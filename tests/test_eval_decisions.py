import json
from pathlib import Path

import pytest

from backend.app.schemas.checklist import ChecklistConfig
from evals import decisions as d

CFG = ChecklistConfig.model_validate(json.loads((Path(__file__).parent.parent / "evals" / "checklist_v2.json").read_text()))
CONV = {
    "channel": "chat",
    "language": "ru",
    "messages": [
        {"message_index": 0, "timestamp_raw": "10:00", "speaker": "client", "text": "Привет"},
        {"message_index": 1, "timestamp_raw": "10:01", "speaker": "operator", "text": "Здравствуйте"},
    ],
}


def choice(pick, probs):
    return {"type": "choice", "choice": pick, "confidence": probs.get(pick, 0), "probabilities": probs}


def score(idx, probs):
    return {"type": "score", "score": float(idx), "confidence": 1, "probabilities": probs}


def noul(p):
    return {"type": "noul", "noul": p}


def full_answers():
    return {
        "q_01": choice("yes", {"yes": 0.9, "no": 0.1}),
        "q_02": choice("na", {"yes": 0.1, "no": 0.2, "na": 0.7}),
        "q_03": choice("no", {"yes": 0.3, "no": 0.6, "na": 0.1}),
        "q_04": score(3, {"0": 0, "1": 0.1, "2": 0.2, "3": 0.6, "4": 0.1}),
        "q_04__na": noul(0.2),
        "q_05": choice("yes", {"yes": 0.8, "no": 0.2}),
        "q_06": score(2, {"0": 0, "1": 0.2, "2": 0.3, "3": 0.5}),
        "q_07": choice("yes", {"yes": 0.55, "no": 0.35, "na": 0.1}),
        "q_08": noul(0.1),
    }


def body(answers=None, usage=None):
    b = {"answers": answers or full_answers()}
    if usage is not None:
        b["usage"] = usage
    return b


class Fake:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, headers, payload, timeout):
        self.calls.append((url, headers, payload, timeout))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def ok(b=None):
    return d.TransportResponse(200, b or body())


def make_client(responses, **kw):
    t = Fake(responses)
    sleeps = []
    clock = kw.pop("clock", None)
    c = d.DecisionsClient(api_key="k", transport=t, sleep=sleeps.append, rng=lambda: 1.0, clock=clock or (lambda: 0.0), **kw)
    return c, t, sleeps


def test_checklist_has_expected_shape():
    assert [c.type for c in CFG.criteria] == ["yes_no", "yes_no", "yes_no", "scale", "yes_no", "scale", "yes_no", "flag"]


def test_yes_no_without_na():
    specs = {s.name: s for s in d.build_questions(CFG)}
    q = specs["q_01"].body
    assert q["type"] == "choice"
    assert list(q["criteria"]) == ["yes", "no"]
    assert "Установление контакта" in q["instructions"]
    assert "поздоровался" in q["instructions"]


def test_yes_no_with_na_uses_na_condition():
    specs = {s.name: s for s in d.build_questions(CFG)}
    q = specs["q_02"].body
    assert list(q["criteria"]) == ["yes", "no", "na"]
    assert q["criteria"]["na"] == "Данных для ответа хватало с самого начала."
    assert specs["q_03"].body["criteria"]["na"] == "Запрос не требовал идентификации."
    assert list(specs["q_07"].body["criteria"]) == ["yes", "no", "na"]


def test_scale_with_na_has_score_and_noul():
    specs = {s.name: s for s in d.build_questions(CFG)}
    q = specs["q_04"].body
    assert q["type"] == "score"
    assert isinstance(q["criteria"], list) and len(q["criteria"]) == 5
    assert q["criteria"][0].startswith("Ответа по существу нет")
    assert specs["q_04"].steps == [0, 5, 10, 15, 20]
    na = specs["q_04__na"].body
    assert na["type"] == "noul"
    assert na["criteria"]["true"] == "Чат закончился до того, как клиент сформулировал запрос."
    assert set(na["criteria"]) == {"true", "false"}


def test_scale_without_na_has_single_question():
    names = [s.name for s in d.build_questions(CFG)]
    assert "q_06" in names and "q_06__na" not in names
    assert len(names) == 9


def test_flag_is_noul_true_means_violation():
    q = {s.name: s for s in d.build_questions(CFG)}["q_08"].body
    assert q["type"] == "noul"
    assert "оскорбление" in q["criteria"]["true"]
    assert q["criteria"]["false"] == "No violation is present."


