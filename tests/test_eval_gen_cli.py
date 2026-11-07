import json

from scripts import eval_gen
from evals.gen import assemble
from tests.test_eval_gen_fakes import generation_output, good_spec


def test_cli_source_never_references_the_api_client():
    source = open(eval_gen.__file__, encoding="utf-8").read()
    assert "import anthropic" not in source and "messages.create" not in source and "batches" not in source


def test_spec_plan_batch_pilot(tmp_path, capsys):
    specs_path = tmp_path / "specs.json"
    assert eval_gen.main(["spec", "--out", str(specs_path)]) == 0
    assert len(json.loads(specs_path.read_text(encoding="utf-8"))) == 36
    assert eval_gen.main(["plan", "--specs", str(specs_path)]) == 0
    out = capsys.readouterr().out
    assert "generation requests: 36" in out and "batch total" in out
    batch = tmp_path / "batch.jsonl"
    assert eval_gen.main(["build-batch", "--specs", str(specs_path), "--out", str(batch)]) == 0
    rows = [json.loads(line) for line in batch.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 36 and rows[0]["custom_id"] == "case-001" and "params" in rows[0]
    pilot = tmp_path / "pilot.json"
    assert eval_gen.main(["pilot-requests", "--specs", str(specs_path), "--out", str(pilot)]) == 0
    pilots = json.loads(pilot.read_text(encoding="utf-8"))
    assert len(pilots) == 4 and all(p["case_id"].startswith("case-") for p in pilots)
    assert {json.loads(specs_path.read_text(encoding="utf-8"))[int(p["case_id"][5:]) - 1]["split"] for p in pilots} == {"dev"}


def test_build_batch_only(tmp_path):
    batch = tmp_path / "b.jsonl"
    eval_gen.main(["build-batch", "--only", "case-003,case-005", "--out", str(batch)])
    assert [json.loads(x)["custom_id"] for x in batch.read_text(encoding="utf-8").splitlines()] == ["case-003", "case-005"]


def test_ingest_then_freeze(tmp_path):
    specs_path = tmp_path / "specs.json"
    specs_path.write_text(json.dumps([good_spec()]), encoding="utf-8")
    message = {"content": [{"type": "text", "text": json.dumps(generation_output(), ensure_ascii=False)}], "stop_reason": "end_turn"}
    results = tmp_path / "r.jsonl"
    results.write_text(json.dumps({"custom_id": "case-901", "result": {"type": "succeeded", "message": message}}, ensure_ascii=False) + "\n", encoding="utf-8")
    out = tmp_path / "dataset.json"
    card = tmp_path / "card.md"
    assert eval_gen.main(["ingest", "--specs", str(specs_path), "--results", str(results), "--out", str(out), "--card", str(card)]) == 0
    dataset = json.loads(out.read_text(encoding="utf-8"))
    assert assemble.contract_errors(dataset) == []
    assert card.read_text(encoding="utf-8").startswith("# Evaluation dataset card")
    assert eval_gen.main(["freeze", "--specs", str(specs_path), "--in", str(out), "--out", str(tmp_path / "f.json"), "--card", str(tmp_path / "c.md")]) == 1
    dataset["cases"][0]["review"]["status"] = "accepted"
    out.write_text(json.dumps(dataset, ensure_ascii=False), encoding="utf-8")
    assert eval_gen.main(["freeze", "--specs", str(specs_path), "--in", str(out), "--out", str(tmp_path / "f.json"), "--card", str(tmp_path / "c.md"), "--version", "2"]) == 0
    frozen = json.loads((tmp_path / "f.json").read_text(encoding="utf-8"))
    assert frozen["version"] == 2 and assemble.verify_hash(frozen)


def test_ingest_failure_exit_code(tmp_path):
    results = tmp_path / "r.jsonl"
    results.write_text(json.dumps({"custom_id": "case-001", "result": {"type": "expired"}}) + "\n", encoding="utf-8")
    assert eval_gen.main(["ingest", "--results", str(results), "--out", str(tmp_path / "d.json")]) == 1
