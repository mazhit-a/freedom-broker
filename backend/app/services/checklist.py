import json
import sqlite3
from pathlib import Path

from backend.app.schemas.checklist import (
    ChecklistConfig,
    ChecklistOut,
    VersionOut,
    VersionSummary,
)

SEED_PATH = Path(__file__).resolve().parents[1] / "seed" / "checklist_default.json"


class NotFound(Exception):
    pass


class NotDraft(Exception):
    pass


class DraftVersion(Exception):
    pass


class Incomplete(Exception):
    pass


def ensure_complete(config: ChecklistConfig) -> None:
    errors = config.completeness_errors()
    if errors:
        raise Incomplete("; ".join(errors))


def _derive_status(
    stored: str, version: int, version_id: int, default_id: int | None, default_version: int | None, was_active: bool = False
) -> str:
    if stored == "draft":
        return "draft"
    if version_id == default_id:
        return "active"
    if was_active:
        return "archived"
    if default_version is not None and version < default_version:
        return "archived"
    return "saved"


def _default_version_number(conn: sqlite3.Connection, default_id: int | None) -> int | None:
    if default_id is None:
        return None
    row = conn.execute("SELECT version FROM checklist_version WHERE id = ?", (default_id,)).fetchone()
    return row["version"] if row else None


def _version_out(row: sqlite3.Row, default_id: int | None, default_version: int | None = None) -> VersionOut:
    config = ChecklistConfig.model_validate_json(row["config_json"])
    return VersionOut(
        id=row["id"],
        checklist_id=row["checklist_id"],
        version=row["version"],
        created_at=row["created_at"],
        is_default=row["id"] == default_id,
        status=_derive_status(row["status"], row["version"], row["id"], default_id, default_version, bool(row["was_active"])),
        config=config,
        warnings=config.warnings(),
    )


def _default_id(conn: sqlite3.Connection, checklist_id: int) -> int | None:
    row = conn.execute("SELECT default_version_id FROM checklist WHERE id = ?", (checklist_id,)).fetchone()
    if row is None:
        raise NotFound(f"checklist {checklist_id} not found")
    return row["default_version_id"]


def create_checklist(
    conn: sqlite3.Connection, config: ChecklistConfig, status: str = "saved", channels: list[str] | None = None
) -> VersionOut:
    if status != "draft":
        ensure_complete(config)
    cur = conn.execute(
        "INSERT INTO checklist(name, channels) VALUES (?, ?)",
        (config.name, json.dumps(_clean_channels(channels or []), ensure_ascii=False)),
    )
    checklist_id = cur.lastrowid
    version = add_version(conn, checklist_id, config, status)
    if status != "draft":
        set_default(conn, checklist_id, version.id)
    return get_version(conn, version.id)


def _clean_channels(channels: list[str]) -> list[str]:
    cleaned: list[str] = []
    for ch in channels:
        ch = ch.strip()
        if ch and ch.lower() not in [c.lower() for c in cleaned]:
            cleaned.append(ch)
    return cleaned


def add_version(
    conn: sqlite3.Connection, checklist_id: int, config: ChecklistConfig, status: str = "saved"
) -> VersionOut:
    _default_id(conn, checklist_id)
    if status != "draft":
        ensure_complete(config)
    row = conn.execute(
        "SELECT COALESCE(MAX(version), 0) + 1 AS n FROM checklist_version WHERE checklist_id = ?",
        (checklist_id,),
    ).fetchone()
    cur = conn.execute(
        "INSERT INTO checklist_version(checklist_id, version, config_json, status) VALUES (?, ?, ?, ?)",
        (checklist_id, row["n"], config.model_dump_json(), status),
    )
    conn.commit()
    return get_version(conn, cur.lastrowid)


def get_version(conn: sqlite3.Connection, version_id: int) -> VersionOut:
    row = conn.execute("SELECT * FROM checklist_version WHERE id = ?", (version_id,)).fetchone()
    if row is None:
        raise NotFound(f"checklist version {version_id} not found")
    default_id = _default_id(conn, row["checklist_id"])
    return _version_out(row, default_id, _default_version_number(conn, default_id))


