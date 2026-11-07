import json

import pytest

from evals.gen import ambiguity, assemble, prompt, spec as spec_mod
from evals.gen.common import SONNET_MODEL, OPUS_MODEL, cases_hash
from tests.test_eval_gen_fakes import CFG, generation_output, good_case, good_spec


def batch_line(case_id, output, kind="succeeded", stop="end_turn"):
    if kind != "succeeded":
        return json.dumps({"custom_id": case_id, "result": {"type": kind}})
    message = {"content": [{"type": "text", "text": json.dumps(output, ensure_ascii=False)}], "stop_reason": stop}
    return json.dumps({"custom_id": case_id, "result": {"type": "succeeded", "message": message}}, ensure_ascii=False)


def test_case_from_output_is_clean_and_normalized():
    out = generation_output()
    out["messages"][0]["offset_seconds"] = 999
    case = assemble.case_from_output(CFG, good_spec(), out)
    assert case["review"] == {"status": "pending", "flags": []}
    assert case["conversation"]["messages"][0]["offset_seconds"] == 2.0
    assert case["expected"]["04"]["answer"] == 20
    assert case["tags"] == {"channel": "chat", "language": "ru", "length": "short", "topic": "deposit_withdrawal", "hard": []}


def test_invalid_items_are_kept_visible_and_flagged():
    out = generation_output()
    out["results"][4]["answer"] = "maybe"
    case = assemble.case_from_output(CFG, good_spec(), out)
    assert case["expected"]["05"]["answer"] == "maybe"
    assert any(f.startswith("answer:05:") for f in case["review"]["flags"])


def test_ingest_results_and_failures():
    specs = [good_spec(), dict(good_spec(), id="case-902"), dict(good_spec(), id="case-903"), dict(good_spec(), id="case-904")]
    lines = [
        batch_line("case-901", generation_output()),
        batch_line("case-902", None, kind="errored"),
        batch_line("case-903", generation_output(), stop="max_tokens"),
        "",
    ]
    cases, failures = assemble.ingest_results(CFG, specs, lines)
    assert [c["id"] for c in cases] == ["case-901"]
    assert set(failures) == {"case-902", "case-903", "case-904"}
    assert "errored" in failures["case-902"] and "max_tokens" in failures["case-903"]


def test_ingest_accepts_plain_text_lines():
    line = json.dumps({"custom_id": "case-901", "text": json.dumps(generation_output(), ensure_ascii=False)}, ensure_ascii=False)
    cases, failures = assemble.ingest_results(CFG, [good_spec()], [line])
    assert len(cases) == 1 and failures == {}


def test_ingest_bad_json_output():
    line = json.dumps({"custom_id": "case-901", "text": "oops"})
    cases, failures = assemble.ingest_results(CFG, [good_spec()], [line])
    assert cases == [] and "not valid JSON" in failures["case-901"]


def test_assemble_is_deterministic_and_hash_is_stable():
    a, b = good_case(), dict(good_case(), id="case-902")
    d1 = assemble.assemble_dataset([b, a], 3)
    d2 = assemble.assemble_dataset([a, b], 3)
    assert d1 == d2
    assert [c["id"] for c in d1["cases"]] == ["case-901", "case-902"]
    assert d1["hash"] == cases_hash(d1["cases"]) and len(d1["hash"]) == 64
    assert assemble.verify_hash(d1)
    d1["cases"][0]["expected"]["01"]["answer"] = "no"
    assert not assemble.verify_hash(d1)


def test_dataset_contract_schema():
    dataset = assemble.assemble_dataset([good_case()], 1)
    assert set(dataset) == {"version", "checklist", "hash", "cases"}
    assert dataset["checklist"] == "evals/checklist_v2.json"
    assert assemble.contract_errors(dataset, CFG) == []
    case = dataset["cases"][0]
    assert set(case) == {"id", "split", "tags", "conversation", "expected", "review"}
    assert set(case["conversation"]) == {"channel", "language", "messages"}
    assert set(case["conversation"]["messages"][0]) == {"message_index", "timestamp_raw", "offset_seconds", "speaker", "text"}
    assert set(case["expected"]["01"]) == {"answer", "rationale", "evidence", "checked_range", "na_reason"}


def test_contract_errors_catch_breakage():
    dataset = assemble.assemble_dataset([good_case()], 1)
    dataset["cases"][0]["split"] = "train"
    dataset["cases"][0]["review"]["status"] = "done"
    errors = assemble.contract_errors(dataset, CFG)
    assert any("bad split" in e for e in errors)
    assert any("hash" in e for e in errors)
    assert any("review" in e for e in errors)


def test_write_roundtrip(tmp_path):
    dataset = assemble.assemble_dataset([good_case()], 2)
    path = assemble.write_dataset(dataset, tmp_path / "d.json")
    assert json.loads(path.read_text(encoding="utf-8")) == dataset


