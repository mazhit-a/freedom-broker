from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Mapping

from backend.app.schemas.checklist import ChecklistConfig, Criterion

NA = "na"
NEEDS_REVIEW = "needs_review"
YES = "yes"
NO = "no"

HUNDRED = Decimal(100)
CENT = Decimal("0.01")


class ScoringError(ValueError):
    pass


@dataclass
class CriterionScore:
    id: str
    type: str
    status: str
    answer: Any
    weight: Decimal
    points: Decimal | None
    effective_points: Decimal | None


@dataclass
class SectionScore:
    id: str | None
    title: str
    earned: Decimal | None
    applicable_max: Decimal
    percent: Decimal | None


@dataclass
class ScoreResult:
    total: Decimal | None
    calculated: bool
    reason: str | None
    provisional: bool
    needs_review_ids: list[str]
    gross_violation: bool | None
    criteria: list[CriterionScore]
    sections: list[SectionScore] = field(default_factory=list)


def _q(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _norm(value: Any) -> Any:
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("n/a", "na", "not_applicable"):
            return NA
        if v in ("needs_review", "needs review"):
            return NEEDS_REVIEW
        if v in ("yes", "no", "true", "false"):
            return {"true": YES, "false": NO}.get(v, v)
        if v.lstrip("-").isdigit():
            return int(v)
    if isinstance(value, bool):
        return YES if value else NO
    return value


def _classify(crit: Criterion, raw: Any) -> tuple[str, Any]:
    if raw is None:
        return NEEDS_REVIEW, None
    ans = _norm(raw)
    if ans == NEEDS_REVIEW:
        return NEEDS_REVIEW, None
    if ans == NA:
        if crit.type == "flag" or not crit.na_allowed:
            raise ScoringError(f"criterion {crit.id}: N/A is not allowed")
        return NA, NA
    if crit.type == "scale":
        if isinstance(ans, bool) or not isinstance(ans, int):
            raise ScoringError(f"criterion {crit.id}: invalid scale answer {raw!r}")
        if ans not in {s.value for s in crit.scale_steps}:
            raise ScoringError(f"criterion {crit.id}: {ans} is not a configured scale step")
        return "answered", ans
    if ans not in (YES, NO):
        raise ScoringError(f"criterion {crit.id}: invalid answer {raw!r}")
    return "answered", ans


def score(
    config: ChecklistConfig | Mapping[str, Any],
    answers: Mapping[str, Any],
    overrides: Mapping[str, Any] | None = None,
) -> ScoreResult:
    cfg = config if isinstance(config, ChecklistConfig) else ChecklistConfig.model_validate(config)
    merged = dict(answers)
    if overrides:
        merged.update(overrides)
    known = {c.id for c in cfg.criteria}
    unknown = sorted(set(merged) - known)
    if unknown:
        raise ScoringError(f"unknown criteria: {', '.join(unknown)}")

    rows: dict[str, dict] = {}
    for c in cfg.criteria:
        status, ans = _classify(c, merged.get(c.id))
        weight = Decimal(str(c.weight))
        points = None
        if status == "answered" and c.type != "flag":
            if c.type == "yes_no":
                points = weight if ans == YES else Decimal(0)
            else:
                points = weight * Decimal(ans) / Decimal(c.max_step)
        rows[c.id] = {"crit": c, "status": status, "answer": ans, "weight": weight, "points": points}

    def counts(r: dict) -> bool:
        return r["crit"].type != "flag" and r["status"] == "answered"

    applicable_weight = sum((r["weight"] for r in rows.values() if counts(r)), Decimal(0))
    earned_total = sum((r["points"] for r in rows.values() if counts(r)), Decimal(0))
    review_ids = [cid for cid, r in rows.items() if r["status"] == NEEDS_REVIEW]

    total = None
    reason = None
    if applicable_weight > 0:
        total = _q(HUNDRED * earned_total / applicable_weight)
    elif review_ids:
        reason = "all weighted criteria are N/A or awaiting review"
    else:
        reason = "all weighted criteria are N/A"

    criteria: list[CriterionScore] = []
    for cid, r in rows.items():
        eff = None
        if counts(r) and applicable_weight > 0:
            eff = _q(r["points"] * HUNDRED / applicable_weight)
        pts = _q(r["points"]) if r["points"] is not None else None
        criteria.append(
            CriterionScore(cid, r["crit"].type, r["status"], r["answer"], r["weight"], pts, eff)
        )

    flags = [r for r in rows.values() if r["crit"].type == "flag"]
    gross: bool | None = None
    if flags:
        if any(r["answer"] == YES for r in flags):
            gross = True
        elif any(r["status"] == NEEDS_REVIEW for r in flags):
            gross = None
        else:
            gross = False

    sections: list[SectionScore] = []
    for sec in cfg.sections:
        members = [r for r in rows.values() if r["crit"].section == sec.id and counts(r)]
        smax = sum((r["weight"] for r in members), Decimal(0))
        if smax > 0:
            earned = sum((r["points"] for r in members), Decimal(0))
            sections.append(SectionScore(sec.id, sec.title, _q(earned), smax, _q(HUNDRED * earned / smax)))
        else:
            sections.append(SectionScore(sec.id, sec.title, None, Decimal(0), None))

    return ScoreResult(
        total=total,
        calculated=total is not None,
        reason=reason,
        provisional=bool(review_ids),
        needs_review_ids=review_ids,
        gross_violation=gross,
        criteria=criteria,
        sections=sections,
    )
