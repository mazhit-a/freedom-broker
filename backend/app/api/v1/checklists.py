import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException

from backend.app.core.database import get_db
from backend.app.schemas.checklist import ChannelsIn, ChecklistConfig, ChecklistOut, DefaultIn, VersionOut
from backend.app.services import checklist as svc

router = APIRouter(tags=["checklists"])


@router.get("/checklists", response_model=list[ChecklistOut])
def list_checklists(conn: sqlite3.Connection = Depends(get_db)):
    return svc.list_checklists(conn)


@router.post("/checklists", response_model=VersionOut, status_code=201)
def create_checklist(config: ChecklistConfig, conn: sqlite3.Connection = Depends(get_db)):
    return svc.create_checklist(conn, config)


@router.get("/checklists/{checklist_id}", response_model=ChecklistOut)
def get_checklist(checklist_id: int, conn: sqlite3.Connection = Depends(get_db)):
    try:
        return svc.get_checklist(conn, checklist_id)
    except svc.NotFound as e:
        raise HTTPException(404, str(e))


@router.post("/checklists/{checklist_id}/versions", response_model=VersionOut, status_code=201)
def create_version(
    checklist_id: int,
    config: ChecklistConfig,
    status: Literal["draft", "saved"] = "saved",
    conn: sqlite3.Connection = Depends(get_db),
):
    try:
        return svc.add_version(conn, checklist_id, config, status)
    except svc.NotFound as e:
        raise HTTPException(404, str(e))


@router.get("/checklist-versions/{version_id}", response_model=VersionOut)
def get_version(version_id: int, conn: sqlite3.Connection = Depends(get_db)):
    try:
        return svc.get_version(conn, version_id)
    except svc.NotFound as e:
        raise HTTPException(404, str(e))


@router.put("/checklist-versions/{version_id}", response_model=VersionOut)
def update_draft(version_id: int, config: ChecklistConfig, conn: sqlite3.Connection = Depends(get_db)):
    try:
        return svc.update_draft(conn, version_id, config)
    except svc.NotFound as e:
        raise HTTPException(404, str(e))
    except svc.NotDraft as e:
        raise HTTPException(409, str(e))


@router.post("/checklist-versions/{version_id}/save", response_model=VersionOut)
def save_draft(version_id: int, conn: sqlite3.Connection = Depends(get_db)):
    try:
        return svc.save_draft(conn, version_id)
    except svc.NotFound as e:
        raise HTTPException(404, str(e))
    except svc.NotDraft as e:
        raise HTTPException(409, str(e))


@router.put("/checklists/{checklist_id}/channels", response_model=ChecklistOut)
def set_channels(checklist_id: int, body: ChannelsIn, conn: sqlite3.Connection = Depends(get_db)):
    try:
        return svc.set_channels(conn, checklist_id, body.channels)
    except svc.NotFound as e:
        raise HTTPException(404, str(e))


@router.put("/checklists/{checklist_id}/default", response_model=VersionOut)
def set_default(checklist_id: int, body: DefaultIn, conn: sqlite3.Connection = Depends(get_db)):
    try:
        return svc.set_default(conn, checklist_id, body.version_id)
    except svc.NotFound as e:
        raise HTTPException(404, str(e))
    except svc.DraftVersion as e:
        raise HTTPException(422, str(e))
