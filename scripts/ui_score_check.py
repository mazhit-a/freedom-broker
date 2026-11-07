import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app.core.database import connect
from backend.app.services.checklist import get_version
from backend.app.services.scoring import score

db, eval_id = sys.argv[1], int(sys.argv[2])
conn = connect(db)
row = conn.execute("SELECT checklist_version_id FROM evaluation WHERE id=?", (eval_id,)).fetchone()
cfg = get_version(conn, row["checklist_version_id"]).config
answers = {
    r["criterion_id"]: r["answer"]
    for r in conn.execute("SELECT criterion_id, answer FROM criterion_result WHERE evaluation_id=?", (eval_id,))
    if r["answer"] not in (None, "")
}
overrides = {}
for r in conn.execute(
    "SELECT a.criterion_id, d.new_answer FROM appeal a JOIN review_decision d ON d.appeal_id=a.id "
    "WHERE a.evaluation_id=? AND d.decision='change' ORDER BY d.id",
    (eval_id,),
):
    overrides[r["criterion_id"]] = r["new_answer"]
res = score(cfg, answers, overrides)
print(
    json.dumps(
        {
            "total": float(res.total) if res.total is not None else None,
            "sections": {s.id: (float(s.earned) if s.earned is not None else None) for s in res.sections},
        }
    )
)
