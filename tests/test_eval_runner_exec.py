import json
from types import SimpleNamespace

import pytest

from evals import prices, runner
from evals.ledger import Ledger
from evals.workflows.base import ERROR, OK, TRUNCATED, LLMRequest, Stage, Workflow
from evals.gen import assemble
from tests.test_eval_runner_fakes import CFG, FakeAnthropic, FakeJev, default_responder, results_text, tiny_dataset
from tests.test_eval_runner_workflows import VARIANTS


class StatusError(Exception):
    def __init__(self, status_code, msg="bad"):
        super().__init__(msg)
        self.status_code = status_code


def make_executor(tmp_path, sdk=None, mode="live", jev=None, **kw):
    kw.setdefault("sleep", lambda s: None)
    kw.setdefault("poll_initial", 0)
    return runner.Executor(CFG, mode=mode, sdk=sdk or FakeAnthropic(), jev_client=jev or FakeJev(), ledger=Ledger(tmp_path / "ledger.json"), concurrency=3, **kw)


def request(rid="r1", model="claude-opus-5-5"):
    params = {"model": model, "max_tokens": 10, "system": [], "messages": [{"role": "user", "content": rid}], "output_config": {"format": {"type": "json_schema", "schema": {"type": "object", "properties": {"results": {"type": "array", "items": {"type": "object", "properties": {"criterion_id": {"enum": ["01"]}}}}}}}}}
    return LLMRequest(rid, "anthropic", model, params, "single_call")


def run_variant(tmp_path, name="baseline", mode="live", sdk=None, jev=None, dataset=None, run_id="r", reps=1, **kw):
    dataset = dataset or tiny_dataset()
    ex = make_executor(tmp_path, sdk, mode, jev, **kw)
    out = runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run(VARIANTS[name], dataset["cases"], "all", reps, run_id=run_id)
    return ex, out


def read(tmp_path, run_id, name):
    return json.loads((tmp_path / "runs" / run_id / name).read_text(encoding="utf-8"))


def test_batch_execution_maps_results_by_custom_id_not_position(tmp_path):
    sdk = FakeAnthropic(default_responder, seed=7)
    ex, out = run_variant(tmp_path, mode="batch", sdk=sdk)
    assert len(sdk.batches_created) == 1 and len(sdk.batches_created[0]) == 3
    sent = [r["custom_id"] for r in sdk.batches_created[0]]
    returned = [e.custom_id for e in sdk.stored["batch_1"]]
    assert sorted(sent) == sorted(returned) and sent != returned
    results = read(tmp_path, "r", "results.json")
    assert [c["case_id"] for c in results] == ["c1", "c2", "c3"]
    assert all(c["mode"] == "batch" and c["calls"][0]["latency_ms"] is None and c["calls"][0]["batch"] for c in results)
    assert sdk.live_calls == []
    for r in sdk.batches_created[0]:
        assert len(r["custom_id"]) <= 64 and r["custom_id"].isalnum()


def test_batch_results_follow_the_right_case_when_responses_differ(tmp_path):
    dataset = tiny_dataset(3)
    dataset["cases"][1]["conversation"]["messages"][1]["text"] += " ZZZ"
    dataset["hash"] = assemble.cases_hash(dataset["cases"])

    def responder(params):
        ids = [c.id for c in CFG.criteria]
        overrides = {"08": "yes"} if "ZZZ" in params["messages"][0]["content"] else None
        return results_text(ids, overrides=overrides)

    for seed in (1, 2, 3):
        sdk = FakeAnthropic(responder, seed=seed)
        ex, out = run_variant(tmp_path / str(seed), mode="batch", sdk=sdk, dataset=dataset)
        results = read(tmp_path / str(seed), "r", "results.json")
        assert {c["case_id"]: c["results"]["08"]["answer"] for c in results} == {"c1": "no", "c2": "yes", "c3": "no"}


