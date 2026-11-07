import test from "node:test";
import assert from "node:assert/strict";
import { t, setLocale, getLocale, subscribe, hasKey, DICTIONARIES, LOCALES, normalizeLocale } from "../src/i18n/index.js";
import { can, normalizeRole, wireRole } from "../src/roles.js";

test("all locales define the same keys as ru", () => {
  const base = Object.keys(DICTIONARIES.ru).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(DICTIONARIES[locale]).sort(), base, locale);
  }
});

test("plural entries have an other form in every locale", () => {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(DICTIONARIES[locale])) {
      if (typeof value === "object") assert.ok(value.other, `${locale}:${key}`);
    }
  }
});

test("t translates, interpolates and picks plural forms", () => {
  assert.equal(t("nav.overview", {}, "ru"), "Обзор");
  assert.equal(t("nav.overview", {}, "en"), "Overview");
  assert.equal(t("count.conversations", { count: 1 }, "ru"), "1 диалог");
  assert.equal(t("count.conversations", { count: 2 }, "ru"), "2 диалога");
  assert.equal(t("count.conversations", { count: 5 }, "ru"), "5 диалогов");
  assert.equal(t("count.conversations", { count: 21 }, "ru"), "21 диалог");
  assert.equal(t("count.conversations", { count: 11 }, "ru"), "11 диалогов");
  assert.equal(t("count.conversations", { count: 3 }, "en"), "3 conversations");
});

test("missing keys return the key", () => {
  assert.equal(t("no.such.key"), "no.such.key");
  assert.equal(hasKey("no.such.key"), false);
});

test("operator display name is not localised", () => {
  for (const locale of LOCALES) assert.equal(t("actor.operator", {}, locale), "Оператор A");
});

test("role labels follow the combined QA / reviewer decision", () => {
  assert.equal(t("role.reviewer", {}, "ru"), "QA / Проверяющий");
});

test("setLocale notifies subscribers and normalises", () => {
  const seen = [];
  const off = subscribe((l) => seen.push(l));
  setLocale("kk");
  assert.equal(getLocale(), "kk");
  setLocale("kk");
  setLocale("xx");
  off();
  assert.deepEqual(seen, ["kk", "ru"]);
  assert.equal(normalizeLocale("KZ"), "kk");
});

test("roles map legacy keys to the combined role", () => {
  assert.equal(normalizeRole("qa"), "reviewer");
  assert.equal(normalizeRole("reviewer"), "reviewer");
  assert.equal(normalizeRole("unknown"), "exec");
  assert.equal(can("reviewer", "decide-appeal"), true);
  assert.equal(can("reviewer", "file-appeal"), false);
  assert.equal(can("operator", "file-appeal"), true);
  assert.equal(can("operator", "decide-appeal"), false);
  assert.equal(can("exec", "file-appeal"), false);
  assert.equal(wireRole("qa"), "reviewer");
  assert.equal(wireRole("exec"), null);
});
