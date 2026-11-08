import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from backend.app.core.config import Settings, get_settings
from backend.app.core.database import connect
from backend.app.services.appeals import with_review
from backend.app.services.evaluator import evaluate_conversation, get_evaluation
from backend.app.services.llm_client import QUOTA_MARKERS, LLMClient, LLMFatalError, is_fatal_text, is_quota_text
from backend.app.services.openai_support import redact

THROTTLE_MARKERS = ("429", "throttl", "ratelimit", "rate limit", "rate_limit", "rate_limit_exceeded", "ratelimiterror", "too many requests", "overloaded", "529", "503", "serviceunavailable")


FINAL_STATUSES = ("completed", "failed", "cancelled")
ACTIVE_DB_STATUSES = ("queued", "running", "cancelling")


class _ItemCancelled(Exception):
    pass


class _FatalWatch:
    def __init__(self, client):
        self._client = client
        self.fatal: LLMFatalError | None = None

    def __getattr__(self, name):
        return getattr(self._client, name)

    def complete(self, *args, **kwargs):
        try:
            return self._client.complete(*args, **kwargs)
        except LLMFatalError as exc:
            self.fatal = exc
            raise


def _provider_label(client, settings: Settings | None) -> str:
    cfg = settings or getattr(client, "settings", None)
    provider = getattr(cfg, "llm_provider", "anthropic")
    return {"openai": "OpenAI", "bedrock": "Bedrock"}.get(provider, "Anthropic")


def fatal_run_message(provider: str, text: str | None) -> str:
    low = (text or "").lower()
    if is_quota_text(text) or any(m in low for m in ("401", "403", "authentication", "permission", "api_key is not set", "billing")):
        return f"{provider}: нет кредитов на аккаунте или неверный ключ, прогон остановлен"
    return f"{provider}: критическая ошибка провайдера, прогон остановлен"


def is_throttle_error(message: str | None) -> bool:
    low = (message or "").lower()
    if any(marker in low for marker in QUOTA_MARKERS):
        return False
    return any(marker in low for marker in THROTTLE_MARKERS)


@dataclass
class BatchJob:
    id: int
    dataset: str | None
    checklist_version_id: int
    force: bool
    retry_failed: bool
    concurrency: int
    total: int = 0
    skipped: int = 0
    completed: int = 0
    needs_review: int = 0
    failed: int = 0
    in_flight: int = 0
    throttled_retries: int = 0
    cancelled: int = 0
    cancel_requested: bool = False
    fatal: str | None = None
    stop_event: threading.Event = field(default_factory=threading.Event, repr=False)
    model: str | None = None
    status: str = "queued"
    started_at: str = ""
    finished_at: str | None = None
    failures: list[dict] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def processed(self) -> int:
        return self.completed + self.needs_review + self.failed + self.cancelled

    def snapshot(self) -> dict:
        with self.lock:
            to_run = self.total - self.skipped
            return {
                "id": self.id,
                "run_id": self.id,
                "dataset": self.dataset,
                "checklist_version_id": self.checklist_version_id,
                "force": self.force,
                "retry_failed": self.retry_failed,
                "concurrency": self.concurrency,
                "model": self.model,
                "status": self.status,
                "total": self.total,
                "skipped": self.skipped,
                "to_run": to_run,
                "processed": self.processed,
                "completed": self.completed,
                "needs_review": self.needs_review,
                "failed": self.failed,
                "cancelled": self.cancelled,
                "in_flight": self.in_flight,
                "throttled_retries": self.throttled_retries,
                "percent": 100 if to_run <= 0 and self.status == "completed" else (round(100 * self.processed / to_run) if to_run > 0 else 0),
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "failures": list(self.failures),
            }


_jobs: dict[int, BatchJob] = {}
_jobs_lock = threading.Lock()


def get_job(job_id: int) -> BatchJob | None:
    return _jobs.get(job_id)


def list_jobs() -> list[dict]:
    with _jobs_lock:
        jobs = list(_jobs.values())
    return [j.snapshot() for j in sorted(jobs, key=lambda j: -j.id)]


def reset_jobs() -> None:
    with _jobs_lock:
        _jobs.clear()


