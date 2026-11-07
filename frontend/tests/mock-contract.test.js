import test from "node:test";
import assert from "node:assert/strict";
import { configure, api, resetMock, getSettings, ADAPTER_METHODS, REAL_METHODS, GAP_METHODS } from "../src/api.js";
import { score } from "../src/scoring.js";
import { ROWS, makeConfig, CHAT_CHECKLIST_NAME } from "../src/mock-fixtures.js";

const LIST_ITEM_KEYS = [
  "appealStatus", "calculated", "channel", "checklistName", "confidence", "durationSeconds", "evaluated", "evaluationId", "failed", "gross", "groupId", "hasAudio", "id", "language", "lowConfidence", "messageCount", "modelLabel", "occurredAt", "operator", "originalTotal", "pk", "provisional", "sections", "status", "total", "totalChanged", "totalStatus", "versionId", "versionLabel"
];
const CONVERSATION_KEYS = ["channel", "channelRaw", "datasetId", "durationSeconds", "groupId", "hasAudio", "id", "language", "messages", "occurredAt", "operator", "pk"];
const MESSAGE_KEYS = ["audioEnd", "audioStart", "index", "n", "offsetSeconds", "speaker", "text", "time", "timestamp"];
const EVALUATION_KEYS = [
  "appealDeadline", "appealStatus", "appealWindowWorkdays", "appeals", "applicableWeight", "calculated", "checklistName", "config", "confidence", "conversationPk", "cost", "createdAt", "criteria", "durationSeconds", "factor", "grossViolation", "id", "latencyMs", "lowConfidence", "model", "modelLabel", "occurredAt", "originalTotal", "provisional", "reason", "sections", "status", "tokensIn", "tokensOut", "total", "totalChanged", "totalStatus", "versionId", "versionLabel"
];
const CRITERION_KEYS = [
  "answer", "appeal", "description", "effPoints", "effWeight", "evidence", "expected", "id", "labels", "maxStep", "naAllowed", "naCondition", "naReason", "needsReview", "number", "originalAnswer", "overridden", "points", "rationale", "section", "steps", "title", "type", "weight"
];
const APPEAL_KEYS = [
  "ageHours", "author", "authorRole", "channel", "comment", "conversationId", "conversationPk", "createdAt", "criterionId", "criterionLabels", "criterionSteps", "criterionTitle", "criterionType", "criterionWeight", "decidedAt", "decidedBy", "decision", "evaluationId", "fragment", "id", "language", "modelLabel", "naAllowed", "newAnswer", "open", "original", "reason", "refs", "reviewStartedAt", "status", "totalAfter", "totalBefore", "versionLabel"
];
const SUMMARY_KEYS = ["agingHours", "medianResolutionHours", "new", "olderThanHours", "open", "underReview"];
const OVERVIEW_KEYS = ["attention", "attentionTotal", "byChannel", "byLanguage", "distribution", "kpis", "perCriterion", "period"];
const KPI_KEYS = ["agingHours", "avgScore", "calls", "chats", "deltaVsPrev", "evaluatedCount", "grossCount", "grossShare", "medianResolutionDays", "notCalculated", "olderThanCount", "openAppeals", "previousAvg", "targetDays"];
const CHECKLIST_KEYS = ["channels", "defaultVersionId", "id", "name", "versions"];
const VERSION_SUMMARY_KEYS = ["appliedCount", "checklistId", "createdAt", "criteriaCount", "firstAppliedAt", "id", "isDefault", "label", "locked", "status", "version", "weightSum"];
const VERSION_KEYS = [...VERSION_SUMMARY_KEYS, "config", "name", "warnings"];
const DATASET_KEYS = ["calls", "chats", "conversations", "groupId", "id", "importedAt", "kind", "label", "source", "sourceFilename"];
const RUN_KEYS = [
  "averageTotal", "checklistLabel", "cost", "datasetLabel", "done", "elapsedSeconds", "etaSeconds", "failed", "failures", "finishedAt", "force", "groupId", "id", "items", "itemsTotal", "model", "needsReview", "number", "percent", "processed", "queued", "running", "skipped", "startedAt", "status", "tokensIn", "tokensOut", "toRun", "total", "versionId", "versionLabel"
];
const RUN_ITEM_KEYS = ["channel", "conversationId", "conversationPk", "error", "evaluationId", "gross", "language", "latencyMs", "otherVersionTotal", "status", "total"];

