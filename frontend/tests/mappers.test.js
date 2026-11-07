import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { score } from "../src/scoring.js";
import {
  mapAnswer,
  mapConversation,
  mapEvaluation,
  mapVersion,
  mapListResponse,
  mapAppealList,
  mapAppealSummary,
  mapChecklists,
  mapDataset,
  mapOverview,
  mapRun,
  channelKind,
  clock,
  OPERATOR_LABEL,
  REVIEWER_LABEL
} from "../src/mappers.js";

const dir = new URL("./fixtures/backend_samples/", import.meta.url);
const sample = (name) => JSON.parse(readFileSync(new URL(name + ".json", dir), "utf8"));

test("samples never carry a real audio url", () => {
  for (const name of ["conversation_chat", "conversation_call"]) {
    const text = readFileSync(new URL(name + ".json", dir), "utf8");
    assert.ok(!/powerplatform|sig=|api-version/.test(text), name);
  }
});

test("mapAnswer normalises backend answers", () => {
  assert.equal(mapAnswer("yes"), "yes");
  assert.equal(mapAnswer("no"), "no");
  assert.equal(mapAnswer("na"), "na");
  assert.equal(mapAnswer("15"), 15);
  assert.equal(mapAnswer(20), 20);
  assert.equal(mapAnswer(null), "needs_review");
});

