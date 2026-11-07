import copy
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.schemas.checklist import Criterion
from evals import compiler, runner
from evals.compiler import (
    COMPILER_MODEL,
    CompiledError,
    PRINCIPLES_V1,
    assemble,
    build_request,
    compile_checklist,
    compile_criterion,
    load_compiled,
    system_prompt,
    validate_spec,
    write_compiled,
)
from evals.decisions import (
    RULES_HEADER,
    DecisionsError,
    build_questions,
    build_request as jev_request,
    map_answers,
    specs_for_questions,
)
from evals.ledger import Ledger
from evals.workflows import build_workflow
from scripts import eval as cli
from tests.test_eval_jev_obs import gapped_conv
from tests.test_eval_runner_fakes import CFG, FakeAnthropic, FakeJev, tiny_dataset

ROOT = Path(__file__).resolve().parent.parent
VARIANTS = runner.load_variants()
CRIT = {c.id: c for c in CFG.criteria}


def crit(kind, na=False, steps=(0, 5, 10)):
    return Criterion(
        id="x1",
        title="Тест",
        description="Описание критерия.",
        type=kind,
        na_allowed=na,
        na_condition="Условие N/A." if na else None,
        scale_steps=[{"value": v, "descriptor": f"Шаг {v}."} for v in steps] if kind == "scale" else [],
        weight=0 if kind == "flag" else 10,
    )


SHAPES = {
    "yes_no": crit("yes_no"),
    "yes_no_na": crit("yes_no", na=True),
    "scale": crit("scale"),
    "scale_na": crit("scale", na=True),
    "flag": crit("flag"),
}


def good_spec(c, pause=False):
    if c.type == "flag":
        options = [
            {"key": "true", "text": "Нарушение есть.", "maps_to": "yes"},
            {"key": "false", "text": "Нарушения нет.", "maps_to": "no"},
        ]
        return {"jev_type": "noul", "instructions": f"Вопрос {c.id}.", "options": options, "needs_pause_marks": pause}
    if c.type == "scale":
        options = [{"key": f"s{s.value}", "text": s.descriptor, "maps_to": str(s.value)} for s in c.scale_steps]
    else:
        options = [{"key": "da", "text": "Да.", "maps_to": "yes"}, {"key": "net", "text": "Нет.", "maps_to": "no"}]
    if c.na_allowed:
        options.append({"key": "nd", "text": "N/A.", "maps_to": "na"})
    return {"jev_type": "choice", "instructions": f"Вопрос {c.id}.", "options": options, "needs_pause_marks": pause}


def criterion_id(params):
    return re.search(r'"id": "([^"]+)"', params["messages"][0]["content"]).group(1)


def responder(pause_ids=(), bad_first=None, always_bad=None, calls=None):
    def respond(params):
        if calls is not None:
            calls.append(params)
        cid = criterion_id(params)
        repair = len(params["messages"]) > 1
        spec = good_spec(CRIT[cid], pause=cid in pause_ids)
        if always_bad and cid in always_bad:
            spec["options"] = spec["options"][:-1]
            return json.dumps(spec, ensure_ascii=False)
        if bad_first and cid in bad_first and not repair:
            spec["options"] = spec["options"][:-1]
        return json.dumps(spec, ensure_ascii=False)

    return respond


def compile_with(tmp_path, compiler_name="naive", **kw):
    sdk = FakeAnthropic(responder(**kw))
    ledger = Ledger(tmp_path / "ledger.json")
    data = compile_checklist(CFG, compiler_name, sdk, ledger, "compile-test", None, 2, sleep=lambda s: None)
    return data, sdk, ledger


def test_request_shape_structured_and_one_per_criterion():
    reqs = [build_request(c, "naive") for c in CFG.criteria]
    assert len(reqs) == len(CFG.criteria)
    for c, r in zip(CFG.criteria, reqs):
        assert r["model"] == COMPILER_MODEL
        assert r["output_config"]["effort"] == "medium"
        fmt = r["output_config"]["format"]
        assert fmt["type"] == "json_schema"
        assert fmt["schema"]["required"] == ["jev_type", "instructions", "options", "needs_pause_marks"]
        assert fmt["schema"]["additionalProperties"] is False
        assert len(r["messages"]) == 1 and r["messages"][0]["role"] == "user"
        assert f'"id": "{c.id}"' in r["messages"][0]["content"]
        assert c.title in r["messages"][0]["content"]


