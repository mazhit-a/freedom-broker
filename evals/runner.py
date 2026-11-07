import hashlib
import json
import random
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from evals import prices
from evals.decisions import JEV_MODEL, DecisionsClient, DecisionsError, build_questions, compute_cost, map_answers
from evals.gen.assemble import verify_hash
from evals.gen.common import DATASET_PATH, ROOT
from evals.graders import load_checklist
from evals.ledger import Ledger
from evals.workflows import build_workflow
from evals.workflows.base import ANTHROPIC, ERROR, JEV, OK, REFUSED, TRUNCATED, LLMRequest, Response

RUNS_DIR = ROOT / "evals" / "runs"
VARIANTS_PATH = ROOT / "evals" / "variants.json"
SPLITS = ("dev", "holdout", "all")


class BudgetStop(RuntimeError):
    pass


class BatchPending(RuntimeError):
    pass


class DatasetError(ValueError):
    pass


def to_dict(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: to_dict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_dict(v) for v in obj]
    if hasattr(obj, "model_dump"):
        return to_dict(obj.model_dump(mode="json"))
    if hasattr(obj, "__dict__") and not isinstance(obj, type):
        return {k: to_dict(v) for k, v in vars(obj).items() if not k.startswith("_")}
    return obj


def load_variants(path: Path | str = VARIANTS_PATH) -> dict[str, dict]:
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    out = {}
    for row in rows:
        if row["name"] in out:
            raise ValueError(f"duplicate variant {row['name']}")
        out[row["name"]] = row
    return out


def load_dataset(path: Path | str = DATASET_PATH, verify: bool = True) -> dict:
    path = Path(path)
    if not path.exists():
        raise DatasetError(f"dataset {path} does not exist")
    dataset = json.loads(path.read_text(encoding="utf-8"))
    if verify and not verify_hash(dataset):
        raise DatasetError(f"dataset {path} hash does not match its cases")
    return dataset


def select_cases(dataset: dict, split: str, limit: int | None = None) -> list[dict]:
    if split not in SPLITS:
        raise ValueError(f"split must be one of {SPLITS}")
    cases = sorted((c for c in dataset["cases"] if split == "all" or c["split"] == split), key=lambda c: c["id"])
    return cases[:limit] if limit else cases


def git_info() -> dict:
    def run(*args: str) -> str | None:
        try:
            r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            return None
        return r.stdout.strip() if r.returncode == 0 else None

    status = run("status", "--porcelain", "--untracked-files=no")
    return {"git_sha": run("rev-parse", "HEAD"), "git_dirty": bool(status) if status is not None else None}


def custom_id(prefix: str, key: str) -> str:
    return prefix + hashlib.sha1(key.encode("utf-8")).hexdigest()[:30]


def now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def make_run_id(variant: str, split: str) -> str:
    return f"{now_stamp()}-{variant}-{split}"


def retry_after_of(exc: Exception) -> float | None:
    headers = getattr(getattr(exc, "response", None), "headers", None)
    try:
        value = headers.get("retry-after") if headers is not None else None
        return max(0.0, float(value)) if value is not None else None
    except (TypeError, ValueError, AttributeError):
        return None


def is_retryable(exc: Exception) -> bool:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and (status in (408, 409, 429) or status >= 500):
        return True
    name = type(exc).__name__
    return "Timeout" in name or "Connection" in name


def model_matches(served: str, requested: str) -> bool:
    return served == requested or served.startswith(requested + "-")


