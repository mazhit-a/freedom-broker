import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_DEFAULTS, DEMO_TEXT, DEMO_LOCALES, DEMO_ROLES, buildSteps, demoIds, frameUrl, stepIndexForHash } from "../src/demo-steps.js";
import { parseHash } from "../src/routes.js";
import { ROLES } from "../src/roles.js";

test("demo ids come from config.js with defaults per mode", () => {
  assert.equal(demoIds({}, false).gross, "p1-ru-022");
  assert.equal(demoIds({}, true).gross, DEMO_DEFAULTS.mock.gross);
  assert.equal(demoIds({ demo: { real: { call: "p4-ru-005" } } }, false).call, "p4-ru-005");
  assert.equal(demoIds({ demo: { real: { call: "p4-ru-005" } } }, false).chatNa, "p1-ru-001");
});

test("steps walk the TASK demo path and every hash is a known route", () => {
  const steps = buildSteps(demoIds({}, false));
  assert.deepEqual(steps.map((s) => s.key), ["list", "na", "gross", "call", "appeal", "decide", "total", "builder", "runs"]);
  for (const step of steps) {
    const route = parseHash(step.hash);
    assert.ok(route.known, step.hash);
    assert.ok(ROLES.includes(step.role), step.role);
  }
  assert.equal(steps[4].role, "operator");
  assert.equal(steps[5].role, "reviewer");
  assert.equal(parseHash(steps[3].hash).id, "p4-ru-004");
  assert.equal(steps.filter((s) => s.minutes).reduce((n, s) => n + s.minutes, 0), 5);
});

test("texts exist for every step in ru, kk and en", () => {
  const keys = buildSteps(demoIds({}, true)).map((s) => s.key);
  for (const locale of DEMO_LOCALES) {
    const text = DEMO_TEXT[locale];
    for (const key of keys) {
      assert.ok(text.steps[key].title && text.steps[key].body && text.steps[key].points.length >= 2, `${locale}.${key}`);
    }
    for (const role of DEMO_ROLES) assert.ok(text.roles[role]);
  }
  assert.deepEqual(Object.keys(DEMO_TEXT.kk).sort(), Object.keys(DEMO_TEXT.ru).sort());
  assert.deepEqual(Object.keys(DEMO_TEXT.en).sort(), Object.keys(DEMO_TEXT.ru).sort());
});

test("frame urls are relative and carry the mock flag only in mock mode", () => {
  assert.equal(frameUrl({ page: "index.html", role: null, locale: "ru", mock: true, hash: "#/runs" }), "index.html?mock=1&locale=ru#/runs");
  assert.equal(frameUrl({ page: "index.html", role: "reviewer", locale: "kk", mock: false, hash: "#/appeals" }), "index.html?role=reviewer&locale=kk#/appeals");
  assert.ok(!frameUrl({ page: "index.html", mock: false, hash: "" }).startsWith("/"));
});

test("hash to step lookup", () => {
  const steps = buildSteps(demoIds({}, false));
  assert.equal(stepIndexForHash(steps, "#/appeals"), 5);
  assert.equal(stepIndexForHash(steps, "#/nope"), -1);
});
