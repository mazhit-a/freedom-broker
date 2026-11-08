import hashlib
import json
import re

from backend.app.services.evaluator import RULES, build_system_prompt, build_user_prompt, render_criterion
from evals.graders import load_checklist
from evals.workflows import build_workflow
from evals.workflows.prompts import (
    NEW_RANGE_RULE,
    OLD_RANGE_RULE,
    TIEBREAK_RULE,
    build_system_prompt_tiebreak,
    build_system_prompt_v2,
    build_system_prompt_xml,
    build_user_prompt_xml,
)
from evals.workflows.single_call import PROMPTS

MESSAGES = [
    {"message_index": 0, "timestamp_raw": "00:00", "offset_seconds": 0, "speaker": "client", "text": "Привет"},
    {"message_index": 1, "timestamp_raw": "00:05", "offset_seconds": 5, "speaker": "operator", "text": "Здравствуйте"},
]
CONV = {"channel": "agent chat", "language": "ru"}


def test_registry_has_new_prompts_and_keeps_old_ones():
    assert {"v1", "v2", "v3_tiebreak", "v3_xml"} <= set(PROMPTS)
    cfg = load_checklist()
    assert PROMPTS["v1"][0](cfg) == build_system_prompt(cfg)
    assert PROMPTS["v2"][0](cfg) == build_system_prompt_v2(cfg)


def test_tiebreak_differs_from_v2_only_by_one_added_rule():
    cfg = load_checklist()
    v2 = build_system_prompt_v2(cfg)
    tb = build_system_prompt_tiebreak(cfg)
    assert TIEBREAK_RULE in tb and TIEBREAK_RULE not in v2
    stripped = re.sub(r"\n\d+\. " + re.escape(TIEBREAK_RULE), "", tb)
    renumbered = re.sub(r"^(\d+)\. ", lambda m: m.group(0), v2, flags=re.M)
    assert len(stripped.splitlines()) == len(v2.splitlines())
    assert "highest step whose descriptor fully holds" in tb
    assert tb.count(TIEBREAK_RULE) == 1
    assert renumbered


def test_tiebreak_rule_sits_before_the_final_rule_and_numbering_is_contiguous():
    cfg = load_checklist()
    tb = build_system_prompt_tiebreak(cfg)
    numbered = re.findall(r"^(\d+)\. ", tb.split("Checklist:")[0], flags=re.M)
    assert numbered == [str(i) for i in range(1, len(RULES) + 2)]
    lines = tb.split("Checklist:")[0].strip().splitlines()
    assert lines[-2].endswith(TIEBREAK_RULE)
    assert lines[-1].startswith(f"{len(RULES) + 1}. Return one result object")


def test_xml_system_prompt_has_all_sections_and_the_v2_rules():
    cfg = load_checklist()
    text = build_system_prompt_xml(cfg)
    assert text.startswith("<rules>\n1. ")
    assert "</rules>" in text and "<checklist name=" in text and "<output_format>" in text
    assert NEW_RANGE_RULE in text and OLD_RANGE_RULE not in text
    titles = {s.id: s.title for s in cfg.sections}
    for c in cfg.criteria:
        assert f'<criterion id="{c.id}">' in text
        assert render_criterion(c, titles) in text
    for r in RULES:
        if r != OLD_RANGE_RULE:
            assert r in text


def test_xml_user_prompt_wraps_metadata_transcript_and_task():
    text = build_user_prompt_xml(CONV, MESSAGES)
    assert text.startswith("<conversation_metadata>channel=agent chat, language=ru, messages=2</conversation_metadata>")
    assert "<transcript>\n[#0 | 00:00 | client] Привет\n[#1 | 00:05 | operator] Здравствуйте\n</transcript>" in text
    assert text.endswith("<task>Evaluate every criterion now.</task>")
    assert "Transcript:" not in text and build_user_prompt(CONV, MESSAGES) != text


def test_variants_resolve_to_the_new_prompts_through_the_openai_workflow():
    cfg = load_checklist()
    variants = {v["name"]: v for v in json.load(open("evals/variants.json"))}
    for name, expect in (("gpt_sol_xml", "v3_xml"), ("gpt_sol_tiebreak", "v3_tiebreak")):
        assert variants[name]["params"]["prompt"] == expect
        assert variants[name]["params"]["model"] == "gpt-6.1-sol" and variants[name]["params"]["effort"] == "medium"
        wf = build_workflow(variants[name], cfg)
        assert wf.prompt == expect
    assert variants["gpt_sol_medium"]["params"]["prompt"] == "v2"


