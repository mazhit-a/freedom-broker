import json

from backend.app.services.importer import compute_offsets
from evals.gen.common import (
    FIXTURE_PATH,
    OPUS_MODEL,
    SPEAKERS,
    SYSTEM_EVENTS,
    load_checklist,
)

DEFAULT_EFFORT = "medium"
DEFAULT_MAX_TOKENS = 16000
PRICE_LIVE_IN = 4.0
PRICE_LIVE_OUT = 20.0
BATCH_FACTOR = 0.5
TOKENS_IN_PER_CASE = 3000
TOKENS_OUT_PER_CASE = 6000

LANGUAGE_NAMES = {"ru": "Russian", "kk": "Kazakh", "en": "English"}

HARD_GUIDE = {
    "bot_greets_no_greeting": "The bot greets the client and says an operator will join. The human operator then starts directly with the answer and never greets or introduces themselves.",
    "verification_needed_not_confirmed": "The client's request needs identity verification, but no identity verified event appears anywhere in the conversation. The operator either never asks for verification or asks and the client does not complete it, yet the operator keeps going.",
    "verification_not_needed": "The client asks a general question that needs no account data (public conditions, general rules). No identity verification is needed or performed.",
    "client_leaves_before_closing": "The client stops answering and leaves (add a client left or connection lost system event) before the operator could sum up and say goodbye. The conversation ends right after that event.",
    "chat_ends_before_request": "The client never states a request. After the greeting and the operator's opening question the client leaves or the chat is closed. The operator did nothing wrong.",
    "insult": "The operator insults the client at least once (clearly abusive wording, not just dry tone).",
    "paid_personal_consultation": "The operator offers the client a personal paid consultation or service that bypasses the company, for example a private payment to the operator.",
    "confidential_disclosure": "The operator discloses confidential information (another client's data or internal company data, such as account balances, passport data or internal limits).",
    "near_miss_rude_no_violation": "The operator is curt, impatient or rude in tone, but never insults the client, never offers a paid private service and never discloses confidential data. This is NOT a gross violation.",
    "angry_client_with_empathy": "The client is angry about a concrete problem. The operator reacts to that concrete problem with real empathy and an apology or acknowledgement, and then helps.",
    "angry_client_without_empathy": "The client is angry about a concrete problem. The operator stays formally polite but ignores the emotion and the specific problem, with no acknowledgement or apology.",
    "wait_without_warning": "The operator makes the client wait explicitly (a hold on event or a long gap while the operator checks something) without warning the client beforehand.",
    "missed_item_long": "A long conversation in which the client raises several questions and the operator quietly misses one of them near the middle or end. The client never reminds the operator.",
}

TOPIC_GUIDE = {
    "account_opening_kyc": "opening a brokerage account and KYC documents",
    "deposit_withdrawal": "depositing or withdrawing funds",
    "tariffs_fees": "tariffs, commissions and fees",
    "trading_platform_failure": "the trading platform or mobile app not working",
    "order_execution_complaint": "a complaint about how an order was executed",
    "tax_documents": "tax documents and statements",
    "ipo_participation": "participating in an IPO",
}

VIOLATION_GUIDE = {
    "insult": "an insult directed at the client",
    "paid_offer": "an offer of a personal paid consultation or service in bypass of the company",
    "confidential_disclosure": "disclosure of confidential information",
}


def render_criterion(c, section_titles: dict[str, str]) -> str:
    lines = [f"Criterion {c.id}: {c.title} (type {c.type}, section {section_titles.get(c.section, c.section)})"]
    if c.description:
        lines.append(f"  description: {c.description}")
    if c.type == "scale":
        lines.append("  allowed answers (scale steps, answer with the number):")
        for s in sorted(c.scale_steps, key=lambda s: -s.value):
            lines.append(f"    {s.value}: {s.descriptor}")
    elif c.type == "yes_no":
        lines.append("  allowed answers: yes, no" + (", na" if c.na_allowed else ""))
    else:
        lines.append("  allowed answers: yes (violation present), no (no violation)")
    if c.na_allowed:
        lines.append(f"  na is allowed when: {c.na_condition}")
    else:
        lines.append("  na is NOT allowed")
    return "\n".join(lines)


def result_item_schema(cfg) -> dict:
    evidence = {
        "type": "object",
        "properties": {"message_index": {"type": "integer"}, "quote": {"type": "string"}},
        "required": ["message_index", "quote"],
        "additionalProperties": False,
    }
    rng = {
        "type": "object",
        "properties": {"from": {"type": "integer"}, "to": {"type": "integer"}},
        "required": ["from", "to"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "criterion_id": {"type": "string", "enum": [c.id for c in cfg.criteria]},
            "answer": {"type": "string"},
            "rationale": {"type": "string"},
            "evidence": {"type": "array", "items": evidence},
            "checked_range": {"anyOf": [rng, {"type": "null"}]},
            "na_reason": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        },
        "required": ["criterion_id", "answer", "rationale", "evidence", "checked_range", "na_reason"],
        "additionalProperties": False,
    }


