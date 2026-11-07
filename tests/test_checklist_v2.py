import copy
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services.checklist import SEED_PATH

API = "/api/v1"


@pytest.fixture
def client(tmp_path, monkeypatch):
    path = str(tmp_path / "v2.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    from backend.app.main import app

    with TestClient(app) as c:
        c.db_path = path
        yield c
    config.get_settings.cache_clear()


def seed_cfg():
    return json.loads(SEED_PATH.read_text(encoding="utf-8"))


def first_checklist(client):
    return client.get(f"{API}/checklists").json()[0]


def add_conversation(client, channel, group="g"):
    conn = connect(client.db_path)
    ds = conn.execute("INSERT INTO dataset (group_id) VALUES (?)", (group,)).lastrowid
    pk = conn.execute(
        "INSERT INTO conversation (dataset_id, conversation_id, channel, language) VALUES (?,?,?,?)",
        (ds, f"{group}-1", channel, "RU"),
    ).lastrowid
    conn.commit()
    conn.close()
    return pk


def test_listing_has_status_and_counts_and_no_label(client):
    cl = first_checklist(client)
    v = cl["versions"][0]
    assert v["version"] == 1 and v["status"] == "active"
    assert v["applied_count"] == 0 and v["first_applied_at"] is None
    assert "label" not in v
    assert cl["channels"] == []


def test_status_derivation_saved_active_archived(client):
    cl = first_checklist(client)
    cfg = seed_cfg()
    v2 = client.post(f"{API}/checklists/{cl['id']}/versions", json=cfg).json()
    assert v2["status"] == "saved"
    client.put(f"{API}/checklists/{cl['id']}/default", json={"version_id": v2["id"]})
    statuses = {v["version"]: v["status"] for v in first_checklist(client)["versions"]}
    assert statuses == {1: "archived", 2: "active"}


def test_applied_count_and_first_applied(client):
    cl = first_checklist(client)
    vid = cl["default_version_id"]
    conn = connect(client.db_path)
    ds = conn.execute("INSERT INTO dataset (group_id) VALUES ('x')").lastrowid
    for i, st in enumerate(["completed", "needs_review", "failed"]):
        pk = conn.execute(
            "INSERT INTO conversation (dataset_id, conversation_id, channel) VALUES (?,?,?)", (ds, f"c{i}", "agent chat")
        ).lastrowid
        conn.execute(
            "INSERT INTO evaluation (conversation_id, checklist_version_id, status, created_at) VALUES (?,?,?,?)",
            (pk, vid, st, f"2026-10-0{i + 1} 10:00:00"),
        )
    conn.commit()
    conn.close()
    v = first_checklist(client)["versions"][0]
    assert v["applied_count"] == 2
    assert v["first_applied_at"] == "2026-10-01 10:00:00"


def test_draft_lifecycle(client):
    cl = first_checklist(client)
    r = client.post(f"{API}/checklists/{cl['id']}/versions", params={"status": "draft"}, json=seed_cfg())
    assert r.status_code == 201
    d = r.json()
    assert d["status"] == "draft" and d["version"] == 2
    assert first_checklist(client)["versions"][1]["status"] == "draft"

    cfg = copy.deepcopy(d["config"])
    cfg["criteria"][0]["weight"] = 5
    r = client.put(f"{API}/checklist-versions/{d['id']}", json=cfg)
    assert r.status_code == 200 and r.json()["config"]["criteria"][0]["weight"] == 5
    assert r.json()["status"] == "draft"

    assert client.put(f"{API}/checklists/{cl['id']}/default", json={"version_id": d["id"]}).status_code == 422

    r = client.post(f"{API}/checklist-versions/{d['id']}/save")
    assert r.status_code == 200 and r.json()["status"] == "saved"
    assert client.put(f"{API}/checklist-versions/{d['id']}", json=cfg).status_code == 409
    assert client.post(f"{API}/checklist-versions/{d['id']}/save").status_code == 409


def test_put_on_saved_and_unknown_version(client):
    cl = first_checklist(client)
    assert client.put(f"{API}/checklist-versions/{cl['default_version_id']}", json=seed_cfg()).status_code == 409
    assert client.put(f"{API}/checklist-versions/9999", json=seed_cfg()).status_code == 404
    assert client.post(f"{API}/checklist-versions/9999/save").status_code == 404


def test_draft_with_weights_95_saves_with_warning(client):
    cl = first_checklist(client)
    cfg = seed_cfg()
    cfg["criteria"][0]["weight"] = 5
    r = client.post(f"{API}/checklists/{cl['id']}/versions", json=cfg)
    assert r.status_code == 201 and r.json()["warnings"]


def test_evaluate_draft_is_422(client):
    cl = first_checklist(client)
    d = client.post(f"{API}/checklists/{cl['id']}/versions", params={"status": "draft"}, json=seed_cfg()).json()
    pk = add_conversation(client, "agent chat")
    r = client.post(f"{API}/conversations/{pk}/evaluate", params={"checklist_version_id": d["id"]})
    assert r.status_code == 422
    r = client.post(f"{API}/batches", json={"dataset": "g", "checklist_version_id": d["id"]})
    assert r.status_code == 422


def test_channel_binding_selects_default(client, monkeypatch):
    from backend.app.api.v1 import evaluations

    cl = first_checklist(client)
    calls_cl = client.post(f"{API}/checklists", json={**seed_cfg(), "name": "Calls"}).json()
    r = client.put(f"{API}/checklists/{calls_cl['checklist_id']}/channels", json={"channels": ["voice call", " Voice Call "]})
    assert r.status_code == 200 and r.json()["channels"] == ["voice call"]
    assert client.put(f"{API}/checklists/999/channels", json={"channels": []}).status_code == 404

    seen = []
    monkeypatch.setattr(evaluations, "evaluate_conversation", lambda conn, pk, vid, c: seen.append(vid) or {"ok": 1})
    voice = add_conversation(client, "voice call", "gv")
    chat = add_conversation(client, "agent chat", "gc")
    assert client.post(f"{API}/conversations/{voice}/evaluate").status_code == 200
    assert client.post(f"{API}/conversations/{chat}/evaluate").status_code == 200
    assert seen == [calls_cl["id"], cl["default_version_id"]]


def test_batch_channel_default(client, monkeypatch):
    from backend.app.api.v1 import batches

    calls_cl = client.post(f"{API}/checklists", json={**seed_cfg(), "name": "Calls"}).json()
    client.put(f"{API}/checklists/{calls_cl['checklist_id']}/channels", json={"channels": ["voice call"]})
    add_conversation(client, "voice call", "gv")
    seen = []

    class Job:
        def snapshot(self):
            return {"ok": True}

    monkeypatch.setattr(batches.batch, "start_job", lambda conn, ds, vid, *a, **k: seen.append(vid) or Job())
    assert client.post(f"{API}/batches", json={"dataset": "gv"}).status_code == 202
    assert seen == [calls_cl["id"]]


def test_seed_has_russian_labels_and_scoring_fields_unchanged(client):
    cfg = seed_cfg()
    assert cfg["criteria"][0]["labels"]["ru"]["title"] == "Установление контакта"
    assert cfg["sections"][0]["labels"]["ru"]["title"] == "Начало и понимание запроса"
    assert cfg["criteria"][1]["labels"]["ru"]["na_condition"]
    stripped = copy.deepcopy(cfg)
    for c in stripped["criteria"]:
        c.pop("labels", None)
    assert [c["id"] for c in stripped["criteria"]] == [f"0{i}" for i in range(1, 9)]
    assert [c["weight"] for c in stripped["criteria"]] == [10, 15, 20, 20, 15, 15, 5, 0]
    assert sum(c["weight"] for c in stripped["criteria"]) == 100
    v = client.get(f"{API}/checklist-versions/{first_checklist(client)['default_version_id']}").json()
    assert v["config"]["criteria"][0]["labels"]["ru"]["title"] == "Установление контакта"
    assert v["config"]["criteria"][0]["title"] == "Rapport"


def test_labels_optional_and_roundtrip(client):
    cfg = seed_cfg()
    cfg["criteria"][0]["labels"] = {"kk": {"title": "Байланыс"}}
    r = client.post(f"{API}/checklists", json={**cfg, "name": "L"})
    assert r.status_code == 201
    assert r.json()["config"]["criteria"][0]["labels"]["kk"]["title"] == "Байланыс"
    assert r.json()["config"]["criteria"][1]["labels"]["ru"]["title"]


def test_init_db_migrates_old_database_idempotently(tmp_path):
    path = str(tmp_path / "old.db")
    raw = sqlite3.connect(path)
    raw.executescript(
        "CREATE TABLE checklist (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, default_version_id INTEGER);"
        "CREATE TABLE checklist_version (id INTEGER PRIMARY KEY AUTOINCREMENT, checklist_id INTEGER NOT NULL,"
        " version INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, config_json TEXT NOT NULL,"
        " UNIQUE (checklist_id, version));"
        "INSERT INTO checklist(name, default_version_id) VALUES ('old', 1);"
    )
    raw.execute("INSERT INTO checklist_version(checklist_id, version, config_json) VALUES (1, 1, ?)", (SEED_PATH.read_text(encoding="utf-8"),))
    raw.commit()
    raw.close()
    init_db(path)
    init_db(path)
    conn = connect(path)
    from backend.app.services import checklist as svc

    out = svc.get_checklist(conn, 1)
    assert out.channels == [] and out.versions[0].status == "active"
    conn.close()
