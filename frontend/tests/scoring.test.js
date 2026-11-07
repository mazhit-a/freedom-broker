import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { score, ScoringError } from "../src/scoring.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/scoring_cases.json", import.meta.url), "utf8"));

const fixed = (v) => (v === null || v === undefined ? null : Number(v).toFixed(2));

function checkCase(c) {
  const config = golden.configs[c.config];
  if (c.expect.error) {
    assert.throws(() => score(config, c.answers, c.overrides), ScoringError);
    return;
  }
  const r = score(config, c.answers, c.overrides);
  const e = c.expect;
  assert.equal(fixed(r.total), e.total);
  assert.equal(r.calculated, e.calculated);
  assert.equal(r.provisional, e.provisional);
  assert.equal(r.grossViolation, e.grossViolation);
  assert.deepEqual(r.needsReviewIds, e.needsReviewIds);
  if (e.reason) assert.equal(r.reason, e.reason);
  if (e.applicableWeight) assert.equal(fixed(r.applicableWeight), e.applicableWeight);
  if (e.factor) assert.equal(r.factor, e.factor);
  for (const [id, want] of Object.entries(e.sections || {})) {
    const got = r.sections.find((s) => s.id === id);
    assert.ok(got, `section ${id}`);
    for (const [k, v] of Object.entries(want)) assert.equal(fixed(got[k]), v, `${id}.${k}`);
  }
  for (const [id, want] of Object.entries(e.criteria || {})) {
    const got = r.criteria.find((x) => x.id === id);
    assert.ok(got, `criterion ${id}`);
    for (const [k, v] of Object.entries(want)) {
      if (k === "na") assert.equal(got.na, v);
      else assert.equal(fixed(got[k]), v, `${id}.${k}`);
    }
  }
}

for (const c of golden.cases) test(`golden: ${c.name}`, () => checkCase(c));

const seed = golden.configs.seed;
const card = { "01": "yes", "02": "yes", "03": "na", "04": 15, "05": "yes", "06": 7, "07": "no", "08": "no" };

test("p1-ru-001 totals are 81.88 and 88.13", () => {
  assert.equal(score(seed, card).total, 81.88);
  assert.equal(score(seed, card, { "07": "yes" }).total, 88.13);
});

test("ledger rows expose nominal and effective weight, points and the N/A flag", () => {
  const r = score(seed, card);
  const row = (id) => r.criteria.find((c) => c.id === id);
  assert.equal(r.applicableWeight, 80);
  assert.equal(r.factor, 1.25);
  assert.equal(row("01").weight, 10);
  assert.equal(row("01").effectiveWeight, 12.5);
  assert.equal(row("04").effectiveWeight, 25);
  assert.equal(row("04").points, 15);
  assert.equal(row("03").na, true);
  assert.equal(row("03").effectiveWeight, null);
  assert.equal(row("08").points, null);
});

test("section subtotals match the Conversations row", () => {
  const r = score(seed, card);
  assert.deepEqual(
    ["opening", "security", "conduct"].map((id) => r.sections.find((s) => s.id === id).effectivePoints),
    [31.25, 18.75, 31.88]
  );
  assert.equal(score(seed, card, { "07": "yes" }).sections.find((s) => s.id === "conduct").effectivePoints, 38.13);
});

test("a float implementation would not pass: 88.125 is exact", () => {
  assert.equal(Math.round(88.125 * 100) / 100, 88.13);
  assert.equal(score(seed, card, { "07": "yes" }).total, 88.13);
  assert.equal(score(golden.configs["half-up"], { a: "yes", b: "no" }).total, 0.63);
});

test("inputs are not mutated and overrides win over answers", () => {
  const answers = { ...card };
  const r = score(seed, answers, { "07": "yes" });
  assert.deepEqual(answers, card);
  assert.equal(r.criteria.find((c) => c.id === "07").answer, "yes");
});

test("answer spellings are normalised like the backend", () => {
  const r = score(seed, { ...card, "01": "Yes", "02": true, "03": " N/A ", "04": "15", "05": "TRUE" });
  assert.equal(r.total, 81.88);
});
