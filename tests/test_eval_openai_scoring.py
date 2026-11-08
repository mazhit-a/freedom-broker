import json
from types import SimpleNamespace as NS

import pytest

from backend.app.services.evaluator import build_schema, build_system_prompt, build_user_prompt
from evals import runner
from evals.gen import openai_provider as op
from evals.ledger import Ledger
from evals.workflows import build_workflow
from evals.workflows.base import ERROR, OK, REFUSED, TRUNCATED, LLMRequest
from evals.workflows.prompts import NEW_RANGE_RULE, build_system_prompt_v2
from evals.workflows.review import repair_prompt
from scripts import eval as cli
from tests.test_eval_gen_openai import FakeClient, HttpError, response
from tests.test_eval_runner_fakes import CFG, FakeAnthropic, FakeJev, results_text, tiny_dataset
from tests.test_eval_runner_cli import Env

VARIANTS = runner.load_variants()
USAGE = (3000, 1000, 6000, 2000)
COST = (2000 * 2.0 + 1000 * 0.1 + 6000 * 10.0) / 1e6
IDS = [c.id for c in CFG.criteria]


def good(kwargs):
    ids = kwargs["text"]["format"]["schema"]["properties"]["results"]["items"]["properties"]["criterion_id"]["enum"]
    return results_text(ids)


def ok_handler(n, kwargs):
    return response(good(kwargs), usage=USAGE)


def make_executor(tmp_path, client, mode="live", **kw):
    kw.setdefault("sleep", lambda s: None)
    kw.setdefault("poll_initial", 0)
    return runner.Executor(
        CFG, mode=mode, sdk=FakeAnthropic(), jev_client=FakeJev(), openai_client=client, ledger=Ledger(tmp_path / "ledger.json"), concurrency=2, **kw
    )


def run_variant(tmp_path, client, name="gpt_sol_medium", mode="live", dataset=None, run_id="o", **kw):
    dataset = dataset or tiny_dataset()
    ex = make_executor(tmp_path, client, mode, **kw)
    out = runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run(VARIANTS[name], dataset["cases"], "all", 1, run_id=run_id)
    return ex, out


def read(tmp_path, run_id, name):
    return json.loads((tmp_path / "runs" / run_id / name).read_text(encoding="utf-8"))


def first_stage(name="gpt_sol_medium"):
    case = tiny_dataset()["cases"][0]
    wf = build_workflow(VARIANTS[name], CFG)
    return wf, case, wf.stage(0, case, wf.new_state(case)).requests[0]


def test_variants_registered_and_existing_ones_unchanged():
    assert VARIANTS["gpt_sol_medium"] == {
        "name": "gpt_sol_medium",
        "workflow": "openai_single_call",
        "params": {"prompt": "v2", "model": "gpt-6.1-sol", "effort": "medium"},
    }
    assert VARIANTS["gpt_sol_low"]["params"] == {"prompt": "v2", "model": "gpt-6.1-sol", "effort": "low"}
    assert list(VARIANTS)[:21] == [
        "baseline", "opus_low", "sonnet_medium", "jev_only", "jev_sonnet", "jev_haiku", "extract_then_judge", "per_criterion", "jev_rich",
        "jev_split", "jev_rich_split", "jev_temporal_choice", "jev_temporal_split", "jev_obs", "jev_gaps", "jev_obs_gaps",
        "jev_compiled_naive", "jev_compiled_principled", "opus_low_fix05", "opus_low_marks", "opus_low_fix05_marks",
    ]
    assert VARIANTS["baseline"]["params"] == {"prompt": "v1", "profile": "claude-opus-5-5", "effort": "medium"}
    assert VARIANTS["opus_low_fix05"]["workflow"] == "single_call"


