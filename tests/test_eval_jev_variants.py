import hashlib
import json
from pathlib import Path

import pytest

from evals import runner
from evals.decisions import (
    RULES_HEADER,
    DecisionsError,
    build_questions,
    build_request,
    build_split_requests,
    rich_rules_header,
)
from evals.ledger import Ledger
from evals.workflows import build_workflow
from tests.test_eval_runner_fakes import CFG, FakeAnthropic, FakeJev, default_responder, tiny_dataset

VARIANTS = runner.load_variants()
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "evals" / "runs" / "20261107-222725-jev_only-dev" / "raw"
GOLDEN_HASH = "666b4188e1de31baf381548d0cf43c47d0ffaceaeff8f14b5464f49cbfef0a60"
RICH_HEADER = "You are a strict contact-centre quality assessor. You evaluate ONLY the human operator of the conversation against the questions asked.\nBot and system messages are context only and are never evaluated as the operator. A greeting or introduction made by the bot never counts as the operator's greeting or introduction.\nClient messages are context for what the operator had to do.\nTranscripts are in Russian, Kazakh or English. Voice-call transcripts are noisy ASR output with duplicated lines, IVR/bot prompts and redaction placeholders such as [Имя скрыто]; judge the intent, not the noise.\nSystem events matter: identity verified (Личность клиента подтверждена. / Клиенттің жеке басы расталды. / Customer identity verified.), escalation to operator (Эскалация на оператора. / Чат операторға жіберілді. / Chat transferred to an agent.), chat closed by operator, client left, connection lost, recording paused or resumed, hold on or off, transfer, language switch.\nno means the action was needed but was skipped or done wrong. na may be used only when the criterion says N/A is allowed AND its stated N/A condition is actually met; otherwise choose a real answer.\nIf a criterion requires a precondition (for example verification) that was needed but is not confirmed anywhere in the conversation, the answer is no, not na.\nFor flag criteria, a clear offer or request described in the criterion is enough on its own; the client's consent or any completed action is not required."
RICH_EXPECTED = json.loads(r'''{
 "q_01": {
  "type": "choice",
  "instructions": "Установление контакта. Условие для yes: оператор поздоровался на языке клиента и представился в первом ответе. Выберите yes, если условие выполнено. Выберите no, если действие требовалось, но было пропущено или выполнено неверно. Ответ na недопустим.",
  "criteria": {
   "yes": "Да: оператор поздоровался на языке клиента и представился в первом ответе.",
   "no": "Нет: условие не выполнено (не так, что оператор поздоровался на языке клиента и представился в первом ответе); действие требовалось, но было пропущено или выполнено неверно."
  }
 },
 "q_02": {
  "type": "choice",
  "instructions": "Выявление потребности. Условие для yes: оператор учёл известные детали и уточнил недостающее до ответа. Выберите yes, если условие выполнено. Выберите no, если действие требовалось, но было пропущено или выполнено неверно. Выберите na только если: Данных для ответа хватало с самого начала. Иначе выберите yes или no.",
  "criteria": {
   "yes": "Да: оператор учёл известные детали и уточнил недостающее до ответа.",
   "no": "Нет: условие не выполнено (не так, что оператор учёл известные детали и уточнил недостающее до ответа); действие требовалось, но было пропущено или выполнено неверно.",
   "na": "N/A: Данных для ответа хватало с самого начала; критерий не применим, обычный ответ не нужен."
  }
 },
 "q_03": {
  "type": "choice",
  "instructions": "Идентификация. Условие для yes: Проверка личности подтверждена до раскрытия данных или защищённого действия. Выберите yes, если условие выполнено. Выберите no, если действие требовалось, но было пропущено или выполнено неверно. Выберите na только если: Запрос не требовал идентификации. Иначе выберите yes или no.",
  "criteria": {
   "yes": "Да: Проверка личности подтверждена до раскрытия данных или защищённого действия.",
   "no": "Нет: условие не выполнено (не так, что Проверка личности подтверждена до раскрытия данных или защищённого действия); действие требовалось, но было пропущено или выполнено неверно.",
   "na": "N/A: Запрос не требовал идентификации; критерий не применим, обычный ответ не нужен."
  }
 },
 "q_04": {
  "type": "score",
  "instructions": "Корректная и полная консультация. Оцените ответ или следующий шаг по шкале ниже. Шаги шкалы (значение — описание): 0 — Ответа по существу нет или ключевая рекомендация ошибочна; 5 — Есть общая подсказка, но клиенту всё ещё непонятно, как действовать; 10 — Часть запроса закрыта, существенный вопрос остался открытым; 15 — Основной вопрос решён, пропущена второстепенная деталь; 20 — Все существенные вопросы закрыты или дан корректный следующий шаг. Выберите наивысший шаг, описание которого выполняется полностью.",
  "criteria": [
   "Ответа по существу нет или ключевая рекомендация ошибочна.",
   "Есть общая подсказка, но клиенту всё ещё непонятно, как действовать.",
   "Часть запроса закрыта, существенный вопрос остался открытым.",
   "Основной вопрос решён, пропущена второстепенная деталь.",
   "Все существенные вопросы закрыты или дан корректный следующий шаг."
  ]
 },
 "q_04__na": {
  "type": "noul",
  "instructions": "Выполняется ли условие N/A для критерия «Корректная и полная консультация»? Условие N/A: Чат закончился до того, как клиент сформулировал запрос.",
  "criteria": {
   "true": "Условие N/A выполнено: Чат закончился до того, как клиент сформулировал запрос.",
   "false": "Условие N/A не выполнено; применим обычный ответ по шкале."
  }
 },
 "q_05": {
  "type": "choice",
  "instructions": "Эмпатия и клиентоориентированность. Условие для yes: Оператор вежлив и, если клиент выразил недовольство или описал неудобство, отреагировал на конкретную проблему. Выберите yes, если условие выполнено. Выберите no, если действие требовалось, но было пропущено или выполнено неверно. Ответ na недопустим.",
  "criteria": {
   "yes": "Да: Оператор вежлив и, если клиент выразил недовольство или описал неудобство, отреагировал на конкретную проблему.",
   "no": "Нет: условие не выполнено (не так, что Оператор вежлив и, если клиент выразил недовольство или описал неудобство, отреагировал на конкретную проблему); действие требовалось, но было пропущено или выполнено неверно."
  }
 },
 "q_06": {
  "type": "score",
  "instructions": "Управление диалогом, скорость и грамотность. Оцените ясность, порядок ответов и предупреждение об ожидании по шкале ниже. Шаги шкалы (значение — описание): 0 — Из-за бессвязных или противоречивых реплик ход диалога непонятен; 4 — Клиенту приходится переспрашивать из-за формулировок или порядка ответов; 7 — Один заметный сбой, но клиент может понять ответ и продолжить; 10 — Ответы ясные и связные. Если было явное ожидание, оператор предупредил. Выберите наивысший шаг, описание которого выполняется полностью.",
  "criteria": [
   "Из-за бессвязных или противоречивых реплик ход диалога непонятен",
   "Клиенту приходится переспрашивать из-за формулировок или порядка ответов.",
   "Один заметный сбой, но клиент может понять ответ и продолжить.",
   "Ответы ясные и связные. Если было явное ожидание, оператор предупредил."
  ]
 },
 "q_07": {
  "type": "choice",
  "instructions": "Завершение. Условие для yes: Оператор подвёл итог или предложил дальнейшую помощь и попрощался. Выберите yes, если условие выполнено. Выберите no, если действие требовалось, но было пропущено или выполнено неверно. Выберите na только если: Чат оборвался до возможности его завершить. Иначе выберите yes или no.",
  "criteria": {
   "yes": "Да: Оператор подвёл итог или предложил дальнейшую помощь и попрощался.",
   "no": "Нет: условие не выполнено (не так, что Оператор подвёл итог или предложил дальнейшую помощь и попрощался); действие требовалось, но было пропущено или выполнено неверно.",
   "na": "N/A: Чат оборвался до возможности его завершить; критерий не применим, обычный ответ не нужен."
  }
 },
 "q_08": {
  "type": "noul",
  "instructions": "Грубые ошибки. Ответ true означает, что нарушение выявлено, то есть выявлено одно из: (1) оскорбление клиента; (2) предложение платной услуги в обход компании; (3) раскрытие конфиденциальной информации. Ответ false означает, что нарушения нет: ни одно из трёх не выявлено.",
  "criteria": {
   "true": "Нарушение есть, выявлено одно из: (1) оскорбление клиента; (2) предложение платной услуги в обход компании; (3) раскрытие конфиденциальной информации.",
   "false": "Нарушения нет: ни одно из трёх не выявлено."
  }
 }
}''')


