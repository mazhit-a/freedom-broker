import copy
import json
import math
import os
import random
import re
import threading
import time
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

from evals import prices

DEFAULT_MODEL = "gpt-6.1-sol"
MODEL_ENV = "OPENAI_GEN_MODEL"
KEY_ENV = "OPENAI_API_KEY"
DOTENV_PATH = Path(__file__).resolve().parents[2] / ".env"

EFFORTS = ("low", "medium", "high", "xhigh", "max")
DEFAULT_EFFORT = "medium"
DEFAULT_MAX_OUTPUT_TOKENS = 32000
DEFAULT_CONCURRENCY = 3
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_CEILING_SECONDS = 900.0
SCHEMA_NAME = "eval_case"

ASSUMED_INPUT_TOKENS = 3000
ASSUMED_OUTPUT_TOKENS = 6000
CHARS_PER_TOKEN = 2.5

UNSUPPORTED_KEYWORDS = (
    "default",
    "examples",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "$schema",
    "title",
    "description",
)
COMPOSITE_KEYWORDS = ("oneOf", "allOf", "not", "if", "then", "else", "patternProperties")

TIMEOUT_NAMES = {"APITimeoutError", "APIConnectionError", "Timeout", "TimeoutError", "ReadTimeout", "ConnectTimeout", "ConnectError"}
KEY_PATTERN = re.compile(r"sk-[A-Za-z0-9_\-]{8,}|Bearer\s+\S+")


class CeilingExceeded(Exception):
    pass


class BudgetRefused(Exception):
    pass


def _read_dotenv_value(name: str, dotenv_path: Path | None) -> str | None:
    path = dotenv_path or DOTENV_PATH
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        if key.strip() == name:
            raw = raw.strip().strip('"').strip("'")
            if raw.startswith(name + "="):
                raw = raw[len(name) + 1 :].strip()
            return raw or None
    return None


def load_setting(name: str, env: dict | None = None, dotenv_path: Path | None = None) -> str | None:
    source = os.environ if env is None else env
    value = source.get(name)
    if value and value.strip():
        return value.strip()
    return _read_dotenv_value(name, dotenv_path)


def load_api_key(env: dict | None = None, dotenv_path: Path | None = None) -> str | None:
    return load_setting(KEY_ENV, env, dotenv_path)


def default_model(env: dict | None = None, dotenv_path: Path | None = None) -> str:
    return load_setting(MODEL_ENV, env, dotenv_path) or DEFAULT_MODEL


def make_client(api_key: str, timeout: float = DEFAULT_CEILING_SECONDS):
    import openai

    return openai.OpenAI(api_key=api_key, max_retries=0, timeout=timeout)


def make_default_client(timeout: float = DEFAULT_CEILING_SECONDS, env: dict | None = None, dotenv_path: Path | None = None):
    key = load_api_key(env, dotenv_path)
    if not key:
        return None, []
    return make_client(key, timeout), [key]


def redact(text: str, secrets: list[str] | None = None) -> str:
    out = str(text)
    for s in secrets or []:
        if s:
            out = out.replace(s, "[redacted]")
    return KEY_PATTERN.sub("[redacted]", out)


def _is_null(node) -> bool:
    return isinstance(node, dict) and node.get("type") == "null"


