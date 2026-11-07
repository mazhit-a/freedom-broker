import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { integer, number } from "../format.js";
import { answerChip, chip, pointsChip } from "../shared/chip.js";
import { icon } from "../shared/icons.js";
import { redistributionNote } from "./call-model.js";

export const CALL_CSS = `
.call-sticky { position: sticky; top: var(--thead-h, 0px); z-index: 1; border-bottom: 1px solid var(--cqa-line); background: var(--cqa-surface); }
.m .msg.msg-gross { background: var(--cqa-critical-bg); border: 1px solid var(--cqa-critical); }
.m .msg.is-live { box-shadow: 0 0 0 2px var(--cqa-brand); }
.m .msg-head .chip { height: 18px; }
.call-play { height: 20px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--cqa-line-strong); background: var(--cqa-surface); font: 600 11px var(--cqa-font); color: var(--cqa-ink-2); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.call-play:hover { color: var(--cqa-ink); border-color: var(--cqa-ink-3); }
.call-play svg { flex: none; }
.call-alert { border-radius: var(--cqa-radius-card); background: var(--cqa-critical-bg); border: 1px solid var(--cqa-critical); padding: 16px 20px; display: flex; flex-direction: column; gap: 8px; }
.call-alert-head { display: flex; align-items: center; gap: 8px 10px; color: var(--cqa-critical); flex-wrap: wrap; }
.call-alert-head h2 { margin: 0; font-size: var(--cqa-fs-16); font-weight: 600; }
.call-alert-note { margin-left: auto; font-size: var(--cqa-fs-12); }
.call-alert p { margin: 0; font-size: var(--cqa-fs-14); color: var(--cqa-ink); overflow-wrap: anywhere; }
.call-table { padding: 8px 0 0; overflow: hidden; }
.call-table-head { padding: 10px 20px 4px; display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; }
.crow { display: grid; grid-template-columns: 28px minmax(0, 1fr) minmax(76px, auto) minmax(92px, auto); gap: 10px; align-items: center; padding: 8px 20px; min-height: 40px; border-top: 1px solid var(--cqa-line); font-size: var(--cqa-fs-13); }
.crow-head { border-top: 0; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); min-height: 32px; }
.crow-gross { background: var(--cqa-critical-bg); }
.crow .no { color: var(--cqa-ink-3); }
.crow-gross .no { color: var(--cqa-critical); }
.crow .pts { text-align: right; }
.crow .why { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); overflow-wrap: anywhere; }
.crow .name { min-width: 0; overflow-wrap: anywhere; }
.call-note { padding: 8px 20px; border-top: 1px solid var(--cqa-line); font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); display: flex; flex-direction: column; gap: 2px; }
.call-actions { padding: 12px 20px; display: flex; gap: 8px; border-top: 1px solid var(--cqa-line); flex-wrap: wrap; }
@container (max-width: 1099px) {
  .call-sticky { top: 0; }
}
@media (max-width: 520px) {
  .crow { grid-template-columns: 24px minmax(0, 1fr) auto; }
  .crow > :nth-child(3) { grid-column: 2; }
  .crow > :nth-child(4) { grid-column: 3; grid-row: 1 / span 2; }
}
`;

const PHONE = raw(
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>'
);

const PLAY_SMALL = raw('<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><polygon points="7 4 20 12 7 20 7 4"></polygon></svg>');

export function callChannelChip(locale) {
  return html`<span class="chip c-na">${PHONE}${t("call.channel", {}, locale)}</span>`;
}

export function callMetaTemplate(parts, locale) {
  const text = [...parts, t("call.asr", {}, locale)].join(" · ");
  return html`<span class="tnum strip-meta muted" data-call-meta>${text}</span>`;
}

export function playerSlot() {
  return html`<div class="call-sticky" data-player-slot></div>`;
}

export function playFromHere(message, start, locale) {
  const time = message.time;
  return html`<button type="button" class="call-play" data-action="call-play" data-msg="${message.index}" aria-label="${t("call.playFromAria", { time, n: integer(message.n, locale) }, locale)}">${PLAY_SMALL}${t("call.playFrom", {}, locale)}</button>`;
}