def test_request_sends_exactly_the_criterion_fields():
    msg = build_request(CRIT["04"], "naive")["messages"][0]["content"]
    payload = json.loads(msg.split("Criterion:\n", 1)[1].split("\n\nRequired:", 1)[0])
    assert set(payload) == {"id", "title", "type", "description", "na_allowed", "na_condition", "scale_steps"}
    assert payload == compiler.criterion_payload(CRIT["04"])
    assert [s["value"] for s in payload["scale_steps"]] == [0, 5, 10, 15, 20]


def test_naive_has_no_principles_principled_has_all_six():
    assert len(PRINCIPLES_V1) == 6
    naive, principled = system_prompt("naive"), system_prompt("principled")
    for p in PRINCIPLES_V1:
        assert p not in naive
        assert p in principled
    assert compiler.PRINCIPLES_HEADER not in naive
    assert principled.startswith(naive)
    assert build_request(CRIT["01"], "naive")["system"][0]["text"] == naive
    assert build_request(CRIT["01"], "principled")["system"][0]["text"] == principled
    assert compiler.COMPILER_VERSIONS["naive"] != compiler.COMPILER_VERSIONS["principled"]


def test_requests_carry_no_dataset_text():
    dataset = json.loads((ROOT / "evals" / "dataset.json").read_text(encoding="utf-8"))
    texts = {m["text"].strip() for case in dataset["cases"] for m in case["conversation"]["messages"] if len(m.get("text") or "") >= 25}
    assert texts
    blobs = []
    for name in ("naive", "principled"):
        for c in CFG.criteria:
            r = build_request(c, name)
            blobs.append(json.dumps(r, ensure_ascii=False))
    for blob in blobs:
        for t in texts:
            assert t not in blob
    for name in ("naive", "principled"):
        low = system_prompt(name).lower()
        for word in ("dataset", "holdout", "dev set", "test case", "error pattern", "expected answer", "failure"):
            assert word not in low


def test_repair_request_carries_errors_and_previous_text():
    r = build_request(CRIT["01"], "naive", prior=("{bad", ["first problem", "second problem"]))
    assert [m["role"] for m in r["messages"]] == ["user", "assistant", "user"]
    assert r["messages"][1]["content"] == "{bad"
    assert "first problem" in r["messages"][2]["content"] and "second problem" in r["messages"][2]["content"]
    assert build_request(CRIT["01"], "naive", prior=("", ["e"]))["messages"][1]["content"] == "{}"


@pytest.mark.parametrize("shape", list(SHAPES))
def test_validator_accepts_good_spec(shape):
    c = SHAPES[shape]
    spec, errors = validate_spec(c, good_spec(c, pause=True))
    assert errors == [] and spec is not None
    assert spec["needs_pause_marks"] is True
    if c.type == "scale":
        assert [o["maps_to"] for o in spec["options"] if o["maps_to"] != "na"] == [0, 5, 10]
    again, errors = validate_spec(c, spec)
    assert errors == [] and again == spec


def test_validator_accepts_integer_step_values():
    c = SHAPES["scale"]
    raw = good_spec(c)
    for o in raw["options"]:
        o["maps_to"] = int(o["maps_to"])
    assert validate_spec(c, raw)[1] == []


def mutate(fn):
    def apply(spec):
        out = copy.deepcopy(spec)
        fn(out)
        return out

    return apply


