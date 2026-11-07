import json
import re

from backend.app.services.evaluator import quote_matches, validate_item
from backend.app.services.importer import parse_timestamp
from evals.gen.common import (
    IDENTITY_RE,
    KAZAKH_LETTERS,
    LEFT_RE,
    ESCALATION_RE,
    LENGTHS,
    SPEAKERS,
    possible_answers,
)

MESSAGE_KEYS = {"message_index", "timestamp_raw", "offset_seconds", "speaker", "text"}
RESULT_KEYS = {"answer", "rationale", "evidence", "checked_range", "na_reason"}
RU_SHARE = 0.7
EN_SHARE = 0.7
KK_SHARE = 0.2
SWITCH_MIN = 2


def flag(kind: str, cid: str | None, message: str) -> str:
    return f"{kind}:{cid or '-'}:{message}"


def split_flag(text: str) -> tuple[str, str, str]:
    kind, _, rest = text.partition(":")
    cid, _, message = rest.partition(":")
    return kind, cid, message


def message_language(text: str) -> str | None:
    letters = [ch for ch in text if ch.isalpha()]
    if len(letters) < 3:
        return None
    if any(ch in KAZAKH_LETTERS for ch in letters):
        return "kk"
    cyr = sum(1 for ch in letters if "Ѐ" <= ch <= "ӿ")
    if cyr / len(letters) > 0.6:
        return "ru"
    lat = sum(1 for ch in letters if "a" <= ch.lower() <= "z")
    if lat / len(letters) > 0.8:
        return "en"
    return None


def language_shares(messages: list[dict]) -> dict[str, int]:
    counts = {"ru": 0, "kk": 0, "en": 0}
    for m in messages:
        if m.get("speaker") in ("client", "operator", "bot"):
            lang = message_language(str(m.get("text") or ""))
            if lang:
                counts[lang] += 1
    return counts


def validate_format(messages) -> list[str]:
    flags = []
    if not isinstance(messages, list) or not messages:
        return [flag("format", None, "messages must be a non-empty list")]
    last_offset = None
    for pos, m in enumerate(messages):
        if not isinstance(m, dict):
            flags.append(flag("format", None, f"message {pos} is not an object"))
            continue
        missing = MESSAGE_KEYS - set(m)
        extra = set(m) - MESSAGE_KEYS
        if missing:
            flags.append(flag("format", None, f"message {pos} is missing {sorted(missing)}"))
        if extra:
            flags.append(flag("format", None, f"message {pos} has unknown fields {sorted(extra)}"))
        if m.get("message_index") != pos or isinstance(m.get("message_index"), bool):
            flags.append(flag("index", None, f"message_index at position {pos} is {m.get('message_index')!r}, expected {pos}"))
        if m.get("speaker") not in SPEAKERS:
            flags.append(flag("format", None, f"message {pos} has invalid speaker {m.get('speaker')!r}"))
        text = m.get("text")
        if not isinstance(text, str) or not text.strip():
            flags.append(flag("format", None, f"message {pos} has empty text"))
        raw = m.get("timestamp_raw")
        parsed = parse_timestamp(raw) if isinstance(raw, str) else (None, None, None)
        if not isinstance(raw, str) or (parsed[1] is None and parsed[2] is None):
            flags.append(flag("format", None, f"message {pos} has an unparseable timestamp_raw {raw!r}"))
        offset = m.get("offset_seconds")
        if not isinstance(offset, (int, float)) or isinstance(offset, bool):
            flags.append(flag("format", None, f"message {pos} has no numeric offset_seconds"))
        else:
            if last_offset is not None and offset + 1e-6 < last_offset:
                flags.append(flag("format", None, f"offset_seconds decreases at message {pos}"))
            last_offset = offset
    speakers = {m.get("speaker") for m in messages if isinstance(m, dict)}
    for needed in ("operator", "client"):
        if needed not in speakers:
            flags.append(flag("format", None, f"conversation has no {needed} message"))
    return flags


def validate_spec_match(spec: dict, conv: dict) -> list[str]:
    flags = []
    messages = conv.get("messages") or []
    lo, hi = LENGTHS[spec["length"]]
    if not lo <= len(messages) <= hi:
        flags.append(flag("length", None, f"{len(messages)} messages, band {spec['length']} is {lo} to {hi}"))
    if conv.get("channel") != spec["channel"]:
        flags.append(flag("format", None, f"channel {conv.get('channel')!r} differs from spec {spec['channel']!r}"))
    if conv.get("language") != spec["conversation_language"]:
        flags.append(flag("language", None, f"conversation language {conv.get('language')!r} differs from spec {spec['conversation_language']!r}"))
    counts = language_shares(messages)
    total = sum(counts.values())
    if total == 0:
        return flags + [flag("language", None, "no message has a detectable language")]
    if spec["language"] == "ru" and counts["ru"] / total < RU_SHARE:
        flags.append(flag("language", None, f"only {counts['ru']} of {total} messages look Russian"))
    elif spec["language"] == "en" and counts["en"] / total < EN_SHARE:
        flags.append(flag("language", None, f"only {counts['en']} of {total} messages look English"))
    elif spec["language"] == "kk" and (counts["kk"] / total < KK_SHARE or counts["en"] / total > 0.3):
        flags.append(flag("language", None, f"{counts['kk']} of {total} messages look Kazakh"))
    elif spec["language"] == "switch":
        for lang in (spec["conversation_language"], spec["switch_to"]):
            if counts[lang] < SWITCH_MIN:
                flags.append(flag("language", None, f"switch needs at least {SWITCH_MIN} {lang} messages, found {counts[lang]}"))
    return flags


