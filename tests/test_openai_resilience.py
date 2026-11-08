import json
import logging
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.app import main
from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services import batch, checklist as checklist_service
from backend.app.services.openai_client import OpenAIClient
from tests.test_batch import add_dataset
from tests.test_evaluator import StatusError, fixed_good, payload, version_id

SECRET = "sk-test-secret-1234"
GOOD = payload(fixed_good())
ENV_NAMES = (
    "OPENAI_API_KEY",
    "LLM_PROMPT_VERSION",
    "CQA_BATCH_CONCURRENCY",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_EFFORT",
    "LLM_API_KEY",
    "OPENAI_MAX_INFLIGHT",
    "OPENAI_MAX_ATTEMPTS",
    "AWS_REGION",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "r.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    batch.reset_jobs()
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    yield conn
    conn.close()
    config.get_settings.cache_clear()


def make_settings(**overrides):
    values = {
        "llm_provider": "openai",
        "llm_model": "gpt-6.1-sol",
        "llm_effort": "high",
        "openai_api_key": SECRET,
        "openai_max_attempts": 1,
    }
    values.update(overrides)
    return config.Settings(_env_file=None, **values)


def response(text=GOOD, model="gpt-6.1-sol", status="completed", content=None, incomplete=None):
    if content is None:
        content = [SimpleNamespace(type="output_text", text=text)]
    return SimpleNamespace(
        model=model,
        status=status,
        output=[SimpleNamespace(type="message", content=content)],
        incomplete_details=SimpleNamespace(reason=incomplete) if incomplete else None,
        usage=SimpleNamespace(
            input_tokens=100,
            input_tokens_details=SimpleNamespace(cached_tokens=0),
            output_tokens=10,
            output_tokens_details=SimpleNamespace(reasoning_tokens=0),
        ),
    )


class FakeOpenAI:
    def __init__(self, script=None, default=None, delay=0.0):
        self.script = list(script or [])
        self.default = default if default is not None else response()
        self.delay = delay
        self.lock = threading.Lock()
        self.calls = 0
        self.in_flight = 0
        self.max_in_flight = 0
        self.responses = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        with self.lock:
            self.calls += 1
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
            item = self.script.pop(0) if self.script else self.default
        try:
            if self.delay:
                time.sleep(self.delay)
            if isinstance(item, BaseException):
                raise item
            return item
        finally:
            with self.lock:
                self.in_flight -= 1


def client_for(settings, sdk):
    return OpenAIClient(sdk=sdk, settings=settings, sleep=lambda s: None)


def run(env, group, n, sdk, settings=None, **kwargs):
    settings = settings or make_settings()
    add_dataset(env, group, n)
    kwargs.setdefault("sleep", lambda s: None)
    return batch.run_job_sync(env, group, version_id(env), client_for(settings, sdk), **kwargs)


def item_statuses(env):
    return [r["status"] for r in env.execute("SELECT status FROM eval_run_item WHERE status != 'skipped' ORDER BY id").fetchall()]


def stored_text(env):
    rows = env.execute("SELECT raw_output FROM evaluation").fetchall()
    items = env.execute("SELECT error FROM eval_run_item").fetchall()
    return " ".join(str(r[0]) for r in rows) + " " + " ".join(str(r[0]) for r in items)


def test_429_n_times_then_success(env):
    sdk = FakeOpenAI(script=[StatusError(429, "Too many requests")] * 3)
    sleeps = []
    snap = run(env, "T", 1, sdk, backoff_base=0.5, sleep=sleeps.append)
    assert sleeps == [0.5, 1.0, 2.0]
    assert snap["completed"] == 1 and snap["failed"] == 0
    assert snap["throttled_retries"] == 3
    assert sdk.calls == 4
    assert env.execute("SELECT COUNT(*) FROM evaluation").fetchone()[0] == 1
    assert env.execute("SELECT throttled_retries FROM eval_run").fetchone()[0] == 3


def test_throttled_items_in_a_batch_are_retried_and_counted(env):
    sdk = FakeOpenAI(script=[StatusError(429)] * 5)
    snap = run(env, "TB", 6, sdk, concurrency=3, max_retries=10)
    assert snap["completed"] == 6 and snap["failed"] == 0
    assert snap["throttled_retries"] == 5


def test_clamp_applies_for_openai_only(env):
    add_dataset(env, "CL", 3)
    vid = version_id(env)
    capped = make_settings(openai_max_inflight=3, cqa_batch_concurrency=8)
    job, _ = batch.create_job(env, "CL", vid, concurrency=50, settings=capped)
    assert job.concurrency == 3 and job.snapshot()["concurrency"] == 3
    assert env.execute("SELECT concurrency FROM eval_run WHERE id = ?", (job.id,)).fetchone()[0] == 3
    default, _ = batch.create_job(env, "CL", vid, force=True, settings=make_settings(openai_max_inflight=12, cqa_batch_concurrency=8))
    assert default.concurrency == 8
    floor, _ = batch.create_job(env, "CL", vid, force=True, settings=make_settings(openai_max_inflight=12, cqa_batch_concurrency=30))
    assert floor.concurrency == 12
    other = capped.model_copy(update={"llm_provider": "anthropic", "llm_effort": "medium"})
    free, _ = batch.create_job(env, "CL", vid, force=True, concurrency=50, settings=other)
    assert free.concurrency == 50


def test_clamp_uses_client_settings_in_run_job_sync(env):
    sdk = FakeOpenAI(delay=0.02)
    settings = make_settings(openai_max_inflight=2)
    snap = run(env, "CS", 6, sdk, settings=settings, concurrency=9)
    assert snap["concurrency"] == 2
    assert snap["completed"] == 6
    assert sdk.max_in_flight <= 2


def test_twenty_items_at_concurrency_12_never_exceed_12(env):
    sdk = FakeOpenAI(delay=0.03)
    snap = run(env, "W", 20, sdk, settings=make_settings(openai_max_inflight=12), concurrency=12)
    assert snap["concurrency"] == 12
    assert snap["completed"] == 20 and snap["failed"] == 0
    assert 1 < sdk.max_in_flight <= 12


def test_twenty_items_requested_above_cap_are_clamped_to_12(env):
    sdk = FakeOpenAI(delay=0.03)
    snap = run(env, "W2", 20, sdk, settings=make_settings(openai_max_inflight=12), concurrency=20)
    assert snap["concurrency"] == 12
    assert sdk.max_in_flight <= 12


def test_all_items_failed_is_reported_not_crashed(env):
    sdk = FakeOpenAI(default=StatusError(500, "server exploded"))
    snap = run(env, "AF", 4, sdk, concurrency=2)
    assert snap["status"] == "completed"
    assert snap["failed"] == 4 and snap["completed"] == 0
    assert len(snap["failures"]) == 4
    assert all("500" in f["error"] for f in snap["failures"])
    assert snap["percent"] == 100
    assert item_statuses(env) == ["failed"] * 4


def test_no_key_fails_fast_per_item(env):
    settings = make_settings(openai_api_key="")
    add_dataset(env, "NK", 3)
    client = OpenAIClient(settings=settings, sleep=lambda s: None)
    snap = batch.run_job_sync(env, "NK", version_id(env), client, concurrency=2, sleep=lambda s: None)
    assert snap["status"] == "failed"
    assert snap["failed"] >= 1 and snap["failed"] + snap["cancelled"] == 3 and snap["throttled_retries"] == 0
    assert all("OPENAI_API_KEY is not set" in f["error"] for f in snap["failures"][: snap["failed"]])
    assert sorted(item_statuses(env)) == sorted(["failed"] * snap["failed"] + ["cancelled"] * snap["cancelled"])
    statuses = [r["status"] for r in env.execute("SELECT status FROM evaluation").fetchall()]
    assert statuses == ["failed"] * snap["failed"]


def test_retry_failed_reruns_after_throttle_exhaustion(env):
    sdk = FakeOpenAI(default=StatusError(429, "Too many requests"))
    snap = run(env, "RF", 2, sdk, concurrency=1, max_retries=2)
    assert snap["failed"] == 2 and snap["throttled_retries"] == 4
    assert all("429" in f["error"] for f in snap["failures"])
    good = FakeOpenAI()
    again = batch.run_job_sync(env, "RF", version_id(env), client_for(make_settings(), good), concurrency=1)
    assert again["completed"] == 2 and again["skipped"] == 0 and good.calls == 2


@pytest.mark.parametrize("code,expected_retries", [(429, 1), (503, 1), (500, 0)])
def test_failure_surface_provider_errors_after_client_retries(env, code, expected_retries):
    sdk = FakeOpenAI(default=StatusError(code, "provider trouble"))
    settings = make_settings(openai_max_attempts=2)
    snap = run(env, "PE", 1, sdk, settings=settings, max_retries=1)
    assert snap["failed"] == 1 and snap["throttled_retries"] == expected_retries
    assert "gave up after 2 attempts" in snap["failures"][0]["error"]
    assert f"status {code}" in snap["failures"][0]["error"]
    assert sdk.calls == 2 * (1 + expected_retries)
    assert item_statuses(env) == ["failed"]


def test_failure_surface_auth_401_is_failed_non_retryable_and_redacted(env):
    sdk = FakeOpenAI(default=StatusError(401, f"Incorrect API key provided: {SECRET}"))
    snap = run(env, "AU", 2, sdk, concurrency=1)
    assert snap["failed"] == 1 and snap["cancelled"] == 1 and snap["throttled_retries"] == 0
    assert sdk.calls == 1
    assert "status 401" in snap["failures"][0]["error"]
    assert SECRET not in json.dumps(snap)
    assert SECRET not in stored_text(env)


def test_failure_surface_refusal_is_needs_review(env):
    refusal = response(content=[SimpleNamespace(type="refusal", refusal="cannot help")])
    snap = run(env, "RE", 1, FakeOpenAI(default=refusal))
    assert snap["needs_review"] == 1 and snap["failed"] == 0 and snap["throttled_retries"] == 0
    assert item_statuses(env) == ["needs_review"]


def test_failure_surface_truncation_is_needs_review(env):
    truncated = response(text='{"results": [', status="incomplete", incomplete="max_output_tokens")
    sdk = FakeOpenAI(default=truncated)
    snap = run(env, "TR", 1, sdk)
    assert snap["needs_review"] == 1 and snap["failed"] == 0
    assert sdk.calls == 1
    assert item_statuses(env) == ["needs_review"]


def test_failure_surface_invalid_json_gets_one_repair(env):
    sdk = FakeOpenAI(script=[response(text="not json")], default=response())
    snap = run(env, "IJ", 1, sdk)
    assert snap["completed"] == 1 and sdk.calls == 2


def test_failure_surface_still_invalid_after_repair_is_needs_review(env):
    sdk = FakeOpenAI(default=response(text="not json"))
    snap = run(env, "SI", 1, sdk)
    assert snap["needs_review"] == 1 and snap["failed"] == 0
    assert sdk.calls == 2
    assert item_statuses(env) == ["needs_review"]


def test_failure_surface_served_model_mismatch_is_failed_not_throttled(env):
    sdk = FakeOpenAI(default=response(model="gpt-other"))
    snap = run(env, "MM", 1, sdk, max_retries=3)
    assert snap["failed"] == 1 and snap["throttled_retries"] == 0
    assert "does not match requested model" in snap["failures"][0]["error"]
    assert sdk.calls == 1


def test_failure_surface_schema_problem_is_failed_not_throttled(env, monkeypatch):
    from backend.app.services.llm_client import LLMError

    def broken(self, schema):
        raise LLMError("schema is not strict compatible: $: additionalProperties must be false")

    monkeypatch.setattr(OpenAIClient, "_strict_schema", broken)
    sdk = FakeOpenAI()
    snap = run(env, "SC", 1, sdk, max_retries=3)
    assert snap["failed"] == 1 and snap["throttled_retries"] == 0
    assert "schema is not strict compatible" in snap["failures"][0]["error"]
    assert sdk.calls == 0


def test_same_settings_object_reaches_the_evaluator(env, monkeypatch):
    seen = []
    real = batch.evaluate_conversation

    def spy(conn, pk, vid, client, settings=None):
        seen.append(settings)
        return real(conn, pk, vid, client, settings)

    monkeypatch.setattr(batch, "evaluate_conversation", spy)
    settings = make_settings()
    run(env, "SP", 3, FakeOpenAI(), settings=settings, concurrency=2)
    assert len(seen) == 3 and all(s is settings for s in seen)


def patch_settings(monkeypatch, settings):
    monkeypatch.setattr(main, "get_settings", lambda: settings)


def test_health_without_key_is_not_ready_and_app_starts(env, monkeypatch):
    patch_settings(monkeypatch, make_settings(openai_api_key=""))
    with TestClient(main.app) as client:
        r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "llm": {"provider": "openai", "model": "gpt-6.1-sol", "ready": False}}


