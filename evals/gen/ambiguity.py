import json
import re

from backend.app.services.evaluator import normalize_answer
from evals.gen.common import SONNET_MODEL, load_checklist
from evals.gen.prompt import render_criterion
from evals.gen.validate import flag

BLIND_MAX_TOKENS = 4000

RULES = [
    "You are a strict contact-centre quality assessor. Evaluate ONLY the human operator against the checklist.",
    "Bot and system messages are context only. A greeting or introduction by the bot never counts as the operator's.",
    "no means the action was needed but skipped or done wrongly. na is allowed only when the criterion allows it and its N/A condition is actually met. If verification was needed but never confirmed anywhere in the conversation, the answer is no, not na.",
    "System events matter: identity verified, escalation, chat closed, client left, connection lost, recording paused or resumed, hold on or off, transfer.",
    "For flag criteria, answer yes only for a clear violation described in the criterion.",
    "Give one answer for every criterion: yes, no, na, or the numeric scale step as a string. Add a one-sentence rationale in Russian.",
]


def blind_schema(cfg) -> dict:
    item = {
        "type": "object",
        "properties": {
            "criterion_id": {"type": "string", "enum": [c.id for c in cfg.criteria]},
            "answer": {"type": "string"},
            "rationale": {"type": "string"},
        },
        "required": ["criterion_id", "answer", "rationale"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {"results": {"type": "array", "items": item}},
        "required": ["results"],
        "additionalProperties": False,
    }


def blind_system_prompt(cfg) -> str:
    titles = {s.id: s.title for s in cfg.sections}
    return "\n\n".join(
        [
            "\n".join(f"{i}. {r}" for i, r in enumerate(RULES, 1)),
            f"Checklist: {cfg.name}",
            "\n\n".join(render_criterion(c, titles) for c in cfg.criteria),
            'Output JSON only: {"results": [{"criterion_id": str, "answer": str, "rationale": str}]}',
        ]
    )


def blind_user_prompt(case: dict) -> str:
    conv = case["conversation"]
    lines = [
        f"[#{m['message_index']} | {m.get('timestamp_raw') or ''} | {m.get('speaker') or ''}] {m.get('text') or ''}"
        for m in conv["messages"]
    ]
    head = f"Conversation metadata: channel={conv.get('channel')}, language={conv.get('language')}, messages={len(lines)}"
    return head + "\n\nTranscript:\n" + "\n".join(lines) + "\n\nEvaluate every criterion now."


def blind_request(case: dict, cfg=None, model: str = SONNET_MODEL, max_tokens: int = BLIND_MAX_TOKENS) -> dict:
    cfg = cfg or load_checklist()
    return {
        "model": model,
        "max_tokens": max_tokens,
        "system": [{"type": "text", "text": blind_system_prompt(cfg), "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": blind_user_prompt(case)}],
        "output_config": {"format": {"type": "json_schema", "schema": blind_schema(cfg)}},
    }


def blind_batch_request(case: dict, cfg=None, **kwargs) -> dict:
    return {"custom_id": case["id"], "params": blind_request(case, cfg, **kwargs)}


def blind_batch_requests(cases: list[dict], cfg=None, **kwargs) -> list[dict]:
    cfg = cfg or load_checklist()
    return [blind_batch_request(c, cfg, **kwargs) for c in cases]


def parse_blind(cfg, text: str) -> dict[str, object]:
    data, error = parse_generation_like(text)
    if error:
        return {}
    answers = {}
    by_id = {c.id: c for c in cfg.criteria}
    for item in data["results"]:
        if not isinstance(item, dict) or item.get("criterion_id") not in by_id:
            continue
        c = by_id[item["criterion_id"]]
        value, err = normalize_answer(c, item.get("answer"))
        if err is None:
            answers[c.id] = value
    return answers


def parse_generation_like(text: str):
    try:
        data = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip()))
    except ValueError as exc:
        return None, str(exc)
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        return None, "no results list"
    return data, None


def compare(cfg, expected: dict, blind: dict[str, object]) -> list[str]:
    flags = []
    for c in cfg.criteria:
        item = expected.get(c.id)
        if not isinstance(item, dict):
            continue
        want, err = normalize_answer(c, item.get("answer"))
        if err:
            continue
        got = blind.get(c.id)
        if got is None:
            flags.append(flag("ambiguity", c.id, "blind model gave no valid answer"))
        elif got != want:
            flags.append(flag("ambiguity", c.id, f"blind model answered {got!r}, expected {want!r}"))
    return flags
