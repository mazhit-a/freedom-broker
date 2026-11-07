from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.app.core.database import get_db
from backend.app.services import appeals as service

router = APIRouter(tags=["appeals"])


class AppealIn(BaseModel):
    criterion_id: str
    comment: Optional[str] = None
    role: Optional[str] = None


class DecisionIn(BaseModel):
    decision: str
    new_answer: Any = None
    reason: Optional[str] = None
    role: Optional[str] = None


def _raise(exc: service.AppealError):
    raise HTTPException(status_code=exc.status, detail=exc.message)


@router.post("/evaluations/{evaluation_id}/appeals", status_code=201)
def create(evaluation_id: int, body: AppealIn, conn=Depends(get_db)):
    try:
        return service.create_appeal(conn, evaluation_id, body.criterion_id, body.comment, body.role)
    except service.AppealError as exc:
        _raise(exc)


@router.get("/appeals")
def list_appeals(status: str = "open", conn=Depends(get_db)):
    if status not in ("open", "resolved", "all"):
        raise HTTPException(status_code=422, detail="status must be open, resolved or all")
    return service.queue(conn, status)


@router.get("/appeals/{appeal_id}")
def read(appeal_id: int, conn=Depends(get_db)):
    try:
        return service.get_appeal(conn, appeal_id)
    except service.AppealError as exc:
        _raise(exc)


@router.post("/appeals/{appeal_id}/decision")
def decide(appeal_id: int, body: DecisionIn, conn=Depends(get_db)):
    try:
        return service.decide(conn, appeal_id, body.decision, body.new_answer, body.reason, body.role)
    except service.AppealError as exc:
        _raise(exc)
