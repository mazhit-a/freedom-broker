import json

import pytest

from backend.app.services.evaluator import build_system_prompt, build_user_prompt
from evals import report, runner
from evals.decisions import JEV_MODEL
from evals.gen import openai_provider as op
from evals.ledger import Ledger
from evals.workflows import build_workflow
from evals.workflows import jev_sol_hybrid as hyb
from evals.workflows.base import InfrastructureError
from evals.workflows.prompts import build_system_prompt_xml, build_user_prompt_xml
from tests.test_eval_gen_openai import FakeClient, response
from tests.test_eval_runner_cli import Env
from tests.test_eval_runner_fakes import CFG, FakeAnthropic, FakeJev, good_item, tiny_dataset
from tests.test_eval_openai_scoring import USAGE, VARIANTS, read

JEV_IDS = ["01", "05", "08"]
SOL_IDS = ["02", "03", "04", "06", "07"]
MARK = "=== FIXED CLASSIFICATIONS"


def fixed_in(user_text):
    body = user_text.split("(criterion id: fixed answer) ===\n")[1].split("\n=== END")[0]
    return dict(line.split(": ", 1) for line in body.splitlines())


def sol_handler(overrides=None, dispute=None, wrong=None):
    def handler(n, kwargs):
        ids = kwargs["text"]["format"]["schema"]["properties"]["results"]["items"]["properties"]["criterion_id"]["enum"]
        user = kwargs["input"][0]["content"]
        fixed = fixed_in(user) if MARK in user else {}
        items = []
        for c in CFG.criteria:
            if c.id not in ids:
                continue
            answer = {**fixed, **(overrides or {})}.get(c.id)
            if wrong and n == 1 and c.id in wrong:
                answer = wrong[c.id]
            item = good_item(c, answer)
            item.update(disputed=False, dispute_reason=None)
            if dispute and c.id in dispute:
                item.update(disputed=True, dispute_reason=dispute[c.id], evidence=[], checked_range=None)
            items.append(item)
        return response(json.dumps({"results": items}, ensure_ascii=False), usage=USAGE)

    return handler


def make_env(tmp_path, client, jev=None):
    ex = runner.Executor(
        CFG, mode="live", sdk=FakeAnthropic(), jev_client=jev or FakeJev(), openai_client=client,
        ledger=Ledger(tmp_path / "ledger.json"), concurrency=2, sleep=lambda s: None, poll_initial=0,
    )
    return ex


def run(tmp_path, client, name="jev_sol_hybrid", jev=None, variant=None, dataset=None):
    dataset = dataset or tiny_dataset(1)
    ex = make_env(tmp_path, client, jev)
    out = runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run(variant or VARIANTS[name], dataset["cases"], "all", 1, run_id="h")
    return ex, out, dataset


def stage_requests(name="jev_sol_hybrid", variant=None):
    case = tiny_dataset(1)["cases"][0]
    wf = build_workflow(variant or VARIANTS[name], CFG)
    state = wf.new_state(case)
    return wf, case, state


def fake_jev_state(wf, answers=None):
    answers = answers or {cid: {"answer": "yes", "confidence": 0.9, "distribution": {"yes": 0.9}} for cid in wf.jev_ids}
    return answers


def test_variants_registered_and_existing_unchanged():
    assert VARIANTS["jev_sol_hybrid"] == {
        "name": "jev_sol_hybrid",
        "workflow": "jev_sol_hybrid",
        "params": {"prompt": "v2", "model": "gpt-6.1-sol", "effort": "medium"},
    }
    assert "jev_sol_hybrid_t02" not in VARIANTS and "jev_sol_hybrid" in VARIANTS
    assert VARIANTS["gpt_sol_medium"]["workflow"] == "openai_single_call"
    assert VARIANTS["jev_sonnet"]["workflow"] == "jev_explain"