COMMON_FAILURES = {
    "empty_instructions": mutate(lambda s: s.update(instructions="   ")),
    "missing_instructions": mutate(lambda s: s.pop("instructions")),
    "extra_field": mutate(lambda s: s.update(extra=1)),
    "bad_pause_type": mutate(lambda s: s.update(needs_pause_marks="yes")),
    "empty_text": mutate(lambda s: s["options"][0].update(text=" ")),
    "unsafe_key": mutate(lambda s: s["options"][0].update(key="a b")),
    "empty_key": mutate(lambda s: s["options"][0].update(key="")),
    "duplicate_key": mutate(lambda s: s["options"][1].update(key=s["options"][0]["key"])),
    "duplicate_maps_to": mutate(lambda s: s["options"][1].update(maps_to=s["options"][0]["maps_to"])),
    "missing_option": mutate(lambda s: s["options"].pop()),
    "extra_option": mutate(lambda s: s["options"].append({"key": "zz", "text": "Лишний.", "maps_to": "maybe"})),
    "unknown_maps_to": mutate(lambda s: s["options"][0].update(maps_to="maybe")),
    "no_options": mutate(lambda s: s.update(options=[])),
    "option_extra_field": mutate(lambda s: s["options"][0].update(weight=1)),
    "bad_type": mutate(lambda s: s.update(jev_type="score")),
}


@pytest.mark.parametrize("shape", list(SHAPES))
@pytest.mark.parametrize("failure", list(COMMON_FAILURES))
def test_validator_rejects_common_failures(shape, failure):
    c = SHAPES[shape]
    spec, errors = validate_spec(c, COMMON_FAILURES[failure](good_spec(c)))
    assert spec is None
    assert errors


@pytest.mark.parametrize("shape", ["yes_no", "scale", "flag"])
def test_validator_rejects_type_inconsistent_with_criterion(shape):
    c = SHAPES[shape]
    wrong = "choice" if c.type == "flag" else "noul"
    raw = good_spec(c)
    raw["jev_type"] = wrong
    spec, errors = validate_spec(c, raw)
    assert spec is None and any("jev_type" in e for e in errors)


def test_validator_rejects_na_when_not_allowed_and_missing_when_allowed():
    for shape in ("yes_no", "scale"):
        c = SHAPES[shape]
        raw = good_spec(SHAPES[shape + "_na"])
        assert validate_spec(c, raw)[0] is None
    for shape in ("yes_no_na", "scale_na"):
        c = SHAPES[shape]
        raw = good_spec(c)
        raw["options"] = [o for o in raw["options"] if o["maps_to"] != "na"]
        assert validate_spec(c, raw)[0] is None


def test_validator_scale_specific_failures():
    c = SHAPES["scale"]
    raw = good_spec(c)
    raw["options"][0]["maps_to"] = "05"
    assert validate_spec(c, raw)[0] is None
    raw = good_spec(c)
    raw["options"][0]["maps_to"] = "6"
    assert validate_spec(c, raw)[0] is None
    raw = good_spec(c)
    raw["options"][0]["maps_to"] = "yes"
    assert validate_spec(c, raw)[0] is None
    raw = good_spec(c)
    raw["options"][0]["maps_to"] = True
    assert validate_spec(c, raw)[0] is None


def test_validator_flag_specific_failures():
    c = SHAPES["flag"]
    swapped = good_spec(c)
    swapped["options"][0]["maps_to"], swapped["options"][1]["maps_to"] = "no", "yes"
    assert validate_spec(c, swapped)[0] is None
    renamed = good_spec(c)
    renamed["options"][0]["key"] = "violation"
    assert validate_spec(c, renamed)[0] is None
    with_na = good_spec(c)
    with_na["options"].append({"key": "na", "text": "N/A.", "maps_to": "na"})
    assert validate_spec(c, with_na)[0] is None


def test_validator_non_object_and_yes_no_cannot_carry_numbers():
    assert validate_spec(SHAPES["yes_no"], ["x"])[0] is None
    raw = good_spec(SHAPES["yes_no"])
    raw["options"][0]["maps_to"] = 1
    assert validate_spec(SHAPES["yes_no"], raw)[0] is None


def test_compile_all_real_criteria_ok(tmp_path):
    data, sdk, ledger = compile_with(tmp_path, "principled", pause_ids={"06"})
    assert data["complete"] is True
    assert len(sdk.live_calls) == len(CFG.criteria)
    assert list(data["criteria"]) == [c.id for c in CFG.criteria]
    assert all(r["status"] == "ok" and r["attempts"] == 1 for r in data["criteria"].values())
    assert data["checklist_hash"] == compiler.checklist_hash(CFG)
    assert data["compiler"] == "principled" and data["compiler_version"] == compiler.COMPILER_VERSIONS["principled"]
    assert data["model"] == COMPILER_MODEL and data["needs_pause_marks"] is True
    assert data["usage"]["calls"] == len(CFG.criteria)
    assert data["usage"]["cost"] == pytest.approx(sum(r["usage"]["cost"] for r in data["criteria"].values()))
    assert data["criteria"]["04"]["spec"]["options"][0]["maps_to"] == 0


