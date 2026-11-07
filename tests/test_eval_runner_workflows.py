import json

from backend.app.core.config import Settings
from backend.app.services.evaluator import build_schema, build_system_prompt, build_user_prompt, run_evaluation
from backend.app.services.llm_client import LLMClient
from backend.app.services.model_profiles import get_profile
from evals import runner
from evals.graders import grade_run
from evals.ledger import Ledger
from evals.workflows import REGISTRY, build_workflow
from evals.workflows.base import Response, resolve_profile
from evals.workflows.review import repair_prompt, validate_pass
from tests.test_eval_runner_fakes import (
    CFG,
    RATIONALE,
    FakeAnthropic,
    FakeJev,
    default_responder,
    results_text,
    tiny_dataset,
)

VARIANTS = runner.load_variants()


def execute(tmp_path, name, responder=default_responder, mode="live", jev=None, reps=1, dataset=None):
    dataset = dataset or tiny_dataset()
    sdk = FakeAnthropic(responder)
    jev = jev or FakeJev()
    ex = runner.Executor(CFG, mode=mode, sdk=sdk, jev_client=jev, ledger=Ledger(tmp_path / "ledger.json"), concurrency=2, sleep=lambda s: None, poll_initial=0)
    out = runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run(VARIANTS[name], dataset["cases"], "all", reps, run_id=f"t-{name}")
    results = json.loads((tmp_path / "runs" / out["run_id"] / "results.json").read_text(encoding="utf-8"))
    return dataset, out, results, sdk, jev


def case_of(dataset, cid="c1"):
    return next(c for c in dataset["cases"] if c["id"] == cid)


def conv_messages(case):
    conv = case["conversation"]
    return {"channel": conv["channel"], "language": conv["language"]}, conv["messages"]


def test_registry_covers_variants():
    assert set(REGISTRY) == {"single_call", "per_criterion", "extract_then_judge", "jev_only", "jev_explain"}
    assert {v["workflow"] for v in VARIANTS.values()} == set(REGISTRY)
    for name in ("baseline", "opus_low", "sonnet_medium", "jev_only", "jev_sonnet", "jev_haiku", "extract_then_judge", "per_criterion"):
        assert name in VARIANTS
    base = VARIANTS["baseline"]
    assert base["params"] == {"prompt": "v1", "profile": "claude-opus-5-5", "effort": "medium"}


def test_single_call_stage1_request_equals_production_client_request():
    dataset = tiny_dataset()
    case = case_of(dataset)
    conv, messages = conv_messages(case)
    wf = build_workflow(VARIANTS["baseline"], CFG)
    state = wf.new_state(case)
    stage = wf.stage(0, case, state)
    assert len(stage.requests) == 1
    client = LLMClient(sdk=object(), settings=Settings(_env_file=None), profile=get_profile("claude-opus-5-5"))
    expected = client._request(build_system_prompt(CFG), [{"role": "user", "content": build_user_prompt(conv, messages)}], build_schema(CFG))
    assert stage.requests[0].params == expected
    assert json.loads(json.dumps(stage.requests[0].params)) == json.loads(json.dumps(expected))
    assert expected["output_config"]["effort"] == "medium" and "temperature" not in expected


def test_haiku_profile_has_no_effort_and_low_effort_applies():
    assert resolve_profile("claude-haiku-4-5", "high").effort is None
    dataset = tiny_dataset()
    case = case_of(dataset)
    low = build_workflow(VARIANTS["opus_low"], CFG).stage(0, case, {"calls": []}).requests[0].params
    assert low["output_config"]["effort"] == "low"
    sonnet = build_workflow(VARIANTS["sonnet_medium"], CFG).stage(0, case, {"calls": []}).requests[0].params
    assert sonnet["model"] == "claude-sonnet-5-5"


class ProductionFake:
    def __init__(self, texts):
        self.texts = list(texts)
        self.calls = []
        from types import SimpleNamespace

        self.messages = SimpleNamespace(create=self.create)

    def create(self, **kwargs):
        from tests.test_eval_runner_fakes import message

        self.calls.append(kwargs)
        return message(self.texts.pop(0), kwargs, model=kwargs["model"])


