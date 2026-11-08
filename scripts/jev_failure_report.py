import collections
import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DATASET = ROOT / "evals" / "dataset.json"
RUNS = ROOT / "evals" / "runs"
BLIND = ROOT / "evals" / "gen" / "out" / "blind_results.jsonl"
OUT = ROOT / "evals" / "reports" / "jev_failures.html"

JEV = {
    "default": "20261107-222725-jev_only-dev",
    "rich": "20261107-231406-jev_rich-dev",
    "split": "20261107-231410-jev_split-dev",
    "rich_split": "20261107-231436-jev_rich_split-dev",
}
OPUS = "20261107-220004-baseline-dev"
CRITERIA = {
    "01": "Установление контакта",
    "02": "Выявление потребности",
    "03": "Идентификация",
    "04": "Корректная и полная консультация",
    "05": "Эмпатия и клиентоориентированность",
    "06": "Управление диалогом, скорость и грамотность",
    "07": "Завершение",
    "08": "Грубые ошибки",
}
SCALE = {"04": [0, 5, 10, 15, 20], "06": [0, 4, 7, 10]}


def esc(value) -> str:
    return html.escape(str(value if value is not None else ""))


def load_rows(run: str) -> list[dict]:
    data = json.loads((RUNS / run / "results.json").read_text())
    return data if isinstance(data, list) else data.get("candidates", data)


def by_case(run: str, rep: int = 0) -> dict[str, dict]:
    return {r["case_id"]: r for r in load_rows(run) if r.get("rep", 0) == rep}


def load_blind() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for line in BLIND.read_text().splitlines():
        row = json.loads(line)
        text = row.get("text") or row.get("result", {}).get("message", {}).get("content", [{}])[0].get("text")
        try:
            out[row["custom_id"]] = {x["criterion_id"]: x for x in json.loads(text)["results"]}
        except (TypeError, ValueError, KeyError):
            continue
    return out


def same(a, b) -> bool:
    return str(a) == str(b)


def step_gap(cid: str, a, b):
    if cid not in SCALE:
        return None
    try:
        return abs(SCALE[cid].index(int(a)) - SCALE[cid].index(int(b)))
    except (ValueError, TypeError):
        return None


def direction(cid: str, jev, expected) -> str:
    if cid not in SCALE:
        return f"{expected} -> {jev}"
    try:
        return "too high" if int(jev) > int(expected) else "too low"
    except (ValueError, TypeError):
        return "other"


def pct(n, d) -> str:
    return f"{n / d * 100:.1f}%" if d else "n/a"


def dist_bars(dist: dict | None, chosen, expected) -> str:
    if not dist:
        return ""
    rows = []
    for key, p in sorted(dist.items(), key=lambda kv: -kv[1]):
        cls = "bar"
        tag = ""
        if same(key, chosen):
            tag += " (Jev)"
            cls += " jev"
        if same(key, expected):
            tag += " (expected)"
            cls += " exp"
        rows.append(
            f'<div class="drow"><span class="dk">{esc(key)}{esc(tag)}</span>'
            f'<span class="{cls}" style="width:{max(p * 160, 1):.0f}px"></span><span class="dv">{p:.2f}</span></div>'
        )
    return "".join(rows)


def transcript_html(messages: list[dict], exp_ev: set, opus_ev: set, rng: dict | None) -> str:
    lines = []
    for m in messages:
        idx = m["message_index"]
        cls = ["msg", m["speaker"]]
        if idx in exp_ev:
            cls.append("ev-exp")
        if idx in opus_ev:
            cls.append("ev-opus")
        if rng and rng["from"] <= idx <= rng["to"]:
            cls.append("in-range")
        lines.append(
            f'<div class="{" ".join(cls)}"><span class="mi">#{idx}</span>'
            f'<span class="sp">{esc(m["speaker"])}</span><span class="tx">{esc(m["text"])}</span></div>'
        )
    return "".join(lines)


def evidence_list(ev: list[dict]) -> str:
    if not ev:
        return "<em>none</em>"
    return "<ul>" + "".join(f'<li>#{e["message_index"]}: «{esc(e["quote"])}»</li>' for e in ev) + "</ul>"


