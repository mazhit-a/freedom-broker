import json

import pytest

from evals.graders import load_checklist
from evals.workflows import build_workflow
from evals.workflows.jev import EXPLAIN_RULES, EXPLAIN_RULES_OVERRIDE, explain_system, explain_user, override_validator

MESSAGES = [
    {"message_index": 0, "timestamp_raw": "00:00", "offset_seconds": 0, "speaker": "client", "text": "Здравствуйте, помогите с заявкой"},
    {"message_index": 1, "timestamp_raw": "00:10", "offset_seconds": 10, "speaker": "operator", "text": "Здравствуйте, меня зовут Анна"},
]


def crit(cid):
    return {c.id: c for c in load_checklist().criteria}[cid]


def item(answer, disputed=False, reason=None, evidence=None, rng=None, na_reason=None):
    return {
        "criterion_id": "01",
        "answer": answer,
        "rationale": "Оператор поздоровалась и представилась.",
        "evidence": evidence if evidence is not None else [{"message_index": 1, "quote": "меня зовут Анна"}],
        "checked_range": rng,
        "na_reason": na_reason,
        "disputed": disputed,
        "dispute_reason": reason,
    }


def test_override_accepts_the_fixed_answer_without_dispute():
    row, errors = override_validator({"01": "yes"})(crit("01"), item("yes"), MESSAGES)
    assert errors == [] and row["answer"] == "yes" and "disputed" not in row


def test_override_accepts_a_different_answer_only_with_dispute_and_full_support():
    validate = override_validator({"01": "yes"})
    row, errors = validate(crit("01"), item("no", True, "Оператор не представилась.", evidence=[], rng={"from": 0, "to": 1}), MESSAGES)
    assert errors == [] and row["answer"] == "no" and row["disputed"] is True and row["dispute_reason"].startswith("Оператор")


def test_override_still_requires_evidence_or_range_for_the_new_answer():
    validate = override_validator({"01": "no"})
    row, errors = validate(crit("01"), item("yes", True, "Приветствие есть.", evidence=[]), MESSAGES)
    assert row is None and any("evidence" in e for e in errors)


def test_override_rejects_a_dispute_that_keeps_the_same_answer():
    row, errors = override_validator({"01": "yes"})(crit("01"), item("yes", True, "причина"), MESSAGES)
    assert row is None and any("differs from the fixed answer" in e for e in errors)


def test_override_rejects_a_changed_answer_without_dispute():
    row, errors = override_validator({"01": "yes"})(crit("01"), item("no", False, None, rng={"from": 0, "to": 1}), MESSAGES)
    assert row is None and any("only when disputed is true" in e for e in errors)


def test_override_requires_a_reason_and_forbids_one_without_dispute():
    validate = override_validator({"01": "yes"})
    row, errors = validate(crit("01"), item("no", True, "  ", rng={"from": 0, "to": 1}), MESSAGES)
    assert row is None and any("dispute_reason is required" in e for e in errors)
    row, errors = validate(crit("01"), item("yes", False, "лишнее"), MESSAGES)
    assert row is None and any("must be null" in e for e in errors)


def test_system_prompt_selects_rules_by_mode_and_default_is_unchanged():
    cfg = load_checklist()
    assert explain_system(cfg).endswith(EXPLAIN_RULES)
    assert explain_system(cfg, "keep") == explain_system(cfg)
    assert explain_system(cfg, "override").endswith(EXPLAIN_RULES_OVERRIDE)
    assert "Never change an answer" in EXPLAIN_RULES and "which must differ from the fixed answer" in EXPLAIN_RULES_OVERRIDE


def test_user_prompt_label_is_configurable_with_the_old_default():
    default = explain_user({"channel": "agent chat", "language": "ru"}, MESSAGES, {"01": "yes"})
    assert "Fixed answers (do not change):" in default
    custom = explain_user({"channel": "agent chat", "language": "ru"}, MESSAGES, {"01": "yes"}, "Default answers")
    assert "Default answers:" in custom and "Fixed answers" not in custom


def test_variant_is_registered_and_bad_mode_is_rejected():
    cfg = load_checklist()
    variants = {v["name"]: v for v in json.load(open("evals/variants.json"))}
    v = variants["jev_haiku55_override"]
    assert v["workflow"] == "jev_explain" and v["params"]["dispute_mode"] == "override" and v["params"]["profile"] == "claude-haiku-5-5"
    assert build_workflow(v, cfg).dispute_mode == "override"
    assert build_workflow(variants["jev_haiku55"], cfg).dispute_mode == "keep"
    with pytest.raises(ValueError):
        build_workflow({"name": "x", "workflow": "jev_explain", "params": {"dispute_mode": "maybe"}}, cfg)


def test_finish_records_overrides_and_sources():
    cfg = load_checklist()
    wf = build_workflow({"name": "x", "workflow": "jev_explain", "params": {"profile": "claude-haiku-5-5", "dispute_mode": "override"}}, cfg)
    case = {"id": "c1"}
    row = lambda a, **kw: {"criterion_id": "x", "answer": a, "rationale": "r", "evidence": [], "checked_range": None, "na_reason": None, **kw}
    state = {
        "calls": [],
        "fixed": {"01": "yes", "05": "yes"},
        "jev_rows": {"01": {"confidence": 0.9, "distribution": {"yes": 0.9}}, "05": {"confidence": 0.8, "distribution": {"yes": 0.8}}},
        "jev_problems": {},
        "explain": {
            "ok": {"01": row("yes"), "05": row("no", disputed=True, dispute_reason="нет реакции")},
            "review": {},
            "refused": False,
        },
    }
    cand = wf.finish(case, state)
    assert cand["results"]["05"]["answer"] == "no" and cand["results"]["01"]["answer"] == "yes"
    assert cand["overrides"] == {"05": {"from": "yes", "to": "no"}}
    assert cand["disputes"] == {"05": "нет реакции"}
    assert cand["source"] == {"01": "jev", "05": "explainer"}
    assert cand["jev_answers"] == {"01": "yes", "05": "yes"}