def test_request_shape():
    wf, case, req = first_stage()
    p = req.params
    assert req.kind == "openai" and req.request_id == "main" and req.group == "openai_single_call"
    assert "temperature" not in p and p["store"] is False and p["model"] == "gpt-6.1-sol"
    assert p["reasoning"] == {"effort": "medium"} and p["max_output_tokens"] == 32000
    fmt = p["text"]["format"]
    assert fmt["type"] == "json_schema" and fmt["strict"] is True and fmt["name"] == op.SCHEMA_NAME
    assert fmt["schema"] == op.convert_schema(json.loads(json.dumps(build_schema(CFG)))) and op.strict_problems(fmt["schema"]) == []
    assert p["instructions"] == build_system_prompt_v2(CFG) and NEW_RANGE_RULE in p["instructions"]
    conv = case["conversation"]
    user = build_user_prompt({"channel": conv["channel"], "language": conv["language"]}, conv["messages"])
    assert p["input"] == [{"role": "user", "content": user}]
    assert set(p) == {"model", "instructions", "input", "max_output_tokens", "reasoning", "text", "store"}
    json.dumps(p)


def test_params_effort_prompt_marks_and_validation():
    assert first_stage("gpt_sol_low")[2].params["reasoning"] == {"effort": "low"}
    case = tiny_dataset()["cases"][0]
    v1 = build_workflow({"name": "x", "workflow": "openai_single_call", "params": {"prompt": "v1", "effort": "high", "max_output_tokens": 5000}}, CFG)
    p = v1.stage(0, case, v1.new_state(case)).requests[0].params
    assert p["instructions"] == build_system_prompt(CFG) and p["reasoning"] == {"effort": "high"} and p["max_output_tokens"] == 5000
    marks = build_workflow({"name": "x", "workflow": "openai_single_call", "params": {"prompt": "v2", "pause_marks": True}}, CFG)
    pm = marks.stage(0, case, marks.new_state(case)).requests[0].params
    assert pm["instructions"].endswith("never include it in a quote.") and pm["model"] == "gpt-6.1-sol"
    with pytest.raises(ValueError):
        build_workflow({"name": "x", "workflow": "openai_single_call", "params": {"effort": "turbo"}}, CFG)
    with pytest.raises(KeyError):
        build_workflow({"name": "x", "workflow": "openai_single_call", "params": {"prompt": "v9"}}, CFG)
    wf = build_workflow(VARIANTS["gpt_sol_medium"], CFG)
    assert wf.stage_count == 2 and wf.expected_calls() == 1 and wf.estimate_plan() == [("openai_single_call", "gpt-6.1-sol", 1)]


def test_full_case_with_repair_turn(tmp_path):
    def handler(n, kwargs):
        items = kwargs["input"]
        if len(items) == 1:
            return response(results_text([i for i in IDS if i != "05"]), usage=USAGE)
        return response(results_text(["05"]), usage=USAGE)

    client = FakeClient(handler)
    ex, out = run_variant(tmp_path, client)
    assert out["meta"]["status"] == "complete" and out["n_errors"] == 0
    assert len(client.calls) == 6
    repairs = [c for c in client.calls if len(c["input"]) == 3]
    firsts = [c for c in client.calls if len(c["input"]) == 1]
    assert len(repairs) == 3 and len(firsts) == 3
    r = repairs[0]
    first_text = results_text([i for i in IDS if i != "05"])
    assert [m["role"] for m in r["input"]] == ["user", "assistant", "user"]
    assert r["input"][0]["content"].startswith("Conversation metadata") and r["input"][1]["content"] == first_text
    assert r["input"][2]["content"] == repair_prompt({"05": ["criterion 05: missing from the output"]})
    assert r["instructions"] == firsts[0]["instructions"] and r["text"] == firsts[0]["text"] and "temperature" not in r and r["store"] is False
    assert all(c["timeout"] == ex.openai_ceiling for c in client.calls)
    rows = read(tmp_path, "o", "results.json")
    assert len(rows) == 3
    for row in rows:
        assert set(row["results"]) == set(IDS) and row["needs_review"] == {} and row["refused"] is False and row["mode"] == "live" and row["structured"] is True
        assert [c["stage"] for c in row["calls"]] == ["first", "repair"] and {c["provider"] for c in row["calls"]} == {"openai"}
        assert row["calls"][0]["request_id"] == "main" and row["calls"][1]["request_id"] == "main_repair"
    assert out["meta"]["served_models"] == ["gpt-6.1-sol-2026-11-01"]
    assert out["meta"]["cost_actual"] == pytest.approx(6 * COST, abs=1e-6) == pytest.approx(out["meta"]["cost_recomputed"], abs=1e-6)
    assert out["meta"]["usage"]["total"]["cache_read_tokens"] == 6000