def select_by_pks(conn: sqlite3.Connection, pks: list[int]) -> list[dict]:
    if not pks:
        return []
    marks = ",".join("?" for _ in pks)
    rows = conn.execute(
        f"SELECT c.id, c.conversation_id, d.group_id FROM conversation c JOIN dataset d ON d.id = c.dataset_id WHERE c.id IN ({marks}) ORDER BY c.id",
        list(pks),
    ).fetchall()
    return [dict(r) for r in rows]


def select_conversations(conn: sqlite3.Connection, dataset: str) -> list[dict]:
    if dataset.isdigit():
        rows = conn.execute(
            "SELECT c.id, c.conversation_id FROM conversation c JOIN dataset d ON d.id = c.dataset_id "
            "WHERE c.dataset_id = ? OR d.group_id = ? ORDER BY c.id",
            (int(dataset), dataset),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT c.id, c.conversation_id FROM conversation c JOIN dataset d ON d.id = c.dataset_id "
            "WHERE d.group_id = ? ORDER BY c.id",
            (dataset,),
        ).fetchall()
    return [dict(r) for r in rows]


def existing_statuses(conn: sqlite3.Connection, version_id: int) -> dict[int, set[str]]:
    out: dict[int, set[str]] = {}
    for r in conn.execute("SELECT conversation_id, status FROM evaluation WHERE checklist_version_id = ?", (version_id,)).fetchall():
        out.setdefault(r["conversation_id"], set()).add(r["status"])
    return out


def needs_run(statuses: set[str] | None, force: bool, retry_failed: bool) -> bool:
    if force:
        return True
    if not statuses:
        return True
    if "completed" in statuses:
        return False
    return retry_failed


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _db_write(sql: str, args: tuple = ()) -> None:
    conn = connect()
    try:
        conn.execute(sql, args)
        conn.commit()
    finally:
        conn.close()


def connect_write(sql: str, args: tuple = ()) -> int:
    conn = connect()
    try:
        count = conn.execute(sql, args).rowcount
        conn.commit()
        return count
    finally:
        conn.close()


def _refresh_counters(run_id: int, throttled: int) -> None:
    _db_write(
        "UPDATE eval_run SET "
        "completed = (SELECT COUNT(*) FROM eval_run_item WHERE run_id = ?1 AND status = 'completed'), "
        "needs_review = (SELECT COUNT(*) FROM eval_run_item WHERE run_id = ?1 AND status = 'needs_review'), "
        "failed = (SELECT COUNT(*) FROM eval_run_item WHERE run_id = ?1 AND status = 'failed'), "
        "throttled_retries = ?2 WHERE id = ?1",
        (run_id, throttled),
    )


