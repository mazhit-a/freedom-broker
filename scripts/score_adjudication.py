import collections
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "evals" / "dataset.json"
SOURCES = {
    "gpt-6.1-sol medium": "20261108-005254-gpt_sol_medium-dev",
    "opus low + fix05": "20261108-003830-opus_low_fix05-dev",
    "opus medium (baseline)": "20261107-220004-baseline-dev",
    "sonnet medium": "20261107-224037-sonnet_medium-dev",
    "jev default": "20261107-222725-jev_only-dev",
}
STEPS = {"06": [0, 4, 7, 10]}


def load_rows(run: str) -> list[dict]:
    data = json.loads((ROOT / "evals" / "runs" / run / "results.json").read_text())
    return data if isinstance(data, list) else data.get("candidates", data)


def main(path: str, criterion: str = "06") -> None:
    adj = json.loads(Path(path).read_text())
    dataset = {c["id"]: c for c in json.loads(DATASET.read_text())["cases"]}
    human = {}
    unsure = []
    for a in adj["answers"]:
        if a.get("unsure") or a.get("answer") is None:
            unsure.append(a["case_id"])
            continue
        human[a["case_id"]] = int(a["answer"])
    print(f"criterion {criterion}: {len(human)} answered, {len(unsure)} unsure {unsure}")
    models: dict[str, dict[str, list[int]]] = {}
    for name, run in SOURCES.items():
        by = collections.defaultdict(list)
        for r in load_rows(run):
            by[r["case_id"]].append(int(r["results"][criterion]["answer"]))
        models[name] = by
    expected = {cid: int(dataset[cid]["expected"][criterion]["answer"]) for cid in human}

    def gap(a: int, b: int) -> int:
        return abs(STEPS[criterion].index(a) - STEPS[criterion].index(b))

    def agree(name: str, ref: dict[str, int]) -> str:
        exact = n = 0
        for cid, h in ref.items():
            outs = models[name].get(cid)
            if not outs:
                continue
            n += 1
            exact += outs[0] == h
        return f"{exact}/{n}"

    print("\nagreement with the human labels (exact, first repeat):")
    exact_label = sum(1 for cid, h in human.items() if expected[cid] == h)
    print(f"  expected label (dataset v1): {exact_label}/{len(human)}")
    for name in models:
        print(f"  {name}: {agree(name, human)}")
    print("\ndirection of disagreement with the human (negative = lower than the human):")
    for name, by in [("expected label", {cid: [expected[cid]] for cid in human})] + list(models.items()):
        d = collections.Counter()
        for cid, h in human.items():
            outs = by.get(cid)
            if not outs:
                continue
            o = outs[0]
            d["agree" if o == h else ("lower" if o < h else "higher")] += 1
        print(f"  {name}: {dict(d)}")
    print("\nper case (human | expected | gpt | opus low+fix05 | opus medium | sonnet):")
    for cid, h in sorted(human.items()):
        row = [expected[cid]] + [models[n].get(cid, [None])[0] for n in ("gpt-6.1-sol medium", "opus low + fix05", "opus medium (baseline)", "sonnet medium")]
        cells = " | ".join(f"{v}{'' if v == h else 'x'}" for v in row)
        print(f"  {cid} {h} | {cells}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "06")
