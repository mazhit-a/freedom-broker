import json
import statistics
from collections import Counter
from pathlib import Path

from backend.app.services.evaluator import validate_item
from backend.app.services.importer import compute_offsets
from evals.gen import ambiguity
from evals.gen.common import (
    CHANNELS,
    CHECKLIST_REL,
    DATASET_PATH,
    LENGTHS,
    ROOT,
    SPEAKERS,
    cases_hash,
    load_checklist,
    possible_answers,
)
from evals.gen.spec import sample_specs
from evals.gen.validate import flag, parse_generation, split_flag, validate_case

MESSAGE_FIELDS = ("message_index", "timestamp_raw", "offset_seconds", "speaker", "text")
EXPECTED_FIELDS = ("answer", "rationale", "evidence", "checked_range", "na_reason")
STATUSES = ("pending", "accepted", "edited", "rejected")
CARD_PATH = ROOT / "evals" / "DATASET.md"


def normalize_messages(messages: list) -> list[dict]:
    clean = [m for m in messages if isinstance(m, dict)]
    offsets = compute_offsets([m.get("timestamp_raw") for m in clean])
    out = []
    for m, offset in zip(clean, offsets):
        row = {k: m.get(k) for k in MESSAGE_FIELDS}
        if offset is not None:
            row["offset_seconds"] = offset
        out.append(row)
    return out


def _raw_item(item) -> dict:
    item = item if isinstance(item, dict) else {}
    evidence = [
        {"message_index": e.get("message_index"), "quote": e.get("quote")}
        for e in (item.get("evidence") or [])
        if isinstance(e, dict)
    ]
    checked = item.get("checked_range")
    return {
        "answer": item.get("answer"),
        "rationale": item.get("rationale") if isinstance(item.get("rationale"), str) else "",
        "evidence": evidence,
        "checked_range": checked if isinstance(checked, dict) else None,
        "na_reason": item.get("na_reason") if isinstance(item.get("na_reason"), str) else None,
    }


def build_expected(cfg, messages: list[dict], results: list) -> dict:
    by_id = {}
    for item in results:
        if isinstance(item, dict) and isinstance(item.get("criterion_id"), str):
            by_id.setdefault(item["criterion_id"], item)
    expected = {}
    for c in cfg.criteria:
        item = by_id.get(c.id)
        if item is None:
            continue
        normalized, errors = validate_item(c, item, messages)
        if normalized is not None:
            expected[c.id] = {k: normalized[k] for k in EXPECTED_FIELDS}
        else:
            expected[c.id] = _raw_item(item)
    return expected


def tags_from_spec(spec: dict) -> dict:
    return {
        "channel": spec["channel_tag"],
        "language": spec["language"],
        "length": spec["length"],
        "topic": spec["topic"],
        "hard": list(spec["hard"]),
    }


def case_from_output(cfg, spec: dict, data: dict) -> dict:
    messages = normalize_messages(data.get("messages") or [])
    case = {
        "id": spec["id"],
        "split": spec["split"],
        "tags": tags_from_spec(spec),
        "conversation": {
            "channel": spec["channel"],
            "language": spec["conversation_language"],
            "messages": messages,
        },
        "expected": build_expected(cfg, messages, data.get("results") or []),
        "review": {"status": "pending", "flags": []},
    }
    case["review"]["flags"] = validate_case(cfg, spec, case)
    return case


def parse_result_line(line: str) -> tuple[str | None, str | None, str | None]:
    try:
        row = json.loads(line)
    except ValueError:
        return None, None, "line is not valid JSON"
    cid = row.get("custom_id")
    if "text" in row and "result" not in row:
        return cid, row["text"], None
    result = row.get("result") or {}
    kind = result.get("type")
    if kind != "succeeded":
        detail = json.dumps(result.get("error"), ensure_ascii=False) if result.get("error") else ""
        return cid, None, f"batch result {kind or 'missing'} {detail}".strip()
    message = result.get("message") or {}
    if message.get("stop_reason") in ("max_tokens", "refusal"):
        return cid, None, f"generation stopped with {message['stop_reason']}"
    text = "".join(b.get("text", "") for b in message.get("content") or [] if b.get("type") == "text")
    return cid, text, None


def ingest_results(cfg, specs: list[dict], lines: list[str]) -> tuple[list[dict], dict[str, str]]:
    by_id = {s["id"]: s for s in specs}
    cases: dict[str, dict] = {}
    failures: dict[str, str] = {}
    for line in lines:
        if not line.strip():
            continue
        cid, text, error = parse_result_line(line)
        if cid not in by_id:
            failures[str(cid)] = error or "custom_id does not match any spec"
            continue
        if error:
            failures[cid] = error
            continue
        data, perr = parse_generation(text)
        if perr:
            failures[cid] = perr
            continue
        cases[cid] = case_from_output(cfg, by_id[cid], data)
        failures.pop(cid, None)
    for cid in by_id:
        if cid not in cases and cid not in failures:
            failures[cid] = "no result"
    return [cases[k] for k in sorted(cases)], failures


