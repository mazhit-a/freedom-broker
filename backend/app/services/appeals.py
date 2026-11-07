import json
import sqlite3
from decimal import Decimal
from typing import Any, Optional

from backend.app.schemas.checklist import ChecklistConfig
from backend.app.services.checklist import get_version
from backend.app.services.scoring import NA, NEEDS_REVIEW, ScoringError, _norm, score

QA = "qa"
REVIEWER = "reviewer"


class AppealError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _role(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def require_role(role: Optional[str], wanted: str) -> None:
    if _role(role) != wanted:
        raise AppealError(403, f"This action requires the {wanted} role")


def _config(conn: sqlite3.Connection, evaluation_id: int) -> ChecklistConfig:
    row = conn.execute("SELECT checklist_version_id FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone()
    if not row:
        raise AppealError(404, "Evaluation not found")
    return get_version(conn, row["checklist_version_id"]).config


def _canonical(value: Any) -> str:
    norm = _norm(value)
    return str(norm)


def validate_answer(cfg: ChecklistConfig, criterion_id: str, new_answer: Any) -> str:
    if new_answer is None or (isinstance(new_answer, str) and not new_answer.strip()):
        raise AppealError(422, "new_answer is required for a change")
    if _norm(new_answer) == NEEDS_REVIEW:
        raise AppealError(422, "needs_review is not a valid decision")
    try:
        score(cfg, {}, {criterion_id: new_answer})
    except ScoringError as exc:
        raise AppealError(422, str(exc))
    return _canonical(new_answer)


def _appeal_row(conn: sqlite3.Connection, appeal_id: int) -> dict:
    row = conn.execute(
        "SELECT a.id, a.evaluation_id, a.criterion_id, a.comment, a.status, a.created_at, "
        "d.decision, d.new_answer, d.reason, d.decided_at "
        "FROM appeal a LEFT JOIN review_decision d ON d.appeal_id = a.id WHERE a.id = ?",
        (appeal_id,),
    ).fetchone()
    if not row:
        raise AppealError(404, "Appeal not found")
    return dict(row)


def create_appeal(conn: sqlite3.Connection, evaluation_id: int, criterion_id: str, comment: Optional[str], role: Optional[str]) -> dict:
    require_role(role, QA)
    if not comment or not comment.strip():
        raise AppealError(422, "A comment is required to file an appeal")
    if not conn.execute("SELECT 1 FROM evaluation WHERE id = ?", (evaluation_id,)).fetchone():
        raise AppealError(404, "Evaluation not found")
    if not conn.execute(
        "SELECT 1 FROM criterion_result WHERE evaluation_id = ? AND criterion_id = ?", (evaluation_id, criterion_id)
    ).fetchone():
        raise AppealError(404, "Criterion not found in this evaluation")
    if conn.execute(
        "SELECT 1 FROM appeal WHERE evaluation_id = ? AND criterion_id = ? AND status = 'open'", (evaluation_id, criterion_id)
    ).fetchone():
        raise AppealError(409, "An open appeal already exists for this criterion")
    cur = conn.execute(
        "INSERT INTO appeal (evaluation_id, criterion_id, comment) VALUES (?,?,?)",
        (evaluation_id, criterion_id, comment.strip()),
    )
    conn.commit()
    return _appeal_row(conn, cur.lastrowid)


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
        raise AppealError(409, "This appeal is already resolved")
    if decision not in ("confirm", "change"):
        raise AppealError(422, "decision must be confirm or change")
    if not reason or not reason.strip():
        raise AppealError(422, "A reason is required")
    stored_answer = None
    if decision == "change":
        cfg = _config(conn, appeal["evaluation_id"])
        stored_answer = validate_answer(cfg, appeal["criterion_id"], new_answer)
    elif new_answer not in (None, ""):
        raise AppealError(422, "new_answer is only allowed for a change")
    conn.execute(
        "INSERT INTO review_decision (appeal_id, decision, new_answer, reason) VALUES (?,?,?,?)",
        (appeal_id, decision, stored_answer, reason.strip()),
    )
    conn.execute("UPDATE appeal SET status = 'resolved' WHERE id = ?", (appeal_id,))
    conn.commit()
    return _appeal_row(conn, appeal_id)


def get_appeal(conn: sqlite3.Connection, appeal_id: int) -> dict:
    return _appeal_row(conn, appeal_id)


def evaluation_appeals(conn: sqlite3.Connection, evaluation_id: int) -> list[dict]:
    rows = conn.execute("SELECT id FROM appeal WHERE evaluation_id = ? ORDER BY id", (evaluation_id,)).fetchall()
    return [_appeal_row(conn, r["id"]) for r in rows]


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
    ev["decisions"] = [a for a in appeals if a["status"] == "resolved"]
    open_ids = {a["criterion_id"] for a in appeals if a["status"] == "open"}
    ev["appealed_criteria"] = sorted(open_ids)
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
            {"id": s.id, "title": s.title, "earned": _num(s.earned), "applicable_max": _num(s.applicable_max), "percent": _num(s.percent)}
            for s in result.sections
        ],
    }
    return ev


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
        ev = conn.execute(
            "SELECT e.id, e.conversation_id AS conversation_pk, e.checklist_version_id, c.conversation_id, c.channel, c.language "
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
