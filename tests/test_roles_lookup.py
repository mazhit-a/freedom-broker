import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services.evaluator import evaluate_conversation
from tests.test_evaluator import add_conversation, fixed_good, make_client, payload, version_id

API = "/api/v1"


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "r.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    from backend.app.main import app

    with TestClient(app) as c:
        conn = connect(path)
        pk = add_conversation(conn)
        vid = version_id(conn)
        llm, _ = make_client([payload(fixed_good())])
        ev = evaluate_conversation(conn, pk, vid, llm)
        conn.close()
        yield c, pk, ev["id"], vid, path
    config.get_settings.cache_clear()


def file(c, eid, role, cid="02"):
    return c.post(f"{API}/evaluations/{eid}/appeals", json={"criterion_id": cid, "comment": "no", "role": role})


def decide(c, aid, role, decision="confirm"):
    return c.post(f"{API}/appeals/{aid}/decision", json={"decision": decision, "reason": "ok", "role": role})


def test_operator_files_and_author_role_is_stored(env):
    c, _, eid, _, _ = env
    r = file(c, eid, "operator")
    assert r.status_code == 201 and r.json()["author_role"] == "operator"
    assert c.get(f"{API}/appeals/{r.json()['id']}").json()["author_role"] == "operator"
    assert c.get(f"{API}/appeals").json()[0]["author_role"] == "operator"


def test_legacy_qa_and_case_insensitive_filing(env):
    c, _, eid, _, _ = env
    assert file(c, eid, "QA", "02").json()["author_role"] == "qa"
    assert file(c, eid, "Operator", "03").json()["author_role"] == "operator"


@pytest.mark.parametrize("role", ["exec", "reviewer", None, ""])
def test_other_roles_cannot_file(env, role):
    c, _, eid, _, _ = env
    r = file(c, eid, role)
    assert r.status_code == 403
    assert r.json()["code"] == "role_forbidden" and r.json()["detail"]


def test_decision_stores_reviewer_role_and_rejects_others(env):
    c, _, eid, _, _ = env
    aid = file(c, eid, "operator").json()["id"]
    for role in ("operator", "exec", "qa"):
        r = decide(c, aid, role)
        assert r.status_code == 403 and r.json()["code"] == "role_forbidden"
    r = decide(c, aid, "reviewer")
    assert r.status_code == 200 and r.json()["decided_by_role"] == "reviewer"
    assert c.get(f"{API}/appeals/{aid}").json()["decided_by_role"] == "reviewer"


def test_filing_roles_configurable(env, monkeypatch):
    c, _, eid, _, _ = env
    monkeypatch.setenv("APPEAL_FILING_ROLES", "operator")
    config.get_settings.cache_clear()
    assert file(c, eid, "qa").status_code == 403
    assert file(c, eid, "operator").status_code == 201


def test_error_codes(env):
    c, _, eid, _, _ = env
    assert file(c, eid, "operator").status_code == 201
    r = file(c, eid, "operator")
    assert r.status_code == 409 and r.json()["code"] == "appeal_open_exists"
    r = c.post(f"{API}/evaluations/{eid}/appeals", json={"criterion_id": "03", "comment": " ", "role": "operator"})
    assert r.status_code == 422 and r.json()["code"] == "comment_required"
    r = file(c, 9999, "operator")
    assert r.status_code == 404 and r.json()["code"] == "evaluation_not_found"
    r = file(c, eid, "operator", "zz")
    assert r.json()["code"] == "criterion_not_found"
    aid = c.get(f"{API}/appeals").json()[0]["id"]
    r = c.post(f"{API}/appeals/{aid}/decision", json={"decision": "confirm", "reason": " ", "role": "reviewer"})
    assert r.status_code == 422 and r.json()["code"] == "reason_required"
    assert decide(c, aid, "reviewer").status_code == 200
    assert decide(c, aid, "reviewer").json()["code"] == "appeal_resolved"
    assert c.get(f"{API}/appeals/9999").json()["code"] == "appeal_not_found"
    assert c.get(f"{API}/appeals?status=bogus").json()["code"] == "invalid_status"
    r = c.get(f"{API}/conversations/9999")
    assert r.status_code == 404 and r.json()["code"] == "conversation_not_found"
    assert r.json()["detail"] == "Conversation not found"


def test_unmapped_errors_get_fallback_code(env):
    c, _, _, _, _ = env
    r = c.get(f"{API}/checklists/999999")
    assert r.status_code == 404 and r.json()["code"]
    assert "detail" in r.json()


def test_by_key_matches_pk_lookup(env):
    c, pk, _, _, _ = env
    by_key = c.get(f"{API}/conversations/by-key/p1-ru-001", params={"dataset": "g-p1-ru-001"})
    assert by_key.status_code == 200
    assert by_key.json() == c.get(f"{API}/conversations/{pk}").json()
    assert c.get(f"{API}/conversations/by-key/p1-ru-001").json()["id"] == pk
    assert c.get(f"{API}/conversations/by-key/p1-ru-001", params={"dataset": str(by_key.json()["dataset_id"])}).json()["id"] == pk


def test_by_key_unknown_and_wrong_dataset(env):
    c, _, _, _, _ = env
    r = c.get(f"{API}/conversations/by-key/nope", params={"dataset": "DEV"})
    assert r.status_code == 404 and r.json()["code"] == "conversation_not_found"
    assert c.get(f"{API}/conversations/by-key/p1-ru-001", params={"dataset": "other"}).status_code == 404


def test_latest_evaluation_for_version(env):
    c, pk, eid, vid, _ = env
    aid = file(c, eid, "operator").json()["id"]
    decide(c, aid, "reviewer")
    r = c.get(f"{API}/conversations/{pk}/evaluation", params={"checklist_version_id": vid})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == eid and body["final"]["total"] is not None and "appeals" in body
    assert c.get(f"{API}/conversations/{pk}/evaluation").json()["id"] == eid
    miss = c.get(f"{API}/conversations/{pk}/evaluation", params={"checklist_version_id": 9999})
    assert miss.status_code == 404 and miss.json()["code"] == "evaluation_not_found"


def test_migration_adds_columns_to_old_database(tmp_path, monkeypatch):
    path = str(tmp_path / "old.db")
    raw = sqlite3.connect(path)
    raw.executescript(
        "CREATE TABLE appeal (id INTEGER PRIMARY KEY AUTOINCREMENT, evaluation_id INTEGER, criterion_id TEXT, comment TEXT,"
        " status TEXT NOT NULL DEFAULT 'open', created_at TEXT);"
        "CREATE TABLE review_decision (id INTEGER PRIMARY KEY AUTOINCREMENT, appeal_id INTEGER, decision TEXT, new_answer TEXT,"
        " reason TEXT, decided_at TEXT);"
    )
    raw.commit()
    raw.close()
    init_db(path)
    init_db(path)
    conn = connect(path)
    assert "author_role" in {r["name"] for r in conn.execute("PRAGMA table_info(appeal)")}
    assert "decided_by_role" in {r["name"] for r in conn.execute("PRAGMA table_info(review_decision)")}
    conn.close()
