import sqlite3
from datetime import date, datetime, timedelta
from statistics import median
from typing import Optional

from backend.app.core.config import get_settings
from backend.app.core.errors import ApiError
from backend.app.services.appeals import _appeal_row, age_hours, with_review
from backend.app.services.audio_timing import is_voice
from backend.app.services.checklist import get_version
from backend.app.services.evaluator import get_evaluation

TARGET_DAYS = 2
BUCKETS = 10
LOW_SCORE = 50.0
DONE = ("completed", "needs_review")


def _bound(value: Optional[str], name: str, end: bool) -> Optional[datetime]:
    if not value:
        return None
    try:
        if len(value) <= 10:
            d = datetime.combine(date.fromisoformat(value), datetime.min.time())
            return d + timedelta(days=1) if end else d
        return datetime.fromisoformat(value.replace("T", " ")[:19])
    except ValueError:
        raise ApiError(422, f"{name} must be an ISO date", "invalid_date")


def _fmt(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S")


def _select(conn, dataset, version_id, start, stop, language, channel) -> list[int]:
    sql = (
        "SELECT MAX(e.id) AS id FROM evaluation e JOIN conversation c ON c.id = e.conversation_id "
        "JOIN dataset d ON d.id = c.dataset_id WHERE e.status IN ('completed', 'needs_review')"
    )
    args: list = []
    if version_id:
        sql += " AND e.checklist_version_id = ?"
        args.append(version_id)
    if start:
        sql += " AND e.created_at >= ?"
        args.append(_fmt(start))
    if stop:
        sql += " AND e.created_at < ?"
        args.append(_fmt(stop))
    if dataset:
        if dataset.isdigit():
            sql += " AND (c.dataset_id = ? OR d.group_id = ?)"
            args += [int(dataset), dataset]
        else:
            sql += " AND d.group_id = ?"
            args.append(dataset)
    if language:
        sql += " AND UPPER(c.language) = UPPER(?)"
        args.append(language)
    if channel:
        voice = "(LOWER(COALESCE(c.channel, '')) LIKE '%call%' OR LOWER(COALESCE(c.channel, '')) LIKE '%voice%')"
        if channel.lower() == "call":
            sql += " AND " + voice
        elif channel.lower() == "chat":
            sql += " AND NOT " + voice
        else:
            sql += " AND LOWER(c.channel) = LOWER(?)"
            args.append(channel)
    sql += " GROUP BY e.conversation_id ORDER BY e.conversation_id"
    return [r["id"] for r in conn.execute(sql, args).fetchall()]


def _load(conn, ids: list[int]) -> list[dict]:
    rows = []
    for eid in ids:
        ev = with_review(conn, get_evaluation(conn, eid))
        conv = conn.execute(
            "SELECT conversation_id, channel, language, audio_url FROM conversation WHERE id = ?",
            (ev["conversation_id"],),
        ).fetchone()
        final = ev["final"]
        rows.append(
            {
                "ev": ev,
                "conversation_pk": ev["conversation_id"],
                "conversation_id": conv["conversation_id"],
                "language": (conv["language"] or "").upper() or None,
                "kind": "call" if is_voice(conv["channel"], conv["audio_url"]) else "chat",
                "total": ev["final_total"],
                "gross": bool(final["gross_violation"]) if final else bool(ev["gross_violation"]),
            }
        )
    return rows


def _avg(values: list[float]) -> Optional[float]:
    return round(sum(values) / len(values), 2) if values else None


def _share(part: int, whole: int) -> Optional[float]:
    return round(part * 100 / whole, 2) if whole else None


def _bucket(total: float) -> int:
    return min(max(int(total // 10), 0), BUCKETS - 1)


def _split(rows: list[dict], key: str) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for r in rows:
        if r[key]:
            groups.setdefault(r[key], []).append(r)
    out = []
    for name in sorted(groups):
        g = groups[name]
        scored = [r["total"] for r in g if r["total"] is not None]
        gross = sum(1 for r in g if r["gross"])
        out.append(
            {
                key if key != "kind" else "channel": name,
                "count": len(g),
                "avg": _avg(scored),
                "gross_count": gross,
                "gross_share": _share(gross, len(g)),
            }
        )
    return out


def _criteria(conn, rows: list[dict]) -> list[dict]:
    configs: dict[int, object] = {}
    acc: dict[str, dict] = {}
    for r in rows:
        ev = r["ev"]
        final = ev["final"]
        if not final:
            continue
        vid = ev["checklist_version_id"]
        if vid not in configs:
            configs[vid] = get_version(conn, vid).config
        cfg = configs[vid]
        meta = {c.id: c for c in cfg.criteria}
        for c in final["criteria"]:
            m = meta.get(c["criterion_id"])
            if m is None or m.type == "flag" or not m.weight:
                continue
            if c["status"] != "answered" or c["points"] is None:
                continue
            a = acc.setdefault(
                c["criterion_id"],
                {"criterion_id": c["criterion_id"], "title": m.title, "labels": None, "points": 0.0, "weight": 0.0, "count": 0, "version": -1},
            )
            if vid >= a["version"]:
                a["title"] = m.title
                a["labels"] = {k: v.model_dump() for k, v in (m.labels or {}).items()} or None
                a["version"] = vid
            a["points"] += c["points"]
            a["weight"] += m.weight
            a["count"] += 1
    out = [
        {
            "criterion_id": a["criterion_id"],
            "title": a["title"],
            "labels": a["labels"],
            "avg_percent": round(a["points"] * 100 / a["weight"], 2),
            "applicable_count": a["count"],
        }
        for a in acc.values()
        if a["weight"]
    ]
    out.sort(key=lambda x: (x["avg_percent"], x["criterion_id"]))
    return out


def _appeal_kpis(conn, rows: list[dict]) -> dict:
    ids = [r["ev"]["id"] for r in rows]
    threshold = get_settings().appeal_aging_hours
    open_count = older = 0
    durations: list[float] = []
    for eid in ids:
        for a in conn.execute("SELECT id FROM appeal WHERE evaluation_id = ?", (eid,)).fetchall():
            row = _appeal_row(conn, a["id"])
            hours = age_hours(row)
            if row["status"] == "open":
                open_count += 1
                if hours is not None and hours > threshold:
                    older += 1
            elif hours is not None:
                durations.append(hours)
    return {
        "open_appeals": open_count,
        "older_than_hours": older,
        "aging_hours": threshold,
        "median_resolution_days": round(median(durations) / 24, 2) if durations else None,
        "target_days": TARGET_DAYS,
    }


def _attention(rows: list[dict], limit: int) -> tuple[list[dict], int]:
    order = {"gross": 0, "low_score": 1, "appeal_pending": 2, "low_confidence": 3}
    items = []
    for r in rows:
        ev = r["ev"]
        reasons = []
        if r["gross"]:
            reasons.append("gross")
        if r["total"] is not None and r["total"] < LOW_SCORE:
            reasons.append("low_score")
        if ev["display_appeal_status"] in ("new", "under_review"):
            reasons.append("appeal_pending")
        if ev["confidence"]["level"] == "low":
            reasons.append("low_confidence")
        if reasons:
            items.append(
                {
                    "conversation_pk": r["conversation_pk"],
                    "conversation_id": r["conversation_id"],
                    "evaluation_id": ev["id"],
                    "language": r["language"],
                    "reason": reasons[0],
                    "reasons": reasons,
                    "score": r["total"],
                    "provisional": ev["confidence"]["level"] == "low",
                    "appeal_status": ev["display_appeal_status"],
                }
            )
    items.sort(key=lambda i: (order[i["reason"]], i["score"] if i["score"] is not None else 101, i["conversation_id"]))
    return items[:limit], len(items)


def overview(
    conn: sqlite3.Connection,
    dataset: Optional[str] = None,
    checklist_version_id: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    language: Optional[str] = None,
    channel: Optional[str] = None,
    attention_limit: int = 20,
) -> dict:
    start = _bound(date_from, "from", False)
    stop = _bound(date_to, "to", True)
    if start and stop and stop <= start:
        raise ApiError(422, "from must not be after to", "invalid_period")
    rows = _load(conn, _select(conn, dataset, checklist_version_id, start, stop, language, channel))
    scored = [r for r in rows if r["total"] is not None]
    totals = [r["total"] for r in scored]
    avg = _avg(totals)
    distribution = [
        {"range_from": i * 10, "range_to": (i + 1) * 10, "count": 0} for i in range(BUCKETS)
    ]
    for t in totals:
        distribution[_bucket(t)]["count"] += 1
    delta = None
    previous_avg = None
    if start and stop:
        span = stop - start
        prev = _load(conn, _select(conn, dataset, checklist_version_id, start - span, start, language, channel))
        prev_totals = [r["total"] for r in prev if r["total"] is not None]
        previous_avg = _avg(prev_totals)
        if avg is not None and prev_totals:
            delta = round(sum(totals) / len(totals) - sum(prev_totals) / len(prev_totals), 2)
    gross = sum(1 for r in scored if r["gross"])
    attention, attention_total = _attention(rows, attention_limit)
    kpis = {
        "avg": avg,
        "delta": delta,
        "previous_avg": previous_avg,
        "evaluated": len(scored),
        "not_calculated": len(rows) - len(scored),
        "chats": sum(1 for r in scored if r["kind"] == "chat"),
        "calls": sum(1 for r in scored if r["kind"] == "call"),
        "gross_count": gross,
        "gross_share": _share(gross, len(scored)),
        **_appeal_kpis(conn, rows),
    }
    return {
        "period": {
            "basis": "evaluation_date",
            "from": date_from or None,
            "to": date_to or None,
            "previous_from": _fmt(start - (stop - start)) if start and stop else None,
            "previous_to": _fmt(start) if start and stop else None,
        },
        "kpis": kpis,
        "distribution": distribution,
        "per_criterion": _criteria(conn, scored),
        "by_language": _split(scored, "language"),
        "by_channel": _split(scored, "kind"),
        "attention": attention,
        "attention_total": attention_total,
    }
