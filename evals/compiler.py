import hashlib
import json
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from backend.app.core.config import Settings
from backend.app.schemas.checklist import ChecklistConfig, Criterion
from backend.app.services.llm_client import LLMClient
from backend.app.services.model_profiles import get_profile
from evals import prices

ROOT = Path(__file__).resolve().parents[1]
COMPILED_DIR = ROOT / "evals" / "compiled"
COMPILER_MODEL = "claude-opus-5-5"
COMPILER_EFFORT = "medium"
COMPILER_NAMES = ("naive", "principled")
COMPILER_VERSIONS = {"naive": "naive-v1", "principled": "principled-v1"}
FILE_VERSION = 1
JEV_TYPES = ("noul", "choice")
SPEC_FIELDS = ("jev_type", "instructions", "options", "needs_pause_marks")
OPTION_FIELDS = ("key", "text", "maps_to")
KEY_RE = re.compile(r"^[A-Za-z0-9_]{1,40}$")
ESTIMATE_INPUT_TOKENS = 1500
ESTIMATE_OUTPUT_TOKENS = 1500
RETRYABLE_STATUSES = (408, 409, 429)
MAX_API_ATTEMPTS = 4

SCHEMA_DESCRIPTION = (
    "Return one JSON object with exactly these fields.\n"
    "- jev_type: \"choice\" for yes_no and scale criteria, \"noul\" for flag criteria.\n"
    "- instructions: the question text for the decision model, written in Russian.\n"
    "- options: a list of objects {key, text, maps_to}. key is a short identifier (letters, digits, underscore) that the decision model "
    "returns; text is the description of the option, written in Russian; maps_to is the checklist answer the option stands for.\n"
    "- needs_pause_marks: boolean; true means the transcript shown to the decision model will be annotated with waiting gaps between "
    "messages for this question.\n"
    "Option rules. A yes_no criterion without N/A: exactly two options, mapping to yes and no. A yes_no criterion with N/A: three options, "
    "mapping to yes, no and na. A scale criterion: one option per scale step, maps_to is the step value written as digits (for example \"15\"), "
    "plus one option mapping to na when N/A is allowed. A flag criterion: jev_type noul and exactly two options, key \"true\" mapping to yes "
    "(the violation is present) and key \"false\" mapping to no (no violation). Every legal answer appears exactly once. Do not invent answers."
)

NAIVE_PROMPT_V1 = (
    "You convert one quality-checklist criterion into a typed question for a decision model that answers typed questions about a "
    "conversation transcript. Preserve the meaning of the criterion. Write the question and the option texts in Russian, the language of "
    "the checklist.\n\n" + SCHEMA_DESCRIPTION
)

PRINCIPLES_V1 = (
    "Write the question so that the answer can be decided from observable events in the transcript (messages, timestamps, system events "
    "such as hold, pause, identity verification, escalation), not from impressions.",
    "If the criterion depends on order or timing (before/after, first/later, how long), state the order explicitly and say what to locate "
    "first and what to compare.",
    "If the criterion concerns every item of some kind (all questions, all steps), tell the model to enumerate the items and check each one.",
    "Spell out what every option means for this criterion, including 'no' (action needed but missing, late or wrong) and 'na' (the stated "
    "N/A condition holds), staying inside the criterion text and adding no new policy.",
    "For scales keep the step descriptors verbatim as option texts and list in the instructions the checks that distinguish adjacent steps.",
    "Set needs_pause_marks to true if the criterion is affected by waiting, holding or response time; otherwise false.",
)

PRINCIPLES_HEADER = "Design principles for the question:"
PRINCIPLED_PROMPT_V1 = (
    NAIVE_PROMPT_V1 + "\n\n" + PRINCIPLES_HEADER + "\n" + "\n".join(f"({i}) {p}" for i, p in enumerate(PRINCIPLES_V1, 1))
)

PROMPTS = {"naive": NAIVE_PROMPT_V1, "principled": PRINCIPLED_PROMPT_V1}


class CompiledError(ValueError):
    pass


def one_line(text: Any) -> str:
    return " ".join(str(text or "").split())


def criterion_payload(c: Criterion) -> dict:
    return {
        "id": c.id,
        "title": c.title,
        "type": c.type,
        "description": c.description,
        "na_allowed": c.na_allowed,
        "na_condition": c.na_condition,
        "scale_steps": [{"value": s.value, "descriptor": s.descriptor} for s in sorted(c.scale_steps, key=lambda s: s.value)],
    }


