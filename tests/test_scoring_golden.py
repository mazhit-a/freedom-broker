import json
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import pytest

from backend.app.services.scoring import ScoringError, score

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[1] / "frontend/tests/fixtures/scoring_cases.json").read_text()
)
CENT = Decimal("0.01")


def fixed(value):
    if value is None:
        return None
    return str(Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP))


def q(value):
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=[c["name"] for c in GOLDEN["cases"]])
def test_golden_case(case):
    config = GOLDEN["configs"][case["config"]]
    expect = case["expect"]
    if expect.get("error"):
        with pytest.raises(ScoringError):
            score(config, case["answers"], case.get("overrides"))
        return
    r = score(config, case["answers"], case.get("overrides"))
    assert fixed(r.total) == expect["total"]
    assert r.calculated == expect["calculated"]
    assert r.provisional == expect["provisional"]
    assert r.gross_violation == expect["grossViolation"]
    assert r.needs_review_ids == expect["needsReviewIds"]
    if "reason" in expect:
        assert r.reason == expect["reason"]

    counted = [c for c in r.criteria if c.type != "flag" and c.status == "answered"]
    applicable = sum((c.weight for c in counted), Decimal(0))
    if "applicableWeight" in expect:
        assert fixed(applicable) == expect["applicableWeight"]
    if "factor" in expect:
        assert Decimal(100) / applicable == Decimal(str(expect["factor"]))

    secs = {s.id: s for s in r.sections}
    for sid, want in expect.get("sections", {}).items():
        s = secs[sid]
        assert fixed(s.earned) == want["earned"]
        assert fixed(s.applicable_max) == want["applicableMax"]
        assert fixed(s.percent) == want["percent"]
        if s.earned is None:
            assert want["effectivePoints"] is None and want["effectiveMax"] is None
        else:
            assert fixed(Decimal(s.earned) * 100 / applicable) == want["effectivePoints"]
            assert fixed(s.applicable_max * 100 / applicable) == want["effectiveMax"]

    rows = {c.id: c for c in r.criteria}
    for cid, want in expect.get("criteria", {}).items():
        c = rows[cid]
        if "points" in want:
            assert fixed(c.points) == want["points"]
        if "effectivePoints" in want:
            assert fixed(c.effective_points) == want["effectivePoints"]
        if "effectiveWeight" in want:
            counted_row = c.type != "flag" and c.status == "answered"
            eff = c.weight * 100 / applicable if counted_row else None
            assert fixed(eff) == want["effectiveWeight"]
        if "na" in want:
            assert (c.status == "na") == want["na"]
