import re
import threading

EFFORTS = ("low", "medium", "high", "xhigh", "max")
SCHEMA_NAME = "eval_case"

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


def map_response_row(response, custom_id: str, requested_model: str, latency: float, attempts: int, total: float | None = None) -> dict:
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


def is_fatal(exc: BaseException) -> bool:
    from backend.app.services.llm_client import is_quota_text

    code = getattr(exc, "status_code", None)
    if code in (401, 403):
        return True
    if code != 429:
        return False
    parts = [str(exc), str(getattr(exc, "code", "") or ""), str(getattr(exc, "body", "") or "")]
    text = " ".join(parts)
    return is_quota_text(text) or "billing" in text.lower()


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