def attach_blind(cfg, cases: list[dict], lines: list[str]) -> list[str]:
    by_id = {c["id"]: c for c in cases}
    problems = []
    for line in lines:
        if not line.strip():
            continue
        cid, text, error = parse_result_line(line)
        case = by_id.get(cid)
        if case is None:
            problems.append(f"{cid}: not in dataset")
            continue
        review = case["review"]
        review["flags"] = [f for f in review["flags"] if split_flag(f)[0] != "ambiguity"]
        if error:
            review["flags"].append(flag("ambiguity", None, f"blind check failed: {error}"))
            continue
        blind = ambiguity.parse_blind(cfg, text)
        if not blind:
            review["flags"].append(flag("ambiguity", None, "blind check output could not be parsed"))
            continue
        review["flags"].extend(ambiguity.compare(cfg, case["expected"], blind))
    return problems


def assemble_dataset(cases: list[dict], version: int = 1) -> dict:
    ordered = sorted(cases, key=lambda c: c["id"])
    return {"version": version, "checklist": CHECKLIST_REL, "hash": cases_hash(ordered), "cases": ordered}


def write_dataset(dataset: dict, path: Path | str = DATASET_PATH) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def verify_hash(dataset: dict) -> bool:
    return dataset.get("hash") == cases_hash(dataset.get("cases", []))


def contract_errors(dataset: dict, cfg=None) -> list[str]:
    cfg = cfg or load_checklist()
    errors = []
    if set(dataset) != {"version", "checklist", "hash", "cases"}:
        errors.append(f"top-level keys are {sorted(dataset)}")
    if not isinstance(dataset.get("version"), int) or isinstance(dataset.get("version"), bool):
        errors.append("version must be an int")
    if dataset.get("checklist") != CHECKLIST_REL:
        errors.append("checklist path is wrong")
    if not verify_hash(dataset):
        errors.append("hash does not match the cases")
    ids = [c.get("id") for c in dataset.get("cases", [])]
    if len(set(ids)) != len(ids):
        errors.append("duplicate case ids")
    criteria = {c.id for c in cfg.criteria}
    for case in dataset.get("cases", []):
        cid = case.get("id")
        if set(case) != {"id", "split", "tags", "conversation", "expected", "review"}:
            errors.append(f"{cid}: case keys are {sorted(case)}")
            continue
        if case["split"] not in ("dev", "holdout"):
            errors.append(f"{cid}: bad split")
        if set(case["tags"]) != {"channel", "language", "length", "topic", "hard"} or not isinstance(case["tags"]["hard"], list):
            errors.append(f"{cid}: bad tags")
        conv = case["conversation"]
        if set(conv) != {"channel", "language", "messages"}:
            errors.append(f"{cid}: bad conversation keys")
        elif conv["channel"] not in CHANNELS or conv["language"] not in ("ru", "kk", "en"):
            errors.append(f"{cid}: bad channel or language")
        for pos, m in enumerate(conv.get("messages", [])):
            if not isinstance(m, dict) or set(m) != set(MESSAGE_FIELDS):
                errors.append(f"{cid}: message {pos} has bad fields")
            elif m["speaker"] not in SPEAKERS:
                errors.append(f"{cid}: message {pos} has bad speaker")
        if set(case["expected"]) - criteria:
            errors.append(f"{cid}: unknown criteria in expected")
        for crit, item in case["expected"].items():
            if not isinstance(item, dict) or set(item) != set(EXPECTED_FIELDS):
                errors.append(f"{cid}/{crit}: bad expected fields")
        review = case["review"]
        if set(review) != {"status", "flags"} or review["status"] not in STATUSES or not isinstance(review["flags"], list):
            errors.append(f"{cid}: bad review block")
    return errors


def freeze(dataset: dict, version: int | None = None, cfg=None, specs: list[dict] | None = None) -> tuple[dict | None, list[str]]:
    cfg = cfg or load_checklist()
    specs = specs or sample_specs(cfg=cfg)
    by_id = {s["id"]: s for s in specs}
    problems = []
    kept = []
    for case in dataset["cases"]:
        status = case["review"]["status"]
        if status == "pending":
            problems.append(f"{case['id']}: still pending review")
        elif status == "rejected":
            problems.append(f"{case['id']}: rejected, regenerate it from the same spec")
        else:
            kept.append(case)
    for case in kept:
        spec = by_id.get(case["id"])
        if spec is None:
            problems.append(f"{case['id']}: no spec")
            continue
        remaining = [f for f in validate_case(cfg, spec, case) if split_flag(f)[0] in ("format", "index", "evidence", "range", "answer", "na_reason", "rationale", "quote")]
        if remaining:
            problems.append(f"{case['id']}: {len(remaining)} hard validation errors remain, first: {remaining[0]}")
    if problems:
        return None, problems
    return assemble_dataset(kept, version or dataset.get("version", 1)), []


def _stats(values: list[int]) -> dict:
    if not values:
        return {"n": 0, "min": None, "median": None, "mean": None, "max": None}
    return {
        "n": len(values),
        "min": min(values),
        "median": statistics.median(values),
        "mean": round(statistics.fmean(values), 1),
        "max": max(values),
    }


