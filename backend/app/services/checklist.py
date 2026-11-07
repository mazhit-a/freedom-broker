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


def _version_out(row: sqlite3.Row, default_id: int | None) -> VersionOut:
    config = ChecklistConfig.model_validate_json(row["config_json"])
    return VersionOut(
        id=row["id"],
        checklist_id=row["checklist_id"],
        version=row["version"],
        created_at=row["created_at"],
        is_default=row["id"] == default_id,
        config=config,
        warnings=config.warnings(),
    )


def _default_id(conn: sqlite3.Connection, checklist_id: int) -> int | None:
    row = conn.execute("SELECT default_version_id FROM checklist WHERE id = ?", (checklist_id,)).fetchone()
    if row is None:
        raise NotFound(f"checklist {checklist_id} not found")
    return row["default_version_id"]


def create_checklist(conn: sqlite3.Connection, config: ChecklistConfig) -> VersionOut:
    cur = conn.execute("INSERT INTO checklist(name) VALUES (?)", (config.name,))
    checklist_id = cur.lastrowid
    version = add_version(conn, checklist_id, config)
    set_default(conn, checklist_id, version.id)
    return get_version(conn, version.id)


def add_version(conn: sqlite3.Connection, checklist_id: int, config: ChecklistConfig) -> VersionOut:
    _default_id(conn, checklist_id)
    row = conn.execute(
        "SELECT COALESCE(MAX(version), 0) + 1 AS n FROM checklist_version WHERE checklist_id = ?",
        (checklist_id,),
    ).fetchone()
    cur = conn.execute(
        "INSERT INTO checklist_version(checklist_id, version, config_json) VALUES (?, ?, ?)",
        (checklist_id, row["n"], config.model_dump_json()),
    )
    conn.commit()
    return get_version(conn, cur.lastrowid)


def get_version(conn: sqlite3.Connection, version_id: int) -> VersionOut:
    row = conn.execute("SELECT * FROM checklist_version WHERE id = ?", (version_id,)).fetchone()
    if row is None:
        raise NotFound(f"checklist version {version_id} not found")
    return _version_out(row, _default_id(conn, row["checklist_id"]))


def set_default(conn: sqlite3.Connection, checklist_id: int, version_id: int) -> VersionOut:
    row = conn.execute(
        "SELECT id FROM checklist_version WHERE id = ? AND checklist_id = ?", (version_id, checklist_id)
    ).fetchone()
    if row is None:
        raise NotFound(f"version {version_id} not found in checklist {checklist_id}")
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
    versions = []
    for v in conn.execute(
        "SELECT * FROM checklist_version WHERE checklist_id = ? ORDER BY version", (checklist_id,)
    ).fetchall():
        cfg = ChecklistConfig.model_validate_json(v["config_json"])
        versions.append(
            VersionSummary(
                id=v["id"],
                version=v["version"],
                created_at=v["created_at"],
                is_default=v["id"] == c["default_version_id"],
                criteria_count=len(cfg.criteria),
                weight_sum=cfg.weight_sum(),
            )
        )
    return ChecklistOut(
        id=c["id"], name=c["name"], default_version_id=c["default_version_id"], versions=versions
    )


def load_seed_config() -> ChecklistConfig:
    return ChecklistConfig.model_validate(json.loads(SEED_PATH.read_text(encoding="utf-8")))


def seed_default(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) AS n FROM checklist").fetchone()["n"]
    if count == 0:
        create_checklist(conn, load_seed_config())