def test_single_call_repair_matches_production_run_evaluation(tmp_path):
    dataset = tiny_dataset()
    case = case_of(dataset)
    conv, messages = conv_messages(case)
    ids = [c.id for c in CFG.criteria]
    broken = json.loads(results_text(ids))
    broken["results"][0]["quote_bad"] = 1
    broken["results"][1]["evidence"] = [{"message_index": 0, "quote": "not in the message at all"}]
    first_text = json.dumps(broken, ensure_ascii=False)
    fix = results_text(["02"])
    texts = [first_text, fix]

    prod_sdk = ProductionFake(texts)
    client = LLMClient(sdk=prod_sdk, settings=Settings(_env_file=None), profile=get_profile("claude-opus-5-5"))
    outcome = run_evaluation(client, CFG, conv, messages)
    assert len(prod_sdk.calls) == 2

    replies = {"n": 0}

    def responder(params):
        replies["n"] += 1
        return texts[replies["n"] - 1]

    _, out, results, sdk, _ = execute(tmp_path, "baseline", responder, dataset=tiny_dataset(1))
    assert [json.dumps(c, sort_keys=True) for c in sdk.live_calls[:2]] == [
        json.dumps({**c, "timeout": sdk.live_calls[i]["timeout"]}, sort_keys=True) for i, c in enumerate(prod_sdk.calls)
    ]
    cand = results[0]
    assert set(cand["results"]) == set(outcome.results)
    assert cand["needs_review"] == outcome.review
    assert len(cand["calls"]) == 2 and [c["stage"] for c in cand["calls"]] == ["first", "repair"]


def test_validate_pass_equals_production_validate_pass():
    from backend.app.services.evaluator import _validate_pass

    dataset = tiny_dataset()
    messages = case_of(dataset)["conversation"]["messages"]
    ids = [c.id for c in CFG.criteria]
    broken = json.loads(results_text(ids))
    broken["results"][3]["answer"] = "7"
    text = json.dumps(broken, ensure_ascii=False)
    assert validate_pass(CFG, text, messages, ids) == _validate_pass(CFG, text, messages, ids)
    assert "Return corrected results for ONLY these criteria" in repair_prompt({"04": ["x"]})


def test_single_call_end_to_end_and_oracle_scoring(tmp_path):
    dataset, out, results, sdk, _ = execute(tmp_path, "baseline")
    assert out["meta"]["status"] == "complete" and out["n_errors"] == 0
    assert len(results) == 3 and all(len(c["calls"]) == 1 for c in results)
    cand = results[0]
    assert cand["mode"] == "live" and cand["refused"] is False and cand["error"] is None and cand["needs_review"] == {}
    call = cand["calls"][0]
    assert call["model"] == "claude-opus-5-5-20261001" and call["structured"] is True and call["stop_reason"] == "end_turn"
    assert call["input_tokens"] == 1000 and call["latency_ms"] is not None and call["status"] == "ok"
    graded = grade_run(dataset, results, CFG)
    assert graded["validity"]["n_ok"] == 3 and graded["validity"]["repair_turn_rate"] == 0.0


def test_per_criterion_end_to_end_and_prompt_layout(tmp_path):
    dataset, out, results, sdk, _ = execute(tmp_path, "per_criterion")
    assert all(len(c["calls"]) == 8 for c in results)
    assert len(sdk.live_calls) == 24
    assert set(results[0]["results"]) == {c.id for c in CFG.criteria}
    req = sdk.live_calls[0]
    system = req["system"][0]["text"]
    assert "Criterion 0" not in system and "Checklist" not in system
    blocks = req["messages"][0]["content"]
    assert blocks[0]["cache_control"] == {"type": "ephemeral"} and "Transcript:" in blocks[0]["text"]
    assert "cache_control" not in blocks[1] and "Criterion to evaluate now" in blocks[1]["text"]
    transcripts = {json.dumps(c["messages"][0]["content"][0]) for c in sdk.live_calls[:24] if "hello there, how can I help" in json.dumps(c["messages"][0]["content"][0])}
    assert len(transcripts) <= 3
    schemas = {json.dumps(c["output_config"]["format"]["schema"]["properties"]["results"]["items"]["properties"]["criterion_id"]["enum"]) for c in sdk.live_calls}
    assert len(schemas) == 8
    assert out["meta"]["expected_calls"] == 8


