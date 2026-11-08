import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services import batch, checklist as checklist_service
from backend.app.services.llm_client import LLMClient, get_llm_client
from tests.test_evaluator import MSGS, StatusError, add_conversation, fixed_good, payload, version_id

GOOD = payload(fixed_good())


class ConcurrentSDK:
    def __init__(self, delay=0.0, fail_marker=None, throttle_first=0, fail_exc=None):
        self.delay = delay
        self.fail_marker = fail_marker
        self.fail_exc = fail_exc or RuntimeError("boom")
        self.throttle_left = throttle_first
        self.lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0
        self.calls = 0
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        with self.lock:
            self.in_flight += 1
            self.calls += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
            throttle = self.throttle_left > 0
            if throttle:
                self.throttle_left -= 1
        try:
            if self.delay:
                time.sleep(self.delay)
            if throttle:
                raise StatusError(429, "Too many requests")
            user = kwargs["messages"][0]["content"]
            if self.fail_marker and self.fail_marker in user:
                raise self.fail_exc
            usage = SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0, cache_creation_input_tokens=0)
            return SimpleNamespace(content=[SimpleNamespace(type="text", text=GOOD)], stop_reason="end_turn", usage=usage)
        finally:
            with self.lock:
                self.in_flight -= 1


def make(sdk):
    return LLMClient(sdk=sdk, settings=config.Settings())


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "b.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    batch.reset_jobs()
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    yield conn
    conn.close()
    config.get_settings.cache_clear()


def add_dataset(conn, group, n, fail_index=None):
    ds = conn.execute("INSERT INTO dataset (group_id) VALUES (?)", (group,)).lastrowid
    pks = []
    for i in range(n):
        pk = conn.execute(
            "INSERT INTO conversation (dataset_id, conversation_id, channel, language) VALUES (?,?,?,?)",
            (ds, f"{group}-{i}", "agent chat", "RU"),
        ).lastrowid
        msgs = list(MSGS)
        if i == fail_index:
            msgs = msgs + [("03:00", "client", "FAILME")]
        for j, (ts, sp, tx) in enumerate(msgs):
            conn.execute(
                "INSERT INTO message (conversation_id, message_index, timestamp_raw, offset_seconds, speaker, text) VALUES (?,?,?,?,?,?)",
                (pk, j, ts, float(j), sp, tx),
            )
        pks.append(pk)
    conn.commit()
    return pks


def test_concurrency_never_exceeds_limit(env, monkeypatch):
    monkeypatch.setenv("CQA_BATCH_CONCURRENCY", "2")
    config.get_settings.cache_clear()
    add_dataset(env, "C", 8)
    sdk = ConcurrentSDK(delay=0.05)
    snap = batch.run_job_sync(env, "C", version_id(env), make(sdk))
    assert snap["concurrency"] == 2
    assert snap["completed"] == 8 and snap["failed"] == 0 and snap["status"] == "completed"
    assert sdk.max_in_flight == 2


def test_concurrency_one_serialises(env):
    add_dataset(env, "S", 4)
    sdk = ConcurrentSDK(delay=0.02)
    batch.run_job_sync(env, "S", version_id(env), make(sdk), concurrency=1)
    assert sdk.max_in_flight == 1


def test_one_failure_does_not_stop_others(env):
    add_dataset(env, "E", 5, fail_index=2)
    sdk = ConcurrentSDK(fail_marker="FAILME")
    snap = batch.run_job_sync(env, "E", version_id(env), make(sdk), concurrency=3)
    assert snap["completed"] == 4 and snap["failed"] == 1 and snap["status"] == "completed"
    assert snap["failures"][0]["conversation_id"] == "E-2"
    assert "boom" in snap["failures"][0]["error"]
    statuses = [r["status"] for r in env.execute("SELECT status FROM evaluation").fetchall()]
    assert sorted(statuses) == ["completed"] * 4 + ["failed"]


def test_resume_skips_finished_and_retries_failed(env):
    add_dataset(env, "R", 4, fail_index=1)
    vid = version_id(env)
    first = ConcurrentSDK(fail_marker="FAILME")
    batch.run_job_sync(env, "R", vid, make(first), concurrency=1)
    assert first.calls == 4
    second = ConcurrentSDK()
    snap = batch.run_job_sync(env, "R", vid, make(second), concurrency=1)
    assert snap["skipped"] == 3 and snap["to_run"] == 1
    assert second.calls == 1 and snap["completed"] == 1
    third = ConcurrentSDK()
    snap = batch.run_job_sync(env, "R", vid, make(third))
    assert third.calls == 0 and snap["skipped"] == 4 and snap["percent"] == 100