def test_health_with_key_is_ready_and_secret_never_leaks(env, monkeypatch, caplog):
    patch_settings(monkeypatch, make_settings())
    sdk = FakeOpenAI(default=StatusError(401, f"Incorrect API key provided: {SECRET}"))
    snap = run(env, "LK", 2, sdk, settings=make_settings())
    bodies = []
    with caplog.at_level(logging.DEBUG):
        with TestClient(main.app) as client:
            r = client.get("/health")
            assert r.json() == {"status": "ok", "llm": {"provider": "openai", "model": "gpt-6.1-sol", "ready": True}}
            bodies.append(r.text)
            bodies.append(client.get("/api/v1/batches").text)
            bodies.append(client.get(f"/api/v1/batches/{snap['id']}").text)
    assert snap["failed"] >= 1
    for text in bodies:
        assert SECRET not in text
    assert SECRET not in caplog.text
    assert SECRET not in stored_text(env)


def test_startup_logs_one_line_without_the_key(env, monkeypatch, caplog):
    patch_settings(monkeypatch, make_settings(llm_prompt_version="v2"))
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        with TestClient(main.app):
            pass
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("llm provider=")]
    assert lines == ["llm provider=openai model=gpt-6.1-sol effort=high prompt_version=v2 key_present=True"]
    assert SECRET not in caplog.text


