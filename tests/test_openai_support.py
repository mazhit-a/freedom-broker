import copy
import random
from types import SimpleNamespace

import pytest

from backend.app.services import openai_support as support
from backend.app.services import prompts as shared_prompts
from backend.app.services.evaluator import build_schema, build_system_prompt, build_user_prompt
from evals.gen import openai_provider as old
from evals.graders import load_checklist
from evals.workflows import prompts as eval_prompts
from evals.workflows import single_call

MESSAGES = [
    {"message_index": 0, "timestamp_raw": "00:00", "offset_seconds": 0, "speaker": "client", "text": "Привет"},
    {"message_index": 1, "timestamp_raw": "00:05", "offset_seconds": 5, "speaker": "operator", "text": "Здравствуйте"},
]
CONV = {"channel": "agent chat", "language": "ru"}


def response(text="{}", status="completed", refusal=None, reason=None, model="gpt-6.1-sol-2026-01-01"):
    part = {"type": "refusal", "refusal": refusal} if refusal else {"type": "output_text", "text": text}
    return {
        "model": model,
        "status": status,
        "incomplete_details": {"reason": reason} if reason else None,
        "output": [{"type": "message", "content": [part]}] if text is not None else [],
        "usage": {
            "input_tokens": 1000,
            "input_tokens_details": {"cached_tokens": 200},
            "output_tokens": 500,
            "output_tokens_details": {"reasoning_tokens": 300},
        },
    }


def test_convert_schema_strict_and_equal_to_eval_reexport():
    cfg = load_checklist()
    schema = build_schema(cfg)
    converted = support.convert_schema(copy.deepcopy(schema))
    assert support.strict_problems(converted) == []
    assert converted == old.convert_schema(copy.deepcopy(schema))
    assert old.convert_schema is support.convert_schema
    assert old.strict_problems is support.strict_problems


def test_eval_reexports_are_the_shared_objects():
    for name in (
        "EFFORTS",
        "UNSUPPORTED_KEYWORDS",
        "COMPOSITE_KEYWORDS",
        "TIMEOUT_NAMES",
        "KEY_PATTERN",
        "SCHEMA_NAME",
        "CeilingExceeded",
        "redact",
        "is_retryable",
        "describe_error",
        "call_with_ceiling",
        "backoff_delay",
        "extract_usage",
    ):
        assert getattr(old, name) is getattr(support, name)


def test_map_response_row_ok_and_usage():
    row = support.map_response_row(response('{"a": 1}'), "c1", "gpt-6.1-sol", 1.23456, 2, 3.5)
    assert row["status"] == "ok"
    assert row["text"] == '{"a": 1}'
    assert row["error"] is None
    assert row["model"] == "gpt-6.1-sol-2026-01-01"
    assert row["served_model_reported"] is True
    assert row["requested_model"] == "gpt-6.1-sol"
    assert row["usage"] == {"input_tokens": 1000, "cached_input_tokens": 200, "output_tokens": 500, "reasoning_tokens": 300}
    assert row["latency_s"] == 1.235
    assert row["total_s"] == 3.5
    assert row["attempts"] == 2
    assert "cost_usd" not in row


def test_map_response_row_refusal_incomplete_empty_and_failed():
    refused = support.map_response_row(response(refusal="no"), "c", "m", 1, 1)
    assert refused["status"] == "refusal" and refused["text"] is None and "no" in refused["error"]
    truncated = support.map_response_row(response(text="{", status="incomplete", reason="max_output_tokens"), "c", "m", 1, 1)
    assert truncated["status"] == "truncated" and truncated["error"] == "response incomplete: max_output_tokens"
    other = support.map_response_row(response(text="{", status="incomplete", reason="content_filter"), "c", "m", 1, 1)
    assert other["status"] == "incomplete"
    empty = support.map_response_row(response(text="  "), "c", "m", 1, 1)
    assert empty["status"] == "empty"
    failed = support.map_response_row(response(status="failed"), "c", "m", 1, 1)
    assert failed["status"] == "error" and "failed" in failed["error"]
    unreported = support.map_response_row({"status": "completed", "output": []}, "c", "m", 1, 1)
    assert unreported["model"] == "m" and unreported["served_model_reported"] is False


