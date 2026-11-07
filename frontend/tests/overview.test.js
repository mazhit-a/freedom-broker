import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configure, api } from "../src/api.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import overviewStrings from "../src/i18n/screens/overview.js";
import {
  attentionCard,
  buildFilter,
  criteriaCard,
  defaultDataset,
  defaultVersionId,
  distributionCard,
  grossHighlighted,
  histogramSummary,
  kpiSection,
  mainRange,
  periodRange,
  selectableVersions,
  splitCard,
  visibleCriteria
} from "../src/components/overview-view.js";

const plain = (value) => String(value).replace(/<[^>]*>/g, "|").replace(/[  ]/g, " ").replace(/\|+/g, "|").replace(/\s+/g, " ");

async function overview(filter = {}, state = null) {
  configure({ mock: true, state });
  return api.getOverview(filter);
}

test("every overview key exists in ru, kk and en and has an other form when plural", () => {
  const keys = Object.keys(overviewStrings.ru);
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(overviewStrings[locale]).sort(), [...keys].sort(), locale);
    for (const key of keys) {
      assert.ok(key.startsWith("overview."), key);
      assert.ok(DICTIONARIES[locale][key] !== undefined, `${locale}:${key}`);
      const value = overviewStrings[locale][key];
      if (typeof value === "object") assert.ok(value.other, `${locale}:${key}`);
    }
  }
});

