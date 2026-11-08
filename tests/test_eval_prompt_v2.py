import json

from backend.app.services.evaluator import build_system_prompt, build_user_prompt
from evals.decisions import annotate_gaps
from evals.graders import load_checklist
from evals.workflows import build_workflow
from evals.workflows.prompts import MARKS_NOTE, NEW_RANGE_RULE, OLD_RANGE_RULE, build_system_prompt_v2, with_marks_note

CASE = {
    "id": "c1",
    "conversation": {
        "channel": "agent chat",
        "language": "ru",
        "messages": [
            {"message_index": 0, "timestamp_raw": "00:00", "offset_seconds": 0, "speaker": "client", "text": "Привет"},
            {"message_index": 1, "timestamp_raw": "00:10", "offset_seconds": 10, "speaker": "operator", "text": "Здравствуйте"},
            {"message_index": 2, "timestamp_raw": "03:10", "offset_seconds": 190, "speaker": "client", "text": "Алло"},
        ],
    },
}


def variant(name):
    for v in json.load(open("evals/variants.json")):
        if v["name"] == name:
            return v
    raise KeyError(name)


def first_request(name):
    cfg = load_checklist()
    v = variant(name)
    wf = build_workflow(v, cfg)
    stage = wf.stage(0, CASE, wf.new_state(CASE))
    return stage.requests[0].params


def test_v2_changes_only_the_range_rule():
    cfg = load_checklist()
    old = build_system_prompt(cfg)
    new = build_system_prompt_v2(cfg)
    assert OLD_RANGE_RULE in old and OLD_RANGE_RULE not in new
    assert new.replace(NEW_RANGE_RULE, OLD_RANGE_RULE) == old
    assert "including criteria about tone, politeness or empathy" in new


def test_baseline_request_unchanged_by_new_options():
    cfg = load_checklist()
    params = first_request("opus_low")
    assert params["system"][0]["text"] == build_system_prompt(cfg)
    conv = {"channel": "agent chat", "language": "ru"}
    assert params["messages"][0]["content"] == build_user_prompt(conv, CASE["conversation"]["messages"])


def test_marks_variant_annotates_user_text_and_adds_note():
    params = first_request("opus_low_marks")
    cfg = load_checklist()
    assert params["system"][0]["text"] == with_marks_note(build_system_prompt(cfg))
    assert MARKS_NOTE in params["system"][0]["text"]
    assert "[пауза 180 с до следующего сообщения]" in params["messages"][0]["content"]
    assert "[пауза" not in json.dumps(CASE)


def test_fix05_marks_combines_both():
    params = first_request("opus_low_fix05_marks")
    text = params["system"][0]["text"]
    assert NEW_RANGE_RULE in text and MARKS_NOTE in text
    assert "[пауза 180 с" in params["messages"][0]["content"]


def test_fix05_without_marks_has_no_annotations():
    params = first_request("opus_low_fix05")
    assert "[пауза" not in params["messages"][0]["content"]
    assert MARKS_NOTE not in params["system"][0]["text"]


def test_annotation_does_not_mutate_case_messages():
    before = json.dumps(CASE)
    annotate_gaps(CASE["conversation"]["messages"])
    assert json.dumps(CASE) == before
