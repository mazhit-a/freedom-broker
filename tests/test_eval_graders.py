import copy

import pytest

from evals import graders
from evals.graders import (
    bootstrap_ci,
    consistency,
    grade_case,
    grade_run,
    load_checklist,
    paired_diff_ci,
    percentile,
)

CFG = load_checklist()
IDS = [c.id for c in CFG.criteria]


def make_row(answer, idx=1, quote="hello there", rationale="because"):
    return {
        "answer": answer,
        "rationale": rationale,
        "evidence": [{"message_index": idx, "quote": quote}],
        "checked_range": None,
        "na_reason": None,
    }


def make_case(case_id, violation=False, language="ru", channel="call", length="short"):
    messages = [
        {"message_index": 0, "timestamp_raw": "00:00", "offset_seconds": 0, "speaker": "operator", "text": "hello there, how can I help"},
        {"message_index": 1, "timestamp_raw": "00:05", "offset_seconds": 5, "speaker": "client", "text": "I want to check my deposit balance"},
        {"message_index": 2, "timestamp_raw": "00:09", "offset_seconds": 9, "speaker": "operator", "text": "your balance is fine, goodbye"},
    ]
    answers = {"01": "yes", "02": "yes", "03": "na", "04": 20, "05": "no", "06": 10, "07": "yes", "08": "yes" if violation else "no"}
    expected = {cid: make_row(ans, idx=i % 3, quote=messages[i % 3]["text"]) for i, (cid, ans) in enumerate(answers.items())}
    return {
        "id": case_id,
        "split": "dev",
        "tags": {"channel": channel, "language": language, "length": length, "topic": "t", "hard": []},
        "conversation": {"channel": channel, "language": language, "messages": messages},
        "expected": expected,
        "review": {},
    }


def make_dataset():
    return {
        "version": 1,
        "checklist": "v2",
        "hash": "x",
        "cases": [
            make_case("c1"),
            make_case("c2", violation=True, language="kk", channel="chat", length="long"),
            make_case("c3"),
        ],
    }


def candidate_from(case, variant="v", mode="live", calls=None):
    return {
        "case_id": case["id"],
        "variant": variant,
        "results": copy.deepcopy(case["expected"]),
        "needs_review": {},
        "calls": calls if calls is not None else [],
        "refused": False,
        "error": None,
        "mode": mode,
    }


def test_oracle_is_perfect():
    ds = make_dataset()
    cands = [candidate_from(c) for c in ds["cases"]]
    res = grade_run(ds, cands, CFG)
    assert res["answer_accuracy_exact"] == 1.0
    assert res["answer_accuracy_partial"] == 1.0
    assert res["gross"]["recall"] == 1.0
    assert res["gross"]["precision"] == 1.0
    assert res["gross"]["f1"] == 1.0
    assert res["validity"]["evidence_grounded_rate"] == 1.0
    assert res["validity"]["needs_review_rate"] == 0.0
    assert all(r["exact"] == 1.0 for r in res["criteria"] if r["n_answered"])


def test_constant_yes_is_low_and_misses_na_and_gross_precision():
    ds = make_dataset()
    cands = []
    for c in ds["cases"]:
        cand = candidate_from(c)
        for cid in IDS:
            crit = {x.id: x for x in CFG.criteria}[cid]
            cand["results"][cid]["answer"] = crit.max_step if crit.type == "scale" else "yes"
        cands.append(cand)
    res = grade_run(ds, cands, CFG)
    assert res["answer_accuracy_exact"] == pytest.approx(0.65)
    assert res["gross"]["recall"] == 1.0
    assert res["gross"]["precision"] == pytest.approx(1 / 3)
    assert res["confusion"]["na"]["yes"] == 3


def test_empty_output_error_refusal_not_scored_wrong():
    ds = make_dataset()
    empty = candidate_from(ds["cases"][0])
    empty["results"] = {}
    err = candidate_from(ds["cases"][1])
    err["results"] = {}
    err["error"] = "APIError: boom"
    ref = candidate_from(ds["cases"][2])
    ref["refused"] = True
    res = grade_run(ds, [empty, err, ref], CFG)
    assert res["answer_accuracy_exact"] is None
    v = res["validity"]
    assert (v["n_empty_output"], v["n_error"], v["n_refused"], v["n_ok"]) == (1, 1, 1, 0)
    assert all(g["unweighted_exact"] is None for g in res["graded"])
    assert res["gross"]["skipped"] == 0
    assert res["gross"]["recall"] is None


def test_missing_cases_counted_as_not_run():
    ds = make_dataset()
    res = grade_run(ds, [candidate_from(ds["cases"][0])], CFG)
    assert res["n_not_run"] == 2
    assert res["answer_accuracy_exact"] == 1.0


def test_needs_review_excluded_from_accuracy():
    ds = make_dataset()
    cand = candidate_from(ds["cases"][0])
    cand["results"]["01"]["answer"] = "needs_review"
    cand["needs_review"] = {"02": "unclear"}
    del cand["results"]["03"]
    g = grade_case(ds["cases"][0], cand, CFG)
    assert g["criteria"]["01"]["state"] == "needs_review"
    assert g["criteria"]["02"]["state"] == "needs_review"
    assert g["criteria"]["03"]["state"] == "omitted"
    assert g["weighted_exact"] == 1.0
    v = grade_run(ds, [cand], CFG)["validity"]
    assert v["needs_review_rate"] == pytest.approx(2 / 8)


