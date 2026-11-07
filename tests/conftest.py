import pytest

from backend.app.core import config


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "isolated.db"))
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()