def conversation_stats(cases: list[dict]) -> dict:
    counts = [len(c["conversation"]["messages"]) for c in cases]
    speakers = Counter(m["speaker"] for c in cases for m in c["conversation"]["messages"])
    total = sum(speakers.values()) or 1
    return {
        "message_count": _stats(counts),
        "speaker_share": {s: round(speakers[s] / total, 3) for s in SPEAKERS},
    }


def _table(headers: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(str(x) for x in row) + " |" for row in rows]
    return "\n".join(out)


def build_card(dataset: dict, cfg=None, reference: dict | None = None) -> str:
    cfg = cfg or load_checklist()
    cases = dataset["cases"]
    answers = possible_answers(cfg)
    lines = [
        "# Evaluation dataset card",
        "",
        f"- version: {dataset['version']}",
        f"- hash: `{dataset['hash']}`",
        f"- checklist: `{dataset['checklist']}`",
        f"- cases: {len(cases)} (dev {sum(c['split'] == 'dev' for c in cases)}, holdout {sum(c['split'] == 'holdout' for c in cases)})",
        "- synthetic conversations; expected results reviewed by one human reviewer",
        "",
        "## Review status",
        "",
        _table(["status", "cases"], [[s, sum(c["review"]["status"] == s for c in cases)] for s in STATUSES]),
        "",
    ]

    def dist(title: str, getter, keys):
        rows = []
        for k in keys:
            rows.append([k] + [sum(1 for c in cases if c["split"] == sp and getter(c) == k) for sp in ("dev", "holdout")])
            rows[-1].append(rows[-1][1] + rows[-1][2])
        lines.extend([f"## {title}", "", _table(["value", "dev", "holdout", "all"], rows), ""])

    dist("Channel", lambda c: c["tags"]["channel"], ["chat", "call"])
    dist("Language", lambda c: c["tags"]["language"], ["ru", "kk", "en", "switch"])
    dist("Length", lambda c: c["tags"]["length"], list(LENGTHS))
    topics = sorted({c["tags"]["topic"] for c in cases})
    dist("Topic", lambda c: c["tags"]["topic"], topics)
    hard = sorted({h for c in cases for h in c["tags"]["hard"]})
    rows = [[h] + [sum(1 for c in cases if c["split"] == sp and h in c["tags"]["hard"]) for sp in ("dev", "holdout")] for h in hard]
    rows = [r + [r[1] + r[2]] for r in rows]
    lines.extend(["## Hard cases", "", _table(["hard case", "dev", "holdout", "all"], rows), ""])
    rows = []
    for c in cfg.criteria:
        for v in answers[c.id]:
            counts = [
                sum(1 for k in cases if k["split"] == sp and str(k["expected"].get(c.id, {}).get("answer")) == str(v))
                for sp in ("dev", "holdout")
            ]
            rows.append([c.id, v] + counts + [sum(counts)])
    lines.extend(["## Expected answers per criterion", "", _table(["criterion", "answer", "dev", "holdout", "all"], rows), ""])
    rows = []
    for channel in CHANNELS:
        for length in LENGTHS:
            subset = [k for k in cases if k["conversation"]["channel"] == channel and k["tags"]["length"] == length]
            st = _stats([len(k["conversation"]["messages"]) for k in subset])
            rows.append([channel, length, st["n"], st["min"], st["median"], st["mean"], st["max"]])
    lines.extend(["## Message counts", "", _table(["channel", "length", "cases", "min", "median", "mean", "max"], rows), ""])
    rows = []
    for channel in list(CHANNELS) + ["all"]:
        subset = [k for k in cases if channel == "all" or k["conversation"]["channel"] == channel]
        share = conversation_stats(subset)["speaker_share"]
        rows.append([channel] + [f"{share[s]:.1%}" for s in SPEAKERS])
    lines.extend(["## Speaker mix (share of messages)", "", _table(["channel"] + list(SPEAKERS), rows), ""])
    own = conversation_stats(cases)
    lines.extend(["## Realism check against DEV statistics", ""])
    if reference:
        ref_count, own_count = reference["message_count"], own["message_count"]
        rows = [[k, ref_count.get(k), own_count.get(k)] for k in ("n", "min", "median", "mean", "max")]
        rows += [[f"share {s}", reference["speaker_share"].get(s), own["speaker_share"].get(s)] for s in SPEAKERS]
        lines.append(_table(["statistic", "DEV", "this set"], rows))
    else:
        lines.append("No DEV reference statistics were supplied. Pass a JSON file with message_count and speaker_share, as produced by conversation_stats, to fill this table.")
    flag_counts = Counter(split_flag(f)[0] for c in cases for f in c["review"]["flags"])
    lines.extend(["", "## Open flags", ""])
    lines.append(_table(["kind", "count"], [[k, n] for k, n in sorted(flag_counts.items())]) if flag_counts else "none")
    return "\n".join(lines) + "\n"
