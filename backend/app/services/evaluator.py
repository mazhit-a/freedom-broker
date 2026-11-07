import difflib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from backend.app.schemas.checklist import ChecklistConfig, Criterion
from backend.app.services.checklist import get_version
from backend.app.services.llm_client import LLMClient, LLMError, LLMResult
from backend.app.services.scoring import score

PROMPT_VERSION = "v1"
FUZZY_THRESHOLD = 0.85
MIN_BLOCK = 3

RULES = [
    "You are a strict contact-centre quality assessor. You evaluate ONLY the human operator of the conversation against the checklist below.",
    "Bot and system messages are context only and are never evaluated as the operator. A greeting or introduction made by the bot never counts as the operator's greeting or introduction.",
    "Client messages are context for what the operator had to do.",
    "Transcripts are in Russian, Kazakh or English. Voice-call transcripts are noisy ASR output with duplicated lines, IVR/bot prompts and redaction placeholders such as [Имя скрыто]; judge the intent, not the noise.",
    "System events matter: identity verified (Личность клиента подтверждена. / Клиенттің жеке басы расталды. / Customer identity verified.), escalation to operator (Эскалация на оператора. / Чат операторға жіберілді. / Chat transferred to an agent.), chat closed by operator, client left, connection lost, recording paused or resumed, hold on or off, transfer, language switch.",
    "Answer types: yes_no criteria take yes or no. scale criteria take exactly one of the listed numeric step values. flag criteria take yes (violation present) or no (no violation).",
    "no means the action was needed but was skipped or done wrong. na may be used only when the criterion says N/A is allowed AND its stated N/A condition is actually met; otherwise choose a real answer.",
    "If a criterion requires a precondition (for example verification) that was needed but is not confirmed anywhere in the conversation, the answer is no, not na.",
    "For flag criteria, a clear offer or request described in the criterion is enough on its own; the client's consent or any completed action is not required.",
    "Every answer needs a short rationale WRITTEN IN RUSSIAN regardless of the transcript language (client and operator quotes stay in their original language).",
    "Evidence: cite message_index values that exist in the transcript, with a short quote that is an exact substring of that message in its original language. Never translate or paraphrase quotes.",
    "When the answer is no for a yes_no criterion (a missed action), you MUST give checked_range with the from and to message indexes where the action was expected; you may also cite evidence.",
    "When the answer is na you MUST give na_reason explaining which N/A condition holds. Otherwise na_reason is null.",
    "For every other answer give at least one evidence item. checked_range is null unless required.",
    "Return one result object for every criterion in the checklist, using the exact criterion_id. Return JSON only, matching the requested schema, with no text outside the JSON.",
]

OUTPUT_FORMAT = (
    'Output format: {"results": [{"criterion_id": str, "answer": str, "rationale": str, '
    '"evidence": [{"message_index": int, "quote": str}], '
    '"checked_range": {"from": int, "to": int} or null, "na_reason": str or null}]}. '
    "answer is yes, no, na, or the numeric scale step as a string."
)


def render_criterion(c: Criterion, section_titles: dict[str, str]) -> str:
    lines = [f"Criterion {c.id}: {c.title}", f"  type: {c.type}"]
    if c.section:
        lines.append(f"  section: {section_titles.get(c.section, c.section)}")
    if c.type != "flag":
        lines.append(f"  weight: {c.weight:g}")
    if c.description:
        lines.append(f"  description: {c.description}")
    if c.type == "scale":
        lines.append("  allowed answers (scale steps, use the number):")
        for s in sorted(c.scale_steps, key=lambda s: -s.value):
            lines.append(f"    {s.value}: {s.descriptor}")
    elif c.type == "yes_no":
        lines.append("  allowed answers: yes, no" + (", na" if c.na_allowed else ""))
    else:
        lines.append("  allowed answers: yes (violation), no (no violation)")
    if c.type == "scale" and c.na_allowed:
        lines.append("  na is also allowed")
    if c.na_allowed:
        lines.append(f"  N/A condition: {c.na_condition}")
    else:
        lines.append("  na is NOT allowed")
    return "\n".join(lines)


def build_system_prompt(cfg: ChecklistConfig) -> str:
    titles = {s.id: s.title for s in cfg.sections}
    parts = [
        "\n".join(f"{i}. {r}" for i, r in enumerate(RULES, 1)),
        f"Checklist: {cfg.name}",
        "\n\n".join(render_criterion(c, titles) for c in cfg.criteria),
        OUTPUT_FORMAT,
    ]
    return "\n\n".join(parts)


def transcript_lines(messages: list[dict]) -> list[str]:
    return [
        f"[#{m['message_index']} | {m.get('timestamp_raw') or ''} | {m.get('speaker') or ''}] {m.get('text') or ''}"
        for m in messages
    ]


