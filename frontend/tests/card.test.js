import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configure, api } from "../src/api.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import {
  buildCard,
  confidenceLevel,
  enterTarget,
  expectedIndices,
  localized,
  messageTime,
  moveSelection,
  paintState,
  wallClock
} from "../src/components/card-model.js";
import { criteriaSection, scoreSection, transcriptSection } from "../src/components/card-view.js";

const norm = (value) => String(value).replace(/[  ]/g, " ");

async function load(id = "p1-ru-001", options = {}) {
  configure({ mock: true, ...options });
  const conversation = await api.getConversation(id);
  const evaluation = await api.getEvaluation(id);
  return { conversation, evaluation };
}

test("card model: p1-ru-001 messages, criteria order and section tiles", async () => {
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  assert.equal(view.messages.length, 15);
  assert.deepEqual(view.order, ["01", "02", "03", "04", "05", "06", "07"]);
  assert.equal(view.sections.length, 3);
  assert.equal(view.gross.state, "none");
  assert.equal(view.byId["08"], undefined);
  assert.equal(evaluation.total, 81.88);
  assert.equal(evaluation.versionLabel, "v2");
});

test("card model: evidence maps to citing criteria on messages (two-way link)", async () => {
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  assert.deepEqual(view.messages[10].cites, ["04", "05", "06"]);
  assert.deepEqual(view.messages[5].cites, ["01"]);
  assert.deepEqual(view.messages[0].cites, []);
  const active = paintState(view, null, "04", null);
  assert.deepEqual([...active.evidence].sort((a, b) => a - b), [10, 11]);
  assert.equal(active.expectedFirst, null);
  const msg = paintState(view, null, "04", 10);
  assert.deepEqual([...msg.citedBy], ["04", "05", "06"]);
});

test("card model: hover wins over selection", async () => {
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  const state = paintState(view, "02", "04", null);
  assert.equal(state.activeId, "02");
  assert.deepEqual([...state.evidence].sort((a, b) => a - b), [6, 7]);
});

test("card model: expected range only for a No answer, with first message and label", async () => {
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  const c07 = view.byId["07"];
  assert.deepEqual(c07.expectedIdx, [12, 13]);
  assert.equal(c07.expected.time, "04:51");
  assert.equal(c07.expected.endTime, "04:58");
  const state = paintState(view, null, "07", null);
  assert.deepEqual([...state.expected], [12, 13]);
  assert.equal(state.expectedFirst, 12);
  assert.equal(state.expectedLabel, "07 Завершение");
  assert.deepEqual(expectedIndices({ answer: "yes", expected: { from: 1, to: 2 } }), []);
  assert.deepEqual(expectedIndices({ answer: "no", expected: null }), []);
  assert.deepEqual(expectedIndices({ answer: "no", expected: { from: 2, to: 4 } }), [2, 3, 4]);
});

test("card model: N/A criterion keeps the condition text and has no points", async () => {
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  const c03 = view.byId["03"];
  assert.equal(c03.na, true);
  assert.equal(c03.effPoints, null);
  assert.match(c03.naCondition, /Запрос не требовал идентификации/);
});

test("card model: scale criterion exposes steps, chosen step and descriptor", async () => {
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  const c04 = view.byId["04"];
  assert.equal(c04.scale, true);
  assert.equal(c04.max, 20);
  assert.deepEqual(c04.steps.map((s) => s.value), [0, 5, 10, 15, 20]);
  assert.deepEqual(c04.steps.filter((s) => s.chosen).map((s) => s.value), [15]);
  assert.equal(c04.stepLabel, "Корректно, но неполно");
});

test("card model: keyboard movement is clamped and Enter prefers evidence over the expected range", async () => {
  const order = ["01", "02", "03"];
  assert.equal(moveSelection(order, "01", "j"), "02");
  assert.equal(moveSelection(order, "01", "ArrowDown"), "02");
  assert.equal(moveSelection(order, "03", "j"), "03");
  assert.equal(moveSelection(order, "01", "k"), "01");
  assert.equal(moveSelection(order, "03", "ArrowUp"), "02");
  assert.equal(moveSelection(order, null, "j"), "01");
  assert.equal(moveSelection([], null, "j"), null);
  assert.equal(moveSelection(order, "02", "x"), "02");
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  assert.deepEqual(enterTarget(view.byId["04"]), { index: 10, select: true });
  assert.deepEqual(enterTarget(view.byId["07"]), { index: 12, select: false });
  assert.equal(enterTarget(null), null);
});

test("card model: call transcript uses offsets, wall clock keeps the local time", async () => {
  const { conversation } = await load("p3-ru-call-014");
  assert.equal(messageTime(conversation.messages[1], "call"), "00:06");
  assert.equal(wallClock("2026-11-07T09:42:00+05:00", "ru"), "07.11.2026 09:42");
  assert.equal(wallClock("", "ru"), "");
});