def test_retry_with_errors_flow(tmp_path):
    calls = []
    data, sdk, ledger = compile_with(tmp_path, bad_first={"04"}, calls=calls)
    rec = data["criteria"]["04"]
    assert rec["status"] == "ok" and rec["attempts"] == 2
    assert rec["first_attempt_errors"]
    repairs = [p for p in calls if criterion_id(p) == "04" and len(p["messages"]) == 3]
    assert len(repairs) == 1
    assert rec["first_attempt_errors"][0] in repairs[0]["messages"][2]["content"]
    assert json.loads(repairs[0]["messages"][1]["content"])["jev_type"] == "choice"
    assert rec["usage"]["calls"] == 2
    assert data["criteria"]["01"]["attempts"] == 1
    assert len(calls) == len(CFG.criteria) + 1


def test_unparsable_json_gets_one_repair(tmp_path):
    state = {"n": 0}

    def respond(params):
        state["n"] += 1
        return "not json" if state["n"] == 1 else json.dumps(good_spec(CRIT[criterion_id(params)]))

    rec = compile_criterion(CRIT["01"], "naive", FakeAnthropic(respond), sleep=lambda s: None)
    assert rec["status"] == "ok" and rec["attempts"] == 2
    assert "not valid JSON" in rec["first_attempt_errors"][0]


def test_failed_criterion_after_one_retry(tmp_path):
    calls = []
    data, sdk, ledger = compile_with(tmp_path, always_bad={"02"}, calls=calls)
    rec = data["criteria"]["02"]
    assert rec["status"] == "failed" and rec["spec"] is None and rec["attempts"] == 2
    assert rec["errors"]
    assert len([p for p in calls if criterion_id(p) == "02"]) == 2
    assert data["complete"] is False
    assert data["criteria"]["01"]["status"] == "ok"
    path = tmp_path / "c.json"
    write_compiled(path, data)
    with pytest.raises(CompiledError, match="criterion 02: compile failed"):
        load_compiled(path, CFG)


def test_api_error_marks_failed_without_repair():
    def respond(params):
        return RuntimeError("boom")

    rec = compile_criterion(CRIT["01"], "naive", FakeAnthropic(respond), sleep=lambda s: None)
    assert rec["status"] == "failed" and rec["attempts"] == 1
    assert "boom" in rec["errors"][0]


def test_refusal_marks_failed_without_repair():
    rec = compile_criterion(CRIT["01"], "naive", FakeAnthropic(lambda p: ("", "refusal")), sleep=lambda s: None)
    assert rec["status"] == "failed" and rec["attempts"] == 1


def test_served_model_mismatch_fails():
    def respond(params):
        return SimpleNamespace(
            type="message", role="assistant", model="claude-other-1",
            content=[SimpleNamespace(type="text", text=json.dumps(good_spec(CRIT["01"])))],
            stop_reason="end_turn", usage=SimpleNamespace(input_tokens=10, output_tokens=10),
        )

    rec = compile_criterion(CRIT["01"], "naive", FakeAnthropic(respond), sleep=lambda s: None)
    assert rec["status"] == "failed" and "does not match" in rec["errors"][0]


def test_retryable_api_error_is_retried():
    state = {"n": 0}

    def respond(params):
        state["n"] += 1
        if state["n"] < 3:
            err = RuntimeError("busy")
            err.status_code = 529
            return err
        return json.dumps(good_spec(CRIT["01"]))

    rec = compile_criterion(CRIT["01"], "naive", FakeAnthropic(respond), sleep=lambda s: None)
    assert rec["status"] == "ok" and state["n"] == 3