def test_cost_math_and_usage_fields(tmp_path):
    client = FakeClient(ok_handler)
    ex = make_executor(tmp_path, client)
    _, _, req = first_stage()
    store = runner.ResponseStore(tmp_path / "raw")
    got = ex.execute([("a", req)], store, "rid")["a"]
    assert got.status == OK and got.kind == "openai" and got.structured is True and got.batch is False
    assert (got.input_tokens, got.cache_read_tokens, got.output_tokens) == (2000, 1000, 6000)
    assert got.cost == pytest.approx(COST) and got.data["reasoning_tokens"] == 2000 and got.model == "gpt-6.1-sol-2026-11-01"
    (entry,) = Ledger(tmp_path / "ledger.json").load()["entries"]
    assert entry["provider"] == "openai" and entry["model"] == "gpt-6.1-sol-2026-11-01" and entry["run_id"] == "rid" and entry["counts"] is False
    assert (entry["input_tokens"], entry["cache_read_tokens"], entry["output_tokens"], entry["requests"]) == (2000, 1000, 6000, 1)
    assert entry["cost"] == pytest.approx(COST) and ex.openai_spent == pytest.approx(COST) and ex.spent == 0.0
    again = ex.execute([("a", req)], store, "rid")["a"]
    assert again.cost == got.cost and len(client.calls) == 1


@pytest.mark.parametrize(
    "resp,status",
    [
        (response('{"results": [', status="incomplete", reason="max_output_tokens"), TRUNCATED),
        (response(refusal="no"), REFUSED),
        (response(text="x", status="incomplete", reason="content_filter"), REFUSED),
        (response(text=""), ERROR),
        (response(text="x", status="failed"), ERROR),
        (response(text="x", status="incomplete", reason="other"), ERROR),
    ],
)
def test_non_ok_statuses_carry_no_text(tmp_path, resp, status):
    ex = make_executor(tmp_path, FakeClient(lambda n, kw: resp))
    _, _, req = first_stage()
    got = ex.execute([("a", req)], runner.ResponseStore(tmp_path / "raw"), "rid")["a"]
    assert got.status == status and got.text == "" and got.error
    assert got.status != OK


def test_truncated_response_never_becomes_an_answer(tmp_path):
    client = FakeClient(lambda n, kw: response(good(kw), status="incomplete", reason="max_output_tokens", usage=USAGE))
    ex, out = run_variant(tmp_path, client)
    rows = read(tmp_path, "o", "results.json")
    assert len(rows) == 3 and all(r["results"] == {} and set(r["needs_review"]) == set(IDS) and r["refused"] is False for r in rows)
    assert all(c["status"] == "truncated" and c["truncated"] is True for r in rows for c in r["calls"])
    assert len(client.calls) == 6


def test_refusal_never_becomes_an_answer_and_skips_repair(tmp_path):
    client = FakeClient(lambda n, kw: response(refusal="I cannot", usage=USAGE))
    ex, out = run_variant(tmp_path, client)
    rows = read(tmp_path, "o", "results.json")
    assert len(client.calls) == 3 and all(r["refused"] is True and r["results"] == {} and len(r["calls"]) == 1 for r in rows)
    assert all(c["status"] == "refused" for r in rows for c in r["calls"])


