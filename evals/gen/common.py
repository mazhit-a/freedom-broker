import hashlib
import json
import re
from pathlib import Path

from backend.app.schemas.checklist import ChecklistConfig

ROOT = Path(__file__).resolve().parents[2]
CHECKLIST_PATH = ROOT / "evals" / "checklist_v2.json"
CHECKLIST_REL = "evals/checklist_v2.json"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "sample_dataset.json"
DATASET_PATH = ROOT / "evals" / "dataset.json"

OPUS_MODEL = "claude-opus-5-5"
SONNET_MODEL = "claude-sonnet-5-5"

CHANNELS = ("agent chat", "voice call")
CHANNEL_TAGS = {"agent chat": "chat", "voice call": "call"}
LANGUAGES = ("ru", "kk", "en")
LENGTHS = {"short": (6, 12), "medium": (15, 30), "long": (40, 80)}
SPEAKERS = ("operator", "client", "bot", "system")

TOPICS = (
    "account_opening_kyc",
    "deposit_withdrawal",
    "tariffs_fees",
    "trading_platform_failure",
    "order_execution_complaint",
    "tax_documents",
    "ipo_participation",
)

VIOLATIONS = ("insult", "paid_offer", "confidential_disclosure")

SYSTEM_EVENTS = {
    "identity_verified": (
        "Личность клиента подтверждена.",
        "Клиенттің жеке басы расталды.",
        "Customer identity verified.",
    ),
    "escalation": (
        "Эскалация на оператора.",
        "Чат операторға жіберілді.",
        "Chat transferred to an agent.",
    ),
    "chat_closed": ("Чат закрыт оператором.", "Чатты оператор жапты.", "Chat closed by agent."),
    "client_left": ("Клиент покинул чат.", "Клиент чаттан шығып кетті.", "Client left the chat."),
    "connection_lost": ("Соединение потеряно.", "Байланыс үзілді.", "Connection lost."),
    "recording_paused": ("Запись приостановлена.", "Жазба тоқтатылды.", "Recording paused."),
    "recording_resumed": ("Запись возобновлена.", "Жазба жалғастырылды.", "Recording resumed."),
    "hold_on": ("Клиент поставлен на удержание.", "Клиент күтуге қойылды.", "Customer put on hold."),
    "hold_off": ("Удержание снято.", "Күту аяқталды.", "Hold ended."),
    "transfer": ("Звонок переведён.", "Қоңырау ауыстырылды.", "Call transferred."),
    "language_switch": ("Язык диалога изменён.", "Диалог тілі өзгертілді.", "Conversation language changed."),
    "agent_joined": ("Оператор подключился.", "Оператор қосылды.", "Agent joined"),
}

IDENTITY_RE = re.compile(r"личность клиента подтверждена|жеке басы расталды|identity verified", re.I)
ESCALATION_RE = re.compile(r"эскалация на оператора|операторға жіберілді|transferred to an agent", re.I)
LEFT_RE = re.compile(
    r"покинул|шығып кетті|client left|соединение потеряно|байланыс үзілді|connection lost|abonent disconnected|call dropped",
    re.I,
)

KAZAKH_LETTERS = set("әіңғүұқөһӘІҢҒҮҰҚӨҺ")


def load_checklist(path: Path | str | None = None) -> ChecklistConfig:
    return ChecklistConfig.model_validate(json.loads(Path(path or CHECKLIST_PATH).read_text(encoding="utf-8")))


def possible_answers(cfg: ChecklistConfig) -> dict[str, list]:
    out: dict[str, list] = {}
    for c in cfg.criteria:
        if c.type == "scale":
            values: list = sorted((s.value for s in c.scale_steps), reverse=True)
        else:
            values = ["yes", "no"]
        if c.na_allowed and c.type != "flag":
            values.append("na")
        out[c.id] = values
    return out


def canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def cases_hash(cases: list[dict]) -> str:
    return hashlib.sha256(canonical_json(cases).encode("utf-8")).hexdigest()
