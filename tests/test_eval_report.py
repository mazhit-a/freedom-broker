import copy

import pytest

from evals import prices, report
from evals.graders import load_checklist
from evals.judge import judge_text
from tests.test_eval_graders import candidate_from, make_case, make_dataset
from tests.test_eval_judge import canned

CFG = load_checklist()
DS = make_dataset()


def call(model="claude-sonnet-5-5", inp=1000, out=200, cr=0, cw=0, lat=1000, cost=None):
    return {
        "model": model,
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_tokens": cr,
        "cache_write_tokens": cw,
        "latency_ms": lat,
        "cost": cost,
        "structured": True,
    }


def make_run(name="A", mode="live", wrong=(), lat=(1000, 2000, 3000), cost=None):
    cands, judgements = [], {}
    for i, case in enumerate(DS["cases"]):
        cand = candidate_from(case, variant=name, mode=mode, calls=[call(lat=lat[i], cr=500, cost=cost)])
        if case["id"] in wrong:
            cand["results"]["01"]["answer"] = "no"
            cand["results"]["08"]["answer"] = "no" if case["expected"]["08"]["answer"] == "yes" else "yes"
        cands.append(cand)
        judgements[case["id"]] = judge_text(canned(case, cand), case, cand, CFG)
    return {"name": name, "dataset": DS, "candidates": cands, "judgements": judgements}


def test_cost_math():
    assert prices.cost("claude-sonnet-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000) == pytest.approx(2.0 + 10.0 + 0.2 + 2.5)
    assert prices.cost("claude-opus-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000) == pytest.approx(29.2)
    assert prices.cost("claude-haiku-4-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000) == pytest.approx(7.35)
    assert prices.cost("typesafe/jev-1.14", 1_000_000, 500) == pytest.approx(0.042)
    assert prices.cost("claude-sonnet-5-5", 1000, 100, batch=True) == pytest.approx(0.5 * (2.0 * 1000 + 10.0 * 100) / 1e6)
    assert prices.cost("claude-haiku-4-5-20251001", 1_000_000) == 1.0
    with pytest.raises(prices.UnknownModel):
        prices.cost("nope", 1)
    assert prices.call_cost({"model": "nope"}) is None


def test_cost_stats_recomputed_from_usage():
    run = make_run()
    c = report.cost_stats(run["candidates"])
    per = (1000 * 2.0 + 200 * 10.0 + 500 * 0.2) / 1e6
    assert c["cost_per_conversation"] == pytest.approx(per)
    assert c["projected_per_1000"] == pytest.approx(per * 1000)
    assert c["cache_read_share"] == pytest.approx(500 / 1500)
    assert c["mean_calls"] == 1 and c["mean_input"] == 1000
    assert c["recorded_spend"] is None
    rec = report.cost_stats(make_run(cost=0.01)["candidates"])
    assert rec["recorded_spend"] == pytest.approx(0.03)


def test_unpriced_model_counted_not_guessed():
    cands = [{"case_id": "c1", "calls": [call(model="mystery")]}]
    c = report.cost_stats(cands)
    assert c["unpriced_calls"] == 1
    assert c["cost_per_conversation"] == 0.0


def test_latency_excludes_batch_rows():
    live = make_run(mode="live")["candidates"]
    batch = make_run(mode="batch", lat=(90000, 90000, 90000))["candidates"]
    stats = report.latency_stats(live + batch)
    assert stats["n_live"] == 3 and stats["n_batch_excluded"] == 3
    assert stats["p50_ms"] == 2000
    assert stats["p95_ms"] == pytest.approx(2900)
    only_batch = report.latency_stats(batch)
    assert only_batch["n_live"] == 0 and only_batch["p50_ms"] is None
    rep = report.run_report(make_run(mode="batch"), CFG)
    assert "Batch-mode conversations excluded | 3" in rep


def test_latency_sums_calls_per_conversation_and_skips_errors():
    cands = make_run()["candidates"]
    cands[0]["calls"].append(call(lat=500))
    cands[1]["error"] = "x"
    stats = report.latency_stats(cands)
    assert stats["n_live"] == 2
    assert stats["p50_ms"] == pytest.approx((1500 + 3000) / 2)


def test_errors_not_counted_as_wrong_in_report():
    run = make_run()
    run["candidates"][0]["error"] = "APIError"
    run["candidates"][0]["results"] = {}
    del run["judgements"]["c1"]
    s = report.summarize_run(run, CFG)
    assert s["grades"]["answer_accuracy_exact"] == 1.0
    assert s["grades"]["validity"]["n_error"] == 1
    assert s["judge"]["score"] == 10
    text = report.run_report(run, CFG)
    assert "Errors (counted apart, not scored wrong) | 1" in text


def test_report_deterministic_and_sections():
    run = make_run(wrong=("c2",))
    a = report.run_report(run, CFG)
    b = report.run_report(copy.deepcopy(run), CFG)
    assert a == b
    for heading in ("## Quality", "## Per-criterion", "## Breakdown by tag", "### language", "### channel", "### length", "## Validity", "## Cost", "## Latency", "## Worst cases"):
        assert heading in a
    assert "08 recall" in a and "Projected cost per 1000" in a
    worst = report.worst_cases(report.summarize_run(run, CFG))
    assert worst[0][0] == "c2"


def test_breakdown_groups_by_tags():
    s = report.summarize_run(make_run(wrong=("c2",)), CFG)
    langs = {r[0]: r for r in s["breakdown"]["language"]}
    assert set(langs) == {"ru", "kk"}
    assert langs["ru"][1] == "2"
    assert langs["kk"][3] != "100.0%"


def test_leaderboard_deterministic_and_noise_floor():
    a = make_run("A")
    b = make_run("B")
    text = report.leaderboard([a, b], CFG)
    assert text == report.leaderboard([b, a], CFG)
    assert report.NO_DIFF in text
    assert "Latency is taken from live-mode rows only" in text


def test_leaderboard_detects_real_difference():
    ids = [f"k{i}" for i in range(12)]
    big_ds = {"version": 1, "checklist": "v2", "hash": "h", "cases": []}
    runs = {"good": [], "bad": []}
    judgements = {"good": {}, "bad": {}}
    for i in ids:
        case = make_case(i)
        big_ds["cases"].append(case)
        for name in runs:
            cand = candidate_from(case, variant=name)
            if name == "bad":
                for cid in ("01", "02", "05", "07"):
                    cand["results"][cid]["answer"] = "no" if cand["results"][cid]["answer"] == "yes" else "yes"
            runs[name].append(cand)
            judgements[name][i] = judge_text(canned(case, cand), case, cand, CFG)
    rs = [{"name": n, "dataset": big_ds, "candidates": runs[n], "judgements": judgements[n]} for n in runs]
    text = report.leaderboard(rs, CFG)
    assert "good better" in text
    assert report.NO_DIFF not in text
    assert text.index("| 1 | good") < text.index("| 2 | bad")


def test_compare_single_variant_has_no_paired_section():
    text = report.leaderboard([make_run("only")], CFG)
    assert "Paired comparison" not in text
