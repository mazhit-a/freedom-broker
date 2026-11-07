import copy
import json

import pytest

from evals.decisions import (
    OBS_04_INSTRUCTIONS,
    OBS_06_INSTRUCTIONS,
    DecisionsError,
    annotate_gaps,
    build_questions,
    build_request,
    build_state,
    map_answers,
    specs_for_questions,
)
from evals.workflows import build_workflow
from tests.test_eval_jev_variants import VARIANTS, run_variant
from tests.test_eval_runner_fakes import CFG, FakeJev, tiny_dataset

NEW_STYLES = ("obs", "gaps", "obs_gaps")
INSTR_04 = (
    "Корректная и полная консультация. Выберите шаг, описание которого выполняется. Порядок проверки: мысленно перечислите все вопросы, "
    "которые клиент задал в диалоге, включая второстепенные, и для каждого проверьте, получил ли он ответ или корректный следующий шаг "
    "после этого. Если основной вопрос решён, а на второстепенный вопрос клиента ответа или следующего шага нет, это 15, а не 20. "
    "Выберите 20 только если на все вопросы клиента, основные и второстепенные, есть ответ или корректный следующий шаг. "
    "Если ключевая рекомендация оператора ошибочна, это 0."
)
INSTR_06 = (
    "Управление диалогом, скорость и грамотность. Найдите в диалоге три наблюдаемые вещи. Первая: явное ожидание, то есть долгая пауза "
    "между сообщениями или событие удержания, и предупредил ли оператор об ожидании до него. Вторая: переспрашивал ли клиент "
    "или спрашивал, что имел в виду оператор, из-за формулировок или порядка ответов оператора. Третья: противоречивые или бессвязные "
    "реплики оператора. Затем выберите шаг, описание которого соответствует увиденному."
)
OPTIONS_04 = {
    "0": "Ответа по существу нет или ключевая рекомендация ошибочна.",
    "5": "Есть общая подсказка, но клиенту всё ещё непонятно, как действовать.",
    "10": "Часть запроса закрыта, существенный вопрос остался открытым.",
    "15": "Основной вопрос решён, пропущена второстепенная деталь.",
    "20": "Все существенные вопросы закрыты или дан корректный следующий шаг.",
}
OPTIONS_06 = {
    "0": "Из-за бессвязных или противоречивых реплик ход диалога непонятен",
    "4": "Клиенту приходится переспрашивать из-за формулировок или порядка ответов.",
    "7": "Один заметный сбой, но клиент может понять ответ и продолжить.",
    "10": "Ответы ясные и связные. Если было явное ожидание, оператор предупредил.",
}
GAP = " [пауза {} с до следующего сообщения]"


def conv():
    return tiny_dataset()["cases"][0]["conversation"]


def bodies(style):
    return {s.name: s.body for s in build_questions(CFG, style)}


def msg(i, t=None, text="x", speaker="operator", raw=None):
    m = {"message_index": i, "speaker": speaker, "text": text}
    if t is not None:
        m["offset_seconds"] = t
    if raw is not None:
        m["timestamp_raw"] = raw
    return m


def texts(msgs):
    return [m["text"] for m in msgs]


def test_variants_registered():
    for name, style in (("jev_obs", "obs"), ("jev_gaps", "gaps"), ("jev_obs_gaps", "obs_gaps")):
        assert VARIANTS[name] == {"name": name, "workflow": "jev_only", "params": {"style": style}}
        wf = build_workflow(VARIANTS[name], CFG)
        assert wf.estimate_plan() == [("jev", "typesafe/jev-1.14", 1)]
        assert wf.expected_calls() == 1


def test_obs_exact_texts():
    assert OBS_04_INSTRUCTIONS == INSTR_04
    assert OBS_06_INSTRUCTIONS == INSTR_06
    for style in ("obs", "obs_gaps"):
        b = bodies(style)
        assert b["q_04"] == {"type": "choice", "instructions": INSTR_04, "criteria": OPTIONS_04}
        assert b["q_06"] == {"type": "choice", "instructions": INSTR_06, "criteria": OPTIONS_06}
        assert list(b["q_04"]["criteria"]) == ["0", "5", "10", "15", "20"]
        assert list(b["q_06"]["criteria"]) == ["0", "4", "7", "10"]