class ResponseStore:
    def __init__(self, directory: Path):
        self.dir = Path(directory)

    def path(self, cid: str) -> Path:
        return self.dir / f"{cid}.json"

    def get(self, cid: str) -> Response | None:
        p = self.path(cid)
        if not p.exists():
            return None
        try:
            return Response(**json.loads(p.read_text(encoding="utf-8"))["response"])
        except (ValueError, KeyError, TypeError):
            return None

    def put(self, cid: str, request: LLMRequest, response: Response) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        body = {"custom_id": cid, "request": asdict(request), "response": asdict(response)}
        tmp = self.path(cid).with_suffix(".tmp")
        tmp.write_text(json.dumps(body, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        tmp.replace(self.path(cid))


def error_response(request: LLMRequest, message: str, attempts: int = 1) -> Response:
    return Response(request.request_id, ERROR, kind=request.kind, error=message, attempts=attempts)


class Executor:
    def __init__(
        self,
        cfg,
        mode: str = "batch",
        sdk: Any = None,
        sdk_factory: Callable[[], Any] | None = None,
        jev_client: DecisionsClient | None = None,
        ledger: Ledger | None = None,
        concurrency: int = 4,
        call_ceiling: float = 300.0,
        max_attempts: int = 5,
        backoff_base: float = 1.0,
        backoff_cap: float = 30.0,
        poll_initial: float = 15.0,
        poll_max: float = 120.0,
        max_wait: float = 90000.0,
        max_spend: float | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        rng: Callable[[], float] = random.random,
    ):
        if mode not in ("batch", "live"):
            raise ValueError("mode must be batch or live")
        self.cfg = cfg
        self.mode = mode
        self._sdk = sdk
        self._live_sdk = None
        self.sdk_factory = sdk_factory
        self.jev_client = jev_client
        self.ledger = ledger
        self.concurrency = max(1, concurrency)
        self.call_ceiling = call_ceiling
        self.max_attempts = max_attempts
        self.backoff_base = backoff_base
        self.backoff_cap = backoff_cap
        self.poll_initial = poll_initial
        self.poll_max = poll_max
        self.max_wait = max_wait
        self.max_spend = max_spend
        self.sleep = sleep
        self.clock = clock
        self.rng = rng
        self.spent = 0.0
        self.lock = threading.Lock()

    @property
    def sdk(self):
        if self._sdk is None:
            if self.sdk_factory is not None:
                self._sdk = self.sdk_factory()
            else:
                from backend.app.core.config import get_settings
                from backend.app.services.llm_client import build_sdk_client

                self._sdk = build_sdk_client(get_settings())
        return self._sdk

    @property
    def live_sdk(self):
        if self._live_sdk is None:
            base = self.sdk
            with_options = getattr(base, "with_options", None)
            self._live_sdk = with_options(max_retries=0) if callable(with_options) else base
        return self._live_sdk

    def backoff(self, attempt: int, retry_after: float | None) -> float:
        exp = min(self.backoff_cap, self.backoff_base * (2 ** (attempt - 1)))
        delay = exp * (0.5 + 0.5 * self.rng())
        if retry_after is not None:
            delay = max(delay, min(retry_after, self.backoff_cap))
        return delay

    def with_retries(self, fn: Callable[[], Any]) -> Any:
        attempt = 0
        while True:
            attempt += 1
            try:
                return fn()
            except Exception as exc:
                if not is_retryable(exc) or attempt >= self.max_attempts:
                    raise
                self.sleep(self.backoff(attempt, retry_after_of(exc)))

    def from_message(self, request: LLMRequest, msg: dict, latency_ms: int | None, batch: bool, attempts: int) -> Response:
        requested = request.params.get("model", "")
        usage = msg.get("usage") or {}

        def tok(name: str) -> int:
            return int(usage.get(name) or 0)

        text = "".join(b.get("text") or "" for b in (msg.get("content") or []) if (b or {}).get("type", "text") == "text")
        served = msg.get("model") if isinstance(msg.get("model"), str) else ""
        stop = msg.get("stop_reason")
        inp, out = tok("input_tokens"), tok("output_tokens")
        cr, cw = tok("cache_read_input_tokens"), tok("cache_creation_input_tokens")
        try:
            cost = prices.cost(requested, inp, out, cr, cw, batch=batch)
        except prices.UnknownModel:
            cost = 0.0
        status, error = OK, None
        if stop == "refusal":
            status = REFUSED
        elif stop == "max_tokens":
            status = TRUNCATED
        if not served:
            status, error = ERROR, "response carries no served model"
        elif not model_matches(served, requested):
            status, error = ERROR, f"served model {served!r} does not match requested model {requested!r}"
        return Response(
            request.request_id,
            status,
            kind=ANTHROPIC,
            model=served,
            text=text,
            stop_reason=stop,
            input_tokens=inp,
            output_tokens=out,
            cache_read_tokens=cr,
            cache_write_tokens=cw,
            latency_ms=latency_ms,
            cost=cost,
            structured="format" in (request.params.get("output_config") or {}),
            batch=batch,
            attempts=attempts,
            error=error,
            raw=msg,
        )

    def call_live(self, request: LLMRequest) -> Response:
        start = self.clock()
        attempt = 0
        while True:
            attempt += 1
            remaining = self.call_ceiling - (self.clock() - start)
            if remaining <= 0:
                return error_response(request, "wall-clock ceiling reached", attempt)
            t0 = time.perf_counter()
            try:
                msg = self.live_sdk.messages.create(**request.params, timeout=remaining)
            except Exception as exc:
                if is_retryable(exc) and attempt < self.max_attempts:
                    delay = self.backoff(attempt, retry_after_of(exc))
                    if self.clock() - start + delay >= self.call_ceiling:
                        return error_response(request, f"wall-clock ceiling reached after {type(exc).__name__}", attempt)
                    self.sleep(delay)
                    continue
                return error_response(request, f"{type(exc).__name__}: {str(exc)[:300]}", attempt)
            latency = int((time.perf_counter() - t0) * 1000)
            return self.from_message(request, to_dict(msg), latency, False, attempt)

    def call_jev(self, request: LLMRequest) -> Response:
        client = self.jev_client or DecisionsClient()
        self.jev_client = client
        try:
            call = client.post(request.params)
        except DecisionsError as exc:
            return error_response(request, str(exc), getattr(exc, "attempts", 1) or 1)
        body = call["body"]
        served = body.get("model")
        if isinstance(served, str) and served and not model_matches(served, JEV_MODEL):
            return error_response(request, f"served model {served!r} does not match requested model {JEV_MODEL!r}", call.get("attempts", 1))
        try:
            answers = map_answers(body, build_questions(self.cfg))
        except DecisionsError as exc:
            return error_response(request, str(exc), call.get("attempts", 1))
        detail = compute_cost(call.get("usage"), request.params["state"], request.params["questions"])
        return Response(
            request.request_id,
            OK,
            kind=JEV,
            model=JEV_MODEL,
            input_tokens=detail["input_tokens"],
            output_tokens=int(detail["output_tokens"] or 0),
            latency_ms=int(call.get("latency_ms") or 0),
            cost=round(detail["cost"], 6),
            attempts=call.get("attempts", 1),
            data={"answers": answers, "estimated_tokens": detail["estimated"], "reported_cost": detail["reported_cost"]},
            raw=body,
        )

    def pool(self, fn: Callable[[LLMRequest], Response], items: list[tuple[str, LLMRequest]]) -> dict[str, Response]:
        if not items:
            return {}
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            futures = [(cid, pool.submit(fn, req)) for cid, req in items]
            return {cid: fut.result() for cid, fut in futures}

    def poll(self, batch_id: str) -> None:
        delay = self.poll_initial
        started = self.clock()
        while True:
            batch = to_dict(self.with_retries(lambda: self.sdk.messages.batches.retrieve(batch_id)))
            if batch.get("processing_status") == "ended":
                return
            if self.clock() - started >= self.max_wait:
                raise BatchPending(f"batch {batch_id} did not end within {self.max_wait:.0f}s; rerun with the same run id to resume it")
            self.sleep(delay * (0.75 + 0.5 * self.rng()))
            delay = min(delay * 1.5, self.poll_max)

    def collect(self, batch_id: str, wanted: dict[str, LLMRequest]) -> dict[str, Response]:
        self.poll(batch_id)
        entries = self.with_retries(lambda: [to_dict(e) for e in self.sdk.messages.batches.results(batch_id)])
        seen: dict[str, Response] = {}
        for entry in entries:
            cid = entry.get("custom_id")
            req = wanted.get(cid)
            if req is None or cid in seen:
                continue
            result = entry.get("result") or {}
            kind = result.get("type")
            if kind == "succeeded":
                seen[cid] = self.from_message(req, result.get("message") or {}, None, True, 1)
            else:
                detail = result.get("error")
                seen[cid] = error_response(req, f"batch {kind}" + (f": {json.dumps(detail, ensure_ascii=False)[:300]}" if detail else ""))
        for cid, req in wanted.items():
            if cid not in seen:
                seen[cid] = error_response(req, "missing from batch results")
        return seen

    def run_batch(self, items: list[tuple[str, LLMRequest]], pending_dir: Path) -> dict[str, Response]:
        wanted = dict(items)
        fresh: dict[str, Response] = {}
        pending_dir.mkdir(parents=True, exist_ok=True)
        for path in sorted(pending_dir.glob("*.json")):
            info = json.loads(path.read_text(encoding="utf-8"))
            if info.get("ingested"):
                continue
            ids = [i for i in info["custom_ids"] if i in wanted]
            if not ids:
                continue
            fresh.update(self.collect(info["batch_id"], {i: wanted[i] for i in ids}))
            info["ingested"] = True
            path.write_text(json.dumps(info), encoding="utf-8")
            for i in ids:
                wanted.pop(i)
        if wanted:
            requests = [{"custom_id": cid, "params": req.params} for cid, req in wanted.items()]
            batch = to_dict(self.with_retries(lambda: self.sdk.messages.batches.create(requests=requests)))
            batch_id = batch["id"]
            number = len(list(pending_dir.glob("*.json"))) + 1
            path = pending_dir / f"batch-{number:03d}.json"
            info = {"batch_id": batch_id, "custom_ids": list(wanted), "ingested": False, "created": datetime.now(timezone.utc).isoformat()}
            path.write_text(json.dumps(info), encoding="utf-8")
            fresh.update(self.collect(batch_id, wanted))
            info["ingested"] = True
            path.write_text(json.dumps(info), encoding="utf-8")
        return fresh

    def log(self, fresh: dict[str, Response], requests: dict[str, LLMRequest], run_id: str, kind: str) -> None:
        groups: dict[tuple, dict] = {}
        for cid, resp in fresh.items():
            if not (resp.input_tokens or resp.output_tokens or resp.cache_read_tokens or resp.cache_write_tokens or resp.cost):
                continue
            req = requests[cid]
            provider = "openrouter" if resp.kind == JEV else "anthropic"
            mode = "batch" if resp.batch else "live"
            g = groups.setdefault(
                (req.group, provider, resp.model or req.params.get("model", ""), mode),
                {"requests": 0, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost": 0.0},
            )
            g["requests"] += 1
            g["input_tokens"] += resp.input_tokens
            g["output_tokens"] += resp.output_tokens
            g["cache_read_tokens"] += resp.cache_read_tokens
            g["cache_write_tokens"] += resp.cache_write_tokens
            g["cost"] += resp.cost
        for (group, provider, model, mode), g in sorted(groups.items()):
            with self.lock:
                self.spent += g["cost"]
            if self.ledger is not None:
                self.ledger.append(
                    {"run_id": run_id, "kind": kind, "group": group, "provider": provider, "model": model, "mode": mode, **g, "cost": round(g["cost"], 6)}
                )

    def execute(self, items: list[tuple[str, LLMRequest]], store: ResponseStore, run_id: str, kind: str = "run", pending_dir: Path | None = None) -> dict[str, Response]:
        out: dict[str, Response] = {}
        todo: list[tuple[str, LLMRequest]] = []
        for cid, req in items:
            cached = store.get(cid)
            if cached is not None and cached.status != ERROR:
                out[cid] = cached
            else:
                todo.append((cid, req))
        if not todo:
            return out
        if self.max_spend is not None and self.spent >= self.max_spend:
            raise BudgetStop(f"spent ${self.spent:.4f} reached --max-spend ${self.max_spend:.4f}")
        anth = [x for x in todo if x[1].kind == ANTHROPIC]
        jev = [x for x in todo if x[1].kind == JEV]
        fresh: dict[str, Response] = {}
        if self.mode == "batch":
            fresh.update(self.run_batch(anth, pending_dir or (store.dir.parent / "batches")) if anth else {})
        else:
            fresh.update(self.pool(self.call_live, anth))
        fresh.update(self.pool(self.call_jev, jev))
        requests = dict(todo)
        for cid, resp in fresh.items():
            store.put(cid, requests[cid], resp)
        self.log(fresh, requests, run_id, kind)
        out.update(fresh)
        return out


class Row:
    def __init__(self, case: dict, rep: int, state: dict):
        self.case = case
        self.rep = rep
        self.state = state
        self.failed = False


def row_name(case_id: str, rep: int) -> str:
    return f"{case_id}__r{rep}"


def sum_usage(candidates: list[dict]) -> dict:
    total = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost": 0.0}
    by_model: dict[str, dict] = {}
    for cand in candidates:
        for call in cand.get("calls") or []:
            slot = by_model.setdefault(call.get("model", ""), {k: (0.0 if k == "cost" else 0) for k in total})
            for target in (total, slot):
                target["calls"] += 1
                for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"):
                    target[k] += int(call.get(k) or 0)
                target["cost"] += float(call.get("cost") or 0)
    total["cost"] = round(total["cost"], 6)
    for slot in by_model.values():
        slot["cost"] = round(slot["cost"], 6)
    return {"total": total, "by_model": by_model}


def recompute_cost(candidates: list[dict]) -> float:
    total = 0.0
    for cand in candidates:
        for call in cand.get("calls") or []:
            c = prices.call_cost(call, batch=bool(call.get("batch")) and call.get("provider") != JEV)
            total += c if c is not None else float(call.get("cost") or 0)
    return round(total, 6)


class Runner:
    def __init__(self, dataset: dict, executor: Executor, runs_dir: Path | str = RUNS_DIR, dataset_path: Path | str | None = None, cfg=None):
        self.dataset = dataset
        self.executor = executor
        self.runs_dir = Path(runs_dir)
        self.dataset_path = str(dataset_path) if dataset_path else None
        self.cfg = cfg or load_checklist()

    def read_rows(self, run_dir: Path) -> list[dict]:
        rows = [json.loads(p.read_text(encoding="utf-8")) for p in sorted((run_dir / "rows").glob("*.json"))]
        return sorted(rows, key=lambda c: (c["case_id"], c.get("rep", 0)))

    def run(self, variant: dict, cases: list[dict], split: str, reps: int = 1, run_id: str | None = None, limit: int | None = None, estimate: float | None = None) -> dict:
        run_id = run_id or make_run_id(variant["name"], split)
        run_dir = self.runs_dir / run_id
        (run_dir / "rows").mkdir(parents=True, exist_ok=True)
        meta_path = run_dir / "meta.json"
        workflow = build_workflow(variant, self.cfg)
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
        expect = {"variant": variant["name"], "split": split, "reps": reps, "mode": self.executor.mode, "dataset_hash": self.dataset["hash"]}
        for k, v in expect.items():
            if meta and meta.get(k) != v:
                raise ValueError(f"run {run_id} was started with {k}={meta.get(k)!r}, not {v!r}")
        meta.update(
            {
                "run_id": run_id,
                **expect,
                "limit": limit,
                "workflow": variant["workflow"],
                "params": variant.get("params") or {},
                "dataset_path": self.dataset_path,
                "dataset_version": self.dataset.get("version"),
                "expected_calls": workflow.expected_calls(),
                "cases": [c["id"] for c in cases],
                "status": "running",
                "cost_estimated": estimate if estimate is not None else meta.get("cost_estimated"),
                **git_info(),
            }
        )
        meta.setdefault("started", datetime.now(timezone.utc).isoformat())
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

        done = {p.stem for p in (run_dir / "rows").glob("*.json")}
        rows = [
            Row(case, rep, workflow.new_state(case))
            for case in cases
            for rep in range(reps)
            if row_name(case["id"], rep) not in done
        ]
        errors: list[dict] = []
        store = ResponseStore(run_dir / "raw")
        stopped: str | None = None
        try:
            for index in range(workflow.stage_count):
                active = [r for r in rows if not r.failed]
                plans = [(r, workflow.stage(index, r.case, r.state)) for r in active]
                items: list[tuple[str, LLMRequest]] = []
                ids: dict[int, dict[str, str]] = {}
                for r, st in plans:
                    ids[id(r)] = {}
                    for req in st.requests:
                        cid = custom_id("q", f"{r.case['id']}|{r.rep}|{index}|{req.request_id}")
                        ids[id(r)][req.request_id] = cid
                        items.append((cid, req))
                responses = self.executor.execute(items, store, run_id, "run", pending_dir=run_dir / "batches") if items else {}
                for r, st in plans:
                    got = {rid: responses[cid] for rid, cid in ids[id(r)].items() if cid in responses}
                    bad = [(rid, g) for rid, g in got.items() if g.status == ERROR]
                    if bad or len(got) != len(st.requests):
                        rid, g = bad[0] if bad else (next(q.request_id for q in st.requests if q.request_id not in got), None)
                        errors.append(
                            {
                                "variant": variant["name"],
                                "case_id": r.case["id"],
                                "rep": r.rep,
                                "stage": st.name,
                                "request_id": rid,
                                "kind": "infrastructure",
                                "error": (g.error if g is not None else "no response") or "error",
                            }
                        )
                        r.failed = True
                        continue
                    r.state = st.reduce(r.state, got)
        except (BudgetStop, BatchPending) as exc:
            stopped = str(exc)
        for r in rows:
            if r.failed or stopped:
                continue
            cand = workflow.finish(r.case, r.state)
            calls = cand.get("calls") or []
            cand["rep"] = r.rep
            cand["mode"] = "live" if calls and all(not c.get("batch") for c in calls) else "batch"
            (run_dir / "rows" / f"{row_name(r.case['id'], r.rep)}.json").write_text(json.dumps(cand, ensure_ascii=False, indent=1), encoding="utf-8")
        results = self.read_rows(run_dir)
        (run_dir / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
        (run_dir / "errors.json").write_text(json.dumps(errors, ensure_ascii=False, indent=1), encoding="utf-8")
        usage = sum_usage(results)
        total_rows = len(cases) * reps
        meta.update(
            {
                "status": f"stopped: {stopped}" if stopped else ("complete" if len(results) == total_rows else "incomplete"),
                "finished": datetime.now(timezone.utc).isoformat(),
                "n_rows": len(results),
                "n_rows_expected": total_rows,
                "n_errors": len(errors),
                "served_models": sorted({c["model"] for r in results for c in r.get("calls") or [] if c.get("model")}),
                "usage": usage,
                "cost_actual": usage["total"]["cost"],
                "cost_recomputed": recompute_cost(results),
            }
        )
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        return {"run_id": run_id, "run_dir": str(run_dir), "meta": meta, "n_errors": len(errors), "stopped": stopped}
