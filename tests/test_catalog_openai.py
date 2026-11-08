import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.config import Settings
from backend.app.core.database import connect, init_db
from backend.app.services import batch, catalog, checklist as checklist_service
from backend.app.services import clients, llm_client, openai_client
from backend.app.services.clients import client_for
from backend.app.services.llm_client import LLMClient, get_llm_client
from backend.app.services.openai_client import OpenAIClient
from tests.test_batch import add_dataset
from tests.test_evaluator import version_id

CLEAN = ["OPENAI_API_KEY", "LLM_PROMPT_VERSION", "CQA_BATCH_CONCURRENCY", "LLM_FALLBACK_MODEL", "LLM_PROVIDER", "LLM_MODEL", "LLM_LABEL"]


def openai_env(monkeypatch, tmp_path, **extra):
    for name in CLEAN:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "o.db"))
    fields = {"llm_provider": "openai", "llm_model": "gpt-6.1-sol", "llm_effort": "medium", "llm_label": ""}
    fields.update(extra)
    return use_settings(monkeypatch, **fields)


def use_settings(monkeypatch, **fields):
    settings = Settings(_env_file=None, **fields)
    for module in (catalog, clients, llm_client, openai_client):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    config.get_settings.cache_clear()
    return settings


@pytest.fixture
def env(tmp_path, monkeypatch):
    openai_env(monkeypatch, tmp_path)
    batch.reset_jobs()
    path = str(tmp_path / "o.db")
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    yield conn
    conn.close()
    config.get_settings.cache_clear()


def seed(conn, model, costs, latency_ms=2000):
    vid = version_id(conn)
    pk = conn.execute("SELECT id FROM conversation LIMIT 1").fetchone()[0]
    for c in costs:
        conn.execute(
            "INSERT INTO evaluation (conversation_id, checklist_version_id, model, status, cost, latency_ms) VALUES (?,?,?,?,?,?)",
            (pk, vid, model, "completed", c, latency_ms),
        )
    conn.commit()


def test_openai_entry_fields(env):
    models = catalog.list_models(env)
    assert len(models) == 1
    m = models[0]
    assert m["id"] == "gpt-6.1-sol" and m["default"] is True and m["paid"] is True
    assert m["label"] == "gpt-6.1-sol"
    assert m["price_input_per_mtok"] == 2.0
    assert m["price_output_per_mtok"] == 10.0
    assert m["price_cache_read_per_mtok"] == 0.1
    assert m["price_source"] == "configured"
    assert m["price_per_evaluation"] == round((3000 * 2.0 + 650 * 10.0) / 1_000_000, 6)
    assert m["price_per_evaluation"] != 0.036
    assert m["avg_latency_s"] == 10.0


def test_label_from_settings(tmp_path, monkeypatch):
    openai_env(monkeypatch, tmp_path, llm_label="GPT Sol")
    path = str(tmp_path / "o.db")
    init_db(path)
    conn = connect(path)
    assert catalog.list_models(conn)[0]["label"] == "GPT Sol"
    conn.close()
    config.get_settings.cache_clear()


def test_history_not_mixed_with_opus(env):
    add_dataset(env, "H", 1)
    seed(env, "claude-opus-5-5", [0.5, 0.7])
    seed(env, "gpt-6.1-sol", [0.01, 0.02, 0.03], latency_ms=4000)
    m = catalog.list_models(env)[0]
    assert m["price_source"] == "history"
    assert m["price_per_evaluation"] == 0.02
    assert m["measured_evaluations"] == 3
    assert m["avg_latency_s"] == 4.0


def test_estimate_cost_and_seconds_with_workers(env):
    add_dataset(env, "E", 4)
    vid = version_id(env)
    est = catalog.estimate(env, "E", vid, concurrency=2)
    assert est["model"] == "gpt-6.1-sol"
    assert est["to_run"] == 4
    price = round((3000 * 2.0 + 650 * 10.0) / 1_000_000, 6)
    assert est["price_per_evaluation"] == price
    assert est["cost_estimate"] == round(4 * price, 4)
    assert est["seconds_estimate"] == round(4 * 10.0 / 2, 1)


def test_unknown_model_is_rejected(env):
    assert catalog.find_model(env, "nope") is None
    assert catalog.find_model(env, None)["id"] == "gpt-6.1-sol"
    from backend.app.main import app

    add_dataset(env, "U", 1)
    with TestClient(app) as c:
        r = c.post("/api/v1/runs", json={"dataset": "U", "model": "nope"})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_model"
        r = c.get("/api/v1/runs/estimate", params={"dataset": "U", "model": "nope"})
        assert r.status_code == 422


def test_fallback_entry_only_when_configured_and_known(tmp_path, monkeypatch):
    openai_env(monkeypatch, tmp_path)
    path = str(tmp_path / "o.db")
    init_db(path)
    conn = connect(path)
    assert len(catalog.list_models(conn)) == 1

    use_settings(monkeypatch, llm_provider="openai", llm_model="gpt-6.1-sol", llm_fallback_model="unknown-model")
    assert len(catalog.list_models(conn)) == 1

    use_settings(monkeypatch, llm_provider="openai", llm_model="gpt-6.1-sol", llm_fallback_model="claude-opus-5-5")
    models = catalog.list_models(conn)
    assert [m["id"] for m in models] == ["gpt-6.1-sol", "claude-opus-5-5"]
    assert models[0]["default"] is True and models[1]["default"] is False
    assert models[1]["price_input_per_mtok"] == 4.0
    assert models[1]["price_output_per_mtok"] == 20.0
    assert models[1]["price_cache_read_per_mtok"] == 0.2
    assert catalog.find_model(conn, "claude-opus-5-5")["id"] == "claude-opus-5-5"
    conn.close()
    config.get_settings.cache_clear()


def test_models_api_returns_new_fields(env):
    from backend.app.main import app

    with TestClient(app) as c:
        body = c.get("/api/v1/models").json()
    assert len(body) == 1
    m = body[0]
    assert m["id"] == "gpt-6.1-sol"
    assert m["price_input_per_mtok"] == 2.0
    assert m["price_output_per_mtok"] == 10.0
    assert m["price_cache_read_per_mtok"] == 0.1


def test_routing_fallback_builds_matching_client(tmp_path, monkeypatch):
    openai_env(monkeypatch, tmp_path, llm_fallback_model="claude-opus-5-5")
    primary = get_llm_client()
    assert isinstance(primary, OpenAIClient)
    assert client_for(None, primary) is primary
    assert client_for("gpt-6.1-sol", primary) is primary
    other = client_for("claude-opus-5-5", primary)
    assert isinstance(other, LLMClient) and other.model == "claude-opus-5-5"

    use_settings(monkeypatch, llm_provider="anthropic", llm_model="claude-opus-5-5", llm_fallback_model="gpt-6.1-sol")
    primary = get_llm_client()
    built = client_for("gpt-6.1-sol", primary)
    assert isinstance(built, OpenAIClient) and built.model == "gpt-6.1-sol"
    config.get_settings.cache_clear()


def test_routing_keeps_injected_override(tmp_path, monkeypatch):
    openai_env(monkeypatch, tmp_path, llm_fallback_model="claude-opus-5-5")

    class Fake:
        model = "fake-model"

    injected = Fake()
    assert client_for("fake-model", injected) is injected
    assert client_for("gpt-6.1-sol", injected) is injected
    assert client_for(None, injected) is injected
    assert isinstance(client_for("claude-opus-5-5", injected), LLMClient)
    with pytest.raises(KeyError):
        client_for("nope", injected)
    config.get_settings.cache_clear()