def test_ledger_entries_for_every_call(tmp_path):
    data, sdk, ledger = compile_with(tmp_path, bad_first={"04"})
    entries = ledger.load()["entries"]
    assert len(entries) == len(CFG.criteria) + 1
    for e in entries:
        assert e["provider"] == "anthropic" and e["run_id"] == "compile-test" and e["kind"] == "compile"
        assert e["model"].startswith(COMPILER_MODEL) and e["mode"] == "live" and e["requests"] == 1
        assert e["counts"] is True and e["cost"] > 0
    assert sum(e["cost"] for e in entries) == pytest.approx(data["usage"]["cost"])


def test_budget_stops_remaining_criteria(tmp_path):
    sdk = FakeAnthropic(responder())
    data = compile_checklist(CFG, "naive", sdk, None, "compile-b", 0.0000001, 1, sleep=lambda s: None)
    statuses = [r["status"] for r in data["criteria"].values()]
    assert statuses[0] == "ok"
    assert set(statuses[1:]) == {"failed"}
    assert "budget" in data["criteria"]["02"]["errors"][0]
    assert len(sdk.live_calls) == 1


def args_for(tmp_path, *extra, compiler_name="naive"):
    argv = ["compile", "--compiler", compiler_name, "--ledger", str(tmp_path / "ledger.json"), "--out-dir", str(tmp_path / "out"), *extra]
    return cli.build_parser().parse_args(argv)


def test_cli_dry_run_prints_and_sends_nothing(tmp_path, capsys):
    sdk = FakeAnthropic(responder())
    assert cli.cmd_compile(args_for(tmp_path, "--max-spend", "1"), lambda: sdk) == 0
    out = capsys.readouterr().out
    assert "dry run" in out and f"requests: {len(CFG.criteria)}" in out and "$0.2880" in out
    assert not sdk.live_calls
    assert not (tmp_path / "out").exists()


def test_cli_execute_writes_file_and_ledger(tmp_path, capsys):
    sdk = FakeAnthropic(responder(pause_ids={"06"}))
    code = cli.cmd_compile(args_for(tmp_path, "--max-spend", "1", "--execute", "--concurrency", "2"), lambda: sdk)
    assert code == 0
    path = tmp_path / "out" / f"{compiler.hash8(CFG)}-naive.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["complete"] is True and data["compiler"] == "naive"
    assert len(Ledger(tmp_path / "ledger.json").load()["entries"]) == len(CFG.criteria)
    assert len(load_compiled(path, CFG)["specs"]) == len(CFG.criteria)


def test_cli_refuses_over_budget_before_sending(tmp_path, capsys):
    sdk = FakeAnthropic(responder())
    assert cli.cmd_compile(args_for(tmp_path, "--max-spend", "0.05", "--execute"), lambda: sdk) == 2
    assert "exceeds --max-spend" in capsys.readouterr().out
    assert not sdk.live_calls
    assert cli.cmd_compile(args_for(tmp_path, "--execute"), lambda: sdk) == 2
    assert not sdk.live_calls


def test_cli_refuses_over_remaining_ledger_budget(tmp_path, capsys):
    ledger = Ledger(tmp_path / "ledger.json")
    data = ledger.load()
    data["budget"] = 0.1
    ledger.save(data)
    sdk = FakeAnthropic(responder())
    assert cli.cmd_compile(args_for(tmp_path, "--max-spend", "1", "--execute"), lambda: sdk) == 2
    assert "remaining budget" in capsys.readouterr().out
    assert not sdk.live_calls


def test_cli_no_overwrite_without_force(tmp_path, capsys):
    sdk = FakeAnthropic(responder())
    a = ("--max-spend", "1", "--execute")
    assert cli.cmd_compile(args_for(tmp_path, *a), lambda: sdk) == 0
    path = tmp_path / "out" / f"{compiler.hash8(CFG)}-naive.json"
    before = path.read_text(encoding="utf-8")
    n = len(sdk.live_calls)
    assert cli.cmd_compile(args_for(tmp_path, *a), lambda: sdk) == 2
    assert "already exists" in capsys.readouterr().out
    assert len(sdk.live_calls) == n and path.read_text(encoding="utf-8") == before
    assert cli.cmd_compile(args_for(tmp_path, *a, "--force"), lambda: sdk) == 0
    assert len(sdk.live_calls) == 2 * n
    with pytest.raises(CompiledError):
        write_compiled(path, json.loads(before))


