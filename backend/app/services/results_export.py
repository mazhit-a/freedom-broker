import json
import sqlite3
from typing import Any

from backend.app.services import checklist as checklist_service
from backend.app.services.checklist import NotFound

SCHEMA_VERSION = "1.0"
CODES = ("contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical")
DEFAULT_ERROR = "Не удалось получить ответ модели."
MISSING_ERROR = "Диалог не оценён."


class ExportError(ValueError):
    pass


def to_value(answer: Any, ctype: str) -> Any:
    if answer in (None, "na"):
        return None
    if ctype == "scale":
        return int(float(answer))
    if answer == "yes":
        return True
    if answer == "no":
        return False
    raise ExportError(f"unexpected answer {answer!r}")


def evidence_turns(evidence_json: str | None, checked_range: str | None) -> list[int]:
    turns: set[int] = set()
    for item in json.loads(evidence_json) if evidence_json else []:
        if isinstance(item, dict) and isinstance(item.get("message_index"), int):
            turns.add(item["message_index"] + 1)
    if not turns and checked_range:
        rng = json.loads(checked_range)
        for key in ("from", "to"):
            if isinstance(rng.get(key), int):
                turns.add(rng[key] + 1)
    return sorted(turns)


def error_text(raw_output: str | None) -> str:
    if not raw_output:
        return DEFAULT_ERROR
    try:
        data = json.loads(raw_output)
    except ValueError:
        return DEFAULT_ERROR
    reason = data.get("error") if isinstance(data, dict) else None
    return f"{DEFAULT_ERROR} {str(reason)[:300]}" if reason else DEFAULT_ERROR


def criterion_record(code: str, ctype: str, row: sqlite3.Row) -> dict:
    return {
        "criterion_id": code,
        "value": to_value(row["answer"], ctype),
        "rationale": row["rationale"] or row["na_reason"] or "",
        "evidence_turns": evidence_turns(row["evidence_json"], row["checked_range"]),
    }


def record_for(conn: sqlite3.Connection, conv: sqlite3.Row, version_id: int, criteria: list) -> tuple[dict, str | None]:
    ev = conn.execute(
        "SELECT * FROM evaluation WHERE conversation_id = ? AND checklist_version_id = ? ORDER BY id DESC LIMIT 1",
        (conv["id"], version_id),
    ).fetchone()
    if ev is None:
        return {"conversation_id": conv["conversation_id"], "status": "error", "criteria": [], "score": None, "error": MISSING_ERROR}, None
    rows = {r["criterion_id"]: r for r in conn.execute("SELECT * FROM criterion_result WHERE evaluation_id = ?", (ev["id"],))}
    usable = (
        ev["status"] == "completed"
        and ev["total"] is not None
        and all(c.id in rows and not rows[c.id]["needs_review"] for c in criteria)
    )
    if not usable:
        return {"conversation_id": conv["conversation_id"], "status": "error", "criteria": [], "score": None, "error": error_text(ev["raw_output"])}, ev["model"]
    records = [criterion_record(code, c.type, rows[c.id]) for code, c in zip(CODES, criteria)]
    return (
        {
            "conversation_id": conv["conversation_id"],
            "status": "ok",
            "criteria": records,
            "score": {"final_score": round(float(ev["total"]), 2), "critical_flag": records[-1]["value"] is True},
        },
        ev["model"],
    )


def build_export(conn: sqlite3.Connection, group_id: str, team_name: str, version_id: int | None = None) -> dict:
    if version_id is None:
        row = conn.execute("SELECT default_version_id FROM checklist WHERE default_version_id IS NOT NULL ORDER BY id LIMIT 1").fetchone()
        if row is None:
            raise NotFound("no default checklist version")
        version_id = row["default_version_id"]
    criteria = checklist_service.get_version(conn, version_id).config.criteria
    if len(criteria) != len(CODES):
        raise ExportError(f"the checklist has {len(criteria)} criteria, the result format needs exactly {len(CODES)}")
    if criteria[-1].type != "flag":
        raise ExportError("the last criterion must be the gross violations flag")
    convs = conn.execute(
        "SELECT c.* FROM conversation c JOIN dataset d ON d.id = c.dataset_id WHERE d.group_id = ? ORDER BY c.id",
        (group_id,),
    ).fetchall()
    if not convs:
        raise NotFound(f"dataset {group_id} has no conversations")
    results, models = [], []
    for conv in convs:
        rec, model = record_for(conn, conv, version_id, criteria)
        results.append(rec)
        if model and model not in models:
            models.append(model)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "team_name": team_name,
        "model": {"mode": "external_api", "name": ", ".join(models)},
        "results": results,
    }
    problems = validate_export(payload)
    if problems:
        raise ExportError("; ".join(problems))
    return payload


def validate_export(payload: dict) -> list[str]:
    problems = []
    if payload.get("schema_version") != SCHEMA_VERSION:
        problems.append("schema_version must be 1.0")
    model = payload.get("model") or {}
    if model.get("mode") not in ("local", "external_api", "hybrid") or not model.get("name"):
        problems.append("model needs a mode and a name")
    seen: set[str] = set()
    for rec in payload.get("results", []):
        cid = rec.get("conversation_id")
        if cid in seen:
            problems.append(f"duplicate conversation_id {cid}")
        seen.add(cid)
        if rec.get("status") == "ok":
            codes = [c.get("criterion_id") for c in rec.get("criteria", [])]
            if codes != list(CODES):
                problems.append(f"{cid}: criteria must be the 8 codes in order")
            score = rec.get("score")
            if not score or not isinstance(score.get("final_score"), (int, float)) or not 0 <= score["final_score"] <= 100:
                problems.append(f"{cid}: final_score must be 0..100")
            elif codes == list(CODES) and rec["criteria"][-1]["value"] is not score["critical_flag"]:
                problems.append(f"{cid}: critical_flag must equal the critical value")
        elif rec.get("status") == "error":
            if rec.get("criteria") != [] or rec.get("score") is not None or not rec.get("error"):
                problems.append(f"{cid}: an error record needs empty criteria, score null and an error text")
        else:
            problems.append(f"{cid}: status must be ok or error")
    return problems
