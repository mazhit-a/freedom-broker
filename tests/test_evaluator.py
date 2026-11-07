import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.schemas.checklist import ChecklistConfig
from backend.app.services import checklist as checklist_service
from backend.app.services.evaluator import (
    build_schema,
    build_system_prompt,
    build_user_prompt,
    evaluate_conversation,
    quote_matches,
)
from backend.app.services.llm_client import LLMClient

MSGS = [
    ("00:01", "client", "Здравствуйте, у меня вопрос по счету"),
    ("00:05", "bot", "Добро пожаловать в Freedom Broker"),
    ("00:20", "system", "Эскалация на оператора."),
    ("00:40", "operator", "Здравствуйте, меня зовут Анна, чем могу помочь?"),
    ("01:00", "client", "Как открыть счет?"),
    ("01:30", "operator", "Нужно подать заявку в приложении, я подскажу шаги"),
    ("02:00", "client", "Спасибо"),
    ("02:10", "operator", "Всего доброго, до свидания"),
]


def ev(idx, quote):
    return [{"message_index": idx, "quote": quote}]


def good_results():
    return {
        "01": ("yes", "Оператор поздоровался и представился.", ev(3, "меня зовут Анна"), None, None),
        "02": ("yes", "Оператор уточнил запрос клиента.", ev(5, "подать заявку в приложении"), None, None),
        "03": ("na", "Идентификация не требовалась.", [], None, "Общий вопрос, проверка личности не нужна."),
        "04": (15, "Основной вопрос решен.", ev(5, "подать заявку"), None, None),
        "05": ("yes", "Оператор был вежлив.", ev(5, "я подскажу шаги"), None, None),
        "06": (7, "Одна заметная шероховатость.", ev(5, "подсказку"), None, None),
        "07": ("yes", "Оператор попрощался.", ev(7, "до свидания"), None, None),
        "08": ("no", "Грубых нарушений нет.", [], None, None),
    }


def payload(results):
    out = []
    for cid, (ans, rat, evd, rng, na) in results.items():
        out.append(
            {
                "criterion_id": cid,
                "answer": str(ans),
                "rationale": rat,
                "evidence": evd,
                "checked_range": rng,
                "na_reason": na,
            }
        )
    return json.dumps({"results": out}, ensure_ascii=False)


def fixed_good():
    r = good_results()
    r["06"] = (7, "Одна заметная шероховатость.", ev(5, "я подскажу шаги"), None, None)
    return r


class FakeSDK:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        text, stop, usage = item if isinstance(item, tuple) else (item, "end_turn", None)
        usage = usage or dict(input_tokens=100, output_tokens=50, cache_read_input_tokens=0, cache_creation_input_tokens=0)
        content = [SimpleNamespace(type="text", text=text)] if text is not None else []
        return SimpleNamespace(content=content, stop_reason=stop, usage=SimpleNamespace(**usage))


class StatusError(Exception):
    def __init__(self, status_code, msg="bad"):
        super().__init__(msg)
        self.status_code = status_code


def make_client(responses, **settings):
    sdk = FakeSDK(responses)
    s = config.Settings(**settings)
    return LLMClient(sdk=sdk, settings=s), sdk


@pytest.fixture
def db(tmp_path):
    path = str(tmp_path / "e.db")
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    yield conn
    conn.close()


def add_conversation(conn, messages=MSGS, cid="p1-ru-001", channel="agent chat", language="RU"):
    ds = conn.execute("INSERT INTO dataset (group_id) VALUES (?)", (f"g-{cid}",)).lastrowid
    pk = conn.execute(
        "INSERT INTO conversation (dataset_id, conversation_id, channel, language) VALUES (?,?,?,?)",
        (ds, cid, channel, language),
    ).lastrowid
    for i, (ts, sp, tx) in enumerate(messages):
        conn.execute(
            "INSERT INTO message (conversation_id, message_index, timestamp_raw, offset_seconds, speaker, text) VALUES (?,?,?,?,?,?)",
            (pk, i, ts, float(i), sp, tx),
        )
    conn.commit()
    return pk


def version_id(conn):
    return conn.execute("SELECT default_version_id FROM checklist").fetchone()[0]


def crit(evaluation, cid):
    return next(c for c in evaluation["criteria"] if c["criterion_id"] == cid)


