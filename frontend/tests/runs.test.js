import test from "node:test";
import assert from "node:assert/strict";
import { configure, api } from "../src/api.js";
import { DICTIONARIES, LOCALES } from "../src/i18n/index.js";
import {
  errorKey,
  isJsonFile,
  itemKind,
  otherVersionLabel,
  progressSegments,
  queuedCount,
  runIsActive,
  savedVersionOptions,
  validateDatasetText,
  wallDateTime
} from "../src/components/cqa-eval-runs-model.js";
import { elements } from "../src/screens/runs.js";

test("runs screen registers cqa-eval-runs", () => {
  assert.deepEqual(Object.keys(elements), ["cqa-eval-runs"]);
});

test("every runs.* key exists in all three locales and none is empty", () => {
  const keys = Object.keys(DICTIONARIES.ru).filter((k) => k.startsWith("runs."));
  assert.ok(keys.length > 80);
  for (const locale of LOCALES) {
    for (const key of keys) {
      assert.ok(DICTIONARIES[locale][key], `${locale}:${key}`);
    }
    const own = Object.keys(DICTIONARIES[locale]).filter((k) => k.startsWith("runs."));
    assert.deepEqual(own.sort(), keys.slice().sort(), locale);
  }
});

test("dataset file validation checks the four required keys", () => {
  const ok = [{ conversation_id: "a", channel: "chat", language: "ru", transcript: [] }];
  assert.deepEqual(validateDatasetText(JSON.stringify(ok)), { ok: true, count: 1 });
  assert.deepEqual(validateDatasetText(JSON.stringify({ conversations: ok })), { ok: true, count: 1 });
  assert.equal(validateDatasetText("{").code, "json");
  assert.equal(validateDatasetText('"x"').code, "shape");
  assert.equal(validateDatasetText("[]").code, "empty");
  const bad = validateDatasetText(JSON.stringify([ok[0], { conversation_id: "b", language: "ru" }]));
  assert.equal(bad.code, "keys");
  assert.equal(bad.params.index, 2);
  assert.equal(bad.params.keys, "channel, transcript");
  assert.equal(validateDatasetText(JSON.stringify([null])).code, "keys");
});

test("json file detection by name or type", () => {
  assert.equal(isJsonFile({ name: "x.JSON", type: "" }), true);
  assert.equal(isJsonFile({ name: "x", type: "application/json" }), true);
  assert.equal(isJsonFile({ name: "x.csv", type: "text/csv" }), false);
  assert.equal(isJsonFile(null), false);
});

test("item kinds and progress segments", () => {
  assert.equal(itemKind({ status: "completed" }), "done");
  assert.equal(itemKind({ status: "needs_review" }), "lowConfidence");
  assert.equal(itemKind({ status: "failed" }), "failed");
  assert.equal(itemKind({ status: "running" }), "running");
  assert.equal(itemKind({ status: "queued" }), "queued");
  const run = { total: 25, skipped: 0, toRun: 25, done: 17, failed: 1, running: 2, queued: 5 };
  const seg = progressSegments(run);
  assert.equal(seg.max, 25);
  assert.equal(seg.now, 18);
  assert.equal(seg.done, 68);
  assert.equal(seg.failed, 4);
  assert.equal(seg.running, 8);
  assert.equal(queuedCount({ ...run, queued: null }), 5);
  assert.equal(queuedCount(run), 5);
  assert.equal(progressSegments({ total: 0, skipped: 0, toRun: 0, done: 0, failed: 0, running: 0 }).max, 0);
  assert.equal(runIsActive({ status: "running" }), true);
  assert.equal(runIsActive(null), false);
});

test("wall clock date time ignores the offset and follows the locale", () => {
  assert.equal(wallDateTime("2026-11-07T15:02:00+05:00", "ru"), "07.11.2026 15:02");
  assert.equal(wallDateTime("2026-11-07T15:02:00+05:00", "en"), "11/07/2026 15:02");
  assert.equal(wallDateTime("2026-11-07T15:02:00+05:00", "kk", false), "07.11.2026");
  assert.equal(wallDateTime(null, "ru"), "");
});

test("error keys fall back to generic", () => {
  assert.equal(errorKey({ code: "role_forbidden" }), "role_forbidden");
  assert.equal(errorKey({ code: "weird" }), "generic");
  assert.equal(errorKey(null), "generic");
});

test("mock: saved versions only, other-version label, start, progress, retry", async () => {
  configure({ mock: true, slowMs: 0 });
  const checklists = await api.listChecklists();
  const versions = savedVersionOptions(checklists);
  assert.ok(versions.length >= 2);
  assert.ok(versions.every((v) => v.label !== "v3"));
  assert.equal(versions.find((v) => v.isDefault).label, "v2");

  const runs = await api.listRuns();
  assert.equal(runs[0].id, "R-0412");
  assert.equal(runs[0].status, "running");
  const run = await api.getRun("R-0412", { limit: 100 });
  assert.equal(otherVersionLabel(run, checklists), "v2");
  assert.ok(run.items.some((i) => i.otherVersionTotal !== null));
  const failed = run.items.find((i) => i.status === "failed");
  assert.equal(failed.error, "Таймаут модели");

  const retried = await api.retryRunItem("R-0412", failed.conversationId);
  assert.equal(retried.items.find((i) => i.conversationId === failed.conversationId).status, "queued");

  const started = await api.startRun({ groupId: "control", versionId: 12, model: "llm-v3", force: false });
  assert.equal(started.status, "running");
  assert.equal(started.total, 25);
  let latest = started;
  for (let i = 0; i < 20 && latest.status === "running"; i += 1) latest = await api.getRun(started.id, { limit: 100 });
  assert.equal(latest.status, "completed");
  const estimate = await api.estimateRun({ groupId: "control", model: "llm-v3", count: 25 });
  assert.equal(estimate.cost, 0.1);
});
