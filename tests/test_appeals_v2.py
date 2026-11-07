import sqlite3
from datetime import datetime

import pytest

from backend.app.core import config
from backend.app.core.database import SCHEMA, connect, init_db
from backend.app.services import appeals as service
from tests.test_appeals import API, appeal, decide, env


def file(c, eid, cid="02", refs=None):
    body = {"criterion_id": cid, "comment": "no", "role": "operator"}
    if refs is not None:
        body["message_refs"] = refs
    return c.post(f"{API}/evaluations/{eid}/appeals", json=body)


def start(c, aid, role="reviewer"):
    return c.post(f"{API}/appeals/{aid}/start-review", json={"role": role})


def set_times(path, aid, created, decided=None):
    conn = connect(path)
    conn.execute("UPDATE appeal SET created_at = ? WHERE id = ?", (created, aid))
    if decided:
        conn.execute("UPDATE review_decision SET decided_at = ? WHERE appeal_id = ?", (decided, aid))
    conn.commit()
    conn.close()


def test_display_status_lifecycle(env):
    c, _, eid, _ = env
    a1 = file(c, eid, "02").json()
    assert a1["display_status"] == "new" and a1["review_started_at"] is None
    r = start(c, a1["id"])
    assert r.status_code == 200 and r.json()["display_status"] == "under_review"
    assert r.json()["review_started_by"] == "reviewer" and r.json()["review_started_at"]
    assert start(c, a1["id"]).json()["review_started_at"] == r.json()["review_started_at"]
    assert decide(c, a1["id"], "confirm", role="reviewer").json()["display_status"] == "confirmed"
    a2 = file(c, eid, "03").json()
    assert decide(c, a2["id"], "change", "no", role="reviewer").json()["display_status"] == "changed"
    assert c.get(f"{API}/appeals/{a1['id']}").json()["display_status"] == "confirmed"


@pytest.mark.parametrize("role", ["operator", "exec", "qa", None])
def test_start_review_forbidden(env, role):
    c, _, eid, _ = env
    aid = file(c, eid).json()["id"]
    r = start(c, aid, role)
    assert r.status_code == 403 and r.json()["code"] == "role_forbidden"
    assert c.get(f"{API}/appeals/{aid}").json()["display_status"] == "new"


def test_start_review_errors(env):
    c, _, eid, _ = env
    assert start(c, 999).status_code == 404
    aid = file(c, eid).json()["id"]
    decide(c, aid, "confirm", role="reviewer")
    r = start(c, aid)
    assert r.status_code == 409 and r.json()["code"] == "appeal_resolved"


def test_status_filters(env):
    c, _, eid, _ = env
    a1 = file(c, eid, "02").json()["id"]
    a2 = file(c, eid, "03").json()["id"]
    a3 = file(c, eid, "04").json()["id"]
    a4 = file(c, eid, "05").json()["id"]
    start(c, a2)
    start(c, a3)
    decide(c, a3, "confirm", role="reviewer")
    decide(c, a4, "change", "no", role="reviewer")

    def ids(s):
        return [x["id"] for x in c.get(f"{API}/appeals", params={"status": s}).json()]

    assert ids("new") == [a1]
    assert ids("under_review") == [a2]
    assert ids("confirmed") == [a3]
    assert ids("changed") == [a4]
    assert ids("open") == [a1, a2]
    assert ids("resolved") == [a3, a4]
    assert ids("all") == [a1, a2, a3, a4]
    assert c.get(f"{API}/appeals", params={"status": "bogus"}).status_code == 422


def test_message_refs_round_trip(env):
    c, _, eid, _ = env
    created = file(c, eid, refs=[1, 2])
    assert created.status_code == 201 and created.json()["message_refs"] == [1, 2]
    aid = created.json()["id"]
    assert c.get(f"{API}/appeals/{aid}").json()["message_refs"] == [1, 2]
    assert c.get(f"{API}/appeals").json()[0]["message_refs"] == [1, 2]
    assert c.get(f"{API}/evaluations/{eid}").json()["appeals"][0]["message_refs"] == [1, 2]
    assert file(c, eid, "03").json()["message_refs"] == []


@pytest.mark.parametrize("refs", [[999], [-1], ["1"], [True], [1.5], "1"])
def test_invalid_refs_rejected(env, refs):
    c, _, eid, _ = env
    r = file(c, eid, refs=refs)
    assert r.status_code == 422 and r.json()["code"] == "invalid_message_ref"
    assert c.get(f"{API}/appeals").json() == []


def test_duplicate_refs_deduplicated(env):
    c, _, eid, _ = env
    assert file(c, eid, refs=[2, 1, 2]).json()["message_refs"] == [2, 1]


def test_before_after_snapshots(env):
    c, _, eid, _ = env
    a1 = file(c, eid, "04").json()["id"]
    r = decide(c, a1, "change", 10, role="reviewer").json()
    assert r["total_before"] == 88.13 and r["total_after"] == 81.88
    a2 = file(c, eid, "04").json()["id"]
    r = decide(c, a2, "change", 15, role="reviewer").json()
    assert r["total_before"] == 81.88 and r["total_after"] == 88.13
    first = c.get(f"{API}/appeals/{a1}").json()
    assert first["total_before"] == 88.13 and first["total_after"] == 81.88
    a3 = file(c, eid, "02").json()["id"]
    r = decide(c, a3, "confirm", role="reviewer").json()
    assert r["total_before"] == r["total_after"] == 88.13
    decisions = c.get(f"{API}/evaluations/{eid}").json()["decisions"]
    assert [d["total_after"] for d in decisions] == [81.88, 88.13, 88.13]
    assert c.get(f"{API}/appeals", params={"status": "resolved"}).json()[0]["total_before"] == 88.13


