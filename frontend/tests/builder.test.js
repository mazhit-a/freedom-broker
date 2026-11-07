import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { score } from "../src/scoring.js";
import { makeConfig } from "../src/mock-fixtures.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import {
  addCriterion,
  changedCount,
  createDraft,
  formatHundredths,
  inputWeight,
  isChanged,
  isNew,
  moveCriterion,
  numbering,
  parseHundredths,
  removeCriterion,
  reset,
  setNaCondition,
  setType,
  toConfig,
  toDecimalString
} from "../src/components/builder-model.js";
import { sumHundredths, validate } from "../src/components/builder-validate.js";
import { computePreview, sampleAnswer } from "../src/components/builder-preview.js";
import { elements } from "../src/screens/builder.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/scoring_cases.json", import.meta.url), "utf8"));
const META = { checklistId: 1, versionId: 13, versionNumber: 3, baseNumber: 2 };

function base() {
  const config = makeConfig("Чек-лист качества чатов");
  return createDraft(config, makeConfig("Чек-лист качества чатов"), META, "ru");
}

function byId(draft, id) {
  return draft.criteria.find((c) => c.id === id);
}

function threeWeights(a, b, c) {
  const draft = base();
  draft.criteria = draft.criteria.slice(0, 3);
  draft.criteria[0].weight = a;
  draft.criteria[1].weight = b;
  draft.criteria[2].weight = c;
  return draft;
}

test("registration exposes the builder tag", () => {
  assert.deepEqual(Object.keys(elements), ["cqa-checklist-builder"]);
});

test("weights parse to exact hundredths", () => {
  assert.equal(parseHundredths("33,3"), 3330);
  assert.equal(parseHundredths("33.30"), 3330);
  assert.equal(parseHundredths("0"), 0);
  assert.equal(parseHundredths("100"), 10000);
  assert.equal(parseHundredths("100,01"), null);
  assert.equal(parseHundredths("1.234"), null);
  assert.equal(parseHundredths(""), null);
  assert.equal(parseHundredths("abc"), null);
  assert.equal(parseHundredths("-5"), null);
  assert.equal(parseHundredths("1e2"), null);
  assert.equal(toDecimalString(3330), "33.30");
  assert.equal(toDecimalString(5), "0.05");
  assert.equal(inputWeight(33.3, "ru"), "33,3");
  assert.equal(inputWeight(33.3, "en"), "33.3");
  assert.equal(inputWeight(20, "ru"), "20");
  assert.equal(inputWeight(33.333, "ru"), "33.333");
  assert.equal(formatHundredths(9999, "ru"), "99,99");
  assert.equal(formatHundredths(9500, "ru"), "95");
  assert.equal(formatHundredths(3330, "en"), "33.3");
});

test("sum uses exact hundredths: 33,3 + 33,3 + 33,4 is exactly 100", () => {
  const ok = threeWeights("33,3", "33,3", "33,4");
  assert.equal(sumHundredths(ok), 10000);
  assert.ok(!validate(ok).errors.some((e) => e.code === "sum"));
  const floatTrap = threeWeights("0,1", "0,2", "99,7");
  assert.equal(sumHundredths(floatTrap), 10000);
  assert.equal(sumHundredths(threeWeights("50", "49,99", "0")), 9999);
  assert.equal(sumHundredths(threeWeights("60", "40,01", "0")), 10001);
  assert.ok(validate(threeWeights("50", "49,99", "0")).errors.some((e) => e.code === "sum"));
  assert.ok(validate(threeWeights("60", "40,01", "0")).errors.some((e) => e.code === "sum"));
});

test("base checklist is valid and weights total 100", () => {
  const v = validate(base());
  assert.equal(v.sum, 10000);
  assert.deepEqual(v.errors, []);
  assert.equal(v.valid, true);
});

test("95 is reported with the exact message data and blocks", () => {
  const draft = base();
  byId(draft, "03").weight = "15";
  const v = validate(draft);
  assert.equal(v.valid, false);
  assert.deepEqual(v.errors, [{ code: "sum", key: null, sum: 9500 }]);
});

test("flag weight never counts", () => {
  const draft = base();
  byId(draft, "08").weight = "50";
  assert.equal(sumHundredths(draft), 10000);
});