def convert_schema(node):
    if isinstance(node, list):
        return [convert_schema(x) for x in node]
    if not isinstance(node, dict):
        return node
    options = node.get("anyOf")
    if isinstance(options, list) and len(options) == 2 and sum(1 for o in options if _is_null(o)) == 1:
        inner = convert_schema(next(o for o in options if not _is_null(o)))
        inner_type = inner.get("type")
        if isinstance(inner_type, str):
            inner["type"] = [inner_type, "null"]
        elif isinstance(inner_type, list) and "null" not in inner_type:
            inner["type"] = inner_type + ["null"]
        if isinstance(inner.get("enum"), list) and None not in inner["enum"]:
            inner["enum"] = inner["enum"] + [None]
        return inner
    out = {}
    for key, value in node.items():
        if key in UNSUPPORTED_KEYWORDS:
            continue
        if key == "properties" and isinstance(value, dict):
            out[key] = {name: convert_schema(sub) for name, sub in value.items()}
        elif key in ("$defs", "definitions") and isinstance(value, dict):
            out[key] = {name: convert_schema(sub) for name, sub in value.items()}
        elif key in ("items", "anyOf"):
            out[key] = convert_schema(value)
        else:
            out[key] = value
    if out.get("type") == "object" or "properties" in out:
        props = out.get("properties") or {}
        out["properties"] = props
        out["required"] = list(props)
        out["additionalProperties"] = False
    return out


def strict_problems(node, path: str = "$", root: bool = True) -> list[str]:
    problems: list[str] = []
    if isinstance(node, list):
        for i, sub in enumerate(node):
            problems.extend(strict_problems(sub, f"{path}[{i}]", False))
        return problems
    if not isinstance(node, dict):
        return problems
    if root and node.get("type") != "object":
        problems.append(f"{path}: root must be an object")
    if root and "anyOf" in node:
        problems.append(f"{path}: root must not use anyOf")
    for key in UNSUPPORTED_KEYWORDS:
        if key in node and key not in ("title", "description", "$schema"):
            problems.append(f"{path}: unsupported keyword {key}")
    for key in COMPOSITE_KEYWORDS:
        if key in node:
            problems.append(f"{path}: unsupported keyword {key}")
    if node.get("type") == "object" or (isinstance(node.get("type"), list) and "object" in node["type"]):
        props = node.get("properties")
        if not isinstance(props, dict):
            problems.append(f"{path}: object without properties")
            props = {}
        if node.get("additionalProperties") is not False:
            problems.append(f"{path}: additionalProperties must be false")
        if sorted(node.get("required") or []) != sorted(props):
            problems.append(f"{path}: every property must be required")
    for key, value in node.items():
        if key == "properties" and isinstance(value, dict):
            for name, sub in value.items():
                problems.extend(strict_problems(sub, f"{path}.{name}", False))
        elif key in ("items", "anyOf"):
            problems.extend(strict_problems(value, f"{path}.{key}", False))
        elif key in ("$defs", "definitions") and isinstance(value, dict):
            for name, sub in value.items():
                problems.extend(strict_problems(sub, f"{path}.{key}.{name}", False))
    return problems


def _system_text(system) -> str:
    if isinstance(system, str):
        return system
    return "\n\n".join(b.get("text", "") for b in system or [] if b.get("type") == "text")


def _user_text(messages) -> str:
    parts = []
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            parts.append(content)
        else:
            parts.extend(b.get("text", "") for b in content or [] if b.get("type") == "text")
    return "\n\n".join(parts)


def to_openai_request(
    request: dict,
    model: str | None = None,
    effort: str = DEFAULT_EFFORT,
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
    name: str = SCHEMA_NAME,
) -> dict:
    if effort not in EFFORTS:
        raise ValueError(f"effort must be one of {EFFORTS}")
    schema = convert_schema(copy.deepcopy(request["output_config"]["format"]["schema"]))
    problems = strict_problems(schema)
    if problems:
        raise ValueError("schema is not strict compatible: " + "; ".join(problems))
    return {
        "model": model or default_model(),
        "instructions": _system_text(request.get("system")),
        "input": [{"role": "user", "content": _user_text(request["messages"])}],
        "max_output_tokens": max_output_tokens,
        "reasoning": {"effort": effort},
        "text": {"format": {"type": "json_schema", "name": name, "schema": schema, "strict": True}},
        "store": False,
    }


def estimate_input_tokens(request: dict) -> int:
    chars = len(request.get("instructions") or "") + len(json.dumps(request.get("input"), ensure_ascii=False))
    return max(ASSUMED_INPUT_TOKENS, math.ceil(chars / CHARS_PER_TOKEN))


