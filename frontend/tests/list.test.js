import test from "node:test";
import assert from "node:assert/strict";
import { configure, api } from "../src/api.js";
import {
  applyClientAppealView,
  ariaSort,
  buildFilter,
  defaultBulkVersion,
  emptyFilters,
  formatCost,
  nextSort,
  normalizePageSize,
  normalizeView,
  pageRange,
  savedVersions,
  sectionCells,
  sortGlyph,
  stamp,
  usesClientAppealView
} from "../src/components/cqa-conversation-list-model.js";
import { COLUMNS, appealCell, countsText, grossCell, rowHtml, scoreCell, skeletonHtml, tableHtml } from "../src/components/cqa-conversation-list-table.js";
import { elements } from "../src/screens/list.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import { number } from "../src/format.js";

const s = (x) => String(x);

async function items() {
  configure({ mock: true });
  return (await api.listConversations({})).items;
}

test("screen registers cqa-conversation-list", () => {
  assert.deepEqual(Object.keys(elements), ["cqa-conversation-list"]);
});

test("every list key exists in all three locales", () => {
  const keys = Object.keys(DICTIONARIES.ru).filter((k) => k.startsWith("list."));
  assert.ok(keys.length > 40);
  for (const locale of LOCALES) {
    for (const key of keys) assert.ok(key in DICTIONARIES[locale], `${locale}:${key}`);
  }
});

test("sort cycles none, ascending, descending and maps to aria-sort and adapter params", () => {
  assert.equal(nextSort(null), "asc");
  assert.equal(nextSort("asc"), "desc");
  assert.equal(nextSort("desc"), null);
  assert.equal(ariaSort(null), "none");
  assert.equal(ariaSort("asc"), "ascending");
  assert.equal(ariaSort("desc"), "descending");
  assert.deepEqual([sortGlyph(null), sortGlyph("asc"), sortGlyph("desc")], ["↕", "↑", "↓"]);
  const base = { view: "all", filters: emptyFilters(), offset: 0, pageSize: 25 };
  assert.equal(buildFilter({ ...base, sort: "asc" }).sort, "total");
  assert.equal(buildFilter({ ...base, sort: "desc" }).sort, "-total");
  assert.equal("sort" in buildFilter({ ...base, sort: null }), false);
});

test("filter building combines filters, views, paging and the operator seam", () => {
  const filters = { q: "  ru-001 ", language: "RU", channel: "chat", versionId: "12", appealStatus: "new" };
  const f = buildFilter({ view: "gross", filters, sort: null, offset: 50, pageSize: 25, operator: "operator-a" });
  assert.deepEqual(f, { q: "ru-001", language: "RU", channel: "chat", versionId: 12, appealStatus: "new", gross: true, operator: "operator-a", limit: 25, offset: 50 });
  assert.deepEqual(buildFilter({ view: "all", filters: emptyFilters(), sort: null, offset: 0, pageSize: 25 }), { limit: 25 });
  assert.equal(usesClientAppealView("appeals", emptyFilters()), true);
  assert.equal(usesClientAppealView("appeals", { ...emptyFilters(), appealStatus: "new" }), false);
  assert.equal("limit" in buildFilter({ view: "appeals", filters: emptyFilters(), sort: null, offset: 0, pageSize: 25 }), false);
});

test("view and page size attributes are normalised", () => {
  assert.equal(normalizeView("gross"), "gross");
  assert.equal(normalizeView("mine"), "all");
  assert.equal(normalizePageSize("5"), 5);
  assert.equal(normalizePageSize("0"), 50);
  assert.equal(normalizePageSize(undefined), 50);
});

test("with appeals view filters, sorts nulls last and pages on the client", async () => {
  const list = await items();
  const all = { items: list, total: list.length, evaluated: 10 };
  const page = applyClientAppealView(all, { sort: "desc", offset: 0, pageSize: 3 });
  assert.equal(page.total, 5);
  assert.deepEqual(page.items.map((i) => i.id), ["p1-ru-002", "p1-ru-001", "p2-ru-call-021"]);
  const second = applyClientAppealView(all, { sort: "asc", offset: 3, pageSize: 3 });
  assert.deepEqual(second.items.map((i) => i.id), ["p1-ru-001", "p1-ru-002"]);
});

test("page range and sections", async () => {
  assert.deepEqual(pageRange(25, 25, 60), { from: 26, to: 50, total: 60 });
  assert.deepEqual(pageRange(0, 0, 0), { from: 0, to: 0, total: 0 });
  const list = await items();
  const row = list.find((i) => i.id === "p1-ru-001");
  assert.deepEqual(sectionCells(row), [31.25, 18.75, 31.88]);
  const failed = list.find((i) => i.id === "p1-ru-019");
  assert.deepEqual(sectionCells(failed), [null, null, null]);
});

test("timestamps keep the wall clock and follow the locale", () => {
  assert.equal(stamp("2026-11-07T09:42:00+05:00", "ru"), "07.11.2026 09:42");
  assert.equal(stamp("2026-11-07T09:42:00+05:00", "kk"), "07.11.2026 09:42");
  assert.equal(stamp("2026-11-07T09:42:00+05:00", "en"), "11/07/2026, 09:42");
  assert.equal(stamp(null, "ru"), "");
});

test("bulk versions list saved versions only, active first", async () => {
  configure({ mock: true });
  const versions = savedVersions(await api.listChecklists());
  assert.deepEqual(versions.map((v) => v.label), ["v2", "v1"]);
  assert.equal(versions[0].active, true);
  assert.equal(defaultBulkVersion(versions), versions[0].id);
  assert.equal(defaultBulkVersion([]), null);
});

