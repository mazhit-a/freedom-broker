import json
import re
from decimal import Decimal
from pathlib import Path

import pytest

from backend.app.schemas.checklist import ChecklistConfig
from backend.app.services import scoring
from backend.app.services.scoring import NA, NEEDS_REVIEW, ScoringError, score

ROOT = Path(__file__).resolve().parents[1]
SEED = ChecklistConfig.model_validate(
    json.loads((ROOT / "backend/app/seed/checklist_default.json").read_text())
)


def all_top():
    a = {}
    for c in SEED.criteria:
        if c.type == "yes_no":
            a[c.id] = "yes"
        elif c.type == "scale":
            a[c.id] = c.max_step
        else:
            a[c.id] = "no"
    return a


def by_id(res):
    return {c.id: c for c in res.criteria}


def test_all_top_is_100():
    r = score(SEED, all_top())
    assert r.total == Decimal("100.00")
    assert r.calculated and not r.provisional
    assert r.gross_violation is False


def test_na_on_03_rescales_to_80_max():
    a = all_top()
    a["03"] = NA
    r = score(SEED, a)
    assert r.total == Decimal("100.00")
    assert by_id(r)["03"].effective_points is None
    assert by_id(r)["01"].effective_points == Decimal("12.50")
    a["01"] = "no"
    r = score(SEED, a)
    assert r.total == Decimal("87.50")


def test_scale_partial_points():
    a = all_top()
    a["04"] = 15
    a["06"] = 7
    r = score(SEED, a)
    c = by_id(r)
    assert c["04"].points == Decimal("15.00")
    assert c["06"].points == Decimal("10.50")
    assert r.total == Decimal("90.50")


def test_all_weighted_na_not_calculated():
    cfg = ChecklistConfig.model_validate(
        {
            "name": "x",
            "criteria": [
                {"id": "a", "title": "a", "weight": 60, "type": "yes_no", "na_allowed": True, "na_condition": "c"},
                {"id": "b", "title": "b", "weight": 40, "type": "yes_no", "na_allowed": True, "na_condition": "c"},
                {"id": "g", "title": "g", "type": "flag"},
            ],
        }
    )
    r = score(cfg, {"a": NA, "b": NA, "g": "yes"})
    assert r.total is None and not r.calculated and r.reason
    assert r.gross_violation is True


def test_override_flips_to_na():
    a = all_top()
    a["02"] = "no"
    base = score(SEED, a)
    assert base.total == Decimal("85.00")
    r = score(SEED, a, overrides={"02": NA})
    assert r.total == Decimal("100.00")


def test_gross_flag_does_not_change_total():
    a = all_top()
    a["08"] = "yes"
    r = score(SEED, a)
    assert r.total == Decimal("100.00")
    assert r.gross_violation is True


def test_invalid_na_rejected():
    a = all_top()
    a["01"] = NA
    with pytest.raises(ScoringError):
        score(SEED, a)
    a = all_top()
    a["08"] = NA
    with pytest.raises(ScoringError):
        score(SEED, a)


def test_invalid_scale_step_rejected():
    a = all_top()
    a["04"] = 12
    with pytest.raises(ScoringError):
        score(SEED, a)
    a["04"] = "yes"
    with pytest.raises(ScoringError):
        score(SEED, a)


def test_unknown_criterion_rejected():
    with pytest.raises(ScoringError):
        score(SEED, {**all_top(), "zz": "yes"})


def test_rounding_half_up():
    cfg = ChecklistConfig.model_validate(
        {
            "name": "r",
            "criteria": [
                {"id": "a", "title": "a", "weight": 1, "type": "yes_no"},
                {"id": "b", "title": "b", "weight": 31, "type": "yes_no"},
            ],
        }
    )
    r = score(cfg, {"a": "yes", "b": "no"})
    assert r.total == Decimal("3.13")


def test_section_with_one_na():
    a = all_top()
    a["03"] = NA
    a["04"] = 15
    r = score(SEED, a)
    sec = {s.id: s for s in r.sections}["security"]
    assert sec.earned == Decimal("15.00")
    assert sec.applicable_max == Decimal(20)
    assert sec.percent == Decimal("75.00")


def test_fully_na_section_is_dash():
    a = all_top()
    a["03"] = NA
    a["04"] = NA
    r = score(SEED, a)
    sec = {s.id: s for s in r.sections}["security"]
    assert sec.percent is None and sec.earned is None
    gross = {s.id: s for s in r.sections}["gross"]
    assert gross.percent is None
    assert r.total == Decimal("100.00")


def test_needs_review_excluded_and_provisional():
    a = all_top()
    a["01"] = "no"
    a["02"] = NEEDS_REVIEW
    r = score(SEED, a)
    assert r.provisional
    assert r.needs_review_ids == ["02"]
    assert by_id(r)["02"].effective_points is None
    assert r.total == Decimal("88.24")
    resolved = score(SEED, a, overrides={"02": "yes"})
    assert not resolved.provisional
    assert resolved.total == Decimal("90.00")


def test_all_needs_review_not_calculated():
    r = score(SEED, {})
    assert r.total is None and r.provisional


def test_synthetic_checklist_non_seed_ids():
    cfg = {
        "name": "synthetic",
        "criteria": [
            {"id": "x-alpha", "title": "A", "weight": 50, "type": "yes_no"},
            {
                "id": "x-beta",
                "title": "B",
                "weight": 50,
                "type": "scale",
                "na_allowed": True,
                "na_condition": "n",
                "scale_steps": [
                    {"value": 0, "descriptor": "bad"},
                    {"value": 3, "descriptor": "mid"},
                    {"value": 6, "descriptor": "good"},
                ],
            },
            {"id": "x-flag", "title": "F", "type": "flag"},
        ],
    }
    r = score(cfg, {"x-alpha": "yes", "x-beta": 3, "x-flag": "no"})
    assert r.total == Decimal("75.00")
    r = score(cfg, {"x-alpha": "no", "x-beta": NA, "x-flag": "yes"})
    assert r.total == Decimal("0.00") and r.gross_violation is True
    with pytest.raises(ScoringError):
        score(cfg, {"x-alpha": "yes", "x-beta": 4, "x-flag": "no"})


def test_scoring_module_has_no_seed_ids():
    text = Path(scoring.__file__).read_text()
    assert not re.search(r"""['"]0[1-8]['"]""", text)
    assert "#" not in text and '"""' not in text
