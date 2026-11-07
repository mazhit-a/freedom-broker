import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect
from backend.app.main import app

API = "/api/v1/stats/overview"
ROOT = Path(__file__).resolve().parent.parent

ALL_YES = {"01": "yes", "02": "yes", "03": "yes", "04": "20", "05": "yes", "06": "10", "07": "yes"}


def fmt(d):
    return d.strftime("%Y-%m-%d %H:%M:%S")


def add_eval(conn, cid, answers, created, language="RU", channel="agent chat", gross=False, provisional=False, status="completed", dataset="D", review=()):
    ds = conn.execute("SELECT id FROM dataset WHERE group_id = ?", (dataset,)).fetchone()
    ds = ds[0] if ds else conn.execute("INSERT INTO dataset (group_id) VALUES (?)", (dataset,)).lastrowid
    pk = conn.execute(
        "INSERT INTO conversation (dataset_id, conversation_id, channel, language) VALUES (?,?,?,?)",
        (ds, cid, channel, language),
    ).lastrowid
    vid = conn.execute("SELECT default_version_id FROM checklist").fetchone()[0]
    eid = conn.execute(
        "INSERT INTO evaluation (conversation_id, checklist_version_id, model, status, provisional, gross_violation, created_at) VALUES (?,?,?,?,?,?,?)",
        (pk, vid, "m", status, int(provisional), int(gross), created),
    ).lastrowid
    full = dict(answers)
    full["08"] = "yes" if gross else "no"
    for k, v in full.items():
        conn.execute(
            "INSERT INTO criterion_result (evaluation_id, criterion_id, answer, rationale, needs_review) VALUES (?,?,?,?,?)",
            (eid, k, v, "r", int(k in review)),
        )
    conn.commit()
    return eid


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "s.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    with TestClient(app) as c:
        conn = connect(path)
        e = {}
        e[1] = add_eval(conn, "c1", ALL_YES, "2026-10-20 10:00:00")
        e[2] = add_eval(conn, "c2", {**ALL_YES, "01": "no"}, "2026-10-20 11:00:00")
        e[3] = add_eval(conn, "c3", {**ALL_YES, "03": "na", "04": "10", "06": "4"}, "2026-10-25 09:00:00")
        e[4] = add_eval(conn, "c4", {"01": "yes", "02": "no", "03": "no", "04": "0", "05": "no", "06": "0", "07": "no"}, "2026-10-26 09:00:00", language="KZ", gross=True)
        e[5] = add_eval(conn, "c5", {**ALL_YES, "04": "15", "06": "needs_review"}, "2026-10-30 09:00:00", language="EN", channel="voice call", provisional=True, review=("06",))
        e[6] = add_eval(conn, "c6", {"01": "yes", "02": "na", "03": "na", "04": "5", "05": "no", "06": "10", "07": "no"}, "2026-11-02 09:00:00")
        e[7] = add_eval(conn, "c7", {**ALL_YES, "04": "0", "05": "no", "06": "0", "07": "no"}, "2026-10-10 09:00:00")
        e[8] = add_eval(conn, "c8", ALL_YES, "2026-10-21 09:00:00", status="failed")
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        conn.execute("INSERT INTO appeal (evaluation_id, criterion_id, comment, status, created_at) VALUES (?,?,?,?,?)", (e[6], "04", "x", "open", fmt(now - timedelta(days=5))))
        aid = conn.execute("INSERT INTO appeal (evaluation_id, criterion_id, comment, status, created_at) VALUES (?,?,?,?,?)", (e[2], "01", "x", "resolved", "2026-10-21 10:00:00")).lastrowid
        conn.execute("INSERT INTO review_decision (appeal_id, decision, reason, decided_at) VALUES (?,?,?,?)", (aid, "confirm", "ok", "2026-10-22 10:00:00"))
        conn.commit()
        conn.close()
        yield c, e, path
    app.dependency_overrides.clear()
    config.get_settings.cache_clear()


PERIOD = {"from": "2026-10-20", "to": "2026-11-03"}


def test_hand_computed_fixture(env):
    c, e, _ = env
    j = c.get(API, params=PERIOD).json()
    cards = {r["conversation_id"]: r for r in j["attention"]}
    totals = {"c1": 100.0, "c2": 90.0, "c3": 76.25, "c4": 10.0, "c5": 94.12, "c6": 46.15}
    mean = round(sum(totals.values()) / 6, 2)
    k = j["kpis"]
    assert k["avg"] == mean == 69.42
    assert k["evaluated"] == 6 and k["chats"] == 5 and k["calls"] == 1
    assert k["gross_count"] == 1 and k["gross_share"] == 16.67
    assert k["previous_avg"] == 45.0
    assert k["delta"] == round(sum(totals.values()) / 6 - 45.0, 2) == 24.42
    assert cards["c4"]["score"] == 10.0 and cards["c6"]["score"] == 46.15 and cards["c5"]["score"] == 94.12


def test_distribution_sums_and_buckets(env):
    c, _, _ = env
    d = c.get(API, params=PERIOD).json()["distribution"]
    assert len(d) == 10
    counts = [b["count"] for b in d]
    assert sum(counts) == 6
    assert counts[1] == 1 and counts[4] == 1 and counts[7] == 1 and counts[9] == 3
    assert d[9]["range_from"] == 90 and d[9]["range_to"] == 100


