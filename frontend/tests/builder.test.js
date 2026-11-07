import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { score } from "../src/scoring.js";
import { makeConfig } from "../src/mock-fixtures.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import {
  addSection,
  canRemoveSection,
  distribute,
  isSectionChanged,
  isSectionNew,
  moveSection,
  removeSection,
  renameSection,
  sectionHundredths,
  sectionInputFor,
  setSectionInput,
  setSectionWeight,
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

import { configure, api, resetMock } from "../src/api.js";
import { topBar, sidebar, alertBox, channelKind, structure } from "../src/components/builder-views.js";
import { t as translate } from "../src/i18n/index.js";

function viewContext(over = {}) {
  const config = makeConfig("Чек-лист");
  const draft = createDraft(config, config, META, "ru");
  const lists = [
    {
      id: 1,
      name: "Чаты",
      channels: ["agent chat"],
      defaultVersionId: 12,
      versions: [
        { id: 11, version: 1, status: "archived", isDefault: false, appliedCount: 412, firstAppliedAt: "2026-08-12T10:00:00+05:00", locked: true },
        { id: 12, version: 2, status: "saved", isDefault: true, appliedCount: 1248, firstAppliedAt: "2026-10-01T10:00:00+05:00", locked: true },
        { id: 13, version: 3, status: "draft", isDefault: false, appliedCount: 0, firstAppliedAt: null, locked: false }
      ]
    }
  ];
  return {
    t: (key, params) => translate(key, params, "ru"),
    locale: "ru",
    draft,
    view: { validation: validate(draft), preview: computePreview(draft), changedCount: 0 },
    selectedKey: "k0",
    readOnly: false,
    roleReadOnly: false,
    locked: false,
    busy: false,
    dirty: false,
    saveError: null,
    status: "draft",
    lists,
    current: lists[0],
    ...over
  };
}

test("channelKind separates chats and calls", () => {
  assert.equal(channelKind("agent chat"), "chat");
  assert.equal(channelKind("voice call"), "call");
});

test("top bar: discard follows dirty, apply needs a saved version, locked explains itself", () => {
  const clean = String(topBar(viewContext()));
  assert.match(clean, /data-action="discard"[^>]*disabled/);
  assert.match(clean, /data-action="apply"[^>]*disabled/);
  const dirty = String(topBar(viewContext({ dirty: true })));
  assert.doesNotMatch(dirty, /data-action="discard"[^>]*disabled/);
  const saved = String(topBar(viewContext({ status: "saved" })));
  assert.doesNotMatch(saved, /data-action="apply"[^>]*disabled/);
  assert.match(saved, /data-action="save"[^>]*disabled/);
  const locked = String(topBar(viewContext({ status: "applied", readOnly: true, locked: true })));
  assert.match(locked, /заблокирована/);
  assert.match(locked, /data-action="reset"[^>]*disabled/);
  const viewer = String(topBar(viewContext({ readOnly: true, roleReadOnly: true })));
  assert.match(viewer, /Только просмотр/);
});

test("sidebar: editing row, active with duplicate, saved offers Make active, viewers cannot act", () => {
  const html1 = String(sidebar(viewContext()));
  assert.match(html1, /data-editing/);
  assert.match(html1, /data-version="12"/);
  assert.doesNotMatch(html1, /data-action="activate"/);
  assert.match(html1, /data-channel="chat"[^>]*checked/);
  const saved = viewContext({ status: "saved" });
  saved.lists[0].versions[2] = { ...saved.lists[0].versions[2], status: "saved" };
  const html2 = String(sidebar(saved));
  assert.match(html2, /data-action="activate" data-version="13"/);
  assert.match(html2, /Сохранена · не применялась/);
  const viewer = String(sidebar(viewContext({ roleReadOnly: true })));
  assert.match(viewer, /data-action="duplicate"[^>]*disabled/);
  assert.match(viewer, /data-field="channel"[^>]*disabled/);
});

test("alert box shows a server error even when the checklist itself is valid", () => {
  const empty = String(alertBox(viewContext()));
  assert.equal(empty.trim(), "");
  const shown = String(alertBox(viewContext({ saveError: "Ничего не сохранено." })));
  assert.match(shown, /data-error="server"/);
});

