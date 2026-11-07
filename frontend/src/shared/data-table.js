import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { icon } from "./icons.js";

function track(col) {
  return col.width || "minmax(80px, 1fr)";
}

function minWidth(cols) {
  return cols.reduce((sum, col) => sum + (Number.parseInt(col.minPx, 10) || 100), 0);
}

export function dataTable({ label, columns, rows, rowId, rowLabel, selectable = false, selected = new Set(), sort = null }, locale) {
  const all = selectable ? [{ key: "_sel", width: "36px", minPx: 36 }, ...columns] : columns;
  const narrow = all.filter((c) => !c.secondary);
  const cols = all.map(track).join(" ");
  const colsNarrow = narrow.map(track).join(" ");
  const style = `--cols:${cols};--cols-narrow:${colsNarrow};--min:${minWidth(all)}px;--min-narrow:${minWidth(narrow)}px`;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(rowId(r)));

  const head = columns.map((col) => {
    const cls = [col.align === "num" ? "num" : "", col.secondary ? "secondary" : ""].filter(Boolean).join(" ");
    if (!col.sortable) return html`<span role="columnheader" class="${cls}">${col.label}</span>`;
    const active = sort && sort.key === col.key;
    const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
    const glyph = active ? icon(sort.dir === "asc" ? "up" : "down", 12) : html``;
    return html`<span role="columnheader" class="${cls}" aria-sort="${ariaSort}"><button type="button" class="sortbtn" data-action="sort" data-key="${col.key}" aria-label="${t("table.sortBy", { name: col.label }, locale)}">${col.label}${glyph}</button></span>`;
  });
  const selectAll = selectable
    ? html`<span role="columnheader"><input type="checkbox" data-action="select-all" aria-label="${t("table.selectAll", {}, locale)}" ${raw(allSelected ? "checked" : "")}></span>`
    : html``;

  const body = rows.map((row) => {
    const id = rowId(row);
    const isSel = selected.has(id);
    const check = selectable
      ? html`<span role="cell"><input type="checkbox" data-action="select-row" data-id="${id}" aria-label="${t("table.selectRow", { name: rowLabel ? rowLabel(row) : id }, locale)}" ${raw(isSel ? "checked" : "")}></span>`
      : html``;
    const cells = columns.map((col) => {
      const cls = [col.align === "num" ? "num" : "", col.secondary ? "secondary" : ""].filter(Boolean).join(" ");
      return html`<span role="cell" class="${cls}">${col.cell(row)}</span>`;
    });
    const rowCls = isSel ? "tbl-row tbl-body selected" : "tbl-row tbl-body";
    return html`<div role="row" class="${raw(rowCls)}" data-id="${id}" ${raw(selectable ? `aria-selected="${isSel}"` : "")}>${check}${cells}</div>`;
  });

  return html`<div class="tbl-wrap"><div role="table" class="tbl" aria-label="${label}" aria-rowcount="${rows.length + 1}" style="${style}"><div role="row" class="tbl-row tbl-head">${selectAll}${head}</div>${body}</div></div>`;
}
