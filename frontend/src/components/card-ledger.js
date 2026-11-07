import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { integer, number } from "../format.js";
import { answerChip, pointsChip } from "../shared/chip.js";

export const LEDGER_CSS = `
.ledger { display: flex; flex-direction: column; overflow: hidden; }
.ledger-toggle { display: flex; align-items: center; gap: 10px; padding: 16px 20px; background: none; border: 0; font: inherit; color: inherit; cursor: pointer; text-align: left; width: 100%; }
.ledger-toggle .sub { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
.ledger-toggle .state { margin-left: auto; font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); }
.ledger-table { border-top: 1px solid var(--cqa-line); }
.lrow { display: grid; grid-template-columns: minmax(0, 1fr) 96px 84px 84px 84px; gap: 8px; align-items: center; padding: 0 16px; min-height: 36px; border-bottom: 1px solid var(--cqa-line); font-size: var(--cqa-fs-13); }
.lrow > span:nth-child(n+3) { text-align: right; font-variant-numeric: tabular-nums; }
.lrow > span { min-width: 0; overflow-wrap: anywhere; }
.lrow-head { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); background: var(--cqa-surface-2); }
.lrow-sec { font-size: var(--cqa-fs-12); font-weight: 600; color: var(--cqa-ink-2); text-transform: uppercase; letter-spacing: .04em; min-height: 32px; }
.lrow-crit > span:first-child { padding: 6px 0 6px 12px; }
.lrow-na { color: var(--cqa-ink-3); background: repeating-linear-gradient(135deg, transparent 0 6px, var(--cqa-surface-2) 6px 7px); }
.lrow-na .nom { text-decoration: line-through; }
.lrow-sub { font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); background: var(--cqa-surface-2); }
.lrow-sub > span:first-child { padding-left: 12px; }
.lrow-sub .pts { font-weight: 600; color: var(--cqa-ink); }
.lrow-total { min-height: 52px; border-bottom: 0; border-top: 2px solid var(--cqa-ink); }
.lrow-total .lbl { font-weight: 600; font-size: var(--cqa-fs-14); }
.lrow-total .dim { color: var(--cqa-ink-3); }
.lrow-total .sum { font-weight: 700; font-size: var(--cqa-fs-18, 18px); }
.lnote { display: block; font-size: 11px; color: var(--cqa-ink-3); }
.lnote-warn { color: var(--cqa-warn); }
.lfoot { padding: 12px 20px 16px; font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); border-top: 1px solid var(--cqa-line); display: flex; flex-direction: column; gap: 4px; }
@container (max-width: 640px) {
  .lrow { grid-template-columns: minmax(0, 1fr) 72px 56px 56px 60px; gap: 4px; padding: 0 10px; }
}
`;

const cents = (value) => Math.round(value * 100) / 100;

function pointsFor(c) {
  if (c.na || c.needsReview) return null;
  if (c.effPoints !== null && c.effPoints !== undefined) return c.effPoints;
  if (c.effWeight === null || c.effWeight === undefined) return null;
  if (c.scale) {
    if (typeof c.answer !== "number" || !c.max) return null;
    return cents((c.effWeight * c.answer) / c.max);
  }
  return c.answer === "yes" ? c.effWeight : c.answer === "no" ? 0 : null;
}

function sumOf(values) {
  const present = values.filter((v) => v !== null && v !== undefined);
  return present.length ? cents(present.reduce((s, v) => s + v, 0)) : null;
}

export function buildLedger(view, evaluation) {
  const sections = view.sections.map((section) => {
    const rows = section.criteria.map((c) => {
      const excluded = c.na || c.needsReview || c.effWeight === null || c.effWeight === undefined;
      return {
        id: c.id,
        title: c.title,
        answer: c.answer,
        scale: c.scale,
        max: c.max,
        na: c.na,
        needsReview: c.needsReview,
        nominal: c.weight,
        effective: excluded ? null : c.effWeight,
        points: excluded ? null : pointsFor(c)
      };
    });
    return {
      id: section.id,
      title: section.title,
      rows,
      nominal: cents(rows.reduce((s, r) => s + (r.nominal || 0), 0)),
      effective: sumOf(rows.map((r) => r.effective)),
      points: sumOf(rows.map((r) => r.points))
    };
  });
  const allRows = sections.flatMap((s) => s.rows);
  const calculated = Boolean(evaluation.calculated) && evaluation.total !== null && evaluation.total !== undefined;
  const nominal = cents(allRows.reduce((s, r) => s + (r.nominal || 0), 0));
  const applicable = evaluation.applicableWeight ?? sumOf(allRows.filter((r) => r.effective !== null).map((r) => r.nominal)) ?? 0;
  const pointsSum = sumOf(allRows.map((r) => r.points));
  const total = calculated ? evaluation.total : null;
  return {
    sections,
    nominal,
    applicable,
    factor: calculated && applicable > 0 ? evaluation.factor ?? nominal / applicable : null,
    effective: sumOf(allRows.map((r) => r.effective)),
    pointsSum,
    total,
    calculated,
    provisional: Boolean(evaluation.provisional),
    reconciled: !calculated || (pointsSum !== null && Math.abs(pointsSum - total) <= 0.05)
  };
}