@pytest.mark.parametrize("style", NEW_STYLES)
def test_other_criteria_byte_identical_to_default(style):
    default = bodies("default")
    new = bodies(style)
    changed = {"q_02"} | ({"q_04", "q_06"} if style != "gaps" else set())
    assert list(new) == list(default)
    for name, body in default.items():
        if name in changed:
            assert json.dumps(new[name], ensure_ascii=False) != json.dumps(body, ensure_ascii=False)
        else:
            assert json.dumps(new[name], ensure_ascii=False, sort_keys=True) == json.dumps(body, ensure_ascii=False, sort_keys=True)
    assert new["q_02"] == bodies("temporal_choice")["q_02"]
    assert "q_04__na" in new


def test_gaps_default_mapping_for_04_and_06():
    assert bodies("gaps")["q_04"] == bodies("default")["q_04"]
    assert bodies("gaps")["q_06"] == bodies("default")["q_06"]


def test_na_companion_unchanged():
    assert bodies("obs")["q_04__na"] == bodies("default")["q_04__na"]


def choice_answers(style, picks, na=0.0):
    _, specs = build_request(conv(), CFG, style=style)
    answers = {}
    for s in specs:
        if s.role == "scale_choice":
            key = picks[s.name]
            probs = {o: 0.05 for o in s.body["criteria"]}
            probs[key] = 0.8
            answers[s.name] = {"type": "choice", "choice": key, "probabilities": probs}
        elif s.body["type"] == "choice":
            answers[s.name] = {"type": "choice", "choice": "yes", "probabilities": {o: 0.5 for o in s.body["criteria"]}}
        elif s.body["type"] == "noul":
            answers[s.name] = {"type": "noul", "noul": na if s.role == "scale_na" else 0.1}
        else:
            answers[s.name] = {"type": "score", "probabilities": {"0": 1.0}}
    return {"answers": answers}, specs


@pytest.mark.parametrize("key,expected", [("0", "0"), ("5", "5"), ("10", "10"), ("15", "15"), ("20", "20")])
def test_map_every_option_04(key, expected):
    body, specs = choice_answers("obs", {"q_04": "20", "q_06": "10"} | {"q_04": key})
    out = map_answers(body, specs)["04"]
    assert out["answer"] == expected
    assert out["confidence"] == pytest.approx(0.8 * 1.0)
    assert set(out["distribution"]) == {"na", "0", "5", "10", "15", "20"}
    assert out["distribution"][expected] == pytest.approx(0.8)


@pytest.mark.parametrize("key", ["0", "4", "7", "10"])
def test_map_every_option_06(key):
    body, specs = choice_answers("obs_gaps", {"q_04": "20", "q_06": key})
    out = map_answers(body, specs)["06"]
    assert out == {"answer": key, "confidence": pytest.approx(0.8), "distribution": {k: pytest.approx(0.8 if k == key else 0.05) for k in ("0", "4", "7", "10")}}
    assert isinstance(int(out["answer"]), int)


def test_map_04_with_na_companion():
    body, specs = choice_answers("obs", {"q_04": "15", "q_06": "7"}, na=0.9)
    out = map_answers(body, specs)["04"]
    assert out["answer"] == "na"
    assert out["confidence"] == 0.9
    body, specs = choice_answers("obs", {"q_04": "15", "q_06": "7"}, na=0.2)
    out = map_answers(body, specs)["04"]
    assert out["answer"] == "15"
    assert out["confidence"] == pytest.approx(0.8 * 0.8)
    assert out["distribution"]["15"] == pytest.approx(0.8 * 0.8)


def test_map_unknown_choice_is_malformed():
    body, specs = choice_answers("obs", {"q_04": "20", "q_06": "10"})
    body["answers"]["q_06"]["choice"] = "5"
    with pytest.raises(DecisionsError):
        map_answers(body, specs)


