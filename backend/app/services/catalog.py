import sqlite3

from backend.app.core.config import get_settings
from backend.app.services import batch


def _measured(conn: sqlite3.Connection, model: str) -> tuple[float | None, float | None, int]:
    row = conn.execute(
        "SELECT AVG(cost) AS cost, AVG(latency_ms) AS latency, COUNT(*) AS n FROM evaluation "
        "WHERE status IN ('completed','needs_review') AND cost IS NOT NULL AND cost > 0 AND (model = ? OR model IS NULL)",
        (model,),
    ).fetchone()
    if not row or not row["n"]:
        return None, None, 0
    latency = round(row["latency"] / 1000, 1) if row["latency"] else None
    return round(row["cost"], 6), latency, row["n"]


def configured_price(settings=None) -> float:
    s = settings or get_settings()
    return round((s.llm_estimate_tokens_input * s.llm_price_input + s.llm_estimate_tokens_output * s.llm_price_output) / 1_000_000, 6)


def model_entry(conn: sqlite3.Connection) -> dict:
    s = get_settings()
    cost, latency, n = _measured(conn, s.llm_model)
    return {
        "id": s.llm_model,
        "label": s.llm_label or s.llm_model,
        "paid": True,
        "default": True,
        "price_per_evaluation": cost if cost is not None else configured_price(s),
        "price_source": "history" if cost is not None else "configured",
        "measured_evaluations": n,
        "avg_latency_s": latency if latency is not None else s.llm_estimate_latency_s,
        "price_input_per_mtok": s.llm_price_input,
        "price_output_per_mtok": s.llm_price_output,
    }


def list_models(conn: sqlite3.Connection) -> list[dict]:
    return [model_entry(conn)]


def find_model(conn: sqlite3.Connection, model_id: str | None) -> dict | None:
    entry = model_entry(conn)
    if model_id is None or model_id == entry["id"]:
        return entry
    return None


def estimate(
    conn: sqlite3.Connection,
    dataset: str | None,
    version_id: int,
    force: bool = False,
    retry_failed: bool = True,
    concurrency: int | None = None,
    conversation_pks: list[int] | None = None,
) -> dict:
    if dataset:
        items = batch.select_conversations(conn, dataset)
        if conversation_pks is not None:
            wanted = set(conversation_pks)
            items = [i for i in items if i["id"] in wanted]
    else:
        items = batch.select_by_pks(conn, conversation_pks or [])
    if not items:
        raise LookupError(f"No conversations found for dataset {dataset}")
    statuses = batch.existing_statuses(conn, version_id)
    to_run = sum(1 for i in items if batch.needs_run(statuses.get(i["id"]), force, retry_failed))
    entry = model_entry(conn)
    workers = max(1, concurrency or get_settings().cqa_batch_concurrency)
    price = entry["price_per_evaluation"]
    return {
        "dataset": dataset,
        "checklist_version_id": version_id,
        "model": entry["id"],
        "total": len(items),
        "skipped": len(items) - to_run,
        "to_run": to_run,
        "price_per_evaluation": price,
        "price_source": entry["price_source"],
        "cost_estimate": round(to_run * price, 4),
        "concurrency": workers,
        "seconds_estimate": round(to_run * entry["avg_latency_s"] / workers, 1),
        "currency": "USD",
    }
