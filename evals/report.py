from collections import defaultdict
from typing import Any

from backend.app.schemas.checklist import ChecklistConfig
from evals.graders import (
    grade_run,
    index_cases,
    load_checklist,
    mean,
    paired_diff_ci,
    percentile,
    rate,
)
from evals.judge import summarize
from evals.prices import call_cost

TAG_KEYS = ("language", "channel", "length")
WORST_N = 5
NO_DIFF = "no detectable difference"


def fmt(x: float | None, nd: int = 3) -> str:
    return "n/a" if x is None else f"{x:.{nd}f}"


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.1f}%"


def usd(x: float | None, nd: int = 4) -> str:
    return "n/a" if x is None else f"${x:.{nd}f}"


def table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(lines)


def ci_text(m: float | None, lo: float | None, hi: float | None, nd: int = 2) -> str:
    return "n/a" if m is None else f"{m:.{nd}f} [{lo:.{nd}f}, {hi:.{nd}f}]"


def cost_stats(candidates: list[dict]) -> dict:
    per_case = []
    unpriced = 0
    recorded = 0.0
    has_recorded = False
    for cand in candidates:
        calls = cand.get("calls") or []
        if not calls:
            continue
        tot = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "calls": len(calls), "cost": 0.0}
        for call in calls:
            tot["input"] += int(call.get("input_tokens") or 0)
            tot["output"] += int(call.get("output_tokens") or 0)
            tot["cache_read"] += int(call.get("cache_read_tokens") or 0)
            tot["cache_write"] += int(call.get("cache_write_tokens") or 0)
            c = call_cost(call)
            if c is None:
                unpriced += 1
            else:
                tot["cost"] += c
            if call.get("cost") is not None:
                has_recorded = True
                recorded += float(call["cost"])
        per_case.append(tot)
    n = len(per_case)
    all_in = sum(t["input"] + t["cache_read"] + t["cache_write"] for t in per_case)
    cpc = mean([t["cost"] for t in per_case])
    return {
        "n": n,
        "mean_input": mean([t["input"] for t in per_case]),
        "mean_output": mean([t["output"] for t in per_case]),
        "mean_cache_read": mean([t["cache_read"] for t in per_case]),
        "mean_cache_write": mean([t["cache_write"] for t in per_case]),
        "mean_calls": mean([t["calls"] for t in per_case]),
        "cache_read_share": rate(sum(t["cache_read"] for t in per_case), all_in),
        "cost_per_conversation": cpc,
        "projected_per_1000": None if cpc is None else cpc * 1000,
        "recorded_spend": recorded if has_recorded else None,
        "unpriced_calls": unpriced,
    }


def latency_stats(candidates: list[dict]) -> dict:
    live, batch = [], 0
    for cand in candidates:
        if not cand.get("calls") or cand.get("error"):
            continue
        if cand.get("mode") == "live":
            live.append(float(sum(int(c.get("latency_ms") or 0) for c in cand["calls"])))
        else:
            batch += 1
    return {
        "n_live": len(live),
        "n_batch_excluded": batch,
        "p50_ms": percentile(live, 0.5),
        "p95_ms": percentile(live, 0.95),
    }


def dispute_stats(candidates: list[dict]) -> dict | None:
    explained = [c for c in candidates if isinstance(c.get("disputes"), dict)]
    if not explained:
        return None
    total = sum(len(c.get("results") or {}) for c in explained)
    disputed = sum(len(c["disputes"]) for c in explained)
    return {"n_candidates": len(explained), "disputed": disputed, "criteria": total, "rate": rate(disputed, total)}


def judged_scores(judgements: dict[str, dict]) -> dict[str, float]:
    return {
        cid: j["case_score"]
        for cid, j in judgements.items()
        if "error" not in j and j.get("case_score") is not None
    }


def breakdown(dataset: dict, judgements: dict[str, dict], grades: dict) -> dict[str, list[list[str]]]:
    cases = index_cases(dataset)
    acc = {g["case_id"]: g["weighted_exact"] for g in grades["graded"] if g["weighted_exact"] is not None}
    scores = judged_scores(judgements)
    out: dict[str, list[list[str]]] = {}
    for key in TAG_KEYS:
        groups: dict[str, set[str]] = defaultdict(set)
        for cid in set(scores) | set(acc):
            case = cases.get(cid)
            if case is not None:
                groups[str((case.get("tags") or {}).get(key))].add(cid)
        rows = []
        for val in sorted(groups):
            ids = sorted(groups[val])
            rows.append(
                [
                    val,
                    str(len(ids)),
                    fmt(mean([scores[i] for i in ids if i in scores]), 2),
                    pct(mean([acc[i] for i in ids if i in acc])),
                ]
            )
        out[key] = rows
    return out


