import importlib.util
import json
from pathlib import Path

import pytest

from backend.app.core.config import Settings
from backend.app.core.database import connect, init_db
from backend.app.services import checklist as checklist_service
from tests.test_evaluator import add_conversation, fixed_good, payload, version_id
from tests.test_openai_client import FakeSDK, make_response

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("shadow_compare", ROOT / "scripts" / "shadow_compare.py")
sc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sc)

SECRET = "sk-test-secret-shadow-1234"
MSG_TEXT = "подать заявку в приложении"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("OPENAI_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_EFFORT", "LLM_PROMPT_VERSION", "CQA_BATCH_CONCURRENCY", "OPENAI_MAX_ATTEMPTS", "OPENAI_CALL_CEILING_S", "OPENAI_MAX_INFLIGHT", "OPENAI_MAX_OUTPUT_TOKENS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(sc, "build_settings", lambda: Settings(_env_file=None, llm_provider="openai", llm_model="gpt-6.1-sol", llm_effort="medium", llm_prompt_version="v2", openai_api_key=""))


OPUS_ANSWERS = {"01": "yes", "02": "yes", "03": "na", "04": "15", "05": "yes", "06": "7", "07": "yes", "08": "no"}


def insert_opus(conn, pk, vid, answers=None, total=88.13, gross=0, model="claude-opus-5-5"):
    answers = answers or OPUS_ANSWERS
    eid = conn.execute(
        "INSERT INTO evaluation (conversation_id, checklist_version_id, model, prompt_version, status, total, total_status, provisional, gross_violation, "
        "tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, latency_ms, cost, raw_output) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (pk, vid, model, "v1", "completed", total, "calculated", 0, gross, 100, 50, 0, 0, 9000, 0.05, "{}"),
    ).lastrowid
    for cid, ans in answers.items():
        conn.execute(
            "INSERT INTO criterion_result (evaluation_id, criterion_id, answer, points, effective_points, rationale, evidence_json, needs_review) VALUES (?,?,?,?,?,?,?,0)",
            (eid, cid, ans, None, None, "Opus rationale", "[]"),
        )
    conn.commit()
    return eid


@pytest.fixture
def copy_db(tmp_path):
    path = tmp_path / "copy.db"
    init_db(str(path))
    conn = connect(str(path))
    checklist_service.seed_default(conn)
    vid = version_id(conn)
    for cid, lang in (("p1-ru-022", "RU"), ("p1-ru-023", "RU"), ("p1-kz-013", "KZ"), ("p9-ru-001", "RU"), ("p9-ru-002", "RU")):
        pk = add_conversation(conn, cid=cid, language=lang)
        insert_opus(conn, pk, vid)
    conn.close()
    return path


def run_main(argv, sdk=None):
    return sc.main(argv, sdk=sdk)


def good_sdk(**kw):
    return FakeSDK(make_response(text=payload(fixed_good()), input_tokens=1000, cached=400, output=300, **kw))


def test_refuses_production_path(capsys):
    code = run_main(["--db", str(ROOT / "cqa.db")])
    assert code == 2
    assert "refus" in capsys.readouterr().err


def test_refuses_any_path_inside_repo(capsys):
    code = run_main(["--db", str(ROOT / "evals" / "copy.db")])
    assert code == 2
    assert "inside the repository" in capsys.readouterr().err


def test_refuses_relative_path_resolving_into_repo(monkeypatch, capsys):
    monkeypatch.chdir(ROOT)
    assert run_main(["--db", "backend/copy.db"]) == 2


def test_refuses_out_inside_repo(copy_db, capsys):
    code = run_main(["--db", str(copy_db), "--out", str(ROOT / "report.json")])
    assert code == 2
    assert "output path" in capsys.readouterr().err


def test_execute_requires_max_spend(copy_db):
    with pytest.raises(SystemExit) as exc:
        run_main(["--db", str(copy_db), "--execute"])
    assert exc.value.code == 2


def test_dry_run_prints_plan_without_key_or_calls(copy_db, capsys):
    before = copy_db.stat().st_size
    code = run_main(["--db", str(copy_db), "--conversations", "p1-ru-022,p1-ru-023,nope-1", "--max-spend", "0.2"])
    out = capsys.readouterr().out
    assert code == 0
    assert "copy.db" in out and str(copy_db.parent) not in out
    assert "gpt-6.1-sol" in out and "medium" in out and "prompt version: v2" in out
    assert "conversations found (2): p1-ru-022, p1-ru-023" in out
    assert "conversations missing (1): nope-1" in out
    assert "estimated cost per conversation: $0.0125" in out
    assert "dry run" in out
    assert copy_db.stat().st_size == before
    conn = connect(str(copy_db))
    assert conn.execute("SELECT COUNT(*) FROM evaluation").fetchone()[0] == 5
    conn.close()


def test_default_list_reports_missing_and_picks_na_and_kazakh_extras(copy_db, capsys):
    conn = connect(str(copy_db))
    vid = version_id(conn)
    pk = add_conversation(conn, cid="p2-kz-005", language="KZ")
    insert_opus(conn, pk, vid, answers={**OPUS_ANSWERS, "03": "yes"})
    pk = add_conversation(conn, cid="p0-ru-001", language="RU")
    insert_opus(conn, pk, vid, answers={**OPUS_ANSWERS, "03": "yes"})
    conn.close()
    code = run_main(["--db", str(copy_db)])
    out = capsys.readouterr().out
    assert code == 0
    assert "p1-ru-022" in out and "p1-kz-013" in out
    assert "p4-ru-004" in out.split("conversations missing")[1]
    found_line = next(line for line in out.splitlines() if line.startswith("conversations found"))
    assert "p9-ru-001" in found_line
    assert "p2-kz-005" in found_line
    assert "p9-ru-002" in found_line


def test_execute_without_key_is_infrastructure_error(copy_db, capsys):
    assert run_main(["--db", str(copy_db), "--max-spend", "0.2", "--execute"]) == 1
    assert "OPENAI_API_KEY is not set" in capsys.readouterr().err


def test_execute_compares_against_latest_opus_and_writes_json(copy_db, tmp_path, capsys):
    conn = connect(str(copy_db))
    vid = version_id(conn)
    pk = conn.execute("SELECT id FROM conversation WHERE conversation_id = 'p1-ru-023'").fetchone()[0]
    insert_opus(conn, pk, vid, answers={**OPUS_ANSWERS, "02": "no", "04": "10", "03": "yes"}, total=60.0, gross=1)
    conn.close()
    out_file = tmp_path / "out" / "report.json"
    sdk = good_sdk()
    code = run_main(["--db", str(copy_db), "--conversations", "p1-ru-022,p1-ru-023,missing-9", "--max-spend", "1", "--execute", "--out", str(out_file)], sdk=sdk)
    out = capsys.readouterr().out
    assert code == 0
    assert len(sdk.calls) == 2
    report = json.loads(out_file.read_text(encoding="utf-8"))
    assert set(report) == {"plan", "conversations", "aggregate", "acceptance"}
    assert report["plan"]["missing"] == ["missing-9"]
    by = {r["conversation_id"]: r for r in report["conversations"]}
    first, second = by["p1-ru-022"], by["p1-ru-023"]
    assert first["status"] == "completed" and first["repair_turns"] == 0
    assert first["tokens_input"] == 600 and first["tokens_output"] == 300 and first["tokens_cache_read"] == 400
    assert first["cost"] == pytest.approx(0.00424)
    assert first["answer_matches"] == 8 and first["flips"] == [] and first["total_abs_diff"] == 0
    assert first["gross_agrees"] is True
    assert second["baseline_total"] == 60.0
    assert second["total_abs_diff"] == pytest.approx(28.13)
    assert second["flips"] == ["02", "03"]
    assert second["one_step"] == ["04"]
    assert second["gross_agrees"] is False
    agg = report["aggregate"]
    assert agg["gross_disagreements"] == ["p1-ru-023"]
    assert agg["flips_by_criterion"]["02"] == 1 and agg["flips_by_criterion"]["01"] == 0
    assert agg["mean_tokens_input"] == 600 and agg["mean_tokens_output"] == 300 and agg["mean_tokens_cache_read"] == 400
    assert agg["failed"] == 0 and agg["needs_review"] == 0 and agg["repair_turns"] == 0
    verdicts = {a["name"]: a["pass"] for a in report["acceptance"]}
    assert verdicts["0 failed"] and verdicts["0 repair turns"]
    assert verdicts["gross-violation agrees on every chosen conversation"] is False
    assert verdicts["mean cost <= 0.02"]
    assert verdicts["median absolute total-score difference <= 5"] is False
    assert "PASS 0 failed" in out and "FAIL gross-violation agrees" in out
    conn = connect(str(copy_db))
    new_rows = conn.execute("SELECT COUNT(*) FROM evaluation WHERE model = 'gpt-6.1-sol' AND prompt_version = 'v2'").fetchone()[0]
    assert new_rows == 2
    conn.close()


def test_report_has_no_key_no_text_only_ids(copy_db, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sc, "build_settings", lambda: Settings(_env_file=None, llm_provider="openai", llm_model="gpt-6.1-sol", llm_effort="medium", llm_prompt_version="v2", openai_api_key=SECRET))
    out_file = tmp_path / "report.json"
    code = run_main(["--db", str(copy_db), "--conversations", "p1-ru-022", "--max-spend", "1", "--execute", "--out", str(out_file)], sdk=good_sdk())
    out = capsys.readouterr()
    text = out_file.read_text(encoding="utf-8")
    assert code == 0
    for blob in (text, out.out, out.err):
        assert SECRET not in blob
        assert MSG_TEXT not in blob and "Opus rationale" not in blob and "Оператор" not in blob
        assert "http" not in blob and str(copy_db.parent) not in blob


def test_max_spend_guard_stops_further_calls(copy_db, capsys):
    sdk = good_sdk()
    code = run_main(["--db", str(copy_db), "--conversations", "p1-ru-022,p1-ru-023,p1-kz-013", "--max-spend", "0.012", "--execute"], sdk=sdk)
    out = capsys.readouterr().out
    assert code == 0
    assert len(sdk.calls) == 1
    assert "p1-ru-023: skipped_budget" in out and "p1-kz-013: skipped_budget" in out
    assert "FAIL all planned conversations evaluated" in out


def test_failed_and_needs_review_are_counted_and_fail_acceptance(copy_db, tmp_path, capsys):
    sdk = FakeSDK(make_response(text="not json"), make_response(text="not json"))
    out_file = tmp_path / "r.json"
    code = run_main(["--db", str(copy_db), "--conversations", "p1-ru-022", "--max-spend", "1", "--execute", "--out", str(out_file)], sdk=sdk)
    assert code == 0
    report = json.loads(out_file.read_text(encoding="utf-8"))
    agg = report["aggregate"]
    assert agg["needs_review"] == 1 and agg["repair_turns"] == 1
    verdicts = {a["name"]: a["pass"] for a in report["acceptance"]}
    assert verdicts["0 needs_review"] is False and verdicts["0 repair turns"] is False


def test_acceptance_thresholds_and_percentiles():
    cfg = checklist_service.load_seed_config()

    def row(cid, latency, cost=0.01, diff=1.0, flips=()):
        return {
            "conversation_id": cid, "status": "completed", "repair_turns": 0, "tokens_input": 10, "tokens_output": 5, "tokens_cache_read": 0,
            "cost": cost, "latency_ms": latency, "total_abs_diff": diff, "gross_agrees": True, "flips": list(flips),
        }

    rows = [row(f"c{i}", 1000 * (i + 1), flips=["02"] if i < 3 else []) for i in range(10)]
    agg = sc.aggregate(rows, cfg)
    assert agg["latency_ms_p50"] == 5000 and agg["latency_ms_p95"] == 10000
    assert agg["flips_by_criterion"]["02"] == 3
    assert all(a["pass"] for a in sc.acceptance(agg, 10))
    rows[3]["flips"] = ["02"]
    lines = {a["name"]: a["pass"] for a in sc.acceptance(sc.aggregate(rows, cfg), 10)}
    assert lines["no criterion flipping on more than 3 of 10 conversations"] is False
    slow = [row("a", 25000), row("b", 1000)]
    lines = {a["name"]: a["pass"] for a in sc.acceptance(sc.aggregate(slow, cfg), 2)}
    assert lines["p95 latency <= 20 s"] is False
    pricey = [row("a", 1000, cost=0.03)]
    assert {a["name"]: a["pass"] for a in sc.acceptance(sc.aggregate(pricey, cfg), 1)}["mean cost <= 0.02"] is False
    far = [row("a", 1000, diff=9.0), row("b", 1000, diff=7.0)]
    assert {a["name"]: a["pass"] for a in sc.acceptance(sc.aggregate(far, cfg), 2)}["median absolute total-score difference <= 5"] is False
