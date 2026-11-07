import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configure, api, ApiError } from "../src/api.js";

const dir = new URL("./fixtures/backend_samples/", import.meta.url);
const sample = (name) => JSON.parse(readFileSync(new URL(name + ".json", dir), "utf8"));

const realFetch = globalThis.fetch;

function stub(routes) {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const target = new URL(String(input));
    const method = options.method || "GET";
    calls.push({ method, path: target.pathname, params: Object.fromEntries(target.searchParams), body: options.body ? JSON.parse(options.body) : null });
    const key = method + " " + target.pathname;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ detail: "Not Found", code: "http_404" }), { status: 404 });
    const out = typeof handler === "function" ? handler(target, options) : handler;
    const status = out && out.__status ? out.__status : 200;
    const body = out && out.__status ? out.body : out;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

test("real mode with no backend rejects with code network, not a raw TypeError", async () => {
  configure({ mock: false, baseUrl: "http://127.0.0.1:9/api/v1" });
  const err = await rejects(api.listConversations(), { status: 0, code: "network" });
  assert.ok(err instanceof ApiError);
  assert.ok(!(err instanceof TypeError));
});

test("error bodies become status, code and message", async () => {
  stub({ "GET /api/v1/appeals/summary": { __status: 409, body: sample("error_body") } });
  real();
  await rejects(api.appealSummary(), { status: 409, code: "appeal_open_exists", message: "An open appeal already exists for this criterion" });
});

test("error without a code falls back to http_<status>", async () => {
  stub({ "GET /api/v1/appeals/summary": { __status: 500, body: { detail: "boom" } } });
  real();
  await rejects(api.appealSummary(), { status: 500, code: "http_500", message: "boom" });
});

test("gaps throw explicit not-implemented errors with the gap id", async () => {
  real();
  await rejects(api.listModels(), { status: 501, code: "not_implemented", gap: "BG-18", message: "BG-18 not implemented" });
  await rejects(api.estimateRun({ count: 1 }), { gap: "BG-18" });
  await rejects(api.retryRunItem("R-0001", "x"), { gap: "BG-19", message: "BG-19 not implemented" });
  await rejects(api.getWaveform("1"), { gap: "BG-30", message: "BG-30 not implemented" });
});

test("listConversations sends filters, envelope and the operator seam", async () => {
  const calls = stub({ "GET /api/v1/conversations": sample("conversations_envelope") });
  real({ operatorId: "operator-a" });
  const out = await api.listConversations({ language: "RU", channel: "chat", versionId: 1, q: "p1", sort: "-total", limit: 10, offset: 20 });
  assert.equal(out.items.length, 3);
  assert.deepEqual(calls[0].params, {
    language: "RU",
    channel: "agent chat",
    checklist_version_id: "1",
    q: "p1",
    sort: "-final_total",
    limit: "10",
    offset: "20",
    envelope: "1",
    operator: "operator-a"
  });
  real();
  await api.listConversations();
  assert.equal(calls[1].params.operator, undefined);
  await api.listConversations({ operator: "other" });
  assert.equal(calls[2].params.operator, "other");
});

test("listConversations with display appeal status filters client side", async () => {
  const items = sample("conversations_envelope");
  const calls = stub({ "GET /api/v1/conversations": items });
  real();
  const out = await api.listConversations({ appealStatus: "changed", limit: 1 });
  assert.equal(calls[0].params.appeal_status, "resolved");
  assert.equal(calls[0].params.limit, undefined);
  assert.ok(out.items.every((i) => i.appealStatus === "changed"));
});

test("listAppeals sends the operator seam and sorts oldest first", async () => {
  const calls = stub({ "GET /api/v1/appeals": sample("appeals_queue").slice().reverse() });
  real({ operatorId: "operator-a" });
  const out = await api.listAppeals({ status: "open" });
  assert.deepEqual(calls[0].params, { status: "open", operator: "operator-a" });
  assert.deepEqual(out.map((a) => a.id), [1, 2, 3]);
});

test("getConversation resolves external ids through by-key and never exposes audio_url", async () => {
  const calls = stub({
    "GET /api/v1/conversations/by-key/p4-ru-003": sample("conversation_call"),
    "GET /api/v1/conversations/1": sample("conversation_chat")
  });
  real();
  const call = await api.getConversation("p4-ru-003", { dataset: "DEV" });
  assert.equal(calls[0].params.dataset, "DEV");
  assert.equal(call.hasAudio, true);
  assert.ok(!JSON.stringify(call).includes("redacted"));
  const chat = await api.getConversation(1);
  assert.equal(chat.id, "p1-ru-001");
  assert.equal(api.audioUrl("p4-ru-003"), "http://backend.test/api/v1/conversations/" + sample("conversation_call").id + "/audio");
  assert.equal(api.audioUrl(7, "proxy"), "http://backend.test/api/v1/conversations/7/audio?mode=proxy");
});