def test_cli_failed_compile_writes_file_and_returns_nonzero(tmp_path, capsys):
    sdk = FakeAnthropic(responder(always_bad={"03"}))
    assert cli.cmd_compile(args_for(tmp_path, "--max-spend", "1", "--execute"), lambda: sdk) == 1
    path = tmp_path / "out" / f"{compiler.hash8(CFG)}-naive.json"
    assert json.loads(path.read_text(encoding="utf-8"))["criteria"]["03"]["status"] == "failed"
    assert "will refuse to start" in capsys.readouterr().out


def test_load_compiled_rejects_other_checklist_and_tampering(tmp_path):
    data, _, _ = compile_with(tmp_path)
    path = tmp_path / "c.json"
    write_compiled(path, data)
    assert load_compiled(path, CFG)["needs_pause_marks"] is False
    other = copy.deepcopy(CFG)
    other.criteria[0].description += " Измененный текст."
    with pytest.raises(CompiledError, match="different checklist"):
        load_compiled(path, other)
    broken = copy.deepcopy(data)
    broken["criteria"]["01"]["spec"]["options"].pop()
    write_compiled(path, broken, force=True)
    with pytest.raises(CompiledError, match="criterion 01: stored spec is invalid"):
        load_compiled(path, CFG)
    with pytest.raises(CompiledError, match="does not exist"):
        load_compiled(tmp_path / "missing.json", CFG)


def test_checklist_hash_depends_only_on_criterion_fields():
    other = copy.deepcopy(CFG)
    other.criteria[0].weight = 99
    other.name = "renamed"
    assert compiler.checklist_hash(other) == compiler.checklist_hash(CFG)
    other.criteria[0].title += "!"
    assert compiler.checklist_hash(other) != compiler.checklist_hash(CFG)


def test_variants_registered_with_compiled_paths():
    h = compiler.hash8(CFG)
    for name, kind in (("jev_compiled_naive", "naive"), ("jev_compiled_principled", "principled")):
        assert VARIANTS[name] == {
            "name": name,
            "workflow": "jev_only",
            "params": {"style": "compiled", "compiled": f"evals/compiled/{h}-{kind}.json"},
        }


def compiled_for(tmp_path, pause_ids=()):
    data, _, _ = compile_with(tmp_path, "principled", pause_ids=pause_ids)
    path = tmp_path / "compiled.json"
    write_compiled(path, data, force=True)
    return path


def variant_for(path, name="jev_compiled_test"):
    return {"name": name, "workflow": "jev_only", "params": {"style": "compiled", "compiled": str(path)}}


class CompiledJev(FakeJev):
    def __init__(self, picks=None, flag=0.1, **kw):
        super().__init__(**kw)
        self.picks = picks or {}
        self.flag = flag

    def post(self, payload):
        self.calls.append(payload)
        answers = {}
        for name, q in payload["questions"].items():
            if q["type"] == "choice":
                key = self.picks.get(name, next(iter(q["criteria"])))
                probs = {o: 0.05 for o in q["criteria"]}
                probs[key] = 0.8
                answers[name] = {"type": "choice", "choice": key, "probabilities": probs}
            else:
                answers[name] = {"type": "noul", "noul": self.flag}
        return {"body": {"answers": answers}, "attempts": 1, "latency_ms": 100.0, "usage": self.usage}


def run_compiled(tmp_path, variant, jev):
    dataset = tiny_dataset()
    ex = runner.Executor(
        CFG, mode="live", sdk=FakeAnthropic(), jev_client=jev, ledger=Ledger(tmp_path / "runledger.json"),
        concurrency=2, sleep=lambda s: None, poll_initial=0,
    )
    out = runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run(variant, dataset["cases"], "all", 1, run_id="t-compiled")
    run_dir = tmp_path / "runs" / out["run_id"]
    results = json.loads((run_dir / "results.json").read_text(encoding="utf-8"))
    errors = json.loads((run_dir / "errors.json").read_text(encoding="utf-8"))
    return out, results, errors