function sameKeys(o, expected, label) {
  assert.deepEqual(Object.keys(o).sort(), expected.slice().sort(), label);
}

async function rejects(promise, expected) {
  try {
    await promise;
  } catch (err) {
    for (const [k, v] of Object.entries(expected)) assert.equal(err[k], v, k);
    assert.equal(typeof err.message, "string");
    return err;
  }
  return assert.fail("expected a rejection");
}

function fresh(options = {}) {
  configure({ mock: true, ...options });
}

test("configure reads mock switches", () => {
  const s = configure({ mock: true, state: "slow", role: "operator", operatorId: "operator-a" });
  assert.equal(s.mock, true);
  assert.equal(s.state, "slow");
  assert.equal(getSettings().role, "operator");
});

test("every adapter method exists and the real/mock-only split is declared", () => {
  assert.deepEqual(Object.keys(api).sort(), ADAPTER_METHODS.slice().sort());
  assert.deepEqual(Object.keys(GAP_METHODS).sort(), ["estimateRun", "getWaveform", "listModels", "retryRunItem"]);
  for (const name of Object.keys(GAP_METHODS)) assert.ok(!REAL_METHODS.includes(name));
  for (const name of ADAPTER_METHODS) assert.ok(REAL_METHODS.includes(name) || name in GAP_METHODS, name);
});

test("conversation list, view model keys, totals computed by scoring.js", async () => {
  fresh();
  const list = await api.listConversations();
  assert.equal(list.items.length, 11);
  assert.equal(list.total, 11);
  assert.equal(list.evaluated, 10);
  for (const item of list.items) sameKeys(item, LIST_ITEM_KEYS, item.id);
  const config = makeConfig(CHAT_CHECKLIST_NAME);
  for (const row of ROWS) {
    const item = list.items.find((i) => i.id === row.id);
    if (row.failed) {
      assert.equal(item.total, null);
      assert.equal(item.failed, true);
      continue;
    }
    assert.equal(item.originalTotal, score(config, row.answers).total, row.id);
  }
  const byId = Object.fromEntries(list.items.map((i) => [i.id, i]));
  assert.equal(byId["p1-ru-001"].total, 81.88);
  assert.equal(byId["p3-ru-call-014"].total, 31);
  assert.deepEqual(byId["p1-ru-001"].sections.slice(0, 3).map((s) => s.effectivePoints), [31.25, 18.75, 31.88]);
  assert.deepEqual(byId["p3-ru-call-014"].sections.slice(0, 3).map((s) => s.effectivePoints), [25, 0, 6]);
  assert.equal(byId["p3-ru-call-014"].gross, true);
  assert.equal(byId["p2-en-003"].lowConfidence, true);
  assert.equal(typeof byId["p2-en-003"].total, "number");
  assert.equal(byId["p1-ru-001"].appealStatus, "under_review");
  assert.equal(byId["p1-ru-002"].appealStatus, "changed");
  assert.equal(byId["p1-ru-002"].total, 94);
  assert.equal(byId["p1-ru-002"].totalChanged, true);
});

test("conversation list filters, sort and paging", async () => {
  fresh();
  assert.equal((await api.listConversations({ channel: "call" })).total, 3);
  assert.equal((await api.listConversations({ language: "KZ" })).total, 3);
  assert.equal((await api.listConversations({ q: "p1-ru" })).total, 4);
  assert.equal((await api.listConversations({ q: "комиссия" })).total, 1);
  assert.equal((await api.listConversations({ appealStatus: "new" })).total, 2);
  const sorted = await api.listConversations({ sort: "-total", limit: 2 });
  assert.equal(sorted.items.length, 2);
  assert.equal(sorted.total, 11);
  assert.ok(sorted.items[0].total >= sorted.items[1].total);
  const asc = await api.listConversations({ sort: "total" });
  assert.equal(asc.items[0].id, "p3-ru-call-014");
  assert.equal(asc.items[asc.items.length - 1].failed, true);
  const page = await api.listConversations({ limit: 3, offset: 3 });
  assert.equal(page.items.length, 3);
});