@pytest.mark.parametrize("style", NEW_STYLES)
def test_specs_for_questions_resolves_new_styles(style):
    payload, specs = build_request(conv(), CFG, style=style)
    resolved = specs_for_questions(CFG, payload["questions"])
    assert [s.name for s in resolved] == list(payload["questions"])
    assert [s.role for s in resolved] == [s.role for s in specs]
    assert [s.steps for s in resolved] == [s.steps for s in specs]
    roles = {s.name: s.role for s in resolved}
    assert roles["q_02"] == "temporal_choice"
    assert (roles["q_04"], roles["q_06"]) == (("scale", "scale") if style == "gaps" else ("scale_choice", "scale_choice"))


def test_gap_threshold_inclusive_and_rounding():
    msgs = [msg(0, 0), msg(1, 59), msg(2, 119), msg(3, 179.4), msg(4, 239.3)]
    out = annotate_gaps(msgs)
    assert texts(out) == ["x", "x" + GAP.format(60), "x" + GAP.format(60), "x", "x"]
    out = annotate_gaps([msg(0, 0), msg(1, 90.5), msg(2, 151)])
    assert texts(out) == ["x" + GAP.format(91), "x" + GAP.format(61), "x"]
    assert annotate_gaps([msg(0, 0), msg(1, 59.6)]) == [msg(0, 0), msg(1, 59.6)]


def test_gap_does_not_mutate_input_and_no_change_without_gaps():
    msgs = [msg(0, 0), msg(1, 10), msg(2, 20)]
    before = copy.deepcopy(msgs)
    out = annotate_gaps(msgs)
    assert msgs == before
    assert out == before
    assert out is not msgs


def test_gap_falls_back_to_timestamps():
    msgs = [msg(0, 0, raw="00:00"), msg(1, 0, raw="01:30"), msg(2, 0, raw="01:35"), msg(3, 0, raw="1:02:35")]
    assert texts(annotate_gaps(msgs)) == ["x" + GAP.format(90), "x", "x" + GAP.format(3660), "x"]
    msgs = [msg(0, raw="00:00"), msg(1, raw="02:00")]
    assert texts(annotate_gaps(msgs)) == ["x" + GAP.format(120), "x"]


def test_gap_missing_or_unparsable_data_skipped():
    msgs = [msg(0), msg(1), msg(2)]
    assert annotate_gaps(msgs) == msgs
    msgs = [msg(0, raw="00:00"), msg(1, raw="soon"), msg(2, raw="10:00"), msg(3, raw="12:00")]
    assert texts(annotate_gaps(msgs)) == ["x", "x", "x" + GAP.format(120), "x"]
    msgs = [msg(0, 0), msg(1), msg(2, 500), msg(3, 700)]
    assert texts(annotate_gaps(msgs)) == ["x", "x", "x" + GAP.format(200), "x"]
    assert annotate_gaps([]) == []
    assert annotate_gaps([msg(0, 0)]) == [msg(0, 0)]


def test_gap_none_text_and_hold_start_untouched():
    msgs = [
        {"message_index": 0, "speaker": "operator", "text": None, "offset_seconds": 0},
        {"message_index": 1, "speaker": "system", "text": "Клиент поставлен на удержание.", "offset_seconds": 100},
        {"message_index": 2, "speaker": "system", "text": "Удержание снято.", "offset_seconds": 400},
        {"message_index": 3, "speaker": "operator", "text": "ok", "offset_seconds": 500},
        {"message_index": 4, "speaker": "system", "text": "Customer put on hold.", "offset_seconds": 900},
        {"message_index": 5, "speaker": "system", "text": "Клиент күтуге қойылды.", "offset_seconds": 1000},
        {"message_index": 6, "speaker": "client", "text": "y", "offset_seconds": 1100},
    ]
    out = annotate_gaps(msgs)
    assert out[0]["text"] == " [пауза 100 с до следующего сообщения]"
    assert out[1]["text"] == "Клиент поставлен на удержание."
    assert out[2]["text"] == "Удержание снято." + GAP.format(100)
    assert out[3]["text"] == "ok" + GAP.format(400)
    assert out[4]["text"] == "Customer put on hold."
    assert out[5]["text"] == "Клиент күтуге қойылды."
    assert out[6]["text"] == "y"
    assert [m["offset_seconds"] for m in out] == [m["offset_seconds"] for m in msgs]


