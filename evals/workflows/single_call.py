from backend.app.services.evaluator import build_schema, build_system_prompt, build_user_prompt
from evals.workflows.base import Stage, Workflow, build_candidate, record_calls, resolve_profile
from evals.workflows.review import ReviewPass

PROMPTS = {"v1": (build_system_prompt, build_user_prompt)}


def conversation_of(case: dict) -> tuple[dict, list[dict]]:
    conv = case["conversation"]
    return {"channel": conv.get("channel"), "language": conv.get("language")}, conv["messages"]


class SingleCall(Workflow):
    name = "single_call"
    stage_count = 2

    def __init__(self, cfg, variant, params=None):
        super().__init__(cfg, variant, params)
        self.prompt = self.params.get("prompt", "v1")
        if self.prompt not in PROMPTS:
            raise KeyError(f"unknown prompt version {self.prompt!r}, known: {sorted(PROMPTS)}")
        self.profile_name = self.params.get("profile", "claude-opus-5-5")
        self.profile = resolve_profile(self.profile_name, self.params.get("effort"))
        self.pass_ = ReviewPass(
            cfg, "main", "main", self.profile_name, self.profile, build_schema(cfg), [c.id for c in cfg.criteria], "single_call"
        )

    def stage(self, index, case, state):
        conv, messages = conversation_of(case)
        if index == 0:
            system_builder, user_builder = PROMPTS[self.prompt]
            req = self.pass_.first_request(state, system_builder(self.cfg), user_builder(conv, messages))

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
        return [("single_call", self.profile.model, 1)]