def summarize_run(run: dict, cfg: ChecklistConfig | None = None) -> dict:
    cfg = cfg or load_checklist()
    candidates = run["candidates"]
    judgements = run.get("judgements") or {}
    grades = grade_run(run["dataset"], candidates, cfg, run.get("expected_calls", 1))
    return {
        "name": run.get("name", "run"),
        "grades": grades,
        "judge": summarize(list(judgements.values())),
        "scores": judged_scores(judgements),
        "disputes": dispute_stats(candidates),
        "cost": cost_stats(candidates),
        "latency": latency_stats(candidates),
        "breakdown": breakdown(run["dataset"], judgements, grades),
    }


def worst_cases(summary: dict, n: int = WORST_N) -> list[tuple[str, float]]:
    return sorted(summary["scores"].items(), key=lambda kv: (kv[1], kv[0]))[:n]


def run_report(run: dict, cfg: ChecklistConfig | None = None) -> str:
    cfg = cfg or load_checklist()
    s = summarize_run(run, cfg)
    g, j, c, lat = s["grades"], s["judge"], s["cost"], s["latency"]
    v, gm = g["validity"], g["gross"]
    out = [f"# Eval report: {s['name']}", ""]
    meta = run.get("meta") or {}
    if meta:
        out += [f"- {k}: {meta[k]}" for k in sorted(meta)] + [""]

    out += ["## Quality", ""]
    out.append(
        table(
            ["Metric", "Value"],
            [
                ["Judge score (0-10, 95% CI)", ci_text(j["score"], *j["ci"])],
                ["Cases judged", j["n_judged"]],
                ["Judge failures (not scored)", j["n_judge_failed"]],
                ["Answer accuracy, checklist-weighted exact", pct(g["answer_accuracy_exact"])],
                ["Answer accuracy, scale partial credit", pct(g["answer_accuracy_partial"])],
                ["Judge answer-correct rate", pct(j["answer_correct_rate"])],
                ["Reasoning-correct rate", pct(j["reasoning_correct_rate"])],
                ["Evidence-correct rate", pct(j["evidence_correct_rate"])],
                ["Criterion 08 judge score", fmt(j["c08_score"], 2)],
                ["08 recall", pct(gm["recall"])],
                ["08 precision", pct(gm["precision"])],
                ["08 F1", fmt(gm["f1"])],
                ["Judge bugs (judge vs code mismatch)", j["judge_bug_count"]],
            ],
        )
    )
    out += ["", f"08 counts: tp={gm['tp']} fp={gm['fp']} fn={gm['fn']} tn={gm['tn']}", ""]

    out += ["## Per-criterion", ""]
    out.append(
        table(
            ["Criterion", "Type", "Weight", "Answered", "Needs review", "Omitted", "Exact", "Partial"],
            [
                [
                    f"{r['id']} {r['title']}",
                    r["type"],
                    f"{r['weight']:g}",
                    r["n_answered"],
                    r["n_needs_review"],
                    r["n_omitted"],
                    pct(r["exact"]),
                    pct(r["partial"]),
                ]
                for r in g["criteria"]
            ],
        )
    )
    out += ["", "## Confusion matrix (rows expected, columns candidate; yes/no and flag criteria)", ""]
    labels = ["yes", "no", "na"]
    out.append(table(["expected"] + labels, [[e] + [g["confusion"][e][x] for x in labels] for e in labels]))

    out += ["", "## Breakdown by tag", ""]
    for key in TAG_KEYS:
        out += [f"### {key}", ""]
        out.append(table([key, "Cases", "Judge score", "Answer accuracy"], s["breakdown"][key]))
        out.append("")

    out += ["## Validity", ""]
    out.append(
        table(
            ["Metric", "Value"],
            [
                ["Candidates", v["n_candidates"]],
                ["Delivered", v["n_ok"]],
                ["Errors (counted apart, not scored wrong)", v["n_error"]],
                ["Refusals (counted apart)", v["n_refused"]],
                ["Empty outputs (counted apart)", v["n_empty_output"]],
                ["Dataset cases not run", g["n_not_run"]],
                ["Needs-review rate", pct(v["needs_review_rate"])],
                ["Repair-turn rate", pct(v["repair_turn_rate"])],
                ["Refusal rate", pct(v["refusal_rate"])],
                ["Truncation rate", pct(v["truncation_rate"])],
                ["Evidence-grounded rate", f"{pct(v['evidence_grounded_rate'])} of {v['evidence_items']} items"],
                ["Repeat consistency (all reps agree)", pct(g["consistency"]["all_reps_agree_rate"])],
            ],
        )
    )
    if s.get("disputes"):
        d = s["disputes"]
        out += ["", f"Explainer dispute rate: {pct(d['rate'])} ({d['disputed']} of {d['criteria']} explained criteria)"]
    if any(row["n"] for row in g["calibration"]):
        out += ["", "### Confidence calibration", ""]
        out.append(
            table(
                ["Confidence", "N", "Accuracy", "Mean confidence"],
                [[r["bucket"], r["n"], pct(r["accuracy"]), fmt(r["mean_confidence"], 2)] for r in g["calibration"]],
            )
        )

    out += ["", "## Cost (live prices recomputed from usage)", ""]
    out.append(
        table(
            ["Metric", "Value"],
            [
                ["Conversations with usage", c["n"]],
                ["Input tokens per case", fmt(c["mean_input"], 0)],
                ["Output tokens per case", fmt(c["mean_output"], 0)],
                ["Cache-read tokens per case", fmt(c["mean_cache_read"], 0)],
                ["Cache-write tokens per case", fmt(c["mean_cache_write"], 0)],
                ["Calls per case", fmt(c["mean_calls"], 2)],
                ["Cache-read share of input", pct(c["cache_read_share"])],
                ["Cost per conversation", usd(c["cost_per_conversation"], 5)],
                ["Projected cost per 1000 conversations", usd(c["projected_per_1000"], 2)],
                ["Actual spend recorded", usd(c["recorded_spend"], 4)],
                ["Calls with unpriced model", c["unpriced_calls"]],
            ],
        )
    )

    out += ["", "## Latency (live-mode calls only)", ""]
    out.append(
        table(
            ["Metric", "Value"],
            [
                ["Live conversations", lat["n_live"]],
                ["p50 per conversation (ms)", fmt(lat["p50_ms"], 0)],
                ["p95 per conversation (ms)", fmt(lat["p95_ms"], 0)],
                ["Batch-mode conversations excluded", lat["n_batch_excluded"]],
            ],
        )
    )

    out += ["", "## Worst cases (lowest judge score)", ""]
    worst = worst_cases(s)
    out.append(table(["Case", "Judge score"], [[cid, fmt(sc, 2)] for cid, sc in worst]) if worst else "none judged")
    return "\n".join(out) + "\n"


