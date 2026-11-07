import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.services import importer

FIXTURE = Path(__file__).parent / "fixtures" / "sample_dataset.json"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CQA_DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("CQA_API_URL", "https://example.invalid/run?api-version=1&token=x")
    config.get_settings.cache_clear()
    from backend.app.main import app

    with TestClient(app) as c:
        yield c
    config.get_settings.cache_clear()


def upload(client, payload, group_id=None):
    data = {"group_id": group_id} if group_id else {}
    return client.post(
        "/api/v1/datasets/import-file",
        files={"file": ("d.json", json.dumps(payload).encode("utf-8"), "application/json")},
        data=data,
    )


def fixture_payload():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def by_cid(client, group, cid):
    rows = client.get("/api/v1/conversations", params={"dataset": group}).json()
    pk = next(r["id"] for r in rows if r["conversation_id"] == cid)
    return client.get(f"/api/v1/conversations/{pk}").json()


def test_import_file_and_read_back(client):
    r = upload(client, fixture_payload())
    assert r.status_code == 200
    assert r.json()["group_id"] == "FIX"
    assert r.json()["created"] == 3
    datasets = client.get("/api/v1/datasets").json()
    assert datasets[0]["conversations"] == 3 and datasets[0]["chats"] == 2 and datasets[0]["calls"] == 1
    assert len(client.get("/api/v1/conversations", params={"language": "EN"}).json()) == 1
    assert len(client.get("/api/v1/conversations", params={"channel": "voice call"}).json()) == 1
    assert len(client.get("/api/v1/conversations", params={"dataset": "FIX", "language": "ru"}).json()) == 2
    assert client.get("/api/v1/conversations/9999").status_code == 404


def test_offsets_chat_and_call(client):
    upload(client, fixture_payload())
    chat = by_cid(client, "FIX", "p1-ru-001")
    assert [m["offset_seconds"] for m in chat["messages"]] == [2, 10, 65, 750]
    assert [m["message_index"] for m in chat["messages"]] == [0, 1, 2, 3]
    assert chat["messages"][0]["timestamp_raw"] == "00:02"
    call = by_cid(client, "FIX", "p4-ru-001")
    offsets = [m["offset_seconds"] for m in call["messages"]]
    assert offsets == [0.0, 4.461, 130.0]
    assert call["messages"][0]["timestamp_raw"] == "2026-11-03T13:10:00.6388245+00:00"
    assert call["audio_url"].startswith("https://")


def test_bare_list_accepted(client):
    records = fixture_payload()["data"]["records"]
    r = upload(client, records, group_id="BARE")
    assert r.status_code == 200 and r.json()["group_id"] == "BARE"
    assert r.json()["total_conversations"] == 3


def test_reimport_does_not_duplicate(client):
    upload(client, fixture_payload())
    r = upload(client, fixture_payload())
    assert r.status_code == 200
    assert r.json()["created"] == 0 and r.json()["updated"] == 3
    assert len(client.get("/api/v1/datasets").json()) == 1
    assert len(client.get("/api/v1/conversations").json()) == 3
    chat = by_cid(client, "FIX", "p1-ru-001")
    assert len(chat["messages"]) == 4


def test_same_conversation_id_in_two_datasets(client):
    upload(client, fixture_payload())
    other = fixture_payload()
    other["data"]["dataset_group_id"] = "CTRL"
    other["data"]["records"][0]["transcript"] = [
        {"timestamp": "00:01", "speaker": "client", "text": "other"}
    ]
    upload(client, other)
    assert len(client.get("/api/v1/conversations").json()) == 6
    assert len(by_cid(client, "FIX", "p1-ru-001")["messages"]) == 4
    ctrl = by_cid(client, "CTRL", "p1-ru-001")
    assert len(ctrl["messages"]) == 1 and ctrl["messages"][0]["text"] == "other"


def test_api_error_is_readable(client, monkeypatch):
    monkeypatch.setattr(
        importer, "fetch_payload", lambda gid: {"isSuccess": False, "error": "Unknown group", "data": None}
    )
    r = client.post("/api/v1/datasets/import", json={"group_id": "NOPE"})
    assert r.status_code == 502
    assert "Unknown group" in r.json()["detail"]
    assert client.get("/api/v1/datasets").json() == []
    r = upload(client, {"isSuccess": False, "error": "Bad file", "data": None})
    assert r.status_code == 502 and "Bad file" in r.json()["detail"]


def test_import_via_api_uses_group_id(client, monkeypatch):
    seen = {}

    def fake(gid):
        seen["gid"] = gid
        return fixture_payload()

    monkeypatch.setattr(importer, "fetch_payload", fake)
    r = client.post("/api/v1/datasets/import", json={"group_id": "DEV"})
    assert r.status_code == 200 and seen["gid"] == "DEV" and r.json()["group_id"] == "DEV"


def test_build_url_appends_group_id():
    assert importer.build_url("https://h/p?a=1&sig=z", "DEV") == "https://h/p?a=1&sig=z&group_id=DEV"
    assert importer.build_url("https://h/p", "A B") == "https://h/p?group_id=A%20B"


def test_invalid_file(client):
    r = client.post(
        "/api/v1/datasets/import-file", files={"file": ("d.json", b"not json", "application/json")}
    )
    assert r.status_code == 400
