import test from "node:test";
import assert from "node:assert/strict";
import { number, integer, percent, plural, date, duration } from "../src/format.js";

const norm = (s) => s.replace(/[  ]/g, " ");

test("number uses locale decimal separator", () => {
  assert.equal(number(82.5, "ru"), "82,50");
  assert.equal(number(82.5, "kk"), "82,50");
  assert.equal(number(82.5, "en"), "82.50");
});

test("integer groups thousands with a non-breaking space in ru", () => {
  const out = integer(1248, "ru");
  assert.match(out, /^1[  ]248$/);
  assert.equal(norm(out), "1 248");
  assert.equal(integer(1248, "en"), "1,248");
});

test("percent", () => {
  assert.equal(norm(percent(3.4, "ru")), "3,4 %");
  assert.equal(percent(3.4, "en"), "3.4%");
});

test("empty values give an empty string", () => {
  assert.equal(number(null, "ru"), "");
  assert.equal(percent(undefined, "en"), "");
});

test("russian plural forms for the dialog noun", () => {
  const forms = { one: "диалог", few: "диалога", many: "диалогов", other: "диалога" };
  const pick = (n) => plural(n, "ru", forms);
  assert.equal(pick(1), "диалог");
  assert.equal(pick(2), "диалога");
  assert.equal(pick(5), "диалогов");
  assert.equal(pick(21), "диалог");
  assert.equal(pick(11), "диалогов");
  assert.equal(pick(22), "диалога");
  assert.equal(pick(0), "диалогов");
});

test("english plural", () => {
  const forms = { one: "item", other: "items" };
  assert.equal(plural(1, "en", forms), "item");
  assert.equal(plural(2, "en", forms), "items");
});

test("date and duration", () => {
  assert.equal(date("2026-11-07T10:00:00Z", "ru"), "07.11.2026");
  assert.equal(duration(65), "01:05");
  assert.equal(duration(3725), "1:02:05");
});
