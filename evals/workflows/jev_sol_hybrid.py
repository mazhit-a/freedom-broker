import copy
from typing import Any

from backend.app.schemas.checklist import Criterion
from backend.app.services.evaluator import validate_item
from evals.decisions import JEV_MODEL, build_request
from evals.gen import openai_provider as op
from evals.workflows.base import JEV, InfrastructureError, LLMRequest, Stage, Workflow, build_candidate, record_calls
from evals.workflows.jev import explain_validator, jev_rows
from evals.workflows.openai_single_call import GROUP, OpenAIReviewPass, strict_schema
from evals.workflows.single_call import PROMPTS, conversation_of

XML_PROMPT = "v3_xml"

FIXED_RULES = (
    "Fixed classifications. A separate decision model has already classified some of the criteria. Their answers are listed in the "
    "user message between the FIXED CLASSIFICATIONS markers, one per line as 'criterion id: fixed answer', and they are FINAL.\n"
    "1. For every listed criterion copy the fixed answer unchanged into \"answer\". Never change it and never decide it again.\n"
    "2. For a listed criterion your job is to find the evidence in the transcript and write the Russian rationale that supports exactly "
    "the fixed answer. Follow all rules above: give evidence quotes for a fixed yes or a fixed flag answer; for a fixed no on a yes_no "
    "criterion give checked_range as the rules require (and evidence when there is some); for a fixed na give na_reason.\n"
    "3. Decide every criterion that is not listed yourself, exactly as usual.\n"
    "4. Every result object has two extra required fields: disputed (boolean) and dispute_reason (string or null). For every criterion "
    "you decide yourself set disputed to false and dispute_reason to null.\n"
    "5. Set disputed to true, with the reason in Russian in dispute_reason, ONLY for a listed criterion when the transcript clearly "
    "contradicts the fixed answer. Even then the answer field must still equal the fixed answer; in that case evidence or checked_range "
    "may be omitted when you cannot honestly support the answer. In every other case disputed is false and dispute_reason is null."
)
FIXED_BEGIN = "=== FIXED CLASSIFICATIONS (criterion id: fixed answer) ==="
FIXED_END = "=== END FIXED CLASSIFICATIONS ==="


def jev_criteria(cfg) -> list[Criterion]:
    return [c for c in cfg.criteria if c.type == "flag" or (c.type == "yes_no" and not c.na_allowed)]


def hybrid_schema(cfg) -> dict:
    schema = copy.deepcopy(strict_schema(cfg))
    item = schema["properties"]["results"]["items"]
    item["properties"]["disputed"] = {"type": "boolean"}
    item["properties"]["dispute_reason"] = {"type": ["string", "null"]}
    item["required"] = item["required"] + ["disputed", "dispute_reason"]
    return schema


def fixed_system(system_text: str, xml: bool) -> str:
    if xml:
        return system_text + "\n\n<fixed_classification_rules>\n" + FIXED_RULES + "\n</fixed_classification_rules>"
    return system_text + "\n\n" + FIXED_RULES


def fixed_lines(fixed: dict[str, Any], jev_rows_: dict[str, dict], show_confidence: bool) -> list[str]:
    lines = []
    for cid, value in fixed.items():
        line = f"{cid}: {value}"
        conf = jev_rows_[cid].get("confidence")
        if show_confidence and isinstance(conf, (int, float)) and not isinstance(conf, bool):
            line += f" (decision model confidence {conf:.2f})"
        lines.append(line)
    return lines


def fixed_user(user_text: str, lines: list[str], xml: bool) -> str:
    body = "\n".join(lines)
    if xml:
        return user_text + "\n\n<fixed_classifications>\n" + body + "\n</fixed_classifications>"
    return user_text + "\n\n" + FIXED_BEGIN + "\n" + body + "\n" + FIXED_END


def hybrid_validator(fixed: dict[str, Any]):
    fixed_check = explain_validator(fixed)

    def validate(c: Criterion, item: Any, messages: list[dict]):
        if c.id in fixed:
            return fixed_check(c, item, messages)
        row, errors = validate_item(c, item, messages)
        if isinstance(item, dict) and item.get("disputed") is True:
            errors = errors + [f"criterion {c.id}: disputed must be false for a criterion you decide yourself"]
        if errors:
            return None, errors
        return row, []

    return validate