test("conversation and evaluation view models", async () => {
  fresh();
  const conv = await api.getConversation("p1-ru-001");
  sameKeys(conv, CONVERSATION_KEYS, "conversation");
  assert.equal(conv.messages.length, 15);
  sameKeys(conv.messages[0], MESSAGE_KEYS, "message");
  assert.equal(conv.messages[0].n, 1);
  assert.equal(conv.messages[14].n, 15);
  const call = await api.getConversation("p3-ru-call-014");
  assert.equal(call.messages.length, 12);
  assert.equal(call.messages[5].audioStart, 43);
  assert.equal(call.messages[7].audioStart, 59);
  assert.equal(call.messages[5].time, "14:02:48");
  assert.equal(call.hasAudio, true);
  assert.equal(call.durationSeconds, 164);
  assert.equal((await api.getConversation(1)).id, "p1-ru-001");

  const ev = await api.getEvaluation("p1-ru-001");
  sameKeys(ev, EVALUATION_KEYS, "evaluation");
  assert.equal(ev.total, 81.88);
  assert.equal(ev.applicableWeight, 80);
  assert.equal(ev.factor, 1.25);
  assert.equal(ev.criteria.length, 8);
  for (const c of ev.criteria) sameKeys(c, CRITERION_KEYS, c.id);
  const byId = Object.fromEntries(ev.criteria.map((c) => [c.id, c]));
  assert.equal(byId["03"].answer, "na");
  assert.equal(byId["03"].effPoints, null);
  assert.equal(byId["04"].answer, 15);
  assert.equal(byId["04"].effPoints, 18.75);
  assert.equal(byId["04"].effWeight, 25);
  assert.deepEqual(byId["07"].expected, { from: 12, to: 13, fromN: 13, toN: 14 });
  assert.equal(byId["01"].evidence[0].n, 6);
  assert.ok(byId["01"].evidence[0].quote.includes("Айгерим"));
  assert.equal(byId["07"].appeal.status, "under_review");
  assert.equal(ev.config.criteria.length, 8);
  assert.equal(ev.versionLabel, "v2");
  assert.equal(ev.sections.length, 4);
  assert.deepEqual(ev.sections.slice(0, 3).map((s) => s.effectivePoints), [31.25, 18.75, 31.88]);

  const callEv = await api.getEvaluation("p3-ru-call-014");
  assert.equal(callEv.total, 31);
  assert.equal(callEv.grossViolation, true);
  assert.equal(callEv.criteria.find((c) => c.id === "08").evidence.length, 2);

  await rejects(api.getEvaluation("p1-ru-001", 11), { status: 404, code: "evaluation_not_found" });
  await rejects(api.getConversation("p1-ru-019"), { status: 404, code: "conversation_not_found" });
  const evs = await api.listEvaluations("p1-ru-001");
  assert.equal(evs.length, 1);
});

