import argparse
import json
import math
import sqlite3
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.core.config import Settings
from backend.app.core.database import connect
from backend.app.services import catalog
from backend.app.services.checklist import get_version
from backend.app.services.evaluator import evaluate_conversation, get_evaluation
from backend.app.services.model_profiles import get_profile
from backend.app.services.openai_client import OpenAIClient

MODEL = "gpt-6.1-sol"
EFFORT = "medium"
PROMPT_VERSION = "v2"
BASE_CONVERSATIONS = ["p1-ru-022", "p1-ru-023", "p4-ru-004", "p4-ru-005", "p1-kz-013", "p1-en-013"]
EXTRA_COUNT = 4
NA_CRITERION = "03"
MAX_MEAN_COST = 0.02
MAX_P95_LATENCY_MS = 20000
MAX_MEDIAN_TOTAL_DIFF = 5.0
MAX_FLIP_SHARE = 0.3


class Refusal(Exception):
    pass


def build_settings() -> Settings:
    return Settings(llm_provider="openai", llm_model=MODEL, llm_effort=EFFORT, llm_prompt_version=PROMPT_VERSION)


def production_paths() -> list[Path]:
    paths = [(ROOT / "cqa.db").resolve()]
    try:
        paths.append((ROOT / Settings(_env_file=None).cqa_db_path).resolve())
    except Exception:
        pass
    return paths


def inside_repo(path: Path) -> bool:
    root = ROOT.resolve()
    return path == root or root in path.parents