def generation_schema(cfg) -> dict:
    message = {
        "type": "object",
        "properties": {
            "message_index": {"type": "integer"},
            "timestamp_raw": {"type": "string"},
            "offset_seconds": {"anyOf": [{"type": "number"}, {"type": "null"}]},
            "speaker": {"type": "string", "enum": list(SPEAKERS)},
            "text": {"type": "string"},
        },
        "required": ["message_index", "timestamp_raw", "offset_seconds", "speaker", "text"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "messages": {"type": "array", "items": message},
            "results": {"type": "array", "items": result_item_schema(cfg)},
        },
        "required": ["messages", "results"],
        "additionalProperties": False,
    }


def fixture_conversations(limit: int = 3, path=FIXTURE_PATH) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    records = payload["data"]["records"] if isinstance(payload, dict) else payload
    out = []
    for record in records[:limit]:
        transcript = record.get("transcript") or []
        offsets = compute_offsets([m.get("timestamp") for m in transcript])
        out.append(
            {
                "channel": record.get("channel"),
                "language": (record.get("language") or "").lower(),
                "messages": [
                    {
                        "message_index": i,
                        "timestamp_raw": m.get("timestamp"),
                        "offset_seconds": offsets[i],
                        "speaker": m.get("speaker"),
                        "text": m.get("text"),
                    }
                    for i, m in enumerate(transcript)
                ],
            }
        )
    return out


def render_events() -> str:
    lines = []
    for key, (ru, kk, en) in SYSTEM_EVENTS.items():
        lines.append(f"  {key}: RU {ru!r} | KZ {kk!r} | EN {en!r}")
    return "\n".join(lines)


def build_system_prompt(cfg=None, limit_references: int = 3) -> str:
    cfg = cfg or load_checklist()
    titles = {s.id: s.title for s in cfg.sections}
    references = json.dumps(fixture_conversations(limit_references), ensure_ascii=False, indent=1)
    parts = [
        "You write synthetic but realistic contact-centre conversations for a Kazakhstan retail brokerage company, together with the expected quality-assessment result for each of the 8 checklist criteria. The conversations are used to test an automatic quality-scoring system, so every expected answer must be unambiguous and defensible from the text alone.",
        "You receive a case specification with the channel, language, number of messages, topic, hard-case scenario and a target answer for every criterion. Write a conversation whose operator behaviour really produces exactly those target answers, and then write the expected result for each criterion. Never mention the specification, the checklist or the evaluation inside the conversation.",
        "MESSAGE FORMAT. Return messages with fields message_index (0-based, contiguous, strictly increasing by 1), timestamp_raw (string), offset_seconds (number), speaker, text. speaker is one of: operator (the human agent being assessed), client, bot (automatic assistant or IVR), system (platform events). Write exactly the requested number of messages, system events and bot messages included.",
        "TIMESTAMPS. Chat: timestamp_raw is MM:SS counted from the start of the conversation (for example 00:02, 01:05, 12:30), non-decreasing, and offset_seconds is the same time in seconds. Voice call: timestamp_raw is an ISO 8601 UTC timestamp such as 2026-11-03T13:10:05.1000000+00:00 on one date, non-decreasing, and offset_seconds is the number of seconds since the first message.",
        "CHAT STRUCTURE. A chat starts with the client, the bot answers (greeting, menu, a request for details) and a system escalation event hands the chat to a human operator; the operator speaks only after that event. Identity verification is shown by a system event, never by the operator claiming it. A chat ends with a system event (chat closed, client left, connection lost) or with the last operator or client message.",
        "VOICE STRUCTURE. A voice call is a noisy ASR transcript: duplicated or half-repeated lines, missing punctuation, homophone mistakes, fillers, IVR and bot prompts, redaction placeholders such as [Имя скрыто], [Номер скрыт], and system events such as agent joined, hold on or off, recording paused or resumed, transfer, connection lost. The operator and client lines alternate loosely and are sometimes split in the middle of a sentence.",
        "SYSTEM EVENT TEXTS (use these exact texts in the language of the conversation):\n" + render_events(),
        "LANGUAGE. The language field of the specification is the language of the client and the operator: ru Russian, kk Kazakh, en English, and switch means the conversation starts in the first language and the client and operator both move to the second language from the middle. Keep the system events in the language of the conversation at that point. All rationales are always in Russian.",
        "REALISM. Real people are brief, make typos in chats, and mix formal and informal registers. The brokerage domain: accounts, KYC, deposits, withdrawals, commissions, trading terminals, orders, tax statements, IPO. Do not invent real people or real phone numbers; use placeholders or obviously fictional values.",
        "EXPECTED RESULT. Return one result object for each of the 8 criteria. Fields: criterion_id, answer, rationale, evidence, checked_range, na_reason. answer is yes, no, na, or the scale step number as a string. rationale is 1 to 3 sentences in Russian that name who did what and why the answer follows. evidence is a list of {message_index, quote}; every quote is copied verbatim from the text of that exact message in its original language, never translated or shortened with ellipses. Rules: a yes_no answer of no needs checked_range {from, to} covering the message indexes where the action was expected (evidence optional); a yes_no answer of yes needs at least one evidence item; a scale answer needs at least one evidence item, and a scale answer of 0 may use checked_range instead; na needs na_reason and empty evidence; criterion 08 answer yes needs evidence quoting the violation, and answer no may have empty evidence. checked_range is null unless required; na_reason is null unless the answer is na.",
        "The target answers in the specification are binding: write the conversation so the target is correct, and report the target as the answer. Only the human operator is assessed; bot and system messages are never the operator. A bot greeting never counts as the operator's greeting.",
        "CHECKLIST\n" + "\n\n".join(render_criterion(c, titles) for c in cfg.criteria),
        "STYLE REFERENCES (format and register only, do not copy their content; they are very short, your conversations are longer and richer):\n" + references,
        'Output JSON only, matching the schema: {"messages": [...], "results": [...]}.',
    ]
    return "\n\n".join(parts)