test("appeal lifecycle: submit, start review, decide change, totals 81.88 to 88.13", async () => {
  fresh();
  resetMock({ withoutAppeals: true });
  const ev = await api.getEvaluation("p1-ru-001");
  assert.equal(ev.total, 81.88);
  assert.equal(ev.appealStatus, "none");

  const created = await api.submitAppeal(ev.id, "07", { comment: "Клиент сам сказал, что вопросов нет", refs: [12, 13] });
  sameKeys(created, APPEAL_KEYS, "appeal");
  assert.equal(created.status, "new");
  assert.equal(created.open, true);
  assert.deepEqual(created.refs, [{ index: 12, n: 13 }, { index: 13, n: 14 }]);
  assert.equal(created.author, "Оператор A");
  assert.equal((await api.getEvaluation("p1-ru-001")).appealStatus, "new");

  await rejects(api.submitAppeal(ev.id, "07", { comment: "ещё раз" }), { status: 409, code: "appeal_open_exists" });
  await rejects(api.submitAppeal(ev.id, "05", { comment: "" }), { status: 422, code: "comment_required" });
  await rejects(api.submitAppeal(ev.id, "05", { comment: "x", refs: [99] }), { status: 422, code: "invalid_message_ref" });
  await rejects(api.submitAppeal(ev.id, "99", { comment: "x" }), { status: 404, code: "criterion_not_found" });

  const reviewing = await api.startReview(created.id);
  assert.equal(reviewing.status, "under_review");
  const again = await api.startReview(created.id);
  assert.equal(again.status, "under_review");

  await rejects(api.decideAppeal(created.id, { decision: "change", newAnswer: "yes", reason: "" }), { status: 422, code: "reason_required" });
  await rejects(api.decideAppeal(created.id, { decision: "change", reason: "ok" }), { status: 422, code: "answer_required" });
  await rejects(api.decideAppeal(created.id, { decision: "change", newAnswer: 5, reason: "ok" }), { status: 422, code: "invalid_answer" });
  await rejects(api.decideAppeal(created.id, { decision: "maybe", reason: "ok" }), { status: 422, code: "invalid_decision" });

  const decided = await api.decideAppeal(created.id, { decision: "change", newAnswer: "yes", reason: "Прощание есть" });
  assert.equal(decided.status, "changed");
  assert.equal(decided.open, false);
  assert.equal(decided.totalBefore, 81.88);
  assert.equal(decided.totalAfter, 88.13);
  assert.equal(decided.decidedBy, "QA / Проверяющий");
  await rejects(api.decideAppeal(created.id, { decision: "confirm", reason: "x" }), { status: 409, code: "appeal_resolved" });
  await rejects(api.startReview(created.id), { status: 409, code: "appeal_resolved" });

  const after = await api.getEvaluation("p1-ru-001");
  assert.equal(after.originalTotal, 81.88);
  assert.equal(after.total, 88.13);
  assert.equal(after.totalChanged, true);
  assert.equal(after.appealStatus, "changed");
  const c07 = after.criteria.find((c) => c.id === "07");
  assert.equal(c07.answer, "yes");
  assert.equal(c07.originalAnswer, "no");
  assert.equal(c07.overridden, true);
  assert.equal(c07.appeal.status, "changed");
  const expected = score(after.config, { "01": "yes", "02": "yes", "03": "na", "04": 15, "05": "yes", "06": 7, "07": "yes", "08": "no" });
  assert.equal(expected.total, 88.13);
  const list = await api.listConversations({ q: "p1-ru-001" });
  assert.equal(list.items[0].total, 88.13);
  assert.equal(list.items[0].appealStatus, "changed");
  assert.equal((await api.appealSummary()).open, 0);
});

test("seeded appeals keep the design statuses and decisions follow the rules", async () => {
  fresh();
  const all = await api.listAppeals();
  assert.equal(all.length, 5);
  const byStatus = Object.fromEntries(all.map((a) => [a.id, a.status]));
  assert.deepEqual(byStatus, { 1: "under_review", 2: "new", 3: "new", 4: "changed", 5: "confirmed" });
  assert.deepEqual(all.map((a) => a.id), [3, 5, 4, 2, 1]);
  for (const a of all) sameKeys(a, APPEAL_KEYS, "appeal " + a.id);
  assert.equal((await api.listAppeals({ status: "new" })).length, 2);
  assert.equal((await api.listAppeals({ status: "open" })).length, 3);
  assert.equal((await api.listAppeals({ status: "resolved" })).length, 2);
  const a2 = all.find((a) => a.id === 2);
  assert.equal(a2.criterionId, "03");
  assert.equal(a2.original.answer, "no");
  assert.equal(a2.fragment.length, 3);
  const detail = await api.getAppeal(1);
  assert.equal(detail.conversationId, "p1-ru-001");
  assert.equal(detail.original.answer, "no");
  assert.deepEqual(detail.refs.map((r) => r.index), [12, 13]);
  await rejects(api.getAppeal(999), { status: 404, code: "appeal_not_found" });

  const confirmed = await api.decideAppeal(2, { decision: "confirm", reason: "Контрольные вопросы обязательны" });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.totalBefore, confirmed.totalAfter);
  const sameAnswer = await api.decideAppeal(3, { decision: "change", newAnswer: "no", reason: "ответ тот же" });
  assert.equal(sameAnswer.status, "confirmed");
});