test("card model: localized falls back to the stored title and honours labels", () => {
  assert.equal(localized({ title: "A" }, "kk", "title"), "A");
  assert.equal(localized({ title: "A", labels: { kk: { title: "Б" } } }, "kk", "title"), "Б");
  assert.equal(localized({ title: "A", labels: { kk: { title: "Б" } } }, "en", "title"), "A");
  assert.equal(localized(null, "ru", "title"), null);
});

test("card model: confidence level falls back to the low-confidence flag", () => {
  assert.equal(confidenceLevel({ level: "high" }, true), "high");
  assert.equal(confidenceLevel(null, true), "low");
  assert.equal(confidenceLevel(null, false), "high");
});

test("card views: total, version chip and tiles per locale", async () => {
  const { conversation, evaluation } = await load();
  const ru = scoreSection(buildCard(conversation, evaluation, "ru"), evaluation, { locale: "ru" }).toString();
  assert.match(norm(ru), />81,88</);
  assert.match(ru, /Чек-лист качества чатов · v2/);
  assert.match(ru, /LLM-оценщик v3/);
  assert.match(ru, /data-gross="none"/);
  assert.equal((ru.match(/class="tile"/g) || []).length, 3);
  const en = scoreSection(buildCard(conversation, evaluation, "en"), evaluation, { locale: "en" }).toString();
  assert.match(en, />81\.88</);
  assert.match(en, /out of 100/);
  const kk = scoreSection(buildCard(conversation, evaluation, "kk"), evaluation, { locale: "kk" }).toString();
  assert.match(norm(kk), />81,88</);
});

test("card views: transcript renders every event with cite buttons and pick controls", async () => {
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  const out = transcriptSection(view, { locale: "ru", durationText: "05:05" }).toString();
  assert.equal((out.match(/<li class="m /g) || []).length, 15);
  assert.match(out, /15 событий · 05:05/);
  assert.match(out, /data-action="cite" data-crit="04"/);
  assert.match(out, /aria-pressed="false"/);
  assert.match(out, /бот \/ система - не оцениваются/);
});

test("card views: criteria list has the keyboard container, N/A text and scale chips", async () => {
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  const out = criteriaSection(view, { locale: "ru", canAppeal: false }).toString();
  assert.match(out, /data-crit-list/);
  assert.match(out, /tabindex="0"/);
  assert.equal((out.match(/class="crit-pick"/g) || []).length, 7);
  assert.match(out, /Условие N\/A выполнено:/);
  assert.match(out, /Вес 20 → исключён/);
  assert.match(out, /step step-on/);
  assert.match(out, /Ожидалось здесь · 04:51–04:58/);
  assert.ok(!/data-action="appeal"/.test(out));
});

test("card views: appeal buttons only render for the operator and skip criteria with an appeal", async () => {
  const { conversation, evaluation } = await load();
  const view = buildCard(conversation, evaluation, "ru");
  const out = criteriaSection(view, { locale: "ru", canAppeal: true }).toString();
  const count = (out.match(/data-action="appeal"/g) || []).length;
  assert.equal(count, view.order.filter((id) => !view.byId[id].appeal).length);
});

test("card views: message and rationale text is escaped", async () => {
  const { conversation, evaluation } = await load();
  const hostile = '<img src=x onerror="alert(1)">';
  conversation.messages[2].text = hostile;
  evaluation.criteria[0].rationale = hostile;
  const view = buildCard(conversation, evaluation, "ru");
  const out = `${transcriptSection(view, { locale: "ru", durationText: "" })}${criteriaSection(view, { locale: "ru", canAppeal: false })}`;
  assert.ok(!/<img/i.test(out));
  assert.ok(out.includes("&lt;img"));
});

test("card views: low confidence keeps the provisional total with its chip and note", async () => {
  const { conversation, evaluation } = await load("p1-ru-001", { state: "lowconf" });
  assert.equal(evaluation.provisional, true);
  const out = scoreSection(buildCard(conversation, evaluation, "ru"), evaluation, { locale: "ru" }).toString();
  assert.match(out, /Предварительно - низкая уверенность/);
  assert.match(out, /data-provisional-note/);
  assert.match(out, /data-total/);
});

test("card strings exist in all locales with the same keys", () => {
  const keys = (locale) => Object.keys(DICTIONARIES[locale]).filter((k) => k.startsWith("card."));
  const ru = keys("ru");
  assert.ok(ru.length > 50);
  for (const locale of LOCALES) assert.deepEqual(keys(locale).sort(), ru.slice().sort(), locale);
  for (const locale of LOCALES) {
    for (const key of ru) assert.ok(DICTIONARIES[locale][key] !== "", `${locale} ${key}`);
  }
});

test("card source files carry no comments", () => {
  const files = ["card-model.js", "card-view.js", "cqa-conversation-card.js"];
  for (const file of files) {
    const text = readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8");
    assert.ok(!/(^|\s)\/\/|\/\*/.test(text.replace(/https?:\/\//g, "")), file);
  }
  const screen = readFileSync(new URL("../src/screens/card.js", import.meta.url), "utf8");
  assert.ok(!/\/\/|\/\*/.test(screen));
});
