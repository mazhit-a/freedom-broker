from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from backend.app.core.database import get_db

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("")
def list_conversations(
    dataset: Optional[str] = None,
    language: Optional[str] = None,
    channel: Optional[str] = None,
    conn=Depends(get_db),
):
    sql = (
        "SELECT c.id, c.dataset_id, d.group_id, c.conversation_id, c.channel, c.language, "
        "c.audio_url IS NOT NULL AS has_audio, "
        "(SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) AS message_count "
        "FROM conversation c JOIN dataset d ON d.id = c.dataset_id WHERE 1=1"
    )
    args: list = []
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
    sql += " ORDER BY c.dataset_id, c.id"
    rows = conn.execute(sql, args).fetchall()
    return [{**dict(r), "has_audio": bool(r["has_audio"])} for r in rows]


@router.get("/{conversation_pk}")
def get_conversation(conversation_pk: int, conn=Depends(get_db)):
    row = conn.execute(
        "SELECT c.id, c.dataset_id, d.group_id, c.conversation_id, c.channel, c.language, c.audio_url "
        "FROM conversation c JOIN dataset d ON d.id = c.dataset_id WHERE c.id = ?",
        (conversation_pk,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Conversation not found")
    messages = conn.execute(
        "SELECT message_index, timestamp_raw, offset_seconds, speaker, text FROM message "
        "WHERE conversation_id = ? ORDER BY message_index",
        (conversation_pk,),
    ).fetchall()
    return {**dict(row), "messages": [dict(m) for m in messages]}
