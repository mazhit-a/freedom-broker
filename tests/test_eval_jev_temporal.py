import itertools
import json

import pytest

from evals import decisions
from evals.decisions import (
    TEMPORAL_CHOICE_BODY,
    TEMPORAL_SPLIT_BODIES,
    DecisionsError,
    build_questions,
    build_request,
    map_answers,
    specs_for_questions,
)
from evals.workflows import build_workflow
from tests.test_eval_jev_variants import VARIANTS, ThreadSafeJev, run_variant
from tests.test_eval_runner_fakes import CFG, FakeJev, tiny_dataset

CHOICE_INSTRUCTIONS = (
    "Выявление потребности. Найдите первый ответ оператора по существу: это не приветствие, не просьба подтвердить личность "
    "и не уточняющий вопрос. Сравните порядок: оператор уточнил недостающие детали до этого ответа или после него. "
    "Выберите yes, если оператор учёл известные детали и спросил о недостающих до первого ответа по существу. "
    "Выберите no_late, если оператор дал ответ или объяснение по существу до того, как спросил о недостающих деталях, "
    "или не спрашивал вовсе, так что клиенту пришлось самому на это указать или самому сообщить детали. "
    "Выберите na только если первое сообщение клиента уже содержало всё необходимое и уточнение не требовалось."
)
CHOICE_OPTIONS = {
    "yes": "Да: оператор учёл известные детали и спросил о недостающих до своего первого ответа по существу.",
    "no_late": (
        "Нет: оператор дал ответ или объяснение по существу до того, как спросил о недостающих деталях, или не спрашивал вовсе, "
        "так что клиенту пришлось самому на это указать или самому сообщить детали."
    ),
    "na": "N/A: первое сообщение клиента уже содержало всё необходимое, уточнение не требовалось.",
}
SPLIT_EXPECTED = {
    "q_02_needed": {
        "type": "noul",
        "instructions": (
            "Выявление потребности: нужны ли были уточнения. Ответ true означает, что в первом сообщении клиента не хватало деталей, "
            "которые оператору были нужны, чтобы ответить правильно: какой счёт, заказ, период, документ, сумма. "
            "Ответ false означает, что первое сообщение клиента уже содержало всё необходимое."
        ),
        "criteria": {
            "true": (
                "Да: в первом сообщении клиента не хватало деталей, которые оператору были нужны, чтобы ответить правильно "
                "(какой счёт, заказ, период, документ, сумма)."
            ),
            "false": "Нет: первое сообщение клиента уже содержало всё необходимое для правильного ответа.",
        },
    },
    "q_02_before": {
        "type": "noul",
        "instructions": (
            "Выявление потребности: порядок реплик оператора. Найдите первый ответ оператора по существу: это не приветствие, "
            "не просьба подтвердить личность и не уточняющий вопрос. Ответ true означает, что до этого ответа есть сообщение оператора, "
            "в котором он просит клиента сообщить недостающие детали или подтверждает уже известные. "
            "Ответ false означает, что такого сообщения до первого ответа по существу нет."
        ),
        "criteria": {
            "true": (
                "Да: есть сообщение оператора, которое просит клиента сообщить недостающие детали или подтверждает известные, "
                "и оно стоит до первого ответа оператора по существу."
            ),
            "false": "Нет: до первого ответа оператора по существу такого сообщения нет.",
        },
    },
    "q_02_pushed": {
        "type": "noul",
        "instructions": (
            "Выявление потребности: инициатива клиента. Ответ true означает, что клиенту пришлось самому указать, что оператор не спросил "
            "нужное, или самому сообщить недостающие детали без запроса после ответа оператора. "
            "Ответ false означает, что клиенту этого делать не пришлось."
        ),
        "criteria": {
            "true": (
                "Да: клиент указал, что оператор не спросил нужное, или сам без запроса сообщил недостающие детали после ответа оператора."
            ),
            "false": "Нет: клиенту не пришлось ни указывать на пропущенный вопрос, ни сообщать детали без запроса.",
        },
    },
}


def conv():
    return tiny_dataset()["cases"][0]["conversation"]


def spec_list(style):
    return build_questions(CFG, style)


def test_variants_registered():
    assert VARIANTS["jev_temporal_choice"] == {"name": "jev_temporal_choice", "workflow": "jev_only", "params": {"style": "temporal_choice"}}
    assert VARIANTS["jev_temporal_split"] == {"name": "jev_temporal_split", "workflow": "jev_only", "params": {"style": "temporal_split"}}


