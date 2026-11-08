import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.services.results_export import build_export  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Export evaluation results in the organisers' JSON 1.0 format")
    ap.add_argument("--set", required=True, choices=["dev", "prod"], help="output folder results/<set>/results.json")
    ap.add_argument("--dataset", required=True, help="group_id of the imported dataset, e.g. DEV")
    ap.add_argument("--team-name", default=os.environ.get("CQA_TEAM_NAME", "freedom-broker"))
    ap.add_argument("--version-id", type=int, default=None, help="checklist version id, default: the default version")
    ap.add_argument("--db", default=os.environ.get("CQA_DB_PATH", "cqa.db"))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    conn = sqlite3.connect(f"file:{Path(args.db).resolve()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    payload = build_export(conn, args.dataset, args.team_name, args.version_id)
    out = Path(args.out) if args.out else ROOT / "results" / args.set / "results.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok = sum(1 for r in payload["results"] if r["status"] == "ok")
    print(f"{out}: {len(payload['results'])} records, {ok} ok, {len(payload['results']) - ok} error")
    return 0


if __name__ == "__main__":
    sys.exit(main())