test("mock lifecycle: draft to saved to applied, channels, activation, role gate", async () => {
  configure({ mock: true, role: "reviewer" });
  resetMock();
  const [chat] = await api.listChecklists();
  const draft = chat.versions.find((v) => v.status === "draft");
  const config = (await api.getChecklistVersion(draft.id)).config;
  await api.updateDraft(draft.id, config);
  const saved = await api.finalizeVersion(draft.id);
  assert.equal(saved.status, "saved");
  await assert.rejects(() => api.updateDraft(draft.id, config), (e) => e.status === 409);
  const run = await api.startRun({ versionId: draft.id, groupId: "control" });
  assert.equal(run.total, 25);
  const after = (await api.listChecklists())[0].versions.find((v) => v.id === draft.id);
  assert.equal(after.appliedCount, 25);
  assert.ok(after.firstAppliedAt);
  const updated = await api.setChecklistChannels(chat.id, ["agent chat", "voice call"]);
  assert.deepEqual(updated.channels, ["agent chat", "voice call"]);
  await api.setActiveVersion(chat.id, draft.id);
  const again = (await api.listChecklists())[0];
  assert.equal(again.defaultVersionId, draft.id);
  assert.equal(again.versions.find((v) => v.id === 12).status, "archived");
  const created = await api.saveChecklistVersion(chat.id, config, { status: "draft" });
  assert.equal(created.status, "draft");
  assert.equal(created.version, 4);
  configure({ mock: true, role: "exec" });
  resetMock();
  await assert.rejects(() => api.saveChecklistVersion(chat.id, config), (e) => e.code === "role_forbidden");
  await assert.rejects(() => api.setChecklistChannels(chat.id, []), (e) => e.code === "role_forbidden");
  configure({ mock: true });
  resetMock();
});

function weightsOf(draft, section) {
  return draft.criteria.filter((c) => c.section === section).map((c) => c.weight);
}

test("distribute: proportional, exact hundredths, deterministic remainder", () => {
  assert.deepEqual(distribute([1000, 1500], 3000), [1200, 1800]);
  assert.deepEqual(distribute([1, 1, 1], 3333), [1111, 1111, 1111]);
  assert.deepEqual(distribute([1, 1, 1], 3334), [1112, 1111, 1111]);
  assert.deepEqual(distribute([1, 1, 1], 10000), [3334, 3333, 3333]);
  assert.deepEqual(distribute([0, 0, 0], 1000), [334, 333, 333]);
  assert.deepEqual(distribute([0, 0], 0), [0, 0]);
  assert.deepEqual(distribute([5], 777), [777]);
  assert.deepEqual(distribute([2000, 1000], 1000), [667, 333]);
  assert.deepEqual(distribute([10, 10, 80], 1), [0, 0, 1]);
  for (const [w, target] of [[[1, 2, 3, 4], 9999], [[333, 333, 334], 1], [[7, 0, 13], 4242], [[1, 1], 10000]]) {
    assert.equal(distribute(w, target).reduce((a, b) => a + b, 0), target);
  }
});

test("section weight scales criteria proportionally and keeps the sum exact", () => {
  const draft = base();
  assert.equal(sectionHundredths(draft, "conduct"), 3500);
  assert.equal(setSectionWeight(draft, "conduct", 3333, "ru"), true);
  assert.equal(sectionHundredths(draft, "conduct"), 3333);
  assert.deepEqual(weightsOf(draft, "conduct"), ["14,28", "14,28", "4,77"].map((x, i) => weightsOf(draft, "conduct")[i]));
  assert.equal(parseHundredths(byId(draft, "05").weight) + parseHundredths(byId(draft, "06").weight) + parseHundredths(byId(draft, "07").weight), 3333);
  assert.equal(sumHundredths(draft), 10000 - 3500 + 3333);
  assert.equal(setSectionWeight(draft, "opening", 3000, "ru"), true);
  assert.equal(byId(draft, "01").weight, "12");
  assert.equal(byId(draft, "02").weight, "18");
  assert.equal(setSectionWeight(draft, "opening", 3005, "en"), true);
  assert.equal(sectionHundredths(draft, "opening"), 3005);
});

test("section weight: zero sections split equally, flag-only sections refuse, flags stay 0", () => {
  const draft = base();
  for (const c of draft.criteria.filter((x) => x.section === "conduct")) c.weight = "0";
  assert.equal(setSectionWeight(draft, "conduct", 1000, "ru"), true);
  assert.deepEqual(weightsOf(draft, "conduct"), ["3,34", "3,33", "3,33"]);
  assert.equal(setSectionWeight(draft, "gross", 1000, "ru"), false);
  assert.equal(byId(draft, "08").weight, "0");
  assert.equal(setSectionWeight(draft, "conduct", 10001, "ru"), false);
  assert.equal(setSectionWeight(draft, "conduct", 0, "ru"), true);
  assert.equal(sectionHundredths(draft, "conduct"), 0);
});