def conv():
    return tiny_dataset()["cases"][0]["conversation"]


def digest(payload):
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def run_variant(tmp_path, name, jev):
    dataset = tiny_dataset()
    ex = runner.Executor(
        CFG, mode="live", sdk=FakeAnthropic(default_responder), jev_client=jev,
        ledger=Ledger(tmp_path / "ledger.json"), concurrency=2, sleep=lambda s: None, poll_initial=0,
    )
    out = runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run(VARIANTS[name], dataset["cases"], "all", 1, run_id=f"t-{name}")
    results = json.loads((tmp_path / "runs" / out["run_id"] / "results.json").read_text(encoding="utf-8"))
    errors = json.loads((tmp_path / "runs" / out["run_id"] / "errors.json").read_text(encoding="utf-8"))
    return out, results, errors


def test_default_request_is_unchanged_golden():
    payload, _ = build_request(conv(), CFG)
    assert digest(payload) == GOLDEN_HASH
    assert payload["state"][0] == RULES_HEADER
    explicit, _ = build_request(conv(), CFG, style="default")
    assert explicit == payload


def test_default_request_matches_recorded_raw_payload():
    files = sorted(RAW_DIR.glob("*.json"))
    if not files:
        pytest.skip("recorded raw payloads are gitignored and absent on a clean checkout (e.g. CI)")
    dataset = json.loads((ROOT / "evals" / "dataset.json").read_text(encoding="utf-8"))
    sent = json.loads(files[0].read_text(encoding="utf-8"))["request"]["params"]
    built = [build_request(c["conversation"], CFG)[0] for c in dataset["cases"]]
    assert sent in built


