from typing import Optional

from fastapi import APIRouter, Depends

from backend.app.core.errors import ApiError
from backend.app.core.database import get_db
from backend.app.services import checklist as checklist_service
from backend.app.services.appeals import with_review
from backend.app.services.evaluator import evaluate_conversation, get_evaluation
from backend.app.services.llm_client import LLMClient, get_llm_client

router = APIRouter(tags=["evaluations"])


def _default_version_id(conn) -> Optional[int]:
    row = conn.execute("SELECT default_version_id FROM checklist WHERE default_version_id IS NOT NULL ORDER BY id LIMIT 1").fetchone()
    return row["default_version_id"] if row else None


@router.post("/conversations/{conversation_pk}/evaluate")
def evaluate(
    conversation_pk: int,
    checklist_version_id: Optional[int] = None,
    conn=Depends(get_db),
    client: LLMClient = Depends(get_llm_client),
):
    channel_row = conn.execute("SELECT channel FROM conversation WHERE id = ?", (conversation_pk,)).fetchone()
    version_id = checklist_service.resolve_version_id(
        conn, checklist_version_id, channel_row["channel"] if channel_row else None
    )
    if version_id is None:
        raise ApiError(422, "No checklist version available", "no_checklist_version")
    if not conn.execute("SELECT 1 FROM checklist_version WHERE id = ?", (version_id,)).fetchone():
        raise ApiError(404, "Checklist version not found", "checklist_version_not_found")
    if checklist_service.is_draft(conn, version_id):
        raise ApiError(422, "Draft checklist versions cannot be evaluated", "checklist_version_draft")
    try:
        return evaluate_conversation(conn, conversation_pk, version_id, client)
    except LookupError as exc:
        raise ApiError(404, str(exc), "not_found")


@router.get("/conversations/{conversation_pk}/evaluation")
def latest_for_conversation(conversation_pk: int, checklist_version_id: Optional[int] = None, conn=Depends(get_db)):
    sql = "SELECT id FROM evaluation WHERE conversation_id = ?"
    args: list = [conversation_pk]
    if checklist_version_id is not None:
        sql += " AND checklist_version_id = ?"
        args.append(checklist_version_id)
    row = conn.execute(sql + " ORDER BY id DESC LIMIT 1", args).fetchone()
    if not row:
        raise ApiError(404, "Evaluation not found", "evaluation_not_found")
    return with_review(conn, get_evaluation(conn, row["id"]))


@router.get("/conversations/{conversation_pk}/evaluations")
def list_for_conversation(conversation_pk: int, conn=Depends(get_db)):
    rows = conn.execute("SELECT id FROM evaluation WHERE conversation_id = ? ORDER BY id DESC", (conversation_pk,)).fetchall()
    return [with_review(conn, get_evaluation(conn, r["id"])) for r in rows]


@router.get("/evaluations/{evaluation_id}")
def read_evaluation(evaluation_id: int, conn=Depends(get_db)):
    try:
        return with_review(conn, get_evaluation(conn, evaluation_id))
    except LookupError as exc:
        raise ApiError(404, str(exc), "evaluation_not_found")