def checklist_hash(cfg: ChecklistConfig) -> str:
    body = json.dumps([criterion_payload(c) for c in cfg.criteria], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def hash8(cfg: ChecklistConfig) -> str:
    return checklist_hash(cfg)[:8]


def compiled_path(cfg: ChecklistConfig, compiler: str, directory: Path | str = COMPILED_DIR) -> Path:
    if compiler not in COMPILER_NAMES:
        raise ValueError(f"compiler must be one of {COMPILER_NAMES}")
    return Path(directory) / f"{hash8(cfg)}-{compiler}.json"


def expected_shape(c: Criterion) -> tuple[str, list[Any]]:
    if c.type == "flag":
        return "noul", ["yes", "no"]
    if c.type == "scale":
        answers: list[Any] = [s.value for s in sorted(c.scale_steps, key=lambda s: s.value)]
    else:
        answers = ["yes", "no"]
    if c.na_allowed:
        answers.append("na")
    return "choice", answers


def spec_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "jev_type": {"type": "string", "enum": list(JEV_TYPES)},
            "instructions": {"type": "string"},
            "options": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"key": {"type": "string"}, "text": {"type": "string"}, "maps_to": {"type": "string"}},
                    "required": list(OPTION_FIELDS),
                    "additionalProperties": False,
                },
            },
            "needs_pause_marks": {"type": "boolean"},
        },
        "required": list(SPEC_FIELDS),
        "additionalProperties": False,
    }


def system_prompt(compiler: str) -> str:
    if compiler not in PROMPTS:
        raise ValueError(f"compiler must be one of {COMPILER_NAMES}")
    return PROMPTS[compiler]


def user_message(c: Criterion) -> str:
    jev_type, answers = expected_shape(c)
    if c.type == "flag":
        shape = (
            "Required: jev_type noul; options exactly key \"true\" with maps_to \"yes\" (the violation is present) "
            "and key \"false\" with maps_to \"no\" (no violation)."
        )
    else:
        listed = ", ".join(f"\"{a}\"" for a in answers)
        shape = f"Required: jev_type {jev_type}; one option for each of these maps_to values, each exactly once: {listed}."
    return "Criterion:\n" + json.dumps(criterion_payload(c), ensure_ascii=False, indent=1) + "\n\n" + shape


def compiler_profile():
    return get_profile(COMPILER_MODEL).with_overrides(effort=COMPILER_EFFORT)


def build_request(c: Criterion, compiler: str, prior: tuple[str, list[str]] | None = None) -> dict:
    messages: list[dict] = [{"role": "user", "content": user_message(c)}]
    if prior is not None:
        text, errors = prior
        feedback = "Your previous answer was rejected:\n" + "\n".join(f"- {e}" for e in errors) + "\nReturn the corrected JSON object only."
        messages.append({"role": "assistant", "content": text or "{}"})
        messages.append({"role": "user", "content": feedback})
    client = LLMClient(sdk=object(), settings=Settings(_env_file=None), profile=compiler_profile())
    return client._request(system_prompt(compiler), messages, spec_schema())


def parse_spec_text(text: str) -> tuple[Any, list[str]]:
    try:
        return json.loads(text), []
    except (ValueError, TypeError) as exc:
        return None, [f"the response is not valid JSON: {str(exc)[:120]}"]