def test_default_variant_params_unchanged_and_new_variants_registered():
    assert VARIANTS["jev_only"]["params"] == {}
    assert VARIANTS["jev_rich"]["params"] == {"style": "rich"}
    assert VARIANTS["jev_split"]["params"] == {"style": "split"}
    assert VARIANTS["jev_rich_split"]["params"] == {"style": "rich_split"}
    for name in ("jev_rich", "jev_split", "jev_rich_split"):
        assert VARIANTS[name]["workflow"] == "jev_only"


def test_unknown_style_rejected():
    with pytest.raises(ValueError):
        build_questions(CFG, "bogus")


def test_rich_header_uses_judging_rules_only():
    assert rich_rules_header() == RICH_HEADER
    assert "Return one result object" not in RICH_HEADER
    assert "RATIONALE" not in RICH_HEADER
    assert "Evidence:" not in RICH_HEADER
    payload, _ = build_request(conv(), CFG, style="rich")
    assert payload["state"][0] == RICH_HEADER
    assert payload["state"][1:] == build_request(conv(), CFG)[0]["state"][1:]


@pytest.mark.parametrize("cid", ["01", "02", "03", "04", "05", "06", "07", "08"])
def test_rich_texts_exact(cid):
    specs = {s.name: s.body for s in build_questions(CFG, "rich")}
    for name, body in specs.items():
        if name.startswith(f"q_{cid}"):
            assert body == RICH_EXPECTED[name]
    assert f"q_{cid}" in specs


def test_rich_option_keys_and_scale_values_match_default():
    rich = build_questions(CFG, "rich")
    default = build_questions(CFG)
    assert [s.name for s in rich] == [s.name for s in default]
    assert [s.steps for s in rich] == [s.steps for s in default]
    for r, d in zip(rich, default):
        assert r.body["type"] == d.body["type"]
        if isinstance(d.body["criteria"], dict):
            assert list(r.body["criteria"]) == list(d.body["criteria"])
        else:
            assert r.body["criteria"] == d.body["criteria"]


def test_rich_has_no_dangling_page_reference():
    blob = json.dumps(build_request(conv(), CFG, style="rich")[0]["questions"], ensure_ascii=False)
    assert "стр." not in blob
    assert "на стр" not in blob
    assert "по шкале на" not in blob
    assert "по шкале ниже" in blob


def test_rich_scale_lists_steps_with_values_and_tie_break():
    body = RICH_EXPECTED["q_04"]["instructions"]
    for value in (0, 5, 10, 15, 20):
        assert f"{value} — " in body
    assert body.endswith("Выберите наивысший шаг, описание которого выполняется полностью.")


def test_rich_flag_spells_out_three_violation_types():
    crit = RICH_EXPECTED["q_08"]["criteria"]
    for kind in ("оскорбление клиента", "предложение платной услуги в обход компании", "раскрытие конфиденциальной информации"):
        assert kind in crit["true"]
    assert crit["false"] == "Нарушения нет: ни одно из трёх не выявлено."


