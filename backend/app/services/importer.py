import json
import re
import sqlite3
from datetime import datetime
from urllib.parse import quote, urlsplit

import httpx

from backend.app.core.config import get_settings


class ImportError_(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


MMSS = re.compile(r"^\s*(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.(\d+))?\s*$")


def _parse_iso(value: str) -> datetime | None:
    text = value.strip().replace("Z", "+00:00")
    text = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"), text, count=1)
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def parse_timestamp(raw) -> tuple[str | None, float | None, datetime | None]:
    if raw is None:
        return None, None, None
    text = str(raw)
    match = MMSS.match(text)
    if match:
        hours, minutes, seconds, frac = match.groups()
        value = int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds)
        if frac:
            value += float("0." + frac)
        return text, float(value), None
    parsed = _parse_iso(text)
    if parsed is not None:
        return text, None, parsed
    return text, None, None


def compute_offsets(timestamps: list) -> list[float | None]:
    parsed = [parse_timestamp(t) for t in timestamps]
    absolute = [p[2] for p in parsed if p[2] is not None]
    origin = None
    if absolute:
        aware = [a for a in absolute if a.tzinfo is not None]
        origin = min(aware) if aware else min(absolute)
    result: list[float | None] = []
    for _, seconds, moment in parsed:
        if seconds is not None:
            result.append(seconds)
        elif moment is not None and origin is not None and (moment.tzinfo is None) == (origin.tzinfo is None):
            result.append(round(max((moment - origin).total_seconds(), 0.0), 3))
        else:
            result.append(None)
    return result


def parse_payload(payload) -> tuple[str | None, list[dict]]:
    if isinstance(payload, list):
        return None, payload
    if not isinstance(payload, dict):
        raise ImportError_("Unexpected payload: expected a JSON object or a list of records")
    if "isSuccess" in payload and not payload.get("isSuccess"):
        message = payload.get("error") or "The data source reported a failure without a message"
        raise ImportError_(f"Data source error: {message}", 502)
    data = payload.get("data") if "data" in payload else payload
    if isinstance(data, list):
        return None, data
    if isinstance(data, dict) and isinstance(data.get("records"), list):
        return data.get("dataset_group_id"), data["records"]
    raise ImportError_("Payload has no records list")


def build_url(base: str, group_id: str) -> str:
    separator = "&" if urlsplit(base).query else "?"
    return f"{base}{separator}group_id={quote(group_id, safe='')}"


def fetch_payload(group_id: str):
    base = get_settings().cqa_api_url
    if not base:
        raise ImportError_("CQA_API_URL is not configured", 500)
    try:
        response = httpx.get(build_url(base, group_id), timeout=60)
    except httpx.HTTPError as exc:
        raise ImportError_(f"Could not reach the data source: {type(exc).__name__}", 502)
    try:
        body = response.json()
    except ValueError:
        body = None
    if response.status_code >= 400 and not (isinstance(body, dict) and "isSuccess" in body):
        raise ImportError_(f"Data source returned HTTP {response.status_code}", 502)
    if body is None:
        raise ImportError_("Data source returned a non-JSON response", 502)
    return body


def store_records(conn: sqlite3.Connection, group_id: str, records: list[dict], source: str) -> dict:
    for index, record in enumerate(records):
        if not isinstance(record, dict) or not record.get("conversation_id"):
            raise ImportError_(f"Record {index} has no conversation_id")
    row = conn.execute("SELECT id FROM dataset WHERE group_id = ?", (group_id,)).fetchone()
    if row:
        dataset_id = row["id"]
        conn.execute(
            "UPDATE dataset SET imported_at = CURRENT_TIMESTAMP, source = ? WHERE id = ?",
            (source, dataset_id),
        )
    else:
        dataset_id = conn.execute(
            "INSERT INTO dataset(group_id, source) VALUES (?, ?)", (group_id, source)
        ).lastrowid
    created = updated = 0
    for record in records:
        cid = str(record["conversation_id"])
        transcript = record.get("transcript") or []
        existing = conn.execute(
            "SELECT id FROM conversation WHERE dataset_id = ? AND conversation_id = ?",
            (dataset_id, cid),
        ).fetchone()
        values = (
            record.get("channel"),
            record.get("language"),
            record.get("audio_url"),
            json.dumps(record, ensure_ascii=False),
        )
        if existing:
            conv_pk = existing["id"]
            conn.execute(
                "UPDATE conversation SET channel = ?, language = ?, audio_url = ?, raw_json = ? WHERE id = ?",
                (*values, conv_pk),
            )
            conn.execute("DELETE FROM message WHERE conversation_id = ?", (conv_pk,))
            updated += 1
        else:
            conv_pk = conn.execute(
                "INSERT INTO conversation(dataset_id, conversation_id, channel, language, audio_url, raw_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (dataset_id, cid, *values),
            ).lastrowid
            created += 1
        offsets = compute_offsets([m.get("timestamp") for m in transcript])
        for idx, message in enumerate(transcript):
            raw = message.get("timestamp")
            conn.execute(
                "INSERT INTO message(conversation_id, message_index, timestamp_raw, offset_seconds, speaker, text) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (conv_pk, idx, None if raw is None else str(raw), offsets[idx], message.get("speaker"), message.get("text")),
            )
    conn.commit()
    total = conn.execute(
        "SELECT COUNT(*) FROM conversation WHERE dataset_id = ?", (dataset_id,)
    ).fetchone()[0]
    return {
        "dataset_id": dataset_id,
        "group_id": group_id,
        "source": source,
        "created": created,
        "updated": updated,
        "total_conversations": total,
    }


def import_from_api(conn: sqlite3.Connection, group_id: str) -> dict:
    payload = fetch_payload(group_id)
    reported, records = parse_payload(payload)
    return store_records(conn, group_id, records, "api")


def import_from_file(conn: sqlite3.Connection, content: bytes, group_id: str | None) -> dict:
    try:
        payload = json.loads(content.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        raise ImportError_("Uploaded file is not valid JSON")
    reported, records = parse_payload(payload)
    final_group = group_id or reported or "file"
    return store_records(conn, final_group, records, "file")