def check_db_path(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if path in production_paths():
        raise Refusal("refusing to use the production database path; pass a COPY outside the repository")
    if inside_repo(path):
        raise Refusal("refusing a database path inside the repository tree; pass a COPY outside the repository, for example in /tmp")
    if not path.is_file():
        raise Refusal("the database copy does not exist")
    return path


def check_out_path(raw: str, db_path: Path) -> Path:
    path = Path(raw).expanduser().resolve()
    if inside_repo(path):
        raise Refusal("refusing an output path inside the repository tree")
    if path == db_path:
        raise Refusal("the output path must differ from the database path")
    return path


def open_readonly(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def default_version_id(conn: sqlite3.Connection) -> int | None:
    row = conn.execute("SELECT default_version_id FROM checklist ORDER BY id LIMIT 1").fetchone()
    return row["default_version_id"] if row else None


def find_conversation(conn: sqlite3.Connection, cid: str, version_id: int) -> dict | None:
    rows = conn.execute("SELECT id, conversation_id, language FROM conversation WHERE conversation_id = ? ORDER BY id", (cid,)).fetchall()
    if not rows:
        return None
    for r in rows:
        if baseline_id(conn, r["id"], version_id) is not None:
            return dict(r)
    return dict(rows[0])


def baseline_id(conn: sqlite3.Connection, pk: int, version_id: int) -> int | None:
    row = conn.execute(
        "SELECT id FROM evaluation WHERE conversation_id = ? AND checklist_version_id = ? "
        "AND status IN ('completed','needs_review') AND (model IS NULL OR model != ?) ORDER BY id DESC LIMIT 1",
        (pk, version_id, MODEL),
    ).fetchone()
    return row["id"] if row else None


def is_kazakh(row: sqlite3.Row) -> bool:
    return (row["language"] or "").strip().lower() in ("kz", "kk", "kaz", "kazakh") or "-kz-" in row["conversation_id"].lower()


def choose_extras(conn: sqlite3.Connection, version_id: int, taken: set[str]) -> list[str]:
    rows = conn.execute("SELECT id, conversation_id, language FROM conversation ORDER BY conversation_id, id").fetchall()
    candidates = []
    seen = set(taken)
    for r in rows:
        if r["conversation_id"] in seen:
            continue
        bid = baseline_id(conn, r["id"], version_id)
        if bid is None:
            continue
        seen.add(r["conversation_id"])
        candidates.append((r, bid))
    chosen: list[str] = []

    def take(pred):
        for r, bid in candidates:
            if r["conversation_id"] not in chosen and pred(r, bid):
                chosen.append(r["conversation_id"])
                return

    def has_na(r, bid):
        row = conn.execute("SELECT answer FROM criterion_result WHERE evaluation_id = ? AND criterion_id = ?", (bid, NA_CRITERION)).fetchone()
        return bool(row) and row["answer"] == "na"

    take(has_na)
    take(lambda r, bid: is_kazakh(r))
    for r, _ in candidates:
        if len(chosen) >= EXTRA_COUNT:
            break
        if r["conversation_id"] not in chosen:
            chosen.append(r["conversation_id"])
    return chosen[:EXTRA_COUNT]


def resolve_targets(conn: sqlite3.Connection, requested: list[str] | None, version_id: int) -> tuple[list[dict], list[str]]:
    ids = list(requested) if requested else list(BASE_CONVERSATIONS)
    if not requested:
        ids += choose_extras(conn, version_id, set(ids))
    found, missing = [], []
    for cid in ids:
        row = find_conversation(conn, cid, version_id)
        if row is None:
            missing.append(cid)
        else:
            found.append(row)
    return found, missing


def estimated_per_call() -> float:
    profile = get_profile(MODEL)
    tin, tout, _ = catalog.PROFILE_ESTIMATES[MODEL]
    return round((tin * profile.price_input + tout * profile.price_output) / 1_000_000, 6)


def scale_positions(cfg) -> dict[str, list[int]]:
    return {c.id: sorted(s.value for s in c.scale_steps) for c in cfg.criteria if c.type == "scale"}


def compare_criteria(cfg, new: dict, old: dict) -> list[dict]:
    positions = scale_positions(cfg)
    old_by = {c["criterion_id"]: c for c in old["criteria"]}
    new_by = {c["criterion_id"]: c for c in new["criteria"]}
    out = []
    for c in cfg.criteria:
        a = new_by.get(c.id, {}).get("answer")
        b = old_by.get(c.id, {}).get("answer")
        match = a == b
        one_step = False
        if not match and c.type == "scale":
            steps = positions[c.id]
            try:
                one_step = abs(steps.index(int(a)) - steps.index(int(b))) == 1
            except (ValueError, TypeError):
                one_step = False
        flip = (not match) and not one_step
        out.append({"criterion_id": c.id, "type": c.type, "new": a, "old": b, "match": match, "one_step": one_step, "flip": flip})
    return out


def repair_turns(conn: sqlite3.Connection, evaluation_id: int) -> int:
    row = conn.execute("SELECT raw_output FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone()
    try:
        raw = json.loads(row[0]) if row and row[0] else {}
    except ValueError:
        raw = {}
    calls = raw.get("calls_meta") or raw.get("calls") or []
    return max(len(calls) - 1, 0)


def row_from_evaluation(conn: sqlite3.Connection, cfg, cid: str, new: dict, old: dict | None) -> dict:
    row = {
        "conversation_id": cid,
        "status": new["status"],
        "repair_turns": repair_turns(conn, new["id"]),
        "tokens_input": new["tokens_input"] or 0,
        "tokens_output": new["tokens_output"] or 0,
        "tokens_cache_read": new["tokens_cache_read"] or 0,
        "cost": float(new["cost"] or 0.0),
        "latency_ms": int(new["latency_ms"] or 0),
        "total": new["total"],
        "provisional": bool(new["provisional"]),
        "gross_violation": bool(new["gross_violation"]),
        "baseline": old is not None,
        "baseline_total": old["total"] if old else None,
        "total_abs_diff": None,
        "gross_agrees": None,
        "criteria": [],
        "flips": [],
        "one_step": [],
        "answer_matches": None,
        "answer_total": len(cfg.criteria),
    }
    if old is not None:
        crit = compare_criteria(cfg, new, old)
        row["criteria"] = crit
        row["flips"] = [c["criterion_id"] for c in crit if c["flip"]]
        row["one_step"] = [c["criterion_id"] for c in crit if c["one_step"]]
        row["answer_matches"] = sum(1 for c in crit if c["match"])
        if new["total"] is not None and old["total"] is not None:
            row["total_abs_diff"] = round(abs(float(new["total"]) - float(old["total"])), 4)
        if new["status"] != "failed":
            row["gross_agrees"] = bool(new["gross_violation"]) == bool(old["gross_violation"])
    return row


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(math.ceil(q * len(ordered)) - 1, 0)]


def mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 6) if values else None


def aggregate(rows: list[dict], cfg) -> dict:
    ran = [r for r in rows if r["status"] not in ("skipped_budget", "error")]
    flips = {c.id: [] for c in cfg.criteria}
    for r in ran:
        for cid in r["flips"]:
            flips[cid].append(r["conversation_id"])
    done = [r for r in ran if r["status"] != "failed"]
    diffs = [r["total_abs_diff"] for r in ran if r["total_abs_diff"] is not None]
    latencies = [r["latency_ms"] for r in ran]
    return {
        "conversations_run": len(ran),
        "conversations_skipped_budget": [r["conversation_id"] for r in rows if r["status"] == "skipped_budget"],
        "conversations_error": [r["conversation_id"] for r in rows if r["status"] == "error"],
        "failed": sum(1 for r in ran if r["status"] == "failed"),
        "needs_review": sum(1 for r in ran if r["status"] == "needs_review"),
        "repair_turns": sum(r["repair_turns"] for r in ran),
        "total_cost": round(sum(r["cost"] for r in ran), 6),
        "mean_cost": mean([r["cost"] for r in ran]),
        "latency_ms_p50": percentile(latencies, 0.5),
        "latency_ms_p95": percentile(latencies, 0.95),
        "median_abs_total_diff": round(statistics.median(diffs), 4) if diffs else None,
        "flips_by_criterion": {cid: len(v) for cid, v in flips.items()},
        "flip_conversations_by_criterion": {cid: v for cid, v in flips.items() if v},
        "gross_disagreements": [r["conversation_id"] for r in ran if r["gross_agrees"] is False],
        "gross_compared": sum(1 for r in ran if r["gross_agrees"] is not None),
        "mean_tokens_input": mean([r["tokens_input"] for r in done]),
        "mean_tokens_output": mean([r["tokens_output"] for r in done]),
        "mean_tokens_cache_read": mean([r["tokens_cache_read"] for r in done]),
    }


def acceptance(agg: dict, planned: int) -> list[dict]:
    n = agg["conversations_run"]
    lines = []

    def add(name, ok, detail):
        lines.append({"name": name, "pass": bool(ok), "detail": detail})

    add("all planned conversations evaluated", n == planned and not agg["conversations_error"], f"{n} of {planned}")
    add("0 failed", agg["failed"] == 0, str(agg["failed"]))
    add("0 needs_review", agg["needs_review"] == 0, str(agg["needs_review"]))
    add("0 repair turns", agg["repair_turns"] == 0, str(agg["repair_turns"]))
    mc = agg["mean_cost"]
    add(f"mean cost <= {MAX_MEAN_COST}", mc is not None and mc <= MAX_MEAN_COST, str(mc))
    p95 = agg["latency_ms_p95"]
    add(f"p95 latency <= {MAX_P95_LATENCY_MS // 1000} s", p95 is not None and p95 <= MAX_P95_LATENCY_MS, f"{p95} ms")
    add("gross-violation agrees on every chosen conversation", agg["gross_compared"] > 0 and not agg["gross_disagreements"], f"disagreements {agg['gross_disagreements']}")
    md = agg["median_abs_total_diff"]
    add(f"median absolute total-score difference <= {MAX_MEDIAN_TOTAL_DIFF:g}", md is not None and md <= MAX_MEDIAN_TOTAL_DIFF, str(md))
    limit = MAX_FLIP_SHARE * n
    worst = {cid: k for cid, k in agg["flips_by_criterion"].items() if k > limit}
    add(f"no criterion flipping on more than {MAX_FLIP_SHARE * 10:g} of 10 conversations", n > 0 and not worst, f"over limit {worst}" if worst else f"max {max(agg['flips_by_criterion'].values(), default=0)} of {n}")
    return lines


def print_plan(db_path: Path, found, missing, version_id, per_call, cap) -> None:
    print(f"database copy: {db_path.name}")
    print(f"checklist version id: {version_id}")
    print(f"model: {MODEL}  effort: {EFFORT}  prompt version: {PROMPT_VERSION}")
    print(f"conversations found ({len(found)}): {', '.join(r['conversation_id'] for r in found)}")
    print(f"conversations missing ({len(missing)}): {', '.join(missing) if missing else 'none'}")
    print(f"estimated cost per conversation: ${per_call:.4f}")
    print(f"estimated total cost: ${per_call * len(found):.4f}")
    if cap is not None:
        print(f"max spend: ${cap:.4f}")


def print_report(rows: list[dict], agg: dict, lines: list[dict]) -> None:
    for r in rows:
        if r["status"] in ("skipped_budget", "error"):
            print(f"{r['conversation_id']}: {r['status']}")
            continue
        print(
            f"{r['conversation_id']}: status={r['status']} repair_turns={r['repair_turns']} tokens in/out/cache={r['tokens_input']}/{r['tokens_output']}/{r['tokens_cache_read']} "
            f"cost=${r['cost']:.6f} latency_ms={r['latency_ms']} total={r['total']} baseline_total={r['baseline_total']} abs_diff={r['total_abs_diff']} "
            f"gross_agrees={r['gross_agrees']} provisional={r['provisional']}"
        )
        if r["baseline"]:
            print(f"  answer match {r['answer_matches']}/{r['answer_total']} one_step={r['one_step']} flips={r['flips']}")
            for c in r["criteria"]:
                if not c["match"]:
                    print(f"  criterion {c['criterion_id']} ({c['type']}): new={c['new']} opus={c['old']}")
        else:
            print("  no stored Opus evaluation to compare")
    print("aggregate:")
    for k, v in agg.items():
        print(f"  {k}: {v}")
    print("acceptance:")
    for ln in lines:
        print(f"  {'PASS' if ln['pass'] else 'FAIL'} {ln['name']} ({ln['detail']})")


def run_execute(conn, db_path, found, version_id, settings, client, cap, per_call) -> tuple[list[dict], dict, list[dict]]:
    cfg = get_version(conn, version_id).config
    rows: list[dict] = []
    costs: list[float] = []
    spent = 0.0
    stopped = False
    for target in found:
        cid = target["conversation_id"]
        avg = sum(costs) / len(costs) if costs else 0.0
        if stopped or spent >= cap or spent + avg * 2 > cap:
            stopped = True
            rows.append({"conversation_id": cid, "status": "skipped_budget"})
            continue
        old_id = baseline_id(conn, target["id"], version_id)
        old = get_evaluation(conn, old_id) if old_id is not None else None
        try:
            new = evaluate_conversation(conn, target["id"], version_id, client, settings=settings)
        except Exception as exc:
            rows.append({"conversation_id": cid, "status": "error", "error_type": type(exc).__name__})
            continue
        row = row_from_evaluation(conn, cfg, cid, new, old)
        spent += row["cost"]
        costs.append(row["cost"])
        rows.append(row)
    agg = aggregate(rows, cfg)
    return rows, agg, acceptance(agg, len(found))


def parse_args(argv):
    p = argparse.ArgumentParser(prog="shadow_compare", description="Shadow comparison of gpt-6.1-sol against stored Opus evaluations on a COPY of the database")
    p.add_argument("--db", required=True)
    p.add_argument("--conversations")
    p.add_argument("--version-id", type=int)
    p.add_argument("--max-spend", type=float)
    p.add_argument("--execute", action="store_true")
    p.add_argument("--out")
    args = p.parse_args(argv)
    if args.execute and (args.max_spend is None or args.max_spend <= 0):
        p.error("--max-spend (a positive USD amount) is required with --execute")
    return args


def main(argv=None, sdk=None) -> int:
    args = parse_args(argv)
    try:
        db_path = check_db_path(args.db)
        out_path = check_out_path(args.out, db_path) if args.out else None
    except Refusal as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    requested = [c.strip() for c in args.conversations.split(",") if c.strip()] if args.conversations else None
    settings = build_settings()
    per_call = estimated_per_call()
    try:
        conn = connect(str(db_path)) if args.execute else open_readonly(db_path)
    except sqlite3.Error as exc:
        print(f"infrastructure error: {type(exc).__name__}", file=sys.stderr)
        return 1
    try:
        version_id = args.version_id or default_version_id(conn)
        if version_id is None:
            print("infrastructure error: no checklist version found in the copy", file=sys.stderr)
            return 1
        found, missing = resolve_targets(conn, requested, version_id)
        print_plan(db_path, found, missing, version_id, per_call, args.max_spend)
        if not args.execute:
            print("dry run: no calls made; pass --execute with --max-spend to run")
            return 0
        if sdk is None and not settings.openai_api_key:
            print("infrastructure error: OPENAI_API_KEY is not set", file=sys.stderr)
            return 1
        if not found:
            print("infrastructure error: no conversations found", file=sys.stderr)
            return 1
        client = OpenAIClient(sdk=sdk, settings=settings)
        rows, agg, lines = run_execute(conn, db_path, found, version_id, settings, client, args.max_spend, per_call)
    except Exception as exc:
        print(f"infrastructure error: {type(exc).__name__}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    print_report(rows, agg, lines)
    report = {
        "plan": {
            "db": db_path.name,
            "checklist_version_id": version_id,
            "model": MODEL,
            "effort": EFFORT,
            "prompt_version": PROMPT_VERSION,
            "max_spend": args.max_spend,
            "estimated_cost_per_conversation": per_call,
            "found": [r["conversation_id"] for r in found],
            "missing": missing,
        },
        "conversations": rows,
        "aggregate": agg,
        "acceptance": lines,
    }
    if out_path is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return 1 if agg["conversations_error"] else 0


if __name__ == "__main__":
    sys.exit(main())
