import copy
import json
from pathlib import Path

import pytest

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services import checklist as checklist_service
from backend.app.services import prompts
from backend.app.services.evaluator import build_schema, run_evaluation
from backend.app.services.model_profiles import get_profile
from backend.app.services.openai_client import OpenAIClient
from backend.app.services.openai_support import convert_schema
from evals.workflows.openai_single_call import openai_params
from tests.test_evaluator import MSGS, fixed_good, payload
from tests.test_openai_client import FakeSDK, make_response

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "golden_request_openai.json").read_text(encoding="utf-8"))
CONV = {"channel": "agent chat", "language": "RU"}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("OPENAI_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_EFFORT", "LLM_PROMPT_VERSION", "CQA_BATCH_CONCURRENCY", "OPENAI_MAX_OUTPUT_TOKENS", "OPENAI_MAX_ATTEMPTS"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(scope="module")
def cfg(tmp_path_factory):
    path = str(tmp_path_factory.mktemp("g") / "g.db")
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    vid = conn.execute("SELECT default_version_id FROM checklist").fetchone()[0]
    out = checklist_service.get_version(conn, vid).config
    conn.close()
    return out


@pytest.fixture
def messages():
    return [{"message_index": i, "timestamp_raw": t, "speaker": s, "text": x} for i, (t, s, x) in enumerate(MSGS)]


def settings(version="v1"):
    return config.Settings(
        _env_file=None,
        llm_provider="openai",
        llm_model="gpt-6.1-sol",
        llm_effort="medium",
        openai_api_key="",
        openai_max_output_tokens=32000,
        llm_prompt_version=version,
    )


def production_request(cfg, messages, version):
    system_builder, user_builder = prompts.PROMPTS[version]
    client = OpenAIClient(sdk=object(), settings=settings(version))
    system_text = system_builder(cfg)
    user_text = user_builder(CONV, messages)
    return system_text, user_text, client._request(system_text, [{"role": "user", "content": user_text}], build_schema(cfg))


def test_every_registered_version_has_a_golden_entry():
    assert set(prompts.PROMPTS) == set(GOLDEN)


@pytest.mark.parametrize("version", sorted(GOLDEN))
def test_request_matches_golden(cfg, messages, version):
    system_text, user_text, request = production_request(cfg, messages, version)
    assert system_text == GOLDEN[version]["system_prompt"]
    assert user_text == GOLDEN[version]["user_prompt"]
    assert json.loads(json.dumps(request)) == GOLDEN[version]["request"]


def test_v2_request_equals_harness_params(cfg, messages):
    system_text, user_text, request = production_request(cfg, messages, "v2")
    profile = get_profile("gpt-6.1-sol")
    schema = convert_schema(copy.deepcopy(build_schema(cfg)))
    expected = openai_params(profile.model, profile.effort, profile.max_tokens, schema, system_text, [{"role": "user", "content": user_text}])
    assert request == expected
    assert (profile.model, profile.effort, profile.max_tokens) == ("gpt-6.1-sol", "medium", 32000)


def test_request_has_exactly_the_harness_fields(cfg, messages):
    _, _, request = production_request(cfg, messages, "v2")
    assert set(request) == {"model", "instructions", "input", "max_output_tokens", "reasoning", "text", "store"}
    assert request["store"] is False and request["reasoning"] == {"effort": "medium"}
    assert "temperature" not in request


def test_repair_request_keeps_instructions_and_adds_separate_items(cfg, messages):
    bad = fixed_good()
    bad["01"] = ("yes", "Оператор поздоровался.", [{"message_index": 99, "quote": "меня зовут Анна"}], None, None)
    first_text = payload(bad)
    fixed = payload({"01": fixed_good()["01"]})
    sdk = FakeSDK(make_response(text=first_text), make_response(text=fixed))
    client = OpenAIClient(sdk=sdk, settings=settings("v2"), sleep=lambda s: None)
    out = run_evaluation(client, cfg, CONV, messages, settings=settings("v2"))
    assert len(sdk.calls) == 2 and not out.review
    first, second = sdk.calls
    assert second["instructions"] == first["instructions"]
    assert second["instructions"] == GOLDEN["v2"]["system_prompt"]
    assert first["input"] == [{"role": "user", "content": GOLDEN["v2"]["user_prompt"]}]
    assert len(second["input"]) == 3
    assert second["input"][0] == first["input"][0]
    assert second["input"][1] == {"role": "assistant", "content": first_text}
    assert second["input"][2]["role"] == "user"
    assert "does not exist" in second["input"][2]["content"]
    assert second["input"][1]["content"] not in second["input"][2]["content"]
    for key in ("model", "max_output_tokens", "reasoning", "text", "store"):
        assert second[key] == first[key]
