import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "evals" / "dataset.json"
CHECKLIST = ROOT / "evals" / "checklist_v2.json"
OUT = ROOT / "evals" / "review" / "adjudicate_06.html"
CASES = ["case-001", "case-002", "case-009", "case-010", "case-013", "case-016", "case-021", "case-022", "case-025", "case-026", "case-027", "case-034"]
CRITERION = "06"
SEED = 20261108

PAGE = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blind labelling: criterion 06</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--mute:#6b6b66;--line:#dcdcd5;--blue:#1f5fbf;--ok:#1b7a3d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Inter,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 90px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 14px}
.crit{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:12px 0}.crit h2{margin:0 0 6px;font-size:17px}
.crit ol{margin:6px 0 0;padding-left:0;list-style:none}.crit li{margin:3px 0}.crit b{display:inline-block;min-width:26px}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);z-index:5;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.bar progress{flex:1;min-width:140px;height:10px}.bar button{padding:6px 12px;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer}
.bar button.primary{background:var(--blue);color:#fff;border-color:var(--blue)}
.case{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:16px 0;overflow:hidden}.case header{padding:10px 14px;background:#efefea;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.case header h3{margin:0;font-size:16px}.chip{font-size:12px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--mute)}
.tr{padding:8px 4px;font-size:14px;max-height:420px;overflow:auto;border-bottom:1px solid var(--line)}
.msg{display:flex;gap:8px;padding:2px 10px}.mi{width:34px;color:var(--mute);flex:none}.ts{width:78px;color:var(--mute);flex:none;font-variant-numeric:tabular-nums}.sp{width:66px;flex:none;color:var(--mute)}
.msg.client .sp{color:#7a4b00}.msg.operator .sp{color:#0b5b8c}.msg.system,.msg.bot{color:var(--mute)}
.choose{padding:12px 14px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}.choose label{display:flex;gap:6px;align-items:center;cursor:pointer;padding:6px 10px;border:1px solid var(--line);border-radius:8px}
.choose label:has(input:checked){border-color:var(--blue);background:#e8f0ff}.choose input[type=text]{flex:1;min-width:200px;padding:6px 8px;border:1px solid var(--line);border-radius:6px}
.done{color:var(--ok);font-weight:600}
</style></head><body><main>
<h1>Blind labelling: criterion 06</h1>
<p class="sub">For each conversation choose the step that fits the operator. You are not shown any model answer or earlier label. If you cannot decide, tick "unsure" and note why. Answers autosave in this browser.</p>
<div class="crit" id="crit"></div>
<div class="bar"><progress id="prog" max="1" value="0"></progress><span id="count"></span><button class="primary" id="dl">Download answers</button></div>
<div id="cases"></div>
</main>
<script>
const DATA = __DATA__;
const KEY = "adjudicate_06_v1";
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { saved = {}; }
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };
const crit = document.getElementById("crit");
crit.appendChild(el("h2", "", DATA.criterion.id + " " + DATA.criterion.title));
crit.appendChild(el("div", "", DATA.criterion.description));
const ol = el("ol");
DATA.criterion.steps.forEach(s => { const li = el("li"); li.appendChild(el("b", "", String(s.value))); li.appendChild(document.createTextNode(" " + s.descriptor)); ol.appendChild(li); });
crit.appendChild(ol);
const wrap = document.getElementById("cases");
function persist() { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {} update(); }
function update() {
  const done = DATA.cases.filter(c => saved[c.id] && (saved[c.id].answer !== undefined || saved[c.id].unsure)).length;
  document.getElementById("prog").value = done / DATA.cases.length;
  document.getElementById("count").textContent = done + " of " + DATA.cases.length + " done";
}
DATA.cases.forEach((c, i) => {
  const box = el("section", "case");
  const h = el("header"); h.appendChild(el("h3", "", "Conversation " + (i + 1)));
  h.appendChild(el("span", "chip", c.channel + " · " + c.language + " · " + c.messages.length + " messages"));
  box.appendChild(h);
  const tr = el("div", "tr");
  c.messages.forEach(m => {
    const r = el("div", "msg " + m.speaker);
    r.appendChild(el("span", "mi", "#" + m.message_index));
    r.appendChild(el("span", "ts", m.timestamp_raw || ""));
    r.appendChild(el("span", "sp", m.speaker));
    r.appendChild(el("span", "tx", m.text));
    tr.appendChild(r);
  });
  box.appendChild(tr);
  const ch = el("div", "choose");
  const cur = saved[c.id] || {};
  DATA.criterion.steps.slice().sort((a, b) => b.value - a.value).forEach(s => {
    const lab = el("label"); const inp = el("input"); inp.type = "radio"; inp.name = c.id; inp.value = String(s.value);
    inp.checked = cur.answer === s.value;
    inp.addEventListener("change", () => { saved[c.id] = Object.assign(saved[c.id] || {}, { answer: s.value, unsure: false }); persist(); u.checked = false; });
    lab.appendChild(inp); lab.appendChild(document.createTextNode(String(s.value))); ch.appendChild(lab);
  });
  const ul = el("label"); const u = el("input"); u.type = "checkbox"; u.checked = !!cur.unsure;
  u.addEventListener("change", () => { const s = saved[c.id] = saved[c.id] || {}; s.unsure = u.checked; persist(); });
  ul.appendChild(u); ul.appendChild(document.createTextNode("unsure")); ch.appendChild(ul);
  const note = el("input"); note.type = "text"; note.placeholder = "note (optional)"; note.value = cur.note || "";
  note.addEventListener("input", () => { const s = saved[c.id] = saved[c.id] || {}; s.note = note.value; persist(); });
  ch.appendChild(note);
  box.appendChild(ch);
  wrap.appendChild(box);
});
document.getElementById("dl").addEventListener("click", () => {
  const out = { criterion: DATA.criterion.id, seed: DATA.seed, answers: DATA.cases.map(c => Object.assign({ case_id: c.id }, saved[c.id] || {})) };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "adjudication_06.json"; a.click();
});
update();
</script></body></html>
"""


def main() -> None:
    dataset = json.loads(DATASET.read_text())
    cfg = json.loads(CHECKLIST.read_text())
    crit = next(c for c in cfg["criteria"] if c["id"] == CRITERION)
    by_id = {c["id"]: c for c in dataset["cases"]}
    order = CASES[:]
    random.Random(SEED).shuffle(order)
    cases = []
    for cid in order:
        conv = by_id[cid]["conversation"]
        cases.append(
            {
                "id": cid,
                "channel": conv["channel"],
                "language": conv["language"],
                "messages": [
                    {k: m.get(k) for k in ("message_index", "timestamp_raw", "speaker", "text")} for m in conv["messages"]
                ],
            }
        )
    data = {
        "criterion": {
            "id": CRITERION,
            "title": crit["title"],
            "description": crit.get("description") or "",
            "steps": [{"value": s["value"], "descriptor": s["descriptor"]} for s in crit["scale_steps"]],
        },
        "seed": SEED,
        "cases": cases,
    }
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    OUT.write_text(PAGE.replace("__DATA__", blob), encoding="utf-8")
    print(OUT)


if __name__ == "__main__":
    sys.exit(main())