def test_split_by_type_and_na_allowed_for_v2_and_synthetic_checklist():
    wf, case, _ = stage_requests()
    assert wf.jev_ids == JEV_IDS and [c.id for c in CFG.criteria if c.id not in wf.jev_ids] == SOL_IDS
    cfg = CFG.model_copy(deep=True)
    by_id = {c.id: c for c in cfg.criteria}
    picked = [by_id["04"], by_id["02"], by_id["01"], by_id["06"], by_id["08"], by_id["05"]]
    for c, new in zip(picked, ["z9", "n2", "k1", "m3", "f8", "p2"]):
        c.id = new
    by_new = {c.id: c for c in picked}
    by_new["n2"].na_allowed = False
    by_new["p2"].na_allowed = True
    by_new["m3"].na_allowed = True
    cfg.criteria = picked
    wf2 = build_workflow(VARIANTS["jev_sol_hybrid"], cfg)
    assert wf2.jev_ids == ["n2", "k1", "f8"]
    payload = wf2.stage(0, case, wf2.new_state(case)).requests[0].params
    assert list(payload["questions"]) == ["q_n2", "q_k1", "q_f8"]


def test_jev_request_has_only_strict_yes_no_and_flag_questions():
    wf, case, state = stage_requests()
    req = wf.stage(0, case, state).requests[0]
    assert req.kind == "jev" and req.profile == JEV_MODEL and req.request_id == "jev"
    assert list(req.params["questions"]) == [f"q_{c}" for c in JEV_IDS]
    assert all(f"q_{c}" not in req.params["questions"] for c in SOL_IDS)
    assert all("na" not in q["criteria"] for q in req.params["questions"].values() if q["type"] == "choice")


def test_bad_params_rejected():
    for params in ({"prompt": "nope"}, {"effort": "turbo"}):
        with pytest.raises((ValueError, KeyError)):
            build_workflow({"name": "x", "workflow": "jev_sol_hybrid", "params": params}, CFG)


def test_sol_request_has_fixed_block_extended_schema_and_no_temperature():
    wf, case, state = stage_requests()
    wf.stage(0, case, state).reduce(state, {"jev": type("R", (), {"data": {"answers": fake_jev_state(wf)}, "request_id": "jev", "status": "ok", "kind": "jev", "model": JEV_MODEL, "input_tokens": 1, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "latency_ms": 1, "cost": 0.0, "structured": False, "stop_reason": None, "truncated": False, "batch": False, "attempts": 1})()})
    req = wf.stage(1, case, state).requests[0]
    p = req.params
    assert req.kind == "openai" and req.group == "openai_single_call" and req.request_id == "main"
    assert "temperature" not in p and p["store"] is False and p["model"] == "gpt-6.1-sol" and p["reasoning"] == {"effort": "medium"}
    user = p["input"][0]["content"]
    assert user.startswith(build_user_prompt({"channel": case["conversation"].get("channel"), "language": case["conversation"].get("language")}, case["conversation"]["messages"]))
    assert fixed_in(user) == {cid: "yes" for cid in JEV_IDS} and "confidence" not in user.split(MARK)[1]
    assert p["instructions"].startswith(hyb.PROMPTS["v2"][0](CFG)) and p["instructions"].endswith(hyb.FIXED_RULES)
    item = p["text"]["format"]["schema"]["properties"]["results"]["items"]
    assert item["properties"]["disputed"] == {"type": "boolean"} and item["properties"]["dispute_reason"] == {"type": ["string", "null"]}
    assert item["required"][-2:] == ["disputed", "dispute_reason"] and set(item["required"]) == set(item["properties"])
    assert op.strict_problems(p["text"]["format"]["schema"]) == []


def test_show_confidence_adds_confidence_to_block():
    variant = {**VARIANTS["jev_sol_hybrid"], "params": {**VARIANTS["jev_sol_hybrid"]["params"], "show_confidence": True}}
    wf, case, state = stage_requests(variant=variant)
    state["jev_answers"] = fake_jev_state(wf)
    user = wf.stage(1, case, state).requests[0].params["input"][0]["content"]
    assert "01: yes (decision model confidence 0.90)" in user


