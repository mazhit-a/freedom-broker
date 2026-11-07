import json
import re

from backend.app.services.evaluator import build_schema, build_system_prompt, build_user_prompt, transcript_lines
from evals.workflows.base import ANTHROPIC, LLMRequest, Stage, Workflow, build_candidate, build_params, record_calls, resolve_profile
from evals.workflows.review import ReviewPass
from evals.workflows.single_call import conversation_of

EVENT_KINDS = [
    "identity_verified",
    "escalation",
    "hold_on",
    "hold_off",
    "recording_paused",
    "recording_resumed",
    "transfer",
    "chat_closed",
    "client_left",
    "connection_lost",
    "language_switch",
    "other",
]
OFFER_KINDS = ["personal_paid_consultation", "confidential_data_disclosure", "insult", "other"]

EXTRACT_RULES = [
    "You extract neutral facts from a contact-centre conversation. You do NOT score anything and you do not judge quality.",
    "Bot and system messages are context. Only the human operator counts as the operator. A greeting by the bot is not the operator's greeting.",
    "Transcripts are in Russian, Kazakh or English. Voice transcripts are noisy ASR output with duplicated lines and redaction placeholders; read the intent.",
    "Every fact must cite message_index values that exist in the transcript. Quotes must be exact substrings of the cited message in its original language.",
    "events: every system event (identity verified, escalation to operator, hold, recording pause, transfer, chat closed, client left, connection lost, language switch).",
    "greeting: whether the human operator greeted or introduced themselves, and where. verification: whether identity verification was needed, and whether it was confirmed by an event or by the operator. escalation: where the chat reached the operator and the operator's first reply.",
    "offers: any operator message that offers a personal paid consultation or service outside the company, discloses confidential data, or insults the client, otherwise an empty list.",
    "client_requests: each request or question of the client, in order, with a one-line summary. closing: whether the operator closed the conversation politely before it ended.",
    "Return JSON only, matching the requested schema.",
]


def _nullable(t: str) -> dict:
    return {"anyOf": [{"type": t}, {"type": "null"}]}


FACTS_SCHEMA = {
    "type": "object",
    "properties": {
        "events": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "message_index": {"type": "integer"},
                    "kind": {"type": "string", "enum": EVENT_KINDS},
                    "note": {"type": "string"},
                },
                "required": ["message_index", "kind", "note"],
                "additionalProperties": False,
            },
        },
        "greeting": {
            "type": "object",
            "properties": {
                "operator_greeted": {"type": "boolean"},
                "operator_introduced": {"type": "boolean"},
                "message_index": _nullable("integer"),
                "quote": _nullable("string"),
                "bot_greeted_only": {"type": "boolean"},
            },
            "required": ["operator_greeted", "operator_introduced", "message_index", "quote", "bot_greeted_only"],
            "additionalProperties": False,
        },
        "verification": {
            "type": "object",
            "properties": {
                "needed": {"type": "boolean"},
                "confirmed": {"type": "boolean"},
                "message_index": _nullable("integer"),
                "note": {"type": "string"},
            },
            "required": ["needed", "confirmed", "message_index", "note"],
            "additionalProperties": False,
        },
        "escalation": {
            "type": "object",
            "properties": {
                "occurred": {"type": "boolean"},
                "message_index": _nullable("integer"),
                "operator_first_reply_index": _nullable("integer"),
            },
            "required": ["occurred", "message_index", "operator_first_reply_index"],
            "additionalProperties": False,
        },
        "offers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "message_index": {"type": "integer"},
                    "kind": {"type": "string", "enum": OFFER_KINDS},
                    "quote": {"type": "string"},
                    "note": {"type": "string"},
                },
                "required": ["message_index", "kind", "quote", "note"],
                "additionalProperties": False,
            },
        },
        "client_requests": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"message_index": {"type": "integer"}, "summary": {"type": "string"}},
                "required": ["message_index", "summary"],
                "additionalProperties": False,
            },
        },
        "closing": {
            "type": "object",
            "properties": {"operator_closed": {"type": "boolean"}, "message_index": _nullable("integer")},
            "required": ["operator_closed", "message_index"],
            "additionalProperties": False,
        },
    },
    "required": ["events", "greeting", "verification", "escalation", "offers", "client_requests", "closing"],
    "additionalProperties": False,
}

