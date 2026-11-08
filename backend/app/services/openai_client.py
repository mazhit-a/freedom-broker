import copy
import random
import threading
import time
from typing import Any

from backend.app.core.config import Settings, get_settings
from backend.app.services.llm_client import LLMError, LLMResult
from backend.app.services.model_profiles import ModelProfile, profile_cost, profile_from_settings
from backend.app.services.openai_support import (
    SCHEMA_NAME,
    backoff_delay,
    call_with_ceiling,
    convert_schema,
    describe_error,
    is_retryable,
    map_response_row,
    redact,
    strict_problems,
)

_gate_lock = threading.Lock()
_gate: tuple[int, threading.BoundedSemaphore] | None = None


def _inflight_gate(size: int) -> threading.BoundedSemaphore:
    global _gate
    size = max(1, int(size))
    with _gate_lock:
        if _gate is None or _gate[0] != size:
            _gate = (size, threading.BoundedSemaphore(size))
        return _gate[1]


def build_openai_sdk(settings: Settings):
    key = settings.openai_api_key
    if not key:
        raise LLMError("OPENAI_API_KEY is not set")
    import openai

    return openai.OpenAI(api_key=key, max_retries=0, timeout=settings.openai_call_ceiling_s)


class OpenAIClient:
    def __init__(self, sdk=None, settings: Settings | None = None, profile: ModelProfile | None = None, sleep=time.sleep, rng=None):
        self.settings = settings or get_settings()
        self.profile = profile or profile_from_settings(self.settings)
        self._sdk = sdk
        self.structured_enabled = True
        self.structured_fallback_reason: str | None = None
        self._sleep = sleep
        self._rng = rng or random.Random()

    @property
    def sdk(self):
        if self._sdk is None:
            self._sdk = build_openai_sdk(self.settings)
        return self._sdk

    @property
    def model(self) -> str:
        return self.profile.model

    def _strict_schema(self, schema: dict) -> dict:
        strict = convert_schema(copy.deepcopy(schema))
        problems = strict_problems(strict)
        if problems:
            raise LLMError("schema is not strict compatible: " + "; ".join(problems))
        return strict

    def _request(self, system_text: str, messages: list[dict], schema: dict) -> dict:
        return {
            "model": self.profile.model,
            "instructions": system_text,
            "input": [{"role": m["role"], "content": m["content"]} for m in messages],
            "max_output_tokens": self.profile.max_tokens,
            "reasoning": {"effort": self.profile.effort},
            "text": {"format": {"type": "json_schema", "name": SCHEMA_NAME, "schema": self._strict_schema(schema), "strict": True}},
            "store": False,
        }

    def _call(self, kwargs: dict) -> tuple[Any, int, float, float]:
        key = self.settings.openai_api_key
        attempts_max = max(1, int(self.settings.openai_max_attempts))
        ceiling = self.settings.openai_call_ceiling_s
        gate = _inflight_gate(self.settings.openai_max_inflight)
        started = time.perf_counter()
        last: BaseException | None = None
        for attempt in range(1, attempts_max + 1):
            call_started = time.perf_counter()
            try:
                with gate:
                    response = call_with_ceiling(lambda: self.sdk.responses.create(**kwargs), ceiling)
                return response, attempt, time.perf_counter() - call_started, time.perf_counter() - started
            except LLMError:
                raise
            except Exception as exc:
                last = exc
                if not is_retryable(exc):
                    raise LLMError(describe_error(exc, [key])) from None
                if attempt < attempts_max:
                    self._sleep(backoff_delay(attempt, self._rng))
        raise LLMError(f"gave up after {attempts_max} attempts: {describe_error(last, [key])}") from None

    def complete(self, system_text: str, messages: list[dict], schema: dict | None = None) -> LLMResult:
        if schema is None:
            raise LLMError("OpenAI client requires a schema")
        kwargs = self._request(system_text, messages, schema)
        response, attempts, latency, total = self._call(kwargs)
        requested = self.profile.model
        row = map_response_row(response, "call", requested, latency, attempts, total)
        served = row["model"] if isinstance(row["model"], str) and row["model"] else requested
        if served != requested and not served.startswith(requested + "-"):
            raise LLMError(f"served model {served!r} does not match requested model {requested!r}")
        usage = row["usage"]
        cached = usage["cached_input_tokens"]
        tokens_in = max(usage["input_tokens"] - cached, 0)
        tokens_out = usage["output_tokens"]
        details = getattr(response, "incomplete_details", None)
        if isinstance(response, dict):
            details = response.get("incomplete_details")
        reason = details.get("reason") if isinstance(details, dict) else getattr(details, "reason", None)
        status = row["status"]
        finish = reason if status in ("truncated", "incomplete") else getattr(response, "status", None) if not isinstance(response, dict) else response.get("status")
        if status == "refusal":
            stop, text = "refusal", ""
        elif status == "truncated" or (status == "incomplete" and reason == "length"):
            stop, text = "max_tokens", row["text"] or ""
        elif status == "ok":
            stop, text = "end_turn", row["text"]
        else:
            raise LLMError(redact(row["error"] or f"response {status}", [self.settings.openai_api_key]))
        return LLMResult(
            text=text,
            stop_reason=stop,
            input_tokens=tokens_in,
            output_tokens=tokens_out,
            cache_read_tokens=cached,
            cache_write_tokens=0,
            latency_ms=int(latency * 1000),
            cost=profile_cost(self.profile, tokens_in, tokens_out, cached, 0),
            structured=True,
            model=served,
            raw=response,
            meta={
                "attempts": attempts,
                "total_ms": int(total * 1000),
                "reasoning_tokens": usage["reasoning_tokens"],
                "served_model": served,
                "finish_reason": finish,
            },
        )
