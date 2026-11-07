from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.app.core.database import get_db
from backend.app.services import batch
from backend.app.services.llm_client import LLMClient, get_llm_client

router = APIRouter(prefix="/batches", tags=["batches"])


class BatchStart(BaseModel):
    dataset: str
    checklist_version_id: Optional[int] = None
    force: bool = False
    retry_failed: bool = True
    concurrency: Optional[int] = None


def _default_version_id(conn) -> Optional[int]:
    row = conn.execute("SELECT default_version_id FROM checklist WHERE default_version_id IS NOT NULL ORDER BY id LIMIT 1").fetchone()
    return row["default_version_id"] if row else None


@router.post("", status_code=202)
def start_batch(body: BatchStart, conn=Depends(get_db), client: LLMClient = Depends(get_llm_client)):
    version_id = body.checklist_version_id or _default_version_id(conn)
    if version_id is None:
        raise HTTPException(status_code=422, detail="No checklist version available")
    if not conn.execute("SELECT 1 FROM checklist_version WHERE id = ?", (version_id,)).fetchone():
        raise HTTPException(status_code=404, detail="Checklist version not found")
    try:
        job = batch.start_job(conn, body.dataset, version_id, client, body.force, body.retry_failed, body.concurrency)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return job.snapshot()


@router.get("")
def list_batches():
    return batch.list_jobs()


@router.get("/{job_id}")
def batch_status(job_id: int):
    job = batch.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return job.snapshot()