function cell(value, locale) {
  return value === null || value === undefined ? "—" : number(value, locale);
}

function answerCell(r, locale) {
  if (r.needsReview) return answerChip("needs_review", locale);
  if (r.scale && typeof r.answer === "number") return pointsChip(r.answer, r.max, locale);
  return answerChip(r.answer, locale);
}

function critRow(r, locale) {
  const cls = r.na ? "lrow lrow-crit lrow-na" : "lrow lrow-crit";
  let note = html``;
  if (r.na) note = html`<span class="lnote">${t("ledger.naNote", {}, locale)}</span>`;
  else if (r.needsReview) note = html`<span class="lnote lnote-warn">${t("ledger.reviewNote", {}, locale)}</span>`;
  return html`<div role="row" class="${raw(cls)}" data-ledger-row="${r.id}"><span role="cell"><span class="tnum muted">${r.id}</span> ${r.title}${note}</span><span role="cell">${answerCell(r, locale)}</span><span role="cell" class="nom">${integer(r.nominal, locale)}</span><span role="cell">${cell(r.effective, locale)}</span><span role="cell" style="font-weight:500">${cell(r.points, locale)}</span></div>`;
}

function sectionRows(s, locale) {
  const head = html`<div role="row" class="lrow lrow-sec"><span role="cell">${s.title}</span><span role="cell"></span><span role="cell"></span><span role="cell"></span><span role="cell"></span></div>`;
  const rows = s.rows.map((r) => critRow(r, locale));
  const sub = html`<div role="row" class="lrow lrow-sub" data-ledger-subtotal="${s.id}"><span role="cell">${t("ledger.subtotal", {}, locale)}</span><span role="cell"></span><span role="cell">${integer(s.nominal, locale)}</span><span role="cell">${cell(s.effective, locale)}</span><span role="cell" class="pts">${cell(s.points, locale)}</span></div>`;
  return html`${head}${rows}${sub}`;
}

function footer(model, locale) {
  const total = integer(model.nominal, locale);
  let line;
  if (!model.calculated || !(model.applicable > 0)) line = t("ledger.footerNone", { total }, locale);
  else if (Math.abs(model.applicable - model.nominal) < 0.005) line = t("ledger.footerFull", { applicable: integer(model.applicable, locale), total }, locale);
  else line = t("ledger.footer", { applicable: number(model.applicable, locale).replace(/[,.]00$/, ""), total, factor: number(model.factor, locale) }, locale);
  const prov = model.provisional ? html`<span data-ledger-provisional>${t("ledger.provisionalNote", {}, locale)}</span>` : html``;
  return html`<div class="lfoot"><span class="tnum" data-ledger-footer>${line}</span>${prov}<span>${t("ledger.formula", {}, locale)}</span></div>`;
}

export function ledgerView(model, ctx) {
  const { locale, open } = ctx;
  const toggle = html`<button type="button" class="ledger-toggle" data-action="toggle-ledger" data-focus-id="ledger-toggle" aria-expanded="${open ? "true" : "false"}" aria-controls="ledger-body"><h2 id="lg-h" class="blk-h">${t("ledger.title", {}, locale)}</h2><span class="sub">${t("ledger.sub", {}, locale)}</span><span class="state" aria-hidden="true">${t(open ? "ledger.collapse" : "ledger.expand", {}, locale)}</span></button>`;
  if (!open) return html`<section class="card ledger" aria-labelledby="lg-h" data-ledger>${toggle}</section>`;
  const totalText = model.calculated ? number(model.total, locale) : t("state.notCalculated", {}, locale);
  const head = html`<div role="row" class="lrow lrow-head"><span role="columnheader">${t("ledger.colCriterion", {}, locale)}</span><span role="columnheader">${t("ledger.colAnswer", {}, locale)}</span><span role="columnheader">${t("ledger.colNominal", {}, locale)}</span><span role="columnheader">${t("ledger.colEffective", {}, locale)}</span><span role="columnheader">${t("ledger.colPoints", {}, locale)}</span></div>`;
  const body = model.sections.map((s) => sectionRows(s, locale));
  const effTotal = model.calculated ? cell(model.effective, locale) : "—";
  const totalRow = html`<div role="row" class="lrow lrow-total" data-ledger-total-row><span role="cell" class="lbl">${t("ledger.total", {}, locale)}</span><span role="cell"></span><span role="cell" class="dim">${integer(model.nominal, locale)}</span><span role="cell" class="dim">${effTotal}</span><span role="cell" class="sum" data-ledger-total>${totalText}</span></div>`;
  return html`<section class="card ledger" aria-labelledby="lg-h" data-ledger data-reconciled="${model.reconciled ? "true" : "false"}">${toggle}<div id="ledger-body"><div role="table" class="ledger-table" aria-label="${t("ledger.tableLabel", {}, locale)}">${head}${body}${totalRow}</div>${footer(model, locale)}</div></section>`;
}
