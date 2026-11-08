import json
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services import batch, checklist as checklist_service
from backend.app.services.llm_client import LLMClient, get_llm_client
from tests.test_batch import GOOD, add_dataset
from tests.test_evaluator import StatusError, version_id

ENV_NAMES = (
    "OPENAI_API_KEY",
    "OPENAI_MAX_INFLIGHT",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_EFFORT",
    "LLM_API_KEY",
    "LLM_PROMPT_VERSION",
    "LLM_STRUCTURED_OUTPUTS",
    "CQA_BATCH_CONCURRENCY",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


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


@pytest.fixture
def api(env):
    from backend.app.main import app

    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


class GateSDK:
    def __init__(self, throttle=False):
        self.release = threading.Event()
        self.lock = threading.Lock()
        self.started = 0
        self.calls = 0
        self.throttle = throttle
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        with self.lock:
            self.started += 1
            self.calls += 1
        if self.throttle:
            raise StatusError(429, "Too many requests")
        assert self.release.wait(10)
        usage = SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0, cache_creation_input_tokens=0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=GOOD)], stop_reason="end_turn", usage=usage)


def settings():
    return config.Settings(_env_file=None, llm_provider="anthropic", llm_model="claude-opus-5-5", llm_api_key="invalid-key-do-not-call", llm_prompt_version="v1")


