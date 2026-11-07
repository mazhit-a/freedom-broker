import json
import random
from collections import Counter
from pathlib import Path

from evals.gen.common import (
    CHANNEL_TAGS,
    CHANNELS,
    LENGTHS,
    TOPICS,
    load_checklist,
    possible_answers,
)

SEED = 20261108
DEFAULT_SPECS_PATH = Path(__file__).resolve().parent / "specs.json"

LANGUAGE_PLAN = {
    "dev": {"ru": 12, "kk": 6, "en": 3, "switch": 3},
    "holdout": {"ru": 6, "kk": 2, "en": 2, "switch": 2},
}
SWITCH_PAIRS = (("ru", "en"), ("ru", "kk"), ("kk", "ru"))
CELL_DEV = 4
CELL_HOLDOUT = 2

HARD = {
    "bot_greets_no_greeting": {"channels": {"agent chat"}, "lengths": None, "forced": {"01": "no"}},
    "verification_needed_not_confirmed": {"channels": None, "lengths": None, "forced": {"03": "no"}},
    "verification_not_needed": {"channels": None, "lengths": None, "forced": {"03": "na"}},
    "client_leaves_before_closing": {"channels": None, "lengths": None, "forced": {"07": "na"}},
    "chat_ends_before_request": {
        "channels": None,
        "lengths": {"short"},
        "forced": {"04": "na", "07": "na", "03": "na", "02": "yes", "05": "yes", "06": 10, "08": "no"},
    },
    "insult": {"channels": None, "lengths": None, "forced": {"08": "yes", "05": "no"}, "violation": "insult"},
    "paid_personal_consultation": {
        "channels": None,
        "lengths": None,
        "forced": {"08": "yes"},
        "violation": "paid_offer",
    },
    "confidential_disclosure": {
        "channels": None,
        "lengths": None,
        "forced": {"08": "yes"},
        "violation": "confidential_disclosure",
    },
    "near_miss_rude_no_violation": {"channels": None, "lengths": None, "forced": {"08": "no", "05": "no"}},
    "angry_client_with_empathy": {
        "channels": None,
        "lengths": {"medium", "long"},
        "forced": {"05": "yes", "08": "no"},
    },
    "angry_client_without_empathy": {
        "channels": None,
        "lengths": {"medium", "long"},
        "forced": {"05": "no", "08": "no"},
    },
    "wait_without_warning": {
        "channels": None,
        "lengths": {"medium", "long"},
        "choices": {"06": [4, 7]},
        "forced": {"08": "no"},
    },
    "missed_item_long": {
        "channels": None,
        "lengths": {"long"},
        "choices": {"04": [10, 15]},
        "forced": {"08": "no"},
    },
}

HARD_DEV = {name: 1 for name in HARD}
HARD_DEV.update({"chat_ends_before_request": 2, "client_leaves_before_closing": 2, "verification_not_needed": 2})
HARD_HOLDOUT = (
    "insult",
    "verification_needed_not_confirmed",
    "wait_without_warning",
    "missed_item_long",
    "client_leaves_before_closing",
    "chat_ends_before_request",
)
ASSIGN_FIRST = ("chat_ends_before_request", "missed_item_long", "bot_greets_no_greeting")

FREE_FORBIDDEN = {"04": {"na"}, "07": {"na"}, "08": {"yes"}}

WEIGHTS = {
    "01": {"yes": 0.7, "no": 0.3},
    "02": {"yes": 0.5, "no": 0.3, "na": 0.2},
    "03": {"yes": 0.6, "no": 0.25, "na": 0.15},
    "04": {20: 0.3, 15: 0.25, 10: 0.2, 5: 0.15, 0: 0.1},
    "05": {"yes": 0.7, "no": 0.3},
    "06": {10: 0.4, 7: 0.3, 4: 0.2, 0: 0.1},
    "07": {"yes": 0.65, "no": 0.35},
    "08": {"no": 1.0},
}


def _weighted(rng: random.Random, weights: dict):
    keys = list(weights)
    return rng.choices(keys, weights=[weights[k] for k in keys], k=1)[0]


def _free_values(cid: str, values: list) -> list:
    return [v for v in values if v not in FREE_FORBIDDEN.get(cid, set())]


def _make_cells(rng: random.Random) -> list[dict]:
    cases = []
    for channel in CHANNELS:
        for length in LENGTHS:
            splits = ["dev"] * CELL_DEV + ["holdout"] * CELL_HOLDOUT
            rng.shuffle(splits)
            for split in splits:
                cases.append({"channel": channel, "length": length, "split": split})
    return cases