test("conversation: message_index 0 becomes n 1 and audio_start_seconds becomes audioStart", () => {
  const chat = mapConversation(sample("conversation_chat"));
  assert.equal(chat.id, "p1-ru-001");
  assert.equal(chat.pk, 1);
  assert.equal(chat.channel, "chat");
  assert.equal(chat.messages[0].index, 0);
  assert.equal(chat.messages[0].n, 1);
  assert.equal(chat.messages[0].time, "00:00");
  assert.equal(chat.operator, OPERATOR_LABEL);
  assert.equal(chat.hasAudio, false);

  const call = mapConversation(sample("conversation_call"));
  assert.equal(call.channel, "call");
  assert.equal(call.hasAudio, true);
  assert.equal(call.messages[5].audioStart, 23.275);
  assert.equal(call.messages[5].audioEnd, 27.675);
  assert.equal(call.messages[5].n, 6);
  assert.match(call.messages[5].time, /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(!JSON.stringify(call).includes("audio_url"));
  assert.ok(!JSON.stringify(call).includes("redacted"));
});

test("clock extracts the time part from ISO timestamps", () => {
  assert.equal(clock("2026-11-05T14:02:48+05:00"), "14:02:48");
  assert.equal(clock("04:51"), "04:51");
});

test("evaluation: na, effPoints, expected range, overrides and totals", () => {
  const raw = sample("evaluation_with_review");
  const version = mapVersion(sample("checklist_version"));
  const ev = mapEvaluation(raw, version);
  assert.equal(ev.versionLabel, "v1");
  assert.equal(ev.checklistName, version.name);
  const byId = Object.fromEntries(ev.criteria.map((c) => [c.id, c]));
  assert.equal(byId["02"].answer, "na");
  assert.equal(byId["04"].answer, 20);
  assert.equal(byId["04"].steps.length, 5);
  assert.equal(byId["01"].effPoints, raw.final.criteria.find((c) => c.criterion_id === "01").effective_points);
  for (const c of ev.criteria) {
    const rawFinal = raw.final.criteria.find((r) => r.criterion_id === c.id);
    assert.equal(c.effPoints, rawFinal.effective_points, c.id);
    assert.equal(c.points, rawFinal.points, c.id);
  }
  assert.equal(byId["07"].answer, "yes");
  assert.equal(byId["07"].originalAnswer, "no");
  assert.equal(byId["07"].overridden, true);
  assert.deepEqual(byId["07"].expected, { from: 11, to: 11, fromN: 12, toN: 12 });
  assert.equal(byId["07"].appeal.status, "changed");
  assert.equal(ev.total, raw.final_total);
  assert.equal(ev.originalTotal, raw.total);
  assert.equal(ev.totalChanged, true);
  assert.equal(ev.appeals[0].totalBefore, 92.31);
  assert.equal(ev.appeals[0].totalAfter, 100);
  assert.equal(ev.appeals[0].decidedBy, REVIEWER_LABEL);
  assert.equal(ev.appeals[0].author, OPERATOR_LABEL);
  assert.deepEqual(ev.appeals[0].refs, [
    { index: 10, n: 11 },
    { index: 11, n: 12 }
  ]);
  assert.equal(ev.appealWindowWorkdays, 5);
  assert.ok(ev.appealDeadline);
});

test("evaluation: scoring.js agrees with the backend final total", () => {
  for (const name of ["evaluation_with_review", "evaluation_checked_range", "evaluation_call"]) {
    const raw = sample(name);
    const version = mapVersion(sample("checklist_version"));
    const answers = {};
    for (const c of raw.final.criteria) answers[c.criterion_id] = c.answer;
    const result = score(version.config, answers);
    assert.equal(result.total, raw.final.total, name);
    const ev = mapEvaluation(raw, version);
    assert.equal(ev.applicableWeight, result.applicableWeight);
    assert.equal(ev.factor, result.factor);
    for (const c of ev.criteria) {
      const led = result.criteria.find((x) => x.id === c.id);
      assert.equal(c.effWeight, led.effectiveWeight, name + c.id);
    }
  }
});

test("evaluation: checked_range maps to expected from/to", () => {
  const ev = mapEvaluation(sample("evaluation_checked_range"), mapVersion(sample("checklist_version")));
  const c07 = ev.criteria.find((c) => c.id === "07");
  assert.deepEqual(c07.expected, { from: 12, to: 13, fromN: 13, toN: 14 });
});

test("evaluation: evidence carries index and 1-based n", () => {
  const ev = mapEvaluation(sample("evaluation_with_review"), mapVersion(sample("checklist_version")));
  const c04 = ev.criteria.find((c) => c.id === "04");
  assert.ok(c04.evidence.length > 0);
  for (const e of c04.evidence) assert.equal(e.n, e.index + 1);
});

test("evaluation: mapping works without a version (no config)", () => {
  const ev = mapEvaluation(sample("evaluation_with_review"), null);
  assert.equal(ev.config, null);
  assert.equal(ev.criteria.length, 8);
  assert.equal(ev.factor, null);
});

test("list envelope", () => {
  const list = mapListResponse(sample("conversations_envelope"));
  assert.equal(list.items.length, 3);
  assert.ok(list.total >= 3);
  const first = list.items[0];
  assert.equal(first.operator, OPERATOR_LABEL);
  assert.ok(Array.isArray(first.sections));
  assert.equal(typeof first.total, "number");
  assert.equal(first.channel, channelKind("agent chat"));
});

test("list as a plain array is paged client side", () => {
  const body = sample("conversations_envelope").items;
  const out = mapListResponse(body, { offset: 1, limit: 1 });
  assert.equal(out.items.length, 1);
  assert.equal(out.total, 3);
});

test("appeals queue", () => {
  const list = mapAppealList(sample("appeals_queue"));
  assert.equal(list.length, 3);
  const changed = list.find((a) => a.id === 3);
  assert.equal(changed.open, false);
  assert.equal(changed.newAnswer, "yes");
  assert.equal(changed.totalBefore, 92.31);
  assert.equal(changed.totalAfter, 100);
  assert.equal(changed.criterionId, "07");
  assert.ok(changed.fragment.length > 0);
  assert.equal(changed.fragment[0].n, changed.fragment[0].index + 1);
  assert.equal(changed.original.answer, "no");
  assert.equal(changed.versionLabel, "v1");
  assert.equal(changed.conversationId, "p1-ru-001");
  const confirmed = list.find((a) => a.id === 1);
  assert.equal(confirmed.decision, "confirm");
  assert.equal(confirmed.original.answer, 15);
  assert.equal(confirmed.criterionType, "scale");
  assert.equal(confirmed.criterionSteps.length, 5);
});

test("appeal decision payload and summary", () => {
  const raw = sample("appeal_decision");
  const [a] = mapAppealList([raw]);
  assert.equal(a.status, "changed");
  const s = mapAppealSummary(sample("appeal_summary"));
  assert.deepEqual(Object.keys(s).sort(), ["agingHours", "medianResolutionHours", "new", "olderThanHours", "open", "underReview"].sort());
});

test("checklists, version and datasets", () => {
  const lists = mapChecklists(sample("checklists"));
  assert.equal(lists[0].versions[0].label, "v1");
  assert.equal(lists[0].versions[0].status, "active");
  assert.equal(lists[0].versions[0].locked, true);
  assert.equal(lists[0].versions[0].appliedCount, 65);
  const v = mapVersion(sample("checklist_version"));
  assert.equal(v.config.criteria.length, 8);
  assert.equal(v.label, "v1");
  const ds = mapDataset(sample("datasets")[0]);
  assert.equal(ds.groupId, "DEV");
  assert.equal(ds.kind, "dev");
});

test("overview", () => {
  const o = mapOverview(sample("overview"));
  assert.equal(o.kpis.evaluatedCount, 65);
  assert.equal(o.distribution.length, 10);
  assert.equal(o.distribution[0].from, 0);
  assert.ok(o.perCriterion[0].avgPercent <= o.perCriterion[1].avgPercent);
  assert.equal(o.byChannel[0].channel, "call");
  assert.equal(o.attention[0].reason, "gross");
});

test("runs and batch snapshots", () => {
  const run = mapRun(sample("run"));
  assert.equal(run.id, "R-0412");
  assert.equal(run.done, 17);
  assert.equal(run.running, 2);
  assert.equal(run.queued, 5);
  assert.equal(run.failed, 1);
  assert.equal(run.items[0].conversationId, "p1-ru-001");
  assert.equal(run.items[1].error, "Таймаут модели");
  assert.equal(run.versionLabel, "v1");
  const snap = mapRun(sample("batch_snapshot"));
  assert.equal(snap.id, "R-0412");
  assert.equal(snap.failures[0].conversationId, "p1-ru-019");
  assert.equal(snap.queued, null);
});
