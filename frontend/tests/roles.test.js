import test from "node:test";
import assert from "node:assert/strict";
import { ROLES, DEFAULT_ROLE, can, capabilities, normalizeRole, wireRole } from "../src/roles.js";
import { t, LOCALES } from "../src/i18n/index.js";

test("header offers exactly two roles in the design order", () => {
  assert.deepEqual([...ROLES], ["reviewer", "operator"]);
  assert.deepEqual(
    ROLES.map((r) => t(`role.${r}`, {}, "ru")),
    ["QA / Проверяющий", "Оператор"]
  );
});

test("every role label exists in every locale", () => {
  for (const locale of LOCALES) for (const role of ROLES) assert.notEqual(t(`role.${role}`, {}, locale), `role.${role}`);
});

test("legacy keys map to the combined role and unknown keys to the default role", () => {
  assert.equal(normalizeRole("qa"), "reviewer");
  assert.equal(normalizeRole("Reviewer"), "reviewer");
  assert.equal(normalizeRole("operator"), "operator");
  assert.equal(normalizeRole("nobody"), DEFAULT_ROLE);
  assert.equal(normalizeRole(undefined), DEFAULT_ROLE);
});

test("operator files appeals, reviewer decides", () => {
  assert.equal(can("operator", "file-appeal"), true);
  assert.equal(can("operator", "decide-appeal"), false);
  assert.equal(can("reviewer", "decide-appeal"), true);
  assert.equal(can("reviewer", "file-appeal"), false);
});

test("wire role names stay operator and reviewer", () => {
  assert.equal(wireRole("operator"), "operator");
  assert.equal(wireRole("qa"), "reviewer");
  assert.equal(wireRole("exec"), "reviewer");
});
