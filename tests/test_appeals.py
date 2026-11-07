
import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect
from backend.app.services.evaluator import evaluate_conversation
from tests.test_evaluator import add_conversation, fixed_good, make_client, payload, version_id

API = "/api/v1"


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "a.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    from backend.app.main import app

    with TestClient(app) as c:
        conn = connect(path)
        pk = add_conversation(conn)
        llm, _ = make_client([payload(fixed_good())])
        ev = evaluate_conversation(conn, pk, version_id(conn), llm)
        conn.close()
        yield c, pk, ev["id"], path
    config.get_settings.cache_clear()


def appeal(c, eid, cid="02", comment="Not correct", role="QA"):
    return c.post(f"{API}/evaluations/{eid}/appeals", json={"criterion_id": cid, "comment": comment, "role": role})


def decide(c, aid, decision="change", new_answer=None, reason="Because", role="Reviewer"):
    body = {"decision": decision, "reason": reason, "role": role}
    if new_answer is not None:
        body["new_answer"] = new_answer
    return c.post(f"{API}/appeals/{aid}/decision", json=body)


def test_flip_to_na_recomputes_with_redistribution(env):
    c, pk, eid, _ = env
    before = c.get(f"{API}/evaluations/{eid}").json()
    assert before["total"] == 88.13
    assert before["final"]["total"] == 88.13 and before["final"]["changed"] is False
    aid = appeal(c, eid).json()["id"]
    r = decide(c, aid, "change", "na")
    assert r.status_code == 200 and r.json()["status"] == "resolved"
    after = c.get(f"{API}/evaluations/{eid}").json()
    assert after["total"] == 88.13
    assert after["original"]["total"] == 88.13
    orig02 = next(x for x in after["original"]["criteria"] if x["criterion_id"] == "02")
    assert orig02["answer"] == "yes" and orig02["points"] == 15
    fin = after["final"]
    assert fin["total"] == 85.38 and fin["changed"] is True
    f02 = next(x for x in fin["criteria"] if x["criterion_id"] == "02")
    assert f02["answer"] == "na" and f02["overridden"] and f02["original_answer"] == "yes"
    assert f02["points"] is None
    f01 = next(x for x in fin["criteria"] if x["criterion_id"] == "01")
    assert f01["effective_points"] == round(10 * 100 / 65, 2)
    assert len(after["decisions"]) == 1 and after["decisions"][0]["reason"] == "Because"
    listed = c.get(f"{API}/conversations/{pk}/evaluations").json()[0]
    assert listed["final"]["total"] == 85.38


def test_originals_never_overwritten(env):
    c, pk, eid, path = env
    conn = connect(path)
    snap = conn.execute("SELECT * FROM criterion_result WHERE evaluation_id = ? ORDER BY id", (eid,)).fetchall()
    snap = [tuple(r) for r in snap]
    total = conn.execute("SELECT total FROM evaluation WHERE id = ?", (eid,)).fetchone()[0]
    aid = appeal(c, eid, "01").json()["id"]
    assert decide(c, aid, "change", "no").status_code == 200
    after = [tuple(r) for r in conn.execute("SELECT * FROM criterion_result WHERE evaluation_id = ? ORDER BY id", (eid,)).fetchall()]
    assert snap == after
    assert conn.execute("SELECT total FROM evaluation WHERE id = ?", (eid,)).fetchone()[0] == total
    conn.close()
    fin = c.get(f"{API}/evaluations/{eid}").json()["final"]
    assert fin["total"] < total


def test_confirm_keeps_total(env):
    c, pk, eid, _ = env
    aid = appeal(c, eid, "05").json()["id"]
    assert decide(c, aid, "confirm").status_code == 200
    ev = c.get(f"{API}/evaluations/{eid}").json()
    assert ev["final"]["total"] == 88.13 and ev["final"]["changed"] is False
    assert ev["decisions"][0]["decision"] == "confirm"


def test_reason_mandatory(env):
    c, pk, eid, _ = env
    aid = appeal(c, eid).json()["id"]
    for reason in (None, "", "   "):
        body = {"decision": "change", "new_answer": "na", "role": "Reviewer"}
        if reason is not None:
            body["reason"] = reason
        r = c.post(f"{API}/appeals/{aid}/decision", json=body)
        assert 400 <= r.status_code < 500
    assert c.get(f"{API}/appeals/{aid}").json()["status"] == "open"
    assert appeal(c, eid, "05", comment="  ").status_code == 422