def test_eval_map_response_wraps_shared_row_and_adds_cost():
    resp = response('{"a": 1}')
    shared = support.map_response_row(resp, "c1", "gpt-6.1-sol", 1.0, 1)
    wrapped = old.map_response(resp, "c1", "gpt-6.1-sol", 1.0, 1)
    cost = wrapped.pop("cost_usd")
    assert wrapped == shared
    assert cost == pytest.approx(old.usage_cost("gpt-6.1-sol-2026-01-01", shared["usage"], "gpt-6.1-sol"))


class StatusError(Exception):
    def __init__(self, status_code):
        super().__init__(f"status {status_code}")
        self.status_code = status_code


@pytest.mark.parametrize("code,expected", [(408, True), (409, True), (429, True), (500, True), (503, True), (400, False), (401, False), (404, False)])
def test_is_retryable_status_codes(code, expected):
    assert support.is_retryable(StatusError(code)) is expected


@pytest.mark.parametrize("name", sorted(support.TIMEOUT_NAMES))
def test_is_retryable_timeout_names(name):
    assert support.is_retryable(type(name, (Exception,), {})("x")) is True


def test_is_retryable_other_and_ceiling():
    assert support.is_retryable(ValueError("x")) is False
    assert support.is_retryable(support.CeilingExceeded("x")) is True


def test_redact_removes_keys_and_tokens():
    key = "sk-abcdefghij1234567890"
    text = support.redact(f"failed with {key} and Authorization: Bearer abc.def-123 end")
    assert key not in text and "abc.def-123" not in text
    assert text.count("[redacted]") == 2
    assert "plainsecret" not in support.redact("x plainsecret y", ["plainsecret"])


def test_describe_error_redacts():
    msg = support.describe_error(StatusError(401), ["secretvalue"])
    assert msg.startswith("StatusError status 401")
    assert "secretvalue" not in support.describe_error(ValueError("bad secretvalue"), ["secretvalue"])


def test_backoff_delay_bounds():
    rng = random.Random(1)
    for attempt in range(1, 12):
        cap = min(60.0, 2.0 * (2 ** (attempt - 1)))
        for _ in range(50):
            assert 0 <= support.backoff_delay(attempt, rng) <= cap
    assert support.backoff_delay(3, SimpleNamespace(uniform=lambda a, b: b)) == 8.0
    assert support.backoff_delay(20, SimpleNamespace(uniform=lambda a, b: b)) == 60.0


def test_call_with_ceiling_returns_raises_and_times_out():
    assert support.call_with_ceiling(lambda: 7, 5) == 7
    with pytest.raises(KeyError):
        support.call_with_ceiling(lambda: (_ for _ in ()).throw(KeyError("k")), 5)
    import threading

    release = threading.Event()
    with pytest.raises(support.CeilingExceeded):
        support.call_with_ceiling(lambda: release.wait(5), 0.05)
    release.set()


def test_v2_matches_eval_builder_on_seeded_checklist():
    cfg = load_checklist()
    system_builder, user_builder = shared_prompts.PROMPTS["v2"]
    assert system_builder(cfg) == eval_prompts.build_system_prompt_v2(cfg)
    assert user_builder(CONV, MESSAGES) == build_user_prompt(CONV, MESSAGES)


def test_registry_renders_identical_to_eval_builders():
    cfg = load_checklist()
    assert set(shared_prompts.PROMPTS) == {"v1", "v2", "v3_xml", "v3_tiebreak", "v4_xml_tiebreak"}
    assert single_call.PROMPTS is shared_prompts.PROMPTS
    assert shared_prompts.PROMPTS["v1"][0](cfg) == build_system_prompt(cfg)
    assert shared_prompts.PROMPTS["v1"][1](CONV, MESSAGES) == build_user_prompt(CONV, MESSAGES)
    assert shared_prompts.PROMPTS["v3_xml"][0](cfg) == eval_prompts.build_system_prompt_xml(cfg)
    assert shared_prompts.PROMPTS["v3_xml"][1](CONV, MESSAGES) == eval_prompts.build_user_prompt_xml(CONV, MESSAGES)
    assert shared_prompts.PROMPTS["v3_tiebreak"][0](cfg) == eval_prompts.build_system_prompt_tiebreak(cfg)
    assert shared_prompts.PROMPTS["v3_tiebreak"][1](CONV, MESSAGES) == build_user_prompt(CONV, MESSAGES)
    assert shared_prompts.NEW_RANGE_RULE in shared_prompts.PROMPTS["v2"][0](cfg)
    assert shared_prompts.OLD_RANGE_RULE not in shared_prompts.PROMPTS["v2"][0](cfg)
