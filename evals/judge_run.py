import json
from datetime import datetime, timezone
from pathlib import Path

from evals import judge
from evals.graders import index_cases, load_checklist
from evals.ledger import Ledger
from evals.runner import Executor, ResponseStore, custom_id
from evals.workflows.base import ANTHROPIC, ERROR, LLMRequest, OK


def judgement_key(case_id: str, rep: int) -> str:
    return case_id if rep == 0 else f"{case_id}~r{rep}"


def load_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def pending_candidates(run_dir: Path, existing: dict) -> list[dict]:
    results = load_json(run_dir / "results.json", [])
    return [c for c in results if judgement_key(c["case_id"], c.get("rep", 0)) not in existing]


def estimate_judge(ledger: Ledger, n_candidates: int, mode: str, model: str = judge.JUDGE_MODEL) -> float:
    return ledger.estimate_plan([("judge", model, 1)], n_candidates, mode)


def run_judge(
    run_dir: Path | str,
    dataset: dict,
    executor: Executor,
    cfg=None,
    model: str = judge.JUDGE_MODEL,
    effort: str = judge.JUDGE_EFFORT,
    estimate: float | None = None,
) -> dict:
    run_dir = Path(run_dir)
    cfg = cfg or load_checklist()
    meta_path = run_dir / "meta.json"
    meta = load_json(meta_path, {})
    if meta.get("dataset_hash") and meta["dataset_hash"] != dataset["hash"]:
        raise ValueError(f"run {run_dir.name} used dataset {meta['dataset_hash'][:12]}, not {dataset['hash'][:12]}")
    cases = index_cases(dataset)
    judgements: dict[str, dict] = load_json(run_dir / "judge.json", {})
    todo = pending_candidates(run_dir, judgements)
    items: list[tuple[str, LLMRequest]] = []
    by_cid: dict[str, tuple[str, dict, dict]] = {}
    skipped: dict[str, str] = {}
    for cand in todo:
        case = cases.get(cand["case_id"])
        key = judgement_key(cand["case_id"], cand.get("rep", 0))
        if case is None:
            skipped[key] = "case not in dataset"
            continue
        if not judge.judgeable(cand):
            skipped[key] = "candidate is not judgeable"
            continue
        params = judge.live_request(case, cand, cfg, model=model, effort=effort)
        cid = custom_id("j", f"{run_dir.name}|{key}")
        items.append((cid, LLMRequest(key, ANTHROPIC, model, params, "judge")))
        by_cid[cid] = (key, case, cand)
    store = ResponseStore(run_dir / "raw" / "judge")
    stopped = None
    responses = {}
    if items:
        try:
            responses = executor.execute(items, store, run_dir.name, "judge", pending_dir=run_dir / "judge_batches")
        except Exception as exc:
            stopped = f"{type(exc).__name__}: {exc}"
    errors: dict[str, str] = {}
    for cid, resp in responses.items():
        key, case, cand = by_cid[cid]
        if resp.status == ERROR:
            errors[key] = resp.error or "error"
        elif resp.status == OK:
            j = judge.judge_text(resp.text, case, cand, cfg)
            j["rep"] = cand.get("rep", 0)
            judgements[key] = j
        else:
            judgements[key] = {"case_id": case["id"], "rep": cand.get("rep", 0), "error": f"stop_reason {resp.stop_reason}"}
    (run_dir / "judge.json").write_text(json.dumps(judgements, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    cost = round(sum(r.cost for r in responses.values()), 6)
    usage = {
        k: sum(getattr(r, k) for r in responses.values())
        for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
    }
    meta["judge"] = {
        "model": model,
        "effort": effort,
        "mode": executor.mode,
        "n_requested": len(items),
        "n_judged": len([k for k in judgements]),
        "n_skipped": len(skipped),
        "skipped": skipped,
        "errors": errors,
        "stopped": stopped,
        "cost_estimated": estimate,
        "cost_actual": cost,
        "usage": usage,
        "served_models": sorted({r.model for r in responses.values() if r.model}),
        "finished": datetime.now(timezone.utc).isoformat(),
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"run_id": run_dir.name, "judgements": judgements, "errors": errors, "skipped": skipped, "cost": cost, "stopped": stopped}
