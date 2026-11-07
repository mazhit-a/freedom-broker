import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect
from backend.app.main import app
from backend.app.services.evaluator import evaluate_conversation
from tests.test_evaluator import add_conversation, fixed_good, make_client, payload, version_id

API = "/api/v1"
SECRET = "https://player.example.test/play?token=SECRETTOKEN&sig=zzz"


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "s.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    with TestClient(app) as c:
        conn = connect(path)
        pk = add_conversation(conn, cid="call-1", channel="voice call")
        conn.execute("UPDATE conversation SET audio_url = ? WHERE id = ?", (SECRET, pk))
        conn.commit()
        llm, _ = make_client([payload(fixed_good())])
        eid = evaluate_conversation(conn, pk, version_id(conn), llm)["id"]
        conn.close()
        yield c, pk, eid
    config.get_settings.cache_clear()


def assert_clean(response):
    assert response.status_code == 200
    assert "audio_url" not in response.text
    assert "SECRETTOKEN" not in response.text
    assert "sig=" not in response.text
    assert "player.example.test" not in response.text


def test_no_endpoint_leaks_audio_url(env):
    c, pk, eid = env
    for url in (
        f"{API}/conversations",
        f"{API}/conversations?envelope=true",
        f"{API}/conversations/{pk}",
        f"{API}/conversations/by-key/call-1",
        f"{API}/conversations/{pk}/evaluation",
        f"{API}/conversations/{pk}/evaluations",
        f"{API}/evaluations/{eid}",
    ):
        assert_clean(c.get(url))


def test_detail_has_audio_and_meta(env):
    c, pk, _ = env
    for body in (c.get(f"{API}/conversations/{pk}").json(), c.get(f"{API}/conversations/by-key/call-1").json()):
        assert body["has_audio"] is True
        assert "occurred_at" in body and "duration_seconds" in body
        assert body["duration_seconds"] is not None and body["duration_seconds"] > 0
    assert c.get(f"{API}/conversations").json()[0]["has_audio"] is True
