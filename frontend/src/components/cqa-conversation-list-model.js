import { dateTime } from "../format.js";

export const VIEWS = Object.freeze(["all", "gross", "appeals"]);
export const APPEAL_STATUSES = Object.freeze(["new", "under_review", "confirmed", "changed"]);
export const LANGUAGES = Object.freeze(["RU", "KZ", "EN"]);
export const CHANNELS = Object.freeze(["chat", "call"]);
export const DEFAULT_PAGE_SIZE = 25;
export const SECTION_COLUMNS = 3;

export function normalizeView(value) {
  return VIEWS.includes(value) ? value : "all";
}

export function normalizePageSize(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : DEFAULT_PAGE_SIZE;
}

export function emptyFilters() {
  return { q: "", language: "", channel: "", versionId: "", appealStatus: "" };
}

export function nextSort(current) {
  if (current === null || current === undefined) return "asc";
  if (current === "asc") return "desc";
  return null;
}

export function sortParam(sort) {
  if (sort === "asc") return "total";
  if (sort === "desc") return "-total";
  return undefined;
}

export function ariaSort(sort) {
  if (sort === "asc") return "ascending";
  if (sort === "desc") return "descending";
  return "none";
}

export function sortGlyph(sort) {
  if (sort === "asc") return "↑";
  if (sort === "desc") return "↓";
  return "↕";
}

export function usesClientAppealView(view, filters) {
  return view === "appeals" && !filters.appealStatus;
}

export function buildFilter({ view, filters, sort, offset, pageSize, operator }) {
  const filter = {};
  const q = String(filters.q || "").trim();
  if (q) filter.q = q;
  if (filters.language) filter.language = filters.language;
  if (filters.channel) filter.channel = filters.channel;
  if (filters.versionId) filter.versionId = Number(filters.versionId);
  if (filters.appealStatus) filter.appealStatus = filters.appealStatus;
  if (view === "gross") filter.gross = true;
  if (operator) filter.operator = operator;
  const sorted = sortParam(sort);
  if (sorted) filter.sort = sorted;
  if (usesClientAppealView(view, filters)) return filter;
  filter.limit = pageSize;
  if (offset) filter.offset = offset;
  return filter;
}

function nullLast(items, sort) {
  if (!sort) return items;
  const dir = sort === "desc" ? -1 : 1;
  const present = items.filter((i) => i.total !== null && i.total !== undefined);
  const missing = items.filter((i) => i.total === null || i.total === undefined);
  present.sort((a, b) => (a.total - b.total) * dir);
  return present.concat(missing);
}

export function applyClientAppealView(response, { sort, offset, pageSize }) {
  const matching = response.items.filter((i) => i.appealStatus && i.appealStatus !== "none");
  const ordered = nullLast(matching, sort);
  return {
    items: ordered.slice(offset || 0, (offset || 0) + pageSize),
    total: ordered.length,
    evaluated: ordered.filter((i) => i.evaluated && !i.failed).length
  };
}

export function pageRange(offset, count, total) {
  if (!count) return { from: 0, to: 0, total };
  return { from: offset + 1, to: offset + count, total };
}

export function hasNext(offset, count, total) {
  return offset + count < total;
}

export function sectionCells(item, columns = SECTION_COLUMNS) {
  const cells = [];
  const scored = Array.isArray(item.sections) ? item.sections.filter((s) => s.id !== "gross") : [];
  for (let i = 0; i < columns; i += 1) {
    const section = scored[i];
    cells.push(section && section.effectivePoints !== null && section.effectivePoints !== undefined ? section.effectivePoints : null);
  }
  return cells;
}

export function stamp(value, locale) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value));
  if (!m) return dateTime(value, locale);
  const text = dateTime(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))), locale);
  return locale === "en" ? text : text.replace(", ", " ");
}

export function savedVersions(checklists) {
  const withSaved = (checklists || []).filter((c) => c.versions.some((v) => v.status !== "draft"));
  const several = withSaved.length > 1;
  const out = [];
  for (const checklist of withSaved) {
    for (const v of checklist.versions) {
      if (v.status === "draft") continue;
      out.push({
        id: v.id,
        label: v.label,
        name: checklist.name,
        title: several ? `${checklist.name} · ${v.label}` : v.label,
        active: Boolean(v.isDefault),
        version: v.version,
        checklistId: checklist.id
      });
    }
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || a.checklistId - b.checklistId || b.version - a.version);
}

export function defaultBulkVersion(versions) {
  const active = versions.find((v) => v.active);
  return active ? active.id : versions.length ? versions[0].id : null;
}

export function formatCost(value, locale, numberFn) {
  const digits = Number(value) > 0 && Number(value) < 0.1 ? 3 : 2;
  const n = numberFn(value, locale, digits);
  return locale === "en" ? `$${n}` : `${n} $`;
}
