import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from evals import compiler, judge, judge_run, report, runner
from evals.gen import ambiguity
from evals.gen.common import DATASET_PATH, SONNET_MODEL
from evals.graders import CHECKLIST_PATH, index_cases, load_checklist
from evals.ledger import BudgetError, Ledger
from evals.workflows import build_workflow

GEN_OUT = ROOT / "evals" / "gen" / "out"


def make_executor(cfg, mode, concurrency, max_spend, ledger):
    return runner.Executor(cfg, mode=mode, concurrency=concurrency, max_spend=max_spend, ledger=ledger)


def money(x: float) -> str:
    return f"${x:.4f}"


def dataset_hash_short(dataset: dict) -> str:
    return str(dataset["hash"])[:12]


def split_names(values: list[str]) -> list[str]:
    return [n for v in values for n in v.split(",") if n]


def cmd_run(args, factory=None) -> int:
    factory = factory or make_executor
    cfg = load_checklist()
    variants = runner.load_variants(args.variants_file)
    names = split_names(args.variants)
    unknown = [n for n in names if n not in variants]
    if unknown:
        raise SystemExit(f"unknown variants {unknown}, known: {sorted(variants)}")
    if args.resume and len(names) != 1:
        raise SystemExit("--resume works with exactly one variant")
    dataset = runner.load_dataset(args.dataset, verify=not args.allow_unverified)
    cases = runner.select_cases(dataset, args.split, args.limit)
    if not cases:
        raise SystemExit("no cases selected")
    ledger = Ledger(args.ledger)
    plans = []
    for name in names:
        try:
            wf = build_workflow(variants[name], cfg)
        except compiler.CompiledError as exc:
            raise SystemExit(f"refused to start variant {name}: {exc}")
        est = ledger.estimate_plan(wf.estimate_plan(), len(cases) * args.reps, args.mode)
        plans.append((name, wf, est))
    total = round(sum(p[2] for p in plans), 6)
    spent, remaining = ledger.spent(), ledger.remaining()
    print("dry run: nothing is sent, add --execute to run" if not args.execute else "execute: requests will be sent")
    print(f"dataset: {args.dataset} (version {dataset.get('version')}, hash {dataset_hash_short(dataset)})")
    print(f"split: {args.split}, cases: {len(cases)}, reps: {args.reps}, limit: {args.limit or 'none'}, mode: {args.mode}")
    print("variants:")
    for name, wf, est in plans:
        v = variants[name]
        reqs = sum(n for _, _, n in wf.estimate_plan()) * len(cases) * args.reps
        models = ", ".join(sorted({m for _, m, _ in wf.estimate_plan()}))
        print(f"  {name}: workflow={v['workflow']} models={models} cases={len(cases)} reps={args.reps} requests={reqs} estimated {money(est)}")
    print(f"estimated total: {money(total)}")
    print(f"spent so far: {money(spent)} of {money(ledger.budget)} budget, remaining {money(remaining)}")
    judge_est = judge_run.estimate_judge(ledger, len(cases) * args.reps * len(plans), args.mode)
    print(f"judging these runs would add about {money(judge_est)} (separate command)")
    print(f"max-spend: {money(args.max_spend) if args.max_spend is not None else 'not given'}")
    if not args.execute:
        return 0
    try:
        ledger.check(total, args.max_spend)
    except BudgetError as exc:
        print(f"refused: {exc}")
        return 2
    executor = factory(cfg, args.mode, args.concurrency, args.max_spend, ledger)
    code = 0
    for name, wf, est in plans:
        out = runner.Runner(dataset, executor, args.runs_dir, args.dataset, cfg).run(
            variants[name], cases, args.split, args.reps, args.resume, args.limit, est
        )
        meta = out["meta"]
        print(
            f"{out['run_id']}: {meta['status']}, rows {meta['n_rows']}/{meta['n_rows_expected']}, errors {out['n_errors']}, "
            f"cost {money(meta['cost_actual'])} (estimated {money(est)})"
        )
        if out["stopped"] or out["n_errors"]:
            code = 1
        if out["stopped"]:
            break
    return code


