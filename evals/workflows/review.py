from typing import Any, Callable

from backend.app.schemas.checklist import ChecklistConfig, Criterion
from backend.app.services.evaluator import parse_results, validate_item
from backend.app.services.model_profiles import ModelProfile
from evals.workflows.base import ANTHROPIC, REFUSAL_REASON, LLMRequest, Response, build_params

ItemValidator = Callable[[Criterion, Any, list[dict]], tuple[dict | None, list[str]]]


def default_validator(c: Criterion, item: Any, messages: list[dict]) -> tuple[dict | None, list[str]]:
    return validate_item(c, item, messages)


def validate_pass(
    cfg: ChecklistConfig, text: str, messages: list[dict], wanted: list[str], validator: ItemValidator = default_validator
) -> tuple[dict[str, dict], dict[str, list[str]]]:
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
            row, errs = validator(crit[cid], by_id[cid], messages)
            if errs:
                bad[cid] = errs
            else:
                ok[cid] = row
    return ok, bad


def repair_prompt(bad: dict[str, list[str]]) -> str:
    problems = "\n".join(f"- {cid}: {'; '.join(errs)}" for cid, errs in bad.items())
    return (
        "Your previous answer had validation errors for these criteria:\n"
        + problems
        + "\nReturn corrected results for ONLY these criteria, in the same JSON format. "
        "Quotes must be exact substrings of the cited message, rationales must be in Russian, "
        "checked_range is required for a missed-action no, na_reason is required for na."
    )


class ReviewPass:
    def __init__(
        self,
        cfg: ChecklistConfig,
        key: str,
        request_id: str,
        profile_name: str,
        profile: ModelProfile,
        schema: dict,
        wanted: list[str],
        group: str,
        validator: ItemValidator = default_validator,
    ):
        self.cfg = cfg
        self.key = key
        self.request_id = request_id
        self.profile_name = profile_name
        self.profile = profile
        self.schema = schema
        self.wanted = wanted
        self.group = group
        self.validator = validator

    def ns(self, state: dict) -> dict:
        return state.setdefault(self.key, {})

    def first_request(self, state: dict, system_text: str, content: Any) -> LLMRequest:
        convo = [{"role": "user", "content": content}]
        self.ns(state).update(system=system_text, convo=convo, ok={}, bad={}, review={}, refused=False)
        params = build_params(self.profile, system_text, convo, self.schema)
        return LLMRequest(self.request_id, ANTHROPIC, self.profile_name, params, self.group)

    def ingest_first(self, state: dict, responses: dict[str, Response], messages: list[dict]) -> None:
        ns = self.ns(state)
        first = responses[self.request_id]
        ns["first_text"] = first.text
        ns["structured"] = first.structured
        if first.refused:
            ns["refused"] = True
            for cid in self.wanted:
                ns["review"][cid] = REFUSAL_REASON
            return
        ns["ok"], ns["bad"] = validate_pass(self.cfg, first.text, messages, self.wanted, self.validator)

    def repair_request(self, state: dict) -> LLMRequest | None:
        ns = self.ns(state)
        if ns["refused"] or not ns["bad"]:
            return None
        messages = ns["convo"] + [
            {"role": "assistant", "content": ns["first_text"] or "{}"},
            {"role": "user", "content": repair_prompt(ns["bad"])},
        ]
        params = build_params(self.profile, ns["system"], messages, self.schema)
        return LLMRequest(self.request_id + "_repair", ANTHROPIC, self.profile_name, params, self.group)

    def ingest_repair(self, state: dict, responses: dict[str, Response], messages: list[dict]) -> None:
        ns = self.ns(state)
        rid = self.request_id + "_repair"
        if rid not in responses:
            return
        second = responses[rid]
        bad = ns["bad"]
        if second.refused:
            ns["refused"] = True
            for cid, errs in bad.items():
                ns["review"][cid] = "; ".join(errs) + "; repair refused"
            return
        ok2, bad2 = validate_pass(self.cfg, second.text, messages, list(bad), self.validator)
        ns["ok"].update(ok2)
        for cid, errs in bad2.items():
            ns["review"][cid] = "; ".join(errs)