def canonical_step(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isascii() and value.isdigit() and str(int(value)) == value:
        return int(value)
    return None


def validate_spec(c: Criterion, raw: Any) -> tuple[dict | None, list[str]]:
    errors: list[str] = []
    if not isinstance(raw, dict):
        return None, ["the spec must be a JSON object"]
    if set(raw) != set(SPEC_FIELDS):
        missing = sorted(set(SPEC_FIELDS) - set(raw))
        extra = sorted(set(raw) - set(SPEC_FIELDS))
        return None, [f"the spec fields must be exactly {list(SPEC_FIELDS)}; missing {missing}, unexpected {extra}"]
    expected_type, expected_answers = expected_shape(c)
    jev_type = raw["jev_type"]
    if jev_type not in JEV_TYPES:
        errors.append(f"jev_type must be one of {list(JEV_TYPES)}, got {jev_type!r}")
    elif jev_type != expected_type:
        errors.append(f"jev_type must be {expected_type!r} for a {c.type} criterion, got {jev_type!r}")
    instructions = raw["instructions"]
    if not isinstance(instructions, str) or not instructions.strip():
        errors.append("instructions must be a non-empty string")
    if not isinstance(raw["needs_pause_marks"], bool):
        errors.append("needs_pause_marks must be a boolean")
    options = raw["options"]
    if not isinstance(options, list) or not options:
        errors.append("options must be a non-empty list")
        return None, errors
    clean: list[dict] = []
    keys: list[str] = []
    answers: list[Any] = []
    for i, o in enumerate(options):
        if not isinstance(o, dict) or set(o) != set(OPTION_FIELDS):
            errors.append(f"option {i} must be an object with exactly the fields {list(OPTION_FIELDS)}")
            continue
        key, text, maps_to = o["key"], o["text"], o["maps_to"]
        if not isinstance(key, str) or not KEY_RE.match(key):
            errors.append(f"option {i}: key {key!r} is not a safe identifier (letters, digits, underscore, 1-40 characters)")
        if not isinstance(text, str) or not text.strip():
            errors.append(f"option {i}: text must be a non-empty string")
        if c.type == "scale":
            step = canonical_step(maps_to)
            if step is not None:
                normalized: Any = step
            elif maps_to == "na":
                normalized = "na"
            else:
                normalized = None
                errors.append(f"option {i}: maps_to {maps_to!r} is not a scale step value or 'na'")
        else:
            if not isinstance(maps_to, str):
                normalized = None
                errors.append(f"option {i}: maps_to must be a string, got {maps_to!r}")
            else:
                normalized = maps_to
        keys.append(key)
        answers.append(normalized)
        clean.append({"key": key, "text": text.strip() if isinstance(text, str) else text, "maps_to": normalized})
    dup_keys = sorted({k for k in keys if isinstance(k, str) and keys.count(k) > 1})
    if dup_keys:
        errors.append(f"duplicate option keys: {dup_keys}")
    known = [a for a in answers if a is not None]
    dup_answers = sorted({str(a) for a in known if known.count(a) > 1})
    if dup_answers:
        errors.append(f"duplicate maps_to values: {dup_answers}")
    if len(known) == len(answers):
        if set(map(str, known)) != set(map(str, expected_answers)):
            errors.append(
                f"maps_to values must cover exactly {[str(a) for a in expected_answers]} for this {c.type} criterion"
                f"{' with N/A' if c.na_allowed else ''}, got {[str(a) for a in known]}"
            )
    if c.type == "flag" and not dup_keys:
        by_key = {o["key"]: o["maps_to"] for o in clean}
        if by_key != {"true": "yes", "false": "no"}:
            errors.append("a flag criterion needs exactly key 'true' mapping to 'yes' and key 'false' mapping to 'no'")
    if errors:
        return None, errors
    return {"jev_type": jev_type, "instructions": instructions.strip(), "options": clean, "needs_pause_marks": raw["needs_pause_marks"]}, []


def spec_warnings(c: Criterion, spec: dict) -> list[str]:
    if c.type != "scale":
        return []
    by_step = {s.value: one_line(s.descriptor) for s in c.scale_steps}
    return [
        f"option text for step {o['maps_to']} is not the verbatim scale descriptor"
        for o in spec["options"]
        if o["maps_to"] != "na" and one_line(o["text"]) != by_step.get(o["maps_to"])
    ]


def plain(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [plain(v) for v in obj]
    if hasattr(obj, "model_dump"):
        return plain(obj.model_dump(mode="json"))
    if hasattr(obj, "__dict__") and not isinstance(obj, type):
        return {k: plain(v) for k, v in vars(obj).items() if not k.startswith("_")}
    return obj


def is_retryable(exc: Exception) -> bool:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and (status in RETRYABLE_STATUSES or status >= 500):
        return True
    name = type(exc).__name__
    return "Timeout" in name or "Connection" in name


def model_matches(served: str, requested: str) -> bool:
    return served == requested or served.startswith(requested + "-")


def empty_usage() -> dict:
    return {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost": 0.0}


def send(client: Any, params: dict, sleep: Callable[[float], None] = time.sleep) -> dict:
    with_options = getattr(client, "with_options", None)
    live = with_options(max_retries=0) if callable(with_options) else client
    attempt = 0
    while True:
        attempt += 1
        try:
            msg = plain(live.messages.create(**params))
        except Exception as exc:
            if is_retryable(exc) and attempt < MAX_API_ATTEMPTS:
                sleep(min(30.0, 1.0 * 2 ** (attempt - 1)))
                continue
            return {"error": f"{type(exc).__name__}: {str(exc)[:300]}", "usage": empty_usage()}
        usage = msg.get("usage") or {}

        def tok(name: str) -> int:
            return int(usage.get(name) or 0)

        inp, out, cr, cw = tok("input_tokens"), tok("output_tokens"), tok("cache_read_input_tokens"), tok("cache_creation_input_tokens")
        served = msg.get("model") if isinstance(msg.get("model"), str) else ""
        text = "".join(b.get("text") or "" for b in (msg.get("content") or []) if (b or {}).get("type", "text") == "text")
        call_usage = {
            "calls": 1,
            "input_tokens": inp,
            "output_tokens": out,
            "cache_read_tokens": cr,
            "cache_write_tokens": cw,
            "cost": prices.cost(COMPILER_MODEL, inp, out, cr, cw),
        }
        result = {"text": text, "stop_reason": msg.get("stop_reason"), "served": served, "usage": call_usage}
        if not served:
            result["error"] = "response carries no served model"
        elif not model_matches(served, COMPILER_MODEL):
            result["error"] = f"served model {served!r} does not match requested model {COMPILER_MODEL!r}"
        return result


def add_usage(total: dict, part: dict) -> None:
    for k in ("calls", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"):
        total[k] += int(part.get(k) or 0)
    total["cost"] = round(total["cost"] + float(part.get("cost") or 0), 6)


def attempt_once(c: Criterion, compiler: str, client: Any, prior, sleep, on_call: Callable[[dict], None]) -> tuple[dict | None, list[str], str, bool]:
    reply = send(client, build_request(c, compiler, prior), sleep)
    on_call(reply)
    if "error" in reply:
        return None, [reply["error"]], reply.get("text", ""), True
    if reply["stop_reason"] == "refusal":
        return None, ["the model refused to compile this criterion"], reply["text"], True
    raw, errors = parse_spec_text(reply["text"])
    if errors:
        return None, errors, reply["text"], False
    spec, errors = validate_spec(c, raw)
    return spec, errors, reply["text"], False


def compile_criterion(
    c: Criterion,
    compiler: str,
    client: Any,
    sleep: Callable[[float], None] = time.sleep,
    on_call: Callable[[dict], None] | None = None,
    allow_call: Callable[[], bool] | None = None,
) -> dict:
    usage = empty_usage()

    def record_call(reply: dict) -> None:
        add_usage(usage, reply.get("usage") or {})
        if on_call is not None:
            on_call(reply)

    def finish(spec, errors, attempts, first_errors, warnings=None):
        return {
            "status": "ok" if spec is not None else "failed",
            "spec": spec,
            "errors": [] if spec is not None else errors,
            "first_attempt_errors": first_errors,
            "warnings": warnings or [],
            "attempts": attempts,
            "usage": usage,
        }

    if allow_call is not None and not allow_call():
        return finish(None, ["budget exhausted before this criterion was compiled"], 0, [])
    spec, errors, text, fatal = attempt_once(c, compiler, client, None, sleep, record_call)
    if spec is not None:
        return finish(spec, [], 1, [], spec_warnings(c, spec))
    first = list(errors)
    if fatal:
        return finish(None, errors, 1, first)
    if allow_call is not None and not allow_call():
        return finish(None, errors + ["budget exhausted before the repair attempt"], 1, first)
    spec, errors, text, fatal = attempt_once(c, compiler, client, (text, first), sleep, record_call)
    if spec is not None:
        return finish(spec, [], 2, first, spec_warnings(c, spec))
    return finish(None, errors, 2, first)


def estimate_cost(cfg: ChecklistConfig) -> float:
    per = prices.cost(COMPILER_MODEL, ESTIMATE_INPUT_TOKENS, ESTIMATE_OUTPUT_TOKENS)
    return round(per * len(cfg.criteria), 6)


def assemble(cfg: ChecklistConfig, compiler: str, records: dict[str, dict], run_id: str | None = None) -> dict:
    total = empty_usage()
    for cid in (c.id for c in cfg.criteria):
        add_usage(total, records[cid]["usage"])
    ok = all(records[c.id]["status"] == "ok" for c in cfg.criteria)
    return {
        "version": FILE_VERSION,
        "checklist_hash": checklist_hash(cfg),
        "checklist_name": cfg.name,
        "compiler": compiler,
        "compiler_version": COMPILER_VERSIONS[compiler],
        "model": COMPILER_MODEL,
        "effort": COMPILER_EFFORT,
        "run_id": run_id,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "complete": ok,
        "needs_pause_marks": any(
            records[c.id]["spec"]["needs_pause_marks"] for c in cfg.criteria if records[c.id]["status"] == "ok"
        ),
        "usage": total,
        "criteria": {c.id: records[c.id] for c in cfg.criteria},
    }


def write_compiled(path: Path | str, data: dict, force: bool = False) -> None:
    path = Path(path)
    if path.exists() and not force:
        raise CompiledError(f"{path} already exists; pass --force to overwrite it")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".compiled-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def compile_checklist(
    cfg: ChecklistConfig,
    compiler: str,
    client: Any,
    ledger: Any = None,
    run_id: str | None = None,
    max_spend: float | None = None,
    concurrency: int = 4,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    run_id = run_id or f"compile-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{compiler}"
    lock = threading.Lock()
    spent = [0.0]

    def on_call(reply: dict) -> None:
        usage = reply.get("usage") or {}
        with lock:
            spent[0] += float(usage.get("cost") or 0)
            if ledger is not None and usage.get("calls"):
                ledger.append(
                    {
                        "run_id": run_id,
                        "kind": "compile",
                        "group": "compile",
                        "provider": "anthropic",
                        "model": reply.get("served") or COMPILER_MODEL,
                        "mode": "live",
                        "requests": 1,
                        "input_tokens": usage["input_tokens"],
                        "output_tokens": usage["output_tokens"],
                        "cache_read_tokens": usage["cache_read_tokens"],
                        "cache_write_tokens": usage["cache_write_tokens"],
                        "cost": usage["cost"],
                    }
                )

    def allow_call() -> bool:
        with lock:
            return max_spend is None or spent[0] < max_spend

    def work(c: Criterion) -> dict:
        return compile_criterion(c, compiler, client, sleep, on_call, allow_call)

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        futures = [(c.id, pool.submit(work, c)) for c in cfg.criteria]
        records = {cid: fut.result() for cid, fut in futures}
    return assemble(cfg, compiler, records, run_id)


def resolve_path(path: Path | str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else ROOT / p


def load_compiled(path: Path | str, cfg: ChecklistConfig) -> dict:
    p = resolve_path(path)
    if not p.exists():
        raise CompiledError(f"compiled file {p} does not exist; run `scripts/eval.py compile` first")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise CompiledError(f"compiled file {p} is not valid JSON: {exc}") from None
    if not isinstance(data, dict) or data.get("version") != FILE_VERSION or not isinstance(data.get("criteria"), dict):
        raise CompiledError(f"compiled file {p} has an unknown format")
    if data.get("checklist_hash") != checklist_hash(cfg):
        raise CompiledError(f"compiled file {p} was compiled for a different checklist (hash mismatch)")
    problems: list[str] = []
    specs: dict[str, dict] = {}
    for c in cfg.criteria:
        rec = data["criteria"].get(c.id)
        if not isinstance(rec, dict):
            problems.append(f"criterion {c.id}: missing from the compiled file")
            continue
        if rec.get("status") != "ok" or rec.get("spec") is None:
            problems.append(f"criterion {c.id}: compile failed ({'; '.join(map(str, rec.get('errors') or [])) or 'no spec'})")
            continue
        spec, errors = validate_spec(c, rec["spec"])
        if errors:
            problems.append(f"criterion {c.id}: stored spec is invalid ({'; '.join(errors)})")
            continue
        specs[c.id] = spec
    extra = sorted(set(data["criteria"]) - {c.id for c in cfg.criteria})
    if extra:
        problems.append(f"criteria not in the checklist: {extra}")
    if problems:
        raise CompiledError(f"compiled file {p} cannot be used: " + " | ".join(problems))
    return {
        "path": str(p),
        "compiler": data.get("compiler"),
        "compiler_version": data.get("compiler_version"),
        "specs": specs,
        "needs_pause_marks": any(s["needs_pause_marks"] for s in specs.values()),
    }