def test_scale_steps_sorted_ascending_even_if_input_shuffled():
    cfg = ChecklistConfig.model_validate(
        {
            "name": "x",
            "criteria": [
                {
                    "id": "a",
                    "title": "T",
                    "type": "scale",
                    "scale_steps": [{"value": 10, "descriptor": "top"}, {"value": 0, "descriptor": "bottom"}],
                }
            ],
        }
    )
    s = d.build_questions(cfg)[0]
    assert s.steps == [0, 10]
    assert s.body["criteria"] == ["bottom", "top"]


def test_state_format_matches_transcript_lines():
    state = d.build_state(CONV)
    assert state[0] == d.RULES_HEADER
    assert state[1] == "Conversation metadata: channel=chat, language=ru, messages=2"
    assert state[2] == "Transcript:\n[#0 | 10:00 | client] Привет\n[#1 | 10:01 | operator] Здравствуйте"


def test_state_handles_missing_fields():
    state = d.build_state({"messages": [{"message_index": 4, "text": None}]})
    assert "[#4 |  | ] " in state[2]


def test_request_payload():
    payload, specs = d.build_request(CONV, CFG)
    assert payload["model"] == "typesafe/jev-1.14"
    assert list(payload["questions"]) == [s.name for s in specs]
    json.dumps(payload, ensure_ascii=False)


def test_answer_mapping_choice():
    specs = d.build_questions(CFG)
    out = d.map_answers(body(), specs)
    assert out["01"] == {"answer": "yes", "confidence": 0.9, "distribution": {"yes": 0.9, "no": 0.1}}
    assert out["02"]["answer"] == "na" and out["02"]["confidence"] == 0.7
    assert out["03"]["answer"] == "no" and out["03"]["confidence"] == 0.6
    assert out["07"]["confidence"] == 0.55


def test_answer_mapping_scale_back_to_step_values():
    out = d.map_answers(body(), d.build_questions(CFG))
    assert out["04"]["answer"] == "15"
    assert out["04"]["confidence"] == pytest.approx(0.6 * 0.8)
    assert set(out["04"]["distribution"]) == {"na", "0", "5", "10", "15", "20"}
    assert out["06"]["answer"] == "10"
    assert out["06"]["confidence"] == 0.5
    assert set(out["06"]["distribution"]) == {"0", "4", "7", "10"}


def test_na_overrides_scale():
    a = full_answers()
    a["q_04__na"] = noul(0.8)
    out = d.map_answers(body(a), d.build_questions(CFG))
    assert out["04"]["answer"] == "na"
    assert out["04"]["confidence"] == 0.8


def test_flag_mapping():
    a = full_answers()
    out = d.map_answers(body(a), d.build_questions(CFG))
    assert out["08"]["answer"] == "no"
    assert out["08"]["confidence"] == pytest.approx(0.9)
    a["q_08"] = noul(0.97)
    out = d.map_answers(body(a), d.build_questions(CFG))
    assert out["08"]["answer"] == "yes"
    assert out["08"]["confidence"] == 0.97


@pytest.mark.parametrize(
    "mutate",
    [
        lambda a: a.pop("q_03"),
        lambda a: a.__setitem__("q_01", choice("maybe", {"yes": 0.5, "no": 0.5})),
        lambda a: a.__setitem__("q_01", {"type": "choice", "choice": "yes"}),
        lambda a: a.__setitem__("q_08", {"type": "choice", "choice": "yes", "probabilities": {}}),
        lambda a: a.__setitem__("q_08", noul("high")),
        lambda a: a.__setitem__("q_08", noul(1.5)),
        lambda a: a.pop("q_04__na"),
    ],
)
def test_bad_answers_raise_malformed(mutate):
    a = full_answers()
    mutate(a)
    with pytest.raises(d.DecisionsError) as e:
        d.map_answers(body(a), d.build_questions(CFG))
    assert e.value.kind == "malformed"


def test_client_success_records_latency_attempts_usage():
    ticks = iter([0.0, 0.0, 0.25])
    c, t, _ = make_client([ok(body(usage={"input_tokens": 100, "output_tokens": 5, "cost": 1e-5}))], clock=lambda: next(ticks))
    r = c.post({"x": 1})
    assert r["attempts"] == 1
    assert r["latency_ms"] == 250.0
    assert r["usage"] == {"input_tokens": 100, "output_tokens": 5, "cost": 1e-5}
    assert t.calls[0][1]["Authorization"] == "Bearer k"


def test_retry_on_429_then_success_with_backoff():
    c, t, sleeps = make_client([d.TransportResponse(429, {"error": "slow"}), d.TransportResponse(503, {}), ok()])
    r = c.post({})
    assert r["attempts"] == 3
    assert sleeps == [0.5, 1.0]
    assert len(t.calls) == 3


def test_backoff_is_jittered_and_capped():
    c, _, _ = make_client([], backoff_cap=2.0)
    c.rng = lambda: 0.0
    assert c.backoff(1, None) == 0.25
    c.rng = lambda: 1.0
    assert c.backoff(10, None) == 2.0
    assert c.backoff(1, 1.5) == 1.5