def test_compiled_questions_shape(tmp_path):
    loaded = load_compiled(compiled_for(tmp_path), CFG)
    specs = build_questions(CFG, "compiled", loaded)
    assert [s.name for s in specs] == [f"q_{c.id}" for c in CFG.criteria]
    by = {s.name: s for s in specs}
    assert by["q_04"].body["type"] == "choice"
    assert list(by["q_04"].body["criteria"]) == ["s0", "s5", "s10", "s15", "s20", "nd"]
    assert by["q_04"].mapping == {"s0": 0, "s5": 5, "s10": 10, "s15": 15, "s20": 20, "nd": "na"}
    assert by["q_02"].body["criteria"].keys() == {"da", "net", "nd"}
    assert by["q_01"].body["criteria"].keys() == {"da", "net"}
    assert "q_04__na" not in by
    assert by["q_08"].body["type"] == "noul" and by["q_08"].role == "flag"
    assert set(by["q_08"].body["criteria"]) == {"true", "false"}
    assert by["q_06"].body["criteria"]["s4"] == "Клиенту приходится переспрашивать из-за формулировок или порядка ответов."


def test_compiled_map_answers_maps_back_with_confidence(tmp_path):
    loaded = load_compiled(compiled_for(tmp_path), CFG)
    payload, specs = jev_request(tiny_dataset()["cases"][0]["conversation"], CFG, style="compiled", compiled=loaded)
    jev = CompiledJev(picks={"q_04": "s15", "q_06": "s7", "q_02": "nd", "q_01": "net", "q_03": "da"}, flag=0.9)
    body = jev.post(payload)["body"]
    out = map_answers(body, specs)
    assert out["04"]["answer"] == "15" and out["04"]["confidence"] == pytest.approx(0.8)
    assert set(out["04"]["distribution"]) == {"0", "5", "10", "15", "20", "na"}
    assert out["04"]["distribution"]["15"] == pytest.approx(0.8)
    assert out["06"]["answer"] == "7"
    assert out["02"]["answer"] == "na" and out["02"]["distribution"]["na"] == pytest.approx(0.8)
    assert out["01"]["answer"] == "no"
    assert out["03"]["answer"] == "yes"
    assert out["08"]["answer"] == "yes" and out["08"]["confidence"] == pytest.approx(0.9)
    assert set(out["01"]) == {"answer", "confidence", "distribution"}
    body["answers"]["q_06"]["choice"] = "zz"
    with pytest.raises(DecisionsError):
        map_answers(body, specs)


def test_compiled_end_to_end_through_runner(tmp_path):
    path = compiled_for(tmp_path)
    jev = CompiledJev(picks={"q_04": "s15", "q_06": "s7", "q_02": "nd", "q_01": "net"}, flag=0.9)
    out, results, errors = run_compiled(tmp_path, variant_for(path), jev)
    assert not errors and out["stopped"] is None
    assert len(jev.calls) == 3
    for r in results:
        res = r["results"]
        assert res["04"]["answer"] == 15 and res["06"]["answer"] == 7
        assert res["02"]["answer"] == "na" and res["01"]["answer"] == "no" and res["03"]["answer"] == "yes"
        assert res["08"]["answer"] == "yes"
        assert res["04"]["confidence"] == pytest.approx(0.8)
    assert jev.calls[0]["state"][0] == RULES_HEADER


def test_compiled_na_option_answers_na_for_scale(tmp_path):
    path = compiled_for(tmp_path)
    jev = CompiledJev(picks={"q_04": "nd"})
    out, results, errors = run_compiled(tmp_path, variant_for(path), jev)
    assert not errors
    assert all(r["results"]["04"]["answer"] == "na" for r in results)


def test_pause_marks_flag_drives_annotations(tmp_path):
    conv = gapped_conv()
    (tmp_path / "a").mkdir()
    plain_path = compiled_for(tmp_path / "a")
    paused_path = compiled_for(tmp_path, pause_ids={"06"})
    plain = load_compiled(plain_path, CFG)
    paused = load_compiled(paused_path, CFG)
    assert plain["needs_pause_marks"] is False and paused["needs_pause_marks"] is True
    base = jev_request(conv, CFG)[0]["state"]
    off = jev_request(conv, CFG, style="compiled", compiled=plain)[0]["state"]
    on = jev_request(conv, CFG, style="compiled", compiled=paused)[0]["state"]
    assert off == base
    assert on[0] == RULES_HEADER and on[1] == base[1]
    assert on[2] != base[2] and "[пауза 300 с до следующего сообщения]" in on[2]


