import json
import os
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from evals import prices
from evals.decisions import JEV_MODEL

ROOT = Path(__file__).resolve().parents[1]
LEDGER_PATH = ROOT / "evals" / "ledger.json"
DEFAULT_BUDGET = 10.0
COUNTED_PROVIDERS = ("anthropic", "jev", "openrouter")


class BudgetError(RuntimeError):
    pass


@dataclass(frozen=True)
class TokenEstimate:
    input: int = 0
    cache_read: int = 0
    cache_write: int = 0
    output: int = 0


DEFAULT_ESTIMATES: dict[str, TokenEstimate] = {
    "single_call": TokenEstimate(1500, 3300, 0, 1500),
    "judge": TokenEstimate(1500, 3300, 0, 2000),
    "per_criterion": TokenEstimate(300, 2200, 0, 450),
    "extract": TokenEstimate(1500, 1000, 0, 700),
    "explain": TokenEstimate(1800, 3500, 0, 1200),
    "jev": TokenEstimate(3500, 0, 0, 0),
    "blind": TokenEstimate(1500, 2000, 0, 700),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def empty_ledger() -> dict:
    return {"budget": DEFAULT_BUDGET, "estimates": {}, "entries": []}


def request_cost(model: str, est: TokenEstimate, mode: str) -> float:
    batch = mode == "batch" and model != JEV_MODEL
    return prices.cost(model, est.input, est.output, est.cache_read, est.cache_write, batch=batch)


class Ledger:
    def __init__(self, path: Path | str = LEDGER_PATH):
        self.path = Path(path)

    def load(self) -> dict:
        if not self.path.exists():
            return empty_ledger()
        data = json.loads(self.path.read_text(encoding="utf-8"))
        data.setdefault("budget", DEFAULT_BUDGET)
        data.setdefault("estimates", {})
        data.setdefault("entries", [])
        return data

    def save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".ledger-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=1)
                fh.write("\n")
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def append(self, entry: dict) -> dict:
        data = self.load()
        row = dict(entry)
        row.setdefault("ts", now_iso())
        row.setdefault("counts", row.get("provider") in COUNTED_PROVIDERS)
        data["entries"].append(row)
        self.save(data)
        return row

    @property
    def budget(self) -> float:
        return float(self.load()["budget"])

    def spent(self) -> float:
        return round(sum(float(e.get("cost") or 0) for e in self.load()["entries"] if e.get("counts", e.get("provider") in COUNTED_PROVIDERS)), 6)

    def remaining(self) -> float:
        data = self.load()
        spent = sum(float(e.get("cost") or 0) for e in data["entries"] if e.get("counts", e.get("provider") in COUNTED_PROVIDERS))
        return round(float(data["budget"]) - spent, 6)

    def summary(self) -> dict:
        data = self.load()
        by_run: dict[str, float] = defaultdict(float)
        by_provider: dict[str, float] = defaultdict(float)
        uncounted: dict[str, float] = defaultdict(float)
        for e in data["entries"]:
            cost = float(e.get("cost") or 0)
            if e.get("counts", e.get("provider") in COUNTED_PROVIDERS):
                by_run[e.get("run_id", "?")] += cost
                by_provider[e.get("provider", "?")] += cost
            else:
                uncounted[e.get("provider", "?")] += cost
        spent = sum(by_provider.values())
        return {
            "budget": float(data["budget"]),
            "spent": round(spent, 6),
            "remaining": round(float(data["budget"]) - spent, 6),
            "by_run": {k: round(v, 6) for k, v in sorted(by_run.items())},
            "by_provider": {k: round(v, 6) for k, v in sorted(by_provider.items())},
            "uncounted": {k: round(v, 6) for k, v in sorted(uncounted.items())},
            "entries": len(data["entries"]),
        }

    def estimates(self) -> dict[tuple[str, str], TokenEstimate]:
        data = self.load()
        sums: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0, 0, 0, 0])
        for e in data["entries"]:
            n = int(e.get("requests") or 0)
            if n <= 0 or not e.get("group") or e.get("status_errors"):
                continue
            s = sums[(e["group"], e.get("model", ""))]
            s[0] += n
            s[1] += int(e.get("input_tokens") or 0)
            s[2] += int(e.get("cache_read_tokens") or 0)
            s[3] += int(e.get("cache_write_tokens") or 0)
            s[4] += int(e.get("output_tokens") or 0)
        out = {k: TokenEstimate(v[1] // v[0], v[2] // v[0], v[3] // v[0], v[4] // v[0]) for k, v in sums.items()}
        for group, over in data["estimates"].items():
            for model in {m for g, m in out if g == group} | {""}:
                base = out.get((group, model), DEFAULT_ESTIMATES.get(group, TokenEstimate()))
                out[(group, model)] = TokenEstimate(**{**base.__dict__, **over})
        return out

    def token_estimate(self, group: str, model: str, table: dict | None = None) -> TokenEstimate:
        table = table if table is not None else self.estimates()
        if (group, model) in table:
            return table[(group, model)]
        if (group, "") in table:
            return table[(group, "")]
        return DEFAULT_ESTIMATES.get(group, TokenEstimate())

    def estimate_plan(self, plan: list[tuple[str, str, int]], n_cases: int, mode: str) -> float:
        table = self.estimates()
        total = 0.0
        for group, model, per_case in plan:
            total += n_cases * per_case * request_cost(model, self.token_estimate(group, model, table), mode)
        return round(total, 6)

    def check(self, estimate: float, max_spend: float | None) -> None:
        if max_spend is None:
            raise BudgetError("--max-spend is required for a run that sends requests")
        if max_spend <= 0:
            raise BudgetError("--max-spend must be positive")
        if estimate > max_spend:
            raise BudgetError(f"estimated cost ${estimate:.4f} exceeds --max-spend ${max_spend:.4f}")
        remaining = self.remaining()
        if estimate > remaining:
            raise BudgetError(
                f"estimated cost ${estimate:.4f} exceeds the remaining budget ${remaining:.4f} (spent ${self.spent():.4f} of ${self.budget:.2f})"
            )
