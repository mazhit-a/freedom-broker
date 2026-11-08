from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from backend.app.api.v1.batches import BatchStart, _batch_channel, start_batch
from backend.app.core.database import get_db
from backend.app.services import batch, catalog
from backend.app.services.clients import client_for
from backend.app.services import checklist as checklist_service
from backend.app.services.llm_client import LLMClient, get_llm_client

router = APIRouter(prefix="/runs", tags=["runs"])
models_router = APIRouter(prefix="/models", tags=["runs"])


class RunStart(BatchStart):
    model: Optional[str] = None


@models_router.get("")
def list_models(conn=Depends(get_db)):
    return catalog.list_models(conn)


@router.post("", status_code=202)
def start_run(body: RunStart, conn=Depends(get_db), client: LLMClient = Depends(get_llm_client)):
    if catalog.find_model(conn, body.model) is None:
        raise HTTPException(status_code=422, detail={"code": "unknown_model", "message": f"Unknown model {body.model}"})
    return start_batch(body, conn, client_for(body.model, client))


@router.get("/estimate")
def estimate_run(
    dataset: Optional[str] = None,
    checklist_version_id: Optional[int] = None,
    force: bool = False,
    retry_failed: bool = True,
    concurrency: Optional[int] = Query(None, ge=1),
    model: Optional[str] = None,
    conversation_pks: Optional[list[int]] = Query(None),
    conn=Depends(get_db),
):
    if not dataset and not conversation_pks:
        raise HTTPException(status_code=422, detail={"code": "dataset_required", "message": "dataset or conversation_pks is required"})
    if catalog.find_model(conn, model) is None:
        raise HTTPException(status_code=422, detail={"code": "unknown_model", "message": f"Unknown model {model}"})
    probe = BatchStart(dataset=dataset, conversation_pks=conversation_pks)
    version_id = checklist_service.resolve_version_id(conn, checklist_version_id, _batch_channel(conn, probe))
    if version_id is None:
        raise HTTPException(status_code=422, detail={"code": "no_checklist_version", "message": "No checklist version available"})
    if not conn.execute("SELECT 1 FROM checklist_version WHERE id = ?", (version_id,)).fetchone():
        raise HTTPException(status_code=404, detail="Checklist version not found")
    try:
        return catalog.estimate(conn, dataset, version_id, force, retry_failed, concurrency, conversation_pks, model)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{run_id}/items/{conversation_pk}/retry")
def retry_run_item(run_id: int, conversation_pk: int, conn=Depends(get_db), client: LLMClient = Depends(get_llm_client)):
    try:
        return batch.retry_item(conn, run_id, conversation_pk, client)
    except batch.RetryError as exc:
        raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": exc.message})


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