def test_batch_errored_expired_and_missing_rows_go_to_errors_json(tmp_path):
    seen = []

    def entry_override(req, entry):
        seen.append(req["custom_id"])
        if len(seen) == 1:
            return SimpleNamespace(custom_id=req["custom_id"], result=SimpleNamespace(type="expired"))
        if len(seen) == 2:
            return SimpleNamespace(custom_id=req["custom_id"], result=SimpleNamespace(type="errored", error={"type": "overloaded"}))
        return None

    sdk = FakeAnthropic(entry_override=entry_override)
    ex, out = run_variant(tmp_path, mode="batch", sdk=sdk)
    errors = read(tmp_path, "r", "errors.json")
    assert out["n_errors"] == 2 and len(errors) == 2
    assert {e["kind"] for e in errors} == {"infrastructure"} and "batch expired" in errors[0]["error"] + errors[1]["error"]
    results = read(tmp_path, "r", "results.json")
    assert len(results) == 1 and out["meta"]["status"] == "incomplete"
    ex2 = make_executor(tmp_path, FakeAnthropic(), "batch")
    out2 = runner.Runner(tiny_dataset(), ex2, tmp_path / "runs", cfg=CFG).run(VARIANTS["baseline"], tiny_dataset()["cases"], "all", 1, run_id="r")
    assert out2["meta"]["status"] == "complete" and read(tmp_path, "r", "errors.json") == []
    assert len(ex2.sdk.batches_created[0]) == 2


def test_missing_batch_entry_is_an_error(tmp_path):
    class Dropping(FakeAnthropic):
        def batch_results(self, bid):
            return iter(list(self.stored[bid])[:-1])

    ex, out = run_variant(tmp_path, mode="batch", sdk=Dropping())
    errors = read(tmp_path, "r", "errors.json")
    assert len(errors) == 1 and errors[0]["error"] == "missing from batch results"


def test_live_execution_bounded_concurrency_and_resume_skips_finished_rows(tmp_path):
    sdk = FakeAnthropic()
    ex, out = run_variant(tmp_path, sdk=sdk)
    assert len(sdk.live_calls) == 3 and all("timeout" in c for c in sdk.live_calls)
    sdk2 = FakeAnthropic()
    ex2, out2 = run_variant(tmp_path, sdk=sdk2)
    assert sdk2.live_calls == [] and out2["meta"]["n_rows"] == 3
    assert Ledger(tmp_path / "ledger.json").summary()["entries"] == 1
    (tmp_path / "runs" / "r" / "rows" / "c2__r0.json").unlink()
    sdk3 = FakeAnthropic()
    ex3, out3 = run_variant(tmp_path, sdk=sdk3)
    assert sdk3.live_calls == [] and out3["meta"]["n_rows"] == 3


def test_resume_does_not_repay_stage_one_when_stage_two_failed(tmp_path):
    state = {"n": 0}

    def responder(params):
        if "events" in params["output_config"]["format"]["schema"]["properties"]:
            return default_responder(params)
        state["n"] += 1
        return StatusError(400, "bad request")

    sdk = FakeAnthropic(responder)
    ex, out = run_variant(tmp_path, "extract_then_judge", sdk=sdk, dataset=tiny_dataset(2), run_id="x")
    assert out["n_errors"] == 2 and out["meta"]["n_rows"] == 0
    errors = read(tmp_path, "x", "errors.json")
    assert {e["stage"] for e in errors} == {"first"}
    sdk2 = FakeAnthropic()
    ex2, out2 = run_variant(tmp_path, "extract_then_judge", sdk=sdk2, dataset=tiny_dataset(2), run_id="x")
    assert len(sdk2.live_calls) == 2
    assert all("events" not in c["output_config"]["format"]["schema"]["properties"] for c in sdk2.live_calls)
    assert out2["meta"]["status"] == "complete"


def test_live_retries_transient_errors_with_jitter_then_succeeds(tmp_path):
    attempts = {"n": 0}
    sleeps = []

    def responder(params):
        attempts["n"] += 1
        if attempts["n"] <= 2:
            return StatusError(429 if attempts["n"] == 1 else 529)
        return default_responder(params)

    ex = make_executor(tmp_path, FakeAnthropic(responder), sleep=sleeps.append, rng=lambda: 0.5)
    resp = ex.call_live(request())
    assert resp.status == OK and resp.attempts == 3 and len(sleeps) == 2 and sleeps[1] > sleeps[0]