test("empty and duplicate names, bad weights, scale violations are listed", () => {
  const draft = base();
  byId(draft, "01").name = "  ";
  byId(draft, "02").name = "Идентификация";
  byId(draft, "05").weight = "";
  byId(draft, "04").steps[0].value = "2";
  byId(draft, "06").steps[2].value = "3.5";
  const v = validate(draft);
  const codes = v.errors.map((e) => e.code);
  assert.ok(codes.includes("nameEmpty"));
  assert.ok(codes.includes("nameDup"));
  assert.ok(codes.includes("weight"));
  const scale = v.errors.filter((e) => e.code === "scale").map((e) => e.problem);
  assert.ok(scale.includes("scale.errZero"));
  assert.ok(scale.includes("builder.err.stepInteger"));
  assert.ok(scale.includes("scale.errAscending"));
  assert.equal(v.valid, false);
  byId(draft, "01").name = "Контакт";
  byId(draft, "02").name = "Потребность";
  byId(draft, "05").weight = "15";
  byId(draft, "04").steps[0].value = "0";
  byId(draft, "06").steps[2].value = "7";
  assert.equal(validate(draft).valid, true);
});

test("duplicate names compare trimmed and case-insensitive", () => {
  const draft = base();
  byId(draft, "02").name = "  УСТАНОВЛЕНИЕ контакта ";
  assert.ok(validate(draft).errors.some((e) => e.code === "nameDup"));
});

test("type mapping to and from the API config", () => {
  const draft = base();
  assert.equal(byId(draft, "01").type, "yn");
  assert.equal(byId(draft, "02").type, "ynna");
  assert.equal(byId(draft, "04").type, "scale");
  assert.equal(byId(draft, "08").type, "flag");
  const out = toConfig(draft);
  const get = (id) => out.criteria.find((c) => c.id === id);
  assert.equal(get("01").type, "yes_no");
  assert.equal(get("01").na_allowed, false);
  assert.equal(get("02").type, "yes_no");
  assert.equal(get("02").na_allowed, true);
  assert.equal(get("04").type, "scale");
  assert.equal(get("04").max_step, 20);
  assert.deepEqual(get("04").scale_steps[1], { value: 5, descriptor: "Частично верно, есть ошибки" });
  assert.equal(get("08").type, "flag");
  assert.equal(get("08").weight, 0);
  assert.deepEqual(out, { ...makeConfig("Чек-лист качества чатов"), criteria: out.criteria });
  assert.deepEqual(out.criteria, makeConfig("Чек-лист качества чатов").criteria);
});

test("flag forces weight 0, scale seeds three steps, na allowed follows the condition", () => {
  const draft = base();
  const c1 = byId(draft, "01");
  setType(draft, c1.key, "flag", []);
  assert.equal(c1.weight, "0");
  assert.equal(toConfig(draft).criteria[0].weight, 0);
  const c2 = byId(draft, "02");
  setType(draft, c2.key, "scale", [{ value: "0", description: "a" }, { value: "5", description: "b" }, { value: "10", description: "c" }]);
  assert.equal(c2.steps.length, 3);
  assert.equal(toConfig(draft).criteria[1].max_step, 10);
  assert.equal(toConfig(draft).criteria[1].na_allowed, true);
  setNaCondition(c2, "");
  assert.equal(toConfig(draft).criteria[1].na_allowed, false);
  assert.equal(toConfig(draft).criteria[1].na_condition, null);
  setType(draft, c2.key, "yn", []);
  assert.equal(toConfig(draft).criteria[1].type, "yes_no");
  assert.deepEqual(toConfig(draft).criteria[1].scale_steps, []);
});

test("changed, new and removed counting against the base", () => {
  const draft = base();
  assert.equal(changedCount(draft), 0);
  byId(draft, "01").weight = "11";
  assert.ok(isChanged(draft, byId(draft, "01")));
  assert.equal(changedCount(draft), 1);
  byId(draft, "01").weight = "10";
  assert.equal(changedCount(draft), 0);
  const key = addCriterion(draft, "conduct", { name: "N", description: "D" });
  assert.ok(isNew(draft, draft.criteria.find((c) => c.key === key)));
  assert.equal(changedCount(draft), 1);
  removeCriterion(draft, byId(draft, "07").key);
  assert.equal(changedCount(draft), 2);
  reset(draft, makeConfig("x"), "ru");
  assert.equal(changedCount(draft), 0);
  assert.equal(draft.criteria.length, 8);
});

test("new criterion goes after the last criterion of its section with defaults", () => {
  const draft = base();
  const key = addCriterion(draft, "opening", { name: "Новый критерий", description: "Опишите" });
  const created = draft.criteria.find((c) => c.key === key);
  assert.equal(created.id, "09");
  assert.equal(created.weight, "0");
  assert.equal(created.type, "yn");
  const num = numbering(draft);
  assert.equal(num.get(key), "03");
  assert.equal(num.get(byId(draft, "03").key), "04");
  const second = addCriterion(draft, "opening", { name: "Другой", description: "" });
  assert.equal(draft.criteria.find((c) => c.key === second).id, "10");
  assert.notEqual(second, key);
});

