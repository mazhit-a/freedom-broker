import json
import random
from collections import defaultdict
from pathlib import Path
from typing import Any

from backend.app.schemas.checklist import ChecklistConfig, Criterion
from backend.app.services.evaluator import quote_matches
from backend.app.services.scoring import NA, NEEDS_REVIEW, NO, YES, _norm

CHECKLIST_PATH = Path(__file__).with_name("checklist_v2.json")
CONFIDENCE_BUCKETS = [(0.0, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 1.01)]
BOOTSTRAP_ITERATIONS = 2000
BOOTSTRAP_SEED = 20261108


def load_checklist(path: Path | str = CHECKLIST_PATH) -> ChecklistConfig:
    return ChecklistConfig.model_validate(json.loads(Path(path).read_text(encoding="utf-8")))


def criteria_map(cfg: ChecklistConfig) -> dict[str, Criterion]:
    return {c.id: c for c in cfg.criteria}


def flag_id(cfg: ChecklistConfig) -> str | None:
    for c in cfg.criteria:
        if c.type == "flag":
            return c.id
    return None


def normalize(value: Any) -> Any:
    if value is None:
        return None
    return _norm(value)


def mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def rate(num: int | float, den: int | float) -> float | None:
    return num / den if den else None


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def bootstrap_ci(
    values: list[float],
    iterations: int = BOOTSTRAP_ITERATIONS,
    seed: int = BOOTSTRAP_SEED,
    alpha: float = 0.05,
) -> tuple[float | None, float | None, float | None]:
    if not values:
        return None, None, None
    m = sum(values) / len(values)
    if len(values) == 1:
        return m, m, m
    rng = random.Random(seed)
    n = len(values)
    means = sorted(sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(iterations))
    lo = means[int((alpha / 2) * (iterations - 1))]
    hi = means[int((1 - alpha / 2) * (iterations - 1) + 0.5)]
    return m, lo, hi


def paired_diff_ci(
    a: dict[str, float], b: dict[str, float], iterations: int = BOOTSTRAP_ITERATIONS, seed: int = BOOTSTRAP_SEED
) -> tuple[float | None, float | None, float | None, int]:
    ids = sorted(set(a) & set(b))
    diffs = [a[i] - b[i] for i in ids]
    m, lo, hi = bootstrap_ci(diffs, iterations, seed)
    return m, lo, hi, len(ids)


def match_answer(crit: Criterion, expected: Any, candidate: Any) -> tuple[bool, float]:
    e, c = normalize(expected), normalize(candidate)
    if e == c and e is not None:
        return True, 1.0
    if crit.type == "scale" and isinstance(e, int) and isinstance(c, int) and not isinstance(e, bool) and not isinstance(c, bool):
        step = crit.max_step or 1
        return False, max(0.0, 1.0 - abs(e - c) / step)
    return False, 0.0


def case_status(cand: dict | None) -> str:
    if cand is None:
        return "not_run"
    if cand.get("error"):
        return "error"
    if cand.get("refused"):
        return "refused"
    results = cand.get("results")
    if not isinstance(results, dict) or not results:
        return "empty_output"
    return "ok"


def criterion_state(cid: str, cand: dict) -> tuple[str, Any]:
    results = cand.get("results") or {}
    row = results.get(cid)
    flagged = cid in (cand.get("needs_review") or {})
    if not isinstance(row, dict):
        return ("needs_review", None) if flagged else ("omitted", None)
    ans = normalize(row.get("answer"))
    if ans is None or ans == NEEDS_REVIEW or flagged:
        return "needs_review", None
    return "answered", ans


def grade_case(case: dict, cand: dict | None, cfg: ChecklistConfig) -> dict:
    status = case_status(cand)
    out: dict[str, Any] = {
        "case_id": case["id"],
        "status": status,
        "criteria": {},
        "weighted_exact": None,
        "weighted_partial": None,
        "unweighted_exact": None,
    }
    if status != "ok":
        return out
    crits = criteria_map(cfg)
    w_total = w_exact = w_partial = 0.0
    n_ans = n_exact = 0
    for cid, exp in case["expected"].items():
        crit = crits.get(cid)
        if crit is None:
            continue
        state, ans = criterion_state(cid, cand)
        row: dict[str, Any] = {
            "state": state,
            "expected": normalize(exp.get("answer")),
            "candidate": ans,
            "exact": None,
            "partial": None,
        }
        if state == "answered":
            exact, partial = match_answer(crit, exp.get("answer"), ans)
            row["exact"], row["partial"] = exact, partial
            n_ans += 1
            n_exact += int(exact)
            if crit.weight > 0:
                w_total += crit.weight
                w_exact += crit.weight * int(exact)
                w_partial += crit.weight * partial
        out["criteria"][cid] = row
    out["weighted_exact"] = rate(w_exact, w_total)
    out["weighted_partial"] = rate(w_partial, w_total)
    out["unweighted_exact"] = rate(n_exact, n_ans)
    return out


