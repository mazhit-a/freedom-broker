import sqlite3
from pathlib import Path

from backend.app.core.config import get_settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS dataset (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT NOT NULL DEFAULT 'api'
);
CREATE TABLE IF NOT EXISTS conversation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id INTEGER NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    channel TEXT,
    language TEXT,
    audio_url TEXT,
    raw_json TEXT,
    UNIQUE (dataset_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    message_index INTEGER NOT NULL,
    timestamp_raw TEXT,
    offset_seconds REAL,
    speaker TEXT,
    text TEXT,
    UNIQUE (conversation_id, message_index)
);
CREATE TABLE IF NOT EXISTS checklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    default_version_id INTEGER,
    channels TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS checklist_version (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checklist_id INTEGER NOT NULL REFERENCES checklist(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    config_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'saved',
    UNIQUE (checklist_id, version)
);
CREATE TABLE IF NOT EXISTS evaluation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    checklist_version_id INTEGER NOT NULL REFERENCES checklist_version(id),
    model TEXT,
    prompt_version TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    total REAL,
    total_status TEXT,
    provisional INTEGER NOT NULL DEFAULT 0,
    gross_violation INTEGER NOT NULL DEFAULT 0,
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_cache_read INTEGER,
    tokens_cache_write INTEGER,
    latency_ms INTEGER,
    cost REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_output TEXT
);
CREATE TABLE IF NOT EXISTS criterion_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id INTEGER NOT NULL REFERENCES evaluation(id) ON DELETE CASCADE,
    criterion_id TEXT NOT NULL,
    answer TEXT,
    points REAL,
    effective_points REAL,
    rationale TEXT,
    evidence_json TEXT,
    checked_range TEXT,
    na_reason TEXT,
    needs_review INTEGER NOT NULL DEFAULT 0,
    UNIQUE (evaluation_id, criterion_id)
);
CREATE TABLE IF NOT EXISTS appeal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id INTEGER NOT NULL REFERENCES evaluation(id) ON DELETE CASCADE,
    criterion_id TEXT NOT NULL,
    comment TEXT,
    author_role TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS review_decision (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appeal_id INTEGER NOT NULL UNIQUE REFERENCES appeal(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('confirm', 'change')),
    new_answer TEXT,
    reason TEXT NOT NULL,
    decided_by_role TEXT,
    decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def connect(path: str | None = None) -> sqlite3.Connection:
    db_path = path or get_settings().cqa_db_path
    if db_path != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


ADDITIVE_COLUMNS = [
    ("checklist", "channels", "TEXT NOT NULL DEFAULT '[]'"),
    ("checklist_version", "status", "TEXT NOT NULL DEFAULT 'saved'"),
]


def _add_missing_columns(conn: sqlite3.Connection) -> None:
    for table, column, ddl in ADDITIVE_COLUMNS:
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def _add_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def init_db(path: str | None = None) -> None:
    conn = connect(path)
    try:
        conn.executescript(SCHEMA)
        _add_column(conn, "appeal", "author_role", "TEXT")
        _add_column(conn, "review_decision", "decided_by_role", "TEXT")
        _add_missing_columns(conn)
        conn.commit()
    finally:
        conn.close()


def get_db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()
