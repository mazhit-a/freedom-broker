from typing import Optional

from fastapi import APIRouter, Depends, Query

from backend.app.core.database import get_db
from backend.app.services import stats

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("/overview")
def overview(
    dataset: Optional[str] = None,
    checklist_version_id: Optional[int] = None,
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    language: Optional[str] = None,
    channel: Optional[str] = None,
    attention_limit: int = Query(20, ge=1, le=200),
    conn=Depends(get_db),
):
    return stats.overview(conn, dataset, checklist_version_id, date_from, date_to, language, channel, attention_limit)
