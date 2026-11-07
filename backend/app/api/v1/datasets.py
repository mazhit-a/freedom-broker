from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from backend.app.core.database import get_db
from backend.app.services import importer

router = APIRouter(prefix="/datasets", tags=["datasets"])


class ImportRequest(BaseModel):
    group_id: str


def _wrap(call):
    try:
        return call()
    except importer.ImportError_ as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)


@router.post("/import")
def import_dataset(body: ImportRequest, conn=Depends(get_db)):
    group_id = body.group_id.strip()
    if not group_id:
        raise HTTPException(status_code=422, detail="group_id must not be empty")
    return _wrap(lambda: importer.import_from_api(conn, group_id))


@router.post("/import-file")
async def import_dataset_file(
    file: UploadFile = File(...),
    group_id: Optional[str] = Form(None),
    conn=Depends(get_db),
):
    content = await file.read()
    gid = group_id.strip() if group_id and group_id.strip() else None
    return _wrap(lambda: importer.import_from_file(conn, content, gid))


@router.get("")
def list_datasets(conn=Depends(get_db)):
    rows = conn.execute(
        "SELECT d.id, d.group_id, d.imported_at, d.source, "
        "COUNT(c.id) AS conversations, "
        "COALESCE(SUM(c.channel = 'agent chat'), 0) AS chats, "
        "COALESCE(SUM(c.channel = 'voice call'), 0) AS calls "
        "FROM dataset d LEFT JOIN conversation c ON c.dataset_id = d.id "
        "GROUP BY d.id ORDER BY d.id"
    ).fetchall()
    return [dict(r) for r in rows]
