import copy
import json
import math
import os
import random
import time
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

from backend.app.services.openai_support import (
    COMPOSITE_KEYWORDS,
    EFFORTS,
    KEY_PATTERN,
    SCHEMA_NAME,
    TIMEOUT_NAMES,
    UNSUPPORTED_KEYWORDS,
    CeilingExceeded,
    backoff_delay,
    call_with_ceiling,
    convert_schema,
    describe_error,
    extract_usage,
    is_retryable,
    map_response_row,
    redact,
    strict_problems,
)
from evals import prices

__all__ = [
    "COMPOSITE_KEYWORDS",
    "EFFORTS",
    "KEY_PATTERN",
    "SCHEMA_NAME",
    "TIMEOUT_NAMES",
    "UNSUPPORTED_KEYWORDS",
    "CeilingExceeded",
    "backoff_delay",
    "call_with_ceiling",
    "convert_schema",
    "describe_error",
    "extract_usage",
    "is_retryable",
    "redact",
    "strict_problems",
]

DEFAULT_MODEL = "gpt-6.1-sol"
MODEL_ENV = "OPENAI_GEN_MODEL"
KEY_ENV = "OPENAI_API_KEY"
DOTENV_PATH = Path(__file__).resolve().parents[2] / ".env"

DEFAULT_EFFORT = "medium"
DEFAULT_MAX_OUTPUT_TOKENS = 32000
DEFAULT_CONCURRENCY = 3
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_CEILING_SECONDS = 900.0

ASSUMED_INPUT_TOKENS = 3000
ASSUMED_OUTPUT_TOKENS = 6000
CHARS_PER_TOKEN = 2.5


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
    row = map_response_row(response, custom_id, requested_model, latency, attempts, total)
    row["cost_usd"] = usage_cost(row["model"], row["usage"], requested_model)
    return row


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
