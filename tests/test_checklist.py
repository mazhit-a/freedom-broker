import copy
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.services.checklist import SEED_PATH


@pytest.fixture
def client(tmp_path, monkeypatch):
    path = str(tmp_path / "t.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    from backend.app.main import app

    with TestClient(app) as c:
        c.db_path = path
        yield c
    config.get_settings.cache_clear()


def seed_cfg():
    return json.loads(SEED_PATH.read_text(encoding="utf-8"))


def default_version(client):
    cl = client.get("/api/v1/checklists").json()[0]
    return cl, client.get(f"/api/v1/checklist-versions/{cl['default_version_id']}").json()


def test_seed_default_version(client):
    lists = client.get("/api/v1/checklists").json()
    assert len(lists) == 1
    cl, v = default_version(client)
    assert v["version"] == 1 and v["is_default"]
    criteria = v["config"]["criteria"]
    assert [c["id"] for c in criteria] == [f"0{i}" for i in range(1, 9)]
    assert sum(c["weight"] for c in criteria if c["type"] != "flag") == 100
    flag = criteria[7]
    assert flag["type"] == "flag" and flag["weight"] == 0
    assert v["warnings"] == []
    c4 = next(c for c in criteria if c["id"] == "04")
    c6 = next(c for c in criteria if c["id"] == "06")
    assert [s["value"] for s in c4["scale_steps"]] == [20, 15, 10, 5, 0]
    assert [s["value"] for s in c6["scale_steps"]] == [10, 7, 4, 0]
    assert c4["scale_steps"][1]["descriptor"] == "Основной вопрос решён, пропущена второстепенная деталь."
    assert c6["scale_steps"][1]["descriptor"] == "Один заметный сбой, но клиент может понять ответ и продолжить."


def test_seed_not_duplicated_on_restart(client, monkeypatch):
    from backend.app.main import app

    with TestClient(app):
        pass
    assert len(client.get("/api/v1/checklists").json()) == 1
    assert len(client.get("/api/v1/checklists").json()[0]["versions"]) == 1


def test_new_version_immutable_and_default_selectable(client):
    cl, v1 = default_version(client)
    cfg = copy.deepcopy(v1["config"])
    cfg["criteria"][0]["title"] = "Rapport edited"
    r = client.post(f"/api/v1/checklists/{cl['id']}/versions", json=cfg)
    assert r.status_code == 201
    v2 = r.json()
    assert v2["version"] == 2 and v2["id"] != v1["id"]
    assert not v2["is_default"]
    again = client.get(f"/api/v1/checklist-versions/{v1['id']}").json()
    assert again["config"] == v1["config"]
    assert again["config"]["criteria"][0]["title"] == "Установление контакта"
    r = client.put(f"/api/v1/checklists/{cl['id']}/default", json={"version_id": v2["id"]})
    assert r.status_code == 200 and r.json()["is_default"]
    cl2 = client.get(f"/api/v1/checklists/{cl['id']}").json()
    assert cl2["default_version_id"] == v2["id"]
    assert [x["is_default"] for x in cl2["versions"]] == [False, True]
    conn = sqlite3.connect(client.db_path)
    assert conn.execute("select count(*) from checklist_version").fetchone()[0] == 2


def test_default_version_must_belong_to_checklist(client):
    cl, _ = default_version(client)
    assert client.put(f"/api/v1/checklists/{cl['id']}/default", json={"version_id": 999}).status_code == 404
    assert client.get("/api/v1/checklist-versions/999").status_code == 404
    assert client.post("/api/v1/checklists/999/versions", json=seed_cfg()).status_code == 404


def post_bad(client, cfg):
    cl, _ = default_version(client)
    r = client.post(f"/api/v1/checklists/{cl['id']}/versions", json=cfg)
    assert len(client.get(f"/api/v1/checklists/{cl['id']}").json()["versions"]) == 1
    return r


def test_duplicate_ids_rejected(client):
    cfg = seed_cfg()
    cfg["criteria"][1]["id"] = "01"
    r = post_bad(client, cfg)
    assert r.status_code == 422
    assert "duplicate criterion ids" in json.dumps(r.json())


def test_scale_without_steps_rejected(client):
    cfg = seed_cfg()
    cfg["criteria"][3]["scale_steps"] = []
    cfg["criteria"][3].pop("max_step")
    r = post_bad(client, cfg)
    assert r.status_code == 422
    assert "scale type requires" in json.dumps(r.json())


def test_na_allowed_without_condition_rejected(client):
    cfg = seed_cfg()
    cfg["criteria"][1]["na_condition"] = ""
    assert post_bad(client, cfg).status_code == 422
    cfg = seed_cfg()
    del cfg["criteria"][1]["na_condition"]
    r = post_bad(client, cfg)
    assert r.status_code == 422
    assert "na_condition" in json.dumps(r.json())


def test_scale_top_step_inconsistent_rejected(client):
    cfg = seed_cfg()
    cfg["criteria"][3]["max_step"] = 15
    r = post_bad(client, cfg)
    assert r.status_code == 422
    assert "max_step" in json.dumps(r.json())


def test_other_invalid_configs_rejected(client):
    cfg = seed_cfg()
    cfg["criteria"][0]["type"] = "bogus"
    assert post_bad(client, cfg).status_code == 422
    cfg = seed_cfg()
    cfg["criteria"][7]["weight"] = 5
    assert post_bad(client, cfg).status_code == 422
    cfg = seed_cfg()
    cfg["criteria"][0]["section"] = "nope"
    assert post_bad(client, cfg).status_code == 422
    cfg = seed_cfg()
    cfg["criteria"] = []
    assert post_bad(client, cfg).status_code == 422


def test_weights_not_100_is_warning_only(client):
    cl, _ = default_version(client)
    cfg = seed_cfg()
    cfg["criteria"][0]["weight"] = 5
    r = client.post(f"/api/v1/checklists/{cl['id']}/versions", json=cfg)
    assert r.status_code == 201
    body = r.json()
    assert body["version"] == 2
    assert len(body["warnings"]) == 1 and "95" in body["warnings"][0]


def test_create_new_checklist_with_custom_criteria(client):
    cfg = {
        "name": "Custom",
        "criteria": [
            {"id": "x1", "title": "T", "weight": 100, "type": "yes_no"},
        ],
    }
    r = client.post("/api/v1/checklists", json=cfg)
    assert r.status_code == 201
    assert r.json()["version"] == 1 and r.json()["is_default"]
    assert len(client.get("/api/v1/checklists").json()) == 2
