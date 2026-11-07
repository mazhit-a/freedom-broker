import test from "node:test";
import assert from "node:assert/strict";
import { configure, api } from "../src/api.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import { buildCard } from "../src/components/card-model.js";
import { activeMessageIndex, appealSummary, compactRows, grossIndices, grossMarkers, headerParts, messageStart, redistributionNote, timeline, wallDate } from "../src/components/call-model.js";
import { callMetaTemplate, compactTable, grossAlert, playFromHere } from "../src/components/call-view.js";
import call from "../src/i18n/screens/call.js";

const norm = (value) => String(value).replace(/[  ]/g, " ");

async function load() {
  configure({ mock: true });
  const conversation = await api.getConversation("p3-ru-call-014");
  const evaluation = await api.getEvaluation("p3-ru-call-014");
  return { conversation, evaluation, view: buildCard(conversation, evaluation, "ru") };
}

test("timeline uses audio starts and ignores messages without them", async () => {
  const { conversation } = await load();
  const points = timeline(conversation.messages);
  assert.equal(points.length, 12);
  assert.equal(points[5].start, 43);
  assert.equal(messageStart({ audioStart: null }), null);
  assert.deepEqual(timeline([{ index: 0, audioStart: null }]), []);
});

test("active message is the last one whose start is not after the position", async () => {
  const { conversation } = await load();
  const points = timeline(conversation.messages);
  assert.equal(activeMessageIndex(points, 0), 0);
  assert.equal(activeMessageIndex(points, 42.9), 4);
  assert.equal(activeMessageIndex(points, 43), 5);
  assert.equal(activeMessageIndex(points, 58), 6);
  assert.equal(activeMessageIndex(points, 999), 11);
  assert.equal(activeMessageIndex([], 10), null);
  assert.equal(activeMessageIndex([{ index: 3, start: 5 }], 1), null);
});

test("gross markers sit at the audio starts of the criterion 08 evidence", async () => {
  const { conversation, view } = await load();
  assert.deepEqual(grossIndices(view), [5, 7]);
  const markers = grossMarkers(view, timeline(conversation.messages));
  assert.deepEqual(markers, [{ index: 5, start: 43 }, { index: 7, start: 59 }]);
  assert.deepEqual(grossMarkers(view, []), []);
});

test("header parts: date and duration", async () => {
  const { conversation } = await load();
  assert.deepEqual(headerParts(conversation, "ru"), ["05.11.2026", "02:44"]);
  assert.equal(wallDate("2026-11-05T14:02:05+05:00", "en"), "11/05/2026");
  assert.equal(wallDate("", "ru"), "");
  assert.match(String(callMetaTemplate(["05.11.2026", "02:44"], "ru")), /05\.11\.2026 · 02:44 · транскрипт ASR/);
});

test("compact rows and table match the design numbers", async () => {
  const { evaluation, view } = await load();
  const rows = compactRows(view);
  assert.equal(rows.length, 7);
  const six = rows.find((r) => r.id === "06");
  assert.equal(six.answer, 4);
  assert.equal(six.effPoints, 6);
  assert.equal(six.effWeight, 15);
  assert.equal(rows.find((r) => r.id === "01").reason, "");
  assert.equal(redistributionNote(evaluation, view).redistributed, false);
  const out = norm(compactTable(view, evaluation, rows, { locale: "ru", toggleLabel: "x", appealStatus: null }));
  assert.match(out, /4 из 10/);
  assert.match(out, /6,00 \/ 15/);
  assert.match(out, /10,00 \/ 10/);
  assert.match(out, /Все критерии применимы · перераспределения нет/);
  assert.match(out, /role="table"/);
  assert.match(out, /crow-gross/);
  assert.equal(appealSummary(view) === null || typeof appealSummary(view) === "string", true);
});

test("gross alert is an alert with seeking evidence chips and no escalation clause", async () => {
  const { view } = await load();
  const out = norm(grossAlert(view, "ru"));
  assert.match(out, /role="alert"/);
  assert.match(out, /Грубая ошибка · 08/);
  assert.match(out, /Флаг без баллов/);
  assert.doesNotMatch(out, /руководител/);
  assert.match(out, /data-action="call-gross" data-msg="5"/);
  assert.match(out, /Оператор · 00:43/);
  assert.match(out, /Оператор · 00:59/);
});

test("play from here is a labelled button", () => {
  const out = String(playFromHere({ index: 5, n: 6, time: "00:43" }, 43, "ru"));
  assert.match(out, /data-action="call-play" data-msg="5"/);
  assert.match(out, /aria-label="Воспроизвести с 00:43, сообщение 6"/);
});

test("call timestamps come from audio starts", async () => {
  const { view } = await load();
  assert.equal(view.messages[5].time, "00:43");
  assert.equal(view.messages[11].time, "02:44");
});

test("audio and call keys exist in every locale with the same set", () => {
  const keys = Object.keys(call.ru);
  for (const lang of LOCALES) {
    assert.deepEqual(Object.keys(call[lang]).sort(), keys.slice().sort(), lang);
    for (const key of keys) assert.ok(DICTIONARIES[lang][key], `${lang} ${key}`);
  }
});

test("mock adapter: no audio url, waveform peaks present, call only", async () => {
  configure({ mock: true });
  assert.equal(api.audioUrl("p3-ru-call-014"), null);
  const wave = await api.getWaveform("p3-ru-call-014");
  assert.equal(wave.peaks.length, 80);
  await assert.rejects(() => api.getWaveform("p1-ru-001"));
});