def test_no_retry_failed_and_force(env):
    add_dataset(env, "F", 3, fail_index=0)
    vid = version_id(env)
    batch.run_job_sync(env, "F", vid, make(ConcurrentSDK(fail_marker="FAILME")), concurrency=1)
    sdk = ConcurrentSDK()
    snap = batch.run_job_sync(env, "F", vid, make(sdk), retry_failed=False)
    assert sdk.calls == 0 and snap["skipped"] == 3
    sdk = ConcurrentSDK()
    batch.run_job_sync(env, "F", vid, make(sdk), force=True, concurrency=1)
    assert sdk.calls == 3


def test_skip_is_per_checklist_version(env):
    add_dataset(env, "V", 2)
    vid = version_id(env)
    batch.run_job_sync(env, "V", vid, make(ConcurrentSDK()))
    cl = env.execute("SELECT id FROM checklist").fetchone()[0]
    cfg = checklist_service.get_version(env, vid).config
    new = checklist_service.add_version(env, cl, cfg)
    sdk = ConcurrentSDK()
    snap = batch.run_job_sync(env, "V", new.id, make(sdk))
    assert sdk.calls == 2 and snap["skipped"] == 0


def test_throttle_backoff_retries_then_succeeds(env):
    add_dataset(env, "T", 1)
    sleeps = []
    sdk = ConcurrentSDK(throttle_first=2)
    snap = batch.run_job_sync(env, "T", version_id(env), make(sdk), backoff_base=1.5, sleep=sleeps.append)
    assert sleeps == [1.5, 3.0]
    assert snap["completed"] == 1 and snap["failed"] == 0 and snap["throttled_retries"] == 2
    assert env.execute("SELECT COUNT(*) FROM evaluation").fetchone()[0] == 1


def test_throttle_exhausted_marks_failed(env):
    add_dataset(env, "X", 1)
    sdk = ConcurrentSDK(throttle_first=99)
    snap = batch.run_job_sync(env, "X", version_id(env), make(sdk), max_retries=2, sleep=lambda s: None)
    assert snap["failed"] == 1 and snap["throttled_retries"] == 2
    assert env.execute("SELECT status FROM evaluation").fetchone()[0] == "failed"


def test_unknown_dataset(env):
    with pytest.raises(LookupError):
        batch.run_job_sync(env, "NOPE", version_id(env), make(ConcurrentSDK()))


@pytest.fixture
def api(env):
    from backend.app.main import app

    sdk = ConcurrentSDK(delay=0.02, fail_marker="FAILME")
    app.dependency_overrides[get_llm_client] = lambda: make(sdk)
    with TestClient(app) as c:
        c.sdk = sdk
        yield c
    app.dependency_overrides.clear()