def test_pause_marks_any_criterion_is_enough(tmp_path):
    for pid in ("01", "08"):
        data, _, _ = compile_with(tmp_path, pause_ids={pid})
        write_compiled(tmp_path / f"{pid}.json", data)
        assert load_compiled(tmp_path / f"{pid}.json", CFG)["needs_pause_marks"] is True


def test_missing_compiled_file_refuses_to_start(tmp_path):
    variant = variant_for(tmp_path / "missing.json")
    with pytest.raises(CompiledError, match="does not exist"):
        build_workflow(variant, CFG)
    dataset = tiny_dataset()
    ex = runner.Executor(CFG, mode="live", sdk=FakeAnthropic(), jev_client=CompiledJev(), ledger=Ledger(tmp_path / "l.json"))
    with pytest.raises(CompiledError):
        runner.Runner(dataset, ex, tmp_path / "runs", cfg=CFG).run(variant, dataset["cases"], "all", 1, run_id="t-missing")
    assert not (tmp_path / "runs" / "t-missing").exists()


def test_failed_criterion_refuses_to_start(tmp_path):
    data, _, _ = compile_with(tmp_path, always_bad={"05"})
    path = tmp_path / "failed.json"
    write_compiled(path, data)
    with pytest.raises(CompiledError, match="criterion 05"):
        build_workflow(variant_for(path), CFG)


def test_compiled_style_without_param_refuses():
    with pytest.raises(CompiledError, match="'compiled' param"):
        build_workflow({"name": "x", "workflow": "jev_only", "params": {"style": "compiled"}}, CFG)
    with pytest.raises(CompiledError):
        build_questions(CFG, "compiled")


def test_cli_run_refuses_clearly_for_missing_compiled_file(tmp_path):
    variants = tmp_path / "variants.json"
    variants.write_text(json.dumps([variant_for(tmp_path / "missing.json", "jev_compiled_x")]), encoding="utf-8")
    argv = ["run", "jev_compiled_x", "--variants-file", str(variants), "--max-spend", "1", "--ledger", str(tmp_path / "l.json")]
    with pytest.raises(SystemExit, match="refused to start variant jev_compiled_x: compiled file .* does not exist"):
        cli.main(argv)


def test_specs_for_questions_resolves_compiled_only_with_its_file(tmp_path):
    path = compiled_for(tmp_path)
    loaded = load_compiled(path, CFG)
    payload, specs = jev_request(tiny_dataset()["cases"][0]["conversation"], CFG, style="compiled", compiled=loaded)
    resolved = specs_for_questions(CFG, payload["questions"], [str(path)])
    assert [s.name for s in resolved] == list(payload["questions"])
    assert [s.role for s in resolved] == [s.role for s in specs]
    assert [s.mapping for s in resolved] == [s.mapping for s in specs]
    guessed = specs_for_questions(CFG, payload["questions"])
    assert [s.role for s in guessed] != [s.role for s in specs]


def test_existing_styles_unchanged():
    from tests.test_eval_jev_variants import GOLDEN_HASH, digest

    payload, _ = jev_request(tiny_dataset()["cases"][0]["conversation"], CFG)
    assert digest(payload) == GOLDEN_HASH
    for style in ("default", "rich", "split", "rich_split", "temporal_choice", "temporal_split", "obs", "gaps", "obs_gaps"):
        specs = build_questions(CFG, style)
        assert all(s.mapping == {} for s in specs)
        assert "compiled_choice" not in {s.role for s in specs}
        resolved = specs_for_questions(CFG, {s.name: s.body for s in specs})
        assert [s.role for s in resolved] == [s.role for s in specs]
    for name in ("jev_only", "jev_rich", "jev_obs_gaps", "jev_temporal_choice"):
        wf = build_workflow(VARIANTS[name], CFG)
        assert wf.compiled is None and wf.compiled_path is None