test("appeal changes reproduce the design previews through scoring.js", async () => {
  fresh();
  const a1 = await api.decideAppeal(1, { decision: "change", newAnswer: "yes", reason: "ок" });
  assert.equal(a1.totalBefore, 81.88);
  assert.equal(a1.totalAfter, 88.13);
  resetMock();
  const a1na = await api.decideAppeal(1, { decision: "change", newAnswer: "na", reason: "ок" });
  assert.equal(a1na.totalAfter, 87.33);
  resetMock();
  const a2yes = await api.decideAppeal(2, { decision: "change", newAnswer: "yes", reason: "ок" });
  assert.equal(a2yes.totalBefore, 31);
  assert.equal(a2yes.totalAfter, 51);
  resetMock();
  const a2na = await api.decideAppeal(2, { decision: "change", newAnswer: "na", reason: "ок" });
  assert.equal(a2na.totalAfter, 38.75);
});

test("roles gate filing and deciding", async () => {
  fresh({ role: "reviewer" });
  await rejects(api.submitAppeal(101, "05", { comment: "x" }), { status: 403, code: "role_forbidden" });
  fresh({ role: "operator" });
  await rejects(api.decideAppeal(1, { decision: "confirm", reason: "x" }), { status: 403, code: "role_forbidden" });
  await rejects(api.startReview(1), { status: 403, code: "role_forbidden" });
  const ok = await api.submitAppeal(101, "05", { comment: "x" });
  assert.equal(ok.status, "new");
  fresh({ role: "exec" });
  await rejects(api.submitAppeal(101, "06", { comment: "x" }), { status: 403, code: "role_forbidden" });
});

test("summary, overview, datasets, models and estimates", async () => {
  fresh();
  const s = await api.appealSummary();
  sameKeys(s, SUMMARY_KEYS, "summary");
  assert.deepEqual({ open: s.open, new: s.new, underReview: s.underReview, older: s.olderThanHours }, { open: 3, new: 2, underReview: 1, older: 1 });
  const o = await api.getOverview();
  sameKeys(o, OVERVIEW_KEYS, "overview");
  sameKeys(o.kpis, KPI_KEYS, "kpis");
  assert.equal(o.kpis.avgScore, 78.42);
  assert.equal(o.kpis.evaluatedCount, 1248);
  assert.equal(o.distribution.length, 10);
  assert.equal(o.distribution.reduce((sum, b) => sum + b.count, 0), 1248);
  assert.deepEqual(o.attention.map((a) => a.id), ["p3-ru-call-014", "p1-kz-007", "p1-ru-001", "p2-en-003"]);
  assert.equal(o.attention[0].score, 31);
  const ds = await api.listDatasets();
  assert.equal(ds.length, 2);
  for (const d of ds) sameKeys(d, DATASET_KEYS, d.groupId);
  const models = await api.listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0].paid, true);
  const est = await api.estimateRun({ groupId: "control", model: "llm-v3" });
  assert.equal(est.count, 25);
  assert.equal(est.cost, 0.1);
  assert.equal((await api.estimateRun({ count: 25, model: "local" })).cost, 0);
  const imported = await api.importDataset({ groupId: "new-set" });
  assert.equal(imported.groupId, "new-set");
  assert.equal(imported.created, 10);
  assert.equal((await api.listDatasets()).length, 3);
});

test("checklists: versions, drafts, save, active pointer", async () => {
  fresh();
  const lists = await api.listChecklists();
  assert.equal(lists.length, 2);
  for (const l of lists) sameKeys(l, CHECKLIST_KEYS, l.name);
  for (const v of lists[0].versions) sameKeys(v, VERSION_SUMMARY_KEYS, v.label);
  assert.deepEqual(lists[0].versions.map((v) => [v.label, v.status]), [["v1", "archived"], ["v2", "active"], ["v3", "draft"]]);
  assert.equal(lists[0].versions[1].appliedCount, 1248);
  assert.equal(lists[1].versions[0].status, "draft");
  assert.equal(lists[1].versions[0].appliedCount, 0);
  const v2 = await api.getChecklistVersion(12);
  sameKeys(v2, VERSION_KEYS, "version");
  assert.equal(v2.config.criteria.length, 8);
  const draft = await api.saveChecklistVersion(1, v2.config, { status: "draft" });
  assert.equal(draft.status, "draft");
  assert.equal(draft.label, "v4");
  const changed = { ...draft.config, criteria: draft.config.criteria.map((c) => (c.id === "01" ? { ...c, weight: 5 } : c)) };
  const updated = await api.updateDraft(draft.id, changed);
  assert.equal(updated.weightSum, 95);
  assert.equal(updated.warnings.length, 1);
  await rejects(api.updateDraft(12, changed), { status: 409 });
  await rejects(api.setActiveVersion(1, draft.id), { status: 422 });
  const saved = await api.finalizeVersion(draft.id);
  assert.equal(saved.status, "saved");
  await rejects(api.finalizeVersion(draft.id), { status: 409 });
  const active = await api.setActiveVersion(1, draft.id);
  assert.equal(active.status, "active");
  const after = await api.listChecklists();
  assert.deepEqual(after[0].versions.map((v) => v.status), ["archived", "archived", "draft", "active"]);
  await rejects(api.getChecklistVersion(9999), { status: 404 });
});

