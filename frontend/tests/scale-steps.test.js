import test from "node:test";
import assert from "node:assert/strict";
import { formatPoints, parseStepValue, stepPoints, topStep, validateSteps } from "../src/scale-steps.js";
import { t } from "../src/i18n/index.js";
import { STEP_ERRORS } from "../src/scale-steps.js";

const steps = (...values) => values.map((value) => ({ value, description: "" }));

test("points are step / top x weight", () => {
  assert.deepEqual(stepPoints(steps("0", "4", "7", "10"), 15), [0, 6, 10.5, 15]);
  assert.deepEqual(stepPoints(steps(0, 5, 10), 20), [0, 10, 20]);
  assert.equal(topStep(steps("0", "4", "7", "10")), 10);
});

test("points are null when the scale cannot be evaluated", () => {
  assert.deepEqual(stepPoints(steps("0", "x"), 15), [null, null]);
  assert.deepEqual(stepPoints(steps("0"), 15), [null]);
  assert.deepEqual(stepPoints(steps("0", "10"), Number.NaN), [null, null]);
});

test("points format per locale", () => {
  assert.equal(formatPoints(6, "ru"), "6,00");
  assert.equal(formatPoints(10.5, "ru"), "10,50");
  assert.equal(formatPoints(10.5, "en"), "10.50");
  assert.equal(formatPoints(null, "ru"), "—");
});

test("a valid scale has no errors", () => {
  assert.deepEqual(validateSteps(steps("0", "4", "7", "10")), []);
  assert.deepEqual(validateSteps(steps("0", "1")), []);
});

test("fewer than two steps is an error", () => {
  assert.deepEqual(validateSteps(steps("0")), ["min"]);
  assert.deepEqual(validateSteps([]), ["min"]);
});

test("steps must increase strictly", () => {
  assert.deepEqual(validateSteps(steps("0", "4", "4")), ["ascending"]);
  assert.deepEqual(validateSteps(steps("0", "7", "4")), ["ascending"]);
});

test("the lowest step must be 0", () => {
  assert.deepEqual(validateSteps(steps("1", "4")), ["zero"]);
  assert.deepEqual(validateSteps(steps("-1", "4")), ["zero"]);
});

test("non numeric values are reported", () => {
  assert.ok(validateSteps(steps("0", "")).includes("number"));
  assert.ok(validateSteps(steps("a", "5")).includes("number"));
  assert.equal(parseStepValue("7,5"), 7.5);
  assert.equal(parseStepValue(" 3 "), 3);
  assert.equal(parseStepValue("1e3"), null);
});

test("error messages exist in every locale with the specified Russian text", () => {
  assert.equal(t(STEP_ERRORS.min, {}, "ru"), "Нужно минимум 2 шага");
  assert.equal(t(STEP_ERRORS.ascending, {}, "ru"), "Шаги должны возрастать");
  assert.equal(t(STEP_ERRORS.zero, {}, "ru"), "Нижний шаг должен быть 0");
  assert.equal(t("scale.rule", { top: 10, weight: 15 }, "ru"), "верхний шаг 10 = полный вес 15");
  assert.equal(t("scale.value", { n: 2 }, "ru"), "Значение шага 2");
  assert.equal(t("scale.description", { n: 2 }, "ru"), "Описание шага 2");
});
