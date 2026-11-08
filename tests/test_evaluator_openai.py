import json
from types import SimpleNamespace

import pytest

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services import checklist as checklist_service
from backend.app.services import prompts
from backend.app.services.evaluator import TRUNCATED_REASON, evaluate_conversation
from backend.app.services.model_profiles import get_profile, profile_cost
from backend.app.services.openai_client import OpenAIClient
from tests.test_evaluator import add_conversation, crit, ev, fixed_good, payload, version_id
from tests.test_openai_client import FakeSDK, StatusError, ZeroRng, make_response


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("OPENAI_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_EFFORT", "LLM_PROMPT_VERSION", "CQA_BATCH_CONCURRENCY", "OPENAI_MAX_ATTEMPTS", "OPENAI_CALL_CEILING_S", "OPENAI_MAX_INFLIGHT", "OPENAI_MAX_OUTPUT_TOKENS"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def db(tmp_path):
    path = str(tmp_path / "e.db")
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    yield conn
    conn.close()


def settings(version="v1"):
    return config.Settings(
        _env_file=None,
        llm_provider="openai",
        llm_model="gpt-6.1-sol",
        llm_effort="medium",
        openai_api_key="",
        openai_max_attempts=5,
        openai_call_ceiling_s=30.0,
        llm_prompt_version=version,
    )


def run(db, sdk, version="v1", sleeps=None):
    s = settings(version)
    sleeps = sleeps if sleeps is not None else []
    client = OpenAIClient(sdk=sdk, settings=s, sleep=sleeps.append, rng=ZeroRng())
    pk = add_conversation(db)
    return evaluate_conversation(db, pk, version_id(db), client, settings=s)


def raw_output(db, evaluation_id):
    return json.loads(db.execute("SELECT raw_output FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone()[0])


def refusal_response():
    return make_response(content=[SimpleNamespace(type="refusal", refusal="cannot help")])


@pytest.mark.parametrize("version", ["v1", "v2"])
def test_completed_evaluation_stores_model_tokens_cost_and_meta(db, version):
    sdk = FakeSDK(make_response(text=payload(fixed_good()), input_tokens=1000, cached=400, output=300, reasoning=120))
    result = run(db, sdk, version)
    assert result["status"] == "completed" and not result["provisional"]
    assert result["model"] == "gpt-6.1-sol"
    assert result["prompt_version"] == version
    assert result["tokens_input"] == 600
    assert result["tokens_cache_read"] == 400
    assert result["tokens_output"] == 300
    assert result["tokens_cache_write"] == 0
    assert result["cost"] == profile_cost(get_profile("gpt-6.1-sol"), 600, 300, 400, 0)
    assert result["total"] == 88.13
    raw = raw_output(db, result["id"])
    assert raw["prompt_version"] == version
    assert len(raw["calls_meta"]) == 1
    meta = raw["calls_meta"][0]
    assert meta["reasoning_tokens"] == 120 and meta["attempts"] == 1
    assert meta["served_model"] == "gpt-6.1-sol" and meta["finish_reason"] == "completed"
    assert raw["structured"] is True and raw["error"] is None


def test_tokens_and_cost_sum_across_repair(db):
    bad = fixed_good()
    bad["01"] = ("yes", "Оператор поздоровался.", ev(99, "меня зовут Анна"), None, None)
    sdk = FakeSDK(
        make_response(text=payload(bad), input_tokens=1000, cached=400, output=300, reasoning=120),
        make_response(text=payload({"01": fixed_good()["01"]}), input_tokens=1500, cached=1000, output=100, reasoning=10),
    )
    result = run(db, sdk)
    assert len(sdk.calls) == 2 and result["status"] == "completed"
    assert result["tokens_input"] == 600 + 500
    assert result["tokens_cache_read"] == 1400
    assert result["tokens_output"] == 400
    profile = get_profile("gpt-6.1-sol")
    expected = round(profile_cost(profile, 600, 300, 400, 0) + profile_cost(profile, 500, 100, 1000, 0), 6)
    assert result["cost"] == expected
    assert len(raw_output(db, result["id"])["calls_meta"]) == 2


def test_refusal_needs_review_with_russian_reason(db):
    sdk = FakeSDK(refusal_response())
    result = run(db, sdk)
    assert len(sdk.calls) == 1
    assert result["status"] == "needs_review"
    assert len(result["criteria"]) == 8
    for c in result["criteria"]:
        assert c["needs_review"] and c["answer"] == "needs_review" and c["points"] is None
        assert c["rationale"] == "Модель отказалась от оценки (refusal)"
    assert result["total"] is None and result["total_status"] == "not_calculated"
    assert result["model"] == "gpt-6.1-sol"
    assert raw_output(db, result["id"])["refused"] is True


def test_truncation_needs_review_with_one_call(db):
    sdk = FakeSDK(make_response(text='{"results": [', status="incomplete", incomplete="max_output_tokens"))
    result = run(db, sdk)
    assert len(sdk.calls) == 1
    assert result["status"] == "needs_review"
    for c in result["criteria"]:
        assert c["needs_review"] and c["rationale"] == TRUNCATED_REASON
    assert result["tokens_output"] == 300 and result["tokens_cache_write"] == 0
    assert raw_output(db, result["id"])["calls_meta"][0]["finish_reason"] == "max_output_tokens"


def test_invalid_json_one_repair_then_needs_review_for_still_bad(db):
    partial = payload({"01": fixed_good()["01"], "02": fixed_good()["02"]})
    sdk = FakeSDK(make_response(text="not json at all"), make_response(text=partial))
    result = run(db, sdk)
    assert len(sdk.calls) == 2
    assert result["status"] == "needs_review" and result["provisional"] is True
    assert not crit(result, "01")["needs_review"] and not crit(result, "02")["needs_review"]
    for cid in ("03", "04", "05", "06", "07", "08"):
        c = crit(result, cid)
        assert c["needs_review"] and "missing from the output" in c["rationale"]
    assert sdk.calls[1]["input"][1] == {"role": "assistant", "content": "not json at all"}


def test_invalid_json_twice_everything_needs_review(db):
    sdk = FakeSDK(make_response(text="not json at all"), make_response(text="still not json"))
    result = run(db, sdk)
    assert len(sdk.calls) == 2
    assert result["status"] == "needs_review"
    assert all(c["needs_review"] for c in result["criteria"])


def range_responder(kwargs):
    with_range = prompts.NEW_RANGE_RULE in kwargs["instructions"] or len(kwargs["input"]) > 1
    results = fixed_good()
    results["05"] = ("no", "Оператор был невежлив.", ev(5, "я подскажу шаги"), {"from": 5, "to": 7} if with_range else None, None)
    return make_response(text=payload(results))


class ScriptedSDK(FakeSDK):
    def __init__(self, responder):
        super().__init__(None)
        self.responder = responder

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.responder(kwargs)


def test_missing_checked_range_triggers_repair_with_v1(db):
    sdk = ScriptedSDK(range_responder)
    result = run(db, sdk, "v1")
    assert prompts.OLD_RANGE_RULE in sdk.calls[0]["instructions"]
    assert len(sdk.calls) == 2
    assert "checked_range is required" in sdk.calls[1]["input"][-1]["content"]
    assert "05" in sdk.calls[1]["input"][-1]["content"]
    c5 = crit(result, "05")
    assert c5["answer"] == "no" and c5["checked_range"] == {"from": 5, "to": 7} and not c5["needs_review"]
    assert result["status"] == "completed"


def test_missing_checked_range_needs_no_repair_with_v2(db):
    sdk = ScriptedSDK(range_responder)
    result = run(db, sdk, "v2")
    assert prompts.NEW_RANGE_RULE in sdk.calls[0]["instructions"]
    assert prompts.OLD_RANGE_RULE not in sdk.calls[0]["instructions"]
    assert len(sdk.calls) == 1
    c5 = crit(result, "05")
    assert c5["answer"] == "no" and c5["checked_range"] == {"from": 5, "to": 7}
    assert result["status"] == "completed"


def test_rate_limit_exhaustion_fails_evaluation_with_429(db):
    sdk = FakeSDK(StatusError(429, "rate limit exceeded"))
    sleeps = []
    result = run(db, sdk, sleeps=sleeps)
    assert len(sdk.calls) == 5 and len(sleeps) == 4
    assert result["status"] == "failed"
    assert result["model"] == "gpt-6.1-sol"
    assert result["tokens_input"] == 0 and result["cost"] == 0
    assert all(c["needs_review"] for c in result["criteria"])
    error = raw_output(db, result["id"])["error"]
    assert "429" in error and "5 attempts" in error
    assert "429" in crit(result, "01")["rationale"]