test("runs: fixture run progresses, history, new run, retry, drafts rejected", async () => {
  fresh();
  const runs = await api.listRuns();
  assert.deepEqual(runs.map((r) => r.id), ["R-0412", "R-0411", "R-0407", "R-0388"]);
  assert.equal(runs[1].averageTotal, 74.36);
  assert.equal(runs[3].total, 412);
  const first = await api.getRun("R-0412");
  sameKeys(first, RUN_KEYS, "run");
  for (const item of first.items) sameKeys(item, RUN_ITEM_KEYS, item.conversationId);
  assert.deepEqual([first.done, first.running, first.queued, first.failed, first.total], [17, 2, 5, 1, 25]);
  assert.equal(first.status, "running");
  assert.equal(first.items.length, 8);
  assert.equal(first.items[0].total, 81.88);
  assert.equal(first.items[1].otherVersionTotal, 52.63);
  const kz = ROWS.find((r) => r.id === "p1-kz-007");
  assert.equal(first.items[1].total, score(makeConfig(CHAT_CHECKLIST_NAME), { ...kz.answers, "02": "yes" }).total);
  assert.equal(first.items[2].status, "needs_review");
  assert.equal(first.items[3].gross, true);
  assert.equal(first.items[4].error, "Таймаут модели");
  assert.equal(first.cost, 0.068);
  let run = first;
  for (let i = 0; i < 10 && run.status === "running"; i += 1) run = await api.getRun("R-0412");
  assert.equal(run.status, "completed");
  assert.equal(run.done, 24);
  assert.equal(run.failed, 1);
  assert.ok(run.finishedAt);
  assert.equal(run.percent, 100);

  const retried = await api.retryRunItem("R-0412", "p1-ru-019");
  assert.equal(retried.failed, 0);
  assert.equal(retried.status, "running");
  await rejects(api.retryRunItem("R-0412", "p1-ru-001"), { status: 409 });

  await rejects(api.startRun({ groupId: "control", versionId: 13 }), { status: 422, code: "draft_version" });
  await rejects(api.startRun({}), { status: 422, code: "dataset_required" });
  const started = await api.startRun({ groupId: "control", versionId: 12, model: "llm-v3" });
  assert.equal(started.id, "R-0413");
  assert.equal(started.total, 25);
  assert.equal(started.queued, 25);
  assert.equal(started.status, "running");
  const step = await api.getRun("R-0413");
  assert.equal(step.queued, 25);
  const step2 = await api.getRun("R-0413");
  assert.equal(step2.running, 2);
  const selection = await api.startRun({ conversationIds: ["p1-ru-001", "p1-kz-007"], versionId: 12 });
  assert.equal(selection.total, 2);
  assert.equal(selection.items.length, 2);
  assert.equal((await api.listRuns())[0].id, "R-0414");
  await rejects(api.getRun("R-9999"), { status: 404 });
});

test("waveform and audio are mock-only conveniences", async () => {
  fresh();
  const wf = await api.getWaveform("p3-ru-call-014");
  assert.equal(wf.peaks.length, 80);
  assert.equal(wf.durationSeconds, 164);
  assert.equal(api.audioUrl("p3-ru-call-014"), null);
  await rejects(api.getWaveform("p1-ru-001"), { status: 404 });
});