def test_per_criterion(env):
    c, _, _ = env
    pc = {x["criterion_id"]: x for x in c.get(API, params=PERIOD).json()["per_criterion"]}
    assert "08" not in pc
    assert pc["01"]["avg_percent"] == round(50 * 100 / 60, 2) and pc["01"]["applicable_count"] == 6
    assert pc["03"]["applicable_count"] == 4
    assert pc["02"]["applicable_count"] == 5
    assert pc["04"]["avg_percent"] == round((20 + 20 + 10 + 0 + 15 + 5) * 100 / 120, 2)
    assert pc["06"]["applicable_count"] == 5
    ordered = [x["avg_percent"] for x in c.get(API, params=PERIOD).json()["per_criterion"]]
    assert ordered == sorted(ordered)


def test_splits(env):
    c, _, _ = env
    j = c.get(API, params=PERIOD).json()
    lang = {x["language"]: x for x in j["by_language"]}
    assert lang["RU"]["count"] == 4 and lang["RU"]["avg"] == round((100 + 90 + 76.25 + 46.15) / 4, 2)
    assert lang["KZ"]["gross_share"] == 100.0 and lang["EN"]["avg"] == 94.12
    ch = {x["channel"]: x for x in j["by_channel"]}
    assert ch["chat"]["count"] == 5 and ch["call"]["count"] == 1


def test_attention_reasons_and_order(env):
    c, _, _ = env
    j = c.get(API, params=PERIOD).json()
    a = j["attention"]
    assert [x["conversation_id"] for x in a] == ["c4", "c6", "c5"]
    assert a[0]["reason"] == "gross" and a[0]["reasons"] == ["gross", "low_score"]
    assert a[1]["reason"] == "low_score" and a[1]["reasons"] == ["low_score", "appeal_pending"]
    assert a[2]["reason"] == "low_confidence" and a[2]["score"] == 94.12 and a[2]["provisional"] is True
    assert j["attention_total"] == 3
    assert len(c.get(API, params={**PERIOD, "attention_limit": 1}).json()["attention"]) == 1


def test_appeal_kpis(env):
    c, _, _ = env
    k = c.get(API, params=PERIOD).json()["kpis"]
    assert k["open_appeals"] == 1 and k["older_than_hours"] == 1
    assert k["median_resolution_days"] == 1.0 and k["target_days"] == 2


def test_failed_ignored_and_no_period(env):
    c, _, _ = env
    j = c.get(API).json()
    assert j["kpis"]["evaluated"] == 7
    assert sum(b["count"] for b in j["distribution"]) == 7
    assert j["kpis"]["delta"] is None
    assert j["period"]["basis"] == "evaluation_date"


def test_filters_narrow_consistently(env):
    c, _, _ = env
    j = c.get(API, params={**PERIOD, "language": "ru", "channel": "chat"}).json()
    assert j["kpis"]["evaluated"] == 4
    assert sum(b["count"] for b in j["distribution"]) == 4
    assert [x["language"] for x in j["by_language"]] == ["RU"]
    assert all(x["language"] == "RU" for x in j["attention"])
    j = c.get(API, params={"from": "2026-10-26", "to": "2026-10-30"}).json()
    assert j["kpis"]["evaluated"] == 2 and j["kpis"]["calls"] == 1
    j = c.get(API, params={"dataset": "nope"}).json()
    assert j["kpis"]["evaluated"] == 0 and j["kpis"]["avg"] is None and sum(b["count"] for b in j["distribution"]) == 0
    assert c.get(API, params={"checklist_version_id": 999}).json()["kpis"]["evaluated"] == 0
    assert c.get(API, params={"dataset": "D"}).json()["kpis"]["evaluated"] == 7


def test_final_totals_after_appeal(env):
    c, e, path = env
    conn = connect(path)
    aid = conn.execute("SELECT id FROM appeal WHERE evaluation_id = ?", (e[6],)).fetchone()[0]
    conn.execute("UPDATE appeal SET status = 'resolved' WHERE id = ?", (aid,))
    conn.execute("INSERT INTO review_decision (appeal_id, decision, new_answer, reason) VALUES (?,?,?,?)", (aid, "change", "20", "fix"))
    conn.commit()
    conn.close()
    j = c.get(API, params=PERIOD).json()
    assert j["kpis"]["open_appeals"] == 0
    assert j["kpis"]["avg"] == round((100 + 90 + 76.25 + 10 + 94.12 + 69.23) / 6, 2)
    assert j["kpis"]["avg"] == 73.27


def test_invalid_dates(env):
    c, _, _ = env
    assert c.get(API, params={"from": "bad"}).status_code == 422
    assert c.get(API, params={"from": "2026-11-05", "to": "2026-11-01"}).status_code == 422


def test_real_db_copy(tmp_path, monkeypatch):
    src = ROOT / "cqa.db"
    if not src.exists():
        pytest.skip("cqa.db missing")
    dst = tmp_path / "copy.db"
    shutil.copy(src, dst)
    monkeypatch.setenv("CQA_DB_PATH", str(dst))
    config.get_settings.cache_clear()
    with TestClient(app) as c:
        conn = connect(str(dst))
        n = conn.execute("SELECT COUNT(DISTINCT conversation_id) FROM evaluation WHERE status IN ('completed','needs_review')").fetchone()[0]
        conn.close()
        start = time.perf_counter()
        j = c.get(API).json()
        elapsed = time.perf_counter() - start
    config.get_settings.cache_clear()
    assert elapsed < 0.3
    k = j["kpis"]
    assert k["evaluated"] + k["not_calculated"] == n
    assert sum(b["count"] for b in j["distribution"]) == k["evaluated"]
    assert sum(x["count"] for x in j["by_language"]) == k["evaluated"]
    assert sum(x["count"] for x in j["by_channel"]) == k["evaluated"]