def wait_done(api, job_id):
    for _ in range(200):
        body = api.get(f"/api/v1/batches/{job_id}").json()
        if body["status"] in ("completed", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError("batch did not finish")


def test_api_batch_progress_and_list_columns(api, env):
    add_dataset(env, "API", 5, fail_index=3)
    r = api.post("/api/v1/batches", json={"dataset": "API"})
    assert r.status_code == 202
    job = r.json()
    assert job["total"] == 5 and job["id"]
    final = wait_done(api, job["id"])
    assert final["completed"] == 4 and final["failed"] == 1 and final["percent"] == 100
    assert api.get("/api/v1/batches").json()[0]["id"] == job["id"]
    assert api.get("/api/v1/batches/9999").status_code == 404
    assert api.post("/api/v1/batches", json={"dataset": "ZZZ"}).status_code == 404
    assert api.post("/api/v1/batches", json={"dataset": "API", "checklist_version_id": 999}).status_code == 404

    rows = api.get("/api/v1/conversations", params={"dataset": "API"}).json()
    done = [r for r in rows if r["eval_status"] == "completed"]
    assert len(done) == 4
    assert done[0]["total"] == 88.13 and done[0]["checklist_version_label"].endswith("v1")
    assert done[0]["gross_violation"] is False
    assert sum(1 for r in rows if r["eval_status"] == "failed") == 1

    def ids(**params):
        return {r["conversation_id"] for r in api.get("/api/v1/conversations", params={"dataset": "API", **params}).json()}

    assert len(ids(status="completed")) == 4
    assert ids(status="failed") == {"API-3"}
    assert len(ids(min_total=88, max_total=89)) == 4
    assert ids(min_total=90) == set()
    assert ids(max_total=10) == set()
    assert ids(gross="true") == set()


def test_filters_gross_none_and_version(api, env):
    pks = add_dataset(env, "G", 3)
    from backend.app.services.evaluator import evaluate_conversation

    bad = fixed_good()
    bad["08"] = ("yes", "Нарушение.", [{"message_index": 5, "quote": "я подскажу шаги"}], None, None)
    sdk = ConcurrentSDK()
    sdk_bad = ConcurrentSDK()
    sdk_bad_text = payload(bad)
    sdk_bad.messages = SimpleNamespace(
        create=lambda **kw: SimpleNamespace(
            content=[SimpleNamespace(type="text", text=sdk_bad_text)],
            stop_reason="end_turn",
            usage=SimpleNamespace(input_tokens=1, output_tokens=1, cache_read_input_tokens=0, cache_creation_input_tokens=0),
        )
    )
    vid = version_id(env)
    evaluate_conversation(env, pks[0], vid, make(sdk))
    evaluate_conversation(env, pks[1], vid, make(sdk_bad))
    rows = {r["conversation_id"]: r for r in api.get("/api/v1/conversations", params={"dataset": "G"}).json()}
    assert rows["G-1"]["gross_violation"] is True and rows["G-0"]["gross_violation"] is False
    assert rows["G-2"]["evaluation_id"] is None and rows["G-2"]["eval_status"] is None
    get = lambda **p: {r["conversation_id"] for r in api.get("/api/v1/conversations", params={"dataset": "G", **p}).json()}
    assert get(gross="true") == {"G-1"}
    assert get(gross="false") == {"G-0"}
    assert get(status="none") == {"G-2"}
    assert get(checklist_version_id=vid, status="completed") == {"G-0", "G-1"}
    assert get(checklist_version_id=vid + 100, status="completed") == set()


def test_cli_runs_and_resumes(env, capsys):
    from scripts import batch_eval

    add_dataset(env, "CLI", 3, fail_index=1)
    sdk = ConcurrentSDK(fail_marker="FAILME")
    code = batch_eval.main(["CLI", "--concurrency", "2"], client=make(sdk))
    out = capsys.readouterr()
    assert code == 1 and "failed 1" in out.out and "FAILED CLI-1" in out.err
    sdk2 = ConcurrentSDK()
    code = batch_eval.main(["CLI"], client=make(sdk2))
    assert code == 0 and sdk2.calls == 1
    assert batch_eval.main(["MISSING"], client=make(sdk2)) == 2


def test_no_comments_in_new_sources():
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    for rel in ["backend/app/services/batch.py", "backend/app/api/v1/batches.py", "scripts/batch_eval.py", "tests/test_batch.py"]:
        text = (root / rel).read_text(encoding="utf-8")
        assert not re.search(r"^\s*#", text, re.M), rel


def test_throttle_markers_cover_openai_error_names():
    assert batch.is_throttle_error("RateLimitError status 429: slow down")
    assert batch.is_throttle_error("code rate_limit_exceeded")
    assert batch.is_throttle_error("gave up after 5 attempts: APIStatusError status 503")
    assert not batch.is_throttle_error("AuthenticationError status 401: bad key")
    assert not batch.is_throttle_error("served model 'x' does not match requested model 'y'")
    assert not batch.is_throttle_error("OPENAI_API_KEY is not set")
    assert not batch.is_throttle_error(None)


def test_create_job_clamp_only_for_openai_provider(env, monkeypatch):
    for name in ("OPENAI_API_KEY", "LLM_PROMPT_VERSION", "CQA_BATCH_CONCURRENCY"):
        monkeypatch.delenv(name, raising=False)
    add_dataset(env, "CAP", 2)
    vid = version_id(env)
    openai_settings = config.Settings(_env_file=None, llm_provider="openai", llm_effort="high", openai_max_inflight=5, cqa_batch_concurrency=4)
    job, _ = batch.create_job(env, "CAP", vid, concurrency=9, settings=openai_settings)
    assert job.concurrency == 5 and job.snapshot()["concurrency"] == 5
    job, _ = batch.create_job(env, "CAP", vid, force=True, settings=openai_settings)
    assert job.concurrency == 4
    anthropic_settings = config.Settings(_env_file=None, llm_provider="anthropic", openai_max_inflight=5)
    job, _ = batch.create_job(env, "CAP", vid, force=True, concurrency=9, settings=anthropic_settings)
    assert job.concurrency == 9