def target_instruction(cfg, cid: str, answer, spec: dict) -> str:
    c = next(x for x in cfg.criteria if x.id == cid)
    label = f"{cid} {c.title}: target {answer}."
    if c.type == "scale":
        if answer == "na":
            return f"{label} N/A condition: {c.na_condition}"
        step = next(s for s in c.scale_steps if s.value == answer)
        return f"{label} Step meaning: {step.descriptor}"
    if answer == "na":
        return f"{label} N/A condition: {c.na_condition}"
    if cid == "08":
        if answer == "yes":
            return f"{label} The violation is: {VIOLATION_GUIDE[spec['violation']]}."
        return f"{label} No insult, no paid private offer, no disclosure of confidential data anywhere."
    if cid == "03":
        if answer == "yes":
            return f"{label} The request needs identity verification. A system identity verified event appears BEFORE the operator reveals data or performs a protected action."
        return f"{label} The request needs identity verification but no identity verified event appears anywhere, and the operator proceeds with protected data or actions anyway."
    return f"{label} {c.description}" + (" Fully satisfied." if answer == "yes" else " Clearly not satisfied.")


def build_user_prompt(spec: dict, cfg=None) -> str:
    cfg = cfg or load_checklist()
    lo, hi = spec["message_range"]
    lang = spec["conversation_language"]
    if spec["language"] == "switch":
        language_line = f"switch: start in {LANGUAGE_NAMES[lang]} and move to {LANGUAGE_NAMES[spec['switch_to']]} from about the middle (conversation language field: {lang})"
    else:
        language_line = f"{spec['language']} ({LANGUAGE_NAMES[lang]})"
    lines = [
        f"Case id: {spec['id']}",
        f"Channel: {spec['channel']}",
        f"Language: {language_line}",
        f"Length class: {spec['length']}; write exactly {spec['message_target']} messages (class band {lo} to {hi}), counting system events and bot messages.",
        f"Topic: {TOPIC_GUIDE[spec['topic']]}",
    ]
    if spec["id_needed"]:
        lines.append("Identity: the client's request involves personal account data or a protected action.")
    else:
        lines.append("Identity: the client's request is a general question that does not need identity verification.")
    if spec["hard"]:
        lines.append("Hard-case scenario to build into the conversation:")
        lines.extend(f"- {name}: {HARD_GUIDE[name]}" for name in spec["hard"])
    lines.append("Target answers (binding):")
    lines.extend(f"- {target_instruction(cfg, cid, ans, spec)}" for cid, ans in spec["targets"].items())
    lines.append("Write the conversation and the 8 expected results now.")
    return "\n".join(lines)


def live_request(spec: dict, cfg=None, model: str = OPUS_MODEL, effort: str = DEFAULT_EFFORT, max_tokens: int = DEFAULT_MAX_TOKENS) -> dict:
    cfg = cfg or load_checklist()
    return {
        "model": model,
        "max_tokens": max_tokens,
        "system": [{"type": "text", "text": build_system_prompt(cfg), "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": build_user_prompt(spec, cfg)}],
        "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": generation_schema(cfg)}},
    }


def batch_request(spec: dict, cfg=None, **kwargs) -> dict:
    return {"custom_id": spec["id"], "params": live_request(spec, cfg, **kwargs)}


def batch_requests(specs: list[dict], cfg=None, **kwargs) -> list[dict]:
    cfg = cfg or load_checklist()
    return [batch_request(s, cfg, **kwargs) for s in specs]


def estimate_cost(count: int, in_tokens: int = TOKENS_IN_PER_CASE, out_tokens: int = TOKENS_OUT_PER_CASE) -> dict:
    live_each = (in_tokens * PRICE_LIVE_IN + out_tokens * PRICE_LIVE_OUT) / 1_000_000
    return {
        "requests": count,
        "input_tokens_per_case": in_tokens,
        "output_tokens_per_case": out_tokens,
        "live_per_case": round(live_each, 4),
        "batch_per_case": round(live_each * BATCH_FACTOR, 4),
        "live_total": round(live_each * count, 4),
        "batch_total": round(live_each * count * BATCH_FACTOR, 4),
    }