def test_error_status_fails_the_row_with_a_redacted_message(tmp_path):
    secret = "sk-proj-ABCDEFGH12345678"
    client = FakeClient(lambda n, kw: (_ for _ in ()).throw(HttpError(400, f"bad request key {secret}")))
    ex, out = run_variant(tmp_path, client)
    errors = read(tmp_path, "o", "errors.json")
    assert len(errors) == 3 and out["meta"]["status"] == "incomplete" and read(tmp_path, "o", "results.json") == []
    assert all(e["kind"] == "infrastructure" and secret not in e["error"] and "HttpError status 400" in e["error"] for e in errors)
    assert len(client.calls) == 3


def test_retries_on_429_then_success(tmp_path):
    seen = []

    def handler(n, kwargs):
        seen.append(n)
        if n <= 2:
            raise HttpError(429, "slow down")
        return response(good(kwargs), usage=USAGE)

    ex, out = run_variant(tmp_path, FakeClient(handler), dataset=tiny_dataset(1))
    assert out["meta"]["status"] == "complete" and len(seen) == 3
    assert read(tmp_path, "o", "results.json")[0]["calls"][0]["attempts"] == 3


def test_served_model_mismatch_and_dated_alias(tmp_path):
    ex = make_executor(tmp_path, FakeClient(lambda n, kw: response(good(kw), model="gpt-5-mini-2026-01-01", usage=USAGE)))
    _, _, req = first_stage()
    got = ex.execute([("a", req)], runner.ResponseStore(tmp_path / "raw"), "rid")["a"]
    assert got.status == ERROR and "does not match requested model" in got.error and got.text == ""
    ex2 = make_executor(tmp_path / "2", FakeClient(lambda n, kw: response(good(kw), model="gpt-6.1-sol", usage=USAGE)))
    assert ex2.execute([("a", req)], runner.ResponseStore(tmp_path / "2" / "raw"), "rid")["a"].status == OK
    ex3 = make_executor(tmp_path / "3", FakeClient(lambda n, kw: response(good(kw), model="gpt-6.1-solar", usage=USAGE)))
    assert ex3.execute([("a", req)], runner.ResponseStore(tmp_path / "3" / "raw"), "rid")["a"].status == ERROR
    ex4 = make_executor(tmp_path / "4", FakeClient(lambda n, kw: response(good(kw), model=None, usage=USAGE)))
    got4 = ex4.execute([("a", req)], runner.ResponseStore(tmp_path / "4" / "raw"), "rid")["a"]
    assert got4.status == ERROR and "no served model" in got4.error


def test_mismatch_through_runner_is_an_infrastructure_error(tmp_path):
    client = FakeClient(lambda n, kw: response(good(kw), model="other-model", usage=USAGE))
    ex, out = run_variant(tmp_path, client)
    assert out["n_errors"] == 3 and all("does not match" in e["error"] for e in read(tmp_path, "o", "errors.json"))


def test_error_responses_are_retried_on_resume_and_ok_ones_are_not(tmp_path):
    state = {"fail": True}

    def handler(n, kwargs):
        if state["fail"]:
            raise HttpError(400, "nope")
        return response(good(kwargs), usage=USAGE)

    client = FakeClient(handler)
    run_variant(tmp_path, client)
    state["fail"] = False
    ex, out = run_variant(tmp_path, client)
    assert out["meta"]["status"] == "complete"
    calls = len(client.calls)
    run_variant(tmp_path, client)
    assert len(client.calls) == calls


def test_live_openai_stage_in_a_batch_run(tmp_path):
    client = FakeClient(ok_handler)
    ex, out = run_variant(tmp_path, client, mode="batch")
    assert ex.sdk.batches_created == [] and ex.sdk.live_calls == [] and len(client.calls) == 3
    assert out["meta"]["mode"] == "batch" and out["meta"]["status"] == "complete"
    assert {r["mode"] for r in read(tmp_path, "o", "results.json")} == {"live"}
    assert all(c["batch"] is False for r in read(tmp_path, "o", "results.json") for c in r["calls"])