def test_per_criterion_repair_only_for_bad_criteria(tmp_path):
    seen = {"bad": 0}

    def responder(params):
        ids = params["output_config"]["format"]["schema"]["properties"]["results"]["items"]["properties"]["criterion_id"]["enum"]
        text = results_text(ids)
        if ids == ["04"] and seen["bad"] == 0:
            seen["bad"] += 1
            return text.replace('"20"', '"7"')
        return text

    _, out, results, sdk, _ = execute(tmp_path, "per_criterion", responder, dataset=tiny_dataset(1))
    cand = results[0]
    assert len(cand["calls"]) == 9 and cand["needs_review"] == {} and "04" in cand["results"]


def test_extract_then_judge_end_to_end(tmp_path):
    dataset, out, results, sdk, _ = execute(tmp_path, "extract_then_judge", dataset=tiny_dataset(1))
    cand = results[0]
    assert [c["stage"] for c in cand["calls"]] == ["extract", "first"]
    extract_req, judge_req = sdk.live_calls
    assert extract_req["output_config"]["effort"] == "low"
    assert "events" in extract_req["output_config"]["format"]["schema"]["properties"]
    user = judge_req["messages"][0]["content"]
    assert "Extracted facts" in user and user.endswith("Evaluate every criterion now.")
    assert judge_req["system"][0]["text"] == build_system_prompt(CFG)
    assert judge_req["output_config"]["format"]["schema"] == build_schema(CFG)
    assert cand["facts"]["events"] == [{"message_index": 1, "kind": "other", "note": "x"}]
    assert any("unknown message_index" in i for i in cand["fact_issues"])
    assert out["meta"]["expected_calls"] == 2


def test_extract_failure_still_judges_without_facts(tmp_path):
    def responder(params):
        if "events" in params["output_config"]["format"]["schema"]["properties"]:
            return ("{", "max_tokens")
        return default_responder(params)

    _, _, results, sdk, _ = execute(tmp_path, "extract_then_judge", responder, dataset=tiny_dataset(1))
    cand = results[0]
    assert cand["facts"] is None and "Extracted facts" not in sdk.live_calls[1]["messages"][0]["content"]
    assert cand["calls"][0]["status"] == "truncated" and len(cand["results"]) == 8


def test_jev_only_end_to_end(tmp_path):
    dataset, out, results, sdk, jev = execute(tmp_path, "jev_only", mode="batch")
    assert sdk.live_calls == [] and sdk.batches_created == [] and len(jev.calls) == 3
    cand = results[0]
    assert cand["explained"] is False and cand["mode"] == "live"
    row = cand["results"]["04"]
    assert row["answer"] == 20 and row["rationale"] == "" and row["evidence"] == [] and row["unexplained"] is True
    assert isinstance(row["confidence"], float) and "distribution" in row
    assert cand["results"]["08"]["answer"] == "no"
    call = cand["calls"][0]
    assert call["model"] == "typesafe/jev-1.14" and call["cost"] == round(3000 * 0.042 / 1e6, 6) and call["provider"] == "jev"
    graded = grade_run(dataset, results, CFG)
    assert graded["validity"]["n_ok"] == 3 and graded["validity"]["needs_review_rate"] == 0.0
    assert any(r["n"] for r in graded["calibration"])


def fixed_from(params):
    text = params["messages"][0]["content"]
    return json.loads(text.split("Fixed answers (do not change):\n")[1].split("\n\nExplain")[0])


def explain_responder(overrides=None, dispute=None):
    def responder(params):
        item = params["output_config"]["format"]["schema"]["properties"]["results"]["items"]
        ids = item["properties"]["criterion_id"]["enum"]
        answers = {**fixed_from(params), **(overrides or {})}
        data = json.loads(results_text(ids, {"disputed": False, "dispute_reason": None}, answers))
        for it in data["results"]:
            if dispute and it["criterion_id"] in dispute:
                it["disputed"], it["dispute_reason"] = True, dispute[it["criterion_id"]]
        return json.dumps(data, ensure_ascii=False)

    return responder


