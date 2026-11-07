import json
import random
import threading
from types import SimpleNamespace as NS

import pytest

from evals import prices
from evals.gen import assemble, openai_provider as op, prompt
from evals.gen.common import load_checklist
from scripts import eval_gen
from tests.test_eval_gen_fakes import generation_output, good_spec

CFG = load_checklist()
SECRET = "sk-test-SECRETSECRET123456"


def response(text=None, status="completed", refusal=None, reason=None, usage=(3000, 1000, 6000, 2000), model="gpt-6.1-sol-2026-11-01"):
    content = []
    if text is not None:
        content.append(NS(type="output_text", text=text))
    if refusal is not None:
        content.append(NS(type="refusal", refusal=refusal))
    return NS(
        status=status,
        model=model,
        incomplete_details=NS(reason=reason) if reason else None,
        output=[NS(type="reasoning", summary=[]), NS(type="message", content=content)],
        usage=NS(
            input_tokens=usage[0],
            input_tokens_details=NS(cached_tokens=usage[1]),
            output_tokens=usage[2],
            output_tokens_details=NS(reasoning_tokens=usage[3]),
        ),
    )


class FakeClient:
    def __init__(self, handler):
        self.calls = []
        self.lock = threading.Lock()
        self.responses = NS(create=self.create)
        self.handler = handler

    def create(self, **kwargs):
        with self.lock:
            self.calls.append(kwargs)
            n = len(self.calls)
        return self.handler(n, kwargs)


class HttpError(Exception):
    def __init__(self, code, message="boom"):
        super().__init__(message)
        self.status_code = code


def items(n=3):
    out = []
    for i in range(n):
        spec = dict(good_spec(), id=f"case-{i + 1:03d}")
        req = op.to_openai_request(prompt.live_request(spec, CFG), model="gpt-6.1-sol")
        out.append({"custom_id": spec["id"], "request": req})
    return out


def run(client, its, **kw):
    kw.setdefault("sleep", lambda s: None)
    kw.setdefault("rng", random.Random(1))
    return op.run_requests(client, its, **kw)


def test_schema_conversion_is_strict_and_leaves_source_untouched():
    source = prompt.generation_schema(CFG)
    before = json.dumps(source, sort_keys=True)
    converted = op.convert_schema(source)
    assert json.dumps(source, sort_keys=True) == before
    assert op.strict_problems(converted) == []
    assert "anyOf" in json.dumps(source) and "anyOf" not in json.dumps(converted)
    item = converted["properties"]["results"]["items"]["properties"]
    assert item["checked_range"]["type"] == ["object", "null"]
    assert item["na_reason"]["type"] == ["string", "null"]
    assert item["criterion_id"]["enum"] == [c.id for c in CFG.criteria]


def test_convert_forces_required_additional_properties_and_drops_keywords():
    schema = {
        "type": "object",
        "properties": {"a": {"type": "integer", "minimum": 0, "default": 1}, "b": {"type": "string", "pattern": "x"}},
        "required": ["a"],
    }
    out = op.convert_schema(schema)
    assert out["required"] == ["a", "b"] and out["additionalProperties"] is False
    assert out["properties"]["a"] == {"type": "integer"} and out["properties"]["b"] == {"type": "string"}
    assert op.strict_problems({"type": "object", "properties": {"a": {"type": "string", "pattern": "x"}}}) != []


def test_request_shape():
    spec = good_spec()
    source = prompt.live_request(spec, CFG)
    req = op.to_openai_request(source, model="gpt-6.1-sol", effort="high", max_output_tokens=1234)
    assert "temperature" not in req and "top_p" not in req
    assert req["reasoning"] == {"effort": "high"} and req["max_output_tokens"] == 1234
    assert req["model"] == "gpt-6.1-sol" and req["store"] is False
    fmt = req["text"]["format"]
    assert fmt["type"] == "json_schema" and fmt["strict"] is True and fmt["name"] and fmt["schema"]["type"] == "object"
    assert req["instructions"] == source["system"][0]["text"]
    assert req["input"] == [{"role": "user", "content": source["messages"][0]["content"]}]
    assert op.to_openai_request(source)["reasoning"]["effort"] == "medium"
    with pytest.raises(ValueError):
        op.to_openai_request(source, effort="turbo")
    with pytest.raises(ValueError):
        op.to_openai_request({"system": "s", "messages": [], "output_config": {"format": {"schema": {"anyOf": [{"type": "object"}, {"type": "null"}]}}}})