def _assign_languages(cases: list[dict], rng: random.Random) -> None:
    for split, plan in LANGUAGE_PLAN.items():
        pool = [lang for lang, n in plan.items() for _ in range(n)]
        rng.shuffle(pool)
        members = [c for c in cases if c["split"] == split]
        if len(pool) != len(members):
            raise ValueError("language plan does not match the split sizes")
        for case, lang in zip(members, pool):
            case["language"] = lang
    pair_index = 0
    for case in cases:
        if case["language"] == "switch":
            first, second = SWITCH_PAIRS[pair_index % len(SWITCH_PAIRS)]
            pair_index += 1
            case["conversation_language"], case["switch_to"] = first, second
        else:
            case["conversation_language"], case["switch_to"] = case["language"], None


def _assign_hard(cases: list[dict], rng: random.Random) -> None:
    wanted = []
    for split, plan in (("dev", HARD_DEV), ("holdout", {n: 1 for n in HARD_HOLDOUT})):
        for name, count in plan.items():
            wanted.extend((name, split) for _ in range(count))
    wanted.sort(key=lambda item: (ASSIGN_FIRST.index(item[0]) if item[0] in ASSIGN_FIRST else len(ASSIGN_FIRST), item[1], item[0]))
    for name, split in wanted:
        rule = HARD[name]
        pool = [
            c
            for c in cases
            if c["split"] == split
            and not c["hard"]
            and (rule["channels"] is None or c["channel"] in rule["channels"])
            and (rule["lengths"] is None or c["length"] in rule["lengths"])
        ]
        if not pool:
            raise ValueError(f"no case available for hard case {name} in {split}")
        chosen = rng.choice(pool)
        chosen["hard"] = [name]
        chosen["locked"] = dict(rule["forced"])
        for cid, options in rule.get("choices", {}).items():
            chosen["locked"][cid] = rng.choice(options)
        chosen["violation"] = rule.get("violation")


def _sample_free(cases: list[dict], rng: random.Random, cids: list[str]) -> None:
    for case in cases:
        targets = dict(case["locked"])
        for cid in cids:
            if cid not in targets:
                targets[cid] = _weighted(rng, WEIGHTS[cid])
        case["targets"] = targets


def _fix_coverage(cases: list[dict], answers: dict[str, list]) -> None:
    dev = [c for c in cases if c["split"] == "dev"]
    for _ in range(200):
        counts = {cid: Counter(c["targets"][cid] for c in dev) for cid in answers}
        deficit = next(
            ((cid, v) for cid, values in answers.items() for v in values if counts[cid][v] < 2),
            None,
        )
        if deficit is None:
            return
        cid, value = deficit
        if value in FREE_FORBIDDEN.get(cid, set()):
            raise ValueError(f"value {value} of criterion {cid} cannot be covered without a hard case")
        candidates = [
            c
            for c in dev
            if cid not in c["locked"] and c["targets"][cid] != value and counts[cid][c["targets"][cid]] > 2
        ]
        if not candidates:
            raise ValueError(f"cannot cover {cid}={value} in dev")
        candidates.sort(key=lambda c: (-counts[cid][c["targets"][cid]], c["_order"]))
        candidates[0]["targets"][cid] = value
    raise ValueError("coverage fixing did not converge")


def sample_specs(seed: int = SEED, cfg=None) -> list[dict]:
    cfg = cfg or load_checklist()
    answers = possible_answers(cfg)
    rng = random.Random(seed)
    cases = _make_cells(rng)
    for case in cases:
        case["hard"] = []
        case["locked"] = {}
        case["violation"] = None
    _assign_languages(cases, rng)
    _assign_hard(cases, rng)
    topics = list(TOPICS) * 6
    rng.shuffle(topics)
    for case, topic in zip(cases, topics):
        case["topic"] = topic
    cases.sort(key=lambda c: (c["channel"], list(LENGTHS).index(c["length"]), c["split"] != "dev"))
    for order, case in enumerate(cases):
        case["_order"] = order
    _sample_free(cases, rng, [c.id for c in cfg.criteria])
    _fix_coverage(cases, answers)
    specs = []
    for order, case in enumerate(cases, 1):
        lo, hi = LENGTHS[case["length"]]
        if "chat_ends_before_request" in case["hard"]:
            hi = 8
        target = rng.randint(lo, hi)
        specs.append(
            {
                "id": f"case-{order:03d}",
                "split": case["split"],
                "channel": case["channel"],
                "channel_tag": CHANNEL_TAGS[case["channel"]],
                "language": case["language"],
                "conversation_language": case["conversation_language"],
                "switch_to": case["switch_to"],
                "length": case["length"],
                "message_range": list(LENGTHS[case["length"]]),
                "message_target": target,
                "topic": case["topic"],
                "hard": list(case["hard"]),
                "violation": case["violation"],
                "id_needed": case["targets"]["03"] != "na",
                "targets": {cid: case["targets"][cid] for cid in answers},
                "seed": seed,
            }
        )
    return specs