def test_freeze_rules():
    specs = [good_spec()]
    case = good_case()
    dataset = assemble.assemble_dataset([case], 1)
    frozen, problems = assemble.freeze(dataset, None, CFG, specs)
    assert frozen is None and "pending" in problems[0]
    case["review"]["status"] = "accepted"
    frozen, problems = assemble.freeze(assemble.assemble_dataset([case], 1), 4, CFG, specs)
    assert problems == [] and frozen["version"] == 4 and assemble.verify_hash(frozen)
    case["review"]["status"] = "rejected"
    frozen, problems = assemble.freeze(assemble.assemble_dataset([case], 1), None, CFG, specs)
    assert frozen is None and "rejected" in problems[0]


def test_freeze_blocks_hard_validation_errors():
    case = good_case()
    case["review"]["status"] = "edited"
    case["expected"]["01"]["evidence"] = [{"message_index": 99, "quote": "x"}]
    frozen, problems = assemble.freeze(assemble.assemble_dataset([case], 1), None, CFG, [good_spec()])
    assert frozen is None and "hard validation" in problems[0]


def test_card_contains_distributions():
    case = good_case()
    card = assemble.build_card(assemble.assemble_dataset([case], 1), CFG)
    for needle in ("## Channel", "## Message counts", "## Speaker mix", "## Hard cases", "version: 1", "No DEV reference"):
        assert needle in card
    reference = assemble.conversation_stats([case])
    assert "| DEV | this set |" in assemble.build_card(assemble.assemble_dataset([case], 1), CFG, reference)


def test_conversation_stats():
    st = assemble.conversation_stats([good_case()])
    assert st["message_count"]["n"] == 1 and st["message_count"]["max"] == 8
    assert abs(sum(st["speaker_share"].values()) - 1) < 0.01


def test_prompt_requests_never_need_network_and_carry_custom_id():
    spec = spec_mod.sample_specs()[0]
    live = prompt.live_request(spec, CFG)
    assert live["model"] == OPUS_MODEL
    assert live["output_config"]["format"]["schema"]["required"] == ["messages", "results"]
    row = prompt.batch_request(spec, CFG)
    assert row["custom_id"] == spec["id"] and row["params"] == live
    assert spec["id"] in prompt.build_user_prompt(spec, CFG)


def test_system_prompt_has_events_and_style_references():
    system = prompt.build_system_prompt(CFG)
    for text in ("Личность клиента подтверждена.", "Клиенттің жеке басы расталды.", "Customer identity verified.", "Эскалация на оператора.", "Chat transferred to an agent.", "[Имя скрыто]"):
        assert text in system
    assert len(prompt.fixture_conversations(5)) == 3
    assert "p1-ru" not in system


def test_every_spec_builds_a_prompt():
    for spec in spec_mod.sample_specs():
        text = prompt.build_user_prompt(spec, CFG)
        assert f"write exactly {spec['message_target']} messages" in text
        for cid in spec["targets"]:
            assert f"- {cid} " in text


def test_estimate_cost():
    est = prompt.estimate_cost(36)
    assert est["requests"] == 36
    assert est["batch_total"] == pytest.approx(36 * (3000 * 4 + 6000 * 20) / 1e6 * 0.5, abs=1e-3)


def test_blind_request_hides_expected_result():
    case = good_case()
    request = ambiguity.blind_request(case, CFG)
    blob = json.dumps(request, ensure_ascii=False)
    assert request["model"] == SONNET_MODEL
    assert case["expected"]["01"]["rationale"] not in blob
    assert "Оператор поздоровался и представился." not in blob
    assert "Нарушений нет." not in blob
    assert "[#3 |" in blob
    assert ambiguity.blind_batch_request(case, CFG)["custom_id"] == case["id"]


def test_blind_compare_flags_disagreements():
    case = good_case()
    blind = {"01": "yes", "02": "no", "03": "yes", "04": 15, "05": "yes", "06": 10, "07": "yes"}
    flags = ambiguity.compare(CFG, case["expected"], blind)
    ids = sorted(f.split(":")[1] for f in flags)
    assert ids == ["02", "04", "08"]
    assert all(f.startswith("ambiguity:") for f in flags)


def test_parse_blind_and_attach():
    case = good_case()
    text = json.dumps({"results": [{"criterion_id": "01", "answer": "no", "rationale": "x"}, {"criterion_id": "04", "answer": "20", "rationale": "x"}, {"criterion_id": "99", "answer": "yes", "rationale": "x"}]})
    assert ambiguity.parse_blind(CFG, text) == {"01": "no", "04": 20}
    line = json.dumps({"custom_id": case["id"], "text": text})
    assemble.attach_blind(CFG, [case], [line])
    assert any(f.startswith("ambiguity:01:") for f in case["review"]["flags"])
    assemble.attach_blind(CFG, [case], [line])
    assert sum(f.startswith("ambiguity:01:") for f in case["review"]["flags"]) == 1