def test_result_mapping_ok():
    text = json.dumps(generation_output(), ensure_ascii=False)
    client = FakeClient(lambda n, kw: response(text))
    rows, skipped = run(client, items(1))
    row = rows[0]
    assert skipped == [] and row["status"] == "ok" and row["text"] == text and row["error"] is None
    assert row["usage"] == {"input_tokens": 3000, "cached_input_tokens": 1000, "output_tokens": 6000, "reasoning_tokens": 2000}
    assert row["model"] == "gpt-6.1-sol-2026-11-01" and row["requested_model"] == "gpt-6.1-sol"
    assert row["cost_usd"] == pytest.approx((2000 * 2.0 + 6000 * 10.0 + 1000 * 0.1) / 1e6)
    assert row["latency_s"] >= 0 and row["attempts"] == 1
    assert client.calls[0]["timeout"] == op.DEFAULT_CEILING_SECONDS and "temperature" not in client.calls[0]


def test_refusal_truncation_and_empty_are_not_ok():
    for resp, status in [
        (response(refusal="I can't help with that"), "refusal"),
        (response(text='{"messages": [', status="incomplete", reason="max_output_tokens"), "truncated"),
        (response(text="x", status="incomplete", reason="content_filter"), "incomplete"),
        (response(text=""), "empty"),
        (response(text="x", status="failed"), "error"),
    ]:
        rows, _ = run(FakeClient(lambda n, kw, r=resp: r), items(1))
        assert rows[0]["status"] == status and rows[0]["text"] is None and rows[0]["error"]
        assert rows[0]["cost_usd"] > 0 or status == "empty"


def test_retry_on_429_5xx_then_success_and_no_retry_on_400():
    ok = response(json.dumps(generation_output()))
    sleeps = []

    def handler(n, kw):
        if n == 1:
            raise HttpError(429)
        if n == 2:
            raise HttpError(503)
        return ok

    rows, _ = run(FakeClient(handler), items(1), sleep=sleeps.append)
    assert rows[0]["status"] == "ok" and rows[0]["attempts"] == 3 and len(sleeps) == 2

    def bad(n, kw):
        raise HttpError(400, "bad request")

    client = FakeClient(bad)
    rows, _ = run(client, items(1))
    assert rows[0]["status"] == "error" and rows[0]["attempts"] == 1 and len(client.calls) == 1


def test_retries_exhausted_and_timeout_ceiling():
    client = FakeClient(lambda n, kw: (_ for _ in ()).throw(HttpError(500)))
    rows, _ = run(client, items(1), max_attempts=3)
    assert rows[0]["status"] == "error" and rows[0]["attempts"] == 3
    gate = threading.Event()
    slow = FakeClient(lambda n, kw: gate.wait(5))
    rows, _ = run(slow, items(1), ceiling=0.05, max_attempts=2)
    gate.set()
    assert rows[0]["status"] == "timeout" and rows[0]["attempts"] == 2


def test_backoff_is_jittered_and_capped():
    rng = random.Random(3)
    values = {op.backoff_delay(3, rng) for _ in range(20)}
    assert len(values) > 1 and all(0 <= v <= 8 for v in values)
    assert op.backoff_delay(20, rng) <= 60


def test_error_text_never_contains_the_key():
    def handler(n, kw):
        raise HttpError(401, f"Incorrect API key provided: {SECRET}. Bearer {SECRET}")

    rows, _ = run(FakeClient(handler), items(1), secrets=[SECRET])
    blob = json.dumps(rows)
    assert SECRET not in blob and "SECRETSECRET" not in blob
    assert "sk-abcdefghijkl" not in op.redact("key sk-abcdefghijkl here")