def cmd_compile(args, factory=None) -> int:
    cfg = load_checklist(args.checklist)
    ledger = Ledger(args.ledger)
    out = compiler.compiled_path(cfg, args.compiler, args.out_dir)
    estimate = compiler.estimate_cost(cfg)
    exists = out.exists()
    print("dry run: nothing is sent, add --execute to run" if not args.execute else "execute: requests will be sent")
    print(f"checklist: {args.checklist} (hash {compiler.hash8(cfg)}, criteria {len(cfg.criteria)})")
    print(f"compiler: {args.compiler} ({compiler.COMPILER_VERSIONS[args.compiler]}), model {compiler.COMPILER_MODEL}, effort {compiler.COMPILER_EFFORT}")
    print(
        f"requests: {len(cfg.criteria)} (plus at most one repair request per criterion), "
        f"estimated {money(estimate)} at {compiler.ESTIMATE_INPUT_TOKENS} input and {compiler.ESTIMATE_OUTPUT_TOKENS} output tokens each"
    )
    print(f"output: {out}{' (exists, needs --force)' if exists and not args.force else ''}")
    print(f"spent so far: {money(ledger.spent())} of {money(ledger.budget)} budget, remaining {money(ledger.remaining())}")
    print(f"max-spend: {money(args.max_spend) if args.max_spend is not None else 'not given'}")
    if not args.execute:
        return 0
    if exists and not args.force:
        print(f"refused: {out} already exists; pass --force to overwrite it")
        return 2
    try:
        ledger.check(estimate, args.max_spend)
    except BudgetError as exc:
        print(f"refused: {exc}")
        return 2
    if factory is not None:
        client = factory()
    else:
        from backend.app.core.config import get_settings
        from backend.app.services.llm_client import build_sdk_client

        client = build_sdk_client(get_settings())
    data = compiler.compile_checklist(cfg, args.compiler, client, ledger, None, args.max_spend, args.concurrency)
    compiler.write_compiled(out, data, force=True)
    failed = [cid for cid, rec in data["criteria"].items() if rec["status"] != "ok"]
    for cid, rec in data["criteria"].items():
        note = "" if rec["status"] == "ok" else f": {'; '.join(rec['errors'])}"
        print(f"  {cid}: {rec['status']}, attempts {rec['attempts']}, cost {money(rec['usage']['cost'])}{note}")
        for w in rec["warnings"]:
            print(f"    warning: {w}")
    print(f"wrote {out}: {len(data['criteria']) - len(failed)}/{len(data['criteria'])} compiled, cost {money(data['usage']['cost'])}, run {data['run_id']}")
    if failed:
        print(f"failed criteria {failed}: variants using this file will refuse to start")
        return 1
    return 0


def run_dir_for(args, run_id: str) -> Path:
    path = Path(args.runs_dir) / run_id
    if not path.is_dir():
        raise SystemExit(f"no run directory {path}")
    return path


def cmd_judge(args, factory=None) -> int:
    factory = factory or make_executor
    cfg = load_checklist()
    ledger = Ledger(args.ledger)
    plan = []
    for run_id in split_names(args.run_ids):
        run_dir = run_dir_for(args, run_id)
        meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
        dataset = runner.load_dataset(args.dataset or meta.get("dataset_path") or DATASET_PATH, verify=not args.allow_unverified)
        existing = judge_run.load_json(run_dir / "judge.json", {})
        todo = judge_run.pending_candidates(run_dir, existing)
        plan.append((run_dir, dataset, len([c for c in todo if judge.judgeable(c)])))
    total = round(sum(judge_run.estimate_judge(ledger, n, args.mode) for _, _, n in plan), 6)
    print("dry run: nothing is sent, add --execute to run" if not args.execute else "execute: requests will be sent")
    for run_dir, dataset, n in plan:
        print(f"  {run_dir.name}: {n} candidates to judge, estimated {money(judge_run.estimate_judge(ledger, n, args.mode))}")
    print(f"mode: {args.mode}, judge model: {judge.JUDGE_MODEL}, estimated total: {money(total)}")
    print(f"spent so far: {money(ledger.spent())} of {money(ledger.budget)} budget, remaining {money(ledger.remaining())}")
    print(f"max-spend: {money(args.max_spend) if args.max_spend is not None else 'not given'}")
    if not args.execute:
        return 0
    try:
        ledger.check(total, args.max_spend)
    except BudgetError as exc:
        print(f"refused: {exc}")
        return 2
    executor = factory(cfg, args.mode, args.concurrency, args.max_spend, ledger)
    code = 0
    for run_dir, dataset, n in plan:
        est = judge_run.estimate_judge(ledger, n, args.mode)
        out = judge_run.run_judge(run_dir, dataset, executor, cfg, estimate=est)
        print(f"{run_dir.name}: judged {len(out['judgements'])}, cost {money(out['cost'])} (estimated {money(est)}), errors {len(out['errors'])}")
        if out["errors"] or out["stopped"]:
            code = 1
    return code


