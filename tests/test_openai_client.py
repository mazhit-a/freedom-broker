import builtins
import subprocess
import sys
from types import SimpleNamespace

import pytest

from backend.app.core.config import Settings
from backend.app.services import llm_client
from backend.app.services.llm_client import LLMClient, LLMError, get_llm_client
from backend.app.services.model_profiles import get_profile
from backend.app.services.openai_client import OpenAIClient, build_openai_sdk
from backend.app.services.openai_support import SCHEMA_NAME

SCHEMA = {
    "type": "object",
    "title": "x",
    "properties": {"a": {"type": "string", "description": "d"}, "b": {"anyOf": [{"type": "integer"}, {"type": "null"}]}},
    "required": ["a"],
}
MESSAGES = [{"role": "user", "content": "hello"}]
SECRET = "sk-test-secret-1234"


class StatusError(Exception):
    def __init__(self, status_code, message="boom"):
        super().__init__(message)
        self.status_code = status_code


class APITimeoutError(Exception):
    pass


def make_response(text='{"a": "x"}', model="gpt-6.1-sol", status="completed", input_tokens=1000, cached=400, output=300, reasoning=120, content=None, incomplete=None):
    if content is None:
        content = [SimpleNamespace(type="output_text", text=text)]
    return SimpleNamespace(
        model=model,
        status=status,
        incomplete_details=SimpleNamespace(reason=incomplete) if incomplete else None,
        output=[SimpleNamespace(type="message", content=content)],
        usage=SimpleNamespace(
            input_tokens=input_tokens,
            input_tokens_details=SimpleNamespace(cached_tokens=cached),
            output_tokens=output,
            output_tokens_details=SimpleNamespace(reasoning_tokens=reasoning),
        ),
    )


class FakeSDK:
    def __init__(self, *script):
        self.script = list(script)
        self.calls = []
        self.responses = SimpleNamespace(create=self.create)

    def create(self, **kwargs):
        self.calls.append(kwargs)
        item = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(item, BaseException):
            raise item
        return item


class ZeroRng:
    def uniform(self, a, b):
        return 0.0


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("OPENAI_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_EFFORT", "OPENAI_MAX_ATTEMPTS", "OPENAI_CALL_CEILING_S", "OPENAI_MAX_INFLIGHT", "OPENAI_MAX_OUTPUT_TOKENS"):
        monkeypatch.delenv(name, raising=False)


def settings(**kw):
    base = dict(llm_provider="openai", llm_model="gpt-6.1-sol", llm_effort="medium", openai_api_key="", openai_max_attempts=5, openai_call_ceiling_s=30.0)
    base.update(kw)
    return Settings(_env_file=None, **base)


def client(sdk, sleeps=None, **kw):
    sleeps = sleeps if sleeps is not None else []
    return OpenAIClient(sdk=sdk, settings=settings(**kw), sleep=sleeps.append, rng=ZeroRng())


def test_request_fields_exact():
    sdk = FakeSDK(make_response())
    client(sdk).complete("SYS", MESSAGES, SCHEMA)
    kwargs = sdk.calls[0]
    assert set(kwargs) == {"model", "instructions", "input", "max_output_tokens", "reasoning", "text", "store"}
    assert kwargs["model"] == "gpt-6.1-sol"
    assert kwargs["instructions"] == "SYS"
    assert kwargs["input"] == [{"role": "user", "content": "hello"}]
    assert kwargs["max_output_tokens"] == 32000
    fmt = kwargs["text"]["format"]
    assert fmt["type"] == "json_schema" and fmt["name"] == SCHEMA_NAME and fmt["strict"] is True
    assert fmt["schema"]["additionalProperties"] is False
    assert fmt["schema"]["required"] == ["a", "b"]
    assert fmt["schema"]["properties"]["b"]["type"] == ["integer", "null"]
    assert "title" not in fmt["schema"]
    assert "cache_control" not in repr(kwargs)


def test_effort_medium_no_temperature_store_false():
    sdk = FakeSDK(make_response())
    client(sdk).complete("SYS", MESSAGES, SCHEMA)
    kwargs = sdk.calls[0]
    assert kwargs["reasoning"] == {"effort": "medium"}
    assert "temperature" not in kwargs
    assert kwargs["store"] is False