def wait_for(predicate, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition not reached")


def item_counts(env, run_id):
    rows = env.execute("SELECT status, COUNT(*) AS n FROM eval_run_item WHERE run_id = ? GROUP BY status", (run_id,)).fetchall()
    return {r["status"]: r["n"] for r in rows}


def start_gated(env, group="G", n=10, concurrency=2):
    add_dataset(env, group, n)
    sdk = GateSDK()
    client = LLMClient(sdk=sdk, settings=settings())
    job = batch.start_job(env, group, version_id(env), client, concurrency=concurrency, backoff_base=0.0)
    wait_for(lambda: sdk.started == concurrency)
    return job, sdk


def test_cancel_live_job_cancels_queued_immediately_then_drains(env, api):
    job, sdk = start_gated(env)
    resp = api.post(f"/api/v1/runs/{job.id}/cancel")
    assert resp.status_code == 200
    mid = resp.json()
    assert mid["status"] == "cancelling"
    assert mid["cancelled"] == 8 and mid["queued"] == 0 and mid["in_flight"] == 2
    assert mid["processed"] == 8 and mid["finished_at"] is None
    assert item_counts(env, job.id) == {"cancelled": 8, "running": 2}
    again = api.post(f"/api/v1/runs/{job.id}/cancel")
    assert again.status_code == 200 and again.json()["status"] == "cancelling" and again.json()["cancelled"] == 8
    assert sdk.calls == 2
    sdk.release.set()
    wait_for(lambda: api.get(f"/api/v1/runs/{job.id}").json()["status"] == "cancelled")
    final = api.post(f"/api/v1/runs/{job.id}/cancel")
    assert final.status_code == 409 and final.json()["detail"]["code"] == "run_not_active"
    drained = api.get(f"/api/v1/runs/{job.id}").json()
    assert drained["completed"] == 2 and drained["cancelled"] == 8 and drained["failed"] == 0
    assert drained["processed"] == 10 and drained["percent"] == 100 and drained["queued"] == 0 and drained["in_flight"] == 0
    assert drained["finished_at"]
    assert item_counts(env, job.id) == {"cancelled": 8, "completed": 2}
    assert env.execute("SELECT COUNT(*) FROM evaluation WHERE run_id = ?", (job.id,)).fetchone()[0] == 2
    assert sdk.calls == 2
    snap = job.snapshot()
    assert snap["status"] == "cancelled" and snap["cancelled"] == 8 and snap["processed"] == 10
    assert api.get(f"/api/v1/runs/{job.id}").json()["items"][0]["status"] in ("completed", "cancelled")


def test_cancel_after_natural_completion_is_409(env, api):
    job, sdk = start_gated(env, n=4, concurrency=2)
    sdk.release.set()
    wait_for(lambda: api.get(f"/api/v1/runs/{job.id}").json()["status"] == "completed")
    resp = api.post(f"/api/v1/runs/{job.id}/cancel")
    assert resp.status_code == 409


def test_cancel_with_nothing_in_flight_finishes_immediately(env):
    add_dataset(env, "Q", 3)
    job, todo = batch.create_job(env, "Q", version_id(env), settings=settings())
    header = batch.cancel_run(env, job.id)
    assert header["status"] == "cancelled" and header["cancelled"] == 3 and header["finished_at"]
    sdk = GateSDK()
    batch.run_job(job, todo, LLMClient(sdk=sdk, settings=settings()), settings=settings())
    assert sdk.calls == 0
    assert batch.get_run(env, job.id, with_items=False)["status"] == "cancelled"


def test_cancel_during_throttle_backoff_stops_the_item(env):
    add_dataset(env, "BO", 3)
    sdk = GateSDK(throttle=True)
    client = LLMClient(sdk=sdk, settings=settings())
    job, todo = batch.create_job(env, "BO", version_id(env), concurrency=1, settings=settings())
    entered = threading.Event()
    proceed = threading.Event()

    def sleeper(delay):
        entered.set()
        assert proceed.wait(10)

    runner = threading.Thread(target=batch.run_job, args=(job, todo, client, 4, 1.0, sleeper, settings()))
    runner.start()
    assert entered.wait(10)
    header = batch.cancel_run(env, job.id)
    assert header["status"] == "cancelling" and header["cancelled"] == 2 and header["in_flight"] == 1
    proceed.set()
    runner.join(10)
    final = batch.get_run(env, job.id, with_items=False)
    assert final["status"] == "cancelled" and final["cancelled"] == 3 and final["failed"] == 0
    assert sdk.calls == 1
    error = env.execute("SELECT error FROM eval_run_item WHERE status = 'cancelled' AND error IS NOT NULL").fetchone()[0]
    assert "cancelled during backoff" in error


def test_cancel_orphan_run(env, api):
    add_dataset(env, "OR", 5)
    job, _ = batch.create_job(env, "OR", version_id(env), settings=settings())
    env.execute("UPDATE eval_run SET status = 'running' WHERE id = ?", (job.id,))
    env.execute("UPDATE eval_run_item SET status = 'running' WHERE id = (SELECT MIN(id) FROM eval_run_item WHERE run_id = ?)", (job.id,))
    env.commit()
    batch.reset_jobs()
    before = api.get(f"/api/v1/runs/{job.id}").json()
    assert before["status"] == "interrupted"
    resp = api.post(f"/api/v1/runs/{job.id}/cancel")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "cancelled" and body["cancelled"] == 5 and body["queued"] == 0 and body["in_flight"] == 0
    assert body["processed"] == 5 and body["percent"] == 100 and body["finished_at"]
    assert item_counts(env, job.id) == {"cancelled": 5}
    assert api.post(f"/api/v1/runs/{job.id}/cancel").status_code == 409
    assert set(body) == set(api.get(f"/api/v1/runs/{job.id}").json()) - {"items", "items_total", "offset", "limit"}


def test_cancel_orphan_run_in_cancelling_state(env, api):
    add_dataset(env, "OC", 2)
    job, _ = batch.create_job(env, "OC", version_id(env), settings=settings())
    env.execute("UPDATE eval_run SET status = 'cancelling' WHERE id = ?", (job.id,))
    env.commit()
    batch.reset_jobs()
    assert api.get(f"/api/v1/runs/{job.id}").json()["status"] == "interrupted"
    assert api.post(f"/api/v1/runs/{job.id}/cancel").json()["status"] == "cancelled"


@pytest.mark.parametrize("final", ["completed", "failed", "cancelled"])
def test_cancel_finished_run_is_409(env, api, final):
    add_dataset(env, "FN", 2)
    job, _ = batch.create_job(env, "FN", version_id(env), settings=settings())
    env.execute("UPDATE eval_run SET status = ?, finished_at = '2026-01-01T00:00:00+00:00' WHERE id = ?", (final, job.id))
    env.commit()
    resp = api.post(f"/api/v1/runs/{job.id}/cancel")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "run_not_active" and resp.json()["detail"]["message"]


def test_cancel_unknown_run_is_404(api):
    resp = api.post("/api/v1/runs/9999/cancel")
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "run_not_found"


def test_list_and_get_include_cancelled_counter(env, api):
    add_dataset(env, "LC", 4)
    job, _ = batch.create_job(env, "LC", version_id(env), settings=settings())
    batch.reset_jobs()
    api.post(f"/api/v1/runs/{job.id}/cancel")
    listed = api.get("/api/v1/runs").json()[0]
    single = api.get(f"/api/v1/runs/{job.id}").json()
    assert listed["cancelled"] == 4 and single["cancelled"] == 4
    assert listed["status"] == "cancelled" and single["processed"] == 4
    other = api.get("/api/v1/runs").json()
    assert all(isinstance(r["cancelled"], int) for r in other)


def test_cancelled_items_are_not_retried_by_retry_item_or_failed_rerun(env):
    job, sdk = start_gated(env, group="RT", n=5, concurrency=1)
    batch.cancel_run(env, job.id)
    sdk.release.set()
    wait_for(lambda: batch.get_run(env, job.id, with_items=False)["status"] == "cancelled")
    cancelled_pk = env.execute("SELECT conversation_id FROM eval_run_item WHERE run_id = ? AND status = 'cancelled'", (job.id,)).fetchone()[0]
    with pytest.raises(batch.RetryError) as info:
        batch.retry_item(env, job.id, cancelled_pk, LLMClient(sdk=sdk, settings=settings()))
    assert info.value.status == 409 and info.value.code == "item_not_failed"
    follow = GateSDK()
    follow.release.set()
    snap = batch.run_job_sync(env, "RT", version_id(env), LLMClient(sdk=follow, settings=settings()), concurrency=2)
    assert snap["skipped"] == 1 and snap["completed"] == 4 and follow.calls == 4


def test_cancel_does_not_touch_other_runs(env):
    add_dataset(env, "A", 3)
    add_dataset(env, "B", 3)
    first, _ = batch.create_job(env, "A", version_id(env), settings=settings())
    second, _ = batch.create_job(env, "B", version_id(env), settings=settings())
    batch.cancel_run(env, first.id)
    assert item_counts(env, second.id) == {"queued": 3}
    assert batch.get_run(env, second.id, with_items=False)["status"] == "queued"