def test_xml_prompt_appends_section_inside_tags():
    variant = {"name": "x", "workflow": "jev_sol_hybrid", "params": {"prompt": "v3_xml", "model": "gpt-6.1-sol", "effort": "medium"}}
    wf, case, state = stage_requests(variant=variant)
    state["jev_answers"] = fake_jev_state(wf)
    p = wf.stage(1, case, state).requests[0].params
    assert p["instructions"] == build_system_prompt_xml(CFG) + "\n\n<fixed_classification_rules>\n" + hyb.FIXED_RULES + "\n</fixed_classification_rules>"
    user = p["input"][0]["content"]
    assert "<fixed_classifications>\n01: yes\n" in user and user.endswith("08: yes\n</fixed_classifications>")
    assert MARK not in user and "<transcript>" in user
    tie = {"name": "t", "workflow": "jev_sol_hybrid", "params": {"prompt": "v3_tiebreak"}}
    wf, case, state = stage_requests(variant=tie)
    state["jev_answers"] = fake_jev_state(wf)
    t = wf.stage(1, case, state).requests[0].params
    assert t["instructions"].endswith(hyb.FIXED_RULES) and "highest step" in t["instructions"] and MARK in t["input"][0]["content"]


def test_unusable_jev_answer_is_infrastructure_error_not_default():
    wf, case, state = stage_requests()
    state["jev_answers"] = {cid: {"answer": "maybe"} for cid in wf.jev_ids}
    with pytest.raises(InfrastructureError):
        wf.stage(1, case, state)
    state["jev_answers"] = {"01": {"answer": "yes"}}
    with pytest.raises(InfrastructureError):
        wf.stage(1, case, state)


def test_full_case_end_to_end_and_accounting(tmp_path):
    client = FakeClient(sol_handler())
    jev = FakeJev()
    ex, out, dataset = run(tmp_path, client, jev=jev)
    assert out["n_errors"] == 0 and out["meta"]["status"] == "complete" and out["meta"]["expected_calls"] == 2
    cand = read(tmp_path, "h", "results.json")[0]
    assert len(jev.calls) == 1 and len(client.calls) == 1
    assert [c["stage"] for c in cand["calls"]] == ["jev", "first"]
    assert [c["provider"] for c in cand["calls"]] == ["jev", "openai"]
    assert cand["source"] == {**{c: "jev" for c in JEV_IDS}, **{c: "sol" for c in SOL_IDS}}
    assert {k for k, v in cand["source"].items() if v == "jev"} == set(JEV_IDS)
    assert cand["disputes"] == {} and set(cand["jev_detail"]) == set(JEV_IDS)
    assert cand["jev_detail"]["01"]["confidence"] is not None and cand["results"]["01"]["rationale"]
    assert cand["needs_review"] == {} and set(cand["results"]) == {c.id for c in CFG.criteria}
    ledger = Ledger(tmp_path / "ledger.json")
    providers = {e["provider"]: e for e in ledger.load()["entries"]}
    assert set(providers) == {"openrouter", "openai"} and providers["openrouter"]["counts"] and not providers["openai"]["counts"]
    assert ledger.spent() == providers["openrouter"]["cost"] > 0 and ledger.summary()["openai"] == providers["openai"]["cost"] > 0
    assert ex.openai_spent > 0 and ex.spent == providers["openrouter"]["cost"]
    assert cand["calls"][1]["cost"] == providers["openai"]["cost"]
    summary = report.summarize_run({"dataset": dataset, "candidates": [cand], "expected_calls": 2}, CFG)
    assert summary["sources"] == {"n_candidates": 1, "jev": 3, "sol": 5}
    assert summary["disputes"] == {"n_candidates": 1, "disputed": 0, "criteria": 3, "rate": 0.0}
    text = report.run_report({"dataset": dataset, "candidates": [cand], "expected_calls": 2}, CFG)
    assert "Answer source: jev 3, sol 5 criteria in 1 candidates" in text


def test_fixed_answer_mismatch_triggers_repair(tmp_path):
    client = FakeClient(sol_handler(wrong={"01": "no"}))
    run(tmp_path, client)
    cand = read(tmp_path, "h", "results.json")[0]
    assert len(client.calls) == 2 and [c["stage"] for c in cand["calls"]] == ["jev", "first", "repair"]
    repair = client.calls[1]["input"][-1]["content"]
    assert "01" in repair and "may not be changed" in repair
    assert cand["results"]["01"]["answer"] == "yes" and cand["needs_review"] == {}
    assert cand["source"]["01"] == "jev"