def test_spend_guard_refuses_when_the_first_call_could_exceed_max_spend(tmp_path):
    client = FakeClient(ok_handler)
    ex, out = run_variant(tmp_path, client, max_spend=0.05)
    assert client.calls == [] and out["stopped"] and "--max-spend" in out["stopped"] and out["meta"]["status"].startswith("stopped")


def test_spend_stops_when_the_estimate_would_pass_max_spend(tmp_path):
    client = FakeClient(lambda n, kw: response(good(kw), usage=(3000, 0, 30000, 0)))
    ex, out = run_variant(tmp_path, client, max_spend=0.4)
    assert out["stopped"] and len(client.calls) == 1 and ex.openai_spent == pytest.approx(0.306)
    assert out["meta"]["status"].startswith("stopped") and "resume" in out["stopped"]
    ex2, out2 = run_variant(tmp_path, FakeClient(ok_handler), max_spend=5.0)
    assert out2["meta"]["status"] == "complete"


def test_missing_key_is_reported_without_a_network_call(tmp_path, monkeypatch):
    monkeypatch.setattr(op, "make_default_client", lambda *a, **k: (None, []))
    ex = runner.Executor(CFG, mode="live", sdk=FakeAnthropic(), ledger=Ledger(tmp_path / "l.json"))
    with pytest.raises(runner.OpenAIKeyMissing) as info:
        ex.check_openai()
    assert "OPENAI_API_KEY is not set" in str(info.value)


class OpenAIEnv(Env):
    def __init__(self, tmp_path, handler=ok_handler, dataset=None):
        super().__init__(tmp_path, dataset=dataset)
        self.client = FakeClient(handler)

    def factory(self, cfg, mode, concurrency, max_spend, ledger):
        self.factory_calls += 1
        return runner.Executor(
            cfg, mode=mode, sdk=self.sdk, jev_client=self.jev, openai_client=self.client, ledger=ledger, concurrency=2,
            max_spend=max_spend, sleep=lambda s: None, poll_initial=0,
        )


def test_dry_run_shows_openai_cost_separately(tmp_path, capsys):
    env = OpenAIEnv(tmp_path)
    assert env.run("gpt_sol_medium", "--split", "dev", "--max-spend", "1") == 0
    out = capsys.readouterr().out
    assert "gpt_sol_medium: workflow=openai_single_call models=gpt-6.1-sol cases=2 reps=1 requests=2" in out
    per_case = (4100 * 2.0 + 2500 * 10.0) / 1e6
    assert f"estimated OpenAI ${2 * per_case:.4f} (not counted against the budget)" in out
    assert "estimated total: $0.0000" in out and f"estimated OpenAI total: ${2 * per_case:.4f}" in out
    assert "never batched" in out and "max-spend applies to: the OpenAI spend" in out
    assert env.factory_calls == 0 and env.client.calls == [] and not env.ledger_path.exists()


def test_estimate_split_and_no_batch_discount_for_openai(tmp_path):
    ledger = Ledger(tmp_path / "l.json")
    plan = [("openai_single_call", "gpt-6.1-sol", 1), ("single_call", "claude-opus-5-5", 1)]
    counted_b, openai_b = ledger.estimate_split(plan, 10, "batch")
    counted_l, openai_l = ledger.estimate_split(plan, 10, "live")
    assert openai_b == openai_l == pytest.approx(10 * (4100 * 2.0 + 2500 * 10.0) / 1e6, abs=1e-6)
    assert counted_b == pytest.approx(counted_l / 2, abs=1e-6) and ledger.estimate_plan(plan, 10, "live") == counted_l
    data = ledger.load()
    data["estimates"] = {"openai_single_call": {"input": 3300, "output": 1700}}
    ledger.save(data)
    assert ledger.estimate_split(plan, 10, "live")[1] == pytest.approx(10 * (3300 * 2.0 + 1700 * 10.0) / 1e6, abs=1e-6)


