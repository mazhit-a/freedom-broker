import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from evals import prices
from evals.gen import ambiguity, assemble, openai_provider, prompt, spec as spec_mod
from evals.gen.common import CHECKLIST_PATH, DATASET_PATH, OPUS_MODEL, ROOT as REPO, load_checklist

GEN_DIR = REPO / "evals" / "gen"
REVIEW_DIR = REPO / "evals" / "review"


def _specs(args) -> list[dict]:
    path = getattr(args, "specs", None)
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    return spec_mod.sample_specs(getattr(args, "seed", spec_mod.SEED))


def _select(specs: list[dict], only: str | None) -> list[dict]:
    if not only:
        return specs
    wanted = {x.strip() for x in only.split(",") if x.strip()}
    chosen = [s for s in specs if s["id"] in wanted]
    missing = wanted - {s["id"] for s in chosen}
    if missing:
        raise SystemExit(f"unknown case ids: {sorted(missing)}")
    return chosen


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def cmd_spec(args) -> int:
    cfg = load_checklist()
    specs = spec_mod.sample_specs(args.seed, cfg)
    problems = spec_mod.check_guarantees(specs, cfg)
    out = spec_mod.write_specs(specs, args.out)
    print(f"wrote {len(specs)} specs to {out}")
    for p in problems:
        print(f"problem: {p}")
    return 1 if problems else 0


def cmd_plan(args) -> int:
    specs = _select(_specs(args), args.only)
    batch = prompt.estimate_cost(len(specs))
    pilot = prompt.estimate_cost(min(4, len(specs)))
    print(f"generation requests: {batch['requests']}")
    print(f"assumed per case: {batch['input_tokens_per_case']} input and {batch['output_tokens_per_case']} output tokens")
    print(f"{OPUS_MODEL} live price: {prompt.PRICE_LIVE_IN}/{prompt.PRICE_LIVE_OUT} per MTok, batch = {int(prompt.BATCH_FACTOR * 100)} percent")
    print(f"per case live ${batch['live_per_case']:.3f}, batch ${batch['batch_per_case']:.3f}")
    print(f"batch total ${batch['batch_total']:.2f} (same cases live ${batch['live_total']:.2f})")
    print(f"pilot of {pilot['requests']} cases live ${pilot['live_total']:.2f}")
    oa_model = openai_provider.default_model()
    oa_each = prices.cost(oa_model, input_tokens=prompt.TOKENS_IN_PER_CASE, output_tokens=prompt.TOKENS_OUT_PER_CASE)
    oa_price = prices.price_for(oa_model)
    print(f"{oa_model} live price: {oa_price.input}/{oa_price.output} per MTok, no batch discount")
    print(f"openai estimate: per case ${oa_each:.3f}, total for {batch['requests']} cases ${oa_each * batch['requests']:.2f}, pilot of {pilot['requests']} cases ${oa_each * pilot['requests']:.2f}")
    print("note: reasoning tokens are billed as output and may add to the output estimate")
    print("blind ambiguity check with the cheaper model is not included in these numbers")
    return 0


def cmd_build_batch(args) -> int:
    specs = _select(_specs(args), args.only)
    rows = prompt.batch_requests(specs, model=args.model, effort=args.effort)
    out = Path(args.out)
    _write_jsonl(out, rows)
    print(f"wrote {len(rows)} batch requests to {out} (not sent)")
    return 0


def pick_pilot(specs: list[dict], count: int = 4) -> list[dict]:
    dev = [s for s in specs if s["split"] == "dev"]
    chosen: list[dict] = []
    seen: set = set()
    for key in (
        lambda s: (s["channel"], s["length"]),
        lambda s: s["language"],
        lambda s: tuple(s["hard"]),
        lambda s: s["topic"],
    ):
        for s in dev:
            if len(chosen) >= count:
                break
            if s not in chosen and key(s) not in seen:
                chosen.append(s)
                seen.add(key(s))
    for s in dev:
        if len(chosen) >= count:
            break
        if s not in chosen:
            chosen.append(s)
    return chosen[:count]


