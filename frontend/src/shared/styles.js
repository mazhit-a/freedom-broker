export const SHARED_CSS = `
*, *::before, *::after { box-sizing: border-box; }
.tnum { font-variant-numeric: tabular-nums; }
a { color: var(--cqa-brand-deep); }
a:hover { color: var(--cqa-ink); }
:focus-visible { outline: 2px solid var(--cqa-focus); outline-offset: 2px; }
.btn { height: var(--cqa-control-h); padding: 0 14px; border-radius: var(--cqa-radius-control); border: 1px solid var(--cqa-line-strong); background: var(--cqa-surface); color: var(--cqa-ink); font: 500 var(--cqa-fs-13)/1 var(--cqa-font); display: inline-flex; align-items: center; gap: 6px; cursor: pointer; text-decoration: none; white-space: nowrap; }
.btn:hover { background: var(--cqa-surface-2); color: var(--cqa-ink); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary { background: var(--cqa-brand-strong); border-color: var(--cqa-brand-strong); color: var(--cqa-on-brand); }
.btn-primary:hover { background: var(--cqa-brand-deep); color: var(--cqa-on-brand); }
.btn-sm { height: 28px; padding: 0 10px; font-size: var(--cqa-fs-12); }
.btn-ghost { border-color: transparent; background: transparent; }
.btn-danger { border-color: var(--cqa-bad); color: var(--cqa-bad); }
.chip { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 6px; font-size: var(--cqa-fs-12); font-weight: 500; white-space: nowrap; }
.c-ok { background: var(--cqa-ok-bg); color: var(--cqa-ok); }
.c-warn { background: var(--cqa-warn-bg); color: var(--cqa-warn); }
.c-bad { background: var(--cqa-bad-bg); color: var(--cqa-bad); }
.c-na { background: var(--cqa-na-bg); color: var(--cqa-na); }
.c-crit { background: var(--cqa-critical-bg); color: var(--cqa-critical); }
.c-brand { background: var(--cqa-brand-tint); color: var(--cqa-brand-deep); }
.lang { font-size: 11px; font-weight: 600; letter-spacing: .04em; padding: 0 6px; height: 20px; border-radius: 4px; border: 1px solid var(--cqa-line-strong); color: var(--cqa-ink-2); display: inline-flex; align-items: center; }
.card { background: var(--cqa-surface); border: 1px solid var(--cqa-line); border-radius: var(--cqa-radius-card); }
.field { height: var(--cqa-control-h); border: 1px solid var(--cqa-line-strong); border-radius: var(--cqa-radius-control); padding: 0 10px; font: var(--cqa-fs-13) var(--cqa-font); color: var(--cqa-ink); background: var(--cqa-surface); }
.seg { display: inline-flex; border: 1px solid var(--cqa-line-strong); border-radius: var(--cqa-radius-control); overflow: hidden; height: 30px; }
.seg button { border: 0; background: transparent; padding: 0 10px; font: 500 var(--cqa-fs-12) var(--cqa-font); color: var(--cqa-ink-2); cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--cqa-ink); color: var(--cqa-surface); }
input[type="checkbox"], input[type="radio"] { width: 16px; height: 16px; accent-color: var(--cqa-brand-strong); margin: 0; }
.sec-h { margin: 0; font-size: var(--cqa-fs-20); font-weight: 600; }
.sub-h { margin: 0; font-size: var(--cqa-fs-12); font-weight: 600; color: var(--cqa-ink-3); text-transform: uppercase; letter-spacing: .04em; }
.muted { color: var(--cqa-ink-3); }
.skel { background: var(--cqa-surface-3); border-radius: 6px; display: block; }
.col { display: flex; flex-direction: column; }
.row { display: flex; flex-wrap: wrap; align-items: center; }
.gap-1 { gap: 4px; } .gap-2 { gap: 8px; } .gap-3 { gap: 12px; } .gap-4 { gap: 16px; }

.ev { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--cqa-line-strong); background: var(--cqa-surface); font: var(--cqa-fs-12) var(--cqa-font); color: var(--cqa-ink-2); text-decoration: none; font-variant-numeric: tabular-nums; cursor: pointer; }
.ev:hover { border-color: var(--cqa-hl-line); background: var(--cqa-hl); color: var(--cqa-ink); }
.ev-expected { border-style: dashed; border-color: var(--cqa-warn); color: var(--cqa-warn); }

.score { display: inline-flex; align-items: center; gap: 8px; }
.score-num { font-weight: 600; min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
.score-track { width: 64px; height: 6px; border-radius: 3px; background: var(--cqa-surface-3); display: inline-block; }
.score-fill { display: block; height: 6px; border-radius: 3px; }
.band-ok { background: var(--cqa-brand-deep); }
.band-warn { background: var(--cqa-warn); }
.band-bad { background: var(--cqa-bad); }
.score-dash { font-weight: 600; color: var(--cqa-ink-3); }

.kf { padding: 16px; border: 1px solid var(--cqa-line); border-radius: var(--cqa-radius-card); display: flex; flex-direction: column; gap: 4px; min-width: 180px; background: var(--cqa-surface); }
.kf-label { font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); }
.kf-value { font-size: var(--cqa-fs-32); font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.kf-delta { font-size: var(--cqa-fs-12); font-variant-numeric: tabular-nums; color: var(--cqa-ink-3); }
.kf-delta.up { color: var(--cqa-ok); }
.kf-delta.down { color: var(--cqa-bad); }

.panel { padding: 20px; display: flex; flex-direction: column; gap: 8px; }
.panel-error { border-color: var(--cqa-bad); }
.panel-title { font-weight: 600; }
.panel-title.bad { color: var(--cqa-bad); }
.panel-text { font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); }
.panel-big { font-size: var(--cqa-fs-20); font-weight: 600; font-variant-numeric: tabular-nums; }

.msg { max-width: 84%; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--cqa-line); font-size: var(--cqa-fs-13); overflow-wrap: anywhere; }
.msg-head { display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; }
.msg-who { font-weight: 700; }
.msg-meta { color: var(--cqa-ink-3); font-size: var(--cqa-fs-12); font-variant-numeric: tabular-nums; }
.msg-text { margin-top: 2px; white-space: pre-wrap; }
.msg-bot { border-style: dashed; border-color: var(--cqa-line-strong); background: var(--cqa-surface-2); color: var(--cqa-ink-2); }
.msg-bot .msg-who { color: var(--cqa-ink-3); }
.msg-operator { align-self: flex-end; background: var(--cqa-op-tint); }
.msg-operator .msg-who { color: var(--cqa-brand-deep); }
.msg-evidence { border-color: var(--cqa-hl-line); background: var(--cqa-hl); box-shadow: 0 0 0 1px var(--cqa-hl-line); }
.msg-expected { align-self: flex-end; border: 1.5px dashed var(--cqa-warn); background: var(--cqa-warn-bg); }
.msg-expected .msg-who { color: var(--cqa-warn); }
.msg-system-wrap { display: flex; justify-content: center; }
.msg-system { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); padding: 4px 10px; border-radius: 999px; border: 1px dashed var(--cqa-line-strong); background: var(--cqa-surface-2); overflow-wrap: anywhere; }
.msg:target, .msg.flash { box-shadow: 0 0 0 2px var(--cqa-focus); }

.crit { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 10px; }
.crit.selected { background: var(--cqa-brand-tint); box-shadow: inset 3px 0 0 var(--cqa-brand); }
.crit-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.crit-no { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); font-variant-numeric: tabular-nums; }
.crit-title { font-weight: 600; flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.crit-points { font-variant-numeric: tabular-nums; }
.crit-points b { font-size: var(--cqa-fs-16); }
.crit-body { font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); padding-left: 26px; }
.crit-foot { display: flex; gap: 6px; flex-wrap: wrap; padding-left: 26px; align-items: center; }
.crit-weight { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); font-variant-numeric: tabular-nums; }

.steps { display: grid; grid-template-columns: 64px 1fr 72px; gap: 6px 10px; align-items: center; font-size: var(--cqa-fs-13); margin: 0; padding: 0; list-style: none; }
.steps li { display: contents; }
.steps .step-n { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.steps .step-p { text-align: right; font-variant-numeric: tabular-nums; }

.tbl-wrap { overflow-x: auto; border: 1px solid var(--cqa-line); border-radius: var(--cqa-radius-card); background: var(--cqa-surface); }
.tbl { min-width: max-content; font-size: var(--cqa-fs-13); }
.tbl-row { display: grid; grid-template-columns: var(--cols); align-items: center; border-bottom: 1px solid var(--cqa-line); min-width: var(--min); }
.tbl-row > * { padding: 0 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tbl-head { height: 36px; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); font-weight: 500; }
.tbl-body { height: 40px; }
.tbl-body:hover { background: var(--cqa-surface-2); }
.tbl-body.selected { background: var(--cqa-brand-tint); }
.tbl-row .num { text-align: right; font-variant-numeric: tabular-nums; }
.tbl-row:last-child { border-bottom: 0; }
.sortbtn { border: 0; background: transparent; font: inherit; color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 0; }
.sortbtn:hover { color: var(--cqa-ink); }
@container (max-width: 1099px) {
  .tbl-row { grid-template-columns: var(--cols-narrow); min-width: var(--min-narrow); }
  .tbl-row > .secondary { display: none; }
}

.chart { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.chart-bars { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 6px; align-items: end; border-bottom: 1px solid var(--cqa-line-strong); height: var(--h); }
.chart-bar { display: flex; flex-direction: column; align-items: center; gap: 4px; justify-content: flex-end; height: 100%; }
.chart-bar > i { display: block; width: 100%; border-radius: 3px 3px 0 0; min-height: 2px; }
.chart-val { font-size: 11px; color: var(--cqa-ink-3); font-variant-numeric: tabular-nums; }
.chart-labels { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 6px; font-size: 11px; color: var(--cqa-ink-3); text-align: center; font-variant-numeric: tabular-nums; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
@container (max-width: 700px) {
  .chart-labels span:nth-child(even) { visibility: hidden; }
}
`;

let sheet = null;

export function sharedSheet() {
  if (sheet !== null) return sheet;
  if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype)) return null;
  sheet = new CSSStyleSheet();
  sheet.replaceSync(SHARED_CSS);
  return sheet;
}