def test_openai_only_max_spend_checks_openai_spend_not_the_budget(tmp_path, capsys):
    env = OpenAIEnv(tmp_path)
    assert env.run("gpt_sol_medium", "--split", "dev", "--execute", "--max-spend", "0.0001") == 2
    out = capsys.readouterr().out
    assert "estimated OpenAI cost" in out and "exceeds --max-spend" in out and "OpenAI spend, not counted against the budget" in out
    Ledger(env.ledger_path).append({"run_id": "old", "provider": "anthropic", "model": "claude-opus-5-5", "mode": "batch", "cost": 9.999})
    assert env.run("gpt_sol_medium", "--split", "dev", "--execute", "--max-spend", "2") == 0
    out = capsys.readouterr().out
    assert "complete, rows 2/2" in out and env.factory_calls == 1 and len(env.client.calls) == 2
    assert env.sdk.batches_created == [] and env.sdk.live_calls == []
    ledger = Ledger(env.ledger_path)
    assert ledger.spent() == pytest.approx(9.999) and ledger.remaining() == pytest.approx(0.001)
    s = ledger.summary()
    assert s["openai"] == pytest.approx(2 * COST, abs=1e-6) and s["by_provider"] == {"anthropic": 9.999} and s["uncounted"] == {"openai": s["openai"]}


def test_mixed_run_checks_both_pools_against_max_spend(tmp_path, capsys):
    env = OpenAIEnv(tmp_path)
    assert env.run("gpt_sol_medium", "baseline", "--split", "dev", "--mode", "live", "--execute", "--max-spend", "0.02") == 2
    out = capsys.readouterr().out
    assert "refused:" in out and env.factory_calls == 0
    assert env.run("gpt_sol_medium", "baseline", "--split", "dev", "--mode", "live", "--execute", "--max-spend", "3") == 0
    out = capsys.readouterr().out
    assert "each must fit under it" in out and len(env.client.calls) == 2 and len(env.sdk.live_calls) == 2
    ledger = Ledger(env.ledger_path)
    assert ledger.spent() > 0 and ledger.summary()["openai"] > 0
    assert set(ledger.summary()["by_provider"]) == {"anthropic"}


def test_ledger_command_prints_openai_spend_separately(tmp_path, capsys):
    ledger = Ledger(tmp_path / "l.json")
    ledger.append({"run_id": "a", "provider": "anthropic", "model": "m", "mode": "batch", "cost": 1.5})
    ledger.append({"run_id": "g1", "provider": "openai", "model": "gpt-6.1-sol", "mode": "live", "cost": 0.4, "input_tokens": 10, "output_tokens": 5})
    ledger.append({"run_id": "g1", "provider": "openai", "model": "gpt-6.1-sol", "mode": "live", "cost": 0.1})
    assert ledger.spent() == 1.5 and ledger.remaining() == 8.5
    assert cli.main(["ledger", "--ledger", str(tmp_path / "l.json")]) == 0
    out = capsys.readouterr().out
    assert "spent $1.5000, remaining $8.5000" in out
    assert "OpenAI spend (not counted against the budget): $0.5000" in out and "  g1: $0.5000" in out


def test_missing_key_refuses_the_cli_run(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(op, "make_default_client", lambda *a, **k: (None, []))

    def factory(cfg, mode, concurrency, max_spend, ledger):
        return runner.Executor(cfg, mode=mode, sdk=FakeAnthropic(), ledger=ledger)

    env = Env(tmp_path)
    code = cli.main(["run", "gpt_sol_medium", "--split", "dev", "--execute", "--max-spend", "1", *env.common()], factory)
    assert code == 2 and "OPENAI_API_KEY is not set" in capsys.readouterr().out and not (tmp_path / "runs").exists()
