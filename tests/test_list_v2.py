import time

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.main import app
from backend.app.services import batch, checklist as checklist_service
from backend.app.services.evaluator import evaluate_conversation
from backend.app.services.llm_client import get_llm_client
from tests.test_appeals import appeal, decide
from tests.test_batch import ConcurrentSDK, add_dataset, make
from tests.test_evaluator import add_conversation, fixed_good, make_client, payload, version_id

API = "/api/v1"


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "l.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    batch.reset_jobs()
    with TestClient(app) as c:
        conn = connect(path)
        pks = []
        eids = []
        for cid in ("p1-ru-001", "p1-ru-002", "p2-ru-003"):
            pk = add_conversation(conn, cid=cid)
            llm, _ = make_client([payload(fixed_good())])
            eids.append(evaluate_conversation(conn, pk, version_id(conn), llm)["id"])
            pks.append(pk)
        conn.close()
        yield c, pks, eids, path
    app.dependency_overrides.clear()
    config.get_settings.cache_clear()


def by_cid(rows):
    return {r["conversation_id"]: r for r in rows}


def flip(c, eid):
    aid = appeal(c, eid, "07", role="operator").json()["id"]
    assert decide(c, aid, "change", "no", role="reviewer").status_code == 200


def test_old_shape_preserved_and_operator_ignored(env):
    c, pks, eids, _ = env
    rows = c.get(f"{API}/conversations").json()
    assert isinstance(rows, list) and len(rows) == 3
    for key in ("id", "total", "eval_status", "appeal_status", "checklist_version_label", "provisional", "gross_violation", "has_audio"):
        assert key in rows[0]
    assert c.get(f"{API}/conversations", params={"operator": "x"}).json() == rows


def test_final_total_after_appeal(env):
    c, pks, eids, _ = env
    before = by_cid(c.get(f"{API}/conversations").json())["p1-ru-001"]
    assert before["total"] == before["final_total"] == 88.13 and before["total_changed"] is False
    flip(c, eids[0])
    rows = by_cid(c.get(f"{API}/conversations").json())
    row = rows["p1-ru-001"]
    assert row["total"] == 88.13 and row["final_total"] == 81.88 and row["total_changed"] is True
    assert row["display_appeal_status"] == "changed" and row["appeal_status"] == "resolved"
    assert rows["p1-ru-002"]["display_appeal_status"] == "none"
    assert c.get(f"{API}/evaluations/{eids[0]}").json()["final_total"] == 81.88


def test_sections_effective_subtotals(env):
    c, pks, eids, _ = env
    row = by_cid(c.get(f"{API}/conversations").json())["p1-ru-001"]
    points = lambda r: [s["effective_points"] for s in r["sections"] if s["effective_points"] is not None]
    assert points(row) == [31.25, 18.75, 38.13]
    assert round(sum(points(row)), 2) == row["final_total"] == 88.13
    assert row["sections"][3]["effective_points"] is None and row["sections"][3]["effective_max"] == 0.0
    flip(c, eids[0])
    row = by_cid(c.get(f"{API}/conversations").json())["p1-ru-001"]
    assert points(row) == [31.25, 18.75, 31.88]
    assert round(sum(points(row)), 2) == row["final_total"] == 81.88
    ev = c.get(f"{API}/evaluations/{eids[0]}").json()
    assert [s["effective_points"] for s in ev["final"]["sections"]][:3] == [31.25, 18.75, 31.88]


def test_search_by_id_and_text(env):
    c, *_ = env
    ids = lambda **p: sorted(r["conversation_id"] for r in c.get(f"{API}/conversations", params=p).json())
    assert ids(q="p1-ru-0") == ["p1-ru-001", "p1-ru-002"]
    assert ids(q="P1-RU-0") == ["p1-ru-001", "p1-ru-002"]
    assert ids(q="ru-001") == []
    assert len(ids(q="подать заявку")) == 3
    assert len(ids(q="ЭСКАЛАЦИЯ")) == 3
    assert ids(q="нет такого слова") == []
    assert ids(q="%") == []


def test_sort_and_paging(env):
    c, pks, eids, _ = env
    flip(c, eids[1])
    order = lambda s: [r["conversation_id"] for r in c.get(f"{API}/conversations", params={"sort": s}).json()]
    assert order("final_total")[0] == "p1-ru-002"
    assert order("-final_total")[-1] == "p1-ru-002"
    assert order("-conversation_id") == ["p2-ru-003", "p1-ru-002", "p1-ru-001"]
    assert c.get(f"{API}/conversations", params={"sort": "bogus"}).status_code == 422
    page = c.get(f"{API}/conversations", params={"sort": "conversation_id", "limit": 2, "offset": 2}).json()
    assert [r["conversation_id"] for r in page] == ["p2-ru-003"]


