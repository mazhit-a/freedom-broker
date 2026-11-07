import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { integer, number } from "../format.js";
import { chip, langChip, statusChip } from "../shared/chip.js";
import { scoreBadge } from "../shared/score-badge.js";
import { icon } from "../shared/icons.js";
import { ariaSort, sectionCells, sortGlyph, stamp } from "./cqa-conversation-list-model.js";

export const COLUMNS = Object.freeze([
  { key: "_sel", width: "36px", px: 36 },
  { key: "id", width: "140px", px: 140 },
  { key: "channel", width: "100px", px: 100 },
  { key: "language", width: "56px", px: 56 },
  { key: "operator", width: "120px", px: 120 },
  { key: "total", width: "300px", px: 300 },
  { key: "s1", width: "76px", px: 76 },
  { key: "s2", width: "76px", px: 76 },
  { key: "s3", width: "76px", px: 76 },
  { key: "gross", width: "84px", px: 84 },
  { key: "appeal", width: "150px", px: 150 },
  { key: "version", width: "64px", px: 64 },
  { key: "evaluated", width: "150px", px: 150 }
]);

export const LIST_CSS = `
  .lt-wrap { overflow-x: auto; border: 1px solid var(--cqa-line); border-radius: var(--cqa-radius-card); background: var(--cqa-surface); }
  .lt-wrap .tbl-wrap { border: 0; border-radius: 0; overflow: visible; }
  .lt-wrap .tbl { min-width: var(--min); }
  .lt-wrap .tbl-row { min-width: var(--min); grid-template-columns: var(--cols); }
  .lt-wrap .tbl-body:focus-visible { outline: 2px solid var(--cqa-focus); outline-offset: -2px; }
  .lt-wrap .tbl-body.active:not(:focus-visible) { box-shadow: inset 3px 0 0 var(--cqa-brand); }
  .lt-chan { display: inline-flex; align-items: center; gap: 6px; color: var(--cqa-ink-2); font-size: var(--cqa-fs-12); }
  .lt-score { display: inline-flex; align-items: center; gap: 8px; }
  .lt-dash { color: var(--cqa-ink-3); }
  .lt-id { font-weight: 500; font-variant-numeric: tabular-nums; }
  .lt-small { font-size: var(--cqa-fs-12); font-variant-numeric: tabular-nums; }
  .lt-skel-row { display: grid; grid-template-columns: 36px 140px 100px 56px 120px 1fr; gap: 12px; align-items: center; height: 40px; padding: 0 10px; border-bottom: 1px solid var(--cqa-line); }
  .lt-skel-row .skel { height: 12px; }
`;

const PHONE = '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path>';
const CHAT = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>';

export function searchIcon() {
  return raw('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>');
}

function channelIcon(kind) {
  return raw(`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${kind === "call" ? PHONE : CHAT}</svg>`);
}

function styleVars() {
  const cols = COLUMNS.map((c) => c.width).join(" ");
  const min = COLUMNS.reduce((sum, c) => sum + c.px, 0);
  return `--cols:${cols};--min:${min}px`;
}

function dash() {
  return html`<span class="lt-dash" aria-hidden="true">—</span>`;
}

export function scoreCell(item, locale) {
  if (item.failed) {
    return html`<span class="lt-score"><span class="score-dash" aria-hidden="true">—</span><a class="chip c-bad" href="#/runs" data-action="open-runs">${t("list.failed", {}, locale)}</a></span>`;
  }
  if (!item.evaluated) return dash();
  if (item.total === null || item.total === undefined) {
    return html`<span class="score"><span class="score-dash" aria-label="${t("state.notCalculated", {}, locale)}" title="${t("state.notCalculated", {}, locale)}">—</span></span>`;
  }
  const title = item.totalChanged && item.originalTotal !== null ? t("list.wasTotal", { value: number(item.originalTotal, locale) }, locale) : "";
  const low = item.lowConfidence ? chip({ tone: "na", text: t("status.low_confidence", {}, locale) }) : html``;
  return html`<span class="lt-score" title="${title}">${scoreBadge(item.total, locale)}${low}</span>`;
}

export function grossCell(item, locale) {
  if (item.gross === true) {
    return html`<span class="chip c-crit">${icon("alert", 12)}${t("list.gross.yes", {}, locale)}</span>`;
  }
  if (item.gross === false) return html`<span class="lt-dash">${t("list.gross.no", {}, locale)}</span>`;
  return dash();
}

export function appealCell(item, locale) {
  const out = statusChip(item.appealStatus, locale);
  return String(out) ? out : dash();
}

export function sectionValue(value, locale) {
  return value === null || value === undefined ? "—" : number(value, locale, 2);
}

