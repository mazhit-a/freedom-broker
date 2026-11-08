from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.app.core.config import Settings
from backend.app.services.model_profiles import get_profile, profile_cost, profile_from_settings

ROOT = Path(__file__).resolve().parent.parent


def gpt_settings(**kwargs):
    return Settings(_env_file=None, llm_provider="openai", llm_model="gpt-6.1-sol", **kwargs)


def test_openai_profile_from_settings_uses_registry():
    profile = profile_from_settings(gpt_settings())
    assert profile.provider == "openai"
    assert profile.model == "gpt-6.1-sol"
    assert profile.effort == "medium"
    assert profile.max_tokens == 32000
    assert (profile.price_input, profile.price_output, profile.price_cache_read, profile.price_cache_write) == (2.0, 10.0, 0.1, 0.0)


def test_openai_ignores_generic_llm_price_settings():
    profile = profile_from_settings(
        gpt_settings(llm_price_input=4.0, llm_price_output=20.0, llm_price_cache_read=0.2, llm_price_cache_write=5.0)
    )
    assert (profile.price_input, profile.price_output, profile.price_cache_read, profile.price_cache_write) == (2.0, 10.0, 0.1, 0.0)
    assert profile_from_settings(gpt_settings(llm_price_input=3)).price_input == 2.0


def test_openai_unknown_model_is_never_priced_with_generic_settings():
    profile = profile_from_settings(Settings(_env_file=None, llm_provider="openai", llm_model="gpt-unknown", llm_price_input=4.0, llm_price_output=20.0))
    assert (profile.price_input, profile.price_output) == (0.0, 0.0)


def test_openai_effort_and_max_output_tokens_applied():
    profile = profile_from_settings(gpt_settings(llm_effort="high", openai_max_output_tokens=1000))
    assert profile.effort == "high"
    assert profile.max_tokens == 1000


@pytest.mark.parametrize("effort", ["low", "medium", "high", "xhigh", "max"])
def test_openai_valid_efforts(effort):
    assert gpt_settings(llm_effort=effort).llm_effort == effort


def test_openai_unknown_effort_rejected():
    with pytest.raises(ValidationError):
        gpt_settings(llm_effort="extreme")


def test_non_openai_effort_not_restricted():
    assert Settings(_env_file=None, llm_effort="whatever").llm_effort == "whatever"


def test_anthropic_profile_from_settings_unchanged():
    profile = profile_from_settings(Settings(_env_file=None))
    assert profile.provider == "anthropic"
    assert profile.model == "claude-opus-5-5"
    assert profile.effort == "medium"
    assert profile.max_tokens == 8192
    assert (profile.price_input, profile.price_output, profile.price_cache_read, profile.price_cache_write) == (4.0, 20.0, 0.2, 5.0)


CLEAN_ENV_VARS = ("OPENAI_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_LABEL", "LLM_EFFORT", "LLM_PROMPT_VERSION", "CQA_BATCH_CONCURRENCY", "LLM_FALLBACK_MODEL")


def clean_settings(monkeypatch, **kwargs):
    for name in CLEAN_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    return Settings(_env_file=None, **kwargs)


def test_new_settings_defaults(monkeypatch):
    settings = clean_settings(monkeypatch)
    assert settings.llm_prompt_version == "v2"
    assert settings.openai_api_key == ""
    assert settings.openai_max_output_tokens == 32000
    assert settings.openai_call_ceiling_s == 180
    assert settings.openai_max_attempts == 5
    assert settings.openai_max_inflight == 12
    assert settings.cqa_batch_concurrency == 8
    assert settings.llm_fallback_model == ""


def test_clean_environment_yields_the_gpt_profile(monkeypatch):
    settings = clean_settings(monkeypatch)
    assert (settings.llm_provider, settings.llm_model, settings.llm_effort, settings.llm_label) == ("openai", "gpt-6.1-sol", "medium", "GPT-6.1 Sol")
    profile = profile_from_settings(settings)
    assert profile.provider == "openai" and profile.model == "gpt-6.1-sol" and profile.effort == "medium"
    assert profile.max_tokens == 32000
    assert (profile.price_input, profile.price_output, profile.price_cache_read, profile.price_cache_write) == (2.0, 10.0, 0.1, 0.0)


def test_rollback_block_restores_opus(monkeypatch):
    for name in CLEAN_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    settings = Settings(
        _env_file=None,
        llm_provider="anthropic",
        llm_model="claude-opus-5-5",
        llm_effort="medium",
        llm_prompt_version="v2",
    )
    profile = profile_from_settings(settings)
    assert profile.provider == "anthropic" and profile.model == "claude-opus-5-5" and profile.effort == "medium"
    assert (profile.price_input, profile.price_output, profile.price_cache_read, profile.price_cache_write) == (4.0, 20.0, 0.2, 5.0)
    assert settings.llm_prompt_version == "v2"


def test_rollback_with_exact_pre_change_prompt(monkeypatch):
    for name in CLEAN_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    settings = Settings(_env_file=None, llm_provider="anthropic", llm_model="claude-opus-5-5", llm_prompt_version="v1")
    assert settings.llm_prompt_version == "v1" and profile_from_settings(settings).provider == "anthropic"


def test_gpt_profile_cost():
    assert profile_cost(get_profile("gpt-6.1-sol"), 1000, 500, 4000, 0) == 0.0074


def test_env_example_has_no_secrets():
    lines = (ROOT / ".env.example").read_text().splitlines()
    key_lines = [line for line in lines if line.startswith("OPENAI_API_KEY=")]
    assert key_lines == ["OPENAI_API_KEY="]
    assert "sk-" not in "\n".join(lines)
    names = {line.split("=")[0] for line in lines if "=" in line and not line.startswith("#")}
    for name in ("OPENAI_MAX_OUTPUT_TOKENS", "OPENAI_CALL_CEILING_S", "OPENAI_MAX_ATTEMPTS", "OPENAI_MAX_INFLIGHT", "LLM_PROMPT_VERSION"):
        assert name in names
