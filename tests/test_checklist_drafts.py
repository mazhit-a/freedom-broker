import copy

from tests.test_checklist_v2 import API, add_conversation, client, first_checklist, seed_cfg  # noqa: F401


def empty_cfg(name="Новый чек-лист"):
    return {"name": name, "sections": [{"id": "s1", "title": "Раздел 1"}], "criteria": []}


def draft_first(client, name="Draft only", channels=("voice call",)):
    params = [("status", "draft")] + [("channels", c) for c in channels]
    r = client.post(f"{API}/checklists", params=params, json=empty_cfg(name))
    assert r.status_code == 201, r.text
    return r.json()


def test_draft_first_checklist_has_no_default(client):
    d = draft_first(client)
    assert d["status"] == "draft" and d["version"] == 1 and d["is_default"] is False
    assert d["config"]["criteria"] == []
    cl = client.get(f"{API}/checklists/{d['checklist_id']}").json()
    assert cl["default_version_id"] is None and cl["channels"] == ["voice call"]
    assert cl["versions"][0]["status"] == "draft" and cl["versions"][0]["criteria_count"] == 0
    listing = client.get(f"{API}/checklists").json()
    assert len(listing) == 2
    assert listing[0]["default_version_id"] is not None


def test_draft_first_does_not_change_other_checklists(client):
    before = client.get(f"{API}/checklists").json()
    draft_first(client)
    after = client.get(f"{API}/checklists").json()
    assert after[0] == before[0]


def test_draft_relaxations(client):
    d = draft_first(client)
    cfg = copy.deepcopy(seed_cfg())
    cfg["criteria"][0]["weight"] = 7
    cfg["criteria"][0]["title"] = ""
    cfg["criteria"][1]["na_condition"] = ""
    cfg["sections"][0]["title"] = ""
    r = client.put(f"{API}/checklist-versions/{d['id']}", json=cfg)
    assert r.status_code == 200 and r.json()["status"] == "draft" and r.json()["warnings"]
    r = client.put(f"{API}/checklist-versions/{d['id']}", json=empty_cfg())
    assert r.status_code == 200


def test_draft_still_rejects_structural_errors(client):
    d = draft_first(client)
    bad = seed_cfg()
    bad["criteria"][1]["id"] = "01"
    assert client.put(f"{API}/checklist-versions/{d['id']}", json=bad).status_code == 422
    bad = seed_cfg()
    bad["criteria"][0]["type"] = "bogus"
    assert client.put(f"{API}/checklist-versions/{d['id']}", json=bad).status_code == 422
    bad = seed_cfg()
    bad["criteria"][0]["section"] = "nope"
    assert client.put(f"{API}/checklist-versions/{d['id']}", json=bad).status_code == 422
    bad = empty_cfg()
    bad["sections"].append({"id": "s1", "title": "dup"})
    assert client.post(f"{API}/checklists", params={"status": "draft"}, json=bad).status_code == 422
    bad = seed_cfg()
    bad["criteria"][7]["weight"] = 5
    assert client.put(f"{API}/checklist-versions/{d['id']}", json=bad).status_code == 422


def test_saved_paths_still_require_complete_config(client):
    assert client.post(f"{API}/checklists", json=empty_cfg()).status_code == 422
    cl = first_checklist(client)
    assert client.post(f"{API}/checklists/{cl['id']}/versions", json=empty_cfg()).status_code == 422
    assert len(first_checklist(client)["versions"]) == 1
    cfg = seed_cfg()
    cfg["criteria"][0]["title"] = " "
    assert client.post(f"{API}/checklists/{cl['id']}/versions", json=cfg).status_code == 422


def test_finalize_validates_and_becomes_v1_default_only_on_activation(client):
    d = draft_first(client)
    r = client.post(f"{API}/checklist-versions/{d['id']}/save")
    assert r.status_code == 422 and "at least 1 criterion" in r.text
    assert client.put(f"{API}/checklist-versions/{d['id']}", json=seed_cfg()).status_code == 200
    r = client.post(f"{API}/checklist-versions/{d['id']}/save")
    assert r.status_code == 200 and r.json()["status"] == "saved"
    assert client.get(f"{API}/checklists/{d['checklist_id']}").json()["default_version_id"] is None
    r = client.put(f"{API}/checklists/{d['checklist_id']}/default", json={"version_id": d["id"]})
    assert r.status_code == 200 and r.json()["status"] == "active"


def test_finalize_draft_with_incomplete_na_is_422(client):
    d = draft_first(client)
    cfg = seed_cfg()
    cfg["criteria"][1]["na_condition"] = ""
    assert client.put(f"{API}/checklist-versions/{d['id']}", json=cfg).status_code == 200
    r = client.post(f"{API}/checklist-versions/{d['id']}/save")
    assert r.status_code == 422 and "na_condition" in r.text
    assert client.get(f"{API}/checklist-versions/{d['id']}").json()["status"] == "draft"


