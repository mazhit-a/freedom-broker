import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configure, api } from "../src/api.js";
import { mapRun } from "../src/mappers.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import {
  cancelOutcome,
  cancelledPercent,
  errorKey,
  itemKind,
  progressSegments,
  queuedCount,
  runCanCancel,
  runIsActive,
  runIsFinal,
  shouldPoll
} from "../src/components/cqa-eval-runs-model.js";

const dir = new URL("./fixtures/backend_samples/", import.meta.url);
const sample = (name) => JSON.parse(readFileSync(new URL("real_" + name + ".json", dir), "utf8"));
const realFetch = globalThis.fetch;

function stub(routes) {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const target = new URL(String(input));
    const method = options.method || "GET";
    calls.push({ method, path: target.pathname, body: options.body ? JSON.parse(options.body) : null });
    const handler = routes[method + " " + target.pathname];
    if (!handler) return new Response(JSON.stringify({ detail: "Not Found", code: "http_404" }), { status: 404 });
    const status = handler.__status || 200;
    return new Response(JSON.stringify(handler.__status ? handler.body : handler), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("mapper reads cancelled, cancelling and the error string", () => {
  const cancelling = mapRun(sample("run_cancelling"));
  assert.equal(cancelling.status, "cancelling");
  assert.equal(cancelling.cancelled, 5);
  assert.equal(cancelling.error, null);
  assert.equal(queuedCount(cancelling), 0);
  const cancelled = mapRun(sample("run_cancelled"));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.running, 0);
  const failed = mapRun(sample("run_error"));
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /нет кредитов/);
});

test("mapper defaults cancelled to zero and error to null for older payloads", () => {
  const old = sample("run_failed");
  assert.equal("cancelled" in old, false);
  const run = mapRun(old);
  assert.equal(run.cancelled, 0);
  assert.equal(run.error, null);
  assert.equal(mapRun({ ...old, error: "   " }).error, null);
});

test("cancelled items are neither errors nor pending", () => {
  assert.equal(itemKind({ status: "cancelled" }), "cancelled");
  const run = mapRun(sample("run_cancelled"));
  assert.equal(run.failed, 0);
  assert.equal(queuedCount({ ...run, queued: null }), 0);
  assert.equal(progressSegments(run).failed, 0);
  assert.equal(cancelledPercent(run), 50);
  assert.equal(cancelledPercent({ ...run, cancelled: 0 }), 0);
});

test("model helpers decide active, final, cancellable and polling", () => {
  const status = (value) => ({ status: value });
  for (const s of ["queued", "running", "cancelling"]) {
    assert.equal(runIsActive(status(s)), true, s);
    assert.equal(shouldPoll(status(s)), true, s);
    assert.equal(runIsFinal(status(s)), false, s);
  }
  for (const s of ["completed", "failed", "cancelled", "interrupted"]) {
    assert.equal(runIsActive(status(s)), false, s);
    assert.equal(shouldPoll(status(s)), false, s);
    assert.equal(runIsFinal(status(s)), true, s);
  }
  for (const s of ["queued", "running", "cancelling", "interrupted"]) assert.equal(runCanCancel(status(s)), true, s);
  for (const s of ["completed", "failed", "cancelled"]) assert.equal(runCanCancel(status(s)), false, s);
  assert.equal(runCanCancel(null), false);
  assert.equal(runIsFinal(null), false);
});

test("cancel outcome and error keys", () => {
  assert.equal(cancelOutcome({ code: "run_not_active" }), "finished");
  assert.equal(cancelOutcome({ code: "run_not_found" }), "missing");
  assert.equal(cancelOutcome({ code: "network" }), "failed");
  assert.equal(errorKey({ code: "run_not_active" }), "run_not_active");
});