export function rowHtml(item, ctx) {
  const { locale, selected, active, selectable, tabbable } = ctx;
  const isSel = selected.has(item.pk);
  const cls = ["tbl-row", "tbl-body", isSel ? "selected" : "", active ? "active" : ""].filter(Boolean).join(" ");
  const kind = item.channel === "call" ? "call" : "chat";
  const sections = sectionCells(item);
  const label = t("table.selectRow", { name: item.id }, locale);
  const check = selectable
    ? html`<input type="checkbox" data-action="select-row" data-id="${item.pk}" data-focus-id="sel-${item.pk}" aria-label="${label}" ${raw(isSel ? "checked" : "")}>`
    : html``;
  return html`<div role="row" class="${raw(cls)}" data-row="${item.pk}" data-focus-id="row-${item.pk}" tabindex="${tabbable ? "0" : "-1"}" aria-label="${item.id}"><span role="cell">${check}</span><span role="cell"><a class="lt-id" href="#/conversations/${encodeURIComponent(item.id)}" data-action="open" data-conversation="${item.id}">${item.id}</a></span><span role="cell"><span class="lt-chan">${channelIcon(kind)}<span>${t(`list.channel.${kind}`, {}, locale)}</span></span></span><span role="cell">${langChip(item.language)}</span><span role="cell">${item.operator}</span><span role="cell">${scoreCell(item, locale)}</span><span role="cell" class="num">${sectionValue(sections[0], locale)}</span><span role="cell" class="num">${sectionValue(sections[1], locale)}</span><span role="cell" class="num">${sectionValue(sections[2], locale)}</span><span role="cell">${grossCell(item, locale)}</span><span role="cell">${appealCell(item, locale)}</span><span role="cell"><span class="lt-small muted">${item.versionLabel || "—"}</span></span><span role="cell"><span class="lt-small muted">${stamp(item.evaluatedAt, locale) || "—"}</span></span></div>`;
}

export function headHtml(ctx) {
  const { locale, sort, allSelected, selectable, sectionTitles = [] } = ctx;
  const header = (key, label, extra = "") => html`<span role="columnheader" class="${raw(extra)}">${label}</span>`;
  const sections = [1, 2, 3].map((n) => {
    const title = sectionTitles[n - 1] || t("list.col.sectionTitle", { n }, locale);
    return html`<span role="columnheader" class="num" title="${title}">${t("list.col.section", { n }, locale)}</span>`;
  });
  const selectAll = selectable
    ? html`<input type="checkbox" data-action="select-all" data-focus-id="sel-all" aria-label="${t("table.selectAll", {}, locale)}" ${raw(allSelected ? "checked" : "")}>`
    : html``;
  const totalName = t("list.col.total", {}, locale);
  return html`<div role="row" class="tbl-row tbl-head"><span role="columnheader">${selectAll}</span>${header("id", t("list.col.id", {}, locale))}${header("channel", t("list.col.channel", {}, locale))}${header("language", t("list.col.language", {}, locale))}${header("operator", t("list.col.operator", {}, locale))}<span role="columnheader" aria-sort="${ariaSort(sort)}"><button type="button" class="sortbtn" data-action="sort" data-focus-id="sort-total" aria-label="${t("table.sortBy", { name: totalName }, locale)}">${totalName} <span aria-hidden="true">${sortGlyph(sort)}</span></button></span>${sections}${header("gross", t("list.col.gross", {}, locale))}${header("appeal", t("list.col.appeal", {}, locale))}${header("version", t("list.col.version", {}, locale))}${header("evaluated", t("list.col.evaluated", {}, locale))}</div>`;
}

export function tableHtml(items, ctx) {
  const { locale, selected, selectable, activeId, busy } = ctx;
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.pk));
  const fallbackActive = items.length ? items[0].pk : null;
  const current = items.some((i) => i.pk === activeId) ? activeId : fallbackActive;
  const rows = items.map((item) =>
    rowHtml(item, { locale, selected, selectable, active: item.pk === current, tabbable: item.pk === current })
  );
  const count = items.length + 1;
  return html`<div class="lt-wrap"><div class="tbl-wrap"><div role="table" class="tbl" aria-label="${t("list.table.label", {}, locale)}" aria-rowcount="${count}" aria-busy="${busy ? "true" : "false"}" data-table style="${styleVars()}">${headHtml({ ...ctx, allSelected })}${rows}</div></div></div>`;
}

export function skeletonHtml(locale, rows = 6) {
  const name = t("state.loading", {}, locale);
  const lines = Array.from({ length: rows }, () => html`<div class="lt-skel-row"><span class="skel"></span><span class="skel"></span><span class="skel"></span><span class="skel"></span><span class="skel"></span><span class="skel"></span></div>`);
  return html`<div class="lt-wrap" role="status" aria-busy="true" aria-label="${name}" data-skeleton>${lines}</div>`;
}

export function countsText(evaluated, shown, locale) {
  return t("list.counts", { evaluated: integer(evaluated, locale), shown: integer(shown, locale) }, locale);
}
