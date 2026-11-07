from backend.app.schemas.checklist import ChecklistConfig
from backend.app.services.evaluator import OUTPUT_FORMAT, RULES, build_schema, render_criterion, transcript_lines
from evals.workflows.base import Stage, Workflow, build_candidate, record_calls, resolve_profile
from evals.workflows.review import ReviewPass
from evals.workflows.single_call import conversation_of

CRITERION_RULE = (
    "You are given exactly one criterion. Evaluate ONLY that criterion and return a results list with exactly one object, "
    "using its exact criterion_id. Return JSON only, matching the requested schema, with no text outside the JSON."
)


def system_text() -> str:
    rules = RULES[:-1] + [CRITERION_RULE]
    return "\n".join(f"{i}. {r}" for i, r in enumerate(rules, 1))


def single_config(cfg: ChecklistConfig, cid: str) -> ChecklistConfig:
    return cfg.model_copy(update={"criteria": [c for c in cfg.criteria if c.id == cid]})


def content_blocks(cfg: ChecklistConfig, conv: dict, messages: list[dict], cid: str) -> list[dict]:
    titles = {s.id: s.title for s in cfg.sections}
    crit = next(c for c in cfg.criteria if c.id == cid)
    head = f"Conversation metadata: channel={conv.get('channel')}, language={conv.get('language')}, messages={len(messages)}"
    transcript = head + "\n\nTranscript:\n" + "\n".join(transcript_lines(messages))
    focus = (
        f"Checklist: {cfg.name}\n\nCriterion to evaluate now (evaluate ONLY this one):\n"
        + render_criterion(crit, titles)
        + "\n\n"
        + OUTPUT_FORMAT
    )
    return [
        {"type": "text", "text": transcript, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": focus},
    ]


class PerCriterion(Workflow):
    name = "per_criterion"
    stage_count = 2

    def __init__(self, cfg, variant, params=None):
        super().__init__(cfg, variant, params)
        self.profile_name = self.params.get("profile", "claude-opus-5-5")
        self.profile = resolve_profile(self.profile_name, self.params.get("effort"))
        self.ids = [c.id for c in cfg.criteria]
        self.passes = {
            cid: ReviewPass(
                single_config(cfg, cid), f"c_{cid}", f"c{cid}", self.profile_name, self.profile,
                build_schema(single_config(cfg, cid)), [cid], "per_criterion",
            )
            for cid in self.ids
        }

    def stage(self, index, case, state):
        conv, messages = conversation_of(case)
        if index == 0:
            system = system_text()
            requests = [self.passes[cid].first_request(state, system, content_blocks(self.cfg, conv, messages, cid)) for cid in self.ids]

            def reduce_first(st, responses):
                record_calls(st, "criteria", responses)
                for cid in self.ids:
                    self.passes[cid].ingest_first(st, responses, messages)
                return st

            return Stage("criteria", requests, reduce_first)
        requests = [r for r in (self.passes[cid].repair_request(state) for cid in self.ids) if r is not None]

        def reduce_repair(st, responses):
            record_calls(st, "repair", responses)
            for cid in self.ids:
                self.passes[cid].ingest_repair(st, responses, messages)
            return st

        return Stage("repair", requests, reduce_repair)

    def finish(self, case, state):
        results, review, refused_ids = {}, {}, []
        for cid in self.ids:
            ns = state[f"c_{cid}"]
            results.update(ns["ok"])
            review.update(ns["review"])
            if ns["refused"]:
                refused_ids.append(cid)
        return build_candidate(case, self.variant, self.cfg, results, review, state, bool(refused_ids), refused_criteria=refused_ids)

    def expected_calls(self):
        return len(self.ids)

    def estimate_plan(self):
        return [("per_criterion", self.profile.model, len(self.ids))]