@pytest.mark.parametrize(
    "cid,answer",
    [("01", "na"), ("06", "na"), ("04", "12"), ("04", "yes"), ("06", "15"), ("02", "7"), ("08", "na"), ("08", "maybe"), ("02", ""), ("02", "needs_review")],
)
def test_invalid_answer_rejected(env, cid, answer):
    c, pk, eid, _ = env
    aid = appeal(c, eid, cid).json()["id"]
    r = decide(c, aid, "change", answer)
    assert r.status_code == 422, r.text
    assert c.get(f"{API}/appeals/{aid}").json()["status"] == "open"


def test_valid_scale_and_flag_changes(env):
    c, pk, eid, _ = env
    a1 = appeal(c, eid, "06").json()["id"]
    assert decide(c, a1, "change", 10).status_code == 200
    a2 = appeal(c, eid, "08").json()["id"]
    assert decide(c, a2, "change", "yes").status_code == 200
    ev = c.get(f"{API}/evaluations/{eid}").json()
    assert ev["final"]["gross_violation"] is True and ev["gross_violation"] is False
    assert ev["final"]["total"] > ev["original"]["total"]


def test_change_requires_answer_and_confirm_rejects_answer(env):
    c, pk, eid, _ = env
    aid = appeal(c, eid).json()["id"]
    assert decide(c, aid, "change").status_code == 422
    assert decide(c, aid, "confirm", "no").status_code == 422
    assert decide(c, aid, "bogus").status_code == 422


def test_one_open_appeal_per_criterion(env):
    c, pk, eid, _ = env
    first = appeal(c, eid)
    assert first.status_code == 201
    assert appeal(c, eid).status_code == 409
    assert appeal(c, eid, "05").status_code == 201
    decide(c, first.json()["id"], "confirm")
    assert appeal(c, eid).status_code == 201


def test_decision_on_resolved_rejected(env):
    c, pk, eid, _ = env
    aid = appeal(c, eid).json()["id"]
    assert decide(c, aid, "confirm").status_code == 200
    assert decide(c, aid, "change", "na").status_code == 409
    assert decide(c, aid, "confirm").status_code == 409
    assert len(c.get(f"{API}/evaluations/{eid}").json()["decisions"]) == 1


def test_role_separation_and_unknowns(env):
    c, pk, eid, _ = env
    assert appeal(c, eid, role="Reviewer").status_code == 403
    assert c.post(f"{API}/evaluations/{eid}/appeals", json={"criterion_id": "02", "comment": "x"}).status_code == 403
    aid = appeal(c, eid).json()["id"]
    assert decide(c, aid, "confirm", role="QA").status_code == 403
    assert appeal(c, eid, "99").status_code == 404
    assert appeal(c, 9999).status_code == 404
    assert decide(c, 9999, "confirm").status_code == 404


def test_queue_contents(env):
    c, pk, eid, _ = env
    aid = appeal(c, eid, "02", "Operator did clarify").json()["id"]
    q = c.get(f"{API}/appeals").json()
    assert len(q) == 1
    item = q[0]
    assert item["id"] == aid and item["comment"] == "Operator did clarify"
    assert item["conversation_pk"] == pk and item["criterion"]["id"] == "02"
    assert item["original"]["answer"] == "yes" and item["original"]["evidence"][0]["message_index"] == 5
    assert [m["message_index"] for m in item["fragment"]] == [4, 5, 6]
    decide(c, aid, "confirm")
    assert c.get(f"{API}/appeals").json() == []
    assert len(c.get(f"{API}/appeals?status=resolved").json()) == 1
    assert len(c.get(f"{API}/appeals?status=all").json()) == 1
    assert c.get(f"{API}/appeals?status=zzz").status_code == 422


def test_list_appeal_status_and_filter(env):
    c, pk, eid, path = env
    conn = connect(path)
    pk2 = add_conversation(conn, cid="p1-ru-002")
    llm, _ = make_client([payload(fixed_good())])
    evaluate_conversation(conn, pk2, version_id(conn), llm)
    conn.close()

    def rows(**p):
        return {r["id"]: r for r in c.get(f"{API}/conversations", params=p).json()}

    assert rows()[pk]["appeal_status"] == "none"
    aid = appeal(c, eid).json()["id"]
    assert rows()[pk]["appeal_status"] == "open"
    assert list(rows(appeal_status="open")) == [pk]
    assert list(rows(appeal_status="none")) == [pk2]
    decide(c, aid, "confirm")
    assert rows()[pk]["appeal_status"] == "resolved"
    assert list(rows(appeal_status="resolved")) == [pk]
    assert list(rows(appeal_status="open")) == []
    assert c.get(f"{API}/conversations", params={"appeal_status": "x"}).status_code == 422


def test_ev_appealed_criteria_listed(env):
    c, pk, eid, _ = env
    appeal(c, eid, "05")
    assert c.get(f"{API}/evaluations/{eid}").json()["appealed_criteria"] == ["05"]