def test_live_non_retryable_and_exhausted_retries_are_errors(tmp_path):
    ex = make_executor(tmp_path, FakeAnthropic(lambda p: StatusError(400)))
    resp = ex.call_live(request())
    assert resp.status == ERROR and resp.attempts == 1 and "StatusError" in resp.error
    ex = make_executor(tmp_path, FakeAnthropic(lambda p: StatusError(500)), max_attempts=3)
    resp = ex.call_live(request())
    assert resp.status == ERROR and resp.attempts == 3


def test_live_wall_clock_ceiling(tmp_path):
    now = {"t": 0.0}

    def clock():
        return now["t"]

    def sleep(s):
        now["t"] += s + 100

    ex = make_executor(tmp_path, FakeAnthropic(lambda p: StatusError(500)), call_ceiling=50.0, clock=clock, sleep=sleep, max_attempts=10)
    resp = ex.call_live(request())
    assert resp.status == ERROR and "ceiling" in resp.error


def test_infrastructure_failure_never_becomes_a_wrong_answer(tmp_path):
    state = {"n": 0}

    def responder(params):
        state["n"] += 1
        return StatusError(400) if state["n"] == 2 else default_responder(params)

    ex, out = run_variant(tmp_path, sdk=FakeAnthropic(responder), dataset=tiny_dataset(3))
    errors = read(tmp_path, "r", "errors.json")
    results = read(tmp_path, "r", "results.json")
    assert len(errors) == 1 and len(results) == 2
    assert errors[0]["case_id"] not in {c["case_id"] for c in results}
    assert out["meta"]["n_errors"] == 1 and out["meta"]["status"] == "incomplete"


def test_served_model_mismatch_is_an_error_and_alias_prefix_is_fine(tmp_path):
    def responder(params):
        return default_responder(params), "end_turn", None, "claude-sonnet-5-5-20261001"

    ex, out = run_variant(tmp_path, sdk=FakeAnthropic(responder))
    errors = read(tmp_path, "r", "errors.json")
    assert len(errors) == 3 and "does not match requested model" in errors[0]["error"]
    assert read(tmp_path, "r", "results.json") == []
    ex = make_executor(tmp_path, FakeAnthropic(lambda p: (default_responder(p), "end_turn", None, "claude-opus-5-5")))
    assert ex.call_live(request()).status == OK
    ex = make_executor(tmp_path, FakeAnthropic(lambda p: (default_responder(p), "end_turn", None, "claude-opus-5-50")))
    assert ex.call_live(request()).status == ERROR
    ex = make_executor(tmp_path, FakeAnthropic(lambda p: (default_responder(p), "end_turn", None, "")))
    assert ex.call_live(request()).status == ERROR


def test_stop_reasons_map_to_statuses(tmp_path):
    ex = make_executor(tmp_path, FakeAnthropic(lambda p: ("x", "max_tokens")))
    assert ex.call_live(request()).status == TRUNCATED
    ex = make_executor(tmp_path, FakeAnthropic(lambda p: ("", "refusal")))
    assert ex.call_live(request()).status == "refused"


def test_jev_failure_goes_to_errors_not_results(tmp_path):
    ex, out = run_variant(tmp_path, "jev_only", jev=FakeJev(fail=True), mode="batch")
    errors = read(tmp_path, "r", "errors.json")
    assert len(errors) == 3 and "server" in errors[0]["error"] and read(tmp_path, "r", "results.json") == []


def test_cost_recomputed_from_usage_equals_meta_cost_live_and_batch(tmp_path):
    for mode in ("live", "batch"):
        ex, out = run_variant(tmp_path / mode, mode=mode, run_id="c")
        meta = read(tmp_path / mode, "c", "meta.json")
        results = read(tmp_path / mode, "c", "results.json")
        recomputed = sum(
            prices.cost(c["model"], c["input_tokens"], c["output_tokens"], c["cache_read_tokens"], c["cache_write_tokens"], batch=(mode == "batch"))
            for r in results
            for c in r["calls"]
        )
        assert meta["cost_actual"] == pytest.approx(recomputed, abs=1e-9) == pytest.approx(meta["cost_recomputed"], abs=1e-9)
        assert Ledger(tmp_path / mode / "ledger.json").spent() == pytest.approx(meta["cost_actual"], abs=1e-9)
    live = read(tmp_path / "live", "c", "meta.json")["cost_actual"]
    batch = read(tmp_path / "batch", "c", "meta.json")["cost_actual"]
    assert batch == pytest.approx(live / 2, abs=1e-6)


