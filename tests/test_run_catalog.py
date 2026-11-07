import time

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services import batch, catalog, checklist as checklist_service
from backend.app.services.llm_client import get_llm_client
from tests.test_batch import ConcurrentSDK, add_dataset, make
from tests.test_evaluator import version_id


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "c.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    batch.reset_jobs()
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    yield conn
    conn.close()
    config.get_settings.cache_clear()


def use_sdk(sdk):
    from backend.app.main import app

    app.dependency_overrides[get_llm_client] = lambda: make(sdk)
    return app


@pytest.fixture
def api(env):
    from backend.app.main import app

    app.dependency_overrides[get_llm_client] = lambda: make(ConcurrentSDK(fail_marker="FAILME"))
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def wait_run(api, run_id):
    for _ in range(200):
        body = api.get(f"/api/v1/runs/{run_id}").json()
        if body["status"] in ("completed", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def seed_costs(conn, costs, latency_ms=2000):
    vid = version_id(conn)
    pk = conn.execute("SELECT id FROM conversation LIMIT 1").fetchone()[0]
    for c in costs:
        conn.execute(
            "INSERT INTO evaluation (conversation_id, checklist_version_id, model, status, cost, latency_ms) VALUES (?,?,?,?,?,?)",
            (pk, vid, "claude-opus-5-5", "completed", c, latency_ms),
        )
    conn.commit()


def test_models_fallback_from_pricing_config(api, env, monkeypatch):
    monkeypatch.setenv("LLM_LABEL", "Opus 5.5")
    config.get_settings.cache_clear()
    models = api.get("/api/v1/models").json()
    assert len(models) == 1
    m = models[0]
    assert m["id"] == "claude-opus-5-5" and m["label"] == "Opus 5.5" and m["paid"] is True
    assert m["price_source"] == "configured" and m["price_per_evaluation"] == 0.036
    assert m["measured_evaluations"] == 0


def test_models_price_is_mean_of_history(api, env):
    add_dataset(env, "H", 1)
    seed_costs(env, [0.03, 0.04, 0.0365 + 0.0035], latency_ms=3000)
    env.execute("INSERT INTO evaluation (conversation_id, checklist_version_id, status, cost) SELECT conversation_id, checklist_version_id, 'failed', 0 FROM evaluation LIMIT 1")
    env.commit()
    m = api.get("/api/v1/models").json()[0]
    assert m["price_source"] == "history" and m["measured_evaluations"] == 3
    assert m["price_per_evaluation"] == 0.036667
    assert m["avg_latency_s"] == 3.0


def test_estimate_counts_and_skipped(api, env):
    add_dataset(env, "E", 5)
    vid = version_id(env)
    first = api.post("/api/v1/runs", json={"dataset": "E", "conversation_pks": [p for p in range(1, 3)]}).json()
    wait_run(api, first["id"])
    assert api.get(f"/api/v1/runs/{first['id']}").json()["completed"] == 2
    seed_costs(env, [0.05, 0.05])
    body = api.get("/api/v1/runs/estimate", params={"dataset": "E", "checklist_version_id": vid}).json()
    assert body["total"] == 5 and body["skipped"] == 2 and body["to_run"] == 3
    mean = env.execute("SELECT AVG(cost) FROM evaluation WHERE cost > 0").fetchone()[0]
    price = round(mean, 6)
    assert body["price_per_evaluation"] == price and body["cost_estimate"] == round(3 * price, 4)
    assert body["price_source"] == "history"
    latency = env.execute("SELECT AVG(latency_ms) FROM evaluation WHERE cost > 0").fetchone()[0] / 1000
    assert body["seconds_estimate"] == round(3 * round(latency, 1) / body["concurrency"], 1)
    forced = api.get("/api/v1/runs/estimate", params={"dataset": "E", "force": True}).json()
    assert forced["to_run"] == 5 and forced["skipped"] == 0 and forced["cost_estimate"] == round(5 * price, 4)
    subset = api.get("/api/v1/runs/estimate", params={"conversation_pks": [3, 4]}).json()
    assert subset["total"] == 2 and subset["to_run"] == 2


def test_estimate_errors(api, env):
    assert api.get("/api/v1/runs/estimate").status_code == 422
    assert api.get("/api/v1/runs/estimate", params={"dataset": "NOPE"}).status_code == 404
    add_dataset(env, "X", 1)
    r = api.get("/api/v1/runs/estimate", params={"dataset": "X", "model": "gpt-9"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_model"


def test_start_with_unknown_model_rejected(api, env):
    add_dataset(env, "U", 2)
    r = api.post("/api/v1/runs", json={"dataset": "U", "model": "gpt-9"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unknown_model"
    assert env.execute("SELECT COUNT(*) FROM eval_run").fetchone()[0] == 0
    ok = api.post("/api/v1/runs", json={"dataset": "U", "model": "claude-opus-5-5"})
    assert ok.status_code == 202
    wait_run(api, ok.json()["id"])


def test_retry_failed_item_in_same_run(api, env):
    add_dataset(env, "R", 4, fail_index=2)
    run_id = api.post("/api/v1/runs", json={"dataset": "R"}).json()["id"]
    body = wait_run(api, run_id)
    assert body["failed"] == 1 and body["completed"] == 3
    failed = [i for i in body["items"] if i["status"] == "failed"][0]
    pk = failed["conversation_pk"]
    app = use_sdk(ConcurrentSDK())
    runs_before = env.execute("SELECT COUNT(*) FROM eval_run").fetchone()[0]
    r = api.post(f"/api/v1/runs/{run_id}/items/{pk}/retry")
    assert r.status_code == 200
    assert r.json()["failed"] == 0 and r.json()["completed"] == 4
    after = api.get(f"/api/v1/runs/{run_id}").json()
    item = [i for i in after["items"] if i["conversation_pk"] == pk][0]
    assert item["status"] == "completed" and item["evaluation_id"] and item["error"] is None
    assert after["failed"] == 0 and after["completed"] == 4 and after["total"] == 4
    assert after["failures"] == []
    assert env.execute("SELECT COUNT(*) FROM eval_run").fetchone()[0] == runs_before
    assert env.execute("SELECT run_id FROM evaluation WHERE id = ?", (item["evaluation_id"],)).fetchone()[0] == run_id
    again = api.post(f"/api/v1/runs/{run_id}/items/{pk}/retry")
    assert again.status_code == 409 and again.json()["detail"]["code"] == "item_not_failed"
    app.dependency_overrides.clear()


def test_retry_that_fails_again_stays_failed(api, env):
    add_dataset(env, "S", 2, fail_index=0)
    run_id = api.post("/api/v1/runs", json={"dataset": "S"}).json()["id"]
    body = wait_run(api, run_id)
    pk = [i for i in body["items"] if i["status"] == "failed"][0]["conversation_pk"]
    r = api.post(f"/api/v1/runs/{run_id}/items/{pk}/retry")
    assert r.status_code == 200 and r.json()["failed"] == 1 and r.json()["completed"] == 1
    item = [i for i in api.get(f"/api/v1/runs/{run_id}").json()["items"] if i["conversation_pk"] == pk][0]
    assert item["status"] == "failed" and "boom" in item["error"]


def test_retry_not_found_cases(api, env):
    assert api.post("/api/v1/runs/999/items/1/retry").json()["detail"]["code"] == "run_not_found"
    add_dataset(env, "N", 1)
    run_id = api.post("/api/v1/runs", json={"dataset": "N"}).json()["id"]
    wait_run(api, run_id)
    assert api.post(f"/api/v1/runs/{run_id}/items/9999/retry").status_code == 404
    pk = env.execute("SELECT conversation_id FROM eval_run_item WHERE run_id = ?", (run_id,)).fetchone()[0]
    assert api.post(f"/api/v1/runs/{run_id}/items/{pk}/retry").status_code == 409


def test_catalog_service_direct(env):
    assert catalog.find_model(env, None)["id"] == "claude-opus-5-5"
    assert catalog.find_model(env, "other") is None
    assert catalog.configured_price() == 0.036