def compare(a: dict, b: dict) -> tuple[str, int]:
    m, lo, hi, n = paired_diff_ci(a["scores"], b["scores"])
    if m is None:
        return "n/a", 0
    if lo <= 0 <= hi:
        return NO_DIFF, n
    return ("better" if m > 0 else "worse"), n


def leaderboard(runs: list[dict], cfg: ChecklistConfig | None = None) -> str:
    cfg = cfg or load_checklist()
    sums = [summarize_run(r, cfg) for r in runs]
    sums.sort(key=lambda s: (-(s["judge"]["score"] if s["judge"]["score"] is not None else -1.0), s["name"]))
    out = ["# Variant leaderboard", ""]
    rows = []
    for rank, s in enumerate(sums, 1):
        j, g, c, lat = s["judge"], s["grades"], s["cost"], s["latency"]
        rows.append(
            [
                rank,
                s["name"],
                ci_text(j["score"], *j["ci"]),
                pct(g["answer_accuracy_exact"]),
                pct(j["reasoning_correct_rate"]),
                pct(j["evidence_correct_rate"]),
                pct(g["gross"]["recall"]),
                pct(g["gross"]["precision"]),
                usd(c["cost_per_conversation"], 5),
                usd(c["projected_per_1000"], 2),
                fmt(lat["p50_ms"], 0) if lat["n_live"] else "n/a (no live rows)",
            ]
        )
    out.append(
        table(
            [
                "#",
                "Variant",
                "Judge score [95% CI]",
                "Answer acc",
                "Reasoning ok",
                "Evidence ok",
                "08 recall",
                "08 precision",
                "$/conv",
                "$/1000",
                "p50 ms (live)",
            ],
            rows,
        )
    )
    if len(sums) > 1:
        top = sums[0]
        out += ["", f"## Paired comparison against {top['name']} (judge score, paired bootstrap)", ""]
        cmp_rows = []
        for s in sums[1:]:
            verdict, n = compare(top, s)
            m, lo, hi, _ = paired_diff_ci(top["scores"], s["scores"])
            label = {"better": f"{top['name']} better", "worse": f"{s['name']} better"}.get(verdict, verdict)
            cmp_rows.append([s["name"], n, ci_text(m, lo, hi), label])
        out.append(table(["Variant", "Shared cases", "Diff [95% CI]", "Verdict"], cmp_rows))
    out += ["", "Latency is taken from live-mode rows only; batch-mode rows are excluded."]
    return "\n".join(out) + "\n"
