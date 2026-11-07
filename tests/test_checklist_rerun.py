import json

import pytest
from fastapi.testclient import TestClient

from backend.app.core import config
from backend.app.services import batch, checklist as checklist_service
from backend.app.services.llm_client import get_llm_client
from tests.test_batch import ConcurrentSDK, add_dataset, make, wait_done
from tests.test_evaluator import fixed_good, ev
from backend.app.core.database import connect, init_db


class DynamicSDK(ConcurrentSDK):
    def __init__(self, results_by_marker):
        super().__init__()
        self.results_by_marker = results_by_marker
        self.systems = []
        self.messages.create = self._dyn

    def _dyn(self, **kwargs):
        system = json.dumps(kwargs.get("system"), ensure_ascii=False)
        self.systems.append(system)
        for marker, text in self.results_by_marker:
            if marker in system:
                break
        usage = type("U", (), dict(input_tokens=1, output_tokens=1, cache_read_input_tokens=0, cache_creation_input_tokens=0))()
        content = [type("C", (), dict(type="text", text=text))()]
        return type("R", (), dict(content=content, stop_reason="end_turn", usage=usage))()


def payload_for(results):
    from tests.test_evaluator import payload

    return payload(results)


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = str(tmp_path / "r.db")
    monkeypatch.setenv("CQA_DB_PATH", path)
    config.get_settings.cache_clear()
    batch.reset_jobs()
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    yield conn
    conn.close()
    config.get_settings.cache_clear()


def seed_config():
    return checklist_service.load_seed_config().model_dump()


def replaced_config():
    cfg = seed_config()
    cfg["criteria"] = [c for c in cfg["criteria"] if c["id"] != "05"]
    cfg["criteria"].insert(
        4,
        {
            "id": "empathy-x",
            "title": "Empathy",
            "description": "The operator acknowledged the client's feelings.",
            "section": "conduct",
            "weight": 15,
            "type": "scale",
            "na_allowed": False,
            "scale_steps": [
                {"value": 0, "descriptor": "none"},
                {"value": 1, "descriptor": "some"},
                {"value": 2, "descriptor": "full"},
            ],
        },
    )
    return cfg


def new_results():
    r = fixed_good()
    del r["05"]
    r["empathy-x"] = (1, "Оператор проявил частичную эмпатию.", ev(5, "я подскажу шаги"), None, None)
    return r


@pytest.fixture
def api(env):
    from backend.app.main import app

    sdk = DynamicSDK([("empathy-x", payload_for(new_results())), ("", payload_for(fixed_good()))])
    app.dependency_overrides[get_llm_client] = lambda: make(sdk)
    with TestClient(app) as c:
        c.sdk = sdk
        yield c
    app.dependency_overrides.clear()


def evals_for(api, pk):
    return api.get(f"/api/v1/conversations/{pk}/evaluations").json()


def test_replace_criterion_and_rerun_without_code_change(api, env):
    pks = add_dataset(env, "RR", 3)
    v1 = checklist_service.get_checklist(env, 1).default_version_id
    first = wait_done(api, api.post("/api/v1/batches", json={"dataset": "RR"}).json()["id"])
    assert first["completed"] == 3
    old = evals_for(api, pks[0])[0]
    assert old["total"] == 88.13
    assert "05" in {c["criterion_id"] for c in old["criteria"]}

    r = api.post("/api/v1/checklists/1/versions", json=replaced_config())
    assert r.status_code == 201 and r.json()["version"] == 2 and r.json()["warnings"] == []
    v2 = r.json()["id"]
    assert api.get("/api/v1/checklists/1").json()["default_version_id"] == v1

    second = wait_done(api, api.post("/api/v1/batches", json={"dataset": "RR", "checklist_version_id": v2}).json()["id"])
    assert second["completed"] == 3 and second["skipped"] == 0
    assert any("empathy-x" in s for s in api.sdk.systems)

    rows = evals_for(api, pks[0])
    assert len(rows) == 2
    new = next(e for e in rows if e["checklist_version_id"] == v2)
    ids = [c["criterion_id"] for c in new["criteria"]]
    assert "05" not in ids and "empathy-x" in ids
    crit = next(c for c in new["criteria"] if c["criterion_id"] == "empathy-x")
    assert crit["answer"] == "1"
    assert crit["points"] == 7.5
    assert new["total"] == 78.75
    assert new["total"] != old["total"]
    assert next(e for e in rows if e["checklist_version_id"] == v1)["total"] == 88.13


def test_batch_conversation_selection(api, env):
    pks = add_dataset(env, "SEL", 4)
    job = api.post("/api/v1/batches", json={"dataset": "SEL", "conversation_pks": [pks[1], pks[3]]}).json()
    assert job["total"] == 2
    done = wait_done(api, job["id"])
    assert done["completed"] == 2
    evaluated = {r["conversation_id"] for r in api.get("/api/v1/conversations", params={"dataset": "SEL", "status": "completed"}).json()}
    assert evaluated == {"SEL-1", "SEL-3"}
    assert api.post("/api/v1/batches", json={"dataset": "SEL", "conversation_pks": []}).status_code == 404


def test_added_criterion_appears_in_prompt_and_scoring(api, env):
    pks = add_dataset(env, "ADD", 1)
    cfg = seed_config()
    cfg["criteria"].append(
        {"id": "extra-9", "title": "Extra", "description": "d", "section": "conduct", "weight": 0, "type": "flag"}
    )
    v2 = api.post("/api/v1/checklists/1/versions", json=cfg).json()["id"]
    results = fixed_good()
    results["extra-9"] = ("yes", "Флаг.", ev(5, "я подскажу шаги"), None, None)
    api.sdk.results_by_marker = [("", payload_for(results))]
    wait_done(api, api.post("/api/v1/batches", json={"dataset": "ADD", "checklist_version_id": v2}).json()["id"])
    e = evals_for(api, pks[0])[0]
    assert "extra-9" in {c["criterion_id"] for c in e["criteria"]}
    assert e["gross_violation"] is True


def test_weights_95_warns_and_saves_next_version(api):
    cfg = seed_config()
    cfg["criteria"][0]["weight"] = 5
    r = api.post("/api/v1/checklists/1/versions", json=cfg)
    assert r.status_code == 201
    assert r.json()["version"] == 2
    assert r.json()["warnings"] == ["weights sum to 95, not 100"]


def test_invalid_configs_422_and_not_saved(api):
    dup = seed_config()
    dup["criteria"][1]["id"] = dup["criteria"][0]["id"]
    r = api.post("/api/v1/checklists/1/versions", json=dup)
    assert r.status_code == 422 and "duplicate criterion ids" in json.dumps(r.json())
    bad = seed_config()
    bad["criteria"][3]["scale_steps"] = []
    r = api.post("/api/v1/checklists/1/versions", json=bad)
    assert r.status_code == 422 and "at least 2 steps" in json.dumps(r.json())
    ch = api.get("/api/v1/checklists/1").json()
    assert len(ch["versions"]) == 1
