from evals.gen import validate
from tests.test_eval_gen_fakes import CFG, good_case, good_spec, item


def kinds(flags):
    return {validate.split_flag(f)[0] for f in flags}


def run(case=None, spec=None):
    return validate.validate_case(CFG, spec or good_spec(), case or good_case())


def test_good_case_has_no_flags():
    assert run() == []


def test_non_contiguous_index():
    case = good_case()
    case["conversation"]["messages"][3]["message_index"] = 9
    assert "index" in kinds(run(case))


def test_missing_message_field_and_bad_speaker():
    case = good_case()
    del case["conversation"]["messages"][1]["offset_seconds"]
    case["conversation"]["messages"][2]["speaker"] = "robot"
    assert "format" in kinds(run(case))


def test_unparseable_timestamp():
    case = good_case()
    case["conversation"]["messages"][1]["timestamp_raw"] = "soon"
    assert any("timestamp_raw" in f for f in run(case))


def test_quote_not_substring():
    case = good_case()
    case["expected"]["01"]["evidence"] = [{"message_index": 3, "quote": "добрый день, я Ольга"}]
    assert "evidence" in kinds(run(case))


def test_quote_fuzzy_match_is_flagged_as_inexact():
    case = good_case()
    case["expected"]["01"]["evidence"] = [{"message_index": 3, "quote": "меня зовут Анна!!"}]
    assert kinds(run(case)) == {"quote"}


def test_evidence_index_missing():
    case = good_case()
    case["expected"]["04"]["evidence"] = [{"message_index": 99, "quote": "деньги"}]
    assert "index" in kinds(run(case))


def test_length_band_mismatch():
    spec = good_spec()
    spec["length"] = "medium"
    spec["message_range"] = [15, 30]
    spec["message_target"] = 20
    assert "length" in kinds(run(spec=spec))


def test_language_mismatch():
    spec = good_spec()
    spec["language"] = spec["conversation_language"] = "en"
    flags = run(spec=spec)
    assert "language" in kinds(flags)


def test_switch_needs_both_languages():
    spec = good_spec()
    spec["language"] = "switch"
    spec["switch_to"] = "en"
    assert "language" in kinds(run(spec=spec))


def test_illegal_answer_under_v2():
    case = good_case()
    case["expected"]["01"]["answer"] = "na"
    case["expected"]["04"]["answer"] = 12
    case["expected"]["08"]["answer"] = "na"
    flags = run(case)
    assert {"01", "04", "08"} <= {validate.split_flag(f)[1] for f in flags if validate.split_flag(f)[0] == "answer"}


def test_rationale_not_russian():
    case = good_case()
    case["expected"]["05"]["rationale"] = "The operator was polite."
    assert "rationale" in kinds(run(case))


def test_missing_checked_range_for_no():
    case = good_case()
    case["expected"]["02"] = item("no", "Оператор не уточнил данные.")
    case["conversation"]["messages"][4]["text"] = "Личность клиента подтверждена."
    spec = good_spec()
    spec["targets"]["02"] = "no"
    assert "range" in kinds(run(case, spec))


def test_na_without_reason():
    case = good_case()
    case["expected"]["02"] = item("na", "Данных хватало.")
    assert "na_reason" in kinds(run(case))


def test_target_mismatch_is_flagged():
    case = good_case()
    case["expected"]["05"] = item("no", "Оператор был холоден.", checked_range={"from": 3, "to": 7})
    assert ("target_mismatch", "05") in {validate.split_flag(f)[:2] for f in run(case)}


def test_scale_target_mismatch():
    case = good_case()
    case["expected"]["04"]["answer"] = "15"
    assert ("target_mismatch", "04") in {validate.split_flag(f)[:2] for f in run(case)}


def test_identity_event_structure():
    case = good_case()
    case["conversation"]["messages"][4]["text"] = "Проверка данных клиента выполнена."
    assert ("structure", "03") in {validate.split_flag(f)[:2] for f in run(case)}


def test_na_closing_needs_left_event():
    case = good_case()
    case["expected"]["07"] = item("na", "Клиент ушёл.", na_reason="Чат оборвался.")
    spec = good_spec()
    spec["targets"]["07"] = "na"
    assert ("structure", "07") in {validate.split_flag(f)[:2] for f in run(case, spec)}


def test_chat_without_escalation_event():
    case = good_case()
    case["conversation"]["messages"][2]["text"] = "Клиент ожидает."
    assert "structure" in kinds(run(case))


def test_missing_criterion_result():
    case = good_case()
    del case["expected"]["06"]
    assert ("format", "06") in {validate.split_flag(f)[:2] for f in run(case)}


def test_parse_generation():
    data, err = validate.parse_generation('```json\n{"messages": [], "results": []}\n```')
    assert err is None and data == {"messages": [], "results": []}
    assert validate.parse_generation("not json")[1]
    assert validate.parse_generation('{"messages": 1}')[1]


def test_message_language_detector():
    assert validate.message_language("Добрый день, как дела") == "ru"
    assert validate.message_language("Сәлеметсіз бе, қалайсыз") == "kk"
    assert validate.message_language("Hello, how can I help") == "en"
    assert validate.message_language("ok") is None
