import json

import pytest

from evals import judge_run, runner
from evals.gen import assemble
from evals.ledger import BudgetError, Ledger, TokenEstimate
from scripts import eval as cli
from tests.test_eval_runner_fakes import CFG, FakeAnthropic, FakeJev, default_responder, tiny_dataset
from tests.test_eval_runner_workflows import explain_responder


def judge_responder(params):
    if "criteria" not in params["output_config"]["format"]["schema"]["properties"]:
        return default_responder(params)
    ids = [c.id for c in CFG.criteria]
    items = [
        {"criterion_id": i, "strengths": "s", "weaknesses": "none", "answer_correct": True, "reasoning_correct": True, "evidence_correct": True, "score": 10}
        for i in ids
    ]
    return json.dumps({"criteria": items})


class Env:
    def __init__(self, tmp_path, responder=default_responder, dataset=None):
        self.tmp = tmp_path
        self.dataset = dataset or tiny_dataset()
        self.dataset_path = tmp_path / "dataset.json"
        self.dataset_path.write_text(json.dumps(self.dataset), encoding="utf-8")
        self.ledger_path = tmp_path / "ledger.json"
        self.sdk = FakeAnthropic(responder)
        self.jev = FakeJev()
        self.factory_calls = 0

    def factory(self, cfg, mode, concurrency, max_spend, ledger):
        self.factory_calls += 1
        return runner.Executor(cfg, mode=mode, sdk=self.sdk, jev_client=self.jev, ledger=ledger, concurrency=2, max_spend=max_spend, sleep=lambda s: None, poll_initial=0)

    def args(self, *extra):
        return [*extra]

    def common(self):
        return ["--dataset", str(self.dataset_path), "--ledger", str(self.ledger_path), "--runs-dir", str(self.tmp / "runs")]

    def run(self, *argv):
        return cli.main(["run", *argv, *self.common()], self.factory)

    def judge(self, *argv):
        return cli.main(["judge", *argv, "--ledger", str(self.ledger_path), "--runs-dir", str(self.tmp / "runs"), "--dataset", str(self.dataset_path)], self.factory)

    def run_ids(self):
        return sorted(p.name for p in (self.tmp / "runs").iterdir())


def test_dry_run_sends_nothing_and_prints_plan(tmp_path, capsys):
    env = Env(tmp_path)
    assert env.run("baseline", "--split", "dev") == 0
    out = capsys.readouterr().out
    assert "dry run: nothing is sent" in out and "estimated total: $" in out and "remaining $10.0000" in out
    assert "baseline: workflow=single_call models=claude-opus-5-5 cases=2" in out and "mode: batch" in out
    assert env.factory_calls == 0 and env.sdk.live_calls == [] and env.sdk.batches_created == []
    assert not env.ledger_path.exists() and not (tmp_path / "runs").exists()


def test_execute_requires_max_spend_and_never_runs_without_execute(tmp_path, capsys):
    env = Env(tmp_path)
    assert env.run("baseline", "--execute") == 2
    assert "--max-spend is required" in capsys.readouterr().out
    assert env.factory_calls == 0 and not (tmp_path / "runs").exists()


def test_guard_refuses_when_estimate_exceeds_max_spend_or_remaining_budget(tmp_path, capsys):
    env = Env(tmp_path)
    assert env.run("baseline", "--execute", "--max-spend", "0.0001") == 2
    assert "exceeds --max-spend" in capsys.readouterr().out
    ledger = Ledger(env.ledger_path)
    ledger.append({"run_id": "old", "provider": "anthropic", "model": "claude-opus-5-5", "mode": "batch", "cost": 9.999})
    assert env.run("baseline", "--execute", "--max-spend", "5") == 2
    assert "remaining budget" in capsys.readouterr().out
    assert env.factory_calls == 0 and env.sdk.batches_created == []


def test_execute_runs_logs_ledger_and_resumes(tmp_path, capsys):
    env = Env(tmp_path)
    assert env.run("baseline", "--split", "all", "--mode", "live", "--execute", "--max-spend", "1") == 0
    out = capsys.readouterr().out
    assert "complete, rows 3/3" in out and "errors 0" in out
    (run_id,) = env.run_ids()
    summary = Ledger(env.ledger_path).summary()
    meta = json.loads((tmp_path / "runs" / run_id / "meta.json").read_text(encoding="utf-8"))
    assert summary["by_run"] == {run_id: pytest.approx(meta["cost_actual"], abs=1e-9)} and meta["cost_estimated"] > 0
    calls = len(env.sdk.live_calls)
    assert env.run("baseline", "--split", "all", "--mode", "live", "--execute", "--max-spend", "1", "--resume", run_id) == 0
    assert len(env.sdk.live_calls) == calls


