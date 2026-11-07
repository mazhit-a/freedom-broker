import re
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services import batch, checklist as checklist_service
from backend.app.services.evaluator import evaluate_conversation
from backend.app.services.llm_client import get_llm_client
from tests.test_batch import ConcurrentSDK, add_dataset, make
from tests.test_evaluator import version_id


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


@pytest.fixture
def api(env):
    from backend.app.main import app

    sdk = ConcurrentSDK(delay=0.02, fail_marker="FAILME")
    app.dependency_overrides[get_llm_client] = lambda: make(sdk)
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


def test_run_listed_and_survives_restart(api, env):
    add_dataset(env, "DEV", 4, fail_index=2)
    run_id = api.post("/api/v1/runs", json={"dataset": "DEV"}).json()["id"]
    wait_run(api, run_id)
    listed = api.get("/api/v1/runs").json()
    assert listed[0]["id"] == run_id and listed[0]["code"] == f"R-{run_id:04d}"
    row = listed[0]
    assert row["dataset"] == "DEV" and row["checklist_label"].endswith("v1")
    assert row["model"] and row["total"] == 4 and row["completed"] == 3 and row["failed"] == 1
    assert row["average_total"] == 88.13
    assert row["started_at"] and row["finished_at"]
    batch.reset_jobs()
    from backend.app.main import app

    with TestClient(app) as fresh:
        again = fresh.get("/api/v1/runs").json()
        assert again[0]["id"] == run_id and again[0]["status"] == "completed"
        assert fresh.get(f"/api/v1/batches/{run_id}").json()["completed"] == 3


def test_run_detail_cost_items_and_paging(api, env):
    add_dataset(env, "D2", 5, fail_index=3)
    run_id = api.post("/api/v1/batches", json={"dataset": "D2"}).json()["id"]
    body = wait_run(api, run_id)
    assert (body["done"], body["running"], body["queued"], body["failed"]) == (4, 0, 0, 1)
    expected = env.execute("SELECT SUM(cost) FROM evaluation WHERE run_id = ?", (run_id,)).fetchone()[0]
    assert body["cost_total"] == round(expected, 6) and body["cost_total"] >= 0
    assert body["tokens_in"] == 40 and body["tokens_out"] == 20
    assert body["elapsed_s"] is not None and body["eta_s"] is None
    assert body["items_total"] == 5 and len(body["items"]) == 5
    failed = [i for i in body["items"] if i["status"] == "failed"]
    assert len(failed) == 1 and "boom" in failed[0]["error"] and failed[0]["total"] is None
    ok = [i for i in body["items"] if i["status"] == "completed"]
    assert all(i["total"] == 88.13 and i["gross"] is False and i["latency_ms"] is not None for i in ok)
    assert all(i["other_version_total"] is None for i in ok)
    page = api.get(f"/api/v1/runs/{run_id}", params={"offset": 2, "limit": 2}).json()
    assert [i["conversation_id"] for i in page["items"]] == [i["conversation_id"] for i in body["items"][2:4]]
    assert page["items_total"] == 5
    assert api.get("/api/v1/runs/9999").status_code == 404
    assert api.get(f"/api/v1/runs/{run_id}", params={"limit": 0}).status_code == 422


def test_other_version_total_and_skipped_item(api, env):
    pks = add_dataset(env, "OV", 2)
    vid = version_id(env)
    evaluate_conversation(env, pks[0], vid, make(ConcurrentSDK()))
    cl = env.execute("SELECT id FROM checklist").fetchone()[0]
    cfg = checklist_service.get_version(env, vid).config
    new = checklist_service.add_version(env, cl, cfg)
    run_id = api.post("/api/v1/runs", json={"dataset": "OV", "checklist_version_id": new.id}).json()["id"]
    body = wait_run(api, run_id)
    by = {i["conversation_pk"]: i for i in body["items"]}
    assert by[pks[0]]["other_version_total"] == 88.13
    assert by[pks[1]]["other_version_total"] is None
    run2 = api.post("/api/v1/runs", json={"dataset": "OV", "checklist_version_id": new.id}).json()["id"]
    body2 = wait_run(api, run2)
    assert body2["skipped"] == 2 and {i["status"] for i in body2["items"]} == {"skipped"}
    assert all(i["total"] == 88.13 for i in body2["items"])
    assert body2["cost_total"] == 0


def test_eta_and_running_counters(env):
    add_dataset(env, "ET", 6)
    job, todo = batch.create_job(env, "ET", version_id(env), concurrency=1, model="m")
    initial = batch.get_run(env, job.id)
    assert initial["status"] == "queued" and initial["queued"] == 6 and initial["eta_s"] is None
    seen = {}

    def watch():
        for _ in range(100):
            snap = batch.get_run(env, job.id, with_items=False)
            if snap["status"] == "running" and snap["processed"] >= 1 and snap["eta_s"] is not None:
                seen.update(snap)
                return
            time.sleep(0.02)

    import threading

    t = threading.Thread(target=watch)
    t.start()
    batch.run_job(job, todo, make(ConcurrentSDK(delay=0.1)))
    t.join()
    assert seen and seen["eta_s"] >= 0 and seen["queued"] + seen["running"] + seen["processed"] == 6
    final = batch.get_run(env, job.id)
    assert final["status"] == "completed" and final["eta_s"] is None and final["model"] == "m"


def test_datasets_kind_and_filename(api, env):
    import json

    records = [{"conversation_id": "f1", "channel": "agent chat", "language": "RU", "transcript": [{"timestamp": "00:01", "speaker": "client", "text": "hi"}]}]
    payload = json.dumps({"data": {"dataset_group_id": "DEV", "records": records}}).encode()
    r = api.post("/api/v1/datasets/import-file", files={"file": ("export_okt.json", payload, "application/json")}, data={"group_id": "DEV"})
    assert r.status_code == 200, r.text
    r2 = api.post("/api/v1/datasets/import-file", files={"file": ("c.json", payload, "application/json")}, data={"group_id": "control"})
    assert r2.status_code == 200
    rows = {d["group_id"]: d for d in api.get("/api/v1/datasets").json()}
    assert rows["DEV"]["kind"] == "dev" and rows["DEV"]["source_filename"] == "export_okt.json"
    assert rows["control"]["kind"] == "control" and rows["control"]["label"] == "control"


def test_init_db_idempotent(tmp_path):
    path = str(tmp_path / "x.db")
    init_db(path)
    init_db(path)
    conn = connect(path)
    assert {"eval_run", "eval_run_item"} <= {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    assert "run_id" in {r[1] for r in conn.execute("PRAGMA table_info(evaluation)")}
    conn.close()


def test_no_comments_in_run_sources():
    root = Path(__file__).resolve().parents[1]
    for rel in ["backend/app/services/batch.py", "backend/app/api/v1/runs.py", "backend/app/api/v1/batches.py", "tests/test_runs.py"]:
        assert not re.search(r"^\s*#", (root / rel).read_text(encoding="utf-8"), re.M), rel