def test_prompt_structure_and_request_shape(db):
    pk = add_conversation(db)
    client, sdk = make_client([payload(fixed_good())], llm_effort="medium")
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert len(sdk.calls) == 1
    call = sdk.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["output_config"]["effort"] == "medium"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert "thinking" not in call and "tool_choice" not in call and "temperature" not in call
    system = call["system"]
    assert system[0]["cache_control"] == {"type": "ephemeral"}
    assert "Main question solved, minor detail missed" in system[0]["text"]
    assert "[#0 |" not in system[0]["text"]
    user = call["messages"][0]["content"]
    assert "[#3 | 00:40 | operator] Здравствуйте, меня зовут Анна" in user
    assert result["status"] == "completed"
    assert result["total"] == 88.13


def test_happy_path_persists_scores_tokens_cost(db):
    pk = add_conversation(db)
    usage = dict(input_tokens=1000, output_tokens=500, cache_read_input_tokens=2000, cache_creation_input_tokens=300)
    client, _ = make_client([(payload(fixed_good()), "end_turn", usage)])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert result["status"] == "completed" and not result["provisional"]
    assert result["total"] == 88.13
    assert result["tokens_input"] == 1000 and result["tokens_output"] == 500
    assert result["tokens_cache_read"] == 2000 and result["tokens_cache_write"] == 300
    expected = (1000 * 4 + 500 * 20 + 2000 * 0.2 + 300 * 5.0) / 1_000_000
    assert result["cost"] == pytest.approx(expected)
    assert result["model"] == "claude-opus-5-5" and result["prompt_version"]
    assert result["latency_ms"] is not None and result["gross_violation"] is False
    c3 = crit(result, "03")
    assert c3["answer"] == "na" and c3["na_reason"].startswith("Общий вопрос")
    assert crit(result, "04")["answer"] == "15" and crit(result, "04")["points"] == pytest.approx(15)
    assert crit(result, "01")["evidence"] == ev(3, "меня зовут Анна")


def test_gross_violation_flag(db):
    pk = add_conversation(db)
    r = fixed_good()
    r["08"] = ("yes", "Оператор предложил личную платную консультацию.", ev(5, "я подскажу шаги"), None, None)
    client, _ = make_client([payload(r)])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert result["gross_violation"] is True
    assert crit(result, "08")["answer"] == "yes"


def test_bad_index_repaired_on_retry(db):
    pk = add_conversation(db)
    bad = fixed_good()
    bad["01"] = ("yes", "Оператор поздоровался.", ev(99, "меня зовут Анна"), None, None)
    client, sdk = make_client([payload(bad), payload({"01": fixed_good()["01"]})])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert len(sdk.calls) == 2
    repair_user = sdk.calls[1]["messages"][-1]["content"]
    assert "does not exist" in repair_user and "01" in repair_user
    assert sdk.calls[1]["system"] == sdk.calls[0]["system"]
    assert result["status"] == "completed" and not crit(result, "01")["needs_review"]
    assert result["tokens_input"] == 200


def test_bad_index_twice_needs_review(db):
    pk = add_conversation(db)
    bad = fixed_good()
    bad["01"] = ("yes", "Оператор поздоровался.", ev(99, "x"), None, None)
    client, sdk = make_client([payload(bad), payload({"01": bad["01"]})])
    result = evaluate_conversation(db, pk, version_id(db), client)
    c1 = crit(result, "01")
    assert c1["needs_review"] and c1["answer"] == "needs_review" and c1["points"] is None
    assert result["status"] == "needs_review" and result["provisional"] is True
    assert result["total"] is not None
    assert not crit(result, "02")["needs_review"]


def test_bad_na_triggers_retry_then_needs_review(db):
    pk = add_conversation(db)
    bad = fixed_good()
    bad["05"] = ("na", "Не применимо.", [], None, "Нет причины")
    client, sdk = make_client([payload(bad), payload({"05": bad["05"]})])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert len(sdk.calls) == 2
    assert "N/A is not allowed" in sdk.calls[1]["messages"][-1]["content"]
    assert crit(result, "05")["needs_review"]


def test_no_without_checked_range_repaired_then_stored(db):
    pk = add_conversation(db)
    bad = fixed_good()
    bad["07"] = ("no", "Оператор не попрощался.", ev(5, "я подскажу шаги"), None, None)
    fixed = {"07": ("no", "Оператор не попрощался.", ev(5, "я подскажу шаги"), {"from": 5, "to": 7}, None)}
    client, sdk = make_client([payload(bad), payload(fixed)])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert "checked_range is required" in sdk.calls[1]["messages"][-1]["content"]
    c7 = crit(result, "07")
    assert not c7["needs_review"] and c7["answer"] == "no"
    assert c7["checked_range"] == {"from": 5, "to": 7}
    assert c7["points"] == 0


