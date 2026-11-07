from typing import Optional

from fastapi import APIRouter, Depends

from backend.app.core.errors import ApiError
from backend.app.core.database import get_db
from backend.app.services.audio_timing import annotate_messages

router = APIRouter(prefix="/conversations", tags=["conversations"])

APPEAL_EXPR = (
    "CASE WHEN e.id IS NULL THEN NULL "
    "WHEN EXISTS (SELECT 1 FROM appeal ap WHERE ap.evaluation_id = e.id AND ap.status = 'open') THEN 'open' "
    "WHEN EXISTS (SELECT 1 FROM appeal ap WHERE ap.evaluation_id = e.id) THEN 'resolved' "
    "ELSE 'none' END"
)


@router.get("")
def list_conversations(
    dataset: Optional[str] = None,
    language: Optional[str] = None,
    channel: Optional[str] = None,
    status: Optional[str] = None,
    gross: Optional[bool] = None,
    min_total: Optional[float] = None,
    max_total: Optional[float] = None,
    checklist_version_id: Optional[int] = None,
    appeal_status: Optional[str] = None,
    conn=Depends(get_db),
):
    sql = (
        "SELECT c.id, c.dataset_id, d.group_id, c.conversation_id, c.channel, c.language, "
        "c.audio_url IS NOT NULL AS has_audio, "
        "(SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) AS message_count, "
        "e.id AS evaluation_id, e.checklist_version_id, cv.version AS checklist_version_number, cl.name AS checklist_name, "
        "e.status AS eval_status, e.total, e.total_status, e.provisional, e.gross_violation, "
        + APPEAL_EXPR + " AS appeal_status "
        "FROM conversation c JOIN dataset d ON d.id = c.dataset_id "
        "LEFT JOIN evaluation e ON e.id = (SELECT MAX(e2.id) FROM evaluation e2 WHERE e2.conversation_id = c.id"
        + (" AND e2.checklist_version_id = ?" if checklist_version_id else "")
        + ") "
        "LEFT JOIN checklist_version cv ON cv.id = e.checklist_version_id "
        "LEFT JOIN checklist cl ON cl.id = cv.checklist_id WHERE 1=1"
    )
    args: list = [checklist_version_id] if checklist_version_id else []
    if dataset:
        if dataset.isdigit():
            sql += " AND (c.dataset_id = ? OR d.group_id = ?)"
            args += [int(dataset), dataset]
        else:
            sql += " AND d.group_id = ?"
            args.append(dataset)
    if language:
        sql += " AND UPPER(c.language) = UPPER(?)"
        args.append(language)
    if channel:
        sql += " AND LOWER(c.channel) = LOWER(?)"
        args.append(channel)
    if status:
        if status == "none":
            sql += " AND e.id IS NULL"
        else:
            sql += " AND e.status = ?"
            args.append(status)
    if gross is not None:
        sql += " AND e.id IS NOT NULL AND e.gross_violation = ?"
        args.append(1 if gross else 0)
    if min_total is not None:
        sql += " AND e.total >= ?"
        args.append(min_total)
    if max_total is not None:
        sql += " AND e.total <= ?"
        args.append(max_total)
    if appeal_status:
        if appeal_status not in ("none", "open", "resolved"):
            raise ApiError(422, "appeal_status must be none, open or resolved", "invalid_appeal_status")
        sql += " AND " + APPEAL_EXPR + " = ?"
        args.append(appeal_status)
    sql += " ORDER BY c.dataset_id, c.id"
    rows = conn.execute(sql, args).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["has_audio"] = bool(d["has_audio"])
        d["provisional"] = bool(d["provisional"]) if d["evaluation_id"] else None
        d["gross_violation"] = bool(d["gross_violation"]) if d["evaluation_id"] else None
        d["checklist_version_label"] = (
            f"{d['checklist_name']} v{d['checklist_version_number']}" if d["evaluation_id"] else None
        )
        out.append(d)
    return out


def _conversation_body(conn, row) -> dict:
    messages = conn.execute(
        "SELECT message_index, timestamp_raw, offset_seconds, speaker, text FROM message "
        "WHERE conversation_id = ? ORDER BY message_index",
        (row["id"],),
    ).fetchall()
    return {**dict(row), "messages": annotate_messages([dict(m) for m in messages], row["channel"], row["audio_url"])}


_CONV_SELECT = (
    "SELECT c.id, c.dataset_id, d.group_id, c.conversation_id, c.channel, c.language, c.audio_url "
    "FROM conversation c JOIN dataset d ON d.id = c.dataset_id "
)


@router.get("/by-key/{conversation_id}")
def get_conversation_by_key(conversation_id: str, dataset: Optional[str] = None, conn=Depends(get_db)):
    sql = _CONV_SELECT + "WHERE c.conversation_id = ?"
    args: list = [conversation_id]
    if dataset:
        if dataset.isdigit():
            sql += " AND (c.dataset_id = ? OR d.group_id = ?)"
            args += [int(dataset), dataset]
        else:
            sql += " AND d.group_id = ?"
            args.append(dataset)
    rows = conn.execute(sql + " ORDER BY c.dataset_id DESC, c.id DESC", args).fetchall()
    if not rows:
        raise ApiError(404, "Conversation not found", "conversation_not_found")
    return _conversation_body(conn, rows[0])


@router.get("/{conversation_pk}")
def get_conversation(conversation_pk: int, conn=Depends(get_db)):
    row = conn.execute(_CONV_SELECT + "WHERE c.id = ?", (conversation_pk,)).fetchone()
    if not row:
        raise ApiError(404, "Conversation not found", "conversation_not_found")
    return _conversation_body(conn, row)