def test_hold_text_only_skipped_for_system_speaker():
    msgs = [msg(0, 0, text="Клиент поставлен на удержание.", speaker="operator"), msg(1, 100)]
    assert texts(annotate_gaps(msgs)) == ["Клиент поставлен на удержание." + GAP.format(100), "x"]


def gapped_conv():
    c = copy.deepcopy(conv())
    c["messages"][1]["offset_seconds"] = c["messages"][0].get("offset_seconds", 0) + 300
    c["messages"][1].pop("timestamp_raw", None)
    return c


def test_state_identical_to_default_when_no_gaps():
    c = copy.deepcopy(conv())
    for i, m in enumerate(c["messages"]):
        m["offset_seconds"] = i * 5
    assert build_state(c, gaps=True) == build_state(c)
    base, _ = build_request(c, CFG)
    for style in ("obs", "temporal_choice"):
        assert build_request(c, CFG, style=style)[0]["state"] == base["state"]
    for style in ("gaps", "obs_gaps"):
        assert build_request(c, CFG, style=style)[0]["state"] == base["state"]


def test_state_annotated_only_for_gap_styles():
    c = gapped_conv()
    base = build_state(c)
    for style in ("default", "obs", "temporal_choice", "rich"):
        assert build_request(c, CFG, style=style)[0]["state"][1:] == base[1:] or style == "rich"
    for style in ("gaps", "obs_gaps"):
        st = build_request(c, CFG, style=style)[0]["state"]
        assert st[0] == base[0] and st[1] == base[1]
        assert st[2] != base[2]
        assert GAP.format(300) in st[2]
    assert build_request(c, CFG, style="obs")[0]["state"] == build_request(c, CFG, style="default")[0]["state"]


class ObsJev(FakeJev):
    def post(self, payload):
        out = super().post(payload)
        answers = out["body"]["answers"]
        answers["q_04"] = {"type": "choice", "choice": "15", "probabilities": {"0": 0.0, "5": 0.0, "10": 0.1, "15": 0.7, "20": 0.2}}
        answers["q_06"] = {"type": "choice", "choice": "7", "probabilities": {"0": 0.0, "4": 0.2, "7": 0.7, "10": 0.1}}
        if "q_02" in answers:
            answers["q_02"] = {"type": "choice", "choice": "yes", "probabilities": {"yes": 0.9, "no_late": 0.05, "na": 0.05}}
        return out


@pytest.mark.parametrize("name", ["jev_obs", "jev_obs_gaps"])
def test_obs_runs_through_runner(tmp_path, name):
    jev = ObsJev()
    out, results, errors = run_variant(tmp_path, name, jev)
    assert not errors
    assert len(jev.calls) == 3
    assert list(jev.calls[0]["questions"]["q_04"]["criteria"]) == ["0", "5", "10", "15", "20"]
    for r in results:
        assert r["results"]["04"]["answer"] == 15
        assert r["results"]["06"]["answer"] == 7
        assert r["results"]["06"]["distribution"] == {"0": 0.0, "4": 0.2, "7": 0.7, "10": 0.1}
        assert r["results"]["02"]["answer"] == "yes"
        assert r["results"]["01"]["answer"] == "yes"


def test_gaps_run_through_runner(tmp_path):
    jev = FakeJev()
    out, results, errors = run_variant(tmp_path, "jev_gaps", jev)
    assert not errors
    assert len(jev.calls) == 3
    assert list(jev.calls[0]["questions"]["q_04"]["criteria"]) == list(bodies("default")["q_04"]["criteria"])
    for r in results:
        assert r["results"]["04"]["answer"] == 20