def test_no_without_checked_range_twice_needs_review(db):
    pk = add_conversation(db)
    bad = fixed_good()
    bad["07"] = ("no", "Оператор не попрощался.", [], None, None)
    client, _ = make_client([payload(bad), payload({"07": bad["07"]})])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert crit(result, "07")["needs_review"]


def test_fuzzy_quote_matching():
    text = "Ну здравствуйте, меня зовут Анна, чем могу вам помочь сегодня?"
    assert quote_matches("меня зовут Анна", text)
    assert quote_matches("Меня завут Анна, чем могу вам помочь", text)
    assert quote_matches("здраствуйте меня зовут Анна чем могу вам помоч", text)
    assert not quote_matches("мы гарантируем доходность двадцать процентов годовых", text)
    assert not quote_matches("", text)


def test_fuzzy_asr_quote_accepted_in_evaluation(db):
    pk = add_conversation(db)
    r = fixed_good()
    r["01"] = ("yes", "Оператор поздоровался и представился.", ev(3, "Здраствуйте, меня зовут Ана"), None, None)
    client, sdk = make_client([payload(r)])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert len(sdk.calls) == 1 and not crit(result, "01")["needs_review"]


def test_fabricated_quote_rejected(db):
    pk = add_conversation(db)
    r = fixed_good()
    r["01"] = ("yes", "Оператор поздоровался.", ev(3, "гарантирую доходность двадцать процентов"), None, None)
    client, sdk = make_client([payload(r), payload({"01": r["01"]})])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert "quote not found" in sdk.calls[1]["messages"][-1]["content"]
    assert crit(result, "01")["needs_review"]


def test_refusal_yields_needs_review_without_exception(db):
    pk = add_conversation(db)
    client, sdk = make_client([(None, "refusal", None)])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert len(sdk.calls) == 1
    assert result["status"] == "needs_review"
    assert all(c["needs_review"] for c in result["criteria"])
    assert result["total"] is None and result["total_status"] == "not_calculated"
    assert result["provisional"] is True


def test_refusal_during_repair(db):
    pk = add_conversation(db)
    bad = fixed_good()
    bad["01"] = ("yes", "Оператор поздоровался.", ev(99, "x"), None, None)
    client, _ = make_client([payload(bad), (None, "refusal", None)])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert crit(result, "01")["needs_review"] and not crit(result, "02")["needs_review"]


def test_unparseable_output_repair_then_ok(db):
    pk = add_conversation(db)
    client, sdk = make_client(["not json at all", payload(fixed_good())])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert len(sdk.calls) == 2 and result["status"] == "completed"


def test_llm_exception_does_not_crash(db):
    pk = add_conversation(db)
    client, _ = make_client([RuntimeError("boom")])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert result["status"] == "failed"
    assert all(c["needs_review"] for c in result["criteria"])


def test_rationale_must_be_russian(db):
    pk = add_conversation(db)
    r = fixed_good()
    r["05"] = ("yes", "The operator was polite.", ev(5, "я подскажу шаги"), None, None)
    client, sdk = make_client([payload(r), payload({"05": fixed_good()["05"]})])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert "written in Russian" in sdk.calls[1]["messages"][-1]["content"]
    assert not crit(result, "05")["needs_review"]
    assert "RUSSIAN" in sdk.calls[0]["system"][0]["text"]