test("source files contain no comments", () => {
  for (const file of ["../src/components/cqa-overview.js", "../src/components/overview-view.js", "../src/screens/overview.js", "../src/i18n/screens/overview.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    const stripped = text.replace(/`(?:\\.|[^`\\])*`/g, "``").replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
    assert.ok(!/\/\/|\/\*/.test(stripped), file);
  }
});

test("period range: last 7 days is inclusive and anchored to the end of the full period", () => {
  assert.deepEqual(periodRange("full", { to: "2026-11-07" }), { from: undefined, to: undefined });
  assert.deepEqual(periodRange("last7", { to: "2026-11-07" }), { from: "2026-11-01", to: "2026-11-07" });
});

test("filter object carries every control and omits empty ones", () => {
  const f = buildFilter({ dataset: "control", versionId: 12, period: "full", language: "KZ", channel: "" }, null);
  assert.deepEqual(f, { dataset: "control", versionId: 12, from: undefined, to: undefined, language: "KZ", channel: undefined });
});

test("defaults: control dataset, active chat version, drafts are not selectable", async () => {
  configure({ mock: true });
  const datasets = await api.listDatasets();
  const checklists = await api.listChecklists();
  assert.equal(defaultDataset(datasets), "control");
  assert.equal(defaultVersionId(checklists), 12);
  const versions = selectableVersions(checklists);
  assert.deepEqual(versions.map((v) => v.id), [11, 12]);
  assert.equal(versions.find((v) => v.id === 12).isDefault, true);
});

test("histogram: bands, main range and generated label", async () => {
  const data = await overview();
  assert.deepEqual(mainRange(data.distribution), { from: 70, to: 100 });
  assert.equal(histogramSummary(data.distribution, "ru"), "Гистограмма: большинство диалогов в диапазоне 70–100 баллов, 80–90 — 392 диалога");
  assert.match(histogramSummary(data.distribution, "en"), /80–90 — 392 conversations/);
  const html = String(distributionCard(data.distribution, "ru"));
  assert.match(html, /role="img"/);
  assert.equal((html.match(/band-bad"/g) || []).length, 5 + 1);
  assert.equal((html.match(/<tr><th scope="row">/g) || []).length, 10);
  assert.match(plain(html), /80–90\|392/);
  assert.equal(histogramSummary(data.distribution.map((b) => ({ ...b, count: 0 })), "ru"), "Гистограмма: нет оценённых диалогов");
});

test("KPI tiles format per locale", async () => {
  const data = await overview();
  const ru = plain(kpiSection(data.kpis, "ru"));
  for (const text of ["78,42", "из 100", "▲", "1,84 к прошлому периоду", "1 248", "1 034 чата · 214 звонков", "3,4 %", "42 диалога · не входит в балл", "17", "5 старше 3 дней", "1,6", "дня", "медиана · цель ≤ 2 дней"]) {
    assert.ok(ru.includes(text), text);
  }
  const en = plain(kpiSection(data.kpis, "en"));
  for (const text of ["78.42", "1,248", "3.4%", "1.6", "days", "5 older than 3 days", "vs previous period"]) assert.ok(en.includes(text), text);
  assert.match(String(kpiSection(data.kpis, "ru")), /kpi-note tnum up/);
  assert.match(String(kpiSection({ ...data.kpis, deltaVsPrev: -2 }, "ru")), /kpi-note tnum down/);
  assert.match(String(kpiSection(data.kpis, "ru")), /kpi-value tnum hot/);
});

test("criteria: weakest first, 08 excluded, bands from the score thresholds", async () => {
  const data = await overview();
  const list = visibleCriteria([...data.perCriterion, { id: "08", title: "Грубые", avgPercent: 10, applicableCount: 5, labels: null }]);
  assert.deepEqual(list.map((c) => c.avgPercent), [61, 68, 72, 79, 84, 88, 95]);
  const html = String(criteriaCard(data.perCriterion, "ru"));
  assert.match(plain(html), /07\| Завершение/);
  assert.equal((html.match(/band-warn/g) || []).length, 2);
  assert.equal((html.match(/band-ok/g) || []).length, 5);
  assert.match(html, /N\/A/);
});

test("gross highlight rule: only slices well above the overall share", async () => {
  const data = await overview();
  assert.equal(grossHighlighted(6.1, 3.4), true);
  assert.equal(grossHighlighted(4.5, 3.4), false);
  assert.equal(grossHighlighted(null, 3.4), false);
  const html = String(splitCard(data, "ru"));
  assert.equal((html.match(/gross-hot/g) || []).length, 1);
  assert.match(plain(html), /Звонок\|214\|73,88\|6,1 %/);
});

test("attention rows: reason chips, provisional score with chip, dash only without a score", async () => {
  const data = await overview();
  const html = String(attentionCard(data, "ru"));
  assert.match(html, /c-crit" title="">Грубая ошибка/);
  assert.match(html, /Апелляция · Новая/);
  assert.match(html, /Апелляция · На рассмотрении/);
  const provisional = plain(html).match(/Низкая уверенность модели[^]*?92,50[^]*?Предварительно - низкая уверенность/);
  assert.ok(provisional, "provisional total is shown with the chip");
  const failed = String(attentionCard({ ...data, attention: [{ ...data.attention[0], score: null, provisional: false }] }, "ru"));
  assert.match(failed, /aria-label="Оценка не выполнена">—/);
  assert.match(html, /href="#\/conversations\/p3-ru-call-014"/);
  assert.match(html, /aria-label="Открыть p3-ru-call-014"/);
});

test("attention content is escaped", async () => {
  const data = await overview();
  const row = { ...data.attention[0], id: '"><img src=x onerror=alert(1)>' };
  const html = String(attentionCard({ ...data, attention: [row] }, "ru"));
  assert.ok(!html.includes("<img"));
});

test("mock overview narrows by language, channel and period, and keeps shape", async () => {
  const all = await overview();
  const kz = await overview({ language: "KZ" });
  assert.equal(kz.kpis.evaluatedCount, 286);
  assert.equal(kz.kpis.avgScore, 75.84);
  assert.equal(kz.byLanguage.length, 1);
  const calls = await overview({ channel: "call" });
  assert.equal(calls.kpis.calls, 214);
  assert.equal(calls.kpis.chats, 0);
  const week = await overview({ from: "2026-11-01", to: "2026-11-07" });
  assert.ok(week.kpis.evaluatedCount < all.kpis.evaluatedCount && week.kpis.evaluatedCount > 0);
  assert.deepEqual(Object.keys(kz).sort(), Object.keys(all).sort());
  const empty = await overview({}, "empty");
  assert.equal(empty.kpis.evaluatedCount, 0);
  await assert.rejects(() => overview({}, "error"));
});