def system_texts(messages: list[dict]) -> list[tuple[int, str]]:
    return [(m["message_index"], m.get("text") or "") for m in messages if m.get("speaker") == "system"]


def validate_structure(spec: dict, messages: list[dict], expected: dict) -> list[str]:
    flags = []
    events = system_texts(messages)
    verified = [i for i, t in events if IDENTITY_RE.search(t)]
    answers = {cid: (item or {}).get("answer") for cid, item in expected.items() if isinstance(item, dict)}
    a03 = str(answers.get("03", "")).strip().lower()
    if a03 == "yes" and not verified:
        flags.append(flag("structure", "03", "answer yes but no identity verified system event exists"))
    if a03 == "no" and verified:
        flags.append(flag("structure", "03", "answer no but an identity verified system event exists"))
    if str(answers.get("07", "")).strip().lower() == "na" and not any(LEFT_RE.search(t) for _, t in events):
        flags.append(flag("structure", "07", "answer na but there is no client left or connection lost event"))
    if spec["channel"] == "agent chat":
        first_operator = next((m["message_index"] for m in messages if m.get("speaker") == "operator"), None)
        escalations = [i for i, t in events if ESCALATION_RE.search(t)]
        if first_operator is not None and not any(i < first_operator for i in escalations):
            flags.append(flag("structure", None, "chat has no escalation event before the first operator message"))
    return flags


def _strict_quote(quote: str, text: str) -> bool:
    return re.sub(r"\s+", " ", quote).strip().casefold() in re.sub(r"\s+", " ", text).casefold()


def _error_kind(message: str) -> str:
    low = message.lower()
    if "rationale" in low:
        return "rationale"
    if "na_reason" in low:
        return "na_reason"
    if "checked_range" in low:
        return "range"
    if "message_index" in low or "does not exist" in low:
        return "index"
    if "quote" in low or "evidence" in low:
        return "evidence"
    return "answer"


def validate_expected(cfg, messages: list[dict], expected) -> tuple[list[str], dict]:
    flags = []
    normalized: dict = {}
    if not isinstance(expected, dict):
        return [flag("format", None, "expected must be an object keyed by criterion id")], normalized
    by_index = {m["message_index"]: m for m in messages if isinstance(m, dict) and "message_index" in m}
    for c in cfg.criteria:
        item = expected.get(c.id)
        if item is None:
            flags.append(flag("format", c.id, "expected result is missing"))
            continue
        result, errors = validate_item(c, item, messages)
        for err in errors:
            flags.append(flag(_error_kind(err), c.id, err))
        if result is not None:
            normalized[c.id] = result
        if isinstance(item, dict):
            for ev in item.get("evidence") or []:
                idx = ev.get("message_index") if isinstance(ev, dict) else None
                quote = ev.get("quote") if isinstance(ev, dict) else None
                msg = by_index.get(idx)
                if msg is not None and isinstance(quote, str) and quote_matches(quote, msg.get("text") or ""):
                    if not _strict_quote(quote, msg.get("text") or ""):
                        flags.append(flag("quote", c.id, f"quote is not an exact substring of message {idx}: {quote!r}"))
    extra = set(expected) - {c.id for c in cfg.criteria}
    if extra:
        flags.append(flag("format", None, f"unknown criteria in expected: {sorted(extra)}"))
    return flags, normalized


def check_targets(cfg, spec: dict, expected: dict) -> list[str]:
    flags = []
    legal = possible_answers(cfg)
    for cid, target in spec["targets"].items():
        item = expected.get(cid)
        if not isinstance(item, dict):
            continue
        answer = item.get("answer")
        norm = str(answer).strip().lower() if answer is not None else ""
        if norm.lstrip("-").isdigit():
            norm = int(norm)
        if norm not in legal[cid] and answer is not None:
            continue
        if norm != target:
            flags.append(flag("target_mismatch", cid, f"expected answer {answer!r} but the spec target is {target!r}"))
    return flags


def validate_case(cfg, spec: dict, case: dict) -> list[str]:
    conv = case.get("conversation") or {}
    messages = conv.get("messages")
    flags = validate_format(messages)
    if not isinstance(messages, list):
        return flags
    flags += validate_spec_match(spec, conv)
    well_formed = [m for m in messages if isinstance(m, dict) and isinstance(m.get("message_index"), int)]
    expected = case.get("expected")
    item_flags, normalized = validate_expected(cfg, well_formed, expected)
    flags += item_flags
    if isinstance(expected, dict):
        flags += check_targets(cfg, spec, expected)
        flags += validate_structure(spec, well_formed, expected)
    return list(dict.fromkeys(flags))


def parse_generation(text: str) -> tuple[dict | None, str | None]:
    body = (text or "").strip()
    body = re.sub(r"^```(?:json)?\s*|\s*```$", "", body)
    try:
        data = json.loads(body)
    except ValueError as exc:
        return None, f"output is not valid JSON: {exc}"
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list) or not isinstance(data.get("results"), list):
        return None, "output must be an object with messages and results lists"
    return data, None
