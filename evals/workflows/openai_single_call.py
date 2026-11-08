import copy

from backend.app.services.evaluator import build_schema
from evals.decisions import annotate_gaps
from evals.gen import openai_provider as op
from evals.workflows.base import OPENAI, LLMRequest, Stage, Workflow, build_candidate, record_calls
from evals.workflows.review import ReviewPass, repair_prompt
from evals.workflows.single_call import PROMPTS, conversation_of
from evals.workflows.prompts import with_marks_note

GROUP = "openai_single_call"


def strict_schema(cfg) -> dict:
    schema = op.convert_schema(copy.deepcopy(build_schema(cfg)))
    problems = op.strict_problems(schema)
    if problems:
        raise ValueError("schema is not strict compatible: " + "; ".join(problems))
    return schema


def openai_params(model: str, effort: str, max_output_tokens: int, schema: dict, system_text: str, items: list[dict]) -> dict:
    return {
        "model": model,
        "instructions": system_text,
        "input": items,
        "max_output_tokens": max_output_tokens,
        "reasoning": {"effort": effort},
        "text": {"format": {"type": "json_schema", "name": op.SCHEMA_NAME, "schema": schema, "strict": True}},
        "store": False,
    }


class OpenAIReviewPass(ReviewPass):
    def __init__(self, cfg, model: str, effort: str, max_output_tokens: int, schema: dict, wanted: list[str], group: str):
        super().__init__(cfg, "main", "main", model, None, schema, wanted, group)
        self.model = model
        self.effort = effort
        self.max_output_tokens = max_output_tokens

    def params(self, system_text: str, items: list[dict]) -> dict:
        return openai_params(self.model, self.effort, self.max_output_tokens, self.schema, system_text, items)

    def first_request(self, state, system_text, content):
        convo = [{"role": "user", "content": content}]
        self.ns(state).update(system=system_text, convo=convo, ok={}, bad={}, review={}, refused=False)
        return LLMRequest(self.request_id, OPENAI, self.model, self.params(system_text, convo), self.group)

    def repair_request(self, state):
        ns = self.ns(state)
        if ns["refused"] or not ns["bad"]:
            return None
        items = ns["convo"] + [
            {"role": "assistant", "content": ns["first_text"] or "{}"},
            {"role": "user", "content": repair_prompt(ns["bad"])},
        ]
        return LLMRequest(self.request_id + "_repair", OPENAI, self.model, self.params(ns["system"], items), self.group)


class OpenAISingleCall(Workflow):
    name = "openai_single_call"
    stage_count = 2

    def __init__(self, cfg, variant, params=None):
        super().__init__(cfg, variant, params)
        self.prompt = self.params.get("prompt", "v1")
        if self.prompt not in PROMPTS:
            raise KeyError(f"unknown prompt version {self.prompt!r}, known: {sorted(PROMPTS)}")
        self.marks = bool(self.params.get("pause_marks", False))
        self.model = self.params.get("model", op.DEFAULT_MODEL)
        self.effort = self.params.get("effort", op.DEFAULT_EFFORT)
        if self.effort not in op.EFFORTS:
            raise ValueError(f"effort must be one of {op.EFFORTS}")
        self.max_output_tokens = int(self.params.get("max_output_tokens", op.DEFAULT_MAX_OUTPUT_TOKENS))
        self.pass_ = OpenAIReviewPass(
            cfg, self.model, self.effort, self.max_output_tokens, strict_schema(cfg), [c.id for c in cfg.criteria], GROUP
        )

    def stage(self, index, case, state):
        conv, messages = conversation_of(case)
        if index == 0:
            system_builder, user_builder = PROMPTS[self.prompt]
            system_text = system_builder(self.cfg)
            shown = messages
            if self.marks:
                system_text = with_marks_note(system_text)
                shown = annotate_gaps(messages)
            req = self.pass_.first_request(state, system_text, user_builder(conv, shown))

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
        ns = state["main"]
        return build_candidate(case, self.variant, self.cfg, ns["ok"], ns["review"], state, ns["refused"], structured=ns.get("structured", False))

    def estimate_plan(self):
        return [(GROUP, self.model, 1)]