def test_weighted_accuracy_uses_scoring_weights():
    ds = make_dataset()
    cand = candidate_from(ds["cases"][0])
    cand["results"]["01"]["answer"] = "no"
    g = grade_case(ds["cases"][0], cand, CFG)
    total = sum(c.weight for c in CFG.criteria)
    assert g["weighted_exact"] == pytest.approx((total - 10) / total)
    assert g["unweighted_exact"] == pytest.approx(7 / 8)


def test_scale_partial_vs_exact():
    ds = make_dataset()
    cand = candidate_from(ds["cases"][0])
    cand["results"]["04"]["answer"] = 15
    g = grade_case(ds["cases"][0], cand, CFG)
    assert g["criteria"]["04"]["exact"] is False
    assert g["criteria"]["04"]["partial"] == pytest.approx(0.75)
    assert g["weighted_partial"] > g["weighted_exact"]


def test_string_answers_normalised():
    ds = make_dataset()
    cand = candidate_from(ds["cases"][0])
    cand["results"]["04"]["answer"] = "20"
    cand["results"]["03"]["answer"] = "N/A"
    cand["results"]["01"]["answer"] = "Yes"
    assert grade_case(ds["cases"][0], cand, CFG)["weighted_exact"] == 1.0


def test_gross_metrics_counts():
    ds = make_dataset()
    cands = [candidate_from(c) for c in ds["cases"]]
    cands[1]["results"]["08"]["answer"] = "no"
    cands[0]["results"]["08"]["answer"] = "yes"
    gm = grade_run(ds, cands, CFG)["gross"]
    assert (gm["tp"], gm["fn"], gm["fp"], gm["tn"]) == (0, 1, 1, 1)
    assert gm["recall"] == 0.0
    assert gm["precision"] == 0.0
    assert gm["f1"] is None


def test_evidence_grounding_detects_fabricated_quotes():
    ds = make_dataset()
    cand = candidate_from(ds["cases"][0])
    cand["results"]["01"]["evidence"] = [{"message_index": 1, "quote": "completely invented sentence about nothing"}]
    cand["results"]["02"]["evidence"] = [{"message_index": 99, "quote": "hello there"}]
    v = grade_run(ds, [cand], CFG)["validity"]
    assert v["evidence_items"] == 8
    assert v["evidence_grounded_rate"] == pytest.approx(6 / 8)


def test_repair_and_truncation_rates():
    ds = make_dataset()
    call = {"model": "claude-haiku-4-5", "input_tokens": 1, "output_tokens": 1, "cache_read_tokens": 0, "cache_write_tokens": 0, "latency_ms": 5, "cost": 0.0, "structured": True}
    a = candidate_from(ds["cases"][0], calls=[call])
    b = candidate_from(ds["cases"][1], calls=[call, call])
    c = candidate_from(ds["cases"][2], calls=[dict(call, stop_reason="max_tokens")])
    v = grade_run(ds, [a, b, c], CFG)["validity"]
    assert v["repair_turn_rate"] == pytest.approx(1 / 3)
    assert v["truncation_rate"] == pytest.approx(1 / 3)
    assert v["refusal_rate"] == 0.0


def test_consistency_across_repeats():
    ds = make_dataset()
    a = candidate_from(ds["cases"][0])
    b = candidate_from(ds["cases"][0])
    b["results"]["01"]["answer"] = "no"
    r = consistency([a, b, candidate_from(ds["cases"][1])], CFG)
    assert r["n_cases"] == 1
    assert r["all_reps_agree_rate"] == pytest.approx(7 / 8)
    assert r["per_criterion"]["01"] == 0.0
    assert r["pairwise_agreement"] == pytest.approx(7 / 8)
    same = consistency([a, candidate_from(ds["cases"][0])], CFG)
    assert same["all_reps_agree_rate"] == 1.0


def test_calibration_table():
    ds = make_dataset()
    cand = candidate_from(ds["cases"][0])
    cand["results"]["01"]["confidence"] = 0.95
    cand["results"]["02"]["confidence"] = 0.95
    cand["results"]["02"]["answer"] = "no"
    cand["results"]["05"]["confidence"] = 0.3
    table = grade_run(ds, [cand], CFG)["calibration"]
    top = [r for r in table if r["bucket"] == "0.9-1.0"][0]
    low = [r for r in table if r["bucket"] == "0.0-0.5"][0]
    assert (top["n"], top["accuracy"]) == (2, 0.5)
    assert (low["n"], low["accuracy"]) == (1, 1.0)
    assert grade_run(ds, [candidate_from(ds["cases"][0])], CFG)["calibration"][0]["n"] == 0


def test_bootstrap_ci_deterministic_and_bracketing():
    vals = [float(x) for x in range(1, 21)]
    a = bootstrap_ci(vals)
    assert a == bootstrap_ci(vals)
    assert a[1] < a[0] < a[2]
    assert bootstrap_ci([3.0]) == (3.0, 3.0, 3.0)
    assert bootstrap_ci([]) == (None, None, None)
    assert bootstrap_ci(vals, seed=1) != a


def test_paired_diff_ci_identical_includes_zero():
    s = {f"c{i}": float(i) for i in range(10)}
    m, lo, hi, n = paired_diff_ci(s, dict(s))
    assert (m, lo, hi, n) == (0.0, 0.0, 0.0, 10)


def test_percentile():
    assert percentile([1, 2, 3, 4], 0.5) == 2.5
    assert percentile([10], 0.95) == 10
    assert percentile([], 0.5) is None


def test_checklist_loads_and_flag_id():
    assert graders.flag_id(CFG) == "08"