class JevSolHybrid(Workflow):
    name = "jev_sol_hybrid"
    stage_count = 3

    def __init__(self, cfg, variant, params=None):
        super().__init__(cfg, variant, params)
        self.prompt = self.params.get("prompt", "v2")
        if self.prompt not in PROMPTS:
            raise KeyError(f"unknown prompt version {self.prompt!r}, known: {sorted(PROMPTS)}")
        self.model = self.params.get("model", op.DEFAULT_MODEL)
        self.effort = self.params.get("effort", op.DEFAULT_EFFORT)
        if self.effort not in op.EFFORTS:
            raise ValueError(f"effort must be one of {op.EFFORTS}")
        self.max_output_tokens = int(self.params.get("max_output_tokens", op.DEFAULT_MAX_OUTPUT_TOKENS))
        self.show_confidence = bool(self.params.get("show_confidence", False))
        self.jev_criteria = jev_criteria(cfg)
        if not self.jev_criteria:
            raise ValueError("the checklist has no strictly yes/no or flag criteria for the decision model")
        self.jev_ids = [c.id for c in self.jev_criteria]
        self.schema = hybrid_schema(cfg)
        self.ids = [c.id for c in cfg.criteria]

    def jev_stage(self, case: dict) -> Stage:
        payload, _ = build_request(case["conversation"], self.cfg, criterion_ids=self.jev_ids)

        def reduce_jev(state, responses):
            record_calls(state, "jev", responses)
            state["jev_answers"] = responses["jev"].data["answers"]
            return state

        return Stage("jev", [LLMRequest("jev", JEV, JEV_MODEL, payload, "jev")], reduce_jev)

    def sol_stage(self, case: dict, state: dict) -> Stage:
        conv, messages = conversation_of(case)
        rows, problems = jev_rows(self.cfg, state["jev_answers"], self.jev_criteria)
        if problems:
            raise InfrastructureError("decision model answer unusable: " + "; ".join(f"{cid}: {msg}" for cid, msg in problems.items()))
        fixed = {cid: rows[cid]["answer"] for cid in self.jev_ids}
        state["jev_rows"], state["fixed"] = rows, fixed
        xml = self.prompt == XML_PROMPT
        system_builder, user_builder = PROMPTS[self.prompt]
        system_text = fixed_system(system_builder(self.cfg), xml)
        user_text = fixed_user(user_builder(conv, messages), fixed_lines(fixed, rows, self.show_confidence), xml)
        pass_ = OpenAIReviewPass(
            self.cfg, self.model, self.effort, self.max_output_tokens, self.schema, self.ids, GROUP, hybrid_validator(fixed)
        )
        state["pass"] = pass_
        req = pass_.first_request(state, system_text, user_text)

        def reduce_first(st, responses):
            record_calls(st, "first", responses)
            pass_.ingest_first(st, responses, messages)
            return st

        return Stage("sol", [req], reduce_first)

    def stage(self, index, case, state):
        if index == 0:
            return self.jev_stage(case)
        if index == 1:
            return self.sol_stage(case, state)
        _, messages = conversation_of(case)
        pass_ = state["pass"]
        repair = pass_.repair_request(state)

        def reduce_repair(st, responses):
            record_calls(st, "repair", responses)
            pass_.ingest_repair(st, responses, messages)
            return st

        return Stage("repair", [repair] if repair else [], reduce_repair)

    def finish(self, case, state):
        ns = state["main"]
        fixed = state["fixed"]
        results: dict[str, dict] = {}
        disputes: dict[str, str] = {}
        for cid, row in ns["ok"].items():
            merged = dict(row)
            if cid in fixed:
                merged["answer"] = fixed[cid]
            results[cid] = merged
            if cid in fixed and row.get("disputed"):
                disputes[cid] = row["dispute_reason"]
        source = {cid: ("jev" if cid in fixed else "sol") for cid in self.ids if cid in results}
        jev_detail = {}
        for cid, jrow in state["jev_rows"].items():
            jev_detail[cid] = {"answer": str(fixed[cid]), "confidence": jrow.get("confidence"), "distribution": jrow.get("distribution")}
            if "detail" in jrow:
                jev_detail[cid]["detail"] = jrow["detail"]
        return build_candidate(
            case, self.variant, self.cfg, results, ns["review"], state, ns["refused"],
            structured=ns.get("structured", False),
            disputes=disputes,
            source=source,
            jev_detail=jev_detail,
        )

    def expected_calls(self):
        return 2

    def estimate_plan(self):
        return [("jev", JEV_MODEL, 1), (GROUP, self.model, 1)]
