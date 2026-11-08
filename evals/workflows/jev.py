import copy
import json
from typing import Any

from backend.app.schemas.checklist import Criterion
from backend.app.services.evaluator import (
    build_schema,
    build_system_prompt,
    normalize_answer,
    transcript_lines,
    validate_item,
)
from evals.compiler import CompiledError, load_compiled
from evals.decisions import COMPILED_STYLE, JEV_MODEL, build_request, build_split_requests, style_flags
from evals.workflows.base import JEV, LLMRequest, Stage, Workflow, build_candidate, record_calls, resolve_profile
from evals.workflows.review import ReviewPass
from evals.workflows.single_call import conversation_of

REQUIREMENT_ERRORS = ("at least one valid evidence item is required", "checked_range is required when the answer is no")

EXPLAIN_RULES = """Explanation mode. The answers for every criterion were already decided by an independent scoring model and are FIXED. Your job is to explain them, not to re-score.
1. For every criterion copy the fixed answer unchanged into "answer". Never change an answer.
2. Write the rationale in Russian so that it supports the fixed answer, and give evidence quotes, checked_range and na_reason according to the rules above.
3. If the transcript clearly contradicts a fixed answer, still keep the answer, set "disputed" to true and put the reason in Russian into "dispute_reason". In that case evidence or checked_range may be omitted when you cannot honestly support the answer. Otherwise "disputed" is false and "dispute_reason" is null.
4. Output format: the results list objects have the extra required fields disputed (boolean) and dispute_reason (string or null)."""


def explain_schema(cfg) -> dict:
    schema = copy.deepcopy(build_schema(cfg))
    item = schema["properties"]["results"]["items"]
    item["properties"]["disputed"] = {"type": "boolean"}
    item["properties"]["dispute_reason"] = {"anyOf": [{"type": "string"}, {"type": "null"}]}
    item["required"] = item["required"] + ["disputed", "dispute_reason"]
    return schema


def explain_system(cfg) -> str:
    return build_system_prompt(cfg) + "\n\n" + EXPLAIN_RULES


def explain_user(conv: dict, messages: list[dict], fixed: dict[str, Any]) -> str:
    head = f"Conversation metadata: channel={conv.get('channel')}, language={conv.get('language')}, messages={len(messages)}"
    return (
        head
        + "\n\nTranscript:\n"
        + "\n".join(transcript_lines(messages))
        + "\n\nFixed answers (do not change):\n"
        + json.dumps(fixed, ensure_ascii=False, sort_keys=True)
        + "\n\nExplain every criterion now."
    )


def jev_rows(cfg, answers: dict[str, dict], criteria=None) -> tuple[dict[str, dict], dict[str, str]]:
    rows: dict[str, dict] = {}
    problems: dict[str, str] = {}
    for c in cfg.criteria if criteria is None else criteria:
        a = answers.get(c.id)
        if not isinstance(a, dict):
            problems[c.id] = "Jev returned no answer"
            continue
        value, err = normalize_answer(c, a.get("answer"))
        if err:
            problems[c.id] = err
            continue
        rows[c.id] = {
            "answer": value,
            "confidence": a.get("confidence"),
            "distribution": a.get("distribution"),
            "rationale": "",
            "evidence": [],
            "checked_range": None,
            "na_reason": None,
            "unexplained": True,
        }
        if a.get("detail") is not None:
            rows[c.id]["detail"] = a["detail"]
    return rows, problems


def init_compiled(workflow: Workflow) -> None:
    workflow.compiled = None
    workflow.compiled_path = None
    if workflow.params.get("style", "default") != COMPILED_STYLE:
        return
    path = workflow.params.get("compiled")
    if not path:
        raise CompiledError(f"variant {workflow.variant}: style 'compiled' needs the 'compiled' param with the compiled file path")
    workflow.compiled = load_compiled(path, workflow.cfg)
    workflow.compiled_path = workflow.compiled["path"]


def jev_style(workflow: Workflow) -> str:
    style = workflow.params.get("style", "default")
    style_flags(style)
    return style


def jev_request_count(workflow: Workflow) -> int:
    _, split = style_flags(jev_style(workflow))
    return len(workflow.cfg.criteria) if split else 1


def jev_stage(workflow: Workflow, case: dict) -> Stage:
    style = jev_style(workflow)
    _, split = style_flags(style)
    if split:
        requests = [
            LLMRequest(f"jev_{cid}", JEV, JEV_MODEL, payload, "jev")
            for cid, payload, _ in build_split_requests(case["conversation"], workflow.cfg, style=style)
        ]
    else:
        payload, _ = build_request(case["conversation"], workflow.cfg, style=style, compiled=workflow.compiled)
        requests = [LLMRequest("jev", JEV, JEV_MODEL, payload, "jev")]

    def reduce_jev(state, responses):
        record_calls(state, "jev", responses)
        merged: dict[str, Any] = {}
        for rid in sorted(responses):
            merged.update(responses[rid].data["answers"])
        state["jev_answers"] = merged
        return state

    return Stage("jev", requests, reduce_jev)