def test_choice_texts_exact():
    body = {s.name: s.body for s in spec_list("temporal_choice")}["q_02"]
    assert body == {"type": "choice", "instructions": CHOICE_INSTRUCTIONS, "criteria": CHOICE_OPTIONS}
    assert list(body["criteria"]) == ["yes", "no_late", "na"]
    assert TEMPORAL_CHOICE_BODY == body


def test_split_texts_exact():
    bodies = {s.name: s.body for s in spec_list("temporal_split")}
    for name, expected in SPLIT_EXPECTED.items():
        assert bodies[name] == expected
    assert TEMPORAL_SPLIT_BODIES == SPLIT_EXPECTED
    assert [n for n in bodies if n.startswith("q_02")] == ["q_02_needed", "q_02_before", "q_02_pushed"]
    assert "q_02" not in bodies


@pytest.mark.parametrize("style", ["temporal_choice", "temporal_split"])
def test_other_criteria_byte_identical_to_default(style):
    default, _ = build_request(conv(), CFG)
    payload, _ = build_request(conv(), CFG, style=style)
    assert payload["state"] == default["state"]
    assert payload["model"] == default["model"]
    for name, body in default["questions"].items():
        if name != "q_02":
            assert json.dumps(payload["questions"][name], ensure_ascii=False) == json.dumps(body, ensure_ascii=False)
    others = [n for n in payload["questions"] if not n.startswith("q_02")]
    assert others == [n for n in default["questions"] if n != "q_02"]
    order = list(payload["questions"])
    assert order.index("q_01") < order.index("q_03")
    assert order[1].startswith("q_02")


def test_existing_styles_unchanged_by_temporal_support():
    for style in ("default", "rich", "split", "rich_split"):
        names = [s.name for s in build_questions(CFG, style)]
        assert "q_02" in names
        assert not any(n.startswith("q_02_") for n in names)
    assert {s.name: s.body for s in build_questions(CFG, "split")} == {s.name: s.body for s in build_questions(CFG)}


def answer_body(name_to_answer):
    return {"answers": name_to_answer}


def full_default_answers(specs, q02):
    answers = {}
    for s in specs:
        if s.name in q02:
            continue
        b = s.body
        if b["type"] == "choice":
            answers[s.name] = {"type": "choice", "choice": "yes", "probabilities": {o: (0.8 if o == "yes" else 0.1) for o in b["criteria"]}}
        elif b["type"] == "score":
            n = len(b["criteria"])
            answers[s.name] = {"type": "score", "probabilities": {str(i): (0.7 if i == n - 1 else 0.3 / (n - 1)) for i in range(n)}}
        else:
            answers[s.name] = {"type": "noul", "noul": 0.1}
    answers.update(q02)
    return answers


@pytest.mark.parametrize("choice,expected", [("yes", "yes"), ("no_late", "no"), ("na", "na")])
def test_choice_mapping_to_v2_answers(choice, expected):
    specs = spec_list("temporal_choice")
    probs = {"yes": 0.1, "no_late": 0.2, "na": 0.3}
    probs[choice] = 0.6
    body = answer_body(full_default_answers(specs, {"q_02": {"type": "choice", "choice": choice, "probabilities": probs}}))
    out = map_answers(body, specs)["02"]
    assert out["answer"] == expected
    assert out["confidence"] == 0.6
    assert out["distribution"] == {"yes": probs["yes"], "no": probs["no_late"], "na": probs["na"]}
    assert "detail" not in out


def test_choice_unknown_option_rejected():
    specs = spec_list("temporal_choice")
    body = answer_body(full_default_answers(specs, {"q_02": {"type": "choice", "choice": "no", "probabilities": {"yes": 0.1, "no_late": 0.1, "na": 0.1}}}))
    with pytest.raises(DecisionsError):
        map_answers(body, specs)


def split_body(specs, needed, before, pushed):
    q02 = {
        "q_02_needed": {"type": "noul", "noul": needed},
        "q_02_before": {"type": "noul", "noul": before},
        "q_02_pushed": {"type": "noul", "noul": pushed},
    }
    return answer_body(full_default_answers(specs, q02))


def expected_outcome(n, b, u):
    if not n:
        return "na"
    return "yes" if b and not u else "no"