def test_queue_enrichment_and_age(env):
    c, _, eid, path = env
    aid = file(c, eid).json()["id"]
    set_times(path, aid, "2020-01-01 00:00:00")
    item = c.get(f"{API}/appeals").json()[0]
    assert item["checklist_version_label"] == "v1"
    assert item["model_label"] == "claude-opus-5-5"
    assert item["age_hours"] > 72
    assert item["author_role"] == "operator" and item["message_refs"] == []
    set_times(path, aid, "2026-01-01 00:00:00")
    fresh = file(c, eid, "03").json()["id"]
    set_times(path, fresh, "2026-01-01 00:00:00", None)
    decide(c, fresh, "confirm", role="reviewer")
    set_times(path, fresh, "2026-01-01 00:00:00", "2026-01-01 05:30:00")
    done = [x for x in c.get(f"{API}/appeals", params={"status": "resolved"}).json() if x["id"] == fresh][0]
    assert done["age_hours"] == 5.5 and done["decided_by_role"] == "reviewer"


def test_summary_with_controlled_timestamps(env):
    c, _, eid, path = env
    assert c.get(f"{API}/appeals/summary").json() == {
        "open": 0,
        "new": 0,
        "under_review": 0,
        "older_than_hours": 0,
        "aging_hours": 72,
        "median_resolution_hours": None,
    }
    old_new = file(c, eid, "02").json()["id"]
    old_review = file(c, eid, "03").json()["id"]
    recent = file(c, eid, "04").json()["id"]
    d1 = file(c, eid, "05").json()["id"]
    d2 = file(c, eid, "06").json()["id"]
    d3 = file(c, eid, "07").json()["id"]
    start(c, old_review)
    decide(c, d1, "confirm", role="reviewer")
    decide(c, d2, "confirm", role="reviewer")
    decide(c, d3, "confirm", role="reviewer")
    set_times(path, old_new, "2020-01-01 00:00:00")
    set_times(path, old_review, "2020-01-01 00:00:00")
    set_times(path, d1, "2026-03-02 00:00:00", "2026-03-02 02:00:00")
    set_times(path, d2, "2026-03-02 00:00:00", "2026-03-02 10:00:00")
    set_times(path, d3, "2026-03-02 00:00:00", "2026-03-03 00:00:00")
    s = c.get(f"{API}/appeals/summary").json()
    assert s["open"] == 3 and s["new"] == 2 and s["under_review"] == 1
    assert s["older_than_hours"] == 2 and s["median_resolution_hours"] == 10.0
    conn = connect(path)
    at = service.summary(conn, datetime(2020, 1, 3, 23, 0, 0))
    assert at["older_than_hours"] == 0
    at = service.summary(conn, datetime(2020, 1, 4, 1, 0, 0))
    assert at["older_than_hours"] == 2
    conn.close()


def test_aging_threshold_configurable(env, monkeypatch):
    c, _, eid, path = env
    aid = file(c, eid).json()["id"]
    set_times(path, aid, "2020-01-01 00:00:00")
    monkeypatch.setenv("APPEAL_AGING_HOURS", "1000000")
    config.get_settings.cache_clear()
    assert c.get(f"{API}/appeals/summary").json()["older_than_hours"] == 0


def test_appeal_deadline_in_working_days(env, monkeypatch):
    c, _, eid, path = env
    conn = connect(path)
    conn.execute("UPDATE evaluation SET created_at = '2026-11-05 10:00:00' WHERE id = ?", (eid,))
    conn.commit()
    conn.close()
    ev = c.get(f"{API}/evaluations/{eid}").json()
    assert ev["appeal_deadline"] == "2026-11-12 10:00:00" and ev["appeal_window_workdays"] == 5
    assert c.get(f"{API}/conversations/{ev['conversation_id']}/evaluation").json()["appeal_deadline"] == "2026-11-12 10:00:00"
    monkeypatch.setenv("APPEAL_WINDOW_WORKDAYS", "1")
    config.get_settings.cache_clear()
    assert c.get(f"{API}/evaluations/{eid}").json()["appeal_deadline"] == "2026-11-06 10:00:00"
    assert service.add_workdays(datetime(2026, 11, 6, 9), 1) == datetime(2026, 11, 9, 9)


def test_window_not_enforced_by_default_but_can_be(env, monkeypatch):
    c, _, eid, path = env
    conn = connect(path)
    conn.execute("UPDATE evaluation SET created_at = '2020-01-01 00:00:00' WHERE id = ?", (eid,))
    conn.commit()
    conn.close()
    assert file(c, eid, "02").status_code == 201
    monkeypatch.setenv("APPEAL_WINDOW_ENFORCED", "true")
    config.get_settings.cache_clear()
    r = file(c, eid, "03")
    assert r.status_code == 409 and r.json()["code"] == "appeal_window_closed"


def test_migration_idempotent_on_existing_db(tmp_path):
    path = str(tmp_path / "old.db")
    old = SCHEMA
    for col in ("    review_started_at TEXT,\n", "    review_started_by TEXT,\n", "    message_refs TEXT,\n", "    total_before REAL,\n", "    total_after REAL,\n"):
        old = old.replace(col, "")
    conn = sqlite3.connect(path)
    conn.executescript(old)
    conn.close()
    init_db(path)
    init_db(path)
    conn = connect(path)
    appeal_cols = {r["name"] for r in conn.execute("PRAGMA table_info(appeal)")}
    decision_cols = {r["name"] for r in conn.execute("PRAGMA table_info(review_decision)")}
    conn.close()
    assert {"review_started_at", "review_started_by", "message_refs"} <= appeal_cols
    assert {"total_before", "total_after"} <= decision_cols
