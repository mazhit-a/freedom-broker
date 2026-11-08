import json

import pytest

from backend.app.core.database import connect, init_db
from backend.app.services import checklist as checklist_service
from backend.app.services.results_export import CODES, ExportError, build_export, validate_export

ANSWERS = {"01": "yes", "02": "na", "03": "na", "04": "15", "05": "yes", "06": "7", "07": "no", "08": "no"}


@pytest.fixture
def conn(tmp_path):
    path = str(tmp_path / "e.db")
    init_db(path)
    c = connect(path)
    checklist_service.seed_default(c)
    c.execute("INSERT INTO dataset (group_id) VALUES ('DEV')")
    for cid in ("a-1", "a-2", "a-3"):
        c.execute("INSERT INTO conversation (dataset_id, conversation_id) VALUES (1, ?)", (cid,))
    c.commit()
    yield c
    c.close()


def add_evaluation(conn, conv_pk, status="completed", total=85.384, gross=0, needs_review=False, raw=None):
    vid = conn.execute("SELECT default_version_id FROM checklist").fetchone()[0]
    cur = conn.execute(
        "INSERT INTO evaluation (conversation_id, checklist_version_id, model, status, total, gross_violation, raw_output) VALUES (?,?,?,?,?,?,?)",
        (conv_pk, vid, "gpt-6.1-sol", status, total, gross, raw),
    )
    eid = cur.lastrowid
    for k, a in {**ANSWERS, "08": "yes" if gross else "no"}.items():
        evidence = json.dumps([{"message_index": 3, "quote": "q"}, {"message_index": 4, "quote": "r"}]) if k != "07" else json.dumps([])
        rng = json.dumps({"from": 5, "to": 8}) if k == "07" else None
        conn.execute(
            "INSERT INTO criterion_result (evaluation_id, criterion_id, answer, rationale, evidence_json, checked_range, needs_review) VALUES (?,?,?,?,?,?,?)",
            (eid, k, a, "обоснование", evidence, rng, 1 if needs_review and k == "04" else 0),
        )
    conn.commit()


def test_ok_record_matches_the_format(conn):
    add_evaluation(conn, 1)
    add_evaluation(conn, 2, status="failed", total=None, raw=json.dumps({"error": "429 quota"}))
    payload = build_export(conn, "DEV", "Team")
    assert payload["schema_version"] == "1.0" and payload["team_name"] == "Team"
    assert payload["model"] == {"mode": "external_api", "name": "gpt-6.1-sol"}
    ok = payload["results"][0]
    assert ok["status"] == "ok" and [c["criterion_id"] for c in ok["criteria"]] == list(CODES)
    values = {c["criterion_id"]: c["value"] for c in ok["criteria"]}
    assert values == {
        "contact": True, "discovery": None, "identification": None, "consultation": 15,
        "empathy": True, "dialogue": 7, "closure": False, "critical": False,
    }
    assert ok["criteria"][0]["evidence_turns"] == [4, 5]
    assert ok["criteria"][6]["evidence_turns"] == [6, 9]
    assert ok["score"] == {"final_score": 85.38, "critical_flag": False}
    err = payload["results"][1]
    assert err["status"] == "error" and err["criteria"] == [] and err["score"] is None and "429 quota" in err["error"]
    missing = payload["results"][2]
    assert missing["status"] == "error" and missing["error"]


def test_needs_review_becomes_error_and_critical_flag_follows(conn):
    add_evaluation(conn, 1, needs_review=True)
    add_evaluation(conn, 2, gross=1)
    payload = build_export(conn, "DEV", "Team")
    assert payload["results"][0]["status"] == "error"
    assert payload["results"][1]["score"]["critical_flag"] is True


def test_validate_catches_problems(conn):
    add_evaluation(conn, 1)
    payload = build_export(conn, "DEV", "Team")
    payload["results"].append(dict(payload["results"][0]))
    payload["results"][0]["criteria"][0]["criterion_id"] = "x"
    problems = validate_export(payload)
    assert any("duplicate" in p for p in problems) and any("8 codes" in p for p in problems)


def test_unknown_dataset_and_wrong_criteria_count(conn):
    with pytest.raises(Exception):
        build_export(conn, "NOPE", "Team")
    vid = conn.execute("SELECT default_version_id FROM checklist").fetchone()[0]
    cfg = checklist_service.get_version(conn, vid).config.model_copy(deep=True)
    cfg.criteria = cfg.criteria[:7]
    cfg.criteria[-1].type = "flag"
    cfg.criteria[-1].weight = 0
    cfg.criteria[-1].na_allowed = False
    v = checklist_service.add_version(conn, 1, cfg)
    with pytest.raises(ExportError):
        build_export(conn, "DEV", "Team", version_id=v.id)