def test_dispute_keeps_jev_answer_and_records_dispute(tmp_path):
    client = FakeClient(sol_handler(dispute={"05": "Оператор был груб."}))
    run(tmp_path, client)
    cand = read(tmp_path, "h", "results.json")[0]
    assert cand["disputes"] == {"05": "Оператор был груб."}
    row = cand["results"]["05"]
    assert row["answer"] == cand["jev_detail"]["05"]["answer"] and row["disputed"] is True and row["evidence"] == []
    assert len(client.calls) == 1 and cand["needs_review"] == {}
    s = report.summarize_run({"dataset": tiny_dataset(1), "candidates": [cand], "expected_calls": 2}, CFG)
    assert s["disputes"]["disputed"] == 1 and s["disputes"]["rate"] == pytest.approx(1 / 3)


def test_dispute_on_self_decided_criterion_is_a_validation_error(tmp_path):
    def handler(n, kwargs):
        data = json.loads(sol_handler()(n, kwargs).output[1].content[0].text)
        if n == 1:
            for it in data["results"]:
                if it["criterion_id"] == "04":
                    it.update(disputed=True, dispute_reason="x")
        return response(json.dumps(data, ensure_ascii=False), usage=USAGE)

    client = FakeClient(handler)
    run(tmp_path, client)
    cand = read(tmp_path, "h", "results.json")[0]
    assert len(client.calls) == 2 and cand["disputes"] == {} and cand["needs_review"] == {}
    assert "disputed must be false" in client.calls[1]["input"][-1]["content"]


def test_jev_failure_is_infrastructure_error_and_sol_not_called(tmp_path):
    client = FakeClient(sol_handler())
    _, out, _ = run(tmp_path, client, jev=FakeJev(fail=True))
    assert out["n_errors"] == 1 and client.calls == []
    errors = read(tmp_path, "h", "errors.json")
    assert errors[0]["kind"] == "infrastructure" and errors[0]["stage"] == "jev"
    assert read(tmp_path, "h", "results.json") == []


def test_unusable_jev_answer_in_runner_is_infrastructure_error(tmp_path, monkeypatch):
    client = FakeClient(sol_handler())
    monkeypatch.setattr(hyb, "jev_rows", lambda cfg, answers, criteria=None: ({}, {"01": "bad"}))
    _, out, _ = run(tmp_path, client)
    assert out["n_errors"] == 1 and client.calls == []
    errors = read(tmp_path, "h", "errors.json")
    assert errors[0]["kind"] == "infrastructure" and "decision model answer unusable" in errors[0]["error"]
    assert read(tmp_path, "h", "results.json") == []


def test_estimate_plan_lists_both_providers():
    wf = build_workflow(VARIANTS["jev_sol_hybrid"], CFG)
    assert wf.estimate_plan() == [("jev", JEV_MODEL, 1), ("openai_single_call", "gpt-6.1-sol", 1)]
    assert wf.expected_calls() == 2 and wf.served_models() == [JEV_MODEL, "gpt-6.1-sol"]


def test_dry_run_shows_both_spends(tmp_path, capsys):
    name = "jev_sol_hybrid"
    env = Env(tmp_path)
    assert env.run(name, "--split", "dev") == 0
    out = capsys.readouterr().out
    assert "estimated OpenAI total: $" in out and "estimated total: $" in out and f"{name}: workflow=jev_sol_hybrid" in out
    assert JEV_MODEL in out and "gpt-6.1-sol" in out
    assert env.factory_calls == 0
    print(out)


def test_flag_scope_selects_only_flag_criteria_by_type():
    from evals.graders import load_checklist
    from evals.workflows.jev_sol_hybrid import jev_criteria

    cfg = load_checklist()
    assert [c.id for c in jev_criteria(cfg, "flag")] == ["08"]
    assert [c.id for c in jev_criteria(cfg)] == ["01", "05", "08"]


def test_unknown_scope_is_rejected_and_variant_is_registered():
    import json

    import pytest

    from evals.graders import load_checklist
    from evals.workflows import build_workflow
    from evals.workflows.jev_sol_hybrid import jev_criteria

    cfg = load_checklist()
    with pytest.raises(ValueError):
        jev_criteria(cfg, "everything")
    variants = {v["name"]: v for v in json.load(open("evals/variants.json"))}
    wf = build_workflow(variants["jev_sol_flag"], cfg)
    assert wf.jev_ids == ["08"] and wf.jev_scope == "flag"
    assert build_workflow(variants["jev_sol_hybrid"], cfg).jev_ids == ["01", "05", "08"]