class JevOnly(Workflow):
    name = "jev_only"
    stage_count = 1

    def __init__(self, cfg, variant, params=None):
        super().__init__(cfg, variant, params)
        init_compiled(self)

    def stage(self, index, case, state):
        return jev_stage(self, case)

    def finish(self, case, state):
        rows, problems = jev_rows(self.cfg, state["jev_answers"])
        return build_candidate(case, self.variant, self.cfg, rows, problems, state, False, explained=False)

    def expected_calls(self):
        return jev_request_count(self)

    def estimate_plan(self):
        return [("jev", JEV_MODEL, jev_request_count(self))]


def lenient_row(c: Criterion, item: dict, answer: Any) -> dict:
    evidence = [{"message_index": int(e["message_index"]), "quote": e["quote"]} for e in item.get("evidence") or []]
    rng = item.get("checked_range")
    checked = {"from": int(rng["from"]), "to": int(rng["to"])} if isinstance(rng, dict) else None
    na_reason = item.get("na_reason")
    return {
        "criterion_id": c.id,
        "answer": answer,
        "rationale": item["rationale"].strip(),
        "evidence": evidence,
        "checked_range": checked if answer != "na" else None,
        "na_reason": na_reason.strip() if answer == "na" and isinstance(na_reason, str) else None,
    }


def explain_validator(fixed: dict[str, Any]):
    def validate(c: Criterion, item: Any, messages: list[dict]):
        if not isinstance(item, dict):
            return None, [f"criterion {c.id}: result must be an object"]
        row, errors = validate_item(c, item, messages)
        answer, _ = normalize_answer(c, item.get("answer"))
        disputed = item.get("disputed") is True
        reason = item.get("dispute_reason")
        reason_ok = isinstance(reason, str) and bool(reason.strip())
        extra: list[str] = []
        if answer != fixed.get(c.id):
            extra.append(f"criterion {c.id}: the answer is fixed as {fixed.get(c.id)!r} and may not be changed")
        if disputed and not reason_ok:
            extra.append(f"criterion {c.id}: dispute_reason is required when disputed is true")
        if disputed and reason_ok and errors:
            remaining = [e for e in errors if not any(r in e for r in REQUIREMENT_ERRORS)]
            if not remaining and not extra:
                row, errors = lenient_row(c, item, answer), []
        if errors or extra:
            return None, errors + extra
        row = dict(row)
        if disputed:
            row["disputed"] = True
            row["dispute_reason"] = reason.strip()
        return row, []

    return validate


class JevExplain(Workflow):
    name = "jev_explain"
    stage_count = 3

    def __init__(self, cfg, variant, params=None):
        super().__init__(cfg, variant, params)
        init_compiled(self)
        self.profile_name = self.params.get("profile", "claude-sonnet-5-5")
        self.profile = resolve_profile(self.profile_name, self.params.get("effort"))
        self.schema = explain_schema(cfg)
        self.ids = [c.id for c in cfg.criteria]

    def make_pass(self, fixed: dict[str, Any]) -> ReviewPass:
        return ReviewPass(
            self.cfg, "explain", "explain", self.profile_name, self.profile, self.schema,
            [cid for cid in self.ids if cid in fixed], "explain", explain_validator(fixed),
        )

    def fixed_answers(self, state: dict) -> dict[str, Any]:
        rows, problems = jev_rows(self.cfg, state["jev_answers"])
        state["jev_rows"], state["jev_problems"] = rows, problems
        return {cid: row["answer"] for cid, row in rows.items()}

    def stage(self, index, case, state):
        conv, messages = conversation_of(case)
        if index == 0:
            return jev_stage(self, case)
        if index == 1:
            fixed = self.fixed_answers(state)
            state["fixed"] = fixed
            pass_ = self.make_pass(fixed)
            state["pass"] = pass_
            shown = {cid: str(v) for cid, v in fixed.items()}
            req = pass_.first_request(state, explain_system(self.cfg), explain_user(conv, messages, shown))

            def reduce_first(st, responses):
                record_calls(st, "first", responses)
                pass_.ingest_first(st, responses, messages)
                return st

            return Stage("first", [req], reduce_first)
        pass_ = state["pass"]
        repair = pass_.repair_request(state)

        def reduce_repair(st, responses):
            record_calls(st, "repair", responses)
            pass_.ingest_repair(st, responses, messages)
            return st

        return Stage("repair", [repair] if repair else [], reduce_repair)

    def finish(self, case, state):
        ns = state["explain"]
        results: dict[str, dict] = {}
        disputes: dict[str, str] = {}
        for cid, row in ns["ok"].items():
            jev = state["jev_rows"][cid]
            merged = dict(row)
            merged["confidence"] = jev["confidence"]
            merged["distribution"] = jev["distribution"]
            results[cid] = merged
            if row.get("disputed"):
                disputes[cid] = row["dispute_reason"]
        review = dict(state["jev_problems"])
        review.update(ns["review"])
        return build_candidate(
            case, self.variant, self.cfg, results, review, state, ns["refused"],
            structured=ns.get("structured", False),
            disputes=disputes,
            explained=True,
            jev_answers={cid: str(v) for cid, v in state["fixed"].items()},
        )

    def expected_calls(self):
        return jev_request_count(self) + 1

    def estimate_plan(self):
        return [("jev", JEV_MODEL, jev_request_count(self)), ("explain", self.profile.model, 1)]
