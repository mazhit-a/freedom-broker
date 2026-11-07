import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional

from backend.app.core.config import get_settings
from backend.app.schemas.checklist import ChecklistConfig
from backend.app.services.checklist import get_version
from backend.app.services.scoring import NA, NEEDS_REVIEW, ScoringError, _norm, score

QA = "qa"
REVIEWER = "reviewer"
QUEUE_STATUSES = ("open", "resolved", "all", "new", "under_review", "confirmed", "changed")
TS_FORMAT = "%Y-%m-%d %H:%M:%S"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _parse(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "")).replace(tzinfo=None)
    except ValueError:
        return None


def add_workdays(start: datetime, days: int) -> datetime:
    current = start
    remaining = days
    while remaining > 0:
        current += timedelta(days=1)
        if current.weekday() < 5:
            remaining -= 1
    return current


def appeal_deadline(created_at: Optional[str]) -> Optional[str]:
    start = _parse(created_at)
    if start is None:
        return None
    return add_workdays(start, get_settings().appeal_window_workdays).strftime(TS_FORMAT)


def display_status(row: dict) -> str:
    if row["status"] == "resolved":
        return "changed" if row.get("decision") == "change" else "confirmed"
    return "under_review" if row.get("review_started_at") else "new"


class AppealError(Exception):
    def __init__(self, status: int, message: str, code: str = "error"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


def _role(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def filing_roles() -> set[str]:
    raw = get_settings().appeal_filing_roles
    return {r.strip().lower() for r in raw.split(",") if r.strip()}


def require_role(role: Optional[str], wanted: str) -> None:
    if _role(role) != wanted:
        raise AppealError(403, f"This action requires the {wanted} role", "role_forbidden")


def require_filing_role(role: Optional[str]) -> str:
    r = _role(role)
    if r not in filing_roles():
        raise AppealError(403, "This action requires the operator role", "role_forbidden")
    return r


def _config(conn: sqlite3.Connection, evaluation_id: int) -> ChecklistConfig:
    row = conn.execute("SELECT checklist_version_id FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone()
    if not row:
        raise AppealError(404, "Evaluation not found", "evaluation_not_found")
    return get_version(conn, row["checklist_version_id"]).config


def _canonical(value: Any) -> str:
    norm = _norm(value)
    return str(norm)


def validate_answer(cfg: ChecklistConfig, criterion_id: str, new_answer: Any) -> str:
    if new_answer is None or (isinstance(new_answer, str) and not new_answer.strip()):
        raise AppealError(422, "new_answer is required for a change", "answer_required")
    if _norm(new_answer) == NEEDS_REVIEW:
        raise AppealError(422, "needs_review is not a valid decision", "invalid_answer")
    try:
        score(cfg, {}, {criterion_id: new_answer})
    except ScoringError as exc:
        raise AppealError(422, str(exc), "invalid_answer")
    return _canonical(new_answer)


def _appeal_row(conn: sqlite3.Connection, appeal_id: int) -> dict:
    row = conn.execute(
        "SELECT a.id, a.evaluation_id, a.criterion_id, a.comment, a.status, a.created_at, "
        "a.author_role, a.review_started_at, a.review_started_by, a.message_refs, "
        "d.decision, d.new_answer, d.reason, d.decided_at, d.decided_by_role, d.total_before, d.total_after "
        "FROM appeal a LEFT JOIN review_decision d ON d.appeal_id = a.id WHERE a.id = ?",
        (appeal_id,),
    ).fetchone()
    if not row:
        raise AppealError(404, "Appeal not found", "appeal_not_found")
    out = dict(row)
    out["message_refs"] = json.loads(out["message_refs"]) if out["message_refs"] else []
    out["display_status"] = display_status(out)
    return out


def validate_refs(conn: sqlite3.Connection, evaluation_id: int, refs: Optional[list]) -> list[int]:
    if refs is None:
        return []
    if not isinstance(refs, list):
        raise AppealError(422, "message_refs must be a list of message indexes", "invalid_message_ref")
    row = conn.execute("SELECT conversation_id FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone()
    valid = {
        r["message_index"]
        for r in conn.execute("SELECT message_index FROM message WHERE conversation_id = ?", (row["conversation_id"],)).fetchall()
    }
    out: list[int] = []
    for ref in refs:
        if isinstance(ref, bool) or not isinstance(ref, int) or ref not in valid:
            raise AppealError(422, f"Invalid message reference: {ref}", "invalid_message_ref")
        if ref not in out:
            out.append(ref)
    return out


def create_appeal(
    conn: sqlite3.Connection,
    evaluation_id: int,
    criterion_id: str,
    comment: Optional[str],
    role: Optional[str],
    message_refs: Optional[list] = None,
) -> dict:
    author_role = require_filing_role(role)
    if not comment or not comment.strip():
        raise AppealError(422, "A comment is required to file an appeal", "comment_required")
    if not conn.execute("SELECT 1 FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone():
        raise AppealError(404, "Evaluation not found", "evaluation_not_found")
    if not conn.execute(
        "SELECT 1 FROM criterion_result WHERE evaluation_id = ? AND criterion_id = ?", (evaluation_id, criterion_id)
    ).fetchone():
        raise AppealError(404, "Criterion not found in this evaluation", "criterion_not_found")
    if conn.execute(
        "SELECT 1 FROM appeal WHERE evaluation_id = ? AND criterion_id = ? AND status = 'open'", (evaluation_id, criterion_id)
    ).fetchone():
        raise AppealError(409, "An open appeal already exists for this criterion", "appeal_open_exists")
    refs = validate_refs(conn, evaluation_id, message_refs)
    if get_settings().appeal_window_enforced:
        created = conn.execute("SELECT created_at FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone()["created_at"]
        deadline = _parse(appeal_deadline(created))
        if deadline is not None and _now() > deadline:
            raise AppealError(409, "The appeal window for this evaluation has closed", "appeal_window_closed")
    cur = conn.execute(
        "INSERT INTO appeal (evaluation_id, criterion_id, comment, author_role, message_refs) VALUES (?,?,?,?,?)",
        (evaluation_id, criterion_id, comment.strip(), author_role, json.dumps(refs) if refs else None),
    )
    conn.commit()
    return _appeal_row(conn, cur.lastrowid)


def start_review(conn: sqlite3.Connection, appeal_id: int, role: Optional[str]) -> dict:
    require_role(role, REVIEWER)
    appeal = _appeal_row(conn, appeal_id)
    if appeal["status"] != "open":
        raise AppealError(409, "This appeal is already resolved", "appeal_resolved")
    if not appeal["review_started_at"]:
        conn.execute(
            "UPDATE appeal SET review_started_at = ?, review_started_by = ? WHERE id = ?",
            (_now().strftime(TS_FORMAT), _role(role), appeal_id),
        )
        conn.commit()
    return _appeal_row(conn, appeal_id)


def _final_total(conn: sqlite3.Connection, evaluation_id: int) -> Optional[float]:
    from backend.app.services.evaluator import get_evaluation

    final = with_review(conn, get_evaluation(conn, evaluation_id)).get("final")
    return final["total"] if final else None


def decide(
    conn: sqlite3.Connection,
    appeal_id: int,
    decision: str,
    new_answer: Any,
    reason: Optional[str],
    role: Optional[str],
) -> dict:
    require_role(role, REVIEWER)
    appeal = _appeal_row(conn, appeal_id)
    if appeal["status"] != "open":
        raise AppealError(409, "This appeal is already resolved", "appeal_resolved")
    if decision not in ("confirm", "change"):
        raise AppealError(422, "decision must be confirm or change", "invalid_decision")
    if not reason or not reason.strip():
        raise AppealError(422, "A reason is required", "reason_required")
    stored_answer = None
    if decision == "change":
        cfg = _config(conn, appeal["evaluation_id"])
        stored_answer = validate_answer(cfg, appeal["criterion_id"], new_answer)
    elif new_answer not in (None, ""):
        raise AppealError(422, "new_answer is only allowed for a change", "new_answer_not_allowed")
    total_before = _final_total(conn, appeal["evaluation_id"])
    conn.execute(
        "INSERT INTO review_decision (appeal_id, decision, new_answer, reason, decided_by_role) VALUES (?,?,?,?,?)",
        (appeal_id, decision, stored_answer, reason.strip(), _role(role)),
    )
    conn.execute("UPDATE appeal SET status = 'resolved' WHERE id = ?", (appeal_id,))
    total_after = _final_total(conn, appeal["evaluation_id"])
    conn.execute(
        "UPDATE review_decision SET total_before = ?, total_after = ? WHERE appeal_id = ?",
        (total_before, total_after, appeal_id),
    )
    conn.commit()
    return _appeal_row(conn, appeal_id)


def get_appeal(conn: sqlite3.Connection, appeal_id: int) -> dict:
    return _appeal_row(conn, appeal_id)


def evaluation_appeals(conn: sqlite3.Connection, evaluation_id: int) -> list[dict]:
    rows = conn.execute("SELECT id FROM appeal WHERE evaluation_id = ? ORDER BY id", (evaluation_id,)).fetchall()
    return [_appeal_row(conn, r["id"]) for r in rows]


def model_label(model: Optional[str]) -> Optional[str]:
    return get_settings().llm_label or model


def _num(value: Optional[Decimal]) -> Optional[float]:
    return float(value) if value is not None else None


def with_review(conn: sqlite3.Connection, ev: dict) -> dict:
    appeals = evaluation_appeals(conn, ev["id"])
    original_criteria = ev["criteria"]
    overrides: dict[str, Any] = {}
    for a in appeals:
        if a["status"] == "resolved" and a["decision"] == "change":
            overrides[a["criterion_id"]] = a["new_answer"]
    ev["original"] = {
        "total": ev["total"],
        "total_status": ev["total_status"],
        "provisional": ev["provisional"],
        "gross_violation": ev["gross_violation"],
        "criteria": original_criteria,
    }
    ev["appeals"] = appeals
    ev["appeal_deadline"] = appeal_deadline(ev.get("created_at"))
    ev["appeal_window_workdays"] = get_settings().appeal_window_workdays
    ev["decisions"] = [a for a in appeals if a["status"] == "resolved"]
    open_ids = {a["criterion_id"] for a in appeals if a["status"] == "open"}
    ev["appealed_criteria"] = sorted(open_ids)
    meta = conversation_meta(conn, ev["conversation_id"])
    ev["model_label"] = model_label(ev.get("model"))
    ev["occurred_at"] = meta["occurred_at"]
    ev["duration_seconds"] = meta["duration_seconds"]
    ev["confidence"] = confidence(original_criteria, ev["provisional"])
    ev["display_appeal_status"] = display_appeal_status(appeals)
    ev["final_total"] = None
    ev["total_changed"] = False
    cfg = _config(conn, ev["id"])
    answers = {c["criterion_id"]: c["answer"] for c in original_criteria if c["answer"] not in (None, "")}
    try:
        result = score(cfg, answers, overrides)
    except ScoringError:
        ev["final"] = None
        return ev
    by_id = {c.id: c for c in result.criteria}
    originals = {c["criterion_id"]: c for c in original_criteria}
    final_criteria = []
    for cid, c in by_id.items():
        orig = originals.get(cid)
        final_criteria.append(
            {
                "criterion_id": cid,
                "answer": c.answer if c.status == "answered" else (NA if c.status == NA else None),
                "status": c.status,
                "points": _num(c.points),
                "effective_points": _num(c.effective_points),
                "overridden": cid in overrides,
                "original_answer": orig["answer"] if orig else None,
                "original_points": orig["points"] if orig else None,
                "original_effective_points": orig["effective_points"] if orig else None,
            }
        )
    ev["final"] = {
        "total": _num(result.total),
        "calculated": result.calculated,
        "reason": result.reason,
        "provisional": result.provisional,
        "gross_violation": bool(result.gross_violation),
        "changed": bool(overrides),
        "criteria": final_criteria,
        "sections": [
            {
                "id": s.id,
                "title": s.title,
                "earned": _num(s.earned),
                "applicable_max": _num(s.applicable_max),
                "percent": _num(s.percent),
                **effective_section(cfg, result, s.id),
            }
            for s in result.sections
        ],
    }
    ev["final_total"] = ev["final"]["total"]
    ev["total_changed"] = ev["final"]["changed"]
    return ev


def effective_section(cfg: ChecklistConfig, result, section_id: Optional[str]) -> dict:
    applicable = sum((c.weight for c in result.criteria if c.type != "flag" and c.status == "answered"), Decimal(0))
    members = [c for c in result.criteria if c.type != "flag" and c.status == "answered" and _section_of(cfg, c.id) == section_id]
    if applicable <= 0 or not members:
        return {"effective_points": None, "effective_max": 0.0}
    points = sum((c.effective_points for c in members), Decimal(0))
    maximum = (sum((c.weight for c in members), Decimal(0)) * Decimal(100) / applicable).quantize(Decimal("0.01"))
    return {"effective_points": float(points), "effective_max": float(maximum)}


def _section_of(cfg: ChecklistConfig, criterion_id: str) -> Optional[str]:
    for c in cfg.criteria:
        if c.id == criterion_id:
            return c.section
    return None


def confidence(criteria: list[dict], provisional: bool) -> dict:
    total = len(criteria)
    with_rationale = sum(1 for c in criteria if (c.get("rationale") or "").strip())
    low = bool(provisional) or any(c.get("needs_review") for c in criteria)
    return {"level": "low" if low else "high", "with_rationale": with_rationale, "total": total}


def display_appeal_status(appeals: list[dict]) -> str:
    if not appeals:
        return "none"
    open_ones = [a for a in appeals if a["status"] == "open"]
    if open_ones:
        return display_status(open_ones[-1])
    return display_status(appeals[-1])


ISO_FRACTION = re.compile(r"(\.\d{6})\d+")


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value or "T" not in value:
        return None
    try:
        return datetime.fromisoformat(ISO_FRACTION.sub(r"\1", value))
    except ValueError:
        return None


def conversation_meta(conn: sqlite3.Connection, conversation_pk: int) -> dict:
    rows = conn.execute(
        "SELECT timestamp_raw, offset_seconds FROM message WHERE conversation_id = ? ORDER BY message_index",
        (conversation_pk,),
    ).fetchall()
    stamps = [(r["timestamp_raw"], _parse_iso(r["timestamp_raw"])) for r in rows]
    parsed = [p for _, p in stamps if p is not None]
    occurred = next((raw for raw, p in stamps if p is not None), None)
    duration = None
    if len(parsed) >= 2:
        duration = round((max(parsed) - min(parsed)).total_seconds(), 2)
    else:
        offsets = [r["offset_seconds"] for r in rows if r["offset_seconds"] is not None]
        if offsets:
            duration = round(float(max(offsets)), 2)
    return {"occurred_at": occurred, "duration_seconds": duration}


def queue(conn: sqlite3.Connection, status: str = "open") -> list[dict]:
    sql = "SELECT id FROM appeal"
    args: list = []
    if status in ("open", "resolved"):
        sql += " WHERE status = ?"
        args.append(status)
    sql += " ORDER BY id"
    out = []
    for r in conn.execute(sql, args).fetchall():
        a = _appeal_row(conn, r["id"])
        if status in ("new", "under_review", "confirmed", "changed") and a["display_status"] != status:
            continue
        ev = conn.execute(
            "SELECT e.id, e.conversation_id AS conversation_pk, e.checklist_version_id, e.model, c.conversation_id, c.channel, c.language "
            "FROM evaluation e JOIN conversation c ON c.id = e.conversation_id WHERE e.id = ?",
            (a["evaluation_id"],),
        ).fetchone()
        res = conn.execute(
            "SELECT answer, points, effective_points, rationale, evidence_json, checked_range, na_reason FROM criterion_result "
            "WHERE evaluation_id = ? AND criterion_id = ?",
            (a["evaluation_id"], a["criterion_id"]),
        ).fetchone()
        cfg = get_version(conn, ev["checklist_version_id"]).config
        crit = next((c for c in cfg.criteria if c.id == a["criterion_id"]), None)
        evidence = json.loads(res["evidence_json"] or "[]")
        rng = json.loads(res["checked_range"]) if res["checked_range"] else None
        wanted = {e["message_index"] for e in evidence if isinstance(e, dict) and "message_index" in e}
        if rng:
            wanted.update(range(rng["from"], rng["to"] + 1))
        lo = max(min(wanted) - 1, 0) if wanted else 0
        hi = max(wanted) + 1 if wanted else 3
        frag = conn.execute(
            "SELECT message_index, timestamp_raw, offset_seconds, speaker, text FROM message "
            "WHERE conversation_id = ? AND message_index BETWEEN ? AND ? ORDER BY message_index",
            (ev["conversation_pk"], lo, hi),
        ).fetchall()
        out.append(
            {
                **a,
                "conversation_pk": ev["conversation_pk"],
                "conversation_id": ev["conversation_id"],
                "channel": ev["channel"],
                "language": ev["language"],
                "age_hours": age_hours(a),
                "checklist_version_label": version_label(conn, ev["checklist_version_id"]),
                "model_label": model_label(ev["model"]),
                "criterion": crit.model_dump() if crit else None,
                "original": {
                    "answer": res["answer"],
                    "points": res["points"],
                    "effective_points": res["effective_points"],
                    "rationale": res["rationale"],
                    "na_reason": res["na_reason"],
                    "evidence": evidence,
                    "checked_range": rng,
                },
                "fragment": [dict(m) for m in frag],
            }
        )
    return out


def age_hours(a: dict, now: Optional[datetime] = None) -> Optional[float]:
    created = _parse(a["created_at"])
    if created is None:
        return None
    end = _parse(a["decided_at"]) if a["status"] == "resolved" else (now or _now())
    if end is None:
        return None
    return round(max((end - created).total_seconds(), 0) / 3600, 2)


def version_label(conn: sqlite3.Connection, version_id: int) -> str:
    row = conn.execute("SELECT version FROM checklist_version WHERE id = ?", (version_id,)).fetchone()
    return f"v{row['version']}" if row else ""


def summary(conn: sqlite3.Connection, now: Optional[datetime] = None) -> dict:
    now = now or _now()
    threshold = get_settings().appeal_aging_hours
    new = under = older = 0
    durations: list[float] = []
    for r in conn.execute("SELECT id FROM appeal").fetchall():
        a = _appeal_row(conn, r["id"])
        if a["status"] == "open":
            if a["display_status"] == "under_review":
                under += 1
            else:
                new += 1
            hours = age_hours(a, now)
            if hours is not None and hours > threshold:
                older += 1
        else:
            hours = age_hours(a)
            if hours is not None:
                durations.append(hours)
    durations.sort()
    median = None
    if durations:
        mid = len(durations) // 2
        median = durations[mid] if len(durations) % 2 else round((durations[mid - 1] + durations[mid]) / 2, 2)
    return {
        "open": new + under,
        "new": new,
        "under_review": under,
        "older_than_hours": older,
        "aging_hours": threshold,
        "median_resolution_hours": median,
    }
