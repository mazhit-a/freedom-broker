import json

import pytest

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services import batch, checklist as checklist_service
from backend.app.services.llm_client import LLMClient, LLMError, LLMFatalError
from backend.app.services.openai_client import OpenAIClient, build_openai_sdk
from tests.test_batch import add_dataset
from tests.test_evaluator import FakeSDK, StatusError, version_id
from tests.test_openai_resilience import FakeOpenAI, GOOD, SECRET, make_settings, response

SCHEMA = {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"], "additionalProperties": False}
QUOTA_TEXT = "You exceeded your current quota. You have no credits remaining."

ENV_NAMES = (
    "OPENAI_API_KEY",
    "OPENAI_MAX_INFLIGHT",
    "OPENAI_MAX_ATTEMPTS",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_EFFORT",
    "LLM_API_KEY",
    "LLM_PROMPT_VERSION",
    "LLM_STRUCTURED_OUTPUTS",
    "CQA_BATCH_CONCURRENCY",
    "AWS_REGION",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "f.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    batch.reset_jobs()
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    yield conn
    conn.close()
    config.get_settings.cache_clear()


def openai_client(sdk, **overrides):
    return OpenAIClient(sdk=sdk, settings=make_settings(**overrides), sleep=lambda s: None)


def anthropic_settings(**overrides):
    return config.Settings(_env_file=None, llm_provider="anthropic", llm_model="claude-opus-5-5", llm_api_key="invalid-key-do-not-call", **overrides)


def test_insufficient_quota_429_is_fatal_and_not_retried():
    sdk = FakeOpenAI(default=StatusError(429, f"{QUOTA_TEXT} key {SECRET}"))
    client = openai_client(sdk, openai_max_attempts=5)
    with pytest.raises(LLMFatalError) as info:
        client.complete("sys", [{"role": "user", "content": "x"}], SCHEMA)
    assert sdk.calls == 1
    assert "429" in str(info.value)
    assert SECRET not in str(info.value)


def test_insufficient_quota_code_attribute_is_fatal():
    exc = StatusError(429, "Request failed")
    exc.code = "insufficient_quota"
    sdk = FakeOpenAI(default=exc)
    with pytest.raises(LLMFatalError):
        openai_client(sdk, openai_max_attempts=5).complete("sys", [{"role": "user", "content": "x"}], SCHEMA)
    assert sdk.calls == 1


def test_ordinary_429_is_still_retried_and_not_fatal():
    sdk = FakeOpenAI(default=StatusError(429, "Too many requests"))
    with pytest.raises(LLMError) as info:
        openai_client(sdk, openai_max_attempts=3).complete("sys", [{"role": "user", "content": "x"}], SCHEMA)
    assert not isinstance(info.value, LLMFatalError)
    assert sdk.calls == 3
    assert "gave up after 3 attempts" in str(info.value)


def test_5xx_is_still_retried_and_not_fatal():
    sdk = FakeOpenAI(default=StatusError(503, "unavailable"))
    with pytest.raises(LLMError) as info:
        openai_client(sdk, openai_max_attempts=2).complete("sys", [{"role": "user", "content": "x"}], SCHEMA)
    assert not isinstance(info.value, LLMFatalError)
    assert sdk.calls == 2


@pytest.mark.parametrize("code", [401, 403])
def test_openai_auth_errors_are_fatal_and_redacted(code):
    sdk = FakeOpenAI(default=StatusError(code, f"Incorrect API key provided: {SECRET}"))
    with pytest.raises(LLMFatalError) as info:
        openai_client(sdk, openai_max_attempts=5).complete("sys", [{"role": "user", "content": "x"}], SCHEMA)
    assert sdk.calls == 1
    assert f"status {code}" in str(info.value)
    assert SECRET not in str(info.value)


def test_other_4xx_is_a_plain_non_retried_error():
    sdk = FakeOpenAI(default=StatusError(400, "bad request"))
    with pytest.raises(LLMError) as info:
        openai_client(sdk, openai_max_attempts=5).complete("sys", [{"role": "user", "content": "x"}], SCHEMA)
    assert not isinstance(info.value, LLMFatalError)
    assert sdk.calls == 1


def test_missing_key_is_fatal():
    with pytest.raises(LLMFatalError, match="OPENAI_API_KEY is not set"):
        build_openai_sdk(make_settings(openai_api_key=""))


def test_served_model_mismatch_is_fatal():
    sdk = FakeOpenAI(default=response(model="gpt-other"))
    with pytest.raises(LLMFatalError, match="does not match"):
        openai_client(sdk).complete("sys", [{"role": "user", "content": "x"}], SCHEMA)


def test_non_strict_schema_is_fatal():
    sdk = FakeOpenAI()
    bad = {"type": "object", "properties": {"a": {"oneOf": [{"type": "string"}, {"type": "integer"}]}}, "required": ["a"]}
    with pytest.raises(LLMFatalError, match="strict"):
        openai_client(sdk).complete("sys", [{"role": "user", "content": "x"}], bad)
    assert sdk.calls == 0


def test_anthropic_credit_balance_is_fatal_without_structured_fallback():
    sdk = FakeSDK([StatusError(400, "Your credit balance is too low to access the Anthropic API"), "{}"])
    client = LLMClient(sdk=sdk, settings=anthropic_settings(llm_structured_outputs=True))
    with pytest.raises(LLMFatalError, match="credit balance is too low"):
        client.complete("sys", [{"role": "user", "content": "x"}], SCHEMA)
    assert len(sdk.calls) == 1


@pytest.mark.parametrize("code", [401, 403])
def test_anthropic_auth_errors_are_fatal(code):
    sdk = FakeSDK([StatusError(code, "invalid x-api-key")])
    client = LLMClient(sdk=sdk, settings=anthropic_settings())
    with pytest.raises(LLMFatalError):
        client.complete("sys", [{"role": "user", "content": "x"}], None)


@pytest.mark.parametrize("code,text", [(400, "bad request"), (429, "rate limited"), (500, "boom"), (529, "overloaded")])
def test_anthropic_other_errors_are_not_fatal(code, text):
    sdk = FakeSDK([StatusError(code, text)])
    client = LLMClient(sdk=sdk, settings=anthropic_settings(llm_structured_outputs=False))
    with pytest.raises(LLMError) as info:
        client.complete("sys", [{"role": "user", "content": "x"}], None)
    assert not isinstance(info.value, LLMFatalError)


@pytest.mark.parametrize(
    "message,expected",
    [
        ("RateLimitError status 429: Too many requests", True),
        ("rate_limit_exceeded", True),
        ("overloaded_error 529", True),
        ("ServiceUnavailable 503", True),
        ("gave up after 5 attempts: RateLimitError status 429: You have no credits remaining", False),
        ("RateLimitError status 429: insufficient_quota", False),
        ("429 You exceeded your current quota, please check your plan", False),
        ("BadRequestError 400: Your credit balance is too low", False),
        ("RuntimeError: boom", False),
        ("", False),
        (None, False),
    ],
)
def test_is_throttle_error_table(message, expected):
    assert batch.is_throttle_error(message) is expected


def run_fatal(env, sdk, n=20, concurrency=3, settings=None):
    add_dataset(env, "FX", n)
    client = openai_client(sdk, openai_max_inflight=concurrency) if settings is None else settings
    return batch.run_job_sync(env, "FX", version_id(env), client, concurrency=concurrency, sleep=lambda s: None)


def test_batch_aborts_on_fatal_error_and_cancels_the_rest(env):
    sdk = FakeOpenAI(default=StatusError(429, f"{QUOTA_TEXT} {SECRET}"), delay=0.05)
    snap = run_fatal(env, sdk)
    assert snap["status"] == "failed"
    assert snap["throttled_retries"] == 0
    assert 1 <= snap["failed"] <= 3
    assert snap["failed"] + snap["cancelled"] == 20
    assert sdk.calls == snap["failed"]
    assert snap["processed"] == 20
    row = env.execute("SELECT status, error, throttled_retries, finished_at FROM eval_run").fetchone()
    assert row["status"] == "failed" and row["finished_at"]
    assert row["error"] == "OpenAI: нет кредитов на аккаунте или неверный ключ, прогон остановлен"
    assert row["throttled_retries"] == 0
    statuses = [r["status"] for r in env.execute("SELECT status FROM eval_run_item ORDER BY id").fetchall()]
    assert statuses.count("failed") == snap["failed"] and statuses.count("cancelled") == snap["cancelled"]
    errors = [r["error"] for r in env.execute("SELECT error FROM eval_run_item").fetchall()]
    assert all("429" in e and "no credits remaining" in e for e in errors)
    assert SECRET not in json.dumps(snap) and SECRET not in " ".join(errors) and SECRET not in row["error"]


def test_batch_fatal_on_first_call_with_single_worker(env):
    sdk = FakeOpenAI(default=StatusError(401, "Incorrect API key"))
    snap = run_fatal(env, sdk, n=20, concurrency=1)
    assert sdk.calls == 1
    assert snap["failed"] == 1 and snap["cancelled"] == 19 and snap["status"] == "failed"


def test_fatal_detected_from_text_when_the_type_was_lost(env):
    class Plain:
        model = "claude-opus-5-5"
        settings = anthropic_settings()

        def complete(self, system_text, messages, schema=None):
            raise LLMError("RateLimitError status 429: You have no credits remaining")

    add_dataset(env, "TX", 6)
    snap = batch.run_job_sync(env, "TX", version_id(env), Plain(), concurrency=1, sleep=lambda s: None)
    assert snap["status"] == "failed" and snap["failed"] == 1 and snap["cancelled"] == 5
    assert snap["throttled_retries"] == 0
    assert env.execute("SELECT error FROM eval_run").fetchone()[0].startswith("Anthropic:")


def test_anthropic_fatal_aborts_batch(env):
    sdk = FakeSDK([StatusError(400, "Your credit balance is too low")] * 10)
    client = LLMClient(sdk=sdk, settings=anthropic_settings())
    add_dataset(env, "AN", 5)
    snap = batch.run_job_sync(env, "AN", version_id(env), client, concurrency=1, sleep=lambda s: None)
    assert snap["status"] == "failed" and snap["failed"] == 1 and snap["cancelled"] == 4


def test_ordinary_failures_do_not_abort_the_run(env):
    sdk = FakeOpenAI(default=StatusError(500, "server exploded"))
    snap = run_fatal(env, sdk, n=5, concurrency=2)
    assert snap["status"] == "completed" and snap["failed"] == 5 and snap["cancelled"] == 0
    assert env.execute("SELECT error FROM eval_run").fetchone()[0] is None


def test_good_run_is_unaffected(env):
    sdk = FakeOpenAI(default=response(GOOD))
    snap = run_fatal(env, sdk, n=4, concurrency=2)
    assert snap["status"] == "completed" and snap["completed"] == 4 and snap["cancelled"] == 0