export function grossAlert(view, locale) {
  const g = view.gross;
  const quotes = g.evidence.map((e) => {
    const text = `${t(`msg.${e.role}`, {}, locale)} · ${e.time}`;
    return html`<button type="button" class="ev" data-action="call-gross" data-msg="${e.index}">${text}</button>`;
  });
  return html`<div class="call-alert" role="alert" data-call-alert><div class="call-alert-head">${icon("alert", 20)}<h2>${t("call.grossTitle", { id: g.id }, locale)}</h2><span class="call-alert-note">${t("call.grossNote", {}, locale)}</span></div>${g.rationale ? html`<p>${g.rationale}</p>` : html``}<div class="row gap-1">${quotes}</div></div>`;
}

function quantity(value, locale) {
  if (value === null || value === undefined) return "—";
  return Number.isInteger(Number(value)) ? integer(value, locale) : number(value, locale, 2);
}

function answerCell(row, locale) {
  if (row.needsReview) return answerChip("needs_review", locale);
  if (row.scale && typeof row.answer === "number") return pointsChip(row.answer, row.max, locale);
  return answerChip(row.answer, locale);
}

function pointsCell(row, locale) {
  if (row.na) return html`<span class="tnum pts muted" role="cell">${t("answer.na", {}, locale)}</span>`;
  const points = row.effPoints === null || row.effPoints === undefined ? "—" : number(row.effPoints, locale);
  return html`<span class="tnum pts" role="cell">${points} / ${quantity(row.effWeight, locale)}</span>`;
}

function grossRow(view, locale) {
  const g = view.gross;
  if (!g) return html``;
  let cell;
  if (g.state === "found") cell = chip({ tone: "crit", text: t("answer.yes", {}, locale) });
  else if (g.state === "none") cell = chip({ tone: "ok", text: t("answer.no", {}, locale) });
  else cell = chip({ tone: "warn", text: t("answer.needsReview", {}, locale) });
  const cls = g.state === "found" ? "crow crow-gross" : "crow";
  return html`<div class="${raw(cls)}" role="row" data-call-gross-row><span class="tnum no" role="cell">${g.id}</span><span class="name" role="cell"><span style="font-weight:500">${g.title}</span></span><span role="cell">${cell}</span><span class="pts muted fs12" role="cell">${t("call.noPoints", {}, locale)}</span></div>`;
}

export function compactTable(view, evaluation, rows, ctx) {
  const { locale, toggleLabel, appealStatus } = ctx;
  const body = rows.map((r) => {
    const why = r.reason ? html`<span class="why" title="${r.reason}">${r.reason}</span>` : html``;
    return html`<div class="crow" role="row" data-call-row="${r.id}"><span class="tnum no" role="cell">${r.id}</span><span class="name" role="cell">${r.title}${why}</span><span role="cell">${answerCell(r, locale)}</span>${pointsCell(r, locale)}</div>`;
  });
  const note = redistributionNote(evaluation, view);
  const line = note.redistributed
    ? t("call.redistributed", { factor: note.factor === null ? "—" : number(note.factor, locale, 4).replace(/0+$/, "").replace(/[.,]$/, "") }, locale)
    : t("call.allApplicable", {}, locale);
  const appeal = appealStatus
    ? html`<button type="button" class="btn btn-sm" data-action="call-appeals" data-focus-id="call-appeals">${t("call.appeal", { status: t(`status.${appealStatus}`, {}, locale) }, locale)}</button>`
    : html``;
  return html`<section class="card call-table" aria-labelledby="call-cr-h" data-call-table><div class="call-table-head"><h2 id="call-cr-h" class="blk-h">${t("card.criteria", {}, locale)}</h2></div><div role="table" aria-label="${t("call.tableLabel", {}, locale)}"><div class="crow crow-head" role="row"><span role="columnheader">${t("call.colNo", {}, locale)}</span><span role="columnheader">${t("call.colCriterion", {}, locale)}</span><span role="columnheader">${t("call.colAnswer", {}, locale)}</span><span role="columnheader" class="pts">${t("call.colPoints", {}, locale)}</span></div>${body}${grossRow(view, locale)}</div><div class="call-note"><span>${t("call.grossSeparate", {}, locale)}</span><span data-call-redistribution>${line}</span></div><div class="call-actions"><button type="button" class="btn btn-sm" data-action="call-detail" data-focus-id="call-detail">${toggleLabel}</button>${appeal}</div></section>`;
}

export function detailBar(ctx) {
  const { locale } = ctx;
  return html`<div class="card call-actions" style="border-top:0"><button type="button" class="btn btn-sm" data-action="call-detail" data-focus-id="call-detail">${t("call.detailClose", {}, locale)}</button></div>`;
}