def gross_metrics(graded: list[dict], cfg: ChecklistConfig) -> dict:
    fid = flag_id(cfg)
    tp = fp = fn = tn = 0
    skipped = 0
    for g in graded:
        row = g["criteria"].get(fid) if fid else None
        if row is None or row["state"] != "answered":
            if g["status"] == "ok":
                skipped += 1
            continue
        e, c = row["expected"] == YES, row["candidate"] == YES
        tp += e and c
        fn += e and not c
        fp += c and not e
        tn += (not e) and (not c)
    recall, precision = rate(tp, tp + fn), rate(tp, tp + fp)
    f1 = None
    if recall is not None and precision is not None and (recall + precision) > 0:
        f1 = 2 * recall * precision / (recall + precision)
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "recall": recall, "precision": precision, "f1": f1, "skipped": skipped}


def confusion_matrix(graded: list[dict], cfg: ChecklistConfig) -> dict[str, dict[str, int]]:
    crits = criteria_map(cfg)
    labels = (YES, NO, NA)
    matrix = {e: {c: 0 for c in labels} for e in labels}
    for g in graded:
        for cid, row in g["criteria"].items():
            if crits[cid].type == "scale" or row["state"] != "answered":
                continue
            if row["expected"] in labels and row["candidate"] in labels:
                matrix[row["expected"]][row["candidate"]] += 1
    return matrix


def criterion_table(graded: list[dict], cfg: ChecklistConfig) -> list[dict]:
    rows = []
    for c in cfg.criteria:
        scored = [g["criteria"][c.id] for g in graded if c.id in g["criteria"]]
        answered = [r for r in scored if r["state"] == "answered"]
        rows.append(
            {
                "id": c.id,
                "title": c.title,
                "type": c.type,
                "weight": c.weight,
                "n_answered": len(answered),
                "n_needs_review": sum(1 for r in scored if r["state"] == "needs_review"),
                "n_omitted": sum(1 for r in scored if r["state"] == "omitted"),
                "exact": rate(sum(1 for r in answered if r["exact"]), len(answered)),
                "partial": mean([r["partial"] for r in answered]),
            }
        )
    return rows


def message_text(case: dict, index: Any) -> str | None:
    for m in case["conversation"]["messages"]:
        if m.get("message_index") == index:
            return str(m.get("text", ""))
    return None


def evidence_grounding(case: dict, cand: dict) -> tuple[int, int]:
    grounded = total = 0
    for row in (cand.get("results") or {}).values():
        if not isinstance(row, dict):
            continue
        for ev in row.get("evidence") or []:
            if not isinstance(ev, dict):
                continue
            total += 1
            text = message_text(case, ev.get("message_index"))
            quote = ev.get("quote")
            if text is not None and isinstance(quote, str) and quote_matches(quote, text):
                grounded += 1
    return grounded, total


def is_truncated(cand: dict) -> bool:
    err = str(cand.get("error") or "").lower()
    if "max_tokens" in err or "truncat" in err:
        return True
    return any(
        call.get("stop_reason") == "max_tokens" or call.get("truncated") is True for call in cand.get("calls") or []
    )


def validity_metrics(cases: dict[str, dict], candidates: list[dict], expected_calls: int = 1) -> dict:
    n = len(candidates)
    statuses = [case_status(c) for c in candidates]
    delivered = [c for c, s in zip(candidates, statuses) if s == "ok"]
    nr = total_crit = 0
    ev_ok = ev_total = 0
    for c in delivered:
        case = cases.get(c["case_id"])
        if case is None:
            continue
        for cid in case["expected"]:
            total_crit += 1
            nr += criterion_state(cid, c)[0] == "needs_review"
        g, t = evidence_grounding(case, c)
        ev_ok += g
        ev_total += t
    with_calls = [c for c in candidates if c.get("calls")]
    return {
        "n_candidates": n,
        "n_ok": len(delivered),
        "n_error": statuses.count("error"),
        "n_refused": statuses.count("refused"),
        "n_empty_output": statuses.count("empty_output"),
        "needs_review_rate": rate(nr, total_crit),
        "repair_turn_rate": rate(sum(1 for c in with_calls if len(c["calls"]) > expected_calls), len(with_calls)),
        "refusal_rate": rate(statuses.count("refused"), n),
        "truncation_rate": rate(sum(1 for c in candidates if is_truncated(c)), n),
        "evidence_grounded_rate": rate(ev_ok, ev_total),
        "evidence_items": ev_total,
    }