def build_user_prompt(conv: dict, messages: list[dict]) -> str:
    head = f"Conversation metadata: channel={conv.get('channel')}, language={conv.get('language')}, messages={len(messages)}"
    return head + "\n\nTranscript:\n" + "\n".join(transcript_lines(messages)) + "\n\nEvaluate every criterion now."


def build_schema(cfg: ChecklistConfig) -> dict:
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
    item = {
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
    return {
        "type": "object",
        "properties": {"results": {"type": "array", "items": item}},
        "required": ["results"],
        "additionalProperties": False,
    }


def _norm_text(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", s.casefold())).strip()


def quote_matches(quote: str, text: str) -> bool:
    q, t = _norm_text(quote), _norm_text(text)
    if not q:
        return False
    if q in t:
        return True
    sm = difflib.SequenceMatcher(None, t, q, autojunk=False)
    matched = sum(b.size for b in sm.get_matching_blocks() if b.size >= MIN_BLOCK)
    return matched / len(q) >= FUZZY_THRESHOLD


def _cyrillic_ratio(s: str) -> float:
    letters = [ch for ch in s if ch.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for ch in letters if "Ѐ" <= ch <= "ӿ") / len(letters)


def _as_int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, str) and v.strip().lstrip("-").isdigit():
        return int(v.strip())
    return None


def normalize_answer(c: Criterion, raw: Any) -> tuple[Any, str | None]:
    if isinstance(raw, bool):
        raw = "yes" if raw else "no"
    s = str(raw).strip().lower() if raw is not None else ""
    if s in ("n/a", "na", "not_applicable", "not applicable"):
        if c.type == "flag" or not c.na_allowed:
            return None, f"N/A is not allowed for criterion {c.id}"
        return "na", None
    if c.type == "scale":
        n = _as_int(raw)
        if n is None or n not in {st.value for st in c.scale_steps}:
            allowed = sorted({st.value for st in c.scale_steps}, reverse=True)
            return None, f"answer {raw!r} is not a valid scale step for criterion {c.id}, allowed {allowed}"
        return n, None
    if s in ("yes", "no"):
        return s, None
    return None, f"answer {raw!r} is invalid for criterion {c.id} of type {c.type}"


def validate_item(c: Criterion, item: Any, messages: list[dict]) -> tuple[dict | None, list[str]]:
    errors: list[str] = []
    if not isinstance(item, dict):
        return None, [f"criterion {c.id}: result must be an object"]
    by_index = {m["message_index"]: m for m in messages}
    answer, err = normalize_answer(c, item.get("answer"))
    if err:
        errors.append(err)
    rationale = item.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        errors.append(f"criterion {c.id}: rationale is required")
    elif _cyrillic_ratio(rationale) < 0.5:
        errors.append(f"criterion {c.id}: rationale must be written in Russian")

    evidence_out: list[dict] = []
    evidence = item.get("evidence")
    if evidence is None:
        evidence = []
    if not isinstance(evidence, list):
        errors.append(f"criterion {c.id}: evidence must be a list")
        evidence = []
    for ev in evidence:
        idx = _as_int(ev.get("message_index")) if isinstance(ev, dict) else None
        if idx is None or idx not in by_index:
            errors.append(f"criterion {c.id}: evidence message_index {ev.get('message_index') if isinstance(ev, dict) else ev!r} does not exist")
            continue
        quote = ev.get("quote")
        if not isinstance(quote, str) or not quote_matches(quote, by_index[idx].get("text") or ""):
            errors.append(f"criterion {c.id}: quote not found in message {idx}: {quote!r}")
            continue
        evidence_out.append({"message_index": idx, "quote": quote})

    checked: dict | None = None
    raw_range = item.get("checked_range")
    if raw_range is not None:
        lo = _as_int(raw_range.get("from")) if isinstance(raw_range, dict) else None
        hi = _as_int(raw_range.get("to")) if isinstance(raw_range, dict) else None
        if lo is None or hi is None or lo not in by_index or hi not in by_index or lo > hi:
            errors.append(f"criterion {c.id}: checked_range is invalid or outside the transcript")
        else:
            checked = {"from": lo, "to": hi}

    na_reason = item.get("na_reason")
    if answer == "na":
        if not isinstance(na_reason, str) or not na_reason.strip():
            errors.append(f"criterion {c.id}: na_reason is required for N/A")
        checked = None
    elif answer == "no" and c.type == "yes_no":
        if checked is None and not any("checked_range" in e for e in errors):
            errors.append(f"criterion {c.id}: checked_range is required when the answer is no")
    elif answer is not None and not (c.type == "flag" and answer == "no"):
        zero_scale = c.type == "scale" and answer == 0
        if not evidence_out and not (zero_scale and checked is not None):
            if not any("evidence" in e or "quote" in e for e in errors):
                errors.append(f"criterion {c.id}: at least one valid evidence item is required")

    if errors:
        return None, errors
    return {
        "criterion_id": c.id,
        "answer": answer,
        "rationale": rationale.strip(),
        "evidence": evidence_out,
        "checked_range": checked,
        "na_reason": na_reason.strip() if answer == "na" else None,
    }, []


def parse_results(text: str) -> tuple[list[Any] | None, str | None]:
    body = text.strip()
    body = re.sub(r"^```(?:json)?\s*|\s*```$", "", body)
    start_obj, end_obj = body.find("{"), body.rfind("}")
    start_arr, end_arr = body.find("["), body.rfind("]")
    candidates = []
    if start_obj != -1 and end_obj > start_obj:
        candidates.append(body[start_obj : end_obj + 1])
    if start_arr != -1 and end_arr > start_arr:
        candidates.append(body[start_arr : end_arr + 1])
    for cand in candidates:
        try:
            data = json.loads(cand)
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            return data["results"], None
        if isinstance(data, list):
            return data, None
    return None, "output is not valid JSON with a results list"


@dataclass
class Outcome:
    results: dict[str, dict] = field(default_factory=dict)
    review: dict[str, str] = field(default_factory=dict)
    calls: list[LLMResult] = field(default_factory=list)
    raw: list[str] = field(default_factory=list)
    refused: bool = False
    error: str | None = None
    structured: bool = False


def _validate_pass(cfg: ChecklistConfig, text: str, messages: list[dict], wanted: list[str]) -> tuple[dict[str, dict], dict[str, list[str]]]:
    items, perr = parse_results(text)
    ok: dict[str, dict] = {}
    bad: dict[str, list[str]] = {}
    by_id: dict[str, Any] = {}
    for it in items or []:
        if isinstance(it, dict) and isinstance(it.get("criterion_id"), str):
            by_id.setdefault(it["criterion_id"], it)
    crit = {c.id: c for c in cfg.criteria}
    for cid in wanted:
        if items is None:
            bad[cid] = [perr or "unparseable output"]
        elif cid not in by_id:
            bad[cid] = [f"criterion {cid}: missing from the output"]
        else:
            res, errs = validate_item(crit[cid], by_id[cid], messages)
            if errs:
                bad[cid] = errs
            else:
                ok[cid] = res
    return ok, bad


def run_evaluation(client: LLMClient, cfg: ChecklistConfig, conv: dict, messages: list[dict]) -> Outcome:
    out = Outcome()
    system_text = build_system_prompt(cfg)
    user_text = build_user_prompt(conv, messages)
    schema = build_schema(cfg)
    convo = [{"role": "user", "content": user_text}]
    ids = [c.id for c in cfg.criteria]

    def fail_all(reason: str) -> Outcome:
        for cid in ids:
            if cid not in out.results:
                out.review[cid] = reason
        return out

    try:
        first = client.complete(system_text, convo, schema)
    except LLMError as exc:
        out.error = str(exc)
        return fail_all(f"LLM call failed: {exc}")
    out.calls.append(first)
    out.raw.append(first.text)
    out.structured = first.structured
    if first.refused:
        out.refused = True
        return fail_all("Модель отказалась от оценки (refusal)")
    ok, bad = _validate_pass(cfg, first.text, messages, ids)
    out.results.update(ok)
    if not bad:
        return out

    problems = "\n".join(f"- {cid}: {'; '.join(errs)}" for cid, errs in bad.items())
    repair = (
        "Your previous answer had validation errors for these criteria:\n"
        + problems
        + "\nReturn corrected results for ONLY these criteria, in the same JSON format. "
        "Quotes must be exact substrings of the cited message, rationales must be in Russian, "
        "checked_range is required for a missed-action no, na_reason is required for na."
    )
    repair_messages = convo + [
        {"role": "assistant", "content": first.text or "{}"},
        {"role": "user", "content": repair},
    ]
    try:
        second = client.complete(system_text, repair_messages, schema)
    except LLMError as exc:
        out.error = str(exc)
        for cid, errs in bad.items():
            out.review[cid] = "; ".join(errs)
        return out
    out.calls.append(second)
    out.raw.append(second.text)
    if second.refused:
        out.refused = True
        for cid, errs in bad.items():
            out.review[cid] = "; ".join(errs) + "; repair refused"
        return out
    ok2, bad2 = _validate_pass(cfg, second.text, messages, list(bad))
    out.results.update(ok2)
    for cid, errs in bad2.items():
        out.review[cid] = "; ".join(errs)
    return out


def _load_conversation(conn: sqlite3.Connection, pk: int) -> tuple[dict, list[dict]]:
    row = conn.execute("SELECT id, conversation_id, channel, language FROM conversation WHERE id = ?", (pk,)).fetchone()
    if not row:
        raise LookupError("Conversation not found")
    msgs = conn.execute(
        "SELECT message_index, timestamp_raw, offset_seconds, speaker, text FROM message WHERE conversation_id = ? ORDER BY message_index",
        (pk,),
    ).fetchall()
    return dict(row), [dict(m) for m in msgs]


def evaluate_conversation(conn: sqlite3.Connection, conversation_pk: int, version_id: int, client: LLMClient) -> dict:
    conv, messages = _load_conversation(conn, conversation_pk)
    version = get_version(conn, version_id)
    cfg = version.config
    outcome = run_evaluation(client, cfg, conv, messages)

    answers: dict[str, Any] = {}
    for cid, res in outcome.results.items():
        answers[cid] = res["answer"]
    result = score(cfg, answers)

    inp = sum(c.input_tokens for c in outcome.calls)
    outp = sum(c.output_tokens for c in outcome.calls)
    cr = sum(c.cache_read_tokens for c in outcome.calls)
    cw = sum(c.cache_write_tokens for c in outcome.calls)
    latency = sum(c.latency_ms for c in outcome.calls)
    cost = round(sum(c.cost for c in outcome.calls), 6)
    if outcome.error and not outcome.calls:
        status = "failed"
    elif outcome.review:
        status = "needs_review"
    else:
        status = "completed"
    total_status = "calculated" if result.calculated else "not_calculated"
    raw_output = json.dumps(
        {"calls": outcome.raw, "structured": outcome.structured, "refused": outcome.refused, "error": outcome.error, "review": outcome.review},
        ensure_ascii=False,
    )
    cur = conn.execute(
        "INSERT INTO evaluation (conversation_id, checklist_version_id, model, prompt_version, status, total, total_status, "
        "provisional, gross_violation, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, latency_ms, cost, raw_output) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            conversation_pk,
            version_id,
            client.model,
            PROMPT_VERSION,
            status,
            float(result.total) if result.total is not None else None,
            total_status,
            1 if result.provisional else 0,
            1 if result.gross_violation else 0,
            inp,
            outp,
            cr,
            cw,
            latency,
            cost,
            raw_output,
        ),
    )
    eval_id = cur.lastrowid
    scores = {s.id: s for s in result.criteria}
    for c in cfg.criteria:
        res = outcome.results.get(c.id)
        sc = scores[c.id]
        if res is None:
            conn.execute(
                "INSERT INTO criterion_result (evaluation_id, criterion_id, answer, points, effective_points, rationale, evidence_json, "
                "checked_range, na_reason, needs_review) VALUES (?,?,?,?,?,?,?,?,?,1)",
                (eval_id, c.id, "needs_review", None, None, outcome.review.get(c.id, "needs review"), "[]", None, None),
            )
            continue
        conn.execute(
            "INSERT INTO criterion_result (evaluation_id, criterion_id, answer, points, effective_points, rationale, evidence_json, "
            "checked_range, na_reason, needs_review) VALUES (?,?,?,?,?,?,?,?,?,0)",
            (
                eval_id,
                c.id,
                str(res["answer"]),
                float(sc.points) if sc.points is not None else None,
                float(sc.effective_points) if sc.effective_points is not None else None,
                res["rationale"],
                json.dumps(res["evidence"], ensure_ascii=False),
                json.dumps(res["checked_range"]) if res["checked_range"] else None,
                res["na_reason"],
            ),
        )
    conn.commit()
    return get_evaluation(conn, eval_id)


def get_evaluation(conn: sqlite3.Connection, evaluation_id: int) -> dict:
    row = conn.execute("SELECT * FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone()
    if not row:
        raise LookupError("Evaluation not found")
    ev = dict(row)
    ev["provisional"] = bool(ev["provisional"])
    ev["gross_violation"] = bool(ev["gross_violation"])
    ev.pop("raw_output", None)
    crit_rows = conn.execute(
        "SELECT criterion_id, answer, points, effective_points, rationale, evidence_json, checked_range, na_reason, needs_review "
        "FROM criterion_result WHERE evaluation_id = ? ORDER BY id",
        (evaluation_id,),
    ).fetchall()
    criteria = []
    for r in crit_rows:
        d = dict(r)
        d["evidence"] = json.loads(d.pop("evidence_json") or "[]")
        d["checked_range"] = json.loads(d["checked_range"]) if d["checked_range"] else None
        d["needs_review"] = bool(d["needs_review"])
        criteria.append(d)
    ev["criteria"] = criteria
    return ev
