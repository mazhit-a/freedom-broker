import os
import tempfile

import pytest

SESSION_DB = os.path.join(tempfile.mkdtemp(prefix="cqa-tests-"), "session.db")
os.environ["CQA_DB_PATH"] = SESSION_DB

from backend.app.core import config


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "isolated.db"))
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_MODEL", "claude-opus-5-5")
    monkeypatch.setenv("LLM_LABEL", "")
    monkeypatch.setenv("LLM_PROMPT_VERSION", "v1")
    monkeypatch.setenv("CQA_BATCH_CONCURRENCY", "4")
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()