def load_run(args, run_id: str, dataset_cache: dict) -> dict:
    run_dir = run_dir_for(args, run_id)
    meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
    path = args.dataset or meta.get("dataset_path") or DATASET_PATH
    if path not in dataset_cache:
        dataset_cache[path] = runner.load_dataset(path, verify=not args.allow_unverified)
    dataset = dataset_cache[path]
    if meta.get("dataset_hash") and meta["dataset_hash"] != dataset["hash"]:
        raise SystemExit(f"run {run_id} used dataset {meta['dataset_hash'][:12]}, not {dataset['hash'][:12]}: scores from different set versions are never compared")
    keep = ("variant", "workflow", "split", "mode", "reps", "dataset_hash", "git_sha", "served_models", "cost_actual", "cost_estimated")
    return {
        "name": f"{meta.get('variant', run_id)} ({run_id})",
        "dataset": dataset,
        "candidates": judge_run.load_json(run_dir / "results.json", []),
        "judgements": judge_run.load_json(run_dir / "judge.json", {}),
        "meta": {k: meta[k] for k in keep if k in meta} | ({"judge_cost": meta["judge"]["cost_actual"]} if meta.get("judge") else {}),
        "expected_calls": meta.get("expected_calls", 1),
    }


def cmd_report(args) -> int:
    ids = split_names(args.run_ids)
    cache: dict = {}
    runs = [load_run(args, i, cache) for i in ids]
    hashes = {r["dataset"]["hash"] for r in runs}
    if len(hashes) > 1:
        raise SystemExit("runs use different dataset versions, refusing to compare them")
    cfg = load_checklist()
    parts = []
    if len(runs) > 1:
        parts.append(report.leaderboard(runs, cfg))
    if len(runs) == 1 or args.per_run:
        parts += [report.run_report(r, cfg) for r in runs]
    text = "\n".join(parts)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(text)
    return 0


def cmd_ledger(args) -> int:
    s = Ledger(args.ledger).summary()
    print(f"budget {money(s['budget'])}, spent {money(s['spent'])}, remaining {money(s['remaining'])}, entries {s['entries']}")
    print("by provider:")
    for k, v in s["by_provider"].items():
        print(f"  {k}: {money(v)}")
    print("by run:")
    for k, v in s["by_run"].items():
        print(f"  {k}: {money(v)}")
    if s["uncounted"]:
        print("recorded but not counted against the budget:")
        for k, v in s["uncounted"].items():
            print(f"  {k}: {money(v)}")
    return 0


def cmd_calibrate_export(args) -> int:
    run_dir = run_dir_for(args, args.run_id)
    meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
    dataset = runner.load_dataset(args.dataset or meta.get("dataset_path") or DATASET_PATH, verify=not args.allow_unverified)
    judgements = {k: v for k, v in judge_run.load_json(run_dir / "judge.json", {}).items() if "~r" not in k}
    candidates = {c["case_id"]: c for c in judge_run.load_json(run_dir / "results.json", []) if c.get("rep", 0) == 0}
    rows = judge.export_calibration(judgements, index_cases(dataset), candidates, args.out, n=args.n, seed=args.seed)
    print(f"wrote {len(rows)} calibration rows to {args.out}")
    return 0


def cmd_calibrate_score(args) -> int:
    res = judge.load_calibration_agreement(args.path, args.threshold)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    return 0 if res["passed"] else 1


def blind_lines(items, responses) -> list[str]:
    lines = []
    for cid, req in items:
        resp = responses[cid]
        if resp.status == "error":
            result = {"type": "errored", "error": {"message": resp.error}}
        else:
            result = {"type": "succeeded", "message": resp.raw}
        lines.append(json.dumps({"custom_id": req.request_id, "result": result}, ensure_ascii=False))
    return lines


def cmd_blind_check(args, factory=None) -> int:
    factory = factory or make_executor
    cfg = load_checklist()
    dataset = runner.load_dataset(args.dataset, verify=not args.allow_unverified)
    cases = dataset["cases"]
    if args.only:
        wanted = set(split_names([args.only]))
        cases = [c for c in cases if c["id"] in wanted]
    if not cases:
        raise SystemExit("no cases selected")
    ledger = Ledger(args.ledger)
    estimate = ledger.estimate_plan([("blind", SONNET_MODEL, 1)], len(cases), "batch")
    print("dry run: nothing is sent, add --execute to run" if not args.execute else "execute: requests will be sent")
    print(f"blind check: {len(cases)} cases, model {SONNET_MODEL}, mode batch, estimated {money(estimate)}")
    print(f"spent so far: {money(ledger.spent())} of {money(ledger.budget)} budget, remaining {money(ledger.remaining())}")
    print(f"max-spend: {money(args.max_spend) if args.max_spend is not None else 'not given'}")
    print(f"output: {args.out}")
    if not args.execute:
        return 0
    try:
        ledger.check(estimate, args.max_spend)
    except BudgetError as exc:
        print(f"refused: {exc}")
        return 2
    from evals.workflows.base import ANTHROPIC, LLMRequest

    run_id = f"{runner.now_stamp()}-blind"
    run_dir = Path(args.runs_dir) / run_id
    items = [
        (case["id"], LLMRequest(case["id"], ANTHROPIC, SONNET_MODEL, ambiguity.blind_request(case, cfg), "blind"))
        for case in cases
    ]
    executor = factory(cfg, "batch", args.concurrency, args.max_spend, ledger)
    responses = executor.execute(items, runner.ResponseStore(run_dir / "raw"), run_id, "blind", pending_dir=run_dir / "batches")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(blind_lines(items, responses)) + "\n", encoding="utf-8")
    failed = [cid for cid, r in responses.items() if r.status == "error"]
    print(f"wrote {len(responses)} blind results to {out}, {len(failed)} errors, cost {money(executor.spent)}")
    return 1 if failed else 0


