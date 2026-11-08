import time
from dataclasses import dataclass, field
from typing import Any

from backend.app.core.config import Settings, get_settings
from backend.app.services.model_profiles import ModelProfile, profile_cost, profile_from_settings


class LLMError(RuntimeError):
    pass


@dataclass
class LLMResult:
    text: str
    stop_reason: str | None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    latency_ms: int = 0
    cost: float = 0.0
    structured: bool = False
    model: str = ""
    raw: Any = field(default=None, repr=False)
    meta: dict = field(default_factory=dict)

    @property
    def refused(self) -> bool:
        return self.stop_reason == "refusal"


def compute_cost(settings: Settings, input_tokens: int, output_tokens: int, cache_read: int, cache_write: int) -> float:
    total = (
        input_tokens * settings.llm_price_input
        + output_tokens * settings.llm_price_output
        + cache_read * settings.llm_price_cache_read
        + cache_write * settings.llm_price_cache_write
    )
    return round(total / 1_000_000, 6)


def build_sdk_client(settings: Settings):
    import anthropic

    if settings.llm_provider != "bedrock":
        return anthropic.Anthropic(api_key=settings.llm_api_key or None, base_url=settings.llm_base_url)
    kwargs: dict[str, Any] = {"aws_region": settings.aws_region}
    if settings.aws_access_key_id and settings.aws_secret_access_key:
        kwargs["aws_access_key"] = settings.aws_access_key_id
        kwargs["aws_secret_key"] = settings.aws_secret_access_key
        if settings.aws_session_token:
            kwargs["aws_session_token"] = settings.aws_session_token
    return anthropic.AnthropicBedrockMantle(**kwargs)


class LLMClient:
    def __init__(self, sdk=None, settings: Settings | None = None, profile: ModelProfile | None = None):
        self.settings = settings or get_settings()
        self.explicit_profile = profile is not None
        self.profile = profile or profile_from_settings(self.settings)
        self._sdk = sdk
        self.structured_enabled = self.settings.llm_structured_outputs
        self.structured_fallback_reason: str | None = None

    @property
    def sdk(self):
        if self._sdk is None:
            self._sdk = build_sdk_client(self.settings)
        return self._sdk

    @property
    def model(self) -> str:
        return self.profile.model

    def _request(self, system_text: str, messages: list[dict], schema: dict | None) -> dict:
        output_config: dict[str, Any] = {}
        if self.profile.supports_effort and self.profile.effort is not None:
            output_config["effort"] = self.profile.effort
        if schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": schema}
        kwargs: dict[str, Any] = {
            "model": self.profile.model,
            "max_tokens": self.profile.max_tokens,
            "system": [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}],
            "messages": messages,
        }
        if output_config:
            kwargs["output_config"] = output_config
        if self.profile.thinking_budget:
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": self.profile.thinking_budget}
        return kwargs

    def _send(self, kwargs: dict) -> Any:
        try:
            return self.sdk.messages.create(**kwargs)
        except Exception as exc:
            raise LLMError(f"{type(exc).__name__}: {exc}") from exc

    def complete(self, system_text: str, messages: list[dict], schema: dict | None = None) -> LLMResult:
        use_schema = schema if self.structured_enabled else None
        started = time.perf_counter()
        try:
            response = self._send(self._request(system_text, messages, use_schema))
        except LLMError as err:
            cause = err.__cause__
            status = getattr(cause, "status_code", None)
            if use_schema is not None and status in (400, 404, 422):
                self.structured_enabled = False
                self.structured_fallback_reason = str(err)[:300]
                use_schema = None
                response = self._send(self._request(system_text, messages, None))
            else:
                raise
        latency_ms = int((time.perf_counter() - started) * 1000)
        usage = getattr(response, "usage", None)

        def tok(name: str) -> int:
            return int(getattr(usage, name, 0) or 0)

        text = "".join(
            getattr(b, "text", "") or "" for b in (getattr(response, "content", None) or []) if getattr(b, "type", "text") == "text"
        )
        inp, out = tok("input_tokens"), tok("output_tokens")
        cr, cw = tok("cache_read_input_tokens"), tok("cache_creation_input_tokens")
        served = getattr(response, "model", None)
        served = served if isinstance(served, str) and served else self.profile.model
        if self.explicit_profile and served != self.profile.model and not served.startswith(self.profile.model + "-"):
            raise LLMError(f"served model {served!r} does not match requested model {self.profile.model!r}")
        return LLMResult(
            text=text,
            stop_reason=getattr(response, "stop_reason", None),
            input_tokens=inp,
            output_tokens=out,
            cache_read_tokens=cr,
            cache_write_tokens=cw,
            latency_ms=latency_ms,
            cost=profile_cost(self.profile, inp, out, cr, cw),
            structured=use_schema is not None,
            model=served,
            raw=response,
        )


def get_llm_client():
    settings = get_settings()
    if settings.llm_provider == "openai":
        from backend.app.services.openai_client import OpenAIClient

        return OpenAIClient(settings=settings)
    return LLMClient()