test("cost formatting follows the locale", () => {
  assert.equal(formatCost(0.012, "en", number), "$0.012");
  assert.equal(formatCost(0.012, "ru", number).replace(/\s/g, " "), "0,012 $");
  assert.equal(formatCost(1.5, "ru", number).replace(/\s/g, " "), "1,50 $");
});

test("table has the 13 design columns and role=table semantics", async () => {
  const list = await items();
  assert.equal(COLUMNS.length, 13);
  const out = s(tableHtml(list, { locale: "ru", selected: new Set(), selectable: true, activeId: null, sort: null, busy: false }));
  assert.match(out, /role="table"/);
  assert.equal((out.match(/role="columnheader"/g) || []).length, 13);
  assert.equal((out.match(/data-row="/g) || []).length, 11);
  assert.match(out, /aria-label="Оценённые диалоги"/);
  assert.match(out, /aria-sort="none"/);
  assert.match(out, /aria-label="Выбрать p1-ru-001"/);
  assert.match(out, /aria-label="Выбрать все"/);
});

test("rows: one roving tab stop, selection state, labelled checkboxes", async () => {
  const list = await items();
  const out = s(tableHtml(list, { locale: "ru", selected: new Set([2]), selectable: true, activeId: 3, sort: "asc", busy: true }));
  assert.equal((out.match(/tabindex="0"/g) || []).length, 1);
  assert.match(out, /data-row="3"[^>]*tabindex="0"/);
  assert.equal((out.match(/class="tbl-row tbl-body selected/g) || []).length, 1);
  assert.match(out, /aria-sort="ascending"/);
  assert.match(out, /aria-busy="true"/);
  const unknown = s(tableHtml(list, { locale: "ru", selected: new Set(), selectable: true, activeId: 999, sort: null, busy: false }));
  assert.match(unknown, /data-row="1"[^>]*tabindex="0"/);
});

test("score cells: score with chip, dash with failure link, dash when not calculated", async () => {
  const list = await items();
  const find = (id) => list.find((i) => i.id === id);
  const normal = s(scoreCell(find("p1-ru-001"), "ru"));
  assert.match(normal, /81,88/);
  assert.match(normal, /band-ok/);
  assert.doesNotMatch(normal, /Низкая уверенность/);
  const low = s(scoreCell(find("p2-en-003"), "ru"));
  assert.match(low, /92,50/);
  assert.match(low, /Низкая уверенность/);
  const failed = s(scoreCell(find("p1-ru-019"), "ru"));
  assert.match(failed, /Ошибка оценки · повторить/);
  assert.match(failed, /href="#\/runs"/);
  assert.doesNotMatch(failed, /score-num/);
  const notCalc = s(scoreCell({ ...find("p1-ru-001"), total: null }, "ru"));
  assert.match(notCalc, /Итог не рассчитан/);
  const changed = s(scoreCell({ ...find("p1-ru-002"), totalChanged: true, originalTotal: 70 }, "ru"));
  assert.match(changed, /было 70,00 - изменено по апелляции/);
});

test("gross and appeal cells", async () => {
  const list = await items();
  const find = (id) => list.find((i) => i.id === id);
  assert.match(s(grossCell(find("p3-ru-call-014"), "ru")), /c-crit/);
  assert.match(s(grossCell(find("p3-ru-call-014"), "ru")), /Да/);
  assert.match(s(grossCell(find("p1-ru-001"), "ru")), />Нет</);
  assert.match(s(appealCell(find("p3-ru-call-014"), "ru")), /c-brand[^>]*>Новая/);
  assert.match(s(appealCell(find("p1-ru-001"), "ru")), /c-warn[^>]*>На рассмотрении/);
  assert.match(s(appealCell(find("p2-ru-call-021"), "ru")), /c-na[^>]*>Подтверждено/);
  assert.match(s(appealCell(find("p1-ru-002"), "ru")), /c-ok[^>]*>Изменено/);
  assert.match(s(appealCell(find("p1-ru-015"), "ru")), />—</);
});

test("row cells follow the locale and escape ids", async () => {
  const list = await items();
  const row = list.find((i) => i.id === "p1-ru-001");
  const en = s(rowHtml(row, { locale: "en", selected: new Set(), active: false, selectable: true, tabbable: false }));
  assert.match(en, /81\.88/);
  assert.match(en, /31\.25/);
  assert.match(en, />Chat</);
  assert.match(en, /Under review/);
  const evil = { ...row, id: '<img src=x onerror="alert(1)">' };
  const out = s(rowHtml(evil, { locale: "ru", selected: new Set(), active: false, selectable: true, tabbable: false }));
  assert.ok(!/<img/i.test(out));
  assert.ok(out.includes("&lt;img"));
});

test("counts header uses locale separators", () => {
  assert.equal(countsText(1248, 11, "ru").replace(/\s/g, " "), "1 248 оценено · 11 показано");
  assert.equal(countsText(1248, 11, "en"), "1,248 evaluated · 11 shown");
});

test("loading skeleton is a busy status region", () => {
  const out = s(skeletonHtml("ru"));
  assert.match(out, /role="status"/);
  assert.match(out, /aria-busy="true"/);
  assert.match(out, /aria-label="Загрузка"/);
});

test("mock list rows carry the evaluation time", async () => {
  const list = await items();
  assert.ok(list.every((i) => typeof i.evaluatedAt === "string" && i.evaluatedAt.startsWith("2026-")));
});