def test_schema_input_not_mutated_and_problems_raise():
    sdk = FakeSDK(make_response())
    original = {"type": "object", "title": "x", "properties": {"a": {"type": "string"}}}
    snapshot = repr(original)
    client(sdk).complete("S", MESSAGES, original)
    assert repr(original) == snapshot
    with pytest.raises(LLMError, match=r"\$"):
        client(FakeSDK(make_response())).complete("S", MESSAGES, {"type": "array", "items": {"type": "string"}})


def test_success_maps_tokens_cost_and_meta():
    sdk = FakeSDK(make_response())
    result = client(sdk).complete("SYS", MESSAGES, SCHEMA)
    prof = get_profile("gpt-6.1-sol")
    assert result.text == '{"a": "x"}'
    assert result.stop_reason == "end_turn"
    assert result.input_tokens == 600
    assert result.cache_read_tokens == 400
    assert result.cache_write_tokens == 0
    assert result.output_tokens == 300
    assert result.structured is True
    assert result.model == "gpt-6.1-sol"
    expected = round((600 * prof.price_input + 300 * prof.price_output + 400 * prof.price_cache_read) / 1_000_000, 6)
    assert result.cost == expected
    assert result.meta["reasoning_tokens"] == 120
    assert result.meta["attempts"] == 1
    assert result.meta["served_model"] == "gpt-6.1-sol"
    assert result.meta["finish_reason"] == "completed"
    assert "total_ms" in result.meta


def test_429_then_200_retries():
    sleeps = []
    sdk = FakeSDK(StatusError(429), make_response())
    result = client(sdk, sleeps).complete("S", MESSAGES, SCHEMA)
    assert len(sdk.calls) == 2
    assert len(sleeps) == 1
    assert result.meta["attempts"] == 2
    assert result.text


def test_400_does_not_retry():
    sdk = FakeSDK(StatusError(400, "bad request"))
    sleeps = []
    with pytest.raises(LLMError, match="status 400"):
        client(sdk, sleeps).complete("S", MESSAGES, SCHEMA)
    assert len(sdk.calls) == 1
    assert sleeps == []


def test_five_503_raises_with_status_text_and_matches_throttle():
    from backend.app.services.batch import is_throttle_error

    sdk = FakeSDK(StatusError(503, "unavailable"))
    with pytest.raises(LLMError) as info:
        client(sdk).complete("S", MESSAGES, SCHEMA)
    assert "status 503" in str(info.value)
    assert is_throttle_error(str(info.value))
    assert len(sdk.calls) == 5


def test_timeout_names_retry():
    sdk = FakeSDK(APITimeoutError("timed out"), make_response())
    result = client(sdk).complete("S", MESSAGES, SCHEMA)
    assert len(sdk.calls) == 2
    assert result.meta["attempts"] == 2


def test_ceiling_exceeded_retries_then_raises():
    import threading

    release = threading.Event()

    class Slow:
        def __init__(self):
            self.calls = 0
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            self.calls += 1
            release.wait(5)
            return make_response()

    sdk = Slow()
    try:
        with pytest.raises(LLMError, match="ceiling"):
            client(sdk, openai_max_attempts=2, openai_call_ceiling_s=0.05).complete("S", MESSAGES, SCHEMA)
    finally:
        release.set()
    assert sdk.calls == 2


def test_refusal():
    resp = make_response(content=[SimpleNamespace(type="refusal", refusal="no")])
    result = client(FakeSDK(resp)).complete("S", MESSAGES, SCHEMA)
    assert result.stop_reason == "refusal"
    assert result.refused is True


def test_incomplete_max_output_tokens():
    resp = make_response(text='{"a":', status="incomplete", incomplete="max_output_tokens")
    result = client(FakeSDK(resp)).complete("S", MESSAGES, SCHEMA)
    assert result.stop_reason == "max_tokens"
    assert result.meta["finish_reason"] == "max_output_tokens"