def build() -> str:
    ds = {c["id"]: c for c in json.loads(DATASET.read_text())["cases"] if c["split"] == "dev"}
    jev = {name: by_case(run) for name, run in JEV.items()}
    opus0, opus1 = by_case(OPUS, 0), by_case(OPUS, 1)
    blind = load_blind()

    errors = []
    totals = collections.Counter()
    for cid, case in ds.items():
        for k, exp in case["expected"].items():
            totals[k] += 1
            cand = jev["default"][cid]["results"][k]
            if same(cand["answer"], exp["answer"]):
                continue
            o0 = opus0[cid]["results"][k]
            o1 = opus1[cid]["results"][k]
            variants = {n: jev[n][cid]["results"][k]["answer"] for n in JEV}
            errors.append(
                {
                    "case": cid,
                    "k": k,
                    "tags": case["tags"],
                    "exp": exp,
                    "jev": cand,
                    "opus": o0,
                    "opus_wrong_0": not same(o0["answer"], exp["answer"]),
                    "opus_wrong_1": not same(o1["answer"], exp["answer"]),
                    "blind": blind.get(cid, {}).get(k),
                    "variants": variants,
                    "persist": sum(1 for n, a in variants.items() if n != "default" and same(a, cand["answer"])),
                    "wrong_in": sum(1 for n, a in variants.items() if not same(a, exp["answer"])),
                }
            )

    n_err = len(errors)
    total = sum(totals.values())
    by_k = collections.Counter(e["k"] for e in errors)
    by_len = collections.Counter(e["tags"]["length"] for e in errors)
    len_tot = collections.Counter()
    lang_tot = collections.Counter()
    chan_tot = collections.Counter()
    for c in ds.values():
        len_tot[c["tags"]["length"]] += 8
        lang_tot[c["tags"]["language"]] += 8
        chan_tot[c["tags"]["channel"]] += 8
    by_lang = collections.Counter(e["tags"]["language"] for e in errors)
    by_chan = collections.Counter(e["tags"]["channel"] for e in errors)

    jev_only = [e for e in errors if not e["opus_wrong_0"]]
    shared = [e for e in errors if e["opus_wrong_0"]]
    robust = [e for e in errors if e["wrong_in"] == len(JEV)]
    flips = [e for e in errors if e["k"] not in SCALE]
    far = [e for e in errors if e["k"] in SCALE and (step_gap(e["k"], e["jev"]["answer"], e["exp"]["answer"]) or 0) >= 2]
    adjacent = [e for e in errors if e["k"] in SCALE and (step_gap(e["k"], e["jev"]["answer"], e["exp"]["answer"]) or 0) == 1]

    conf_err = [e["jev"].get("confidence") or 0 for e in errors]
    conf_ok = []
    for cid, case in ds.items():
        for k, exp in case["expected"].items():
            a = jev["default"][cid]["results"][k]
            if same(a["answer"], exp["answer"]):
                conf_ok.append(a.get("confidence") or 0)

    hard_err = collections.Counter()
    hard_tot = collections.Counter()
    for c in ds.values():
        for h in c["tags"]["hard"]:
            hard_tot[h] += 8
    for e in errors:
        for h in e["tags"]["hard"]:
            hard_err[h] += 1

    def table(headers, rows):
        head = "".join(f"<th>{esc(h)}</th>" for h in headers)
        body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
        return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"

    css = """
    :root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--mute:#6b6b66;--line:#dcdcd5;--bad:#b3261e;--ok:#1b7a3d;--blue:#1f5fbf;--warn:#9a6700}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Inter,Segoe UI,sans-serif}
    main{max-width:1100px;margin:0 auto;padding:24px 16px 80px}h1{font-size:26px;margin:0 0 4px}h2{margin:36px 0 10px;font-size:20px;border-bottom:1px solid var(--line);padding-bottom:6px}
    h3{margin:0;font-size:16px}p.sub{color:var(--mute);margin:0 0 18px}table{border-collapse:collapse;width:100%;background:var(--card);margin:8px 0 14px;font-size:14px}
    th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}th{background:#efefea}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0 18px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
    .kpi b{display:block;font-size:22px}.kpi span{color:var(--mute);font-size:13px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:14px 0;overflow:hidden}.card header{padding:10px 14px;background:#efefea;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
    .chip{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--mute)}.chip.bad{color:var(--bad);border-color:var(--bad)}.chip.ok{color:var(--ok);border-color:var(--ok)}.chip.warn{color:var(--warn);border-color:var(--warn)}
    .body{padding:12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:800px){.body{grid-template-columns:1fr}}
    .col h4{margin:0 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}.col p{margin:0 0 8px}.col ul{margin:2px 0 8px;padding-left:18px}
    .ans{font-weight:600;padding:1px 6px;border-radius:4px;background:#efefea}.ans.bad{background:#fbe3e1;color:var(--bad)}.ans.ok{background:#dff1e5;color:var(--ok)}
    .drow{display:flex;align-items:center;gap:8px;font-size:13px}.dk{width:150px;color:var(--mute)}.bar{display:inline-block;height:10px;background:#bdbdb5;border-radius:3px}.bar.jev{background:var(--bad)}.bar.exp{background:var(--ok)}.bar.jev.exp{background:var(--ok)}.dv{color:var(--mute)}
    details{border-top:1px solid var(--line);padding:8px 14px}summary{cursor:pointer;color:var(--blue)}.tr{margin-top:8px;font-size:13.5px}
    .msg{display:flex;gap:8px;padding:2px 6px;border-left:3px solid transparent}.msg .mi{width:34px;color:var(--mute);flex:none}.msg .sp{width:64px;color:var(--mute);flex:none}.msg.client .sp{color:#7a4b00}.msg.operator .sp{color:#0b5b8c}
    .msg.system,.msg.bot{color:var(--mute)}.ev-exp{background:#e4f4ea;border-left-color:var(--ok)}.ev-opus{border-left-color:var(--blue);box-shadow:inset 3px 0 0 var(--blue)}.in-range{background:#fff7dd}
    .legend span{margin-right:14px;font-size:13px}.k{display:inline-block;width:12px;height:12px;vertical-align:-1px;margin-right:4px;border:1px solid var(--line)}
    nav a{margin-right:12px;color:var(--blue)}code{background:#efefea;padding:0 4px;border-radius:3px}
    """

    parts = [
        f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Jev failure report</title><style>{css}</style></head><body><main>",
        "<h1>Where Jev 1.14 fails on the eval set</h1>",
        f"<p class='sub'>Dataset v1, 24 dev cases, 192 criterion results. Jev run <code>{JEV['default']}</code> (default mapping); comparison with Opus 5.5 medium (baseline, repeat 0), the blind Sonnet 5.5 check, and three other Jev mappings. Expected answers are the reviewed labels.</p>",
        "<nav><a href='#summary'>Summary</a><a href='#slices'>Slices</a><a href='#confidence'>Confidence</a><a href='#catalogue'>All failures</a></nav>",
        "<h2 id='summary'>Summary</h2><div class='grid'>",
        f"<div class='kpi'><b>{n_err} / {total}</b><span>Jev errors ({pct(total - n_err, total)} accuracy)</span></div>",
        f"<div class='kpi'><b>{len(jev_only)}</b><span>Jev wrong, Opus right</span></div>",
        f"<div class='kpi'><b>{len(shared)}</b><span>Jev and Opus both wrong</span></div>",
        f"<div class='kpi'><b>{len(robust)}</b><span>wrong in all 4 Jev mappings</span></div>",
        f"<div class='kpi'><b>{len(flips)}</b><span>yes/no/na flips</span></div>",
        f"<div class='kpi'><b>{len(adjacent)} / {len(far)}</b><span>scale errors: one step / two or more steps</span></div>",
        "</div>",
        "<p>Reading the split: errors where Opus is also wrong point at a hard case or at an arguable label; errors where only Jev is wrong are Jev's own failures.</p>",
        "<h2 id='slices'>Where the errors are</h2>",
        "<h3>By criterion</h3>",
        table(
            ["Criterion", "Errors", "Of", "Accuracy", "Jev only", "Shared with Opus"],
            [
                [
                    f"{k} {esc(CRITERIA[k])}",
                    by_k[k],
                    totals[k],
                    pct(totals[k] - by_k[k], totals[k]),
                    sum(1 for e in jev_only if e["k"] == k),
                    sum(1 for e in shared if e["k"] == k),
                ]
                for k in sorted(CRITERIA)
            ],
        ),
        "<h3>By transcript length</h3>",
        table(
            ["Length", "Errors", "Of", "Accuracy"],
            [[l, by_len[l], len_tot[l], pct(len_tot[l] - by_len[l], len_tot[l])] for l in ("short", "medium", "long")],
        ),
        "<h3>By language and channel</h3>",
        table(
            ["Slice", "Errors", "Of", "Accuracy"],
            [[f"language {l}", by_lang[l], lang_tot[l], pct(lang_tot[l] - by_lang[l], lang_tot[l])] for l in sorted(lang_tot)]
            + [[f"channel {c}", by_chan[c], chan_tot[c], pct(chan_tot[c] - by_chan[c], chan_tot[c])] for c in sorted(chan_tot)],
        ),
        "<h3>By hard-case tag</h3>",
        table(
            ["Hard case", "Errors", "Of", "Accuracy"],
            [[esc(h), hard_err[h], hard_tot[h], pct(hard_tot[h] - hard_err[h], hard_tot[h])] for h in sorted(hard_tot)],
        ),
        "<h3>Scale errors by direction</h3>",
        table(
            ["Criterion", "Jev too high", "Jev too low"],
            [
                [
                    k,
                    sum(1 for e in errors if e["k"] == k and direction(k, e["jev"]["answer"], e["exp"]["answer"]) == "too high"),
                    sum(1 for e in errors if e["k"] == k and direction(k, e["jev"]["answer"], e["exp"]["answer"]) == "too low"),
                ]
                for k in SCALE
            ],
        ),
        "<h3>Yes / no / na confusion on the flipped criteria</h3>",
        table(
            ["Expected", "Jev answered", "Count", "Cases"],
            [
                [exp, ans, len(v), esc(", ".join(f"{e['case']}/{e['k']}" for e in v))]
                for (exp, ans), v in sorted(
                    collections.defaultdict(list, {key: [e for e in flips if (str(e["exp"]["answer"]), str(e["jev"]["answer"])) == key] for key in {(str(e["exp"]["answer"]), str(e["jev"]["answer"])) for e in flips}}).items()
                )
            ],
        ),
        "<h2 id='confidence'>Confidence</h2>",
        f"<p>Mean confidence on correct answers {sum(conf_ok) / len(conf_ok):.2f}; on errors {sum(conf_err) / len(conf_err):.2f}.</p>",
    ]
    rows = []
    for t in (0.6, 0.7, 0.8, 0.9, 0.95):
        esc_n = sum(1 for c in conf_ok if c < t) + sum(1 for c in conf_err if c < t)
        caught = sum(1 for c in conf_err if c < t)
        confident = sum(1 for c in conf_err if c >= t)
        rows.append([f"&lt; {t}", pct(esc_n, total), f"{caught} / {n_err}", confident])
    parts.append(table(["Threshold", "Criteria below it", "Errors below it", "Errors above it (confident errors)"], rows))
    top = sorted(errors, key=lambda e: -(e["jev"].get("confidence") or 0))[:6]
    parts.append(
        "<p>Most confident errors: "
        + "; ".join(f"{e['case']}/{e['k']} ({e['jev'].get('confidence', 0):.2f}, expected {esc(e['exp']['answer'])}, Jev {esc(e['jev']['answer'])})" for e in top)
        + ".</p>"
    )

    parts.append("<h2 id='catalogue'>Every failure</h2>")
    parts.append(
        "<p class='legend'><span><i class='k' style='background:#e4f4ea'></i>evidence cited by the expected result</span>"
        "<span><i class='k' style='background:#fff;box-shadow:inset 3px 0 0 #1f5fbf'></i>evidence cited by Opus</span>"
        "<span><i class='k' style='background:#fff7dd'></i>expected checked range</span></p>"
    )
    order = sorted(errors, key=lambda e: (e["k"], e["case"]))
    for k in sorted(CRITERIA):
        group = [e for e in order if e["k"] == k]
        if not group:
            continue
        parts.append(f"<h3 style='margin-top:26px'>{k} {esc(CRITERIA[k])}: {len(group)} errors</h3>")
        for e in group:
            case = ds[e["case"]]
            exp, jv, op, bl = e["exp"], e["jev"], e["opus"], e["blind"]
            chips = [
                f"<span class='chip'>{esc(case['tags']['channel'])} · {esc(case['tags']['language'])} · {esc(case['tags']['length'])} · {len(case['conversation']['messages'])} msgs</span>",
                f"<span class='chip'>{esc(case['tags']['topic'])}</span>",
            ]
            for h in case["tags"]["hard"]:
                chips.append(f"<span class='chip warn'>{esc(h)}</span>")
            chips.append(
                "<span class='chip ok'>Opus right</span>" if not e["opus_wrong_0"] else "<span class='chip bad'>Opus also wrong</span>"
            )
            chips.append(f"<span class='chip {'bad' if e['wrong_in'] == len(JEV) else ''}'>wrong in {e['wrong_in']} of 4 Jev mappings</span>")
            gap = step_gap(k, jv["answer"], exp["answer"])
            if k in SCALE:
                chips.append(f"<span class='chip'>{direction(k, jv['answer'], exp['answer'])}, {gap} step{'s' if gap != 1 else ''}</span>")
            blind_txt = ""
            if bl:
                ok = same(bl["answer"], exp["answer"])
                blind_txt = (
                    f"<h4>Blind Sonnet 5.5 (did not see the expected result)</h4><p><span class='ans {'ok' if ok else 'bad'}'>{esc(bl['answer'])}</span> {esc(bl['rationale'])}</p>"
                )
            variants = " · ".join(
                f"{n}: <span class='ans {'ok' if same(a, exp['answer']) else 'bad'}'>{esc(a)}</span>" for n, a in e["variants"].items()
            )
            parts.append(
                f"<div class='card'><header><h3>{esc(e['case'])} / {k}</h3>{''.join(chips)}</header><div class='body'>"
                f"<div class='col'><h4>Expected</h4><p><span class='ans ok'>{esc(exp['answer'])}</span> {esc(exp['rationale'])}</p>"
                f"<h4>Expected evidence</h4>{evidence_list(exp['evidence'])}"
                + (f"<p>Checked range: #{exp['checked_range']['from']}–#{exp['checked_range']['to']}</p>" if exp.get("checked_range") else "")
                + (f"<p>N/A reason: {esc(exp['na_reason'])}</p>" if exp.get("na_reason") else "")
                + f"<h4>Opus 5.5 medium (baseline)</h4><p><span class='ans {'bad' if e['opus_wrong_0'] else 'ok'}'>{esc(op['answer'])}</span> {esc(op.get('rationale'))}</p>"
                + (f"<p><em>Opus's second repeat was also wrong.</em></p>" if e["opus_wrong_1"] and e["opus_wrong_0"] else "")
                + f"{blind_txt}</div>"
                f"<div class='col'><h4>Jev answer</h4><p><span class='ans bad'>{esc(jv['answer'])}</span> confidence {jv.get('confidence', 0):.2f}</p>"
                f"{dist_bars(jv.get('distribution'), jv['answer'], exp['answer'])}"
                f"<h4>Same question under the other Jev mappings</h4><p>{variants}</p></div></div>"
                f"<details><summary>Transcript ({len(case['conversation']['messages'])} messages)</summary><div class='tr'>"
                f"{transcript_html(case['conversation']['messages'], {x['message_index'] for x in exp['evidence']}, {x['message_index'] for x in op.get('evidence', [])}, exp.get('checked_range'))}"
                f"</div></details></div>"
            )
    parts.append("</main></body></html>")
    return "".join(parts)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(build(), encoding="utf-8")
    print(OUT)


if __name__ == "__main__":
    main()