def cmd_pilot(args) -> int:
    specs = _specs(args)
    chosen = pick_pilot(specs, 4)
    cfg = load_checklist()
    rows = [{"case_id": s["id"], "request": prompt.live_request(s, cfg, model=args.model, effort=args.effort)} for s in chosen]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} pilot requests to {out} (not sent): {', '.join(s['id'] for s in chosen)}")
    return 0


def cmd_generate(args) -> int:
    if args.provider != "openai":
        raise SystemExit(f"unsupported provider {args.provider}")
    specs = _select(_specs(args), args.only)
    if not specs:
        raise SystemExit("no specs selected")
    cfg = load_checklist()
    model = args.model or openai_provider.default_model()
    requests = [
        {
            "custom_id": s["id"],
            "request": openai_provider.to_openai_request(
                prompt.live_request(s, cfg), model=model, effort=args.effort, max_output_tokens=args.max_output_tokens
            ),
        }
        for s in specs
    ]
    input_tokens = max(openai_provider.estimate_input_tokens(r["request"]) for r in requests)
    guard = openai_provider.SpendGuard(args.max_spend if args.max_spend is not None else float("inf"), model, args.max_output_tokens, input_tokens)
    per_case = guard.default_estimate()
    if args.dry_run:
        print("dry run: nothing is sent")
        print(f"requests: {len(requests)}")
        print(f"model: {model}")
        print(f"effort: {args.effort}")
        print(f"max output tokens per call: {args.max_output_tokens}")
        print(f"concurrency: {args.concurrency}")
        print(f"estimated cost: ${per_case * len(requests):.2f} (${per_case:.3f} per case at about {input_tokens} input and {openai_provider.ASSUMED_OUTPUT_TOKENS} output tokens; reasoning tokens may add to output)")
        print(f"worst case for one call: ${guard.worst_case_call():.3f}")
        return 0
    if args.max_spend is None:
        raise SystemExit("--max-spend is required for a live run")
    out = Path(args.out)
    log_path = out.with_suffix(".spend.json")
    if (out.exists() or log_path.exists()) and not args.force:
        raise SystemExit(f"{out} or {log_path} already exists; pass --force to overwrite")
    try:
        guard.check_start()
    except openai_provider.BudgetRefused as e:
        raise SystemExit(f"refusing to start: {e}")
    key = openai_provider.load_api_key()
    if not key:
        raise SystemExit("OPENAI_API_KEY is not set in the environment or .env")
    client = openai_provider.make_client(key, args.timeout)
    out.parent.mkdir(parents=True, exist_ok=True)
    handle = out.open("w", encoding="utf-8")

    def on_result(row: dict) -> None:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        handle.flush()
        cost = row.get("cost_usd")
        print(f"{row['custom_id']}: {row['status']} ${cost if cost is not None else 0:.4f} {row['latency_s']}s, spent ${guard.spent:.4f}")

    try:
        rows, skipped = openai_provider.run_requests(
            client,
            requests,
            guard=guard,
            concurrency=args.concurrency,
            ceiling=args.timeout,
            max_attempts=args.max_attempts,
            on_result=on_result,
            secrets=[key],
        )
    finally:
        handle.close()
    log = {
        "provider": "openai",
        "model": model,
        "effort": args.effort,
        "max_spend_usd": args.max_spend,
        "spent_usd": round(guard.spent, 6),
        "requested": [r["custom_id"] for r in requests],
        "skipped_for_budget": skipped,
        "statuses": {r["custom_id"]: r["status"] for r in rows},
        "served_models": sorted({r["model"] for r in rows if r.get("model")}),
        "results": [
            {k: r.get(k) for k in ("custom_id", "status", "model", "usage", "cost_usd", "latency_s", "total_s", "attempts", "error")}
            for r in rows
        ],
    }
    log_path.write_text(json.dumps(log, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    bad = {r["custom_id"]: r["status"] for r in rows if r["status"] != "ok"}
    print(f"wrote {len(rows)} results to {out} and spend log to {log_path}; spent ${guard.spent:.4f} of ${args.max_spend:.2f}")
    if skipped:
        print(f"stopped before the budget would be exceeded; not run: {', '.join(skipped)}")
    for cid, status in sorted(bad.items()):
        print(f"not valid {cid}: {status}")
    return 1 if (bad or skipped) else 0


def cmd_ingest(args) -> int:
    cfg = load_checklist()
    specs = _specs(args)
    lines = Path(args.results).read_text(encoding="utf-8").splitlines()
    cases, failures = assemble.ingest_results(cfg, specs, lines)
    if args.blind:
        for problem in assemble.attach_blind(cfg, cases, Path(args.blind).read_text(encoding="utf-8").splitlines()):
            print(f"blind: {problem}")
    dataset = assemble.assemble_dataset(cases, args.version)
    out = assemble.write_dataset(dataset, args.out)
    flagged = sum(1 for c in cases if c["review"]["flags"])
    print(f"wrote {len(cases)} cases to {out}; {flagged} carry flags; hash {dataset['hash']}")
    for cid, err in sorted(failures.items()):
        print(f"failed {cid}: {err}")
    if args.card:
        Path(args.card).write_text(assemble.build_card(dataset, cfg), encoding="utf-8")
        print(f"wrote card to {args.card}")
    return 1 if failures else 0


def cmd_build_blind(args) -> int:
    dataset = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    cases = dataset["cases"]
    if args.only:
        wanted = {x.strip() for x in args.only.split(",")}
        cases = [c for c in cases if c["id"] in wanted]
    rows = ambiguity.blind_batch_requests(cases, model=args.model)
    _write_jsonl(Path(args.out), rows)
    print(f"wrote {len(rows)} blind requests to {args.out} (not sent)")
    return 0


def cmd_freeze(args) -> int:
    cfg = load_checklist()
    dataset = json.loads(Path(args.input).read_text(encoding="utf-8"))
    frozen, problems = assemble.freeze(dataset, args.version, cfg, _specs(args))
    for p in problems:
        print(f"problem: {p}")
    if frozen is None:
        return 1
    out = assemble.write_dataset(frozen, args.out)
    reference = json.loads(Path(args.reference).read_text(encoding="utf-8")) if args.reference else None
    Path(args.card).write_text(assemble.build_card(frozen, cfg, reference), encoding="utf-8")
    print(f"froze {len(frozen['cases'])} cases to {out}; version {frozen['version']}; hash {frozen['hash']}")
    return 0


def cmd_card(args) -> int:
    dataset = json.loads(Path(args.input).read_text(encoding="utf-8"))
    reference = json.loads(Path(args.reference).read_text(encoding="utf-8")) if args.reference else None
    Path(args.out).write_text(assemble.build_card(dataset, load_checklist(), reference), encoding="utf-8")
    print(f"wrote card to {args.out}")
    return 0


def cmd_review_assets(args) -> int:
    data = json.loads(CHECKLIST_PATH.read_text(encoding="utf-8"))
    out = REVIEW_DIR / "checklist_v2.js"
    out.write_text("window.CHECKLIST_V2 = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")
    print(f"wrote {out}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="eval_gen", description="Eval set generation tooling. Never calls the API.")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp, specs=True):
        if specs:
            sp.add_argument("--specs", help="specs JSON file; default samples with the fixed seed")
            sp.add_argument("--seed", type=int, default=spec_mod.SEED)

    s = sub.add_parser("spec", help="write the sampled case specs")
    s.add_argument("--seed", type=int, default=spec_mod.SEED)
    s.add_argument("--out", default=str(spec_mod.DEFAULT_SPECS_PATH))
    s.set_defaults(func=cmd_spec)

    s = sub.add_parser("plan", help="print request count and estimated cost")
    common(s)
    s.add_argument("--only")
    s.set_defaults(func=cmd_plan)

    s = sub.add_parser("build-batch", help="write the batch request file, never sends it")
    common(s)
    s.add_argument("--only", help="comma-separated case ids, for example to regenerate rejects")
    s.add_argument("--out", default=str(GEN_DIR / "batch_requests.jsonl"))
    s.add_argument("--model", default=OPUS_MODEL)
    s.add_argument("--effort", default=prompt.DEFAULT_EFFORT)
    s.set_defaults(func=cmd_build_batch)

    s = sub.add_parser("pilot-requests", help="write 4 live pilot requests, never sends them")
    common(s)
    s.add_argument("--out", default=str(GEN_DIR / "pilot_requests.json"))
    s.add_argument("--model", default=OPUS_MODEL)
    s.add_argument("--effort", default=prompt.DEFAULT_EFFORT)
    s.set_defaults(func=cmd_pilot)

    s = sub.add_parser("generate", help="run live generation through a provider (spends money unless --dry-run)")
    common(s)
    s.add_argument("--provider", choices=["openai"], default="openai")
    s.add_argument("--model", default=os.environ.get(openai_provider.MODEL_ENV) or None, help="default: OPENAI_GEN_MODEL, else gpt-6.1-sol")
    s.add_argument("--effort", choices=list(openai_provider.EFFORTS), default=openai_provider.DEFAULT_EFFORT)
    s.add_argument("--only", help="comma-separated case ids")
    s.add_argument("--out", default=str(GEN_DIR / "openai_results.jsonl"))
    s.add_argument("--max-spend", type=float, help="hard USD ceiling, required unless --dry-run")
    s.add_argument("--max-output-tokens", type=int, default=openai_provider.DEFAULT_MAX_OUTPUT_TOKENS)
    s.add_argument("--concurrency", type=int, default=openai_provider.DEFAULT_CONCURRENCY)
    s.add_argument("--timeout", type=float, default=openai_provider.DEFAULT_CEILING_SECONDS, help="per-call wall-clock ceiling in seconds")
    s.add_argument("--max-attempts", type=int, default=openai_provider.DEFAULT_MAX_ATTEMPTS)
    s.add_argument("--force", action="store_true", help="overwrite an existing results file")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(func=cmd_generate)

    s = sub.add_parser("ingest", help="validate batch results and assemble a candidate dataset")
    common(s)
    s.add_argument("--results", required=True, help="batch results JSONL")
    s.add_argument("--blind", help="batch results JSONL of the blind ambiguity check")
    s.add_argument("--out", default=str(DATASET_PATH))
    s.add_argument("--version", type=int, default=1)
    s.add_argument("--card")
    s.set_defaults(func=cmd_ingest)

    s = sub.add_parser("build-blind", help="write blind ambiguity requests for a dataset, never sends them")
    s.add_argument("--dataset", default=str(DATASET_PATH))
    s.add_argument("--only")
    s.add_argument("--out", default=str(GEN_DIR / "blind_requests.jsonl"))
    s.add_argument("--model", default=ambiguity.SONNET_MODEL)
    s.set_defaults(func=cmd_build_blind)

    s = sub.add_parser("freeze", help="turn a reviewed candidate into the frozen dataset and card")
    common(s)
    s.add_argument("--in", dest="input", required=True)
    s.add_argument("--out", default=str(DATASET_PATH))
    s.add_argument("--card", default=str(assemble.CARD_PATH))
    s.add_argument("--version", type=int)
    s.add_argument("--reference", help="DEV statistics JSON for the realism table")
    s.set_defaults(func=cmd_freeze)

    s = sub.add_parser("card", help="write DATASET.md for a dataset file")
    s.add_argument("--in", dest="input", default=str(DATASET_PATH))
    s.add_argument("--out", default=str(assemble.CARD_PATH))
    s.add_argument("--reference")
    s.set_defaults(func=cmd_card)

    s = sub.add_parser("review-assets", help="write the checklist script used by the review page")
    s.set_defaults(func=cmd_review_assets)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