def test_incomplete_other_reason_and_failed_status_raise():
    with pytest.raises(LLMError):
        client(FakeSDK(make_response(status="incomplete", incomplete="content_filter"))).complete("S", MESSAGES, SCHEMA)
    with pytest.raises(LLMError, match="failed"):
        client(FakeSDK(make_response(status="failed"))).complete("S", MESSAGES, SCHEMA)


def test_empty_text_raises():
    with pytest.raises(LLMError, match="no output text"):
        client(FakeSDK(make_response(text="  "))).complete("S", MESSAGES, SCHEMA)


def test_served_model_alias_accepted_and_other_rejected():
    result = client(FakeSDK(make_response(model="gpt-6.1-sol-2026-10-01"))).complete("S", MESSAGES, SCHEMA)
    assert result.model == "gpt-6.1-sol-2026-10-01"
    assert result.meta["served_model"] == "gpt-6.1-sol-2026-10-01"
    with pytest.raises(LLMError, match="does not match requested model"):
        client(FakeSDK(make_response(model="gpt-6.1-sol2"))).complete("S", MESSAGES, SCHEMA)
    with pytest.raises(LLMError, match="does not match requested model"):
        client(FakeSDK(make_response(model="gpt-5"))).complete("S", MESSAGES, SCHEMA)


def test_missing_key_message():
    with pytest.raises(LLMError, match="OPENAI_API_KEY is not set"):
        build_openai_sdk(settings(openai_api_key=""))


def test_error_text_never_contains_key():
    sdk = FakeSDK(StatusError(400, f"invalid key {SECRET} supplied"))
    with pytest.raises(LLMError) as info:
        client(sdk, openai_api_key=SECRET).complete("S", MESSAGES, SCHEMA)
    assert SECRET not in str(info.value)
    assert "[redacted]" in str(info.value)
    sdk = FakeSDK(StatusError(503, f"Bearer {SECRET}"))
    with pytest.raises(LLMError) as info:
        client(sdk, openai_api_key=SECRET, openai_max_attempts=2).complete("S", MESSAGES, SCHEMA)
    assert SECRET not in str(info.value)


def test_repair_turn_sends_three_items():
    sdk = FakeSDK(make_response())
    messages = [
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "fix it"},
    ]
    client(sdk).complete("S", messages, SCHEMA)
    items = sdk.calls[0]["input"]
    assert [i["role"] for i in items] == ["user", "assistant", "user"]
    assert [i["content"] for i in items] == ["u1", "a1", "fix it"]
    assert all(set(i) == {"role", "content"} for i in items)


def test_fake_sdk_client_never_imports_openai(monkeypatch):
    real_import = builtins.__import__

    def guard(name, *args, **kwargs):
        if name == "openai" or name.startswith("openai."):
            raise AssertionError("openai imported")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guard)
    result = client(FakeSDK(make_response())).complete("S", MESSAGES, SCHEMA)
    assert result.text


def test_module_import_does_not_import_openai():
    code = "import sys; import backend.app.services.openai_client; assert 'openai' not in sys.modules"
    subprocess.run([sys.executable, "-c", code], check=True, env={"PATH": "/usr/bin:/bin"}, cwd=str(__import__("pathlib").Path(__file__).parent.parent))


def test_factory_returns_class_per_provider(monkeypatch):
    for provider, cls in (("openai", OpenAIClient), ("anthropic", LLMClient), ("bedrock", LLMClient)):
        explicit = settings(llm_provider=provider, llm_model="gpt-6.1-sol" if provider == "openai" else "claude-opus-5-5")
        monkeypatch.setattr(llm_client, "get_settings", lambda s=explicit: s)
        made = get_llm_client()
        assert type(made) is cls
    monkeypatch.setattr(llm_client, "get_settings", lambda: settings())
    assert get_llm_client().model == "gpt-6.1-sol"


def test_llm_result_meta_defaults_to_empty_dict():
    a = llm_client.LLMResult(text="", stop_reason=None)
    b = llm_client.LLMResult(text="", stop_reason=None)
    assert a.meta == {} and a.meta is not b.meta
