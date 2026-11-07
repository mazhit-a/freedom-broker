import copy
import json
import math
import os
import random
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from backend.app.schemas.checklist import ChecklistConfig, Criterion
from backend.app.services.evaluator import RULES, transcript_lines

DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"
JEV_MODEL = "typesafe/jev-1.14"
PRICE_PER_INPUT_TOKEN = 0.042 / 1e6
CHARS_PER_TOKEN_ESTIMATE = 3.0
NA_SUFFIX = "__na"
NA_THRESHOLD = 0.5

RULES_HEADER = (
    "You assess ONLY the human operator of the conversation below against the questions asked.\n"
    "Bot and system messages are context, never the operator. A bot greeting never counts as the operator's greeting.\n"
    "Client messages show what the operator had to do. Transcripts are Russian, Kazakh or English; "
    "voice transcripts are noisy ASR with duplicated lines and redaction placeholders, so judge intent, not noise.\n"
    "Answer no when an action was needed but skipped or done wrong. Answer na only when its stated condition is actually met.\n"
    "If a needed precondition is not confirmed anywhere in the conversation, the answer is no, not na."
)

JUDGING_RULE_INDEXES = (0, 1, 2, 3, 4, 6, 7, 8)
STYLES = ("default", "rich", "split", "rich_split", "temporal_choice", "temporal_split")
TEMPORAL_CRITERION = "02"
TEMPORAL_CHOICE_ANSWERS = {"yes": "yes", "no_late": "no", "na": "na"}
TEMPORAL_SPLIT_ROLES = {"q_02_needed": "t_needed", "q_02_before": "t_before", "q_02_pushed": "t_pushed"}
TEMPORAL_THRESHOLD = 0.5
FRAMING_RE = re.compile(r"^\s*(?:Да|Нет)\s*[—–-]\s*")
DETECTED_RE = re.compile(r"^выявлен[оы]?\s+", re.IGNORECASE)
LIST_SPLIT_RE = re.compile(r",\s*|\s+или\s+")
YES_NO_SPLIT_RE = re.compile(r"^\s*Да\s*[—–-]\s*(.*?)\s*Нет\s*[—–-]\s*(.*)$")
SCALE_REF_RE = re.compile(r"по шкале(?:\s+на\s+стр\.\s*\d+)?(?!\s+ниже)")
PAGE_REF_RE = re.compile(r"\s*(?:на\s+)?стр\.\s*\d+")


def rich_rules_header() -> str:
    lines = [RULES[i].replace("against the checklist below", "against the questions asked") for i in JUDGING_RULE_INDEXES]
    return "\n".join(lines)


def style_flags(style: str) -> tuple[bool, bool]:
    if style not in STYLES:
        raise ValueError(f"unknown jev style {style!r}, known: {list(STYLES)}")
    return style in ("rich", "rich_split"), style in ("split", "rich_split")


def temporal_specs(cid: str, style: str) -> list["QuestionSpec"] | None:
    if cid != TEMPORAL_CRITERION:
        return None
    if style == "temporal_choice":
        return [QuestionSpec(qname(cid), cid, "temporal_choice", copy.deepcopy(TEMPORAL_CHOICE_BODY))]
    if style == "temporal_split":
        return [
            QuestionSpec(name, cid, TEMPORAL_SPLIT_ROLES[name], copy.deepcopy(body))
            for name, body in TEMPORAL_SPLIT_BODIES.items()
        ]
    return None


TEMPORAL_CHOICE_BODY = {
    "type": "choice",
    "instructions": (
        "Выявление потребности. Найдите первый ответ оператора по существу: это не приветствие, не просьба подтвердить личность "
        "и не уточняющий вопрос. Сравните порядок: оператор уточнил недостающие детали до этого ответа или после него. "
        "Выберите yes, если оператор учёл известные детали и спросил о недостающих до первого ответа по существу. "
        "Выберите no_late, если оператор дал ответ или объяснение по существу до того, как спросил о недостающих деталях, "
        "или не спрашивал вовсе, так что клиенту пришлось самому на это указать или самому сообщить детали. "
        "Выберите na только если первое сообщение клиента уже содержало всё необходимое и уточнение не требовалось."
    ),
    "criteria": {
        "yes": "Да: оператор учёл известные детали и спросил о недостающих до своего первого ответа по существу.",
        "no_late": (
            "Нет: оператор дал ответ или объяснение по существу до того, как спросил о недостающих деталях, или не спрашивал вовсе, "
            "так что клиенту пришлось самому на это указать или самому сообщить детали."
        ),
        "na": "N/A: первое сообщение клиента уже содержало всё необходимое, уточнение не требовалось.",
    },
}