def common(s, run=False):
    s.add_argument("--dataset", default=None)
    s.add_argument("--allow-unverified", action="store_true", help="accept a dataset whose hash does not match its cases")
    s.add_argument("--ledger", default=str(Ledger().path))
    s.add_argument("--runs-dir", default=str(runner.RUNS_DIR))


def money_args(s):
    s.add_argument("--max-spend", type=float, help="USD ceiling for this invocation, required with --execute")
    s.add_argument("--execute", action="store_true", help="actually send requests; without it the command is a dry run")
    s.add_argument("--concurrency", type=int, default=4)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="eval")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("run", help="run variants on a split (dry run unless --execute)")
    common(s)
    s.set_defaults(dataset=str(DATASET_PATH))
    s.add_argument("variants", nargs="+", help="variant names from evals/variants.json, space or comma separated")
    s.add_argument("--variants-file", default=str(runner.VARIANTS_PATH))
    s.add_argument("--split", choices=list(runner.SPLITS), default="dev")
    s.add_argument("--reps", type=int, default=1)
    s.add_argument("--mode", choices=["batch", "live"], default="batch")
    s.add_argument("--limit", type=int)
    s.add_argument("--resume", help="resume this run id (one variant only)")
    money_args(s)
    s.set_defaults(func=cmd_run)

    s = sub.add_parser("compile", help="compile a checklist into Jev questions with the LLM compiler (dry run unless --execute)")
    s.add_argument("--compiler", choices=list(compiler.COMPILER_NAMES), required=True)
    s.add_argument("--checklist", default=str(CHECKLIST_PATH))
    s.add_argument("--out-dir", default=str(compiler.COMPILED_DIR))
    s.add_argument("--ledger", default=str(Ledger().path))
    s.add_argument("--force", action="store_true", help="overwrite an existing compiled file")
    money_args(s)
    s.set_defaults(func=cmd_compile)

    s = sub.add_parser("judge", help="judge finished runs (dry run unless --execute)")
    common(s)
    s.add_argument("run_ids", nargs="+")
    s.add_argument("--mode", choices=["batch", "live"], default="batch")
    money_args(s)
    s.set_defaults(func=cmd_judge)

    s = sub.add_parser("report", help="markdown report for one run or a leaderboard for several")
    common(s)
    s.add_argument("run_ids", nargs="+")
    s.add_argument("--out")
    s.add_argument("--per-run", action="store_true", help="also print each run report after the leaderboard")
    s.set_defaults(func=cmd_report)

    s = sub.add_parser("ledger", help="print spent and remaining budget")
    s.add_argument("--ledger", default=str(Ledger().path))
    s.set_defaults(func=cmd_ledger)

    s = sub.add_parser("calibrate-export", help="export judge verdicts for human calibration")
    common(s)
    s.add_argument("run_id")
    s.add_argument("--out", required=True)
    s.add_argument("--n", type=int, default=20)
    s.add_argument("--seed", type=int, default=0)
    s.set_defaults(func=cmd_calibrate_export)

    s = sub.add_parser("calibrate-score", help="agreement between the judge and the human marks")
    s.add_argument("path")
    s.add_argument("--threshold", type=float, default=judge.CALIBRATION_THRESHOLD)
    s.set_defaults(func=cmd_calibrate_score)

    s = sub.add_parser("blind-check", help="blind ambiguity check of a dataset with the cheaper model (dry run unless --execute)")
    common(s)
    s.set_defaults(dataset=str(DATASET_PATH))
    s.add_argument("--only")
    s.add_argument("--out", default=str(GEN_OUT / "blind_results.jsonl"))
    money_args(s)
    s.set_defaults(func=cmd_blind_check)
    return p


def main(argv=None, factory=None) -> int:
    args = build_parser().parse_args(argv)
    if args.command in ("run", "judge", "blind-check", "compile"):
        return args.func(args, factory)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