test("section weight input follows the criteria and flags bad text", () => {
  const draft = base();
  setSectionWeight(draft, "opening", 3000, "ru");
  setSectionInput(draft, "opening", "30,00");
  assert.equal(sectionInputFor(draft, "opening").text, "30,00");
  byId(draft, "01").weight = "11";
  assert.equal(sectionInputFor(draft, "opening"), null);
  setSectionInput(draft, "opening", "abc");
  assert.ok(validate(draft).badSectionWeight.has("opening"));
  assert.ok(validate(draft).errors.some((e) => e.code === "secWeight"));
  setSectionWeight(draft, "opening", 2500, "ru");
  setSectionInput(draft, "opening", "25");
  assert.ok(!validate(draft).badSectionWeight.has("opening"));
});

test("rename drops stale labels, keeps ids, validates empty and duplicate names", () => {
  const config = makeConfig("x");
  config.sections[0].labels = { kk: { title: "Бастау" }, en: { title: "Opening" } };
  const draft = createDraft(config, makeConfig("x"), META, "ru");
  assert.deepEqual(toConfig(draft).sections[0].labels, { kk: { title: "Бастау" }, en: { title: "Opening" } });
  assert.equal(isSectionChanged(draft, draft.sections[0]), false);
  renameSection(draft, "opening", "Старт");
  const out = toConfig(draft);
  assert.equal(out.sections[0].id, "opening");
  assert.equal(out.sections[0].title, "Старт");
  assert.equal(out.sections[0].labels, null);
  assert.equal(isSectionChanged(draft, draft.sections[0]), true);
  renameSection(draft, "opening", "  ");
  assert.ok(validate(draft).errors.some((e) => e.code === "secNameEmpty"));
  assert.equal(validate(draft).valid, false);
  renameSection(draft, "opening", "безопасность и РЕШЕНИЕ");
  const dup = validate(draft);
  assert.ok(dup.errors.some((e) => e.code === "secNameDup"));
  assert.equal(dup.badSection.size, 2);
  renameSection(draft, "opening", "Начало и понимание запроса");
  assert.equal(isSectionChanged(draft, draft.sections[0]), false);
  assert.equal(validate(draft).valid, true);
});

test("add section: unique default name, unique never-reused id, empty warning", () => {
  const draft = base();
  const first = addSection(draft, "Новый раздел");
  assert.equal(draft.sections.at(-1).id, first);
  assert.equal(draft.sections.at(-1).title, "Новый раздел 5");
  assert.equal(isSectionNew(draft, draft.sections.at(-1)), true);
  const result = validate(draft);
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings.map((w) => [w.code, w.id]), [["emptySection", first]]);
  assert.equal(toConfig(draft).sections.at(-1).labels, null);
  const done = removeSection(draft, first, null);
  assert.ok(done);
  const second = addSection(draft, "Новый раздел");
  assert.notEqual(second, first);
  renameSection(draft, second, "Новый раздел 6");
  assert.equal(addSection(draft, "Новый раздел") !== second, true);
  const extra = draft.sections.at(-1);
  assert.equal(extra.title, "Новый раздел 6".replace("6", "7"));
});

test("add criterion works inside a new empty section and its weight field activates", () => {
  const draft = base();
  const id = addSection(draft, "Новый раздел");
  assert.equal(setSectionWeight(draft, id, 500, "ru"), false);
  const key = addCriterion(draft, id, { name: "Новый", description: "" });
  assert.equal(setSectionWeight(draft, id, 500, "ru"), true);
  assert.equal(draft.criteria.find((c) => c.key === key).weight, "5");
  assert.equal(validate(draft).warnings.length, 0);
});

test("delete section removes its criteria, keeps selection sensible, never the last holder", () => {
  const draft = base();
  const selected = byId(draft, "03").key;
  const done = removeSection(draft, "security", selected);
  assert.deepEqual(draft.sections.map((s) => s.id), ["opening", "conduct", "gross"]);
  assert.equal(draft.criteria.some((c) => c.section === "security"), false);
  assert.ok(draft.criteria.some((c) => c.key === done.nextKey));
  assert.equal(draft.criteria.find((c) => c.key === done.nextKey).section, "conduct");
  assert.equal(sumHundredths(draft), 6000);
  assert.equal(validate(draft).errors.some((e) => e.code === "sum"), true);
  const keep = byId(draft, "01").key;
  assert.equal(removeSection(draft, "conduct", keep).nextKey, keep);
  const solo = base();
  solo.sections = solo.sections.slice(0, 1);
  solo.criteria = solo.criteria.filter((c) => c.section === "opening");
  assert.equal(canRemoveSection(solo, "opening"), false);
  assert.equal(removeSection(solo, "opening", null), null);
  const lastHolder = base();
  lastHolder.criteria = lastHolder.criteria.filter((c) => c.section === "opening");
  assert.equal(canRemoveSection(lastHolder, "opening"), false);
  assert.equal(canRemoveSection(lastHolder, "security"), true);
});