test("state=error rejects every async method with status, code and message", async () => {
  fresh({ state: "error" });
  const calls = [
    () => api.listConversations(),
    () => api.getConversation("p1-ru-001"),
    () => api.getEvaluation("p1-ru-001"),
    () => api.submitAppeal(101, "05", { comment: "x" }),
    () => api.startReview(1),
    () => api.decideAppeal(1, { decision: "confirm", reason: "x" }),
    () => api.listAppeals(),
    () => api.getAppeal(1),
    () => api.appealSummary(),
    () => api.getOverview(),
    () => api.listChecklists(),
    () => api.getChecklistVersion(12),
    () => api.saveChecklistVersion(1, makeConfig("x")),
    () => api.setActiveVersion(1, 12),
    () => api.listDatasets(),
    () => api.importDataset({ groupId: "g" }),
    () => api.startRun({ groupId: "control" }),
    () => api.getRun("R-0412"),
    () => api.listRuns(),
    () => api.listModels(),
    () => api.estimateRun({ count: 1 })
  ];
  for (const call of calls) await rejects(call(), { status: 500, code: "mock_error" });
});

test("state=empty returns empty lists", async () => {
  fresh({ state: "empty" });
  const list = await api.listConversations();
  assert.deepEqual([list.items.length, list.total, list.evaluated], [0, 0, 0]);
  assert.deepEqual(await api.listAppeals(), []);
  assert.equal((await api.appealSummary()).open, 0);
  const o = await api.getOverview();
  assert.equal(o.kpis.evaluatedCount, 0);
  assert.equal(o.attention.length, 0);
  assert.deepEqual(await api.listRuns(), []);
  await rejects(api.getConversation("p1-ru-001"), { status: 404, code: "conversation_not_found" });
});

test("state=slow delays responses", async () => {
  configure({ mock: true, state: "slow", slowMs: 60 });
  const t = Date.now();
  await api.listConversations();
  assert.ok(Date.now() - t >= 55);
});

test("state=loading never settles", async () => {
  fresh({ state: "loading" });
  const outcome = await Promise.race([api.listConversations().then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("pending"), 30))]);
  assert.equal(outcome, "pending");
});

test("state=lowconf makes totals provisional with the number kept", async () => {
  fresh({ state: "lowconf" });
  const ev = await api.getEvaluation("p1-ru-001");
  assert.equal(ev.provisional, true);
  assert.equal(ev.lowConfidence, true);
  assert.equal(ev.confidence.level, "low");
  assert.equal(typeof ev.total, "number");
  assert.notEqual(ev.total, 81.88);
  assert.equal(ev.criteria.find((c) => c.id === "04").needsReview, true);
  const list = await api.listConversations();
  assert.equal(list.items.filter((i) => i.lowConfidence).length, 10);
  assert.equal(list.items.find((i) => i.id === "p1-ru-019").lowConfidence, false);
});

test("operator seam: unset and the single operator give identical results", async () => {
  fresh();
  const base = await api.listConversations();
  const baseAppeals = await api.listAppeals();
  fresh({ operatorId: "operator-a" });
  assert.deepEqual(await api.listConversations(), base);
  assert.deepEqual(await api.listAppeals(), baseAppeals);
  assert.deepEqual(await api.listConversations({ operator: "Оператор A" }), base);
  fresh({ operatorId: "operator-b" });
  assert.equal((await api.listConversations()).items.length, 0);
  assert.equal((await api.listAppeals()).length, 0);
  assert.equal((await api.listConversations({ operator: "operator-a" })).items.length, 11);
});

test("all mock actors are the constants, no personal names in view models", async () => {
  fresh();
  const appeals = await api.listAppeals();
  for (const a of appeals) {
    assert.equal(a.author, "Оператор A");
    if (a.decidedBy) assert.equal(a.decidedBy, "QA / Проверяющий");
  }
  const list = await api.listConversations();
  for (const i of list.items) assert.equal(i.operator, "Оператор A");
  assert.equal((await api.getConversation("p1-ru-001")).operator, "Оператор A");
  const dump = JSON.stringify([appeals, list, await api.getOverview(), await api.listRuns(), await api.getEvaluation("p1-ru-001")]);
  for (const name of ["Сапарова", "Ерлан", "Жумабеков", "Нұржан", "Әбілов", "Ольга Ли", "Марат Ким", "Daniyar", "Омаров"]) assert.ok(!dump.includes(name), name);
});