def _get(obj, name, default=None):
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def extract_usage(response) -> dict:
    usage = _get(response, "usage")
    return {
        "input_tokens": int(_get(usage, "input_tokens", 0) or 0),
        "cached_input_tokens": int(_get(_get(usage, "input_tokens_details"), "cached_tokens", 0) or 0),
        "output_tokens": int(_get(usage, "output_tokens", 0) or 0),
        "reasoning_tokens": int(_get(_get(usage, "output_tokens_details"), "reasoning_tokens", 0) or 0),
    }


def usage_cost(model: str, usage: dict, fallback_model: str | None = None) -> float | None:
    cached = usage["cached_input_tokens"]
    for name in (model, fallback_model):
        if not name:
            continue
        try:
            return prices.cost(
                name,
                input_tokens=max(0, usage["input_tokens"] - cached),
                output_tokens=usage["output_tokens"],
                cache_read_tokens=cached,
            )
        except prices.UnknownModel:
            continue
    return None


def map_response(response, custom_id: str, requested_model: str, latency: float, attempts: int, total: float | None = None) -> dict:
    usage = extract_usage(response)
    served = _get(response, "model") or requested_model
    row = {
        "custom_id": custom_id,
        "status": "ok",
        "text": None,
        "error": None,
        "model": served,
        "served_model_reported": bool(_get(response, "model")),
        "requested_model": requested_model,
        "usage": usage,
        "cost_usd": usage_cost(served, usage, requested_model),
        "latency_s": round(latency, 3),
        "total_s": round(total if total is not None else latency, 3),
        "attempts": attempts,
    }
    texts: list[str] = []
    refusals: list[str] = []
    for item in _get(response, "output") or []:
        if _get(item, "type") != "message":
            continue
        for part in _get(item, "content") or []:
            kind = _get(part, "type")
            if kind == "output_text":
                texts.append(_get(part, "text") or "")
            elif kind == "refusal":
                refusals.append(_get(part, "refusal") or "")
    state = _get(response, "status")
    if refusals:
        row["status"] = "refusal"
        row["error"] = "model refused: " + " ".join(refusals)[:300]
    elif state == "incomplete":
        reason = _get(_get(response, "incomplete_details"), "reason") or "unknown"
        row["status"] = "truncated" if reason == "max_output_tokens" else "incomplete"
        row["error"] = f"response incomplete: {reason}"
    elif state not in (None, "completed"):
        detail = _get(_get(response, "error"), "message") or ""
        row["status"] = "error"
        row["error"] = f"response status {state} {detail}".strip()[:300]
    elif not "".join(texts).strip():
        row["status"] = "empty"
        row["error"] = "response has no output text"
    else:
        row["text"] = "".join(texts)
    return row


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, CeilingExceeded):
        return True
    code = getattr(exc, "status_code", None)
    if isinstance(code, int):
        return code in (408, 409, 429) or code >= 500
    return type(exc).__name__ in TIMEOUT_NAMES


def describe_error(exc: BaseException, secrets: list[str] | None = None) -> str:
    code = getattr(exc, "status_code", None)
    head = type(exc).__name__ + (f" status {code}" if code else "")
    return redact(f"{head}: {str(exc)[:300]}", secrets)


def call_with_ceiling(fn, ceiling: float):
    box: dict = {}
    done = threading.Event()

    def target():
        try:
            box["value"] = fn()
        except BaseException as exc:
            box["error"] = exc
        finally:
            done.set()

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    if not done.wait(ceiling):
        raise CeilingExceeded(f"call exceeded the {ceiling:g}s wall-clock ceiling")
    if "error" in box:
        raise box["error"]
    return box["value"]


def backoff_delay(attempt: int, rng, base: float = 2.0, cap: float = 60.0) -> float:
    return rng.uniform(0, min(cap, base * (2 ** (attempt - 1))))


