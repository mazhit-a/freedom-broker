import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configure, api } from "../src/api.js";
import { mapConversation, mapEvaluation, mapAppeal, mapAppealList, mapVersion } from "../src/mappers.js";
import { score } from "../src/scoring.js";
import { errorText, previewTotals } from "../src/components/appeal-model.js";
import { t } from "../src/i18n/index.js";
import { wireRole } from "../src/roles.js";

const dir = new URL("./fixtures/backend_samples/", import.meta.url);
const sample = (name) => JSON.parse(readFileSync(new URL("real_card_" + name + ".json", dir), "utf8"));
const realFetch = globalThis.fetch;

function stub(routes) {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const target = new URL(String(input));
    const method = options.method || "GET";
    calls.push({ method, path: target.pathname, params: Object.fromEntries(target.searchParams), body: options.body ? JSON.parse(options.body) : null });
    const handler = routes[method + " " + target.pathname];
    if (!handler) return new Response(JSON.stringify({ detail: "Not Found", code: "http_404" }), { status: 404 });
    const out = typeof handler === "function" ? handler(target, options) : handler;
    const status = out && out.__status ? out.__status : 200;
    return new Response(JSON.stringify(out && out.__status ? out.body : out), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

function real(options = {}) {
  configure({ mock: false, baseUrl: "http://backend.test/api/v1", ...options });
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

async function rejects(promise, expected) {
  try {
    await promise;
  } catch (err) {
    for (const [k, v] of Object.entries(expected)) assert.equal(err[k], v, k);
    return err;
  }
  return assert.fail("expected a rejection");
}

const version = () => mapVersion(sample("version"));

test("chat conversation: indexes stay 0-based, display numbers are 1-based, no recording url", () => {
  const raw = sample("conversation_chat");
  const conv = mapConversation(raw);
  assert.equal(conv.id, "p1-ru-001");
  assert.equal(conv.messages[0].index, 0);
  assert.equal(conv.messages[0].n, 1);
  assert.equal(conv.messages[9].n, 10);
  assert.equal(conv.hasAudio, false);
  assert.equal(conv.messages[1].time, "00:02");
  assert.ok(!/audio_url|sig=/.test(JSON.stringify(conv)));
});

test("call conversation: audio_start_seconds map to audioStart and the ISO clock is shortened", () => {
  const raw = sample("conversation_call");
  const conv = mapConversation(raw);
  assert.equal(conv.hasAudio, true);
  assert.equal(conv.durationSeconds, raw.duration_seconds);
  assert.ok(conv.occurredAt);
  const timed = conv.messages.filter((m) => m.audioStart !== null);
  assert.equal(timed.length, raw.messages.filter((m) => m.audio_start_seconds !== undefined && m.audio_start_seconds !== null).length);
  conv.messages.forEach((m, i) => {
    assert.equal(m.audioStart, raw.messages[i].audio_start_seconds ?? null);
    assert.match(m.time, /^\d\d:\d\d:\d\d$/);
  });
  assert.ok(!/audio_url|sig=|filedownload/.test(JSON.stringify(conv)));
});

test("chat evaluation: total, sections, N/A, ranges and evidence come from the payload", () => {
  const raw = sample("evaluation_chat");
  const ev = mapEvaluation(raw, version());
  assert.equal(ev.total, raw.final_total);
  assert.equal(ev.originalTotal, raw.total);
  assert.equal(ev.totalChanged, false);
  assert.equal(ev.confidence.level, "high");
  assert.equal(ev.lowConfidence, false);
  assert.equal(ev.versionLabel, "v1");
  assert.equal(ev.sections.filter((s) => s.id !== "gross").length, 3);
  const sum = ev.sections.filter((s) => s.id !== "gross").reduce((acc, s) => acc + s.effectivePoints, 0);
  assert.ok(Math.abs(sum - ev.total) < 0.05);
  const na = ev.criteria.find((c) => c.answer === "na");
  assert.ok(na.naReason);
  assert.equal(na.points, null);
  const ranged = ev.criteria.find((c) => c.expected);
  assert.equal(ranged.expected.fromN, ranged.expected.from + 1);
  const withEvidence = ev.criteria.find((c) => c.evidence.length);
  assert.equal(withEvidence.evidence[0].n, withEvidence.evidence[0].index + 1);
});

test("scoring.js reproduces the backend final total and effective points for every payload", () => {
  for (const name of ["evaluation_chat", "evaluation_call", "evaluation_changed", "evaluation_open_appeal"]) {
    const raw = sample(name);
    const ev = mapEvaluation(raw, version());
    const answers = Object.fromEntries(ev.criteria.map((c) => [c.id, c.answer]));
    const result = score(ev.config, answers);
    assert.equal(result.total, raw.final.total, name);
    for (const c of raw.final.criteria) {
      const mine = result.criteria.find((x) => x.id === c.criterion_id);
      assert.equal(mine.effectivePoints ?? null, c.effective_points, `${name} ${c.criterion_id}`);
    }
    for (const s of raw.final.sections.filter((x) => x.id !== "gross")) {
      const ledger = ev.sections.find((x) => x.id === s.id);
      assert.equal(ledger.effectivePoints, s.effective_points);
    }
  }
});

test("after a changed appeal the card total is final, the original is kept and the criterion is overridden", () => {
  const raw = sample("evaluation_changed");
  const ev = mapEvaluation(raw, version());
  const changed = sample("appeal_changed");
  assert.equal(ev.total, raw.final_total);
  assert.equal(ev.originalTotal, raw.total);
  assert.notEqual(ev.total, ev.originalTotal);
  assert.equal(ev.totalChanged, true);
  assert.equal(ev.appealStatus, "changed");
  const crit = ev.criteria.find((c) => c.id === changed.criterion_id);
  assert.equal(crit.overridden, true);
  assert.equal(crit.answer, "yes");
  assert.notEqual(crit.originalAnswer, "yes");
  assert.equal(crit.appeal.status, "changed");
  assert.equal(changed.total_before, ev.originalTotal);
  assert.equal(changed.total_after, ev.total);
  const appeal = ev.appeals.find((a) => a.id === changed.id);
  assert.equal(appeal.totalBefore, changed.total_before);
  assert.equal(appeal.totalAfter, changed.total_after);
  assert.equal(appeal.decidedBy, "QA / Проверяющий");
});

test("provisional evaluation without a computable total keeps the not-calculated state and low confidence", () => {
  const raw = sample("evaluation_provisional");
  const ev = mapEvaluation(raw, version());
  assert.equal(ev.total, null);
  assert.equal(ev.calculated, false);
  assert.equal(ev.provisional, true);
  assert.equal(ev.lowConfidence, true);
  assert.equal(ev.confidence.level, "low");
  assert.ok(ev.criteria.some((c) => c.needsReview));
});

test("a new appeal keeps 0-based refs, wire roles and the new status; review moves it to under_review", () => {
  const created = mapAppeal(sample("appeal_new"));
  assert.deepEqual(created.refs, [{ index: 0, n: 1 }, { index: 2, n: 3 }]);
  assert.equal(created.status, "new");
  assert.equal(created.open, true);
  assert.equal(created.authorRole, "operator");
  assert.equal(created.author, "Оператор A");
  assert.equal(created.decidedBy, null);
  const review = mapAppeal(sample("appeal_review"));
  assert.equal(review.status, "under_review");
  assert.ok(review.reviewStartedAt);
});

test("legacy decisions without stored totals or roles map without placeholders", () => {
  const list = mapAppealList(sample("appeals_legacy"));
  assert.ok(list.length > 0);
  for (const a of list) {
    assert.equal(a.totalBefore, null);
    assert.equal(a.totalAfter, null);
    assert.equal(a.decidedBy, "QA / Проверяющий");
    assert.ok(["confirmed", "changed"].includes(a.status));
  }
});

test("queue payload carries criterion, original answer, evidence and a fragment around the checked range", () => {
  const list = mapAppealList(sample("queue_open"));
  assert.ok(list.length > 0);
  for (const a of list) {
    assert.ok(a.criterionTitle);
    assert.ok(a.original);
    assert.ok(a.fragment.length > 0);
    assert.ok(a.versionLabel);
    assert.ok(a.ageHours !== null);
    assert.ok(a.fragment.every((m) => m.n === m.index + 1));
  }
});

test("previewTotals agrees with the backend recomputation of the changed appeal", () => {
  const open = mapEvaluation(sample("evaluation_open_appeal"), version());
  const changed = sample("appeal_changed");
  const preview = previewTotals(open, changed.criterion_id, "change", "yes");
  assert.equal(preview.before, changed.total_before);
  assert.equal(preview.after, changed.total_after);
  const same = previewTotals(open, changed.criterion_id, "confirm", null);
  assert.equal(same.after, same.before);
});

test("submitAppeal sends the operator role and 0-based refs; the role can be overridden", async () => {
  const calls = stub({ "POST /api/v1/evaluations/4/appeals": sample("appeal_new") });
  real();
  const out = await api.submitAppeal(4, "07", { comment: "c", refs: [{ index: 0 }, 2] });
  assert.deepEqual(calls[0].body, { criterion_id: "07", comment: "c", role: "operator", message_refs: [0, 2] });
  assert.equal(out.status, "new");
  await api.submitAppeal(4, "07", { comment: "c", refs: [], role: wireRole("reviewer") });
  assert.equal(calls[1].body.role, "reviewer");
  await api.submitAppeal(4, "07", { comment: "c", refs: [], role: wireRole("exec") });
  assert.equal(calls[2].body.role, null);
  assert.ok(calls.every((c) => c.body.role !== "qa"));
});

test("startReview and decideAppeal send reviewer by default and the totals come back mapped", async () => {
  const calls = stub({
    "POST /api/v1/appeals/9/start-review": sample("appeal_review"),
    "POST /api/v1/appeals/9/decision": sample("appeal_changed")
  });
  real();
  await api.startReview(9);
  assert.deepEqual(calls[0].body, { role: "reviewer" });
  const out = await api.decideAppeal(9, { decision: "change", newAnswer: "yes", reason: "r" });
  assert.deepEqual(calls[1].body, { decision: "change", new_answer: "yes", reason: "r", role: "reviewer" });
  assert.equal(out.totalBefore, sample("appeal_changed").total_before);
  assert.equal(out.status, "changed");
  await api.decideAppeal(9, { decision: "confirm", reason: "r" });
  assert.equal(calls[2].body.new_answer, null);
});

test("server error codes arrive as ApiError.code and map to localised texts in ru, kk and en", async () => {
  const cases = [
    ["POST /api/v1/evaluations/4/appeals", sample("err_exists"), 409, "appeal_open_exists", "appeal"],
    ["POST /api/v1/evaluations/5/appeals", sample("err_ref"), 422, "invalid_message_ref", "appeal"],
    ["POST /api/v1/appeals/9/decision", sample("err_role"), 403, "role_forbidden", "review"],
    ["POST /api/v1/appeals/10/decision", sample("err_reason"), 422, "reason_required", "review"]
  ];
  for (const [route, body, status, code, prefix] of cases) {
    stub({ [route]: { __status: status, body } });
    real();
    const path = route.split(" ")[1];
    const err = await rejects(
      path.includes("appeals/") && path.endsWith("decision") ? api.decideAppeal(Number(path.split("/")[4]), { decision: "confirm", reason: "x" }) : api.submitAppeal(Number(path.split("/")[4]), "07", { comment: "c", refs: [] }),
      { status, code }
    );
    for (const locale of ["ru", "kk", "en"]) {
      const text = errorText(prefix, err, locale, (key) => t(key, {}, locale));
      assert.notEqual(text, t(`${prefix}.err.generic`, {}, locale), `${code} ${locale}`);
    }
  }
});

test("deep links by external id use by-key and audio goes through the backend endpoint only", async () => {
  const conv = sample("conversation_call");
  const calls = stub({
    "GET /api/v1/conversations/by-key/p4-ru-005": conv,
    [`GET /api/v1/conversations/${conv.id}/evaluation`]: sample("evaluation_call"),
    "GET /api/v1/checklist-versions/1": sample("version")
  });
  real();
  const c = await api.getConversation("p4-ru-005", { dataset: "DEV" });
  assert.equal(calls[0].path, ["", "api", "v1", "conversations", "by-key", "p4-ru-005"].join("/"));
  assert.equal(calls[0].params.dataset, "DEV");
  assert.equal(c.pk, conv.id);
  assert.equal(api.audioUrl("p4-ru-005"), `http://backend.test/api/v1/conversations/${conv.id}/audio`);
  assert.equal(api.audioUrl("p4-ru-005", "proxy"), `http://backend.test/api/v1/conversations/${conv.id}/audio?mode=proxy`);
  const ev = await api.getEvaluation("p4-ru-005");
  assert.equal(ev.total, sample("evaluation_call").final_total);
  assert.equal(calls.filter((x) => x.path.includes("by-key")).length, 1);
});

test("the operator seam is sent to appeals and ignored when absent", async () => {
  const calls = stub({ "GET /api/v1/appeals": sample("queue_open"), "GET /api/v1/appeals/summary": sample("summary_open") });
  real({ operatorId: "op-7" });
  await api.listAppeals({ status: "open" });
  assert.equal(calls[0].params.operator, "op-7");
  real();
  await api.listAppeals({ status: "open" });
  assert.equal(calls[1].params.operator, undefined);
  const s = await api.appealSummary();
  assert.equal(typeof s.open, "number");
});

const LIVE = process.env.CQA_LIVE_BASE;

test("live: the UI total equals the backend final total for every evaluated conversation", { skip: LIVE ? false : "set CQA_LIVE_BASE to a server started on a COPY of cqa.db" }, async () => {
  globalThis.fetch = realFetch;
  configure({ mock: false, baseUrl: LIVE });
  const list = await api.listConversations({ limit: 500 });
  assert.ok(list.items.length >= 65);
  let checked = 0;
  for (const item of list.items) {
    if (!item.evaluated || item.failed) continue;
    const raw = await (await fetch(LIVE.replace(/\/+$/, "") + "/conversations/" + item.pk + "/evaluation")).json();
    const ev = await api.getEvaluation(item.pk);
    assert.equal(ev.total, raw.final_total, item.id);
    assert.equal(ev.originalTotal, raw.total, item.id);
    const result = score(ev.config, Object.fromEntries(ev.criteria.map((c) => [c.id, c.answer])));
    assert.equal(result.total, raw.final ? raw.final.total : null, `${item.id} scoring.js vs backend`);
    if (raw.final) for (const s of raw.final.sections.filter((x) => x.id !== "gross")) assert.equal(ev.sections.find((x) => x.id === s.id).effectivePoints, s.effective_points, `${item.id} ${s.id}`);
    checked += 1;
  }
  assert.ok(checked >= 63, `checked ${checked}`);
});
