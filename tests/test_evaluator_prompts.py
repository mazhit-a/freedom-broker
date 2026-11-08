import json
from dataclasses import dataclass, field

import pytest

from backend.app.core import config
from backend.app.core.database import connect, init_db
from backend.app.services import checklist as checklist_service
from backend.app.services import prompts
from backend.app.services.evaluator import PROMPT_VERSION, TRUNCATED_REASON, evaluate_conversation
from tests.test_evaluator import add_conversation, crit, ev, fixed_good, payload, version_id


@dataclass
class FakeResult:
    text: str
    stop_reason: str | None = "end_turn"
    input_tokens: int = 10
    output_tokens: int = 5
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    latency_ms: int = 1
    cost: float = 0.0
    structured: bool = False
    meta: dict = field(default_factory=dict)

    @property
    def refused(self) -> bool:
        return self.stop_reason == "refusal"


class FakeClient:
    model = "fake-model"

    def __init__(self, results):
        self.results = list(results)
        self.systems = []
        self.users = []
        self.calls = 0

    def complete(self, system_text, messages, schema):
        self.calls += 1
        self.systems.append(system_text)
        self.users.append(messages[0]["content"])
        return self.results.pop(0)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("OPENAI_API_KEY", "LLM_PROMPT_VERSION", "CQA_BATCH_CONCURRENCY"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def db(tmp_path):
    path = str(tmp_path / "e.db")
    init_db(path)
    conn = connect(path)
    checklist_service.seed_default(conn)
    yield conn
    conn.close()


def settings(version):
    return config.Settings(_env_file=None, llm_prompt_version=version)


def raw_output(conn, evaluation_id):
    return json.loads(conn.execute("SELECT raw_output FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone()[0])


def run(db, client, version="v1"):
    pk = add_conversation(db)
    return evaluate_conversation(db, pk, version_id(db), client, settings=settings(version))


def test_prompt_version_constant_stays_v1():
    assert PROMPT_VERSION == "v1"


@pytest.mark.parametrize("version", ["v1", "v2", "v3_xml"])
def test_version_stored_and_builders_used(db, version):
    client = FakeClient([FakeResult(payload(fixed_good()))])
    result = run(db, client, version)
    assert result["prompt_version"] == version
    assert result["status"] == "completed"
    assert raw_output(db, result["id"])["prompt_version"] == version
    cfg = checklist_service.get_version(db, version_id(db)).config
    system_builder, user_builder = prompts.PROMPTS[version]
    assert client.systems[0] == system_builder(cfg)
    assert ("<transcript>" in client.users[0]) == (version == "v3_xml")


def test_unknown_version_fails_evaluation(db):
    client = FakeClient([])
    result = run(db, client, "nope")
    assert client.calls == 0
    assert result["status"] == "failed"
    assert result["prompt_version"] == "nope"
    reason = crit(result, "01")["rationale"]
    assert "nope" in reason and "v1" in reason and "v3_xml" in reason
    assert all(c["needs_review"] for c in result["criteria"])
    assert raw_output(db, result["id"])["error"] == reason


def test_v2_range_rule_in_system_prompt(db):
    client = FakeClient([FakeResult(payload(fixed_good()))])
    run(db, client, "v2")
    assert prompts.NEW_RANGE_RULE in client.systems[0]
    assert prompts.OLD_RANGE_RULE not in client.systems[0]
    client = FakeClient([FakeResult(payload(fixed_good()))])
    run(db, client, "v1")
    assert prompts.OLD_RANGE_RULE in client.systems[0]


def test_truncated_first_response_needs_review_no_second_call(db):
    client = FakeClient([FakeResult(payload(fixed_good()), stop_reason="max_tokens")])
    result = run(db, client)
    assert client.calls == 1
    assert result["status"] == "needs_review"
    assert len(result["criteria"]) == 8
    for c in result["criteria"]:
        assert c["needs_review"] and c["answer"] == "needs_review"
        assert c["rationale"] == TRUNCATED_REASON
    assert raw_output(db, result["id"])["error"] is None


def test_truncated_repair_keeps_first_pass(db):
    bad = fixed_good()
    bad["01"] = ("yes", "Оператор поздоровался.", ev(99, "меня зовут Анна"), None, None)
    client = FakeClient(
        [
            FakeResult(payload(bad)),
            FakeResult(payload({"01": fixed_good()["01"]}), stop_reason="max_tokens"),
        ]
    )
    result = run(db, client)
    assert client.calls == 2
    assert result["status"] == "needs_review"
    assert crit(result, "01")["needs_review"] and crit(result, "01")["rationale"] == TRUNCATED_REASON
    for cid in ("02", "03", "04", "05", "06", "07", "08"):
        assert not crit(result, cid)["needs_review"]
    assert raw_output(db, result["id"])["error"] is None


def test_raw_output_calls_meta(db):
    bad = fixed_good()
    bad["01"] = ("yes", "Оператор поздоровался.", ev(99, "меня зовут Анна"), None, None)

    class NoMeta:
        def __init__(self, inner):
            self.__dict__.update({k: v for k, v in inner.__dict__.items() if k != "meta"})
            self.refused = False

    first = FakeResult(payload(bad), meta={"response_id": "r1", "n": 1})
    second = NoMeta(FakeResult(payload({"01": fixed_good()["01"]})))
    result = run(db, FakeClient([first, second]), "v2")
    raw = raw_output(db, result["id"])
    assert raw["prompt_version"] == "v2"
    assert raw["calls_meta"] == [{"response_id": "r1", "n": 1}, {}]
    assert len(raw["calls"]) == 2