test("the last remaining criterion cannot be removed", () => {
  const draft = base();
  let guard = 0;
  while (draft.criteria.length > 1 && guard < 20) {
    guard += 1;
    assert.notEqual(removeCriterion(draft, draft.criteria[0].key), null);
  }
  assert.equal(draft.criteria.length, 1);
  assert.equal(removeCriterion(draft, draft.criteria[0].key), null);
  assert.equal(draft.criteria.length, 1);
});

test("reorder stays inside the section", () => {
  const draft = base();
  const first = byId(draft, "01").key;
  assert.equal(moveCriterion(draft, first, -1), false);
  assert.equal(moveCriterion(draft, first, 1), true);
  assert.deepEqual(draft.criteria.slice(0, 2).map((c) => c.id), ["02", "01"]);
  assert.equal(moveCriterion(draft, first, 1), false);
  assert.equal(numbering(draft).get(first), "02");
});

test("preview of the base checklist matches the golden scoring case", () => {
  const draft = base();
  const p = computePreview(draft);
  assert.equal(p.ok, true);
  assert.equal(p.total, 81.88);
  assert.equal(p.applicableWeight, 80);
  assert.equal(p.factor, 1.25);
  assert.equal(p.anyNa, true);
  const goldenCase = golden.cases.find((c) => c.name.startsWith("p1-ru-001 as shown"));
  const expected = score(golden.configs[goldenCase.config], goldenCase.answers);
  assert.equal(p.total, expected.total);
  assert.equal(p.total, Number(goldenCase.expect.total));
  assert.equal(p.rows.length, 7);
  assert.equal(p.rows[2].na, true);
  assert.equal(p.rows[2].effectiveWeight, null);
  assert.equal(p.rows[0].effectiveWeight, 12.5);
  assert.equal(p.rows[3].effectivePoints, 18.75);
});

test("preview recomputes when weights change and keeps 100", () => {
  const draft = base();
  byId(draft, "04").weight = "25";
  byId(draft, "02").weight = "10";
  assert.equal(sumHundredths(draft), 10000);
  const p = computePreview(draft);
  assert.notEqual(p.total, 81.88);
  assert.equal(p.applicableWeight, 80);
  const config = toConfig(draft);
  const answers = { "01": "yes", "02": "yes", "03": "na", "04": 15, "05": "yes", "06": 7, "07": "no", "08": "no" };
  assert.equal(p.total, score(config, answers).total);
});

test("preview is not calculated when every sample answer is N/A or no weight applies", () => {
  const draft = base();
  const allNa = computePreview(draft, undefined, (c, answers) => (c.type === "ynna" ? "na" : sampleAnswer(c, answers)));
  assert.equal(allNa.ok, true);
  for (const c of draft.criteria) if (c.type !== "flag") c.weight = "0";
  const none = computePreview(draft);
  assert.equal(none.calculated, false);
  assert.equal(none.total, null);
  assert.equal(none.factor, null);
});

test("preview with every weighted criterion N/A shows not calculated", () => {
  const draft = base();
  draft.criteria = draft.criteria.filter((c) => c.type === "ynna" || c.type === "flag");
  const p = computePreview(draft, {}, () => "na");
  assert.equal(p.calculated, false);
  assert.equal(p.total, null);
});

test("preview pauses on invalid scale steps and survives bad weights", () => {
  const draft = base();
  byId(draft, "04").steps[1].value = "";
  assert.deepEqual(computePreview(draft), { ok: false, reason: "scale" });
  byId(draft, "04").steps[1].value = "5";
  byId(draft, "01").weight = "zzz";
  assert.equal(computePreview(draft).ok, true);
});

test("sample answers adapt to type changes", () => {
  const draft = base();
  setType(draft, byId(draft, "03").key, "yn", []);
  const p = computePreview(draft);
  assert.equal(p.rows[2].na, false);
  assert.equal(p.rows[2].answer, "yes");
  assert.equal(p.applicableWeight, 100);
  assert.equal(p.anyNa, false);
});

test("builder strings exist in all locales with the same keys", () => {
  const keys = (locale) => Object.keys(DICTIONARIES[locale]).filter((k) => k.startsWith("builder."));
  const ru = keys("ru");
  assert.ok(ru.length > 80);
  for (const locale of LOCALES) assert.deepEqual(keys(locale).sort(), ru.slice().sort(), locale);
});

test("builder source files carry no comments", () => {
  for (const file of ["builder-model.js", "builder-validate.js", "builder-preview.js", "builder-views.js", "cqa-checklist-builder.js"]) {
    const text = readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8");
    assert.ok(!/(^|\s)\/\/|\/\*/.test(text.replace(/https?:\/\//g, "")), file);
  }
});
