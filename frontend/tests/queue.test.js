import test from "node:test";
import assert from "node:assert/strict";
import { configure, api } from "../src/api.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import { ageText, chooseSelection, decisionText, isAging, nextIndex, parseAppealId, rowLabel, tabCounts, visibleRows } from "../src/components/queue-model.js";

async function appeals() {
  configure({ mock: true });
  return api.listAppeals({ status: "all" });
}

test("tab counts on the mock are 5/2/1/2", async () => {
  const list = await appeals();
  assert.deepEqual(tabCounts(list), { all: 5, new: 2, under_review: 1, closed: 2 });
});

test("rows are filtered by tab and sorted oldest first", async () => {
  const list = await appeals();
  const rows = visibleRows(list, "all");
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i - 1].ageHours >= rows[i].ageHours);
  assert.deepEqual(visibleRows(list, "new").map((a) => a.id), [3, 2]);
  assert.deepEqual(visibleRows(list, "under_review").map((a) => a.id), [1]);
  assert.deepEqual(visibleRows(list, "closed").map((a) => a.id).sort(), [4, 5]);
});

test("only open appeals older than 72 hours are aging", async () => {
  const list = await appeals();
  assert.deepEqual(list.filter((a) => isAging(a)).map((a) => a.id), [3]);
  assert.equal(isAging({ open: false, ageHours: 500 }), false);
  assert.equal(isAging({ open: true, ageHours: 72 }), false);
  assert.equal(isAging({ open: true, ageHours: 72.5 }), true);
  assert.equal(isAging({ open: true, ageHours: 80 }, 96), false);
});

test("age text switches from hours to days at 24 hours", () => {
  assert.equal(ageText(3, "ru"), "3 ч");
  assert.equal(ageText(23.4, "ru"), "23 ч");
  assert.equal(ageText(24, "ru"), "1 д");
  assert.equal(ageText(96, "en"), "4 d");
});

test("appeal id attribute accepts 3 and a3", () => {
  assert.equal(parseAppealId("3"), 3);
  assert.equal(parseAppealId("a3"), 3);
  assert.equal(parseAppealId("A12"), 12);
  assert.equal(parseAppealId("x"), null);
  assert.equal(parseAppealId(null), null);
});

test("default selection prefers the deep link, then the first open row", async () => {
  const list = await appeals();
  const rows = visibleRows(list, "all");
  assert.equal(chooseSelection(rows, 2, null), 2);
  assert.equal(chooseSelection(rows, null, 5), 5);
  assert.ok(rows.find((a) => a.id === chooseSelection(rows, null, null)).open);
  assert.equal(chooseSelection([], null, null), null);
});

test("closed decision text shows the answer change or the confirmation", async () => {
  const list = await appeals();
  const changed = list.find((a) => a.id === 4);
  const confirmed = list.find((a) => a.id === 5);
  assert.equal(decisionText(changed, "ru"), "15 → 20");
  assert.equal(decisionText(confirmed, "ru"), "Оценка подтверждена");
  assert.equal(decisionText(confirmed, "en"), "Score confirmed");
});

test("keyboard index moves within bounds", () => {
  assert.equal(nextIndex(5, -1, 1), 0);
  assert.equal(nextIndex(5, -1, -1), 4);
  assert.equal(nextIndex(5, 4, 1), 4);
  assert.equal(nextIndex(5, 0, -1), 0);
  assert.equal(nextIndex(0, 0, 1), -1);
});

test("row label names conversation, criterion, status and age", async () => {
  const list = await appeals();
  const label = rowLabel(list.find((a) => a.id === 3), "ru");
  assert.match(label, /p1-kz-007/);
  assert.match(label, /02/);
  assert.match(label, /Новая/);
  assert.match(label, /4 д/);
});

test("every queue key exists in all three locales", () => {
  const keys = Object.keys(DICTIONARIES.ru).filter((k) => k.startsWith("queue."));
  assert.ok(keys.length > 40);
  for (const locale of LOCALES) for (const key of keys) assert.ok(key in DICTIONARIES[locale], `${locale} ${key}`);
});

test("preview for an open appeal comes from the evaluation scoring", async () => {
  configure({ mock: true });
  const list = await api.listAppeals({ status: "open" });
  const appeal = list.find((a) => a.id === 1);
  const ev = await api.getEvaluationById(appeal.evaluationId);
  const { previewTotals } = await import("../src/components/appeal-model.js");
  assert.deepEqual(previewTotals(ev, "07", "change", "yes"), { before: 81.88, after: 88.13 });
  const other = list.find((a) => a.id === 3);
  const ev3 = await api.getEvaluationById(other.evaluationId);
  assert.ok(previewTotals(ev3, "02", "change", "yes").after > previewTotals(ev3, "02", "change", "yes").before);
});