class SpendGuard:
    def __init__(self, max_spend: float, model: str, max_output_tokens: int, input_tokens: int = ASSUMED_INPUT_TOKENS):
        self.max_spend = max_spend
        self.model = model
        self.max_output_tokens = max_output_tokens
        self.input_tokens = input_tokens
        self.spent = 0.0
        self.costs: list[float] = []

    def worst_case_call(self) -> float:
        return prices.cost(self.model, input_tokens=self.input_tokens, output_tokens=self.max_output_tokens)

    def default_estimate(self) -> float:
        return prices.cost(self.model, input_tokens=max(self.input_tokens, ASSUMED_INPUT_TOKENS), output_tokens=ASSUMED_OUTPUT_TOKENS)

    def estimate(self) -> float:
        if self.costs:
            return sum(self.costs) / len(self.costs)
        return self.default_estimate()

    def check_start(self) -> None:
        worst = self.worst_case_call()
        if worst > self.max_spend:
            raise BudgetRefused(
                f"the first call could cost up to ${worst:.4f} (input estimate plus {self.max_output_tokens} output tokens), which exceeds --max-spend ${self.max_spend:.4f}"
            )

    def record(self, cost: float | None) -> None:
        if cost is None:
            return
        self.spent += cost
        self.costs.append(cost)

    def permit(self, inflight: int) -> bool:
        if not self.costs:
            return inflight == 0 and self.worst_case_call() <= self.max_spend - self.spent
        return self.spent + (inflight + 1) * self.estimate() <= self.max_spend


def run_one(client, item: dict, ceiling: float, max_attempts: int, sleep, rng, clock, secrets: list[str]) -> dict:
    custom_id = item["custom_id"]
    request = item["request"]
    requested = request["model"]
    started = clock()
    attempts = 0
    while True:
        attempts += 1
        t0 = clock()
        try:
            response = call_with_ceiling(lambda: client.responses.create(**request, timeout=ceiling), ceiling)
        except BaseException as exc:
            if not isinstance(exc, Exception):
                raise
            if is_retryable(exc) and attempts < max_attempts:
                sleep(backoff_delay(attempts, rng))
                continue
            now = clock()
            return {
                "custom_id": custom_id,
                "status": "timeout" if isinstance(exc, CeilingExceeded) or type(exc).__name__ in TIMEOUT_NAMES else "error",
                "text": None,
                "error": describe_error(exc, secrets),
                "model": None,
                "requested_model": requested,
                "usage": {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0},
                "cost_usd": 0.0,
                "latency_s": round(now - t0, 3),
                "total_s": round(now - started, 3),
                "attempts": attempts,
            }
        now = clock()
        row = map_response(response, custom_id, requested, now - t0, attempts, now - started)
        if row["error"]:
            row["error"] = redact(row["error"], secrets)
        return row


def run_requests(
    client,
    items: list[dict],
    guard: SpendGuard | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    ceiling: float = DEFAULT_CEILING_SECONDS,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    on_result=None,
    sleep=time.sleep,
    rng=None,
    clock=time.monotonic,
    secrets: list[str] | None = None,
) -> tuple[list[dict], list[str]]:
    rng = rng or random.Random()
    secrets = secrets or []
    pending = deque(items)
    rows: list[dict] = []
    inflight: dict = {}
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        while pending or inflight:
            while pending and len(inflight) < max(1, concurrency):
                if guard is not None and not guard.permit(len(inflight)):
                    break
                item = pending.popleft()
                future = pool.submit(run_one, client, item, ceiling, max_attempts, sleep, rng, clock, secrets)
                inflight[future] = item["custom_id"]
            if not inflight:
                break
            done, _ = wait(list(inflight), return_when=FIRST_COMPLETED)
            for future in done:
                inflight.pop(future)
                row = future.result()
                if guard is not None and row["usage"]["input_tokens"]:
                    guard.record(row.get("cost_usd"))
                rows.append(row)
                if on_result:
                    on_result(row)
    return rows, [i["custom_id"] for i in pending]