@pytest.mark.parametrize("n,b,u", list(itertools.product([False, True], repeat=3)))
def test_split_all_eight_combinations(n, b, u):
    specs = spec_list("temporal_split")
    pn, pb, pu = (0.9 if n else 0.2), (0.8 if b else 0.3), (0.7 if u else 0.1)
    out = map_answers(split_body(specs, pn, pb, pu), specs)["02"]
    assert out["answer"] == expected_outcome(n, b, u)
    assert out["detail"] == {"needed": pn, "before": pb, "pushed": pu}
    assert sum(out["distribution"].values()) == pytest.approx(1.0)
    assert set(out["distribution"]) == {"yes", "no", "na"}
    if not n:
        expect = 1.0 - pn
    else:
        expect = pn * (pb if b else 1 - pb) * (pu if u else 1 - pu)
    assert out["confidence"] == pytest.approx(expect)


def test_split_threshold_is_inclusive_at_half():
    specs = spec_list("temporal_split")
    assert map_answers(split_body(specs, 0.5, 0.5, 0.49), specs)["02"]["answer"] == "yes"
    assert map_answers(split_body(specs, 0.49, 0.5, 0.49), specs)["02"]["answer"] == "na"
    assert map_answers(split_body(specs, 0.5, 0.5, 0.5), specs)["02"]["answer"] == "no"
    assert map_answers(split_body(specs, 0.5, 0.49, 0.1), specs)["02"]["answer"] == "no"


def test_split_distribution_under_independence():
    specs = spec_list("temporal_split")
    d = map_answers(split_body(specs, 0.8, 0.5, 0.25), specs)["02"]["distribution"]
    assert d["na"] == pytest.approx(0.2)
    assert d["yes"] == pytest.approx(0.8 * 0.5 * 0.75)
    assert d["no"] == pytest.approx(0.8 * (1 - 0.5 * 0.75))


def test_specs_for_questions_resolves_style_from_request():
    for style in ("default", "rich", "temporal_choice", "temporal_split"):
        payload, specs = build_request(conv(), CFG, style=style)
        resolved = specs_for_questions(CFG, payload["questions"])
        assert [s.name for s in resolved] == list(payload["questions"])
        assert [s.role for s in resolved] == [s.role for s in specs]


def test_estimate_counts_requests():
    for name in ("jev_temporal_choice", "jev_temporal_split"):
        wf = build_workflow(VARIANTS[name], CFG)
        assert wf.estimate_plan() == [("jev", "typesafe/jev-1.14", 1)]
        assert wf.expected_calls() == 1


class TemporalJev(FakeJev):
    def __init__(self, noul, **kw):
        super().__init__(**kw)
        self.noul = noul

    def post(self, payload):
        out = super().post(payload)
        answers = out["body"]["answers"]
        if "q_02" in answers:
            answers["q_02"] = {"type": "choice", "choice": "no_late", "probabilities": {"yes": 0.1, "no_late": 0.7, "na": 0.2}}
        for name, p in self.noul.items():
            if name in answers:
                answers[name] = {"type": "noul", "noul": p}
        return out


def test_temporal_choice_run_maps_no_late_to_no(tmp_path):
    jev = TemporalJev({})
    out, results, errors = run_variant(tmp_path, "jev_temporal_choice", jev)
    assert not errors
    assert len(jev.calls) == 3
    assert all(len(r["calls"]) == 1 for r in results)
    for r in results:
        assert r["results"]["02"]["answer"] == "no"
        assert r["results"]["02"]["distribution"] == {"yes": 0.1, "no": 0.7, "na": 0.2}
        assert r["results"]["01"]["answer"] == "yes"
    assert list(jev.calls[0]["questions"]["q_02"]["criteria"]) == ["yes", "no_late", "na"]


def test_temporal_split_run_keeps_detail_in_candidate(tmp_path):
    jev = TemporalJev({"q_02_needed": 0.9, "q_02_before": 0.8, "q_02_pushed": 0.6})
    out, results, errors = run_variant(tmp_path, "jev_temporal_split", jev)
    assert not errors
    assert len(jev.calls) == 3
    assert all(len(r["calls"]) == 1 for r in results)
    for r in results:
        row = r["results"]["02"]
        assert row["answer"] == "no"
        assert row["detail"] == {"needed": 0.9, "before": 0.8, "pushed": 0.6}
        assert set(row["distribution"]) == {"yes", "no", "na"}
        assert "detail" not in r["results"]["01"]
    assert {"q_02_needed", "q_02_before", "q_02_pushed"} <= set(jev.calls[0]["questions"])
    assert "q_02" not in jev.calls[0]["questions"]
