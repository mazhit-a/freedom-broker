from fastapi import APIRouter, Depends, HTTPException, Query, Response

from backend.app.api.v1.batches import BatchStart, start_batch
from backend.app.core.database import get_db
from backend.app.services import batch
from backend.app.services.llm_client import LLMClient, get_llm_client

router = APIRouter(prefix="/runs", tags=["runs"])


@router.post("", status_code=202)
def start_run(body: BatchStart, conn=Depends(get_db), client: LLMClient = Depends(get_llm_client)):
    return start_batch(body, conn, client)


@router.get("")
def list_runs(
    response: Response,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    conn=Depends(get_db),
):
    response.headers["X-Total-Count"] = str(batch.count_runs(conn))
    return batch.list_runs(conn, offset, limit)


@router.get("/{run_id}")
def get_run(
    run_id: int,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    conn=Depends(get_db),
):
    run = batch.get_run(conn, run_id, offset, limit)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run