@pytest.mark.parametrize(
    "overrides,expected",
    [
        ({"llm_provider": "anthropic", "llm_effort": "medium", "llm_model": "claude-opus-5-5", "llm_api_key": "ak-secret-9"}, {"provider": "anthropic", "model": "claude-opus-5-5", "ready": True}),
        ({"llm_provider": "anthropic", "llm_effort": "medium", "llm_model": "claude-opus-5-5", "llm_api_key": ""}, {"provider": "anthropic", "model": "claude-opus-5-5", "ready": False}),
        ({"llm_provider": "bedrock", "llm_effort": "medium", "llm_model": "claude-opus-5-5", "aws_region": "us-east-1", "aws_secret_access_key": "aws-secret-7"}, {"provider": "bedrock", "model": "claude-opus-5-5", "ready": True}),
        ({"llm_provider": "bedrock", "llm_effort": "medium", "llm_model": "claude-opus-5-5", "aws_region": ""}, {"provider": "bedrock", "model": "claude-opus-5-5", "ready": False}),
    ],
)
def test_health_other_providers(env, monkeypatch, overrides, expected):
    patch_settings(monkeypatch, make_settings(openai_api_key="", **overrides))
    with TestClient(main.app) as client:
        r = client.get("/health")
    assert r.json() == {"status": "ok", "llm": expected}
    assert "secret" not in r.text