INDEX_PATHS = [
    ("events", "message_index"),
    ("offers", "message_index"),
    ("client_requests", "message_index"),
]
INDEX_OBJECTS = [
    ("greeting", "message_index"),
    ("verification", "message_index"),
    ("escalation", "message_index"),
    ("escalation", "operator_first_reply_index"),
    ("closing", "message_index"),
]


def extract_system() -> str:
    return "\n".join(f"{i}. {r}" for i, r in enumerate(EXTRACT_RULES, 1))


def parse_facts(text: str, messages: list[dict]) -> tuple[dict | None, list[str]]:
    body = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip())
    try:
        data = json.loads(body)
    except ValueError:
        return None, ["facts output is not valid JSON"]
    if not isinstance(data, dict):
        return None, ["facts output is not an object"]
    known = {m["message_index"] for m in messages}
    issues: list[str] = []
    for key, field in INDEX_PATHS:
        kept = []
        for item in data.get(key) or []:
            if isinstance(item, dict) and item.get(field) in known:
                kept.append(item)
            else:
                issues.append(f"{key}: dropped an item with unknown message_index")
        data[key] = kept
    for key, field in INDEX_OBJECTS:
        obj = data.get(key)
        if isinstance(obj, dict) and obj.get(field) is not None and obj.get(field) not in known:
            issues.append(f"{key}.{field}: unknown message_index {obj.get(field)!r}")
            obj[field] = None
    return data, issues


def judge_user_text(conv: dict, messages: list[dict], facts: dict | None) -> str:
    base = build_user_prompt(conv, messages)
    if facts is None:
        return base
    block = (
        "Extracted facts (preliminary, produced by an earlier pass over this conversation; the transcript is authoritative "
        "and these facts may be wrong):\n" + json.dumps(facts, ensure_ascii=False, indent=1)
    )
    tail = "\n\nEvaluate every criterion now."
    return base[: -len(tail)] + "\n\n" + block + tail


class ExtractThenJudge(Workflow):
    name = "extract_then_judge"
    stage_count = 3

    def __init__(self, cfg, variant, params=None):
        super().__init__(cfg, variant, params)
        self.profile_name = self.params.get("profile", "claude-opus-5-5")
        self.profile = resolve_profile(self.profile_name, self.params.get("effort"))
        self.extract_profile_name = self.params.get("extract_profile", self.profile_name)
        self.extract_profile = resolve_profile(self.extract_profile_name, self.params.get("extract_effort", self.params.get("effort")))
        self.pass_ = ReviewPass(
            cfg, "judge", "judge", self.profile_name, self.profile, build_schema(cfg), [c.id for c in cfg.criteria], "single_call"
        )

    def stage(self, index, case, state):
        conv, messages = conversation_of(case)
        if index == 0:
            head = f"Conversation metadata: channel={conv.get('channel')}, language={conv.get('language')}, messages={len(messages)}"
            user = head + "\n\nTranscript:\n" + "\n".join(transcript_lines(messages)) + "\n\nExtract the facts now."
            params = build_params(self.extract_profile, extract_system(), [{"role": "user", "content": user}], FACTS_SCHEMA)
            req = LLMRequest("extract", ANTHROPIC, self.extract_profile_name, params, "extract")

            def reduce_extract(st, responses):
                record_calls(st, "extract", responses)
                resp = responses["extract"]
                facts, issues = (None, [f"extraction {resp.status}"]) if resp.refused else parse_facts(resp.text, messages)
                st["facts"], st["fact_issues"] = facts, issues
                return st

            return Stage("extract", [req], reduce_extract)
        if index == 1:
            req = self.pass_.first_request(state, build_system_prompt(self.cfg), judge_user_text(conv, messages, state.get("facts")))

            def reduce_first(st, responses):
                record_calls(st, "first", responses)
                self.pass_.ingest_first(st, responses, messages)
                return st

            return Stage("first", [req], reduce_first)
        repair = self.pass_.repair_request(state)

        def reduce_repair(st, responses):
            record_calls(st, "repair", responses)
            self.pass_.ingest_repair(st, responses, messages)
            return st

        return Stage("repair", [repair] if repair else [], reduce_repair)

    def finish(self, case, state):
        ns = state["judge"]
        return build_candidate(
            case, self.variant, self.cfg, ns["ok"], ns["review"], state, ns["refused"],
            structured=ns.get("structured", False),
            facts=state.get("facts"),
            fact_issues=state.get("fact_issues", []),
        )

    def expected_calls(self):
        return 2

    def estimate_plan(self):
        return [("extract", self.extract_profile.model, 1), ("single_call", self.profile.model, 1)]