def test_split_requests_one_per_criterion_with_full_state():
    full, _ = build_request(conv(), CFG)
    parts = build_split_requests(conv(), CFG)
    assert [cid for cid, _, _ in parts] == [c.id for c in CFG.criteria]
    names = []
    for cid, payload, specs in parts:
        assert payload["state"] == full["state"]
        assert payload["model"] == full["model"]
        assert all(s.criterion_id == cid for s in specs)
        for name, body in payload["questions"].items():
            assert full["questions"][name] == body
        names += list(payload["questions"])
    assert names == list(full["questions"])
    assert set(parts[3][1]["questions"]) == {"q_04", "q_04__na"}


def test_rich_split_combines_both():
    full, _ = build_request(conv(), CFG, style="rich")
    parts = build_split_requests(conv(), CFG, style="rich_split")
    assert len(parts) == 8
    assert parts[0][1]["state"] == full["state"]
    merged = {}
    for _, payload, _ in parts:
        merged.update(payload["questions"])
    assert merged == full["questions"]


def test_estimate_plan_counts_requests():
    plans = {n: build_workflow(VARIANTS[n], CFG).estimate_plan() for n in ("jev_only", "jev_rich", "jev_split", "jev_rich_split")}
    assert plans["jev_only"] == [("jev", "typesafe/jev-1.14", 1)]
    assert plans["jev_rich"] == [("jev", "typesafe/jev-1.14", 1)]
    assert plans["jev_split"] == [("jev", "typesafe/jev-1.14", 8)]
    assert plans["jev_rich_split"] == [("jev", "typesafe/jev-1.14", 8)]
    assert build_workflow(VARIANTS["jev_split"], CFG).expected_calls() == 8
    assert build_workflow(VARIANTS["jev_only"], CFG).expected_calls() == 1


def test_default_run_sends_single_request(tmp_path):
    jev = FakeJev()
    out, results, errors = run_variant(tmp_path, "jev_only", jev)
    assert len(jev.calls) == 3
    assert not errors
    assert all(len(r["calls"]) == 1 for r in results)


def test_rich_run_sends_single_request_with_rich_text(tmp_path):
    jev = FakeJev()
    out, results, errors = run_variant(tmp_path, "jev_rich", jev)
    assert len(jev.calls) == 3
    assert not errors
    assert jev.calls[0]["questions"] == RICH_EXPECTED
    assert len(results) == 3


class ThreadSafeJev(FakeJev):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.bad = set()

    def post(self, payload):
        if set(payload["questions"]) & self.bad:
            raise DecisionsError("server", "boom", 500, 4)
        return super().post(payload)


def test_split_run_merges_answers_and_sums_usage(tmp_path):
    jev = ThreadSafeJev(usage={"input_tokens": 1000, "output_tokens": 0, "cost": None})
    out, results, errors = run_variant(tmp_path, "jev_split", jev)
    assert not errors
    assert len(jev.calls) == 3 * 8
    for payload in jev.calls:
        assert payload["state"][1].startswith("Conversation metadata")
    assert len(results) == 3
    for r in results:
        assert sorted(r["results"]) == [c.id for c in CFG.criteria]
        assert not r["needs_review"]
        assert len(r["calls"]) == 8
        assert sum(c["input_tokens"] for c in r["calls"]) == 8000
        assert sum(c["cost"] for c in r["calls"]) == pytest.approx(8000 * 0.042 / 1e6, abs=1e-5)
        assert r["results"]["01"]["answer"] == "yes"
        assert r["results"]["04"]["answer"] == 20
        assert r["results"]["08"]["answer"] == "no"
    assert out["meta"]["expected_calls"] == 8
    assert out["meta"]["usage"]["total"]["cost"] == pytest.approx(3 * 8000 * 0.042 / 1e6, abs=1e-4)


def test_rich_split_run_uses_rich_text_per_request(tmp_path):
    jev = ThreadSafeJev()
    out, results, errors = run_variant(tmp_path, "jev_rich_split", jev)
    assert not errors
    assert len(jev.calls) == 24
    seen = {}
    for payload in jev.calls:
        assert payload["state"][0] == RICH_HEADER
        seen.update(payload["questions"])
    assert seen == RICH_EXPECTED


def test_split_failure_is_infrastructure_error_not_wrong_answer(tmp_path):
    jev = ThreadSafeJev()
    jev.bad = {"q_06"}
    out, results, errors = run_variant(tmp_path, "jev_split", jev)
    assert results == []
    assert len(errors) == 3
    assert {e["kind"] for e in errors} == {"infrastructure"}
    assert {e["request_id"] for e in errors} == {"jev_06"}
    assert out["n_errors"] == 3
    assert out["meta"]["status"] == "incomplete"