def test_ledger_command_and_counting_rules(tmp_path, capsys):
    ledger = Ledger(tmp_path / "l.json")
    ledger.append({"run_id": "a", "provider": "anthropic", "model": "m", "mode": "batch", "cost": 1.5})
    ledger.append({"run_id": "a", "provider": "openrouter", "model": "typesafe/jev-1.14", "mode": "live", "cost": 0.25})
    ledger.append({"run_id": "gen", "provider": "openai", "model": "gpt-6.1-sol", "mode": "live", "cost": 3.0})
    assert ledger.spent() == 1.75 and ledger.remaining() == 8.25
    s = ledger.summary()
    assert s["by_provider"] == {"anthropic": 1.5, "openrouter": 0.25} and s["uncounted"] == {"openai": 3.0}
    assert cli.main(["ledger", "--ledger", str(tmp_path / "l.json")]) == 0
    out = capsys.readouterr().out
    assert "spent $1.7500, remaining $8.2500" in out and "openai: $3.0000" in out and "a: $1.7500" in out
    data = json.loads((tmp_path / "l.json").read_text(encoding="utf-8"))
    assert [e["counts"] for e in data["entries"]] == [True, True, False]
    with pytest.raises(BudgetError):
        ledger.check(9.0, 20.0)
    with pytest.raises(BudgetError):
        ledger.check(1.0, None)
    ledger.check(1.0, 2.0)


def test_budget_is_configurable_in_the_file(tmp_path):
    ledger = Ledger(tmp_path / "l.json")
    ledger.append({"run_id": "a", "provider": "anthropic", "cost": 1.0})
    data = ledger.load()
    data["budget"] = 1.5
    ledger.save(data)
    assert ledger.remaining() == 0.5
    with pytest.raises(BudgetError):
        ledger.check(0.6, 5.0)


