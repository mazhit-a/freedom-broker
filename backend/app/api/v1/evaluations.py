from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from backend.app.core.database import get_db
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
    version_id = checklist_version_id or _default_version_id(conn)
    if version_id is None:
        raise HTTPException(status_code=422, detail="No checklist version available")
    if not conn.execute("SELECT 1 FROM checklist_version WHERE id = ?", (version_id,)).fetchone():
        raise HTTPException(status_code=404, detail="Checklist version not found")
    try:
        return evaluate_conversation(conn, conversation_pk, version_id, client)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/conversations/{conversation_pk}/evaluations")
def list_for_conversation(conversation_pk: int, conn=Depends(get_db)):
    rows = conn.execute("SELECT id FROM evaluation WHERE conversation_id = ? ORDER BY id DESC", (conversation_pk,)).fetchall()
    return [with_review(conn, get_evaluation(conn, r["id"])) for r in rows]


@router.get("/evaluations/{evaluation_id}")
def read_evaluation(evaluation_id: int, conn=Depends(get_db)):
    try:
        return with_review(conn, get_evaluation(conn, evaluation_id))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