def test_jev_explain_end_to_end_with_dispute_and_fixed_answer(tmp_path):
    dataset, out, results, sdk, jev = execute(
        tmp_path, "jev_sonnet", explain_responder(dispute={"05": "Тон оператора был грубым."}), mode="batch", dataset=tiny_dataset(1)
    )
    cand = results[0]
    assert cand["disputes"] == {"05": "Тон оператора был грубым."}
    assert cand["results"]["05"]["disputed"] is True and cand["results"]["05"]["answer"] == "yes"
    assert cand["explained"] is True and cand["jev_answers"]["04"] == "20"
    assert cand["results"]["01"]["rationale"] == RATIONALE and cand["results"]["01"]["confidence"] is not None
    assert [c["stage"] for c in cand["calls"]] == ["jev", "first"]
    req = sdk.batches_created[0][0]["params"]
    assert "FIXED" in req["system"][0]["text"] and "Fixed answers" in req["messages"][0]["content"]
    props = req["output_config"]["format"]["schema"]["properties"]["results"]["items"]
    assert "disputed" in props["required"] and "dispute_reason" in props["required"]
    assert cand["mode"] == "batch"


def test_jev_explain_changed_answer_triggers_repair_and_dispute_without_evidence_is_lenient(tmp_path):
    state = {"n": 0}

    def responder(params):
        state["n"] += 1
        item = params["output_config"]["format"]["schema"]["properties"]["results"]["items"]
        ids = item["properties"]["criterion_id"]["enum"]
        if state["n"] == 1:
            return explain_responder(overrides={"01": "no"})(params)
        data = json.loads(explain_responder()(params))
        for it in data["results"]:
            if it["criterion_id"] == "01":
                it["answer"] = "yes"
        return json.dumps(data, ensure_ascii=False)

    _, _, results, sdk, _ = execute(tmp_path, "jev_haiku", responder, dataset=tiny_dataset(1))
    cand = results[0]
    assert [c["stage"] for c in cand["calls"]] == ["jev", "first", "repair"]
    assert cand["results"]["01"]["answer"] == "yes" and cand["needs_review"] == {}
    assert "may not be changed" in sdk.live_calls[1]["messages"][-1]["content"]
    assert "effort" not in sdk.live_calls[0]["output_config"]

    def dispute_no_evidence(params):
        data = json.loads(explain_responder()(params))
        for it in data["results"]:
            if it["criterion_id"] == "02":
                it.update(disputed=True, dispute_reason="Нет подтверждения в тексте.", evidence=[])
        return json.dumps(data, ensure_ascii=False)

    _, _, results, _, _ = execute(tmp_path / "second", "jev_haiku", dispute_no_evidence, dataset=tiny_dataset(1))
    row = results[0]["results"]["02"]
    assert row["disputed"] is True and row["evidence"] == [] and results[0]["disputes"]["02"]


def test_refusal_and_truncation_are_explicit_not_errors(tmp_path):
    state = {"n": 0}

    def responder(params):
        state["n"] += 1
        if state["n"] == 1:
            return ("", "refusal")
        if state["n"] == 2:
            return ('{"results": [', "max_tokens")
        if state["n"] == 3:
            return ('{"results": [', "max_tokens")
        return default_responder(params)

    dataset, out, results, sdk, _ = execute(tmp_path, "baseline", responder, dataset=tiny_dataset(2))
    by_case = {c["case_id"]: c for c in results}
    refused = by_case["c1"]
    assert refused["refused"] is True and refused["calls"][0]["status"] == "refused" and refused["calls"][0]["stop_reason"] == "refusal"
    assert set(refused["needs_review"]) == {c.id for c in CFG.criteria} and refused["results"] == {}
    truncated = by_case["c2"]
    assert truncated["calls"][0]["status"] == "truncated" and truncated["calls"][0]["truncated"] is True
    assert truncated["calls"][0]["stop_reason"] == "max_tokens"
    assert out["n_errors"] == 0
    graded = grade_run(dataset, results, CFG)
    assert graded["validity"]["n_refused"] == 1 and graded["validity"]["truncation_rate"] > 0


def test_response_properties():
    assert Response("a", "refused").refused and Response("a", "truncated").truncated
