import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.services.checklist import NotFound  # noqa: E402
from backend.app.services.results_export import ExportError, build_export  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Export evaluation results in the organisers' JSON 1.0 format")
    ap.add_argument("--set", required=True, choices=["dev", "prod"], help="output folder results/<set>/results.json")
    ap.add_argument("--dataset", required=True, help="group_id of the imported dataset, e.g. DEV")
    ap.add_argument("--team-name", default=os.environ.get("CQA_TEAM_NAME", "freedom-broker"))
    ap.add_argument("--version-id", type=int, default=None, help="checklist version id, default: the default version")
    ap.add_argument("--db", default=os.environ.get("CQA_DB_PATH", "cqa.db"))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    db = Path(args.db).resolve()
    if not db.exists():
        print(f"database {db} not found: start the backend once so it creates the file, or pass --db. With Docker run the command inside the container, see the README.", file=sys.stderr)
        return 2
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        payload = build_export(conn, args.dataset, args.team_name, args.version_id)
    except (NotFound, ExportError) as exc:
        print(f"export failed: {exc}", file=sys.stderr)
        return 1
    out = Path(args.out) if args.out else ROOT / "results" / args.set / "results.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok = sum(1 for r in payload["results"] if r["status"] == "ok")
    print(f"{out}: {len(payload['results'])} records, {ok} ok, {len(payload['results']) - ok} error")
    return 0


if __name__ == "__main__":
    sys.exit(main())
