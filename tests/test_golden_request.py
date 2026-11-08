import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.schemas.checklist import ChecklistConfig
from backend.app.services import checklist as checklist_service
from backend.app.services.evaluator import (
    build_schema,
    build_system_prompt,
    build_user_prompt,
    run_evaluation,
    score_results,
)
from backend.app.services.llm_client import LLMClient, LLMError
from backend.app.services.model_profiles import PROFILES, get_profile, profile_from_settings
from tests.test_evaluator import MSGS, FakeSDK, fixed_good, payload

GOLDEN = Path(__file__).parent / "fixtures" / "golden_request.json"
CONV = {"channel": "agent chat", "language": "RU"}

EN_SEED = Path(__file__).parent / "fixtures" / "checklist_seed_en.json"


@pytest.fixture(scope="module")
def cfg(tmp_path_factory):
    path = str(tmp_path_factory.mktemp("g") / "g.db")
    init_db(path)
    conn = connect(path)
    checklist_service.create_checklist(conn, ChecklistConfig.model_validate(json.loads(EN_SEED.read_text(encoding="utf-8"))))
    vid = conn.execute("SELECT default_version_id FROM checklist").fetchone()[0]
    out = checklist_service.get_version(conn, vid).config
    conn.close()
    return out


@pytest.fixture
def messages():
    return [{"message_index": i, "timestamp_raw": t, "speaker": s, "text": x} for i, (t, s, x) in enumerate(MSGS)]


def request_for(client, cfg, messages):
    return client._request(build_system_prompt(cfg), [{"role": "user", "content": build_user_prompt(CONV, messages)}], build_schema(cfg))


def test_default_client_matches_golden(cfg, messages):
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert build_system_prompt(cfg) == golden["system_prompt"]
    assert build_user_prompt(CONV, messages) == golden["user_prompt"]
    client = LLMClient(sdk=object(), settings=config.Settings())
    assert json.loads(json.dumps(request_for(client, cfg, messages))) == golden["request"]


def test_profile_from_settings_matches_default_request(cfg, messages):
    s = config.Settings()
    a = request_for(LLMClient(sdk=object(), settings=s), cfg, messages)
    b = request_for(LLMClient(sdk=object(), settings=s, profile=profile_from_settings(s)), cfg, messages)
    assert a == b


@pytest.mark.parametrize("name", ["claude-opus-5-5", "claude-sonnet-5-5"])
def test_effort_profiles_send_effort(cfg, messages, name):
    req = request_for(LLMClient(sdk=object(), profile=get_profile(name)), cfg, messages)
    assert req["model"] == name
    assert req["output_config"]["effort"] == "medium"
    assert req["output_config"]["format"]["type"] == "json_schema"
    assert "thinking" not in req
    assert "temperature" not in req


def test_haiku_sends_no_effort_and_no_thinking(cfg, messages):
    req = request_for(LLMClient(sdk=object(), profile=get_profile("claude-haiku-4-5")), cfg, messages)
    assert req["model"] == "claude-haiku-4-5"
    assert "effort" not in req["output_config"]
    assert "thinking" not in req
    assert "temperature" not in req


def test_haiku_thinking_budget_only_when_set(cfg, messages):
    profile = get_profile("claude-haiku-4-5").with_overrides(thinking_budget=2048, max_tokens=8192)
    req = request_for(LLMClient(sdk=object(), profile=profile), cfg, messages)
    assert req["thinking"] == {"type": "enabled", "budget_tokens": 2048}
    assert "effort" not in req["output_config"]


def test_profile_max_tokens_and_effort_override(cfg, messages):
    profile = get_profile("claude-opus-5-5").with_overrides(max_tokens=1234, effort="low")
    req = request_for(LLMClient(sdk=object(), profile=profile), cfg, messages)
    assert req["max_tokens"] == 1234
    assert req["output_config"]["effort"] == "low"


def test_registry_prices():
    assert (PROFILES["claude-opus-5-5"].price_input, PROFILES["claude-opus-5-5"].price_output) == (4.0, 20.0)
    assert PROFILES["claude-sonnet-5-5"].price_cache_write == 2.5
    assert PROFILES["claude-haiku-4-5"].supports_effort is False


USAGE = dict(input_tokens=1_000_000, output_tokens=1_000_000, cache_read_input_tokens=1_000_000, cache_creation_input_tokens=1_000_000)


class ModelSDK:
    def __init__(self, served):
        self.served = served
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text="{}")],
            stop_reason="end_turn",
            usage=SimpleNamespace(**USAGE),
            model=self.served,
        )


@pytest.mark.parametrize(
    "name,expected",
    [("claude-opus-5-5", 29.2), ("claude-sonnet-5-5", 14.7), ("claude-haiku-4-5", 7.35)],
)
def test_cost_per_profile(name, expected):
    client = LLMClient(sdk=ModelSDK(name), profile=get_profile(name))
    result = client.complete("s", [{"role": "user", "content": "u"}])
    assert result.cost == pytest.approx(expected)
    assert result.model == name


def test_default_cost_uses_settings_prices():
    s = config.Settings(llm_price_input=1.0, llm_price_output=2.0, llm_price_cache_read=3.0, llm_price_cache_write=4.0)
    result = LLMClient(sdk=ModelSDK(s.llm_model), settings=s).complete("s", [{"role": "user", "content": "u"}])
    assert result.cost == pytest.approx(10.0)


def test_served_model_mismatch_raises():
    client = LLMClient(sdk=ModelSDK("claude-opus-5-5"), profile=get_profile("claude-sonnet-5-5"))
    with pytest.raises(LLMError, match="served model"):
        client.complete("s", [{"role": "user", "content": "u"}])


def test_served_model_dated_alias_is_accepted():
    client = LLMClient(sdk=ModelSDK("claude-haiku-4-5-20251001"), profile=get_profile("claude-haiku-4-5"))
    assert client.complete("s", [{"role": "user", "content": "u"}]).model == "claude-haiku-4-5-20251001"


def test_run_evaluation_accepts_custom_builders(cfg, messages):
    sdk = FakeSDK([payload(fixed_good())])
    client = LLMClient(sdk=sdk, settings=config.Settings())
    out = run_evaluation(
        client,
        cfg,
        CONV,
        messages,
        system_builder=lambda c: "custom system",
        user_builder=lambda conv, msgs: f"custom user {len(msgs)}",
    )
    call = sdk.calls[0]
    assert call["system"][0]["text"] == "custom system"
    assert call["messages"][0]["content"] == f"custom user {len(messages)}"
    assert not out.review
    result = score_results(cfg, out.results)
    assert result.calculated