test("api.cancelRun posts to the cancel endpoint and maps the header", async () => {
  configure({ mock: false, baseUrl: "http://backend.test/api/v1" });
  const calls = stub({ "POST /api/v1/runs/7/cancel": sample("run_cancelling") });
  const run = await api.cancelRun("R-0007");
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [["POST", "/api/v1/runs/7/cancel"]]);
  assert.equal(run.status, "cancelling");
  assert.equal(run.cancelled, 5);
  assert.deepEqual(run.items, []);
});

test("api.cancelRun surfaces 404 and 409 as typed errors", async () => {
  configure({ mock: false, baseUrl: "http://backend.test/api/v1" });
  stub({ "POST /api/v1/runs/9/cancel": { __status: 404, body: { detail: { code: "run_not_found", message: "Run not found" } } } });
  await assert.rejects(api.cancelRun(9), (e) => e.name === "ApiError" && e.status === 404 && e.code === "run_not_found");
  stub({ "POST /api/v1/runs/9/cancel": { __status: 409, body: { detail: { code: "run_not_active", message: "Run is not active" } } } });
  await assert.rejects(api.cancelRun("R-0009"), (e) => e.status === 409 && e.code === "run_not_active");
  stub({ "POST /api/v1/runs/9/cancel": { __status: 409, body: { detail: "conflict", code: "http_409" } } });
  await assert.rejects(api.cancelRun(9), (e) => e.status === 409 && e.code === "run_not_active");
  stub({});
  await assert.rejects(api.cancelRun(9), (e) => e.status === 404 && e.code === "run_not_found");
});

test("mock cancelRun: running run goes cancelling, then cancelled after the next poll, queued items cancelled", async () => {
  configure({ mock: true, slowMs: 0 });
  const before = (await api.listRuns()).find((r) => r.id === "R-0412");
  assert.equal(before.status, "running");
  const cancelling = await api.cancelRun("R-0412");
  assert.equal(cancelling.status, "cancelling");
  assert.ok(cancelling.cancelled > 0);
  assert.equal(cancelling.queued, 0);
  const again = await api.cancelRun("R-0412");
  assert.equal(again.status, "cancelling");
  const next = await api.getRun("R-0412", { limit: 100 });
  assert.equal(next.status, "cancelled");
  assert.equal(next.running, 0);
  assert.ok(next.items.some((i) => i.status === "cancelled"));
  assert.ok(next.items.every((i) => i.status !== "queued" && i.status !== "running"));
  await assert.rejects(api.cancelRun("R-0412"), (e) => e.status === 409 && e.code === "run_not_active");
  await assert.rejects(api.cancelRun("R-0999"), (e) => e.status === 404 && e.code === "run_not_found");
  await assert.rejects(api.cancelRun("R-0411"), (e) => e.status === 409);
});

test("mock extra runs: failed with error and interrupted cancelled at once", async () => {
  configure({ mock: true, slowMs: 0, state: "extraruns" });
  const runs = await api.listRuns();
  const failed = runs.find((r) => r.id === "R-0409");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /нет кредитов/);
  const stopped = await api.cancelRun("R-0408");
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.cancelled, 7);
});

test("every new runs.* cancel key exists in all three locales", () => {
  const keys = Object.keys(DICTIONARIES.ru).filter((k) => /^runs\.(cancel|run\.(queued|cancelling|cancelled|interrupted|errorLabel)|counter\.cancelled|item\.cancelled|hcol\.(status|actions)|error\.run_not_active)/.test(k));
  assert.ok(keys.length >= 20);
  for (const locale of LOCALES) {
    for (const key of keys) assert.ok(DICTIONARIES[locale][key], `${locale}:${key}`);
  }
  assert.equal(DICTIONARIES.ru["runs.cancel"], "Остановить");
  assert.notEqual(DICTIONARIES.ru["runs.run.failed"], DICTIONARIES.ru["runs.run.cancelled"]);
  assert.notEqual(DICTIONARIES.en["runs.run.failed"], DICTIONARIES.en["runs.run.cancelled"]);
  assert.notEqual(DICTIONARIES.kk["runs.run.failed"], DICTIONARIES.kk["runs.run.cancelled"]);
});
