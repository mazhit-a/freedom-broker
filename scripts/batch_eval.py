import argparse
import sys

from backend.app.core.config import get_settings
from backend.app.core.database import connect, init_db
from backend.app.services import batch
from backend.app.services.checklist import seed_default
from backend.app.services.llm_client import LLMClient


def default_version(conn) -> int | None:
    row = conn.execute("SELECT default_version_id FROM checklist WHERE default_version_id IS NOT NULL ORDER BY id LIMIT 1").fetchone()
    return row["default_version_id"] if row else None


def render(snapshot: dict) -> str:
    return (
        f"[{snapshot['status']}] {snapshot['processed']}/{snapshot['to_run']} "
        f"(skipped {snapshot['skipped']}, completed {snapshot['completed']}, needs_review {snapshot['needs_review']}, "
        f"failed {snapshot['failed']}, in flight {snapshot['in_flight']}, throttle retries {snapshot['throttled_retries']})"
    )


def main(argv: list[str] | None = None, client: LLMClient | None = None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate a whole dataset with a checklist version")
    parser.add_argument("dataset", help="dataset group_id or numeric dataset id")
    parser.add_argument("--version", type=int, default=None, help="checklist version id (default: default version)")
    parser.add_argument("--force", action="store_true", help="re-evaluate conversations that already have a completed evaluation")
    parser.add_argument("--no-retry-failed", action="store_true", help="do not re-run failed or needs_review evaluations")
    parser.add_argument("--concurrency", type=int, default=None, help="override CQA_BATCH_CONCURRENCY")
    args = parser.parse_args(argv)

    init_db()
    conn = connect()
    try:
        seed_default(conn)
        version_id = args.version or default_version(conn)
        if version_id is None:
            print("No checklist version available", file=sys.stderr)
            return 2
        llm = client or LLMClient(settings=get_settings())
        try:
            snapshot = batch.run_job_sync(
                conn,
                args.dataset,
                version_id,
                llm,
                force=args.force,
                retry_failed=not args.no_retry_failed,
                concurrency=args.concurrency,
                on_progress=lambda s: print(render(s), flush=True),
            )
        except LookupError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        print(render(snapshot))
        for failure in snapshot["failures"]:
            print(f"FAILED {failure['conversation_id']}: {failure['error']}", file=sys.stderr)
        return 1 if snapshot["failed"] else 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