def test_envelope_total_ignores_paging(env):
    c, *_ = env
    body = c.get(f"{API}/conversations", params={"envelope": 1, "limit": 2, "offset": 0, "sort": "conversation_id"}).json()
    assert body["total"] == 3 and body["evaluated"] == 3 and len(body["items"]) == 2
    body = c.get(f"{API}/conversations", params={"envelope": 1, "q": "p1-ru", "limit": 1, "offset": 1}).json()
    assert body["total"] == 2 and len(body["items"]) == 1


def test_confidence_and_model_label(env, monkeypatch):
    c, pks, eids, path = env
    ev = c.get(f"{API}/evaluations/{eids[0]}").json()
    assert ev["confidence"]["level"] == "high"
    assert ev["confidence"]["total"] == 8 and ev["confidence"]["with_rationale"] == 8
    assert ev["model_label"] == "claude-opus-5-5"
    conn = connect(path)
    conn.execute("UPDATE criterion_result SET needs_review = 1, answer = NULL WHERE evaluation_id = ? AND criterion_id = '02'", (eids[1],))
    conn.execute("UPDATE evaluation SET provisional = 1 WHERE id = ?", (eids[1],))
    conn.commit()
    conn.close()
    rows = by_cid(c.get(f"{API}/conversations").json())
    low = rows["p1-ru-002"]
    assert low["confidence"]["level"] == "low" and low["final_total"] is not None
    assert rows["p1-ru-001"]["confidence"]["level"] == "high"
    monkeypatch.setenv("LLM_LABEL", "LLM-оценщик v3")
    config.get_settings.cache_clear()
    assert c.get(f"{API}/evaluations/{eids[0]}").json()["model_label"] == "LLM-оценщик v3"
    assert by_cid(c.get(f"{API}/conversations").json())["p1-ru-001"]["model_label"] == "LLM-оценщик v3"


def test_occurred_at_and_duration(env):
    c, pks, eids, path = env
    conn = connect(path)
    call = add_conversation(conn, cid="call-1", channel="voice call")
    conn.execute("UPDATE message SET timestamp_raw = '2026-11-03T15:49:13.1900670+00:00' WHERE conversation_id = ? AND message_index = 0", (call,))
    conn.execute("UPDATE message SET timestamp_raw = '2026-11-03T15:54:18.1900670+00:00' WHERE conversation_id = ? AND message_index = 7", (call,))
    conn.commit()
    llm, _ = make_client([payload(fixed_good())])
    eid = evaluate_conversation(conn, call, version_id(conn), llm)["id"]
    conn.close()
    ev = c.get(f"{API}/evaluations/{eid}").json()
    assert ev["occurred_at"].startswith("2026-11-03T15:49:13") and ev["duration_seconds"] == 305.0
    chat = c.get(f"{API}/evaluations/{eids[0]}").json()
    assert chat["occurred_at"] is None and chat["duration_seconds"] == 7.0
    row = by_cid(c.get(f"{API}/conversations").json())["call-1"]
    assert row["duration_seconds"] == 305.0


def test_batch_without_dataset_across_datasets(env):
    c, _, _, path = env
    conn = connect(path)
    a = add_dataset(conn, "XA", 2)
    b = add_dataset(conn, "XB", 2)
    conn.close()
    app.dependency_overrides[get_llm_client] = lambda: make(ConcurrentSDK())
    pks = [a[0], b[1], a[1]]
    r = c.post(f"{API}/batches", json={"conversation_pks": pks})
    assert r.status_code == 202
    job = r.json()
    assert job["run_id"] == job["id"] and job["total"] == 3 and job["dataset"] == "mixed"
    for _ in range(100):
        body = c.get(f"{API}/batches/{job['run_id']}").json()
        if body["status"] in ("completed", "failed"):
            break
        time.sleep(0.05)
    assert body["completed"] == 3
    rows = c.get(f"{API}/conversations", params={"dataset": "XA"}).json()
    assert sum(1 for x in rows if x["eval_status"] == "completed") == 2
    rows = c.get(f"{API}/conversations", params={"dataset": "XB"}).json()
    assert sum(1 for x in rows if x["eval_status"] == "completed") == 1


def test_batch_requires_dataset_or_pks(env):
    c, *_ = env
    assert c.post(f"{API}/batches", json={}).status_code == 422
    assert c.post(f"{API}/batches", json={"conversation_pks": [999999]}).status_code == 404


def test_batch_dataset_still_works_with_pks(env):
    c, _, _, path = env
    conn = connect(path)
    a = add_dataset(conn, "YA", 3)
    conn.close()
    app.dependency_overrides[get_llm_client] = lambda: make(ConcurrentSDK())
    job = c.post(f"{API}/batches", json={"dataset": "YA", "conversation_pks": a[:2]}).json()
    assert job["total"] == 2 and job["dataset"] == "YA"
