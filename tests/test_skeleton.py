import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import init_db


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    path = str(tmp_path / "t.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    yield path
    config.get_settings.cache_clear()


def test_health_and_tables_created_on_startup(db_path):
    from backend.app.main import app

    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/app/").status_code == 200
    conn = sqlite3.connect(db_path)
    names = {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}
    expected = {
        "dataset", "conversation", "message", "checklist", "checklist_version",
        "evaluation", "criterion_result", "appeal", "review_decision",
    }
    assert expected <= names


def test_same_conversation_id_in_two_datasets(db_path):
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("insert into dataset(group_id) values ('a')")
    conn.execute("insert into dataset(group_id) values ('b')")
    for ds in (1, 2):
        conn.execute("insert into conversation(dataset_id, conversation_id) values (?, 'p1-ru-001')", (ds,))
    assert conn.execute("select count(*) from conversation").fetchone()[0] == 2
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("insert into conversation(dataset_id, conversation_id) values (1, 'p1-ru-001')")


def test_evaluation_columns(db_path):
    init_db(db_path)
    conn = sqlite3.connect(db_path)
    cols = {r[1] for r in conn.execute("pragma table_info(evaluation)")}
    assert {"prompt_version", "tokens_input", "tokens_cache_read", "latency_ms", "cost", "provisional"} <= cols
    cols = {r[1] for r in conn.execute("pragma table_info(criterion_result)")}
    assert "needs_review" in cols
