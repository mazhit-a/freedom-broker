import test from "node:test";
import assert from "node:assert/strict";
import { configure, api } from "../src/api.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import { buildCard } from "../src/components/card-model.js";
import { allowedAnswers, answerValue, candidateIds, defaultNewAnswer, errorText, fragmentFor, isCommentValid, openFor, previewTotals, refChips } from "../src/components/appeal-model.js";
import { reviewPanel } from "../src/components/appeal-panel.js";

const norm = (value) => String(value).replace(/[  ]/g, " ");

async function load(id = "p1-ru-001") {
  configure({ mock: true });
  const conversation = await api.getConversation(id);
  const evaluation = await api.getEvaluation(id);
  return { conversation, evaluation, view: buildCard(conversation, evaluation, "ru") };
}

function def(evaluation, id) {
  return evaluation.criteria.find((c) => c.id === id);
}

test("allowed answers follow the criterion type", async () => {
  const { evaluation } = await load();
  assert.deepEqual(allowedAnswers(def(evaluation, "07")), ["yes", "no", "na"]);
  assert.deepEqual(allowedAnswers(def(evaluation, "04")), [0, 5, 10, 15, 20, "na"]);
  assert.deepEqual(allowedAnswers({ type: "yes_no", naAllowed: false }), ["yes", "no"]);
  assert.deepEqual(allowedAnswers({ type: "flag", naAllowed: true }), ["yes", "no"]);
  assert.deepEqual(allowedAnswers({ type: "scale", naAllowed: true, steps: [{ value: 3 }, { value: 0 }] }), [0, 3, "na"]);
  assert.deepEqual(allowedAnswers(null), []);
});

test("default new answer differs from the current one", async () => {
  const { evaluation } = await load();
  assert.equal(defaultNewAnswer(def(evaluation, "07")), "yes");
  assert.equal(defaultNewAnswer(def(evaluation, "04")), 0);
  assert.equal(answerValue("na"), "na");
  assert.equal(answerValue("15"), 15);
});

test("preview reads 81,88 to 88,13 for Да and 87,33 for N/A on criterion 07", async () => {
  const { evaluation } = await load();
  assert.deepEqual(previewTotals(evaluation, "07", "change", "yes"), { before: 81.88, after: 88.13 });
  assert.deepEqual(previewTotals(evaluation, "07", "change", "na"), { before: 81.88, after: 87.33 });
  assert.deepEqual(previewTotals(evaluation, "07", "confirm", "yes"), { before: 81.88, after: 81.88 });
  assert.deepEqual(previewTotals(evaluation, "07", "change", null), { before: 81.88, after: 81.88 });
  assert.equal(previewTotals(evaluation, "07", "change", "maybe"), null);
  assert.equal(previewTotals({ ...evaluation, config: null }, "07", "change", "yes"), null);
});

test("candidates skip criteria with an open appeal", async () => {
  const { evaluation, view } = await load();
  assert.equal(openFor(evaluation, "07"), true);
  assert.deepEqual(candidateIds(view, evaluation), ["01", "02", "03", "04", "05", "06"]);
});

test("reference chips and fragment come from the transcript", async () => {
  const { evaluation, view } = await load();
  const chips = refChips(view, [12, 13, 99]);
  assert.deepEqual(chips.map((c) => [c.index, c.n, c.time, c.kind]), [[12, 13, "04:51", "client"], [13, 14, "04:58", "operator"]]);
  const appeal = evaluation.appeals.find((a) => a.criterionId === "07");
  const fragment = fragmentFor(view, def(evaluation, "07"), appeal);
  assert.deepEqual(fragment.map((f) => f.index), [12, 13]);
  const fallback = fragmentFor(view, { expected: null, evidence: [] }, appeal);
  assert.deepEqual(fallback.map((f) => f.index), appeal.refs.map((r) => r.index));
});

test("comment validation trims", () => {
  assert.equal(isCommentValid("   "), false);
  assert.equal(isCommentValid(""), false);
  assert.equal(isCommentValid(null), false);
  assert.equal(isCommentValid(" ok "), true);
});

