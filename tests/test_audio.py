import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app.api.v1 import audio
from backend.app.core import config

MEDIA = "https://media.example.test/api/filedownload/x.mp3?st=1&se=2&sig=abc"
PAGE = '<html><audio controls><source src="https://media.example.test/api/filedownload/x.mp3?st=1&amp;se=2&amp;sig=abc" type="audio/mpeg"></audio></html>'
BYTES = bytes(range(256)) * 8
calls = []


def handler(request: httpx.Request) -> httpx.Response:
    calls.append(request)
    if request.url.host == "player.example.test":
        if request.url.path == "/broken":
            return httpx.Response(200, text="<html>no audio</html>")
        if request.url.path == "/down":
            return httpx.Response(500)
        return httpx.Response(200, text=PAGE, headers={"content-type": "text/html"})
    rng = request.headers.get("range")
    if rng:
        start, end = rng.replace("bytes=", "").split("-")
        start, end = int(start), int(end)
        part = BYTES[start : end + 1]
        return httpx.Response(
            206, content=part,
            headers={"content-type": "audio/mpeg", "content-range": f"bytes {start}-{end}/{len(BYTES)}"},
        )
    return httpx.Response(200, content=BYTES, headers={"content-type": "audio/mpeg"})


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "t.db"))
    config.get_settings.cache_clear()
    monkeypatch.setattr(audio, "make_client", lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True))
    calls.clear()
    from backend.app.core.database import connect
    from backend.app.main import app

    with TestClient(app) as c:
        conn = connect()
        ds = conn.execute("INSERT INTO dataset (group_id) VALUES ('A')").lastrowid
        conn.execute("INSERT INTO conversation (dataset_id, conversation_id, channel, audio_url) VALUES (?,?,?,?)", (ds, "call", "voice call", "https://player.example.test/play"))
        conn.execute("INSERT INTO conversation (dataset_id, conversation_id, channel) VALUES (?,?,?)", (ds, "chat", "agent chat"))
        conn.execute("INSERT INTO conversation (dataset_id, conversation_id, channel, audio_url) VALUES (?,?,?,?)", (ds, "nomedia", "voice call", "https://player.example.test/broken"))
        conn.execute("INSERT INTO conversation (dataset_id, conversation_id, channel, audio_url) VALUES (?,?,?,?)", (ds, "down", "voice call", "https://player.example.test/down"))
        conn.commit()
        conn.close()
        yield c
    config.get_settings.cache_clear()


def pk(client, cid):
    return next(c["id"] for c in client.get("/api/v1/conversations").json() if c["conversation_id"] == cid)


def test_redirects_to_fresh_media_url(client):
    r = client.get(f"/api/v1/conversations/{pk(client, 'call')}/audio", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == MEDIA
    assert r.headers["cache-control"] == "no-store"


def test_resolves_fresh_on_every_request(client):
    p = pk(client, "call")
    client.get(f"/api/v1/conversations/{p}/audio", follow_redirects=False)
    client.get(f"/api/v1/conversations/{p}/audio", follow_redirects=False)
    assert len([c for c in calls if c.url.host == "player.example.test"]) == 2


def test_proxy_full_and_range(client):
    p = pk(client, "call")
    full = client.get(f"/api/v1/conversations/{p}/audio?mode=proxy")
    assert full.status_code == 200
    assert full.content == BYTES
    assert full.headers["content-type"] == "audio/mpeg"
    part = client.get(f"/api/v1/conversations/{p}/audio?mode=proxy", headers={"Range": "bytes=10-19"})
    assert part.status_code == 206
    assert part.content == BYTES[10:20]
    assert part.headers["content-range"] == f"bytes 10-19/{len(BYTES)}"
    assert calls[-1].headers["range"] == "bytes=10-19"


def test_missing_cases(client):
    assert client.get("/api/v1/conversations/9999/audio").status_code == 404
    assert client.get(f"/api/v1/conversations/{pk(client, 'chat')}/audio").status_code == 404


def test_upstream_failures_are_502(client):
    assert client.get(f"/api/v1/conversations/{pk(client, 'nomedia')}/audio", follow_redirects=False).status_code == 502
    assert client.get(f"/api/v1/conversations/{pk(client, 'down')}/audio", follow_redirects=False).status_code == 502