def test_spend_guard_refuses_first_call_that_could_exceed():
    guard = op.SpendGuard(0.05, "gpt-6.1-sol", 32000)
    with pytest.raises(op.BudgetRefused):
        guard.check_start()
    op.SpendGuard(1.0, "gpt-6.1-sol", 32000).check_start()


def test_spend_guard_stops_running_and_runs_first_call_alone():
    text = json.dumps(generation_output())
    per_call = prices.cost("gpt-6.1-sol", input_tokens=2000, output_tokens=6000, cache_read_tokens=1000)
    guard = op.SpendGuard(per_call * 2.5, "gpt-6.1-sol", 100)
    client = FakeClient(lambda n, kw: response(text))
    rows, skipped = run(client, items(6), guard=guard, concurrency=3)
    assert len(rows) == 2 and len(skipped) == 4
    assert guard.spent <= guard.max_spend and len(client.calls) == 2


def test_spend_guard_counts_inflight_calls():
    guard = op.SpendGuard(1.0, "gpt-6.1-sol", 1000)
    guard.record(0.3)
    assert guard.permit(0) and guard.permit(1)
    assert not guard.permit(2)
    cold = op.SpendGuard(1.0, "gpt-6.1-sol", 1000)
    assert cold.permit(0) and not cold.permit(1)


def test_concurrency_is_bounded():
    text = json.dumps(generation_output())
    state = {"now": 0, "peak": 0}
    lock = threading.Lock()

    def handler(n, kw):
        with lock:
            state["now"] += 1
            state["peak"] = max(state["peak"], state["now"])
        threading.Event().wait(0.02)
        with lock:
            state["now"] -= 1
        return response(text)

    rows, skipped = run(FakeClient(handler), items(8), concurrency=3)
    assert len(rows) == 8 and state["peak"] <= 3


def test_dotenv_loader_with_temp_file(tmp_path):
    path = tmp_path / ".env"
    path.write_text("A=1\nOPENAI_API_KEY=OPENAI_API_KEY=sk-live-fake\n", encoding="utf-8")
    assert op.load_api_key({}, path) == "sk-live-fake"
    assert op.load_api_key({"OPENAI_API_KEY": " abc "}, path) == "abc"
    assert op.load_api_key({}, tmp_path / "missing") is None
    assert op.default_model({}, tmp_path / "missing") == "gpt-6.1-sol"
    assert op.default_model({"OPENAI_GEN_MODEL": "x"}, tmp_path / "missing") == "x"


def test_prices_and_plan_output(capsys):
    p = prices.price_for("gpt-6.1-sol")
    assert (p.input, p.output, p.cache_read, p.cache_write) == (2.0, 10.0, 0.1, 2.5)
    assert prices.cost("gpt-6.1-sol", 1_000_000, 1_000_000, batch=False) == 12.0
    assert eval_gen.main(["plan", "--only", "case-001,case-002"]) == 0
    out = capsys.readouterr().out
    assert "openai estimate" in out and "reasoning tokens" in out and "generation requests: 2" in out


def test_module_imports_no_openai_at_top_level():
    import scripts.eval_gen as mod

    source = open(mod.__file__, encoding="utf-8").read() + open(op.__file__, encoding="utf-8").read()
    assert not [line for line in source.splitlines() if line.startswith("import openai") or line.startswith("from openai")]


@pytest.fixture
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", SECRET)
    text = json.dumps(generation_output(), ensure_ascii=False)
    clients = []

    def factory(key, timeout):
        assert key == SECRET
        c = FakeClient(lambda n, kw: response(text))
        clients.append(c)
        return c

    monkeypatch.setattr(op, "make_client", factory)
    specs_path = tmp_path / "specs.json"
    specs_path.write_text(json.dumps([good_spec()]), encoding="utf-8")
    return tmp_path, specs_path, clients


