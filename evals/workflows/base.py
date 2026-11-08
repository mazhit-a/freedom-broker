from dataclasses import dataclass, field
from typing import Any, Callable

from backend.app.core.config import Settings
from backend.app.schemas.checklist import ChecklistConfig
from backend.app.services.llm_client import LLMClient
from backend.app.services.model_profiles import ModelProfile, get_profile

OK = "ok"
TRUNCATED = "truncated"
REFUSED = "refused"
ERROR = "error"

ANTHROPIC = "anthropic"
JEV = "jev"
OPENAI = "openai"

REFUSAL_REASON = "Модель отказалась от оценки (refusal)"


class InfrastructureError(Exception):
    pass


@dataclass
class LLMRequest:
    request_id: str
    kind: str
    profile: str
    params: dict
    group: str = ""


@dataclass
class Response:
    request_id: str
    status: str
    kind: str = ANTHROPIC
    model: str = ""
    text: str = ""
    stop_reason: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    latency_ms: int | None = None
    cost: float = 0.0
    structured: bool = False
    batch: bool = False
    attempts: int = 1
    error: str | None = None
    data: dict | None = None
    raw: Any = field(default=None, repr=False)

    @property
    def refused(self) -> bool:
        return self.status == REFUSED

    @property
    def truncated(self) -> bool:
        return self.status == TRUNCATED


Reduce = Callable[[dict, dict[str, Response]], dict]


@dataclass
class Stage:
    name: str
    requests: list[LLMRequest]
    reduce: Reduce


def resolve_profile(name: str, effort: str | None = None) -> ModelProfile:
    profile = get_profile(name)
    if not profile.supports_effort:
        return profile.with_overrides(effort=None)
    return profile.with_overrides(effort=effort) if effort else profile


def build_params(profile: ModelProfile, system_text: str, messages: list[dict], schema: dict | None) -> dict:
    client = LLMClient(sdk=object(), settings=Settings(_env_file=None), profile=profile)
    return client._request(system_text, messages, schema)


def call_record(response: Response, stage: str) -> dict:
    return {
        "stage": stage,
        "request_id": response.request_id,
        "provider": response.kind,
        "model": response.model,
        "input_tokens": response.input_tokens,
        "output_tokens": response.output_tokens,
        "cache_read_tokens": response.cache_read_tokens,
        "cache_write_tokens": response.cache_write_tokens,
        "latency_ms": response.latency_ms,
        "cost": response.cost,
        "structured": response.structured,
        "stop_reason": response.stop_reason,
        "status": response.status,
        "truncated": response.truncated,
        "batch": response.batch,
        "attempts": response.attempts,
    }


def record_calls(state: dict, stage: str, responses: dict[str, Response]) -> None:
    for rid in sorted(responses):
        state["calls"].append(call_record(responses[rid], stage))


def build_candidate(case: dict, variant: str, cfg: ChecklistConfig, results: dict, review: dict, state: dict, refused: bool, **extra: Any) -> dict:
    order = [c.id for c in cfg.criteria]
    cand = {
        "case_id": case["id"],
        "variant": variant,
        "results": {cid: results[cid] for cid in order if cid in results},
        "needs_review": {cid: review[cid] for cid in order if cid in review},
        "calls": list(state["calls"]),
        "refused": refused,
        "error": None,
        "mode": None,
    }
    cand.update(extra)
    return cand


class Workflow:
    name = ""
    stage_count = 1

    def __init__(self, cfg: ChecklistConfig, variant: str, params: dict | None = None):
        self.cfg = cfg
        self.variant = variant
        self.params = dict(params or {})

    def new_state(self, case: dict) -> dict:
        return {"calls": []}

    def stage(self, index: int, case: dict, state: dict) -> Stage:
        raise NotImplementedError

    def finish(self, case: dict, state: dict) -> dict:
        raise NotImplementedError

    def expected_calls(self) -> int:
        return 1

    def estimate_plan(self) -> list[tuple[str, str, int]]:
        raise NotImplementedError

    def served_models(self) -> list[str]:
        return [model for _, model, _ in self.estimate_plan()]