def test_retry_after_header_respected():
    c, _, sleeps = make_client([d.TransportResponse(429, {}, {"Retry-After": "3"}), ok()])
    c.post({})
    assert sleeps == [3.0]


def test_retries_exhausted_raises_last_error():
    c, t, sleeps = make_client([d.TransportResponse(500, {"error": {"message": "boom"}})] * 3, max_attempts=3)
    with pytest.raises(d.DecisionsError) as e:
        c.post({})
    assert e.value.kind == "server" and e.value.status == 500 and e.value.attempts == 3
    assert "boom" in e.value.message
    assert len(sleeps) == 2


@pytest.mark.parametrize("status,kind", [(400, "client"), (401, "auth"), (402, "payment"), (403, "auth"), (422, "client")])
def test_non_retryable_errors_fail_immediately(status, kind):
    c, t, sleeps = make_client([d.TransportResponse(status, {"error": "no"}), ok()])
    with pytest.raises(d.DecisionsError) as e:
        c.post({})
    assert e.value.kind == kind
    assert len(t.calls) == 1 and sleeps == []


def test_network_and_timeout_errors_are_retried():
    c, t, _ = make_client([d.TransportError("timeout"), d.TransportError("network"), ok()])
    assert c.post({})["attempts"] == 3


def test_ceiling_stops_retries():
    now = [0.0]

    def sleep(s):
        now[0] += s

    t = Fake([d.TransportResponse(503, {})] * 10)
    c = d.DecisionsClient(api_key="k", transport=t, sleep=sleep, rng=lambda: 1.0, clock=lambda: now[0], max_total_seconds=1.0, max_attempts=10)
    with pytest.raises(d.DecisionsError) as e:
        c.post({})
    assert e.value.kind == "ceiling"
    assert len(t.calls) < 10


def test_per_attempt_timeout_clamped_to_remaining():
    c, t, _ = make_client([ok()], timeout=30.0, max_total_seconds=5.0)
    c.post({})
    assert t.calls[0][3] == 5.0


def test_malformed_200_not_retried():
    c, t, _ = make_client([d.TransportResponse(200, {"oops": 1}), ok()])
    with pytest.raises(d.DecisionsError) as e:
        c.post({})
    assert e.value.kind == "malformed" and len(t.calls) == 1


def test_missing_key_raises_auth_without_calling(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(d, "load_api_key", lambda *a, **k: None)
    t = Fake([])
    c = d.DecisionsClient(transport=t)
    with pytest.raises(d.DecisionsError) as e:
        c.post({})
    assert e.value.kind == "auth" and t.calls == []


def test_error_text_never_contains_key():
    c, _, _ = make_client([d.TransportResponse(401, {"error": "bad"})])
    with pytest.raises(d.DecisionsError) as e:
        c.post({})
    assert "Bearer" not in str(e.value) and "k" != str(e.value)


def test_load_api_key_env_then_dotenv(tmp_path):
    f = tmp_path / ".env"
    f.write_text("A=1\nOPENROUTER_API_KEY=\n")
    assert d.load_api_key({}, f) is None
    f.write_text('# c\nOPENROUTER_API_KEY="abc"\n')
    assert d.load_api_key({}, f) == "abc"
    assert d.load_api_key({"OPENROUTER_API_KEY": "envkey"}, f) == "envkey"
    assert d.load_api_key({}, tmp_path / "missing") is None


def test_decide_with_reported_usage():
    c, t, _ = make_client([ok(body(usage={"input_tokens": 1000000, "output_tokens": 0}))])
    r = d.decide(CONV, CFG, client=c)
    assert r["cost"] == pytest.approx(0.042)
    assert r["cost_detail"]["estimated"] is False
    assert r["answers"]["01"]["answer"] == "yes"
    assert r["usage"]["input_tokens"] == 1000000
    assert r["raw"]["answers"]["q_08"]["noul"] == 0.1
    assert set(r["answers"]) == {c.id for c in CFG.criteria}
    assert t.calls[0][2]["model"] == "typesafe/jev-1.14"


def test_decide_estimates_cost_when_no_usage():
    c, _, _ = make_client([ok()])
    r = d.decide(CONV, CFG, client=c)
    assert r["usage"] is None
    assert r["cost_detail"]["estimated"] is True
    assert r["cost"] == pytest.approx(r["cost_detail"]["input_tokens"] * 0.042 / 1e6)
    assert r["cost"] > 0


def test_decide_propagates_errors_without_answers():
    c, _, _ = make_client([d.TransportResponse(500, {})] * 4)
    with pytest.raises(d.DecisionsError):
        d.decide(CONV, CFG, client=c)