test("error codes map to localized inline text", () => {
  const tr = (locale) => (key) => DICTIONARIES[locale][key];
  assert.match(errorText("appeal", { code: "appeal_open_exists" }, "ru", tr("ru")), /уже есть открытая апелляция/);
  assert.match(errorText("review", { code: "reason_required" }, "ru", tr("ru")), /обоснование/);
  assert.match(errorText("review", { code: "reason_required" }, "en", tr("en")), /reason/);
  assert.match(errorText("review", { status: 403, code: "weird" }, "kk", tr("kk")), /QA/);
  assert.equal(errorText("appeal", { code: "unknown_thing" }, "ru", tr("ru")), DICTIONARIES.ru["appeal.err.generic"]);
  assert.equal(errorText("appeal", null, "en", tr("en")), DICTIONARIES.en["appeal.err.generic"]);
});

test("dictionaries carry the same appeal and review keys in every locale", () => {
  const keys = (locale) => Object.keys(DICTIONARIES[locale]).filter((k) => k.startsWith("appeal.") || k.startsWith("review.")).sort();
  const base = keys("ru");
  assert.ok(base.length > 40);
  for (const locale of LOCALES) assert.deepEqual(keys(locale), base, locale);
  for (const locale of LOCALES) for (const key of base) assert.ok(String(DICTIONARIES[locale][key]).length > 0, `${locale} ${key}`);
});

function panelModel(evaluation, view, state) {
  const d = def(evaluation, "07");
  const appeal = evaluation.appeals.find((a) => a.criterionId === "07");
  return {
    id: appeal.id,
    criterion: d,
    title: "Завершение",
    appeal,
    state,
    options: allowedAnswers(d).map((value) => ({ value, label: String(value) })),
    preview: previewTotals(evaluation, "07", state.decision, state.newAnswer),
    fragment: fragmentFor(view, d, appeal),
    refsText: "Ссылки: 04:51, 04:58",
    filed: "подана"
  };
}

test("decision panel renders preview, disabled save without reason and inline error", async () => {
  const { evaluation, view } = await load();
  const state = { decision: "change", newAnswer: "yes", reason: "", busy: false, error: null };
  const markup = norm(reviewPanel(panelModel(evaluation, view, state), "ru"));
  assert.match(markup, /81,88 → 88,13/);
  assert.match(markup, /data-action="review-save"[^>]*disabled/);
  assert.match(markup, /aria-required="true"/);
  assert.doesNotMatch(markup, /data-rv-error/);
  const ready = norm(reviewPanel(panelModel(evaluation, view, { ...state, reason: "Причина" }), "ru"));
  assert.doesNotMatch(ready, /data-action="review-save"[^>]*disabled/);
  const failed = norm(reviewPanel(panelModel(evaluation, view, { ...state, reason: "x", error: "Укажите обоснование решения." }), "ru"));
  assert.match(failed, /role="alert" data-rv-error>Укажите обоснование решения\./);
  const confirm = norm(reviewPanel(panelModel(evaluation, view, { ...state, decision: "confirm", reason: "x" }), "ru"));
  assert.doesNotMatch(confirm, /data-rv="answer"/);
  assert.match(confirm, /81,88 → 81,88/);
});

test("decision panel names only the role labels and escapes the comment", async () => {
  const { evaluation, view } = await load();
  const model = panelModel(evaluation, view, { decision: "change", newAnswer: "yes", reason: "<b>x</b>", busy: false, error: null });
  const markup = reviewPanel(model, "ru").toString();
  assert.ok(!markup.includes("<b>x</b>"));
  assert.match(markup, /&lt;b&gt;x&lt;\/b&gt;/);
});

test("mock flow: operator files, reviewer decides, totals follow", async () => {
  configure({ mock: true });
  const before = await api.getEvaluation("p1-ru-001");
  const filed = await api.submitAppeal(before.id, "04", { comment: "Сроки названы", refs: [10, 11] });
  assert.equal(filed.open, true);
  assert.deepEqual(filed.refs.map((r) => r.index), [10, 11]);
  await assert.rejects(() => api.submitAppeal(before.id, "04", { comment: "ещё раз" }), (e) => e.code === "appeal_open_exists");
  await assert.rejects(() => api.submitAppeal(before.id, "05", { comment: "  " }), (e) => e.code === "comment_required");
  await assert.rejects(() => api.decideAppeal(filed.id, { decision: "confirm", reason: " " }), (e) => e.code === "reason_required");
  const decided = await api.decideAppeal(filed.id, { decision: "change", newAnswer: 20, reason: "Сроки названы" });
  assert.equal(decided.open, false);
  const after = await api.getEvaluation("p1-ru-001");
  assert.ok(after.total > before.total);
  assert.equal(after.totalChanged, true);
});