def _draft_row(conn: sqlite3.Connection, version_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM checklist_version WHERE id = ?", (version_id,)).fetchone()
    if row is None:
        raise NotFound(f"checklist version {version_id} not found")
    if row["status"] != "draft":
        raise NotDraft(f"checklist version {version_id} is saved and immutable")
    return row


def update_draft(conn: sqlite3.Connection, version_id: int, config: ChecklistConfig) -> VersionOut:
    _draft_row(conn, version_id)
    conn.execute(
        "UPDATE checklist_version SET config_json = ? WHERE id = ?", (config.model_dump_json(), version_id)
    )
    conn.commit()
    return get_version(conn, version_id)


def delete_draft(conn: sqlite3.Connection, version_id: int) -> None:
    row = _draft_row(conn, version_id)
    conn.execute("DELETE FROM checklist_version WHERE id = ?", (version_id,))
    left = conn.execute(
        "SELECT COUNT(*) AS n FROM checklist_version WHERE checklist_id = ?", (row["checklist_id"],)
    ).fetchone()["n"]
    if left == 0:
        conn.execute("DELETE FROM checklist WHERE id = ?", (row["checklist_id"],))
    conn.commit()


def save_draft(conn: sqlite3.Connection, version_id: int) -> VersionOut:
    row = _draft_row(conn, version_id)
    ensure_complete(ChecklistConfig.model_validate_json(row["config_json"]))
    conn.execute("UPDATE checklist_version SET status = 'saved' WHERE id = ?", (version_id,))
    conn.commit()
    return get_version(conn, version_id)


def set_channels(conn: sqlite3.Connection, checklist_id: int, channels: list[str]) -> ChecklistOut:
    _default_id(conn, checklist_id)
    cleaned = _clean_channels(channels)
    conn.execute("UPDATE checklist SET channels = ? WHERE id = ?", (json.dumps(cleaned, ensure_ascii=False), checklist_id))
    conn.commit()
    return get_checklist(conn, checklist_id)


def resolve_version_id(conn: sqlite3.Connection, explicit: int | None, channel: str | None = None) -> int | None:
    if explicit:
        return explicit
    rows = conn.execute(
        "SELECT default_version_id, channels FROM checklist WHERE default_version_id IS NOT NULL ORDER BY id"
    ).fetchall()
    if channel:
        wanted = channel.strip().lower()
        for r in rows:
            if wanted in [c.strip().lower() for c in json.loads(r["channels"] or "[]")]:
                return r["default_version_id"]
    for r in rows:
        if not json.loads(r["channels"] or "[]"):
            return r["default_version_id"]
    return rows[0]["default_version_id"] if rows else None


def is_draft(conn: sqlite3.Connection, version_id: int) -> bool:
    row = conn.execute("SELECT status FROM checklist_version WHERE id = ?", (version_id,)).fetchone()
    return row is not None and row["status"] == "draft"


def set_default(conn: sqlite3.Connection, checklist_id: int, version_id: int) -> VersionOut:
    row = conn.execute(
        "SELECT id, status FROM checklist_version WHERE id = ? AND checklist_id = ?", (version_id, checklist_id)
    ).fetchone()
    if row is None:
        raise NotFound(f"version {version_id} not found in checklist {checklist_id}")
    if row["status"] == "draft":
        raise DraftVersion(f"version {version_id} is a draft and cannot be made default")
    previous = _default_id(conn, checklist_id)
    if previous is not None and previous != version_id:
        conn.execute("UPDATE checklist_version SET was_active = 1 WHERE id = ?", (previous,))
    conn.execute("UPDATE checklist_version SET was_active = 0 WHERE id = ?", (version_id,))
    conn.execute("UPDATE checklist SET default_version_id = ? WHERE id = ?", (version_id, checklist_id))
    conn.commit()
    return get_version(conn, version_id)


def list_checklists(conn: sqlite3.Connection) -> list[ChecklistOut]:
    out = []
    for c in conn.execute("SELECT * FROM checklist ORDER BY id").fetchall():
        out.append(get_checklist(conn, c["id"]))
    return out


def get_checklist(conn: sqlite3.Connection, checklist_id: int) -> ChecklistOut:
    c = conn.execute("SELECT * FROM checklist WHERE id = ?", (checklist_id,)).fetchone()
    if c is None:
        raise NotFound(f"checklist {checklist_id} not found")
    default_version = _default_version_number(conn, c["default_version_id"])
    versions = []
    for v in conn.execute(
        "SELECT * FROM checklist_version WHERE checklist_id = ? ORDER BY version", (checklist_id,)
    ).fetchall():
        cfg = ChecklistConfig.model_validate_json(v["config_json"])
        applied = conn.execute(
            "SELECT COUNT(DISTINCT conversation_id) AS n, MIN(created_at) AS first FROM evaluation "
            "WHERE checklist_version_id = ? AND status != 'failed'",
            (v["id"],),
        ).fetchone()
        versions.append(
            VersionSummary(
                id=v["id"],
                version=v["version"],
                created_at=v["created_at"],
                is_default=v["id"] == c["default_version_id"],
                criteria_count=len(cfg.criteria),
                weight_sum=cfg.weight_sum(),
                status=_derive_status(
                    v["status"], v["version"], v["id"], c["default_version_id"], default_version, bool(v["was_active"])
                ),
                applied_count=applied["n"] or 0,
                first_applied_at=applied["first"],
            )
        )
    return ChecklistOut(
        id=c["id"],
        name=c["name"],
        default_version_id=c["default_version_id"],
        channels=json.loads(c["channels"] or "[]"),
        versions=versions,
    )


def load_seed_config() -> ChecklistConfig:
    return ChecklistConfig.model_validate(json.loads(SEED_PATH.read_text(encoding="utf-8")))


def seed_default(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) AS n FROM checklist").fetchone()["n"]
    if count == 0:
        create_checklist(conn, load_seed_config())