TEMPORAL_SPLIT_BODIES = {
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


class DecisionsError(Exception):
    def __init__(self, kind: str, message: str, status: int | None = None, attempts: int = 0):
        super().__init__(f"{kind}: {message}")
        self.kind = kind
        self.message = message
        self.status = status
        self.attempts = attempts


class TransportError(Exception):
    def __init__(self, kind: str = "network", message: str = ""):
        super().__init__(message or kind)
        self.kind = kind


@dataclass
class TransportResponse:
    status: int
    body: Any = None
    headers: dict = field(default_factory=dict)


Transport = Callable[[str, dict, dict, float], TransportResponse]


def classify_status(status: int) -> str:
    if status in (401, 403):
        return "auth"
    if status == 402:
        return "payment"
    if status == 429:
        return "rate_limit"
    if status == 408:
        return "timeout"
    if 500 <= status < 600:
        return "server"
    if 400 <= status < 500:
        return "client"
    return "unexpected"


RETRYABLE_KINDS = {"rate_limit", "server", "network", "timeout"}


def httpx_transport(url: str, headers: dict, payload: dict, timeout: float) -> TransportResponse:
    import httpx

    try:
        r = httpx.post(url, headers=headers, json=payload, timeout=timeout)
    except httpx.TimeoutException as e:
        raise TransportError("timeout", type(e).__name__) from None
    except httpx.HTTPError as e:
        raise TransportError("network", type(e).__name__) from None
    try:
        body = r.json()
    except ValueError:
        body = {"_text": r.text[:300]}
    return TransportResponse(r.status_code, body, dict(r.headers))


def load_api_key(env: dict | None = None, dotenv_path: Path | None = None) -> str | None:
    source = os.environ if env is None else env
    value = source.get("OPENROUTER_API_KEY")
    if value:
        return value.strip()
    path = dotenv_path or Path(__file__).resolve().parent.parent / ".env"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, raw = line.partition("=")
        if name.strip() == "OPENROUTER_API_KEY":
            raw = raw.strip().strip('"').strip("'")
            return raw or None
    return None


def parse_retry_after(headers: dict) -> float | None:
    for k, v in headers.items():
        if k.lower() == "retry-after":
            try:
                return max(0.0, float(v))
            except (TypeError, ValueError):
                return None
    return None


def error_message(body: Any) -> str:
    if isinstance(body, dict):
        err = body.get("error", body)
        if isinstance(err, dict):
            err = err.get("message") or json.dumps(err, ensure_ascii=False)
        return str(err)[:300]
    return str(body)[:300]


class DecisionsClient:
    def __init__(
        self,
        api_key: str | None = None,
        transport: Transport | None = None,
        url: str = DECISIONS_URL,
        timeout: float = 30.0,
        max_attempts: int = 4,
        backoff_base: float = 0.5,
        backoff_cap: float = 8.0,
        max_total_seconds: float = 60.0,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        rng: Callable[[], float] = random.random,
    ):
        self._api_key = api_key
        self.transport = transport or httpx_transport
        self.url = url
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.backoff_base = backoff_base
        self.backoff_cap = backoff_cap
        self.max_total_seconds = max_total_seconds
        self.sleep = sleep
        self.clock = clock
        self.rng = rng

    def backoff(self, attempt: int, retry_after: float | None) -> float:
        exp = min(self.backoff_cap, self.backoff_base * (2 ** (attempt - 1)))
        delay = exp * (0.5 + 0.5 * self.rng())
        if retry_after is not None:
            delay = max(delay, min(retry_after, self.backoff_cap))
        return delay

    def post(self, payload: dict) -> dict:
        key = self._api_key or load_api_key()
        if not key:
            raise DecisionsError("auth", "OPENROUTER_API_KEY is not set")
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        start = self.clock()
        deadline = start + self.max_total_seconds
        attempt = 0
        last: DecisionsError | None = None
        while attempt < self.max_attempts:
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise DecisionsError("ceiling", "wall-clock ceiling reached", attempts=attempt)
            attempt += 1
            retry_after = None
            try:
                resp = self.transport(self.url, headers, payload, min(self.timeout, remaining))
            except TransportError as e:
                last = DecisionsError(e.kind, str(e), attempts=attempt)
            else:
                if resp.status == 200:
                    body = resp.body
                    if not isinstance(body, dict) or not isinstance(body.get("answers"), dict):
                        raise DecisionsError("malformed", error_message(body), 200, attempt)
                    return {
                        "body": body,
                        "attempts": attempt,
                        "latency_ms": round((self.clock() - start) * 1000, 1),
                        "usage": normalize_usage(body.get("usage")),
                    }
                kind = classify_status(resp.status)
                last = DecisionsError(kind, error_message(resp.body), resp.status, attempt)
                retry_after = parse_retry_after(resp.headers or {})
            if last.kind not in RETRYABLE_KINDS or attempt >= self.max_attempts:
                raise last
            delay = self.backoff(attempt, retry_after)
            if self.clock() + delay >= deadline:
                raise DecisionsError("ceiling", f"wall-clock ceiling reached after {last.kind}", last.status, attempt)
            self.sleep(delay)
        raise last or DecisionsError("unexpected", "no attempt made")


def normalize_usage(usage: Any) -> dict | None:
    if not isinstance(usage, dict):
        return None
    inp = usage.get("input_tokens", usage.get("inputTokens"))
    out = usage.get("output_tokens", usage.get("outputTokens"))
    cost = usage.get("cost")
    if inp is None and out is None and cost is None:
        return None
    return {"input_tokens": inp, "output_tokens": out, "cost": cost}


@dataclass
class QuestionSpec:
    name: str
    criterion_id: str
    role: str
    body: dict
    steps: list[int] = field(default_factory=list)


def question_instructions(c: Criterion) -> str:
    parts = [c.title.strip()]
    if c.description.strip():
        parts.append(c.description.strip())
    return ". ".join(p.rstrip(".") for p in parts if p) + "."


def one_line(text: str | None) -> str:
    return " ".join((text or "").split())


def qname(cid: str) -> str:
    return f"q_{cid}"


def condition_text(text: str | None) -> str:
    return FRAMING_RE.sub("", one_line(text)).rstrip(". ").strip()


def clean_scale_text(text: str | None) -> str:
    out = SCALE_REF_RE.sub("по шкале ниже", one_line(text))
    return PAGE_REF_RE.sub("", out).strip()


def rich_yes_no(c: Criterion) -> tuple[str, dict]:
    cond = condition_text(c.description)
    yes = f"Да: {cond}." if cond else "Да: требование выполнено."
    no = (
        f"Нет: условие не выполнено (не так, что {cond}); действие требовалось, но было пропущено или выполнено неверно."
        if cond
        else "Нет: действие требовалось, но было пропущено или выполнено неверно."
    )
    options = {"yes": yes, "no": no}
    parts = [f"{c.title.strip()}.", f"Условие для yes: {cond}." if cond else "Условие для yes: требование выполнено."]
    parts.append("Выберите yes, если условие выполнено. Выберите no, если действие требовалось, но было пропущено или выполнено неверно.")
    if c.na_allowed:
        na_cond = condition_text(c.na_condition)
        options["na"] = f"N/A: {na_cond}; критерий не применим, обычный ответ не нужен."
        parts.append(f"Выберите na только если: {na_cond}. Иначе выберите yes или no.")
    else:
        parts.append("Ответ na недопустим.")
    return " ".join(parts), options


def rich_flag(c: Criterion) -> tuple[str, dict]:
    raw = one_line(c.description)
    m = YES_NO_SPLIT_RE.match(raw)
    if m:
        yes_cond, no_cond = m.group(1).rstrip(". ").strip(), m.group(2).rstrip(". ").strip()
    else:
        yes_cond, no_cond = condition_text(raw), ""
    yes_cond = DETECTED_RE.sub("", yes_cond)
    kinds = [k.strip() for k in LIST_SPLIT_RE.split(yes_cond) if k.strip()]
    if len(kinds) > 1:
        yes_cond = "; ".join(f"({i}) {k}" for i, k in enumerate(kinds, 1))
    true_text = f"Нарушение есть, выявлено одно из: {yes_cond}." if len(kinds) > 1 else (f"Нарушение есть: {yes_cond}." if yes_cond else "Нарушение есть.")
    false_text = f"Нарушения нет: {no_cond}." if no_cond else "Нарушения нет: условие нарушения не выявлено."
    lead = "нарушение выявлено, то есть выявлено одно из" if len(kinds) > 1 else "нарушение выявлено"
    instr = (
        f"{c.title.strip()}. Ответ true означает, что {lead}: {yes_cond}. "
        f"Ответ false означает, что нарушения нет: {no_cond or 'условие нарушения не выявлено'}."
    )
    return instr, {"true": true_text, "false": false_text}


def rich_scale(c: Criterion) -> tuple[str, list[str], list]:
    steps = sorted(c.scale_steps, key=lambda s: s.value)
    desc = clean_scale_text(c.description).rstrip(". ")
    listing = "; ".join(f"{s.value} — {one_line(s.descriptor).rstrip('.')}" for s in steps)
    parts = [f"{c.title.strip()}."]
    if desc:
        parts.append(f"{desc}.")
    parts.append(f"Шаги шкалы (значение — описание): {listing}.")
    parts.append("Выберите наивысший шаг, описание которого выполняется полностью.")
    return " ".join(parts), [one_line(s.descriptor) for s in steps], steps


def build_questions(cfg: ChecklistConfig, style: str = "default") -> list[QuestionSpec]:
    rich, _ = style_flags(style)
    specs: list[QuestionSpec] = []
    for c in cfg.criteria:
        replaced = temporal_specs(c.id, style)
        if replaced is not None:
            specs.extend(replaced)
            continue
        instr = question_instructions(c)
        if c.type == "yes_no":
            if rich:
                instr, options = rich_yes_no(c)
            else:
                options = {
                    "yes": one_line(c.description) or "The requirement is met.",
                    "no": "The requirement was needed but skipped or done wrong.",
                }
                if c.na_allowed:
                    options["na"] = one_line(c.na_condition)
            specs.append(
                QuestionSpec(qname(c.id), c.id, "choice", {"type": "choice", "instructions": instr, "criteria": options})
            )
        elif c.type == "flag":
            if rich:
                instr, criteria = rich_flag(c)
            else:
                criteria = {
                    "true": one_line(c.description) or "A violation is present.",
                    "false": "No violation is present.",
                }
            specs.append(
                QuestionSpec(qname(c.id), c.id, "flag", {"type": "noul", "instructions": instr, "criteria": criteria})
            )
        else:
            steps = sorted(c.scale_steps, key=lambda s: s.value)
            descriptors = [one_line(s.descriptor) for s in steps]
            if rich:
                instr, descriptors, _ = rich_scale(c)
            specs.append(
                QuestionSpec(
                    qname(c.id),
                    c.id,
                    "scale",
                    {"type": "score", "instructions": instr, "criteria": descriptors},
                    [s.value for s in steps],
                )
            )
            if c.na_allowed:
                if rich:
                    na_cond = condition_text(c.na_condition)
                    na_body = {
                        "type": "noul",
                        "instructions": f"Выполняется ли условие N/A для критерия «{c.title.strip()}»? Условие N/A: {na_cond}.",
                        "criteria": {
                            "true": f"Условие N/A выполнено: {na_cond}.",
                            "false": "Условие N/A не выполнено; применим обычный ответ по шкале.",
                        },
                    }
                else:
                    na_body = {
                        "type": "noul",
                        "instructions": f"Is the N/A condition for '{c.title.strip()}' met?",
                        "criteria": {
                            "true": one_line(c.na_condition),
                            "false": "The N/A condition is not met; a real answer applies.",
                        },
                    }
                specs.append(QuestionSpec(qname(c.id) + NA_SUFFIX, c.id, "scale_na", na_body))
    return specs


def questions_payload(specs: list[QuestionSpec]) -> dict:
    return {s.name: s.body for s in specs}


def build_state(conversation: dict, messages: list[dict] | None = None, header: str | None = None) -> list[str]:
    msgs = messages if messages is not None else conversation.get("messages") or []
    meta = (
        f"Conversation metadata: channel={conversation.get('channel')}, "
        f"language={conversation.get('language')}, messages={len(msgs)}"
    )
    transcript = "Transcript:\n" + "\n".join(transcript_lines(msgs))
    return [header if header is not None else RULES_HEADER, meta, transcript]


def build_request(
    conversation: dict, cfg: ChecklistConfig, model: str = JEV_MODEL, style: str = "default"
) -> tuple[dict, list[QuestionSpec]]:
    rich, _ = style_flags(style)
    specs = build_questions(cfg, style)
    header = rich_rules_header() if rich else None
    payload = {"model": model, "state": build_state(conversation, header=header), "questions": questions_payload(specs)}
    return payload, specs


def build_split_requests(
    conversation: dict, cfg: ChecklistConfig, model: str = JEV_MODEL, style: str = "split"
) -> list[tuple[str, dict, list[QuestionSpec]]]:
    rich, _ = style_flags(style)
    specs = build_questions(cfg, "rich" if rich else "default")
    header = rich_rules_header() if rich else None
    state = build_state(conversation, header=header)
    out: list[tuple[str, dict, list[QuestionSpec]]] = []
    for c in cfg.criteria:
        group = [s for s in specs if s.criterion_id == c.id]
        payload = {"model": model, "state": list(state), "questions": questions_payload(group)}
        out.append((c.id, payload, group))
    return out


def malformed(msg: str) -> DecisionsError:
    return DecisionsError("malformed", msg)


def as_prob(v: Any) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or math.isnan(v):
        raise malformed("non-numeric probability")
    return float(v)


def get_answer(answers: dict, name: str, expected: str) -> dict:
    a = answers.get(name)
    if not isinstance(a, dict):
        raise malformed(f"missing answer {name}")
    if a.get("type") != expected:
        raise malformed(f"answer {name} has type {a.get('type')!r}, expected {expected!r}")
    return a


def noul_probability(a: dict) -> float:
    p = as_prob(a.get("noul"))
    if not 0.0 <= p <= 1.0:
        raise malformed("noul out of range")
    return p


def map_choice(a: dict, options: list[str]) -> dict:
    choice = a.get("choice")
    if choice not in options:
        raise malformed(f"unknown choice {choice!r}")
    probs = a.get("probabilities")
    if not isinstance(probs, dict):
        raise malformed("choice without probabilities")
    dist = {o: as_prob(probs.get(o, 0.0)) for o in options}
    return {"answer": choice, "confidence": dist[choice], "distribution": dist}


def map_score(a: dict, steps: list[int]) -> dict:
    probs = a.get("probabilities")
    if not isinstance(probs, dict):
        raise malformed("score without probabilities")
    by_index = [as_prob(probs.get(str(i), 0.0)) for i in range(len(steps))]
    best = max(range(len(steps)), key=lambda i: (by_index[i], -i))
    dist = {str(steps[i]): by_index[i] for i in range(len(steps))}
    return {"answer": str(steps[best]), "confidence": by_index[best], "distribution": dist}


def map_flag(p: float) -> dict:
    yes = p >= NA_THRESHOLD
    return {
        "answer": "yes" if yes else "no",
        "confidence": p if yes else 1.0 - p,
        "distribution": {"yes": p, "no": 1.0 - p},
    }


def map_temporal_choice(a: dict, options: list[str]) -> dict:
    mapped = map_choice(a, options)
    return {
        "answer": TEMPORAL_CHOICE_ANSWERS[mapped["answer"]],
        "confidence": mapped["confidence"],
        "distribution": {TEMPORAL_CHOICE_ANSWERS[k]: v for k, v in mapped["distribution"].items()},
    }


def combine_temporal(needed: float, before: float, pushed: float) -> dict:
    t = TEMPORAL_THRESHOLD
    n_hit, b_hit, u_hit = needed >= t, before >= t, pushed >= t
    p_yes = needed * before * (1.0 - pushed)
    distribution = {"yes": p_yes, "no": needed * (1.0 - before * (1.0 - pushed)), "na": 1.0 - needed}
    if not n_hit:
        answer, confidence = "na", 1.0 - needed
    else:
        confidence = needed * (before if b_hit else 1.0 - before) * (pushed if u_hit else 1.0 - pushed)
        answer = "yes" if b_hit and not u_hit else "no"
    return {
        "answer": answer,
        "confidence": confidence,
        "distribution": distribution,
        "detail": {"needed": needed, "before": before, "pushed": pushed},
    }


def specs_for_questions(cfg: ChecklistConfig, asked: dict) -> list[QuestionSpec]:
    for style in STYLES:
        specs = build_questions(cfg, style)
        by_name = {s.name: s for s in specs}
        if all(n in by_name and by_name[n].body == b for n, b in asked.items()):
            return [by_name[n] for n in asked]
    return [q for q in build_questions(cfg) if q.name in asked]


def map_answers(response_body: dict, specs: list[QuestionSpec]) -> dict:
    answers = response_body.get("answers")
    if not isinstance(answers, dict):
        raise malformed("no answers")
    by_cid: dict[str, dict[str, QuestionSpec]] = {}
    for s in specs:
        by_cid.setdefault(s.criterion_id, {})[s.role] = s
    out: dict[str, dict] = {}
    for cid, roles in by_cid.items():
        if "temporal_choice" in roles:
            s = roles["temporal_choice"]
            out[cid] = map_temporal_choice(get_answer(answers, s.name, "choice"), list(s.body["criteria"].keys()))
        elif "t_needed" in roles:
            probs = {
                key: noul_probability(get_answer(answers, roles[role].name, "noul"))
                for key, role in (("needed", "t_needed"), ("before", "t_before"), ("pushed", "t_pushed"))
            }
            out[cid] = combine_temporal(probs["needed"], probs["before"], probs["pushed"])
        elif "choice" in roles:
            s = roles["choice"]
            options = list(s.body["criteria"].keys())
            out[cid] = map_choice(get_answer(answers, s.name, "choice"), options)
        elif "flag" in roles:
            s = roles["flag"]
            out[cid] = map_flag(noul_probability(get_answer(answers, s.name, "noul")))
        else:
            s = roles["scale"]
            mapped = map_score(get_answer(answers, s.name, "score"), s.steps)
            na = roles.get("scale_na")
            if na is not None:
                p_na = noul_probability(get_answer(answers, na.name, "noul"))
                if p_na >= NA_THRESHOLD:
                    dist = {"na": p_na, **{k: v * (1 - p_na) for k, v in mapped["distribution"].items()}}
                    mapped = {"answer": "na", "confidence": p_na, "distribution": dist}
                else:
                    dist = {"na": p_na, **{k: v * (1 - p_na) for k, v in mapped["distribution"].items()}}
                    mapped = {
                        "answer": mapped["answer"],
                        "confidence": mapped["confidence"] * (1 - p_na),
                        "distribution": dist,
                    }
            out[cid] = mapped
    return out


def estimate_input_tokens(state: list[str], questions: dict) -> int:
    chars = sum(len(s) for s in state) + len(json.dumps(questions, ensure_ascii=False))
    return math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)


def compute_cost(usage: dict | None, state: list[str], questions: dict) -> dict:
    tokens = usage.get("input_tokens") if usage else None
    estimated = not isinstance(tokens, (int, float))
    if estimated:
        tokens = estimate_input_tokens(state, questions)
    return {
        "input_tokens": int(tokens),
        "output_tokens": (usage or {}).get("output_tokens"),
        "estimated": estimated,
        "cost": tokens * PRICE_PER_INPUT_TOKEN,
        "reported_cost": (usage or {}).get("cost"),
    }


def decide(
    conversation: dict,
    cfg: ChecklistConfig,
    client: DecisionsClient | None = None,
    model: str = JEV_MODEL,
) -> dict:
    client = client or DecisionsClient()
    payload, specs = build_request(conversation, cfg, model)
    call = client.post(payload)
    answers = map_answers(call["body"], specs)
    cost = compute_cost(call["usage"], payload["state"], payload["questions"])
    return {
        "answers": answers,
        "usage": call["usage"],
        "latency_ms": call["latency_ms"],
        "attempts": call["attempts"],
        "cost": cost["cost"],
        "cost_detail": cost,
        "raw": call["body"],
    }