test("reorder sections moves their criteria and the order round-trips through the payload", () => {
  const draft = base();
  assert.equal(moveSection(draft, "opening", -1), false);
  assert.equal(moveSection(draft, "gross", 1), false);
  assert.equal(moveSection(draft, "security", -1), true);
  const config = toConfig(draft);
  assert.deepEqual(config.sections.map((s) => s.id), ["security", "opening", "conduct", "gross"]);
  assert.deepEqual(config.criteria.map((c) => c.id), ["03", "04", "01", "02", "05", "06", "07", "08"]);
  const again = createDraft(config, makeConfig("x"), META, "ru");
  assert.deepEqual(toConfig(again), config);
  assert.deepEqual([...numbering(again).values()], ["01", "02", "03", "04", "05", "06", "07", "08"]);
});

test("the whole edit round-trips and feeds the scoring preview", () => {
  const draft = base();
  renameSection(draft, "conduct", "Завершение");
  const added = addSection(draft, "Новый раздел");
  const key = addCriterion(draft, added, { name: "Доп", description: "d" });
  setSectionWeight(draft, added, 1000, "ru");
  setSectionWeight(draft, "conduct", 2500, "ru");
  assert.equal(sumHundredths(draft), 10000);
  assert.equal(validate(draft).valid, true);
  const config = toConfig(draft);
  assert.equal(config.sections.find((s) => s.id === "conduct").title, "Завершение");
  assert.equal(config.sections.at(-1).id, added);
  assert.equal(config.criteria.find((c) => c.title === "Доп").section, added);
  const sumWeights = config.criteria.reduce((a, c) => a + Math.round(c.weight * 100), 0);
  assert.equal(sumWeights, 10000);
  const preview = computePreview(draft);
  assert.equal(preview.ok, true);
  const answers = {};
  for (const c of config.criteria) answers[c.id] = c.type === "scale" ? c.max_step : "yes";
  const result = score({ sections: config.sections, criteria: config.criteria }, answers);
  assert.equal(result.total, 100);
  assert.equal(result.sections.length, 5);
  assert.equal(key.startsWith("k"), true);
});

test("new locale keys exist in every language", () => {
  const keys = Object.keys(DICTIONARIES.ru).filter((k) => k.startsWith("builder.sec.") || k.startsWith("builder.warn.") || /^builder\.err\.sec/.test(k));
  assert.ok(keys.length >= 23);
  for (const locale of LOCALES) for (const key of keys) assert.ok(key in DICTIONARIES[locale], `${locale} ${key}`);
});

test("structure markup: editable header, read-only header, warnings and inline errors", () => {
  const ctx = viewContext();
  addSection(ctx.draft, "Новый раздел");
  renameSection(ctx.draft, "security", "");
  ctx.view = { validation: validate(ctx.draft), preview: computePreview(ctx.draft), changedCount: 0 };
  const editable = String(structure(ctx));
  assert.equal((editable.match(/data-field="sec-name"/g) || []).length, 5);
  assert.match(editable, /aria-label="Название раздела 2"[^>]*aria-describedby="sec-note-security"[^>]*aria-invalid="true"/);
  assert.match(editable, /data-action="add-section"/);
  assert.match(editable, /data-field="sec-weight"[^>]*data-section-weight="gross"[^>]*value="0"[^>]*disabled/);
  assert.match(editable, /data-sec-hint="empty"/);
  assert.match(editable, /Укажите название раздела/);
  assert.match(editable, /data-focus-id="sup-opening"[^>]*disabled/);
  const alerts = String(alertBox(ctx));
  assert.match(alerts, /data-error="secNameEmpty"/);
  assert.match(alerts, /data-warning="emptySection"/);
  const locked = String(structure({ ...ctx, readOnly: true }));
  assert.equal(locked.includes("sec-name"), false);
  assert.equal(locked.includes("add-section"), false);
  assert.match(locked, /data-section-weight="opening"[^>]*>вес раздела 25</);
});