def test_kz_and_en_samples_russian_rationale_original_quotes(db):
    kz = [
        ("00:01", "client", "Сәлеметсіз бе, шотым туралы сұрағым бар"),
        ("00:20", "system", "Чат операторға жіберілді."),
        ("00:40", "operator", "Сәлеметсіз бе, менің атым Айгерім, сізге қалай көмектесе аламын?"),
        ("01:10", "operator", "Сау болыңыз"),
    ]
    en = [
        ("00:01", "client", "Hello, I need help with my account"),
        ("00:20", "system", "Chat transferred to an agent."),
        ("00:40", "operator", "Hello, this is Sam, how can I help you today?"),
        ("01:10", "operator", "Goodbye and have a nice day"),
    ]
    for cid, msgs, lang, q1, q7 in (
        ("p1-kz-001", kz, "KZ", "менің атым Айгерім", "Сау болыңыз"),
        ("p1-en-001", en, "EN", "this is Sam", "Goodbye and have a nice day"),
    ):
        pk = add_conversation(db, msgs, cid=cid, language=lang)
        r = {
            "01": ("yes", "Оператор поздоровался на языке клиента и представился.", ev(2, q1), None, None),
            "02": ("yes", "Оператор уточнил детали запроса.", ev(2, q1), None, None),
            "03": ("na", "Идентификация не требовалась.", [], None, "Запрос общий, проверка личности не нужна."),
            "04": (20, "Вопрос решен полностью.", ev(2, q1), None, None),
            "05": ("yes", "Оператор был вежлив.", ev(2, q1), None, None),
            "06": (10, "Диалог ясный и связный.", ev(2, q1), None, None),
            "07": ("yes", "Оператор попрощался.", ev(3, q7), None, None),
            "08": ("no", "Грубых нарушений нет.", [], None, None),
        }
        client, sdk = make_client([payload(r)])
        result = evaluate_conversation(db, pk, version_id(db), client)
        assert len(sdk.calls) == 1 and result["status"] == "completed"
        assert crit(result, "01")["evidence"][0]["quote"] == q1
        assert re.search("[А-Яа-я]", crit(result, "01")["rationale"])
        assert f"language={lang}" in sdk.calls[0]["messages"][0]["content"]


def test_115_turn_transcript_not_truncated(db):
    msgs = []
    for i in range(115):
        sp = ["client", "operator", "bot", "system"][i % 4]
        msgs.append((f"2026-11-03T13:{i // 60:02d}:{i % 60:02d}.6388245+00:00", sp, f"Реплика номер {i} тест звонка с шумом"))
    pk = add_conversation(db, msgs, cid="p4-ru-115", channel="voice call")
    r = fixed_good()
    for cid in ("01", "02", "04", "05", "06", "07"):
        a, rat, _, _, _ = r[cid]
        r[cid] = (a, rat, ev(110, "Реплика номер 110"), None, None)
    client, sdk = make_client([payload(r)])
    result = evaluate_conversation(db, pk, version_id(db), client)
    user = sdk.calls[0]["messages"][0]["content"]
    for i in range(115):
        assert f"[#{i} | " in user
    assert "Реплика номер 114 тест" in user and "messages=115" in user
    assert sdk.calls[0]["max_tokens"] >= 4096
    assert result["status"] == "completed"


def test_structured_outputs_fallback_to_json_text(db):
    pk = add_conversation(db)
    client, sdk = make_client([StatusError(400, "output_config.format not supported"), payload(fixed_good())])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert "format" in sdk.calls[0]["output_config"]
    assert "format" not in sdk.calls[1]["output_config"]
    assert sdk.calls[1]["output_config"]["effort"] == "medium"
    assert client.structured_enabled is False and client.structured_fallback_reason
    assert result["status"] == "completed"
    assert json.loads(db.execute("SELECT raw_output FROM evaluation").fetchone()[0])["structured"] is False


def test_structured_outputs_disabled_by_setting(db):
    pk = add_conversation(db)
    client, sdk = make_client([payload(fixed_good())], llm_structured_outputs=False)
    evaluate_conversation(db, pk, version_id(db), client)
    assert "format" not in sdk.calls[0]["output_config"]


def test_cache_tokens_logged_across_repair(db):
    pk = add_conversation(db)
    bad = fixed_good()
    bad["01"] = ("yes", "Оператор поздоровался.", ev(99, "x"), None, None)
    u1 = dict(input_tokens=300, output_tokens=400, cache_read_input_tokens=0, cache_creation_input_tokens=2500)
    u2 = dict(input_tokens=350, output_tokens=60, cache_read_input_tokens=2500, cache_creation_input_tokens=0)
    client, _ = make_client([(payload(bad), "end_turn", u1), (payload({"01": fixed_good()["01"]}), "end_turn", u2)])
    result = evaluate_conversation(db, pk, version_id(db), client)
    assert result["tokens_cache_write"] == 2500 and result["tokens_cache_read"] == 2500
    assert result["tokens_input"] == 650 and result["tokens_output"] == 460


SYNTH = {
    "name": "Synthetic",
    "sections": [{"id": "s1", "title": "Tone"}, {"id": "s2", "title": "Safety"}],
    "criteria": [
        {"id": "tone-A", "title": "Politeness", "description": "Polite phrasing", "section": "s1", "weight": 60, "type": "yes_no"},
        {
            "id": "depth_Z",
            "title": "Depth",
            "description": "How deep the answer is",
            "section": "s1",
            "weight": 40,
            "type": "scale",
            "na_allowed": True,
            "na_condition": "No question was asked.",
            "scale_steps": [
                {"value": 3, "descriptor": "Exhaustive answer"},
                {"value": 1, "descriptor": "Shallow answer"},
                {"value": 0, "descriptor": "Nothing useful"},
            ],
        },
        {"id": "leak-X", "title": "Data leak", "description": "Leaks secrets", "section": "s2", "weight": 0, "type": "flag"},
    ],
}


