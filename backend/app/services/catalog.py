import sqlite3

from backend.app.core.config import get_settings
from backend.app.services import batch
from backend.app.services.model_profiles import PROFILES, ModelProfile, profile_from_settings

PROFILE_ESTIMATES: dict[str, tuple[int, int, float]] = {
    "gpt-6.1-sol": (3000, 650, 10.0),
}


def _measured(conn: sqlite3.Connection, model: str, legacy: bool = True) -> tuple[float | None, float | None, int]:
    clause = "(model = ? OR model IS NULL)" if legacy else "model = ?"
    row = conn.execute(
        "SELECT AVG(cost) AS cost, AVG(latency_ms) AS latency, COUNT(*) AS n FROM evaluation "
        f"WHERE status IN ('completed','needs_review') AND cost IS NOT NULL AND cost > 0 AND {clause}",
        (model,),
    ).fetchone()
    if not row or not row["n"]:
        return None, None, 0
    latency = round(row["latency"] / 1000, 1) if row["latency"] else None
    return round(row["cost"], 6), latency, row["n"]


def configured_price(settings=None) -> float:
    s = settings or get_settings()
    return round((s.llm_estimate_tokens_input * s.llm_price_input + s.llm_estimate_tokens_output * s.llm_price_output) / 1_000_000, 6)


def _estimates(profile: ModelProfile, s, use_settings: bool) -> tuple[int, int, float]:
    if not use_settings and profile.model in PROFILE_ESTIMATES:
        return PROFILE_ESTIMATES[profile.model]
    return s.llm_estimate_tokens_input, s.llm_estimate_tokens_output, s.llm_estimate_latency_s


def _entry(conn: sqlite3.Connection, s, profile: ModelProfile, default: bool) -> dict:
    primary_anthropic = default and profile.provider != "openai"
    tokens_in, tokens_out, latency_s = _estimates(profile, s, primary_anthropic)
    if primary_anthropic:
        configured = configured_price(s)
    else:
        configured = round((tokens_in * profile.price_input + tokens_out * profile.price_output) / 1_000_000, 6)
    cost, latency, n = _measured(conn, profile.model, legacy=primary_anthropic)
    return {
        "id": profile.model,
        "label": (s.llm_label if default and s.llm_label else profile.model),
        "paid": True,
        "default": default,
        "price_per_evaluation": cost if cost is not None else configured,
        "price_source": "history" if cost is not None else "configured",
        "measured_evaluations": n,
        "avg_latency_s": latency if latency is not None else latency_s,
        "price_input_per_mtok": profile.price_input,
        "price_output_per_mtok": profile.price_output,
        "price_cache_read_per_mtok": profile.price_cache_read,
    }


def model_entry(conn: sqlite3.Connection) -> dict:
    s = get_settings()
    return _entry(conn, s, profile_from_settings(s), True)


def list_models(conn: sqlite3.Connection) -> list[dict]:
    s = get_settings()
    primary = profile_from_settings(s)
    entries = [_entry(conn, s, primary, True)]
    fallback = (s.llm_fallback_model or "").strip()
    if fallback and fallback != primary.model and fallback in PROFILES:
        entries.append(_entry(conn, s, PROFILES[fallback], False))
    return entries


def find_model(conn: sqlite3.Connection, model_id: str | None) -> dict | None:
    entries = list_models(conn)
    if model_id is None:
        return entries[0]
    for entry in entries:
        if entry["id"] == model_id:
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
    model: str | None = None,
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
    entry = find_model(conn, model) or model_entry(conn)
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