def _evaluation_error(conn: sqlite3.Connection, evaluation_id: int) -> str | None:
    row = conn.execute("SELECT raw_output FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone()
    if not row or not row["raw_output"]:
        return None
    try:
        return json.loads(row["raw_output"]).get("error")
    except ValueError:
        return None


def _evaluate_with_backoff(
    job: BatchJob,
    pk: int,
    client: LLMClient,
    max_retries: int,
    backoff_base: float,
    sleep: Callable[[float], None],
    settings: Settings | None = None,
) -> dict:
    conn = connect()
    watch = _FatalWatch(client)
    try:
        attempt = 0
        while True:
            result = evaluate_conversation(conn, pk, job.checklist_version_id, watch, settings)
            error = _evaluation_error(conn, result["id"]) if result["status"] == "failed" else None
            if watch.fatal is not None:
                result["fatal"] = str(watch.fatal)
                if error:
                    result["error"] = error
                return result
            if error and is_throttle_error(error) and attempt < max_retries:
                conn.execute("DELETE FROM evaluation WHERE id = ?", (result["id"],))
                conn.commit()
                if job.stop_event.is_set():
                    raise _ItemCancelled(f"cancelled before retry: {error}")
                attempt += 1
                with job.lock:
                    job.throttled_retries += 1
                delay = backoff_base * (2 ** (attempt - 1))
                if sleep is time.sleep:
                    job.stop_event.wait(delay)
                else:
                    sleep(delay)
                if job.stop_event.is_set():
                    raise _ItemCancelled(f"cancelled during backoff: {error}")
                continue
            if error:
                result["error"] = error
            return result
    finally:
        conn.close()


def _claim_item(job: BatchJob, item: dict) -> bool:
    conn = connect()
    try:
        claimed = conn.execute(
            "UPDATE eval_run_item SET status = 'running', started_at = ? WHERE run_id = ? AND conversation_id = ? AND status = 'queued'",
            (_now_iso(), job.id, item["id"]),
        ).rowcount
        conn.commit()
        return bool(claimed)
    finally:
        conn.close()


def _finish_if_drained(job: BatchJob) -> None:
    with job.lock:
        if not job.cancel_requested or job.in_flight > 0 or job.fatal or job.status in FINAL_STATUSES:
            return
        job.status = "cancelled"
        job.finished_at = _now_iso()
        _db_write("UPDATE eval_run SET status = 'cancelled', finished_at = ? WHERE id = ?", (job.finished_at, job.id))


def _register_fatal(job: BatchJob, text: str, message: str) -> None:
    with job.lock:
        first = job.fatal is None
        if first:
            job.fatal = message
            job.stop_event.set()
    if not first:
        return
    conn = connect()
    try:
        count = conn.execute(
            "UPDATE eval_run_item SET status = 'cancelled', error = ?, finished_at = ? WHERE run_id = ? AND status = 'queued'",
            (redact(text), _now_iso(), job.id),
        ).rowcount
        conn.commit()
    finally:
        conn.close()
    with job.lock:
        job.cancelled += count


def _process_item(job: BatchJob, item: dict, client: LLMClient, max_retries: int, backoff_base: float, sleep: Callable[[float], None], settings: Settings | None = None) -> None:
    with job.lock:
        if job.stop_event.is_set():
            return
        job.in_flight += 1
    if not _claim_item(job, item):
        with job.lock:
            job.in_flight -= 1
        _finish_if_drained(job)
        return
    began = time.monotonic()
    evaluation_id = None
    latency_ms = None
    fatal = None
    cancelled = False
    try:
        result = _evaluate_with_backoff(job, item["id"], client, max_retries, backoff_base, sleep, settings)
        status = result["status"]
        error = result.get("error")
        evaluation_id = result["id"]
        latency_ms = result.get("latency_ms")
        fatal = result.get("fatal")
        _db_write("UPDATE evaluation SET run_id = ? WHERE id = ?", (job.id, evaluation_id))
    except _ItemCancelled as stop:
        cancelled = True
        status = "cancelled"
        error = str(stop)
    except Exception as exc:
        status = "failed"
        error = f"{type(exc).__name__}: {exc}"
        if isinstance(exc, LLMFatalError):
            fatal = error
    if latency_ms is None:
        latency_ms = round((time.monotonic() - began) * 1000)
    if not cancelled and status not in ("completed", "needs_review"):
        status = "failed"
        error = error or "failed"
    if fatal is None and status == "failed" and is_fatal_text(error):
        fatal = error
    with job.lock:
        if status == "completed":
            job.completed += 1
        elif status == "needs_review":
            job.needs_review += 1
        elif status == "cancelled":
            job.cancelled += 1
        else:
            job.failed += 1
            job.failures.append({"conversation_pk": item["id"], "conversation_id": item["conversation_id"], "error": error})
        throttled = job.throttled_retries
    _db_write(
        "UPDATE eval_run_item SET status = ?, evaluation_id = ?, latency_ms = ?, error = ?, finished_at = ? WHERE run_id = ? AND conversation_id = ?",
        (status, evaluation_id, latency_ms, error, _now_iso(), job.id, item["id"]),
    )
    _refresh_counters(job.id, throttled)
    if fatal:
        _register_fatal(job, fatal, fatal_run_message(_provider_label(client, settings), fatal))
    with job.lock:
        job.in_flight -= 1
    _finish_if_drained(job)


def create_job(conn: sqlite3.Connection, dataset: str | None, version_id: int, force: bool = False, retry_failed: bool = True, concurrency: int | None = None, conversation_pks: list[int] | None = None, model: str | None = None, settings: Settings | None = None) -> tuple[BatchJob, list[dict]]:
    if dataset:
        items = select_conversations(conn, dataset)
        if conversation_pks is not None:
            wanted = set(conversation_pks)
            items = [i for i in items if i["id"] in wanted]
    else:
        items = select_by_pks(conn, conversation_pks or [])
        groups = {i["group_id"] for i in items}
        dataset = groups.pop() if len(groups) == 1 else "mixed"
    if not items:
        raise LookupError(f"No conversations found for dataset {dataset}")
    statuses = existing_statuses(conn, version_id)
    todo = [i for i in items if needs_run(statuses.get(i["id"]), force, retry_failed)]
    cfg = settings or get_settings()
    workers = max(1, concurrency or cfg.cqa_batch_concurrency)
    if cfg.llm_provider == "openai":
        workers = min(workers, max(1, cfg.openai_max_inflight))
    started = _now_iso()
    run_id = conn.execute(
        "INSERT INTO eval_run (dataset, checklist_version_id, model, force, retry_failed, concurrency, status, total, skipped, started_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (dataset, version_id, model, int(force), int(retry_failed), workers, "queued", len(items), len(items) - len(todo), started),
    ).lastrowid
    todo_ids = {i["id"] for i in todo}
    conn.executemany(
        "INSERT INTO eval_run_item (run_id, conversation_id, status) VALUES (?,?,?)",
        [(run_id, i["id"], "queued" if i["id"] in todo_ids else "skipped") for i in items],
    )
    conn.commit()
    job = BatchJob(
        id=run_id,
        dataset=dataset,
        checklist_version_id=version_id,
        force=force,
        retry_failed=retry_failed,
        concurrency=workers,
        total=len(items),
        skipped=len(items) - len(todo),
        model=model,
        started_at=started,
    )
    with _jobs_lock:
        _jobs[job.id] = job
    return job, todo


def run_job(job: BatchJob, todo: list[dict], client: LLMClient, max_retries: int = 4, backoff_base: float = 2.0, sleep: Callable[[float], None] = time.sleep, settings: Settings | None = None) -> None:
    with job.lock:
        if job.status != "queued":
            return
        job.status = "running"
        _db_write("UPDATE eval_run SET status = 'running' WHERE id = ?", (job.id,))
    try:
        with ThreadPoolExecutor(max_workers=job.concurrency) as pool:
            futures = [pool.submit(_process_item, job, item, client, max_retries, backoff_base, sleep, settings) for item in todo]
            for f in futures:
                f.result()
    except Exception as exc:
        with job.lock:
            job.status = "failed"
            job.finished_at = _now_iso()
            message = f"{type(exc).__name__}: {exc}"
            job.failures.append({"conversation_pk": None, "conversation_id": None, "error": message})
        _db_write("UPDATE eval_run SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", (job.finished_at, message, job.id))
        return
    with job.lock:
        if job.status == "cancelled":
            return
        job.finished_at = _now_iso()
        if job.fatal:
            job.status = "failed"
            job.failures.append({"conversation_pk": None, "conversation_id": None, "error": job.fatal})
            _db_write("UPDATE eval_run SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", (job.finished_at, job.fatal, job.id))
            return
        job.status = "cancelled" if job.cancel_requested else "completed"
        _db_write("UPDATE eval_run SET status = ?, finished_at = ? WHERE id = ?", (job.status, job.finished_at, job.id))


def start_job(conn: sqlite3.Connection, dataset: str | None, version_id: int, client: LLMClient, force: bool = False, retry_failed: bool = True, concurrency: int | None = None, max_retries: int = 4, backoff_base: float = 2.0, conversation_pks: list[int] | None = None, settings: Settings | None = None) -> BatchJob:
    settings = settings or getattr(client, "settings", None)
    job, todo = create_job(conn, dataset, version_id, force, retry_failed, concurrency, conversation_pks, client.model, settings)
    thread = threading.Thread(target=run_job, args=(job, todo, client, max_retries, backoff_base, time.sleep, settings), daemon=True, name=f"batch-{job.id}")
    thread.start()
    return job


def run_job_sync(conn: sqlite3.Connection, dataset: str, version_id: int, client: LLMClient, force: bool = False, retry_failed: bool = True, concurrency: int | None = None, max_retries: int = 4, backoff_base: float = 2.0, sleep: Callable[[float], None] = time.sleep, on_progress: Callable[[dict], None] | None = None, settings: Settings | None = None) -> dict:
    settings = settings or getattr(client, "settings", None)
    job, todo = create_job(conn, dataset, version_id, force, retry_failed, concurrency, None, client.model, settings)
    stop = threading.Event()

    def reporter():
        while not stop.wait(1.0):
            on_progress(job.snapshot())

    watcher = None
    if on_progress:
        watcher = threading.Thread(target=reporter, daemon=True)
        watcher.start()
    run_job(job, todo, client, max_retries, backoff_base, sleep, settings)
    stop.set()
    if watcher:
        watcher.join()
    return job.snapshot()


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _final(conn: sqlite3.Connection, evaluation_id: int | None) -> dict | None:
    if not evaluation_id:
        return None
    try:
        ev = with_review(conn, get_evaluation(conn, evaluation_id))
    except Exception:
        return None
    return {
        "total": ev.get("final_total"),
        "gross": bool((ev.get("final") or {}).get("gross_violation", ev.get("gross_violation"))),
        "status": ev.get("status"),
    }


def _run_status(row: sqlite3.Row) -> str:
    if row["status"] in ACTIVE_DB_STATUSES and row["id"] not in _jobs:
        return "interrupted"
    return row["status"]


def _run_totals(conn: sqlite3.Connection, run_id: int) -> tuple[float | None, int, int, float]:
    agg = conn.execute(
        "SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(tokens_input), 0) AS tin, COALESCE(SUM(tokens_output), 0) AS tout "
        "FROM evaluation WHERE run_id = ?",
        (run_id,),
    ).fetchone()
    totals = []
    for r in conn.execute(
        "SELECT i.evaluation_id FROM eval_run_item i WHERE i.run_id = ? AND i.status IN ('completed', 'needs_review') AND i.evaluation_id IS NOT NULL",
        (run_id,),
    ).fetchall():
        final = _final(conn, r["evaluation_id"])
        if final and final["total"] is not None:
            totals.append(final["total"])
    average = round(sum(totals) / len(totals), 2) if totals else None
    return average, int(agg["tin"]), int(agg["tout"]), round(float(agg["cost"]), 6)


def _run_header(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    run_id = row["id"]
    counts = {
        r["status"]: r["n"]
        for r in conn.execute("SELECT status, COUNT(*) AS n FROM eval_run_item WHERE run_id = ? GROUP BY status", (run_id,)).fetchall()
    }
    status = _run_status(row)
    to_run = row["total"] - row["skipped"]
    cancelled = counts.get("cancelled", 0)
    processed = row["completed"] + row["needs_review"] + row["failed"] + cancelled
    started = _parse_ts(row["started_at"])
    finished = _parse_ts(row["finished_at"])
    now = datetime.now(timezone.utc)
    elapsed = None
    if started:
        elapsed = round(max(((finished or now) - started).total_seconds(), 0), 1)
    eta = None
    if status == "running" and elapsed is not None and processed > 0:
        eta = round(elapsed / processed * max(to_run - processed, 0), 1)
    average, tokens_in, tokens_out, cost = _run_totals(conn, run_id)
    meta = conn.execute(
        "SELECT c.name, v.version FROM checklist_version v JOIN checklist c ON c.id = v.checklist_id WHERE v.id = ?",
        (row["checklist_version_id"],),
    ).fetchone()
    ds = conn.execute("SELECT label FROM dataset WHERE group_id = ? ORDER BY id LIMIT 1", (row["dataset"],)).fetchone()
    failures = [
        {"conversation_pk": r["conversation_id"], "conversation_id": r["cid"], "error": r["error"]}
        for r in conn.execute(
            "SELECT i.conversation_id, c.conversation_id AS cid, i.error FROM eval_run_item i JOIN conversation c ON c.id = i.conversation_id "
            "WHERE i.run_id = ? AND i.status = 'failed' ORDER BY i.id",
            (run_id,),
        ).fetchall()
    ]
    if row["error"]:
        failures.append({"conversation_pk": None, "conversation_id": None, "error": row["error"]})
    return {
        "id": run_id,
        "run_id": run_id,
        "code": f"R-{run_id:04d}",
        "dataset": row["dataset"],
        "dataset_label": (ds["label"] if ds and ds["label"] else row["dataset"]),
        "checklist_version_id": row["checklist_version_id"],
        "checklist_label": f"{meta['name']} v{meta['version']}" if meta else None,
        "model": row["model"],
        "force": bool(row["force"]),
        "retry_failed": bool(row["retry_failed"]),
        "concurrency": row["concurrency"],
        "status": status,
        "total": row["total"],
        "skipped": row["skipped"],
        "to_run": to_run,
        "processed": processed,
        "completed": row["completed"],
        "needs_review": row["needs_review"],
        "failed": row["failed"],
        "cancelled": cancelled,
        "done": row["completed"] + row["needs_review"],
        "running": counts.get("running", 0),
        "in_flight": counts.get("running", 0),
        "queued": counts.get("queued", 0),
        "throttled_retries": row["throttled_retries"],
        "percent": 100 if to_run <= 0 and status == "completed" else (round(100 * processed / to_run) if to_run > 0 else 0),
        "average_total": average,
        "cost_total": cost,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "elapsed_s": elapsed,
        "eta_s": eta,
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "failures": failures,
    }


def list_runs(conn: sqlite3.Connection, offset: int = 0, limit: int = 50) -> list[dict]:
    rows = conn.execute("SELECT * FROM eval_run ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
    return [_run_header(conn, r) for r in rows]


def count_runs(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM eval_run").fetchone()[0]


def get_run(conn: sqlite3.Connection, run_id: int, offset: int = 0, limit: int = 50, with_items: bool = True) -> dict | None:
    row = conn.execute("SELECT * FROM eval_run WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    payload = _run_header(conn, row)
    if not with_items:
        return payload
    rows = conn.execute(
        "SELECT i.*, c.conversation_id AS cid, c.channel, c.language FROM eval_run_item i JOIN conversation c ON c.id = i.conversation_id "
        "WHERE i.run_id = ? ORDER BY i.id LIMIT ? OFFSET ?",
        (run_id, limit, offset),
    ).fetchall()
    items = []
    for r in rows:
        evaluation_id = r["evaluation_id"]
        if r["status"] == "skipped" and not evaluation_id:
            prior = conn.execute(
                "SELECT id FROM evaluation WHERE conversation_id = ? AND checklist_version_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
                (r["conversation_id"], row["checklist_version_id"]),
            ).fetchone()
            evaluation_id = prior["id"] if prior else None
        final = _final(conn, evaluation_id) if r["status"] in ("completed", "needs_review", "skipped") else None
        other = conn.execute(
            "SELECT id FROM evaluation WHERE conversation_id = ? AND checklist_version_id != ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
            (r["conversation_id"], row["checklist_version_id"]),
        ).fetchone()
        other_final = _final(conn, other["id"]) if other else None
        items.append(
            {
                "conversation_pk": r["conversation_id"],
                "conversation_id": r["cid"],
                "channel": r["channel"],
                "language": r["language"],
                "status": r["status"],
                "evaluation_id": evaluation_id,
                "latency_ms": r["latency_ms"],
                "total": final["total"] if final else None,
                "gross": final["gross"] if final else None,
                "error": r["error"],
                "other_version_total": other_final["total"] if other_final else None,
                "started_at": r["started_at"],
                "finished_at": r["finished_at"],
            }
        )
    payload["items"] = items
    payload["items_total"] = conn.execute("SELECT COUNT(*) FROM eval_run_item WHERE run_id = ?", (run_id,)).fetchone()[0]
    payload["offset"] = offset
    payload["limit"] = limit
    return payload


class RetryError(Exception):
    def __init__(self, code: str, message: str, status: int):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def retry_item(conn: sqlite3.Connection, run_id: int, conversation_pk: int, client: LLMClient, max_retries: int = 4, backoff_base: float = 2.0, sleep: Callable[[float], None] = time.sleep) -> dict:
    run = conn.execute("SELECT * FROM eval_run WHERE id = ?", (run_id,)).fetchone()
    if run is None:
        raise RetryError("run_not_found", "Run not found", 404)
    item = conn.execute(
        "SELECT i.*, c.conversation_id AS cid FROM eval_run_item i JOIN conversation c ON c.id = i.conversation_id WHERE i.run_id = ? AND i.conversation_id = ?",
        (run_id, conversation_pk),
    ).fetchone()
    if item is None:
        raise RetryError("item_not_found", "Run item not found", 404)
    if item["status"] != "failed":
        raise RetryError("item_not_failed", "Only failed items can be retried", 409)
    claimed = conn.execute(
        "UPDATE eval_run_item SET status = 'running', started_at = ?, finished_at = NULL, error = NULL WHERE id = ? AND status = 'failed'",
        (_now_iso(), item["id"]),
    ).rowcount
    conn.commit()
    if not claimed:
        raise RetryError("item_not_failed", "Only failed items can be retried", 409)
    job = BatchJob(
        id=run_id,
        dataset=run["dataset"],
        checklist_version_id=run["checklist_version_id"],
        force=bool(run["force"]),
        retry_failed=bool(run["retry_failed"]),
        concurrency=1,
        model=run["model"],
    )
    began = time.monotonic()
    evaluation_id = None
    latency_ms = None
    try:
        result = _evaluate_with_backoff(job, conversation_pk, client, max_retries, backoff_base, sleep)
        status = result["status"]
        error = result.get("error")
        evaluation_id = result["id"]
        latency_ms = result.get("latency_ms")
        _db_write("UPDATE evaluation SET run_id = ? WHERE id = ?", (run_id, evaluation_id))
    except Exception as exc:
        status = "failed"
        error = f"{type(exc).__name__}: {exc}"
    if latency_ms is None:
        latency_ms = round((time.monotonic() - began) * 1000)
    if status not in ("completed", "needs_review"):
        status = "failed"
        error = error or "failed"
    _db_write(
        "UPDATE eval_run_item SET status = ?, evaluation_id = ?, latency_ms = ?, error = ?, finished_at = ? WHERE id = ?",
        (status, evaluation_id, latency_ms, error, _now_iso(), item["id"]),
    )
    _refresh_counters(run_id, run["throttled_retries"] + job.throttled_retries)
    with _jobs_lock:
        live = _jobs.get(run_id)
    if live is not None:
        with live.lock:
            live.failed = max(live.failed - 1, 0)
            if status == "completed":
                live.completed += 1
            elif status == "needs_review":
                live.needs_review += 1
            else:
                live.failed += 1
            live.failures = [f for f in live.failures if f.get("conversation_pk") != conversation_pk]
            if status == "failed":
                live.failures.append({"conversation_pk": conversation_pk, "conversation_id": item["cid"], "error": error})
    return get_run(conn, run_id, with_items=False)


def cancel_run(conn: sqlite3.Connection, run_id: int) -> dict:
    row = conn.execute("SELECT * FROM eval_run WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise RetryError("run_not_found", "Run not found", 404)
    if row["status"] in FINAL_STATUSES:
        raise RetryError("run_not_active", f"Run is already {row['status']}", 409)
    with _jobs_lock:
        job = _jobs.get(run_id)
    if job is None:
        now = _now_iso()
        conn.execute(
            "UPDATE eval_run_item SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')",
            (now, run_id),
        )
        conn.execute("UPDATE eval_run SET status = 'cancelled', finished_at = ? WHERE id = ?", (now, run_id))
        conn.commit()
        return get_run(conn, run_id, with_items=False)
    with job.lock:
        if job.status in FINAL_STATUSES:
            raise RetryError("run_not_active", f"Run is already {job.status}", 409)
        if not job.cancel_requested:
            job.cancel_requested = True
            job.stop_event.set()
            job.status = "cancelling"
            count = connect_write(
                "UPDATE eval_run_item SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status = 'queued'",
                (_now_iso(), run_id),
            )
            job.cancelled += count
            _db_write("UPDATE eval_run SET status = 'cancelling' WHERE id = ?", (run_id,))
    _finish_if_drained(job)
    return get_run(conn, run_id, with_items=False)