test("getEvaluation fetches the latest evaluation and the checklist version", async () => {
  const calls = stub({
    "GET /api/v1/conversations/by-key/p1-ru-001": sample("conversation_chat"),
    "GET /api/v1/conversations/1/evaluation": sample("evaluation_with_review"),
    "GET /api/v1/checklist-versions/1": sample("checklist_version")
  });
  real();
  const ev = await api.getEvaluation("p1-ru-001", 1);
  assert.equal(ev.total, 100);
  assert.equal(ev.originalTotal, 92.31);
  assert.equal(ev.versionLabel, "v1");
  assert.equal(calls.find((c) => c.path.endsWith("/evaluation")).params.checklist_version_id, "1");
  await api.getEvaluation("p1-ru-001");
  assert.equal(calls.filter((c) => c.path.includes("checklist-versions")).length, 1);
});

test("appeal actions use the operator and reviewer wire roles", async () => {
  const base = sample("appeal_decision");
  const calls = stub({
    "POST /api/v1/evaluations/4/appeals": { ...base, status: "open", decision: null, display_status: "new" },
    "POST /api/v1/appeals/3/start-review": { ...base, status: "open", display_status: "under_review" },
    "POST /api/v1/appeals/3/decision": base
  });
  real();
  const created = await api.submitAppeal(4, "07", { comment: "почему", refs: [{ index: 10 }, 11] });
  assert.deepEqual(calls[0].body, { criterion_id: "07", comment: "почему", role: "operator", message_refs: [10, 11] });
  assert.equal(created.status, "new");
  const review = await api.startReview(3);
  assert.deepEqual(calls[1].body, { role: "reviewer" });
  assert.equal(review.status, "under_review");
  const decided = await api.decideAppeal(3, { decision: "change", newAnswer: 20, reason: "верно" });
  assert.deepEqual(calls[2].body, { decision: "change", new_answer: "20", reason: "верно", role: "reviewer" });
  assert.equal(decided.status, "changed");
  await api.decideAppeal(3, { decision: "confirm", reason: "верно" });
  assert.equal(calls[3].body.new_answer, null);
});

test("overview, checklists, versions and datasets use the existing endpoints", async () => {
  const calls = stub({
    "GET /api/v1/stats/overview": sample("overview"),
    "GET /api/v1/checklists": sample("checklists"),
    "GET /api/v1/datasets": sample("datasets"),
    "POST /api/v1/checklists/1/versions": sample("checklist_version"),
    "PUT /api/v1/checklist-versions/2": sample("checklist_version"),
    "POST /api/v1/checklist-versions/2/save": sample("checklist_version"),
    "PUT /api/v1/checklists/1/default": sample("checklist_version"),
    "POST /api/v1/datasets/import": { dataset_id: 1, group_id: "DEV", source: "api", created: 0, updated: 65, total_conversations: 65 }
  });
  real();
  const o = await api.getOverview({ dataset: "DEV", versionId: 1, channel: "call", language: "RU" });
  assert.deepEqual(calls[0].params, { dataset: "DEV", checklist_version_id: "1", language: "RU", channel: "voice call" });
  assert.equal(o.kpis.evaluatedCount, 65);
  assert.equal((await api.listChecklists())[0].versions[0].label, "v1");
  assert.equal((await api.listDatasets())[0].groupId, "DEV");
  const cfg = sample("checklist_version").config;
  await api.saveChecklistVersion(1, cfg, { status: "draft" });
  assert.equal(calls.find((c) => c.method === "POST" && c.path.endsWith("/versions")).params.status, "draft");
  await api.updateDraft(2, cfg);
  await api.finalizeVersion(2);
  await api.setActiveVersion(1, 2);
  assert.deepEqual(calls.find((c) => c.path.endsWith("/default")).body, { version_id: 2 });
  const imported = await api.importDataset({ groupId: "DEV" });
  assert.equal(imported.groupId, "DEV");
  assert.equal(imported.updated, 65);
});

test("runs use /runs and map the persisted run payload", async () => {
  const run = sample("run");
  const calls = stub({
    "POST /api/v1/runs": sample("batch_snapshot"),
    "GET /api/v1/runs/412": run,
    "GET /api/v1/runs": [run],
    "GET /api/v1/conversations/by-key/p1-ru-001": sample("conversation_chat")
  });
  real();
  const started = await api.startRun({ groupId: "DEV", versionId: 1, force: true });
  assert.deepEqual(calls[0].body, { dataset: "DEV", checklist_version_id: 1, force: true });
  assert.equal(started.id, "R-0412");
  const got = await api.getRun("R-0412", { limit: 8 });
  assert.equal(got.items.length, 2);
  assert.equal(calls.find((c) => c.path.endsWith("/runs/412")).params.limit, "8");
  assert.equal((await api.listRuns())[0].id, "R-0412");
  await api.startRun({ conversationIds: ["p1-ru-001", 5], versionId: 1 });
  const last = calls.filter((c) => c.method === "POST").pop();
  assert.deepEqual(last.body.conversation_pks, [1, 5]);
  assert.equal(last.body.dataset, undefined);
});