def test_generate_dry_run_sends_nothing(live, capsys):
    tmp, specs, clients = live
    assert eval_gen.main(["generate", "--specs", str(specs), "--dry-run", "--effort", "high", "--out", str(tmp / "o.jsonl")]) == 0
    out = capsys.readouterr().out
    assert "requests: 1" in out and "model: gpt-6.1-sol" in out and "effort: high" in out and "estimated cost" in out
    assert clients == [] and not (tmp / "o.jsonl").exists()


def test_generate_writes_results_and_spend_log_and_ingest_accepts(live, capsys):
    tmp, specs, clients = live
    out = tmp / "o.jsonl"
    assert eval_gen.main(["generate", "--specs", str(specs), "--out", str(out), "--max-spend", "1.0"]) == 0
    log = json.loads((tmp / "o.spend.json").read_text(encoding="utf-8"))
    assert log["statuses"] == {"case-901": "ok"} and log["spent_usd"] > 0 and log["skipped_for_budget"] == []
    assert SECRET not in out.read_text(encoding="utf-8") + json.dumps(log) + capsys.readouterr().out
    sent = clients[0].calls[0]
    assert "temperature" not in sent and sent["reasoning"] == {"effort": "medium"}
    dataset = tmp / "d.json"
    assert eval_gen.main(["ingest", "--specs", str(specs), "--results", str(out), "--out", str(dataset)]) == 0
    assert assemble.contract_errors(json.loads(dataset.read_text(encoding="utf-8"))) == []


def test_generate_refuses_overwrite_without_force(live):
    tmp, specs, clients = live
    out = tmp / "o.jsonl"
    out.write_text("keep\n", encoding="utf-8")
    with pytest.raises(SystemExit):
        eval_gen.main(["generate", "--specs", str(specs), "--out", str(out), "--max-spend", "1.0"])
    assert out.read_text(encoding="utf-8") == "keep\n" and clients == []
    assert eval_gen.main(["generate", "--specs", str(specs), "--out", str(out), "--max-spend", "1.0", "--force"]) == 0
    assert out.read_text(encoding="utf-8") != "keep\n"


def test_generate_requires_budget_and_refuses_tiny_budget(live):
    tmp, specs, clients = live
    with pytest.raises(SystemExit):
        eval_gen.main(["generate", "--specs", str(specs), "--out", str(tmp / "a.jsonl")])
    with pytest.raises(SystemExit):
        eval_gen.main(["generate", "--specs", str(specs), "--out", str(tmp / "a.jsonl"), "--max-spend", "0.01"])
    assert clients == [] and not (tmp / "a.jsonl").exists()


def test_generate_missing_key(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(op, "DOTENV_PATH", tmp_path / "none.env")
    specs = tmp_path / "s.json"
    specs.write_text(json.dumps([good_spec()]), encoding="utf-8")
    with pytest.raises(SystemExit):
        eval_gen.main(["generate", "--specs", str(specs), "--out", str(tmp_path / "o.jsonl"), "--max-spend", "1"])


def test_generate_budget_stop_reports_skipped(live, monkeypatch):
    tmp, specs, clients = live
    both = [good_spec(), dict(good_spec(), id="case-902")]
    specs.write_text(json.dumps(both), encoding="utf-8")
    out = tmp / "o.jsonl"
    code = eval_gen.main(["generate", "--specs", str(specs), "--out", str(out), "--max-spend", "0.40"])
    log = json.loads((tmp / "o.spend.json").read_text(encoding="utf-8"))
    assert log["spent_usd"] <= 0.40
    assert code == (1 if log["skipped_for_budget"] else 0)


def test_ingest_reports_non_ok_statuses(tmp_path):
    lines = [
        json.dumps({"custom_id": "case-901", "status": "refusal", "text": None, "error": "model refused: no"}),
    ]
    cases, failures = assemble.ingest_results(CFG, [good_spec()], lines)
    assert cases == [] and "refusal" in failures["case-901"]
    lines = [json.dumps({"custom_id": "case-901", "status": "truncated", "text": None, "error": "response incomplete: max_output_tokens"})]
    _, failures = assemble.ingest_results(CFG, [good_spec()], lines)
    assert "truncated" in failures["case-901"]
