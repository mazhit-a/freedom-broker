from evals.workflows.base import Workflow
from evals.workflows.extract_then_judge import ExtractThenJudge
from evals.workflows.jev import JevExplain, JevOnly
from evals.workflows.openai_single_call import OpenAISingleCall
from evals.workflows.per_criterion import PerCriterion
from evals.workflows.single_call import SingleCall

REGISTRY: dict[str, type[Workflow]] = {
    "single_call": SingleCall,
    "openai_single_call": OpenAISingleCall,
    "per_criterion": PerCriterion,
    "extract_then_judge": ExtractThenJudge,
    "jev_only": JevOnly,
    "jev_explain": JevExplain,
}


def build_workflow(variant: dict, cfg) -> Workflow:
    name = variant["workflow"]
    if name not in REGISTRY:
        raise KeyError(f"unknown workflow {name!r}, known: {sorted(REGISTRY)}")
    return REGISTRY[name](cfg, variant["name"], variant.get("params") or {})