def test_synthetic_checklist_prompt_and_schema():
    cfg = ChecklistConfig.model_validate(SYNTH)
    prompt = build_system_prompt(cfg)
    for needle in ("tone-A", "Politeness", "depth_Z", "Exhaustive answer", "Shallow answer", "No question was asked.", "leak-X", "Leaks secrets"):
        assert needle in prompt
    assert "Criterion 01" not in prompt and "Rapport" not in prompt
    schema = build_schema(cfg)
    enum = schema["properties"]["results"]["items"]["properties"]["criterion_id"]["enum"]
    assert enum == ["tone-A", "depth_Z", "leak-X"]
    user = build_user_prompt({"channel": "agent chat", "language": "RU"}, [{"message_index": 0, "timestamp_raw": "00:01", "speaker": "client", "text": "hi"}])
    assert "[#0 | 00:01 | client] hi" in user


def test_synthetic_checklist_end_to_end(db):
    cfg = ChecklistConfig.model_validate(SYNTH)
    ver = checklist_service.create_checklist(db, cfg)
    pk = add_conversation(db)
    results = {
        "tone-A": ("yes", "Оператор вежлив.", ev(3, "чем могу помочь"), None, None),
        "depth_Z": (1, "Ответ поверхностный.", ev(5, "подать заявку"), None, None),
        "leak-X": ("no", "Утечек нет.", [], None, None),
    }
    client, sdk = make_client([payload(results)])
    result = evaluate_conversation(db, pk, ver.id, client)
    assert result["status"] == "completed"
    assert result["total"] == pytest.approx(73.33)
    assert crit(result, "depth_Z")["answer"] == "1"
    bad = {**results, "depth_Z": (2, "Ответ.", ev(5, "подать заявку"), None, None)}
    client2, sdk2 = make_client([payload(bad), payload({"depth_Z": bad["depth_Z"]})])
    result2 = evaluate_conversation(db, pk, ver.id, client2)
    assert crit(result2, "depth_Z")["needs_review"]
    assert "not a valid scale step" in sdk2.calls[1]["messages"][-1]["content"]


def test_no_hardcoded_seed_ids_in_evaluator_sources():
    root = Path(__file__).resolve().parents[1] / "backend" / "app" / "services"
    pattern = re.compile(r"""["']0[1-8]["']|criterion[_ ]0[1-8]|\bc0[1-8]\b""")
    for name in ("evaluator.py", "llm_client.py"):
        src = (root / name).read_text(encoding="utf-8")
        assert not pattern.search(src), name


def test_no_comments_or_docstrings_in_new_sources():
    base = Path(__file__).resolve().parents[1] / "backend" / "app"
    for rel in ("services/evaluator.py", "services/llm_client.py", "api/v1/evaluations.py"):
        src = (base / rel).read_text(encoding="utf-8")
        assert '"""' not in src and "'''" not in src
        for line in src.splitlines():
            assert not line.lstrip().startswith("#")


def test_evaluate_endpoint(tmp_path, monkeypatch):
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "api.db"))
    config.get_settings.cache_clear()
    from backend.app.main import app
    from backend.app.services.llm_client import get_llm_client

    client_llm, sdk = make_client([payload(fixed_good())])
    app.dependency_overrides[get_llm_client] = lambda: client_llm
    try:
        with TestClient(app) as c:
            conn = connect(str(tmp_path / "api.db"))
            pk = add_conversation(conn)
            vid = version_id(conn)
            conn.close()
            r = c.post(f"/api/v1/conversations/{pk}/evaluate", params={"checklist_version_id": vid})
            assert r.status_code == 200
            body = r.json()
            assert body["total"] == 88.13 and len(body["criteria"]) == 8
            assert c.get(f"/api/v1/evaluations/{body['id']}").json()["id"] == body["id"]
            assert len(c.get(f"/api/v1/conversations/{pk}/evaluations").json()) == 1
            assert c.post("/api/v1/conversations/9999/evaluate").status_code == 404
            assert c.post(f"/api/v1/conversations/{pk}/evaluate", params={"checklist_version_id": 9999}).status_code == 404
    finally:
        app.dependency_overrides.clear()
        config.get_settings.cache_clear()
