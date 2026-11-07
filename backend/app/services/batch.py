import itertools
import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from backend.app.core.config import get_settings
from backend.app.core.database import connect
from backend.app.services.evaluator import evaluate_conversation
from backend.app.services.llm_client import LLMClient

THROTTLE_MARKERS = ("429", "throttl", "ratelimit", "rate limit", "rate_limit", "too many requests", "overloaded", "529", "503", "serviceunavailable")


def is_throttle_error(message: str | None) -> bool:
    low = (message or "").lower()
    return any(marker in low for marker in THROTTLE_MARKERS)


@dataclass
class BatchJob:
    id: int
    dataset: str
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
    status: str = "queued"
    started_at: str = ""
    finished_at: str | None = None
    failures: list[dict] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def processed(self) -> int:
        return self.completed + self.needs_review + self.failed

    def snapshot(self) -> dict:
        with self.lock:
            to_run = self.total - self.skipped
            return {
                "id": self.id,
                "dataset": self.dataset,
                "checklist_version_id": self.checklist_version_id,
                "force": self.force,
                "retry_failed": self.retry_failed,
                "concurrency": self.concurrency,
                "status": self.status,
                "total": self.total,
                "skipped": self.skipped,
                "to_run": to_run,
                "processed": self.processed,
                "completed": self.completed,
                "needs_review": self.needs_review,
                "failed": self.failed,
                "in_flight": self.in_flight,
                "throttled_retries": self.throttled_retries,
                "percent": 100 if to_run <= 0 and self.status == "completed" else (round(100 * self.processed / to_run) if to_run > 0 else 0),
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "failures": list(self.failures),
            }


_jobs: dict[int, BatchJob] = {}
_jobs_lock = threading.Lock()
_ids = itertools.count(1)


def get_job(job_id: int) -> BatchJob | None:
    return _jobs.get(job_id)


def list_jobs() -> list[dict]:
    with _jobs_lock:
        jobs = list(_jobs.values())
    return [j.snapshot() for j in sorted(jobs, key=lambda j: -j.id)]


def reset_jobs() -> None:
    with _jobs_lock:
        _jobs.clear()


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
) -> dict:
    conn = connect()
    try:
        attempt = 0
        while True:
            result = evaluate_conversation(conn, pk, job.checklist_version_id, client)
            error = _evaluation_error(conn, result["id"]) if result["status"] == "failed" else None
            if error and is_throttle_error(error) and attempt < max_retries:
                conn.execute("DELETE FROM evaluation WHERE id = ?", (result["id"],))
                conn.commit()
                attempt += 1
                with job.lock:
                    job.throttled_retries += 1
                sleep(backoff_base * (2 ** (attempt - 1)))
                continue
            if error:
                result["error"] = error
            return result
    finally:
        conn.close()


def _process_item(job: BatchJob, item: dict, client: LLMClient, max_retries: int, backoff_base: float, sleep: Callable[[float], None]) -> None:
    with job.lock:
        job.in_flight += 1
    try:
        result = _evaluate_with_backoff(job, item["id"], client, max_retries, backoff_base, sleep)
        status = result["status"]
        error = result.get("error")
    except Exception as exc:
        status = "failed"
        error = f"{type(exc).__name__}: {exc}"
    finally:
        with job.lock:
            job.in_flight -= 1
    with job.lock:
        if status == "completed":
            job.completed += 1
        elif status == "needs_review":
            job.needs_review += 1
        else:
            job.failed += 1
            job.failures.append({"conversation_pk": item["id"], "conversation_id": item["conversation_id"], "error": error or status})


def create_job(conn: sqlite3.Connection, dataset: str, version_id: int, force: bool = False, retry_failed: bool = True, concurrency: int | None = None, conversation_pks: list[int] | None = None) -> tuple[BatchJob, list[dict]]:
    items = select_conversations(conn, dataset)
    if conversation_pks is not None:
        wanted = set(conversation_pks)
        items = [i for i in items if i["id"] in wanted]
    if not items:
        raise LookupError(f"No conversations found for dataset {dataset}")
    statuses = existing_statuses(conn, version_id)
    todo = [i for i in items if needs_run(statuses.get(i["id"]), force, retry_failed)]
    workers = max(1, concurrency or get_settings().cqa_batch_concurrency)
    job = BatchJob(
        id=next(_ids),
        dataset=dataset,
        checklist_version_id=version_id,
        force=force,
        retry_failed=retry_failed,
        concurrency=workers,
        total=len(items),
        skipped=len(items) - len(todo),
        started_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    with _jobs_lock:
        _jobs[job.id] = job
    return job, todo


def run_job(job: BatchJob, todo: list[dict], client: LLMClient, max_retries: int = 4, backoff_base: float = 2.0, sleep: Callable[[float], None] = time.sleep) -> None:
    with job.lock:
        job.status = "running"
    try:
        with ThreadPoolExecutor(max_workers=job.concurrency) as pool:
            futures = [pool.submit(_process_item, job, item, client, max_retries, backoff_base, sleep) for item in todo]
            for f in futures:
                f.result()
    except Exception as exc:
        with job.lock:
            job.status = "failed"
            job.finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            job.failures.append({"conversation_pk": None, "conversation_id": None, "error": f"{type(exc).__name__}: {exc}"})
        return
    with job.lock:
        job.status = "completed"
        job.finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")


def start_job(conn: sqlite3.Connection, dataset: str, version_id: int, client: LLMClient, force: bool = False, retry_failed: bool = True, concurrency: int | None = None, max_retries: int = 4, backoff_base: float = 2.0, conversation_pks: list[int] | None = None) -> BatchJob:
    job, todo = create_job(conn, dataset, version_id, force, retry_failed, concurrency, conversation_pks)
    thread = threading.Thread(target=run_job, args=(job, todo, client, max_retries, backoff_base), daemon=True, name=f"batch-{job.id}")
    thread.start()
    return job


def run_job_sync(conn: sqlite3.Connection, dataset: str, version_id: int, client: LLMClient, force: bool = False, retry_failed: bool = True, concurrency: int | None = None, max_retries: int = 4, backoff_base: float = 2.0, sleep: Callable[[float], None] = time.sleep, on_progress: Callable[[dict], None] | None = None) -> dict:
    job, todo = create_job(conn, dataset, version_id, force, retry_failed, concurrency)
    stop = threading.Event()

    def reporter():
        while not stop.wait(1.0):
            on_progress(job.snapshot())

    watcher = None
    if on_progress:
        watcher = threading.Thread(target=reporter, daemon=True)
        watcher.start()
    run_job(job, todo, client, max_retries, backoff_base, sleep)
    stop.set()
    if watcher:
        watcher.join()
    return job.snapshot()