DIGESTS = {
    "v1": (
        "d8e5e98a95ac2586b019ad90c7ada220364168cd2bee92b51d4a2417b11ed1d6",
        "45e0e4af9e369a18c39067ab45e7ef823dc116c55e3bc7411a0909dc3ee49174",
    ),
    "v2": (
        "f0c9d55aaec786e29a216a0a518efa76b2f3201678474cbe11bb51c9eb366746",
        "45e0e4af9e369a18c39067ab45e7ef823dc116c55e3bc7411a0909dc3ee49174",
    ),
    "v3_xml": (
        "aa9685405386b2d167d61fe9932bd9b87975f82de045ecde93720f2eede69fee",
        "f242377c76c54da0364873a92736b99502fdb67bb755a9f88aa46034d16c8e2b",
    ),
    "v3_tiebreak": (
        "26de8182fb5dfe9b0fda5022c252dea4527e8a54f40baa1f316ce63ece04c40c",
        "45e0e4af9e369a18c39067ab45e7ef823dc116c55e3bc7411a0909dc3ee49174",
    ),
}


def combined_prompt():
    from backend.app.services.prompts import build_system_prompt_xml_tiebreak

    return build_system_prompt_xml_tiebreak(load_checklist())


def test_existing_prompt_renderings_are_unchanged():
    cfg = load_checklist("evals/checklist_v2.json")
    for key, (system_digest, user_digest) in DIGESTS.items():
        system_builder, user_builder = PROMPTS[key]
        assert hashlib.sha256(system_builder(cfg).encode()).hexdigest() == system_digest
        assert hashlib.sha256(user_builder(CONV, MESSAGES).encode()).hexdigest() == user_digest


def test_registry_has_exactly_the_five_prompt_keys():
    assert set(PROMPTS) == {"v1", "v2", "v3_tiebreak", "v3_xml", "v4_xml_tiebreak"}


def test_combined_prompt_starts_with_rules_and_has_the_tiebreak_once_and_the_new_range_rule():
    text = combined_prompt()
    assert text.startswith("<rules>\n1. ")
    assert text.count(TIEBREAK_RULE) == 1
    assert NEW_RANGE_RULE in text and OLD_RANGE_RULE not in text


def test_combined_prompt_criteria_and_output_format_equal_the_xml_rendering():
    cfg = load_checklist()
    combined = combined_prompt()
    xml = build_system_prompt_xml(cfg)
    assert combined.split("</rules>", 1)[1] == xml.split("</rules>", 1)[1]
    assert combined != xml


def test_combined_prompt_numbering_is_contiguous_and_tiebreak_precedes_the_final_rule():
    text = combined_prompt()
    rules_block = text.split("<rules>\n", 1)[1].split("\n</rules>", 1)[0]
    lines = rules_block.splitlines()
    assert [re.match(r"(\d+)\. ", line).group(1) for line in lines] == [str(i) for i in range(1, len(RULES) + 2)]
    assert lines[-2] == f"{len(RULES)}. {TIEBREAK_RULE}"
    assert lines[-1].startswith(f"{len(RULES) + 1}. Return one result object")


def test_combined_prompt_rules_match_the_tiebreak_rules_apart_from_the_wrapper():
    cfg = load_checklist()
    text = combined_prompt()
    rules_block = text.split("<rules>\n", 1)[1].split("\n</rules>", 1)[0]
    assert rules_block == build_system_prompt_tiebreak(cfg).split("\n\nChecklist:", 1)[0]


def test_combined_user_prompt_equals_the_xml_user_prompt():
    from backend.app.services.prompts import PROMPTS as BACKEND_PROMPTS

    assert BACKEND_PROMPTS["v4_xml_tiebreak"][1] is build_user_prompt_xml
    assert BACKEND_PROMPTS["v4_xml_tiebreak"][1](CONV, MESSAGES) == BACKEND_PROMPTS["v3_xml"][1](CONV, MESSAGES)


def test_new_variant_resolves_to_the_combined_prompt_through_the_openai_workflow():
    cfg = load_checklist()
    variants = {v["name"]: v for v in json.load(open("evals/variants.json"))}
    variant = variants["gpt_sol_xml_tiebreak"]
    assert variant["workflow"] == "openai_single_call"
    assert variant["params"] == {"prompt": "v4_xml_tiebreak", "model": "gpt-6.1-sol", "effort": "medium"}
    assert build_workflow(variant, cfg).prompt == "v4_xml_tiebreak"