def test_delete_draft(client):
    cl = first_checklist(client)
    d = client.post(f"{API}/checklists/{cl['id']}/versions", params={"status": "draft"}, json=seed_cfg()).json()
    assert client.delete(f"{API}/checklist-versions/{d['id']}").status_code == 204
    assert client.get(f"{API}/checklist-versions/{d['id']}").status_code == 404
    assert len(first_checklist(client)["versions"]) == 1
    assert client.delete(f"{API}/checklist-versions/{d['id']}").status_code == 404


def test_delete_saved_or_active_is_409(client):
    cl = first_checklist(client)
    assert client.delete(f"{API}/checklist-versions/{cl['default_version_id']}").status_code == 409
    assert client.get(f"{API}/checklist-versions/{cl['default_version_id']}").status_code == 200


def test_delete_only_draft_removes_empty_checklist(client):
    d = draft_first(client)
    assert client.delete(f"{API}/checklist-versions/{d['id']}").status_code == 204
    assert client.get(f"{API}/checklists/{d['checklist_id']}").status_code == 404
    assert len(client.get(f"{API}/checklists").json()) == 1


def test_delete_keeps_checklist_with_other_versions(client):
    d = draft_first(client)
    client.put(f"{API}/checklist-versions/{d['id']}", json=seed_cfg())
    client.post(f"{API}/checklist-versions/{d['id']}/save")
    d2 = client.post(f"{API}/checklists/{d['checklist_id']}/versions", params={"status": "draft"}, json=empty_cfg()).json()
    assert client.delete(f"{API}/checklist-versions/{d2['id']}").status_code == 204
    assert client.get(f"{API}/checklists/{d['checklist_id']}").status_code == 200


def test_resolution_ignores_checklist_without_default(client, monkeypatch):
    from backend.app.api.v1 import evaluations

    cl = first_checklist(client)
    d = draft_first(client, channels=("voice call",))
    seen = []
    monkeypatch.setattr(evaluations, "evaluate_conversation", lambda conn, pk, vid, c: seen.append(vid) or {"ok": 1})
    voice = add_conversation(client, "voice call", "gv")
    assert client.post(f"{API}/conversations/{voice}/evaluate").status_code == 200
    assert seen == [cl["default_version_id"]]
    assert client.post(f"{API}/conversations/{voice}/evaluate", params={"checklist_version_id": d["id"]}).status_code == 422
    r = client.post(f"{API}/batches", json={"dataset": "gv", "checklist_version_id": d["id"]})
    assert r.status_code == 422


def test_resolve_with_only_drafts_is_none(tmp_path, monkeypatch):
    from backend.app.core.database import connect, init_db
    from backend.app.schemas.checklist import ChecklistConfig
    from backend.app.services import checklist as svc

    path = str(tmp_path / "only.db")
    init_db(path)
    conn = connect(path)
    svc.create_checklist(conn, ChecklistConfig.model_validate(empty_cfg()), "draft", ["voice call"])
    assert svc.resolve_version_id(conn, None, "voice call") is None
    assert svc.resolve_version_id(conn, None) is None
    assert len(svc.list_checklists(conn)) == 1
    conn.close()


def test_activation_changes_statuses(client):
    cl = first_checklist(client)
    v1 = cl["default_version_id"]
    v2 = client.post(f"{API}/checklists/{cl['id']}/versions", json=seed_cfg()).json()
    v3 = client.post(f"{API}/checklists/{cl['id']}/versions", json=seed_cfg()).json()
    statuses = lambda: [v["status"] for v in first_checklist(client)["versions"]]
    assert statuses() == ["active", "saved", "saved"]
    assert client.put(f"{API}/checklists/{cl['id']}/default", json={"version_id": v3["id"]}).status_code == 200
    assert statuses() == ["archived", "archived", "active"]
    assert client.put(f"{API}/checklists/{cl['id']}/default", json={"version_id": v1}).status_code == 200
    assert statuses() == ["active", "saved", "archived"]
    assert client.put(f"{API}/checklists/{cl['id']}/default", json={"version_id": v2["id"]}).status_code == 200
    assert statuses() == ["archived", "active", "archived"]


def test_draft_allows_empty_scale_descriptor_but_finalize_does_not(client):
    d = draft_first(client)
    cfg = seed_cfg()
    cfg["criteria"][3]["scale_steps"][0]["descriptor"] = ""
    assert client.put(f"{API}/checklist-versions/{d['id']}", json=cfg).status_code == 200
    r = client.post(f"{API}/checklist-versions/{d['id']}/save")
    assert r.status_code == 422 and "descriptors" in r.text
    cl = first_checklist(client)
    assert client.post(f"{API}/checklists/{cl['id']}/versions", json=cfg).status_code == 422
