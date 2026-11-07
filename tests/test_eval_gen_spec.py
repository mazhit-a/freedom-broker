import json
from collections import Counter

from evals.gen import spec as spec_mod
from evals.gen.common import LENGTHS, TOPICS, load_checklist, possible_answers

CFG = load_checklist()
SPECS = spec_mod.sample_specs()


def test_checklist_is_the_frozen_v2():
    assert [c.id for c in CFG.criteria] == ["01", "02", "03", "04", "05", "06", "07", "08"]
    assert possible_answers(CFG)["04"] == [20, 15, 10, 5, 0, "na"]
    assert possible_answers(CFG)["08"] == ["yes", "no"]


def test_sampling_is_deterministic():
    assert spec_mod.sample_specs() == SPECS
    assert spec_mod.sample_specs(seed=1) != SPECS


def test_all_guarantees_hold():
    assert spec_mod.check_guarantees(SPECS, CFG) == []


def test_split_sizes_and_stratification():
    dev = [s for s in SPECS if s["split"] == "dev"]
    hold = [s for s in SPECS if s["split"] == "holdout"]
    assert (len(dev), len(hold)) == (24, 12)
    for channel in ("agent chat", "voice call"):
        for length in LENGTHS:
            assert sum(1 for s in dev if s["channel"] == channel and s["length"] == length) == 4
            assert sum(1 for s in hold if s["channel"] == channel and s["length"] == length) == 2


def test_every_dev_answer_value_appears_twice():
    dev = [s for s in SPECS if s["split"] == "dev"]
    for cid, values in possible_answers(CFG).items():
        counts = Counter(s["targets"][cid] for s in dev)
        for v in values:
            assert counts[v] >= 2, (cid, v)


def test_every_hard_case_present_overall():
    seen = {h for s in SPECS for h in s["hard"]}
    assert seen == set(spec_mod.HARD)


def test_coverage_dimensions_present():
    assert {s["language"] for s in SPECS} == {"ru", "kk", "en", "switch"}
    assert {s["topic"] for s in SPECS} == set(TOPICS)
    assert Counter(s["language"] for s in SPECS)["ru"] >= 18


def test_targets_are_internally_consistent():
    for s in SPECS:
        t = s["targets"]
        lo, hi = LENGTHS[s["length"]]
        assert lo <= s["message_target"] <= hi
        for cid, value in t.items():
            assert value in possible_answers(CFG)[cid]
        if t["04"] == "na":
            assert s["length"] == "short" and t["07"] == "na" and t["03"] == "na"
        if t["07"] == "na":
            assert {"client_leaves_before_closing", "chat_ends_before_request"} & set(s["hard"])
        if t["08"] == "yes":
            assert s["violation"] in ("insult", "paid_offer", "confidential_disclosure")
        else:
            assert s["violation"] is None
        if s["violation"] == "insult":
            assert t["05"] == "no"
        if s["language"] == "switch":
            assert s["switch_to"] and s["switch_to"] != s["conversation_language"]
        assert s["id_needed"] == (t["03"] != "na")


def test_consistency_checker_catches_bad_specs():
    bad = json.loads(json.dumps(SPECS[0]))
    bad["targets"]["08"] = "yes"
    assert any("violation" in p for p in spec_mod.spec_consistency(CFG, bad))
    bad = json.loads(json.dumps(SPECS[0]))
    bad["targets"]["01"] = "na"
    assert any("not a legal answer" in p for p in spec_mod.spec_consistency(CFG, bad))
    bad = json.loads(json.dumps(SPECS[0]))
    bad["targets"]["07"] = "na"
    assert any("07 na" in p for p in spec_mod.spec_consistency(CFG, bad))


def test_write_and_load_specs(tmp_path):
    path = spec_mod.write_specs(SPECS, tmp_path / "specs.json")
    assert spec_mod.load_specs(path) == SPECS
