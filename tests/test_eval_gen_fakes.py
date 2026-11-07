import copy

from evals.gen.common import load_checklist

CFG = load_checklist()

SPEC = {
    "id": "case-901",
    "split": "dev",
    "channel": "agent chat",
    "channel_tag": "chat",
    "language": "ru",
    "conversation_language": "ru",
    "switch_to": None,
    "length": "short",
    "message_range": [6, 12],
    "message_target": 8,
    "topic": "deposit_withdrawal",
    "hard": [],
    "violation": None,
    "id_needed": True,
    "targets": {"01": "yes", "02": "yes", "03": "yes", "04": 20, "05": "yes", "06": 10, "07": "yes", "08": "no"},
    "seed": 1,
}

ROWS = [
    ("00:02", "client", "Здравствуйте, хочу вывести деньги со счёта"),
    ("00:05", "bot", "Добро пожаловать! Сейчас подключу оператора."),
    ("00:08", "system", "Эскалация на оператора."),
    ("00:40", "operator", "Здравствуйте, меня зовут Анна. Подскажите, пожалуйста, номер заявки."),
    ("00:55", "system", "Личность клиента подтверждена."),
    ("01:10", "client", "Номер заявки 4521, жду уже три дня"),
    ("01:50", "operator", "Заявка 4521 исполнена сегодня, деньги придут на карту в течение суток."),
    ("02:10", "operator", "Это всё, чем я могла помочь. Спасибо за обращение, всего доброго!"),
]


def item(answer, rationale, evidence=None, checked_range=None, na_reason=None):
    return {
        "answer": answer,
        "rationale": rationale,
        "evidence": evidence or [],
        "checked_range": checked_range,
        "na_reason": na_reason,
    }


def good_case():
    messages = [
        {"message_index": i, "timestamp_raw": t, "offset_seconds": float(int(t[:2]) * 60 + int(t[3:])), "speaker": s, "text": x}
        for i, (t, s, x) in enumerate(ROWS)
    ]
    expected = {
        "01": item("yes", "Оператор поздоровался и представился.", [{"message_index": 3, "quote": "меня зовут Анна"}]),
        "02": item("yes", "Оператор уточнил номер заявки.", [{"message_index": 3, "quote": "номер заявки"}]),
        "03": item("yes", "Личность подтверждена до раскрытия данных.", [{"message_index": 4, "quote": "Личность клиента подтверждена."}]),
        "04": item(20, "Запрос решён полностью.", [{"message_index": 6, "quote": "деньги придут на карту"}]),
        "05": item("yes", "Оператор вежлив.", [{"message_index": 3, "quote": "пожалуйста"}]),
        "06": item(10, "Ответы ясные и связные.", [{"message_index": 6, "quote": "Заявка 4521 исполнена"}]),
        "07": item("yes", "Оператор попрощался.", [{"message_index": 7, "quote": "всего доброго"}]),
        "08": item("no", "Нарушений нет."),
    }
    case = {
        "id": SPEC["id"],
        "split": "dev",
        "tags": {"channel": "chat", "language": "ru", "length": "short", "topic": "deposit_withdrawal", "hard": []},
        "conversation": {"channel": "agent chat", "language": "ru", "messages": messages},
        "expected": expected,
        "review": {"status": "pending", "flags": []},
    }
    return copy.deepcopy(case)


def good_spec():
    return copy.deepcopy(SPEC)


def generation_output():
    case = good_case()
    results = [dict(v, criterion_id=k) for k, v in case["expected"].items()]
    return {"messages": case["conversation"]["messages"], "results": results}


def test_fake_helpers_build():
    assert good_case()["id"] == good_spec()["id"]