def test_estimates_defaults_override_and_update_from_measured_runs(tmp_path):
    ledger = Ledger(tmp_path / "l.json")
    plan = [("single_call", "claude-opus-5-5", 1)]
    default = ledger.estimate_plan(plan, 10, "live")
    assert default == pytest.approx(10 * (1500 * 4 + 3300 * 0.2 + 1500 * 20) / 1e6, abs=1e-6)
    assert ledger.estimate_plan(plan, 10, "batch") == pytest.approx(default / 2, abs=1e-6)
    ledger.append({"run_id": "r", "group": "single_call", "provider": "anthropic", "model": "claude-opus-5-5", "mode": "batch", "requests": 2, "input_tokens": 2000, "output_tokens": 600, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost": 0.01})
    measured = ledger.estimate_plan(plan, 10, "live")
    assert measured == pytest.approx(10 * (1000 * 4 + 300 * 20) / 1e6, abs=1e-6)
    data = ledger.load()
    data["estimates"] = {"single_call": {"output": 100}}
    ledger.save(data)
    assert ledger.estimate_plan(plan, 10, "live") == pytest.approx(10 * (1000 * 4 + 100 * 20) / 1e6, abs=1e-6)
    assert ledger.token_estimate("single_call", "claude-sonnet-5-5") == TokenEstimate(1500, 3300, 0, 100)
    assert ledger.estimate_plan([("jev", "typesafe/jev-1.14", 1)], 10, "batch") == pytest.approx(10 * 3500 * 0.042 / 1e6, abs=1e-9)


def test_judge_dry_run_then_execute_batch_with_separate_cost(tmp_path, capsys):
    env = Env(tmp_path, judge_responder)
    assert env.run("baseline", "jev_only", "--split", "all", "--mode", "live", "--execute", "--max-spend", "1") == 0
    ids = env.run_ids()
    base = next(i for i in ids if "baseline" in i)
    jev_run = next(i for i in ids if "jev_only" in i)
    capsys.readouterr()
    assert env.judge(base) == 0
    assert "dry run" in capsys.readouterr().out and not (tmp_path / "runs" / base / "judge.json").exists()
    assert env.judge(base, "--execute", "--max-spend", "1") == 0
    judgements = json.loads((tmp_path / "runs" / base / "judge.json").read_text(encoding="utf-8"))
    assert sorted(judgements) == ["c1", "c2", "c3"] and judgements["c1"]["case_score"] == 10.0
    meta = json.loads((tmp_path / "runs" / base / "meta.json").read_text(encoding="utf-8"))
    assert meta["judge"]["cost_actual"] > 0 and meta["judge"]["mode"] == "batch" and meta["cost_actual"] != meta["judge"]["cost_actual"]
    assert meta["judge"]["served_models"] == ["claude-sonnet-5-5-20261001"]
    kinds = {e["kind"] for e in Ledger(env.ledger_path).load()["entries"]}
    assert kinds == {"run", "judge"}
    before = len(env.sdk.batches_created)
    assert env.judge(base, "--execute", "--max-spend", "1") == 0
    assert len(env.sdk.batches_created) == before
    assert jev_run


def test_judge_skips_errors_and_keeps_infra_errors_out_of_judge_json(tmp_path):
    env = Env(tmp_path, judge_responder)
    env.run("baseline", "--split", "all", "--mode", "live", "--execute", "--max-spend", "1")
    (run_id,) = env.run_ids()
    run_dir = tmp_path / "runs" / run_id
    results = json.loads((run_dir / "results.json").read_text(encoding="utf-8"))
    results[0]["error"] = "x"
    (run_dir / "results.json").write_text(json.dumps(results), encoding="utf-8")
    dataset = runner.load_dataset(env.dataset_path)
    sdk = FakeAnthropic(lambda p: Exception("down"))
    ex = runner.Executor(CFG, mode="live", sdk=sdk, ledger=Ledger(env.ledger_path), sleep=lambda s: None)
    out = judge_run.run_judge(run_dir, dataset, ex, CFG)
    assert set(out["errors"]) == {"c2", "c3"} and list(out["skipped"]) == ["c1"]
    assert json.loads((run_dir / "judge.json").read_text(encoding="utf-8")) == {}


def test_judge_refuses_wrong_dataset_version(tmp_path):
    env = Env(tmp_path, judge_responder)
    env.run("baseline", "--split", "all", "--mode", "live", "--execute", "--max-spend", "1")
    (run_id,) = env.run_ids()
    other = tiny_dataset(2)
    ex = runner.Executor(CFG, mode="live", sdk=env.sdk, sleep=lambda s: None)
    with pytest.raises(ValueError):
        judge_run.run_judge(tmp_path / "runs" / run_id, other, ex, CFG)


def test_report_leaderboard_with_dispute_rate_and_hash_guard(tmp_path, capsys):
    env = Env(tmp_path, lambda p: judge_responder(p) if "criteria" in p["output_config"]["format"]["schema"]["properties"] else explain_responder(dispute={"05": "Тон был грубым."})(p) if "disputed" in json.dumps(p["output_config"]["format"]["schema"]) else default_responder(p))
    assert env.run("baseline", "jev_sonnet", "--split", "all", "--mode", "live", "--execute", "--max-spend", "1") == 0
    ids = env.run_ids()
    assert env.judge(*ids, "--execute", "--max-spend", "1") == 0
    capsys.readouterr()
    common = ["--dataset", str(env.dataset_path), "--runs-dir", str(tmp_path / "runs")]
    assert cli.main(["report", *ids, *common, "--per-run"]) == 0
    out = capsys.readouterr().out
    assert "# Variant leaderboard" in out and "baseline" in out and "jev_sonnet" in out
    assert "Explainer dispute rate: 100.0%" not in out and "Explainer dispute rate" in out
    outfile = tmp_path / "r.md"
    assert cli.main(["report", ids[0], *common, "--out", str(outfile)]) == 0
    assert outfile.read_text(encoding="utf-8").startswith("# Eval report")
    meta_path = tmp_path / "runs" / ids[0] / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["dataset_hash"] = "other"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(SystemExit):
        cli.main(["report", *ids, *common])


def test_calibration_export_and_score(tmp_path, capsys):
    env = Env(tmp_path, judge_responder, tiny_dataset(3))
    env.run("baseline", "--split", "all", "--mode", "live", "--execute", "--max-spend", "1")
    (run_id,) = env.run_ids()
    env.judge(run_id, "--execute", "--max-spend", "1")
    out = tmp_path / "cal.json"
    common = ["--dataset", str(env.dataset_path), "--runs-dir", str(tmp_path / "runs")]
    assert cli.main(["calibrate-export", run_id, "--out", str(out), "--n", "6", *common]) == 0
    rows = json.loads(out.read_text(encoding="utf-8"))
    assert len(rows) == 6 and rows[0]["human"] == {"answer_correct": None, "reasoning_correct": None, "evidence_correct": None}
    assert cli.main(["calibrate-score", str(out)]) == 1
    for r in rows:
        r["human"] = dict(r["judge"] | {}) and {k: r["judge"][k] for k in ("answer_correct", "reasoning_correct", "evidence_correct")}
    out.write_text(json.dumps(rows), encoding="utf-8")
    assert cli.main(["calibrate-score", str(out)]) == 0


def test_blind_check_dry_run_guard_and_output_feeds_ingest_blind(tmp_path, capsys):
    dataset = tiny_dataset(2)
    env = Env(tmp_path, dataset=dataset)
    out_path = tmp_path / "blind.jsonl"
    argv = ["blind-check", "--dataset", str(env.dataset_path), "--ledger", str(env.ledger_path), "--runs-dir", str(tmp_path / "runs"), "--out", str(out_path)]
    assert cli.main(argv, env.factory) == 0
    assert "dry run" in capsys.readouterr().out and env.factory_calls == 0 and not out_path.exists()
    assert cli.main([*argv, "--execute"], env.factory) == 2 and env.factory_calls == 0

    def responder(params):
        ids = params["output_config"]["format"]["schema"]["properties"]["results"]["items"]["properties"]["criterion_id"]["enum"]
        items = [{"criterion_id": i, "answer": "yes" if i != "03" else "na", "rationale": "Оператор выполнил."} for i in ids]
        return json.dumps({"results": items}, ensure_ascii=False)

    env.sdk = FakeAnthropic(responder)
    assert cli.main([*argv, "--execute", "--max-spend", "1"], env.factory) == 0
    lines = out_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2 and {json.loads(l)["custom_id"] for l in lines} == {"c1", "c2"}
    assert env.sdk.batches_created and env.sdk.batches_created[0][0]["params"]["model"] == "claude-sonnet-5-5"
    cases = [dict(c, review={"status": "pending", "flags": []}) for c in dataset["cases"]]
    assert assemble.attach_blind(CFG, cases, lines) == []
    assert any("blind model answered" in f for c in cases for f in c["review"]["flags"])
    summary = Ledger(env.ledger_path).summary()
    assert len(summary["by_run"]) == 1 and next(iter(summary["by_run"])).endswith("-blind")


def test_cli_rejects_unknown_variant_and_missing_dataset(tmp_path):
    env = Env(tmp_path)
    with pytest.raises(SystemExit):
        env.run("nonsense")
    with pytest.raises(runner.DatasetError):
        cli.main(["run", "baseline", "--dataset", str(tmp_path / "none.json"), "--ledger", str(env.ledger_path)], env.factory)


def test_dataset_hash_is_verified(tmp_path):
    env = Env(tmp_path)
    data = json.loads(env.dataset_path.read_text(encoding="utf-8"))
    data["cases"][0]["tags"]["topic"] = "changed"
    env.dataset_path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(runner.DatasetError):
        env.run("baseline")
    assert env.run("baseline", "--allow-unverified") == 0


def test_select_cases_splits_and_limit():
    ds = tiny_dataset(3)
    assert [c["id"] for c in runner.select_cases(ds, "dev")] == ["c1", "c2"]
    assert [c["id"] for c in runner.select_cases(ds, "holdout")] == ["c3"]
    assert [c["id"] for c in runner.select_cases(ds, "all", 2)] == ["c1", "c2"]
    with pytest.raises(ValueError):
        runner.select_cases(ds, "bogus")


def test_cli_and_runner_sources_do_not_hardcode_network_or_secrets():
    for mod in (cli, runner):
        text = open(mod.__file__, encoding="utf-8").read()
        assert "api_key" not in text.lower().replace("llm_api_key", "")
        assert "os.environ" not in text
