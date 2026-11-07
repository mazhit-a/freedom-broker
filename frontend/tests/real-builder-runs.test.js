import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configure, api } from "../src/api.js";
import { mapRun, mapChecklists, mapVersion } from "../src/mappers.js";
import { progressSegments, itemKind, queuedCount, savedVersionOptions, errorKey } from "../src/components/cqa-eval-runs-model.js";
import { createDraft, toConfig } from "../src/components/builder-model.js";

const dir = new URL("./fixtures/backend_samples/", import.meta.url);
const sample = (name) => JSON.parse(readFileSync(new URL("real_" + name + ".json", dir), "utf8"));
const realFetch = globalThis.fetch;

function stub(routes) {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const target = new URL(String(input));
    const method = options.method || "GET";
    calls.push({ method, path: target.pathname, query: target.search, params: Object.fromEntries(target.searchParams), body: options.body ? JSON.parse(options.body) : null });
    const handler = routes[method + " " + target.pathname];
    if (!handler) return new Response(JSON.stringify({ detail: "Not Found", code: "http_404" }), { status: 404 });
    const out = typeof handler === "function" ? handler(target, options) : handler;
    const status = out && out.__status ? out.__status : 200;
    return new Response(JSON.stringify(out && out.__status ? out.body : out), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

function real() {
  configure({ mock: false, baseUrl: "http://backend.test/api/v1" });
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

test("checklists payload: statuses, labels vN, applied counts and channel binding are exposed", () => {
  const lists = mapChecklists(sample("checklists"));
  const c = lists[0];
  assert.deepEqual(c.channels, []);
  assert.deepEqual(c.versions.map((v) => [v.label, v.status, v.isDefault, v.locked]), [["v1", "archived", false, true], ["v2", "active", true, true], ["v3", "draft", false, false]]);
  assert.equal(c.defaultVersionId, 2);
  assert.equal(c.versions[0].appliedCount, 65);
  assert.equal(c.versions[1].appliedCount, 0);
  assert.equal(c.versions[1].weightSum, 100);
  assert.deepEqual(savedVersionOptions(lists).map((v) => v.id), [1, 2]);
});

test("draft version payload maps to an unlocked draft and finalize to a locked saved version", () => {
  const draft = mapVersion(sample("draft3"));
  assert.equal(draft.status, "draft");
  assert.equal(draft.locked, false);
  assert.equal(draft.label, "v3");
  const saved = mapVersion(sample("finalize"));
  assert.equal([saved.status, saved.locked, saved.version].join("|"), "saved|true|2");
  assert.deepEqual(saved.warnings, []);
});

test("builder draft built from a real version round-trips through toConfig without losing fields", () => {
  const version = mapVersion(sample("finalize"));
  const draft = createDraft(version.config, version.config, { checklistId: 1, versionId: version.id, versionNumber: version.version, baseNumber: 1 }, "ru");
  const config = toConfig(draft);
  assert.equal(config.criteria.length, version.config.criteria.length);
  for (const [i, c] of version.config.criteria.entries()) {
    const out = config.criteria[i];
    assert.equal(out.id, c.id);
    assert.equal(out.title, c.title);
    assert.equal(out.weight, c.weight);
    assert.equal(out.type, c.type);
    assert.equal(out.na_allowed, c.na_allowed);
    assert.equal(out.section, c.section);
  }
  assert.deepEqual(config.sections, version.config.sections);
});

test("save paths send the documented requests", async () => {
  const cfg = mapVersion(sample("finalize")).config;
  const calls = stub({
    "POST /api/v1/checklists/1/versions": sample("draft3"),
    "PUT /api/v1/checklist-versions/3": sample("put_draft"),
    "POST /api/v1/checklist-versions/3/save": sample("finalize"),
    "PUT /api/v1/checklists/1/default": sample("finalize")
  });
  real();
  const draft = await api.saveChecklistVersion(1, cfg, { status: "draft" });
  assert.equal(calls[0].params.status, "draft");
  assert.equal(draft.status, "draft");
  const saved = await api.saveChecklistVersion(1, cfg);
  assert.equal(calls[1].params.status, "saved");
  assert.equal(saved.version, 3);
  await api.updateDraft(3, cfg);
  assert.equal(calls[2].method, "PUT");
  await api.finalizeVersion(3);
  assert.ok(calls[3].path.endsWith("/checklist-versions/3/save"));
  await api.setActiveVersion(1, 2);
  assert.deepEqual(calls[4].body, { version_id: 2 });
});

test("channels are sent as wire strings and the bound checklist comes back", async () => {
  const calls = stub({ "PUT /api/v1/checklists/1/channels": sample("channels_put") });
  real();
  const out = await api.setChecklistChannels(1, ["chat", "voice call"]);
  assert.deepEqual(calls[0].body, { channels: ["agent chat", "voice call"] });
  assert.deepEqual(out.channels, ["agent chat", "voice call"]);
});

test("a 422 validation list becomes one message and http_422", async () => {
  stub({ "POST /api/v1/checklists/1/versions": { __status: 422, body: sample("e_dup") } });
  real();
  const err = await rejects(api.saveChecklistVersion(1, {}), { status: 422, code: "http_422" });
  assert.match(err.message, /duplicate criterion ids: 01/);
});

test("editing a saved version returns 409 with the server text", async () => {
  stub({ "PUT /api/v1/checklist-versions/2": { __status: 409, body: sample("e_immutable") } });
  real();
  await rejects(api.updateDraft(2, {}), { status: 409, code: "http_409", message: "checklist version 2 is saved and immutable" });
});

test("models and estimate map price, source and count x mean", async () => {
  const calls = stub({
    "GET /api/v1/models": sample("models"),
    "GET /api/v1/runs/estimate": (url) => (url.searchParams.get("force") === "true" ? sample("est_force") : url.searchParams.getAll("conversation_pks").length ? sample("est_pks") : sample("estimate"))
  });
  real();
  const models = await api.listModels();
  assert.equal(models[0].id, "claude-opus-5-5");
  assert.equal(models[0].paid, true);
  assert.equal(models[0].pricePerEvaluation, 0.032558);
  assert.equal(models[0].priceSource, "history");
  const est = await api.estimateRun({ groupId: "DEV", versionId: 2, model: "claude-opus-5-5" });
  assert.deepEqual([est.count, est.total, est.skipped], [65, 65, 0]);
  assert.equal(est.cost, 2.1163);
  assert.ok(Math.abs(est.cost - est.count * est.pricePerEvaluation) < 0.0001);
  assert.equal(calls[calls.length - 1].params.checklist_version_id, "2");
  assert.equal(calls[calls.length - 1].params.dataset, "DEV");
  const forced = await api.estimateRun({ groupId: "DEV", versionId: 2, force: true });
  assert.equal(forced.count, 65);
});

test("estimate for a conversation selection resolves pks and repeats the query parameter", async () => {
  const calls = stub({ "GET /api/v1/runs/estimate": sample("est_pks") });
  real();
  const est = await api.estimateRun({ conversationIds: [1, 2], versionId: 2 });
  assert.deepEqual(calls[0].query.match(/conversation_pks=\d+/g), ["conversation_pks=1", "conversation_pks=2"]);
  assert.equal(est.count, 2);
  assert.equal(est.cost, 0.0651);
});

test("estimate for an uploaded file is count x the measured model price without a dataset request", async () => {
  const calls = stub({ "GET /api/v1/models": sample("models") });
  real();
  const est = await api.estimateRun({ count: 25 });
  assert.equal(calls.length, 1);
  assert.equal(est.count, 25);
  assert.equal(est.cost, Math.round(25 * 0.032558 * 10000) / 10000);
});

test("estimate errors carry the nested detail code and message", async () => {
  stub({ "GET /api/v1/runs/estimate": { __status: 422, body: { detail: { code: "unknown_model", message: "Unknown model zz" }, code: "http_422" } } });
  real();
  await rejects(api.estimateRun({ groupId: "DEV", model: "zz" }), { status: 422, code: "unknown_model", message: "Unknown model zz" });
});

test("startRun sends the model and maps the 202 snapshot and the persisted run", async () => {
  const calls = stub({ "GET /api/v1/datasets": [{ id: 1, group_id: "DEV", label: "DEV", kind: "dev", conversations: 65 }], "POST /api/v1/runs": sample("start_resp") });
  real();
  const run = await api.startRun({ groupId: "DEV", versionId: 2, model: "claude-opus-5-5", force: false });
  assert.deepEqual(calls[calls.length - 1].body, { dataset: "DEV", checklist_version_id: 2, force: false, model: "claude-opus-5-5" });
  assert.equal(run.id, "R-0002");
  assert.equal(run.status, "running");
  assert.equal(run.checklistLabel, null);
  assert.deepEqual(progressSegments(run), { max: 1, now: 0, done: 0, failed: 0, running: 0 });
});

test("startRun maps the draft and missing-dataset 422 strings to stable codes", async () => {
  stub({ "GET /api/v1/datasets": [{ id: 1, group_id: "DEV", label: "DEV", kind: "dev", conversations: 65 }], "POST /api/v1/runs": { __status: 422, body: sample("e_draft") } });
  real();
  await rejects(api.startRun({ groupId: "DEV", versionId: 3 }), { status: 422, code: "draft_version" });
  stub({ "POST /api/v1/runs": { __status: 422, body: { detail: "dataset or conversation_pks is required", code: "http_422" } } });
  await rejects(api.startRun({ versionId: 2 }), { status: 422, code: "dataset_required" });
  stub({ "GET /api/v1/datasets": [{ id: 1, group_id: "DEV", label: "DEV", kind: "dev", conversations: 65 }], "POST /api/v1/runs": { __status: 422, body: { detail: { code: "unknown_model", message: "Unknown model x" }, code: "http_422" } } });
  await rejects(api.startRun({ groupId: "DEV", model: "x" }), { status: 422, code: "unknown_model" });
  assert.equal(errorKey({ code: "unknown_model" }), "unknown_model");
});

test("a finished run whose items all failed keeps the failures, cost and version label", () => {
  const run = mapRun(sample("run_failed"));
  assert.equal(run.id, "R-0001");
  assert.equal(run.status, "completed");
  assert.equal(run.versionLabel, "v2");
  assert.deepEqual([run.total, run.done, run.failed, run.running, run.queued], [2, 0, 2, 0, 0]);
  assert.equal(run.cost, 0.00056);
  assert.equal(run.items.length, 2);
  assert.equal(run.items[0].conversationId, "p1-ru-001");
  assert.equal(run.items[0].conversationPk, 1);
  assert.equal(run.items[0].channel, "chat");
  assert.equal(run.items[0].otherVersionTotal, 92.31);
  assert.equal(itemKind(run.items[0]), "failed");
  assert.equal(queuedCount(run), 0);
  assert.equal(run.itemsTotal, 2);
  assert.deepEqual(progressSegments(run), { max: 2, now: 2, done: 0, failed: 100, running: 0 });
});

test("getRun and listRuns use the numeric id and paging", async () => {
  const calls = stub({ "GET /api/v1/runs/1": sample("run_failed"), "GET /api/v1/runs": sample("runs") });
  real();
  const got = await api.getRun("R-0001", { limit: 25, offset: 0 });
  assert.ok(calls[0].path.endsWith("/runs/1"));
  assert.equal(calls[0].params.limit, "25");
  assert.equal(got.items.length, 2);
  const list = await api.listRuns({ limit: 50 });
  assert.equal(list.length, sample("runs").length);
  assert.ok(list.every((r) => /^R-\d{4}$/.test(r.id)));
});

test("retryRunItem finds the pk from the run, posts the retry and returns the refreshed run", async () => {
  const calls = stub({
    "GET /api/v1/runs/1": sample("run_failed"),
    "POST /api/v1/runs/1/items/1/retry": sample("retry_resp")
  });
  real();
  const run = await api.retryRunItem("R-0001", "p1-ru-001");
  assert.deepEqual(calls.map((c) => c.method + " " + c.path), ["GET /api/v1/runs/1", "POST /api/v1/runs/1/items/1/retry", "GET /api/v1/runs/1"]);
  assert.equal(run.items.length, 2);
  await rejects(api.retryRunItem("R-0001", "nope"), { status: 404, code: "item_not_found" });
});

test("retry on a non-failed item surfaces the nested 409 code", async () => {
  stub({
    "GET /api/v1/runs/1": sample("run_failed"),
    "POST /api/v1/runs/1/items/1/retry": { __status: 409, body: { detail: { code: "item_not_failed", message: "Only failed items can be retried" }, code: "http_409" } }
  });
  real();
  await rejects(api.retryRunItem(1, "p1-ru-001"), { status: 409, code: "item_not_failed", message: "Only failed items can be retried" });
});

test("an organisers failure is reported as source_failure with the server text", async () => {
  stub({ "POST /api/v1/datasets/import": { __status: 502, body: { detail: "Data source error: по данному group_id:zzz данные не найдены", code: "http_502" } } });
  real();
  const err = await rejects(api.importDataset({ groupId: "zzz" }), { status: 502 });
  assert.match(err.message, /zzz/);
  stub({ "POST /api/v1/datasets/import": { isSuccess: false, error: "нет данных" } });
  await rejects(api.importDataset({ groupId: "zzz" }), { code: "source_failure", message: "нет данных" });
});

test("startRun imports an unknown group_id first and then starts the run on it", async () => {
  const calls = stub({
    "GET /api/v1/datasets": [{ id: 1, group_id: "DEV", label: "DEV", kind: "dev", conversations: 65 }],
    "POST /api/v1/datasets/import": { dataset_id: 2, group_id: "G2", source: "api", created: 10, updated: 0, total_conversations: 10 },
    "POST /api/v1/runs": sample("start_resp")
  });
  real();
  await api.startRun({ groupId: "G2", versionId: 2 });
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => c.path.replace(/^.*\/v1/, "")), ["/datasets/import", "/runs"]);
  assert.equal(calls[calls.length - 1].body.dataset, "G2");
});

test("startRun on a known group does not import and a 502 from the organisers maps to source_failure", async () => {
  const calls = stub({
    "GET /api/v1/datasets": [{ id: 1, group_id: "DEV", label: "DEV", kind: "dev", conversations: 65 }],
    "POST /api/v1/runs": sample("start_resp")
  });
  real();
  await api.startRun({ groupId: "DEV", versionId: 2 });
  assert.ok(!calls.some((c) => c.path.endsWith("/datasets/import")));
  stub({
    "GET /api/v1/datasets": [],
    "POST /api/v1/datasets/import": { __status: 502, body: { detail: "Data source error: нет данных", code: "http_502" } }
  });
  const err = await rejects(api.startRun({ groupId: "zzz", versionId: 2 }), { status: 502 });
  assert.equal(errorKey(err), "source_failure");
  assert.match(err.message, /нет данных/);
});

test("real scale steps stored from the top down are shown ascending and the draft is valid", async () => {
  const { validate } = await import("../src/components/builder-validate.js");
  const version = mapVersion(sample("finalize"));
  const draft = createDraft(version.config, version.config, { checklistId: 1, versionId: version.id, versionNumber: version.version, baseNumber: 1 }, "ru");
  const scale = draft.criteria.find((c) => c.type === "scale");
  assert.deepEqual(scale.steps.map((s) => s.value), ["0", "5", "10", "15", "20"]);
  assert.equal(validate(draft).valid, true);
  const out = toConfig(draft).criteria.find((c) => c.id === scale.id);
  assert.equal(out.max_step, 20);
  assert.deepEqual(out.scale_steps.map((s) => s.value), [0, 5, 10, 15, 20]);
  assert.equal(out.scale_steps[0].descriptor, "No substantive answer or the key recommendation is wrong");
});

test("labels keep their translations until the canonical title or N/A text is edited", () => {
  const version = mapVersion(sample("finalize"));
  const config = JSON.parse(JSON.stringify(version.config));
  config.criteria[1].labels = { ru: { title: "Выявление потребности", na_condition: "Нет данных" }, kk: { title: "Қажеттілік" } };
  const draft = createDraft(config, config, { checklistId: 1, versionId: 3, versionNumber: 3, baseNumber: 2 }, "ru");
  assert.deepEqual(toConfig(draft).criteria[1].labels, config.criteria[1].labels);
  draft.criteria[1].name = "Needs discovery (new)";
  assert.deepEqual(toConfig(draft).criteria[1].labels, { ru: { na_condition: "Нет данных" } });
  draft.criteria[1].naCondition = "changed";
  assert.equal(toConfig(draft).criteria[1].labels, null);
});