def check_guarantees(specs: list[dict], cfg=None) -> list[str]:
    cfg = cfg or load_checklist()
    answers = possible_answers(cfg)
    problems = []
    if len(specs) != 36:
        problems.append(f"expected 36 specs, got {len(specs)}")
    if len({s["id"] for s in specs}) != len(specs):
        problems.append("duplicate spec ids")
    dev = [s for s in specs if s["split"] == "dev"]
    hold = [s for s in specs if s["split"] == "holdout"]
    if (len(dev), len(hold)) != (24, 12):
        problems.append(f"split is {len(dev)}/{len(hold)}, expected 24/12")
    for channel in CHANNELS:
        for length in LENGTHS:
            d = sum(1 for s in dev if s["channel"] == channel and s["length"] == length)
            h = sum(1 for s in hold if s["channel"] == channel and s["length"] == length)
            if (d, h) != (CELL_DEV, CELL_HOLDOUT):
                problems.append(f"split not stratified for {channel}/{length}: {d}/{h}")
    for cid, values in answers.items():
        counts = Counter(s["targets"].get(cid) for s in dev)
        for v in values:
            if counts[v] < 2:
                problems.append(f"dev answer {cid}={v} appears {counts[v]} times")
    seen = {h for s in specs for h in s["hard"]}
    for name in HARD:
        if name not in seen:
            problems.append(f"hard case {name} is missing")
    for s in specs:
        problems.extend(f"{s['id']}: {p}" for p in spec_consistency(cfg, s))
    return problems


def spec_consistency(cfg, spec: dict) -> list[str]:
    problems = []
    answers = possible_answers(cfg)
    targets = spec["targets"]
    for cid, values in answers.items():
        if cid not in targets:
            problems.append(f"target {cid} missing")
        elif targets[cid] not in values:
            problems.append(f"target {cid}={targets[cid]!r} is not a legal answer")
    lo, hi = LENGTHS[spec["length"]]
    if not lo <= spec["message_target"] <= hi:
        problems.append("message_target outside the length band")
    if targets.get("04") == "na" and (spec["length"] != "short" or targets.get("07") != "na"):
        problems.append("04 na requires a short chat that also ends before closing (07 na)")
    if targets.get("04") == "na" and targets.get("03") != "na":
        problems.append("04 na requires 03 na")
    if targets.get("07") == "na" and "04" in targets and targets["04"] == "na" and "chat_ends_before_request" not in spec["hard"]:
        problems.append("04 na without its hard case")
    if targets.get("07") == "na" and not (
        {"client_leaves_before_closing", "chat_ends_before_request"} & set(spec["hard"])
    ):
        problems.append("07 na requires the client to leave before closing")
    if targets.get("08") == "yes" and spec.get("violation") is None:
        problems.append("08 yes requires a concrete violation type")
    if targets.get("08") == "no" and spec.get("violation") is not None:
        problems.append("violation type set while 08 is no")
    if spec.get("violation") == "insult" and targets.get("05") != "no":
        problems.append("insult requires 05 no")
    if spec["channel"] == "voice call" and "bot_greets_no_greeting" in spec["hard"]:
        problems.append("bot greeting hard case needs a chat")
    if spec["id_needed"] != (targets.get("03") != "na"):
        problems.append("id_needed disagrees with 03")
    if spec["language"] == "switch" and not spec.get("switch_to"):
        problems.append("switch language needs switch_to")
    return problems


def write_specs(specs: list[dict], path: Path | str = DEFAULT_SPECS_PATH) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(specs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def load_specs(path: Path | str | None = None) -> list[dict]:
    path = Path(path) if path else DEFAULT_SPECS_PATH
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return sample_specs()