def consistency(candidates: list[dict], cfg: ChecklistConfig) -> dict:
    by_case: dict[str, list[dict]] = defaultdict(list)
    for c in candidates:
        if case_status(c) == "ok":
            by_case[c["case_id"]].append(c)
    same = total = 0
    pair_agree = pair_total = 0
    per_crit: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    n_cases = 0
    for case_id in sorted(by_case):
        reps = by_case[case_id]
        if len(reps) < 2:
            continue
        n_cases += 1
        for crit in cfg.criteria:
            answers = [criterion_state(crit.id, r)[1] for r in reps]
            ok = len(set(map(repr, answers))) == 1
            same += ok
            total += 1
            per_crit[crit.id][0] += ok
            per_crit[crit.id][1] += 1
            for i in range(len(answers)):
                for j in range(i + 1, len(answers)):
                    pair_total += 1
                    pair_agree += answers[i] == answers[j]
    return {
        "n_cases": n_cases,
        "all_reps_agree_rate": rate(same, total),
        "pairwise_agreement": rate(pair_agree, pair_total),
        "per_criterion": {cid: rate(a, t) for cid, (a, t) in sorted(per_crit.items())},
    }


def calibration_table(cases: dict[str, dict], candidates: list[dict], cfg: ChecklistConfig) -> list[dict]:
    crits = criteria_map(cfg)
    buckets: dict[int, list] = defaultdict(list)
    for cand in candidates:
        case = cases.get(cand["case_id"])
        if case is None or case_status(cand) != "ok":
            continue
        for cid, exp in case["expected"].items():
            row = (cand.get("results") or {}).get(cid)
            conf = row.get("confidence") if isinstance(row, dict) else None
            if isinstance(conf, bool) or not isinstance(conf, (int, float)):
                continue
            state, ans = criterion_state(cid, cand)
            if state != "answered" or cid not in crits:
                continue
            exact, _ = match_answer(crits[cid], exp.get("answer"), ans)
            for i, (lo, hi) in enumerate(CONFIDENCE_BUCKETS):
                if lo <= conf < hi:
                    buckets[i].append((float(conf), int(exact)))
                    break
    out = []
    for i, (lo, hi) in enumerate(CONFIDENCE_BUCKETS):
        items = buckets.get(i, [])
        out.append(
            {
                "bucket": f"{lo:.1f}-{min(hi, 1.0):.1f}",
                "n": len(items),
                "accuracy": mean([x[1] for x in items]),
                "mean_confidence": mean([x[0] for x in items]),
            }
        )
    return out


def index_cases(dataset: dict) -> dict[str, dict]:
    return {c["id"]: c for c in dataset["cases"]}


def grade_run(dataset: dict, candidates: list[dict], cfg: ChecklistConfig | None = None, expected_calls: int = 1) -> dict:
    cfg = cfg or load_checklist()
    cases = index_cases(dataset)
    known = [c for c in candidates if c["case_id"] in cases]
    graded = [grade_case(cases[c["case_id"]], c, cfg) for c in known]
    ok = [g for g in graded if g["status"] == "ok"]
    seen = {c["case_id"] for c in known}
    wexact = [g["weighted_exact"] for g in ok if g["weighted_exact"] is not None]
    wpart = [g["weighted_partial"] for g in ok if g["weighted_partial"] is not None]
    return {
        "n_cases_dataset": len(cases),
        "n_not_run": len([cid for cid in cases if cid not in seen]),
        "n_unknown_case": len(candidates) - len(known),
        "graded": graded,
        "answer_accuracy_exact": mean(wexact),
        "answer_accuracy_partial": mean(wpart),
        "accuracy_ci": bootstrap_ci(wexact),
        "gross": gross_metrics(ok, cfg),
        "confusion": confusion_matrix(ok, cfg),
        "criteria": criterion_table(ok, cfg),
        "validity": validity_metrics(cases, known, expected_calls),
        "consistency": consistency(known, cfg),
        "calibration": calibration_table(cases, known, cfg),
    }