def test_meta_contents_and_raw_files(tmp_path):
    dataset = tiny_dataset()
    ex, out = run_variant(tmp_path, dataset=dataset)
    meta = read(tmp_path, "r", "meta.json")
    assert meta["variant"] == "baseline" and meta["workflow"] == "single_call" and meta["mode"] == "live"
    assert meta["params"] == VARIANTS["baseline"]["params"] and meta["dataset_hash"] == dataset["hash"]
    assert meta["served_models"] == ["claude-opus-5-5-20261001"] and "git_sha" in meta
    assert meta["usage"]["total"]["calls"] == 3 and meta["usage"]["by_model"]["claude-opus-5-5-20261001"]["input_tokens"] == 3000
    raws = list((tmp_path / "runs" / "r" / "raw").glob("*.json"))
    assert len(raws) == 3
    body = json.loads(raws[0].read_text(encoding="utf-8"))
    assert body["request"]["params"]["model"] == "claude-opus-5-5" and body["response"]["raw"]["stop_reason"] == "end_turn"
    with pytest.raises(ValueError):
        runner.Runner(dataset, make_executor(tmp_path), tmp_path / "runs", cfg=CFG).run(VARIANTS["baseline"], dataset["cases"], "all", 2, run_id="r")


def test_reps_produce_separate_rows(tmp_path):
    ex, out = run_variant(tmp_path, reps=2, dataset=tiny_dataset(2))
    results = read(tmp_path, "r", "results.json")
    assert [(c["case_id"], c["rep"]) for c in results] == [("c1", 0), ("c1", 1), ("c2", 0), ("c2", 1)]


def test_batch_pending_file_is_resumed_instead_of_resubmitted(tmp_path):
    sdk = FakeAnthropic(batch_polls=100)
    ex = make_executor(tmp_path, sdk, "batch", max_wait=0.0)
    dataset = tiny_dataset()
    out = runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run(VARIANTS["baseline"], dataset["cases"], "all", 1, run_id="p")
    assert out["stopped"] and "did not end" in out["stopped"] and out["meta"]["n_rows"] == 0
    assert len(sdk.batches_created) == 1
    sdk.batch_polls = 0
    ex2 = make_executor(tmp_path, sdk, "batch")
    out2 = runner.Runner(dataset, ex2, tmp_path / "runs", cfg=CFG).run(VARIANTS["baseline"], dataset["cases"], "all", 1, run_id="p")
    assert len(sdk.batches_created) == 1 and out2["meta"]["status"] == "complete"


def test_max_spend_stops_between_stages_and_resumes_later(tmp_path):
    sdk = FakeAnthropic()
    ex = make_executor(tmp_path, sdk, max_spend=0.0001)
    dataset = tiny_dataset(2)
    out = runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run(VARIANTS["extract_then_judge"], dataset["cases"], "all", 1, run_id="s")
    assert out["stopped"] and "max-spend" in out["stopped"] and out["meta"]["n_rows"] == 0
    assert len(sdk.live_calls) == 2


def test_stage_api_empty_stage_still_reduces(tmp_path):
    class Probe(Workflow):
        stage_count = 2

        def stage(self, index, case, state):
            if index == 0:
                return Stage("a", [], lambda st, r: {**st, "a": True})
            return Stage("b", [], lambda st, r: {**st, "b": True})

        def finish(self, case, state):
            return {"case_id": case["id"], "variant": "p", "results": {}, "needs_review": {}, "calls": [], "refused": False, "error": None, "mode": None, "flags": [k for k in ("a", "b") if state.get(k)]}

    import evals.runner as r

    original = r.build_workflow
    r.build_workflow = lambda variant, cfg: Probe(cfg, variant["name"])
    try:
        dataset = tiny_dataset(2)
        ex = make_executor(tmp_path)
        out = runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run({"name": "p", "workflow": "x"}, dataset["cases"], "all", run_id="e")
    finally:
        r.build_workflow = original
    results = read(tmp_path, "e", "results.json")
    assert [c["flags"] for c in results] == [["a", "b"], ["a", "b"]] and ex.sdk.live_calls == []
