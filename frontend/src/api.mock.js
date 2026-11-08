import { score } from "./scoring.js";
import { ApiError } from "./errors.js";
import * as F from "./mock-fixtures.js";
import {
  channelKind,
  mapAppeal,
  mapAppealList,
  mapAppealSummary,
  mapChecklist,
  mapChecklists,
  mapConversation,
  mapDataset,
  mapEvaluation,
  mapEvaluationSummary,
  mapListResponse,
  mapOverview,
  mapRun,
  mapVersion,
  runLabel,
  runNumber,
  versionLabel,
  wireAnswer
} from "./mappers.js";

const HOUR = 3600000;
const EPOCH_MS = Date.parse(F.MOCK_EPOCH);
const AGING_HOURS = 72;
const WINDOW_WORKDAYS = 5;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function iso(ms) {
  const offset = 5 * HOUR;
  return new Date(ms + offset).toISOString().replace("Z", "+05:00").replace(/\.\d{3}/, "");
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function addWeekdays(ms, days) {
  const d = new Date(ms);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d.getTime();
}

function numericAnswerEquals(a, b) {
  return String(a) === String(b);
}

function freshStore(options) {
  const startedAt = Date.now();
  const nowMs = () => EPOCH_MS + (Date.now() - startedAt);
  const store = {
    startedAt,
    nowMs,
    options,
    nextAppealId: 6,
    nextVersionId: 100,
    nextChecklistId: 50,
    nextRun: 413,
    appeals: [],
    checklists: clone(F.CHECKLISTS),
    configs: {
      11: F.makeConfig(F.CHAT_CHECKLIST_NAME),
      12: F.makeConfig(F.CHAT_CHECKLIST_NAME),
      13: F.makeConfig(F.CHAT_CHECKLIST_NAME),
      21: F.makeConfig(F.CALL_CHECKLIST_NAME)
    },
    datasets: clone(F.DATASETS),
    evaluatedAt: {},
    runs: []
  };
  if (!options.withoutAppeals) {
    for (const fixture of F.APPEALS) {
      const createdMs = EPOCH_MS - fixture.ageHours * HOUR;
      const appeal = {
        id: fixture.id,
        rowPk: fixture.rowPk,
        criterionId: fixture.criterionId,
        comment: fixture.comment,
        refs: fixture.refs.slice(),
        createdMs,
        reviewStartedMs: fixture.reviewStarted ? createdMs + HOUR : null,
        decision: null,
        newAnswer: null,
        reason: null,
        decidedMs: null,
        totalBefore: null,
        totalAfter: null,
        original: fixture.original || null,
        fragment: fixture.fragment
      };
      store.appeals.push(appeal);
    }
    for (const fixture of F.APPEALS) {
      if (fixture.decision) {
        const appeal = store.appeals.find((a) => a.id === fixture.id);
        applyDecision(store, appeal, fixture.decision, fixture.newAnswer, fixture.reason, Date.parse(fixture.decidedAt));
      }
    }
  }
  store.runs.push(initialRun(store));
  for (const h of F.RUN_HISTORY) store.runs.push(historyRun(h));
  if (options.state === "extraruns") for (const h of F.RUN_EXTRA) store.runs.push(historyRun(h));
  store.runs.sort((a, b) => b.number - a.number);
  return store;
}

function rowByPk(pk) {
  return F.ROWS.find((r) => r.pk === pk) || null;
}

function findRow(idOrPk) {
  if (typeof idOrPk === "number") return rowByPk(idOrPk);
  const text = String(idOrPk);
  return F.ROWS.find((r) => r.id === text) || (/^\d+$/.test(text) ? rowByPk(Number(text)) : null);
}

function versionIdFor(row) {
  return 10 + row.versionNumber;
}

function configFor(store, versionId) {
  return store.configs[versionId];
}

function rowAnswers(store, row) {
  if (!row.answers) return null;
  const answers = { ...row.answers };
  if (store.options.state === "lowconf") answers["04"] = null;
  return answers;
}

function overridesFor(store, row, uptoMs = Infinity, excludeId = null) {
  const out = {};
  const decided = store.appeals
    .filter((a) => a.rowPk === row.pk && a.decidedMs !== null && a.decidedMs <= uptoMs && a.id !== excludeId && a.changed)
    .sort((a, b) => a.decidedMs - b.decidedMs);
  for (const a of decided) out[a.criterionId] = a.newAnswer;
  return out;
}

function calc(store, row, includeOverrides = true) {
  const config = configFor(store, versionIdFor(row));
  const answers = rowAnswers(store, row);
  if (!answers) return { config, answers: null, original: null, final: null };
  const original = score(config, answers);
  const final = includeOverrides ? score(config, answers, overridesFor(store, row)) : original;
  return { config, answers, original, final };
}

function applyDecision(store, appeal, decision, newAnswer, reason, decidedMs) {
  const row = rowByPk(appeal.rowPk);
  const config = configFor(store, versionIdFor(row));
  const answers = rowAnswers(store, row);
  const before = score(config, answers, overridesFor(store, row, Infinity, appeal.id)).total;
  const originalAnswer = answers[appeal.criterionId];
  const changed = decision === "change" && !numericAnswerEquals(newAnswer, originalAnswer);
  appeal.decision = decision;
  appeal.newAnswer = decision === "change" ? newAnswer : null;
  appeal.reason = reason;
  appeal.decidedMs = decidedMs;
  appeal.changed = changed;
  const overrides = overridesFor(store, row, Infinity, appeal.id);
  if (changed) overrides[appeal.criterionId] = newAnswer;
  appeal.totalBefore = before;
  appeal.totalAfter = score(config, answers, overrides).total;
}

function displayStatus(appeal) {
  if (appeal.decidedMs !== null) return appeal.changed ? "changed" : "confirmed";
  return appeal.reviewStartedMs !== null ? "under_review" : "new";
}

function evalIdFor(row) {
  return 100 + row.pk;
}

function rowByEvaluationId(id) {
  return F.ROWS.find((r) => evalIdFor(r) === Number(id)) || null;
}

function wireOrNull(value) {
  if (value === null || value === undefined) return null;
  return wireAnswer(value);
}

function resultsFor(row) {
  return F.RESULTS[row.id] || null;
}

function messagesFor(row) {
  return F.MESSAGES[row.id] || null;
}

function rawResultRow(def, led, res) {
  const evidence = res ? res.evidence.map((i) => ({ message_index: i, quote: "" })) : [];
  return {
    criterion_id: def.id,
    answer: led.status === "needs_review" ? null : wireOrNull(led.answer),
    points: led.points,
    effective_points: led.effectivePoints,
    rationale: res ? res.rationale : "",
    checked_range: res && res.range ? res.range : null,
    na_reason: res ? res.naReason : null,
    needs_review: led.status === "needs_review",
    evidence
  };
}

function fillQuotes(rows, messages) {
  for (const r of rows) {
    for (const e of r.evidence) {
      const m = messages.find((x) => x.message_index === e.message_index);
      e.quote = m ? m.text : "";
    }
  }
}

function criteriaConfidence(rows) {
  const total = rows.length;
  const withRationale = rows.filter((r) => !r.needs_review && r.rationale).length;
  const low = rows.some((r) => r.needs_review);
  return { level: low ? "low" : "high", with_rationale: withRationale, total };
}

function rawAppealBase(store, appeal, row) {
  const status = displayStatus(appeal);
  return {
    id: appeal.id,
    evaluation_id: evalIdFor(row),
    criterion_id: appeal.criterionId,
    comment: appeal.comment,
    status: appeal.decidedMs === null ? "open" : "resolved",
    created_at: iso(appeal.createdMs),
    author_role: "operator",
    review_started_at: appeal.reviewStartedMs === null ? null : iso(appeal.reviewStartedMs),
    review_started_by: appeal.reviewStartedMs === null ? null : "reviewer",
    message_refs: appeal.refs.slice(),
    decision: appeal.decision,
    new_answer: wireOrNull(appeal.newAnswer),
    reason: appeal.reason,
    decided_at: appeal.decidedMs === null ? null : iso(appeal.decidedMs),
    decided_by_role: appeal.decidedMs === null ? null : "reviewer",
    total_before: appeal.totalBefore,
    total_after: appeal.totalAfter,
    display_status: status
  };
}

function ageHours(store, appeal) {
  const end = appeal.decidedMs === null ? store.nowMs() : appeal.decidedMs;
  return round2((end - appeal.createdMs) / HOUR);
}

function rawAppealFull(store, appeal) {
  const row = rowByPk(appeal.rowPk);
  const { config, original } = calc(store, row);
  const def = config.criteria.find((c) => c.id === appeal.criterionId);
  const led = original.criteria.find((c) => c.id === appeal.criterionId);
  const res = resultsFor(row) ? resultsFor(row)[appeal.criterionId] : null;
  const rationale = res ? res.rationale : appeal.original ? appeal.original.rationale : "";
  const evidence = res ? res.evidence.map((i) => ({ message_index: i, quote: "" })) : [];
  const messages = messagesFor(row);
  if (messages) {
    for (const e of evidence) {
      const m = messages.find((x) => x.message_index === e.message_index);
      e.quote = m ? m.text : "";
    }
  }
  const fragment = messages
    ? appeal.fragment.map((f) => messages.find((m) => m.message_index === f.index))
    : appeal.fragment.map((f) => ({
        message_index: f.index,
        timestamp_raw: f.time,
        offset_seconds: null,
        speaker: f.speaker,
        text: f.text
      }));
  return {
    ...rawAppealBase(store, appeal, row),
    conversation_pk: row.pk,
    conversation_id: row.id,
    channel: row.channel,
    language: row.language,
    age_hours: ageHours(store, appeal),
    checklist_version_label: versionLabel(row.versionNumber),
    model_label: modelLabel(),
    criterion: clone(def),
    original: {
      answer: wireOrNull(led.status === "needs_review" ? null : led.answer),
      points: led.points,
      effective_points: led.effectivePoints,
      rationale,
      na_reason: res ? res.naReason : null,
      evidence,
      checked_range: res && res.range ? res.range : null
    },
    fragment
  };
}

function modelLabel() {
  return F.MODELS[0].label;
}

function rowDisplayAppeal(store, row) {
  const list = store.appeals.filter((a) => a.rowPk === row.pk).sort((a, b) => a.createdMs - b.createdMs);
  if (!list.length) return "none";
  const open = list.filter((a) => a.decidedMs === null);
  return displayStatus(open.length ? open[open.length - 1] : list[list.length - 1]);
}

function rawSections(config, sectionsOut) {
  return sectionsOut.map((s) => {
    const def = config.sections.find((x) => x.id === s.id);
    return {
      id: s.id,
      title: def ? def.title : s.id,
      earned: s.earned,
      applicable_max: s.applicableMax,
      percent: s.percent,
      effective_points: s.effectivePoints,
      effective_max: s.effectiveMax
    };
  });
}

function rawEvaluation(store, row) {
  const { config, answers, original, final } = calc(store, row);
  const res = resultsFor(row);
  const messages = messagesFor(row);
  const results = config.criteria.map((def) => {
    const led = original.criteria.find((c) => c.id === def.id);
    return rawResultRow(def, led, res ? res[def.id] : null);
  });
  if (messages) fillQuotes(results, messages);
  const finalCriteria = config.criteria.map((def) => {
    const finalLed = final.criteria.find((c) => c.id === def.id);
    const origLed = original.criteria.find((c) => c.id === def.id);
    const overridden = String(finalLed.answer) !== String(origLed.answer) || finalLed.status !== origLed.status;
    return {
      criterion_id: def.id,
      answer: finalLed.status === "needs_review" ? null : wireOrNull(finalLed.answer),
      status: finalLed.status,
      points: finalLed.points,
      effective_points: finalLed.effectivePoints,
      overridden,
      original_answer: origLed.status === "needs_review" ? null : wireOrNull(origLed.answer),
      original_points: origLed.points,
      original_effective_points: origLed.effectivePoints
    };
  });
  const appeals = store.appeals.filter((a) => a.rowPk === row.pk).map((a) => rawAppealBase(store, a, row));
  const evaluatedAtMs = store.evaluatedAt[row.pk] || Date.parse(row.evaluatedAt);
  const last = messages ? messages[messages.length - 1] : null;
  const isCall = channelKind(row.channel) === "call";
  const base = {
    id: evalIdFor(row),
    conversation_id: row.pk,
    checklist_version_id: versionIdFor(row),
    model: "llm-v3",
    model_label: modelLabel(),
    prompt_version: "v1",
    status: original.provisional ? "needs_review" : "completed",
    total: original.total,
    total_status: original.calculated ? "calculated" : "not_calculated",
    provisional: original.provisional,
    gross_violation: original.grossViolation,
    tokens_input: 700,
    tokens_output: 1800,
    latency_ms: 6200,
    cost: 0.004,
    created_at: iso(evaluatedAtMs),
    criteria: results,
    original: {
      total: original.total,
      total_status: original.calculated ? "calculated" : "not_calculated",
      provisional: original.provisional,
      gross_violation: original.grossViolation,
      criteria: results
    },
    appeals,
    appeal_deadline: iso(addWeekdays(evaluatedAtMs, WINDOW_WORKDAYS)),
    appeal_window_workdays: WINDOW_WORKDAYS,
    decisions: appeals.filter((a) => a.status === "resolved"),
    appealed_criteria: [],
    occurred_at: isCall && messages ? messages[0].timestamp_raw : null,
    duration_seconds: last ? last.offset_seconds : null,
    confidence: criteriaConfidence(results),
    display_appeal_status: rowDisplayAppeal(store, row),
    final_total: final.total,
    total_changed: final.total !== original.total,
    final: {
      total: final.total,
      calculated: final.calculated,
      reason: final.reason,
      provisional: final.provisional,
      gross_violation: final.grossViolation,
      changed: final.total !== original.total,
      criteria: finalCriteria,
      sections: rawSections(config, final.sections)
    }
  };
  return base;
}

function rawListItem(store, row) {
  const base = {
    id: row.pk,
    dataset_id: 1,
    group_id: "DEV",
    conversation_id: row.id,
    channel: row.channel,
    language: row.language,
    has_audio: channelKind(row.channel) === "call",
    message_count: messagesFor(row) ? messagesFor(row).length : null,
    evaluation_id: evalIdFor(row),
    checklist_version_id: versionIdFor(row),
    checklist_version_number: row.versionNumber,
    checklist_name: F.CHAT_CHECKLIST_NAME,
    occurred_at: null,
    duration_seconds: null,
    evaluated_at: iso(store.evaluatedAt[row.pk] || Date.parse(row.evaluatedAt))
  };
  if (row.failed) {
    return {
      ...base,
      eval_status: "failed",
      total: null,
      total_status: null,
      provisional: false,
      gross_violation: null,
      appeal_status: "none",
      checklist_version_label: versionLabel(row.versionNumber),
      model_label: modelLabel(),
      confidence: null,
      final_total: null,
      total_changed: false,
      sections: null,
      display_appeal_status: "none"
    };
  }
  const { original, final } = calc(store, row);
  const results = resultsFor(row);
  const confidence = results
    ? criteriaConfidence(original.criteria.map((c) => ({ needs_review: c.status === "needs_review", rationale: results[c.id] ? results[c.id].rationale : "" })))
    : { level: original.provisional ? "low" : "high", with_rationale: original.provisional ? 7 : 8, total: 8 };
  const display = rowDisplayAppeal(store, row);
  const appealCoarse = display === "none" ? "none" : display === "new" || display === "under_review" ? "open" : "resolved";
  return {
    ...base,
    eval_status: original.provisional ? "needs_review" : "completed",
    total: original.total,
    total_status: original.calculated ? "calculated" : "not_calculated",
    provisional: original.provisional,
    gross_violation: original.grossViolation === true,
    appeal_status: appealCoarse,
    checklist_version_label: versionLabel(row.versionNumber),
    model_label: modelLabel(),
    confidence,
    final_total: final.total,
    total_changed: final.total !== original.total,
    sections: final.sections.map((s) => ({ id: s.id, effective_points: s.effectivePoints, effective_max: s.effectiveMax })),
    display_appeal_status: display
  };
}

function rawConversation(row) {
  const messages = messagesFor(row);
  const isCall = channelKind(row.channel) === "call";
  const last = messages[messages.length - 1];
  return {
    id: row.pk,
    dataset_id: 1,
    group_id: "DEV",
    conversation_id: row.id,
    channel: row.channel,
    language: row.language,
    audio_url: null,
    has_audio: isCall,
    occurred_at: isCall ? messages[0].timestamp_raw : null,
    duration_seconds: last.offset_seconds,
    messages: clone(messages)
  };
}

function versionRaw(store, versionId) {
  for (const cl of store.checklists) {
    const v = cl.versions.find((x) => x.id === versionId);
    if (v) return { cl, v, raw: rawVersion(store, cl, v) };
  }
  return null;
}

function statusOf(cl, v) {
  if (v.status === "draft") return "draft";
  if (cl.defaultVersionId === v.id) return "active";
  if (v.wasActive) return "archived";
  const active = cl.versions.find((x) => x.id === cl.defaultVersionId);
  if (active && v.version < active.version) return "archived";
  return "saved";
}

function structuralProblem(config) {
  const criteria = (config && config.criteria) || [];
  const ids = criteria.map((c) => c.id);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) return "duplicate criterion ids: " + dupes.join(", ");
  const sections = ((config && config.sections) || []).map((s) => s.id);
  if (new Set(sections).size !== sections.length) return "duplicate section ids";
  if (!config || !String(config.name || "").trim()) return "name is required";
  return null;
}

function completenessProblem(config) {
  const structural = structuralProblem(config);
  if (structural) return structural;
  const problems = [];
  if (!config.criteria.length) problems.push("checklist needs at least 1 criterion");
  for (const s of config.sections || []) if (!String(s.title || "").trim()) problems.push("section " + s.id + ": title is required");
  for (const c of config.criteria) {
    if (!String(c.title || "").trim()) problems.push("criterion " + c.id + ": title is required");
    if (c.na_allowed && !String(c.na_condition || "").trim()) problems.push("criterion " + c.id + ": na_allowed requires a non-empty na_condition");
    if (c.type === "scale") {
      const steps = c.scale_steps || [];
      if (steps.length < 2) problems.push("criterion " + c.id + ": scale type requires at least 2 steps");
      else if (steps.some((st) => !String(st.descriptor || "").trim())) problems.push("criterion " + c.id + ": scale step descriptors are required");
    }
  }
  return problems.length ? problems.join("; ") : null;
}

function weightSum(config) {
  return config.criteria.reduce((s, c) => s + (c.type === "flag" ? 0 : Number(c.weight) || 0), 0);
}

function rawVersion(store, cl, v) {
  const config = store.configs[v.id];
  const sum = weightSum(config);
  return {
    id: v.id,
    checklist_id: cl.id,
    version: v.version,
    created_at: v.createdAt,
    is_default: cl.defaultVersionId === v.id,
    status: statusOf(cl, v),
    criteria_count: config.criteria.length,
    weight_sum: sum,
    applied_count: v.appliedCount,
    first_applied_at: v.firstAppliedAt,
    config: clone(config),
    warnings: sum === 100 ? [] : ["Weights of scored criteria sum to " + sum + ", expected 100"]
  };
}

function rawChecklist(store, cl) {
  return {
    id: cl.id,
    name: cl.name,
    default_version_id: cl.defaultVersionId,
    channels: cl.channels.slice(),
    versions: cl.versions.map((v) => {
      const { config, warnings, ...summary } = rawVersion(store, cl, v);
      return summary;
    })
  };
}

function rowTotals(store, row, patch) {
  const config = configFor(store, versionIdFor(row));
  const answers = { ...rowAnswers(store, row), ...(patch || {}) };
  return score(config, answers);
}

function initialRun(store) {
  const nowMs = store.nowMs();
  const items = F.RUN_ITEMS_R0412.map((i) => ({ ...i }));
  return {
    number: 412,
    groupId: "control",
    datasetLabel: "Контрольная группа",
    versionId: 13,
    checklistLabel: "v3",
    model: modelLabel(),
    status: "running",
    force: false,
    total: 25,
    skipped: 0,
    done: 17,
    failed: 1,
    running: 2,
    queued: 5,
    startedMs: nowMs - 102000,
    finishedMs: null,
    items,
    averageTotal: null
  };
}

function historyRun(h) {
  return {
    number: h.number,
    groupId: h.groupId,
    datasetLabel: h.datasetLabel,
    versionId: h.versionId,
    checklistLabel: h.checklistLabel,
    model: h.model,
    status: h.status || "completed",
    force: false,
    total: h.total,
    skipped: 0,
    done: h.done === undefined ? h.total : h.done,
    failed: h.failed || 0,
    running: 0,
    queued: h.queued || 0,
    cancelled: 0,
    error: h.error || null,
    startedMs: Date.parse(h.startedAt),
    finishedMs: h.finishedAt ? Date.parse(h.finishedAt) : null,
    items: [],
    averageTotal: h.averageTotal,
    fixedCost: h.cost
  };
}

function modelPrice(label) {
  const m = F.MODELS.find((x) => x.label === label || x.id === label);
  return m ? m.pricePerEvaluation : 0;
}

function itemTotal(store, item) {
  const row = rowByPk(item.rowPk);
  if (!row || row.failed) return null;
  return rowTotals(store, row, item.patch).total;
}

function rawRun(store, run, paging = null) {
  const nowMs = store.nowMs();
  const endMs = run.finishedMs === null ? nowMs : run.finishedMs;
  const elapsed = Math.max(0, (endMs - run.startedMs) / 1000);
  const processed = run.done + run.failed;
  const toRun = run.total - run.skipped;
  const cancelled = run.cancelled || 0;
  const price = modelPrice(run.model);
  const eta = run.status === "running" && processed > 0 ? round2((elapsed / processed) * Math.max(toRun - processed, 0)) : null;
  const totals = run.items.filter((i) => i.status === "completed" || i.status === "needs_review").map((i) => itemTotal(store, i)).filter((t) => t !== null);
  const average = run.averageTotal !== null ? run.averageTotal : run.status === "completed" && totals.length ? round2(totals.reduce((s, t) => s + t, 0) / totals.length) : null;
  const header = {
    id: run.number,
    run_id: run.number,
    code: runLabel(run.number),
    dataset: run.groupId,
    dataset_label: run.datasetLabel,
    checklist_version_id: run.versionId,
    checklist_label: F.CHAT_CHECKLIST_NAME + " " + run.checklistLabel,
    model: run.model,
    force: run.force,
    status: run.status,
    total: run.total,
    skipped: run.skipped,
    to_run: toRun,
    processed,
    completed: run.done,
    needs_review: 0,
    failed: run.failed,
    done: run.done,
    running: run.running,
    in_flight: run.running,
    queued: run.queued,
    cancelled,
    error: run.error || null,
    percent: toRun > 0 ? Math.round((100 * processed) / toRun) : 100,
    average_total: average,
    cost_total: run.fixedCost !== undefined ? run.fixedCost : Math.round(run.done * price * 10000) / 10000,
    tokens_in: null,
    tokens_out: null,
    elapsed_s: round2(elapsed),
    eta_s: eta,
    started_at: iso(run.startedMs),
    finished_at: run.finishedMs === null ? null : iso(run.finishedMs),
    failures: run.items
      .filter((i) => i.status === "failed")
      .map((i) => ({ conversation_pk: i.rowPk, conversation_id: rowByPk(i.rowPk).id, error: i.error || "Ошибка оценки" }))
  };
  if (!paging) return header;
  const slice = run.items.slice(paging.offset, paging.offset + paging.limit);
  header.items = slice.map((i) => {
    const row = rowByPk(i.rowPk);
    const done = i.status === "completed" || i.status === "needs_review";
    const otherPatch = i.patch ? rowTotals(store, row, null).total : null;
    return {
      conversation_pk: row.pk,
      conversation_id: row.id,
      channel: row.channel,
      language: row.language,
      status: i.status,
      evaluation_id: done ? evalIdFor(row) : null,
      latency_ms: i.latencyMs,
      total: done ? itemTotal(store, i) : null,
      gross: done ? score(configFor(store, versionIdFor(row)), { ...rowAnswers(store, row), ...(i.patch || {}) }).grossViolation === true : null,
      error: i.error || null,
      other_version_total: otherPatch,
      started_at: null,
      finished_at: null
    };
  });
  header.items_total = run.items.length;
  header.offset = paging.offset;
  header.limit = paging.limit;
  return header;
}

function advanceRun(store, run) {
  if (run.status === "cancelling") {
    for (const item of run.items) if (item.status === "running") item.status = rowByPk(item.rowPk) && rowTotalsProvisional(store, item) ? "needs_review" : "completed";
    run.done += run.running;
    run.running = 0;
    run.status = "cancelled";
    run.finishedMs = store.nowMs();
    return;
  }
  if (run.status !== "running") return;
  for (const item of run.items) if (item.status === "running") item.status = rowByPk(item.rowPk) && rowTotalsProvisional(store, item) ? "needs_review" : "completed";
  run.done += run.running;
  const start = Math.min(2, run.queued);
  run.queued -= start;
  run.running = start;
  let promoted = 0;
  for (const item of run.items) {
    if (item.status === "queued" && promoted < start) {
      item.status = "running";
      promoted += 1;
    }
  }
  if (run.queued === 0 && run.running === 0) {
    run.status = "completed";
    run.finishedMs = store.nowMs();
  }
}

function rowTotalsProvisional(store, item) {
  const row = rowByPk(item.rowPk);
  return Boolean(row && !row.failed && rowTotals(store, row, item.patch).provisional);
}

function fail(status, code, message) {
  return new ApiError(status, code, message);
}

function narrowOverview(raw, filter) {
  const total = raw.kpis.evaluated;
  const lang = filter.language ? raw.by_language.find((r) => r.language === String(filter.language).toUpperCase()) : null;
  const chan = filter.channel ? raw.by_channel.find((r) => channelKind(r.channel) === filter.channel) : null;
  let factor = 1;
  if (lang) factor *= lang.count / total;
  if (chan) factor *= chan.count / total;
  if (filter.from && filter.to) factor *= 0.28;
  if (factor === 1) return raw;
  const scale = (n) => Math.round(n * factor);
  raw.kpis.evaluated = scale(total);
  raw.kpis.chats = chan ? (channelKind(chan.channel) === "chat" ? raw.kpis.evaluated : 0) : scale(raw.kpis.chats);
  raw.kpis.calls = chan ? (channelKind(chan.channel) === "call" ? raw.kpis.evaluated : 0) : raw.kpis.evaluated - raw.kpis.chats;
  raw.kpis.gross_count = scale(raw.kpis.gross_count);
  if (lang) raw.kpis.avg = lang.avg;
  if (chan) raw.kpis.avg = chan.avg;
  raw.distribution = raw.distribution.map((b) => ({ ...b, count: scale(b.count) }));
  raw.by_language = (lang ? [lang] : raw.by_language).map((r) => ({ ...r, count: lang ? raw.kpis.evaluated : scale(r.count) }));
  raw.by_channel = (chan ? [chan] : raw.by_channel).map((r) => ({ ...r, count: chan ? raw.kpis.evaluated : scale(r.count) }));
  return raw;
}

function matchesChannel(row, wanted) {
  if (!wanted) return true;
  if (wanted === "chat" || wanted === "call") return channelKind(row.channel) === wanted;
  return row.channel.toLowerCase() === String(wanted).toLowerCase();
}

function operatorMatches(operator) {
  if (!operator) return true;
  return operator === F.OPERATOR_ID || operator === "Оператор A";
}

function sortKey(item, key) {
  if (key === "id") return item.conversation_id;
  if (key === "total") return item.final_total;
  if (key === "evaluatedAt") return null;
  if (key === "language") return item.language;
  return item[key];
}

export function createMock(options = {}) {
  let store = freshStore(options);
  const state = options.state || null;

  async function behave() {
    if (state === "error") throw fail(500, "mock_error", "Mock error");
    if (state === "loading") await new Promise(() => {});
    if (state === "slow") await new Promise((resolve) => setTimeout(resolve, options.slowMs ?? 1200));
  }

  function allowRole(expected) {
    if (options.role && options.role !== expected) throw fail(403, "role_forbidden", "Role " + options.role + " is not allowed to do this");
  }

  function visibleRows() {
    return state === "empty" ? [] : F.ROWS;
  }

  function appealRowOrThrow(id) {
    const appeal = store.appeals.find((a) => a.id === Number(id));
    if (!appeal) throw fail(404, "appeal_not_found", "Appeal not found");
    return appeal;
  }

  function validateAnswer(def, answer) {
    if (def.type === "scale") {
      const values = def.scale_steps.map((s) => s.value);
      if (!values.includes(Number(answer))) throw fail(422, "invalid_answer", "Answer is not a configured scale step");
      return Number(answer);
    }
    const value = String(answer).toLowerCase();
    if (value === "na" && def.na_allowed) return "na";
    if (value === "yes" || value === "no") return value;
    throw fail(422, "invalid_answer", "Invalid answer");
  }

  const impl = {
    async listConversations(filter = {}) {
      await behave();
      let rows = visibleRows().map((r) => ({ row: r, raw: rawListItem(store, r) }));
      if (filter.dataset) rows = rows.filter((x) => x.raw.group_id.toLowerCase() === String(filter.dataset).toLowerCase());
      if (filter.language) rows = rows.filter((x) => x.raw.language.toUpperCase() === String(filter.language).toUpperCase());
      if (filter.channel) rows = rows.filter((x) => matchesChannel(x.row, filter.channel));
      if (filter.versionId) rows = rows.filter((x) => x.raw.checklist_version_id === Number(filter.versionId));
      if (filter.appealStatus) rows = rows.filter((x) => x.raw.display_appeal_status === filter.appealStatus);
      if (filter.gross !== undefined && filter.gross !== null && filter.gross !== "") rows = rows.filter((x) => x.raw.gross_violation === Boolean(filter.gross));
      if (filter.q && String(filter.q).trim()) {
        const needle = String(filter.q).trim().toLowerCase();
        rows = rows.filter((x) => {
          if (x.row.id.toLowerCase().includes(needle)) return true;
          const messages = messagesFor(x.row);
          return Boolean(messages && messages.some((m) => m.text.toLowerCase().includes(needle)));
        });
      }
      const operator = filter.operator !== undefined ? filter.operator : options.operatorId;
      if (!operatorMatches(operator)) rows = [];
      const sort = filter.sort ? String(filter.sort) : "";
      if (sort) {
        const desc = sort.startsWith("-");
        const key = sort.replace(/^[-+]/, "");
        const present = rows.filter((x) => sortKey(x.raw, key) !== null && sortKey(x.raw, key) !== undefined);
        const missing = rows.filter((x) => sortKey(x.raw, key) === null || sortKey(x.raw, key) === undefined);
        present.sort((a, b) => {
          const av = sortKey(a.raw, key);
          const bv = sortKey(b.raw, key);
          const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
          return desc ? -cmp : cmp;
        });
        rows = present.concat(missing);
      }
      const total = rows.length;
      const evaluated = rows.filter((x) => x.raw.eval_status === "completed" || x.raw.eval_status === "needs_review").length;
      const offset = filter.offset || 0;
      const page = filter.limit ? rows.slice(offset, offset + filter.limit) : rows.slice(offset);
      return mapListResponse({ items: page.map((x) => x.raw), total, evaluated });
    },

    async getConversation(id) {
      await behave();
      const row = state === "empty" ? null : findRow(id);
      if (!row || !messagesFor(row)) throw fail(404, "conversation_not_found", "Conversation not found");
      return mapConversation(rawConversation(row));
    },

    async getEvaluation(conversationId, version) {
      await behave();
      const row = state === "empty" ? null : findRow(conversationId);
      if (!row || !messagesFor(row)) throw fail(404, "evaluation_not_found", "Evaluation not found");
      if (version !== undefined && version !== null && Number(version) !== versionIdFor(row)) throw fail(404, "evaluation_not_found", "Evaluation not found");
      const found = versionRaw(store, versionIdFor(row));
      return mapEvaluation(rawEvaluation(store, row), mapVersion(found.raw, found.cl.name));
    },

    async getEvaluationById(evaluationId) {
      await behave();
      const row = rowByEvaluationId(evaluationId);
      if (!row || (!messagesFor(row) && !row.answers)) throw fail(404, "not_found", "Evaluation not found");
      const found = versionRaw(store, versionIdFor(row));
      return mapEvaluation(rawEvaluation(store, row), mapVersion(found.raw, found.cl.name));
    },

    async listEvaluations(conversationId) {
      await behave();
      const row = findRow(conversationId);
      if (!row || !messagesFor(row)) return [];
      return [mapEvaluationSummary(rawEvaluation(store, row))];
    },

    async evaluate(conversationId, versionId) {
      await behave();
      allowRole("reviewer");
      const row = findRow(conversationId);
      if (!row || !messagesFor(row)) throw fail(404, "conversation_not_found", "Conversation not found");
      if (versionId !== undefined && versionId !== null && Number(versionId) !== versionIdFor(row)) throw fail(422, "version_mismatch", "Mock evaluates only the stored version");
      store.evaluatedAt[row.pk] = store.nowMs();
      return impl.getEvaluation(row.pk, versionIdFor(row));
    },

    async submitAppeal(evaluationId, criterionId, body = {}) {
      await behave();
      allowRole("operator");
      const row = rowByEvaluationId(evaluationId);
      if (!row || !messagesFor(row)) throw fail(404, "evaluation_not_found", "Evaluation not found");
      const config = configFor(store, versionIdFor(row));
      if (!config.criteria.some((c) => c.id === criterionId)) throw fail(404, "criterion_not_found", "Criterion not found");
      const comment = (body.comment || "").trim();
      if (!comment) throw fail(422, "comment_required", "Comment is required");
      const refs = [...new Set((body.refs || []).map((r) => (typeof r === "object" ? r.index : r)))].sort((a, b) => a - b);
      const messages = messagesFor(row);
      if (refs.some((i) => !messages.some((m) => m.message_index === i))) throw fail(422, "invalid_message_ref", "Message reference is outside the conversation");
      if (store.appeals.some((a) => a.rowPk === row.pk && a.criterionId === criterionId && a.decidedMs === null)) {
        throw fail(409, "appeal_open_exists", "An open appeal already exists for this criterion");
      }
      const appeal = {
        id: store.nextAppealId,
        rowPk: row.pk,
        criterionId,
        comment,
        refs,
        createdMs: store.nowMs(),
        reviewStartedMs: null,
        decision: null,
        newAnswer: null,
        reason: null,
        decidedMs: null,
        totalBefore: null,
        totalAfter: null,
        original: null,
        fragment: refs.map((i) => {
          const m = messages.find((x) => x.message_index === i);
          return { index: i, time: m.timestamp_raw, speaker: m.speaker, text: m.text };
        })
      };
      store.nextAppealId += 1;
      store.appeals.push(appeal);
      return mapAppeal(rawAppealBase(store, appeal, row));
    },

    async startReview(appealId) {
      await behave();
      allowRole("reviewer");
      const appeal = appealRowOrThrow(appealId);
      if (appeal.decidedMs !== null) throw fail(409, "appeal_resolved", "Appeal is already resolved");
      if (appeal.reviewStartedMs === null) appeal.reviewStartedMs = store.nowMs();
      return mapAppeal(rawAppealBase(store, appeal, rowByPk(appeal.rowPk)));
    },

    async decideAppeal(appealId, body = {}) {
      await behave();
      allowRole("reviewer");
      const appeal = appealRowOrThrow(appealId);
      if (appeal.decidedMs !== null) throw fail(409, "appeal_resolved", "Appeal is already resolved");
      if (body.decision !== "confirm" && body.decision !== "change") throw fail(422, "invalid_decision", "Decision must be confirm or change");
      const reason = (body.reason || "").trim();
      if (!reason) throw fail(422, "reason_required", "Reason is required");
      const row = rowByPk(appeal.rowPk);
      const def = configFor(store, versionIdFor(row)).criteria.find((c) => c.id === appeal.criterionId);
      let newAnswer = null;
      if (body.decision === "change") {
        if (body.newAnswer === undefined || body.newAnswer === null) throw fail(422, "answer_required", "A new answer is required");
        newAnswer = validateAnswer(def, body.newAnswer);
      }
      if (appeal.reviewStartedMs === null) appeal.reviewStartedMs = store.nowMs();
      applyDecision(store, appeal, body.decision, newAnswer, reason, store.nowMs());
      return mapAppeal(rawAppealBase(store, appeal, row));
    },

    async listAppeals(filter = {}) {
      await behave();
      if (state === "empty") return [];
      const status = filter.status || "all";
      const operator = filter.operator !== undefined ? filter.operator : options.operatorId;
      if (!operatorMatches(operator)) return [];
      let list = store.appeals.slice();
      if (status === "open") list = list.filter((a) => a.decidedMs === null);
      else if (status === "resolved") list = list.filter((a) => a.decidedMs !== null);
      else if (status !== "all") list = list.filter((a) => displayStatus(a) === status);
      list.sort((a, b) => a.createdMs - b.createdMs || a.id - b.id);
      return mapAppealList(list.map((a) => rawAppealFull(store, a)));
    },

    async getAppeal(id) {
      await behave();
      const appeal = appealRowOrThrow(id);
      return mapAppeal(rawAppealFull(store, appeal));
    },

    async appealSummary() {
      await behave();
      const open = state === "empty" ? [] : store.appeals.filter((a) => a.decidedMs === null);
      const resolved = state === "empty" ? [] : store.appeals.filter((a) => a.decidedMs !== null);
      const spans = resolved.map((a) => (a.decidedMs - a.createdMs) / HOUR).sort((a, b) => a - b);
      let median = 0;
      if (spans.length) {
        const mid = Math.floor(spans.length / 2);
        median = spans.length % 2 ? spans[mid] : (spans[mid - 1] + spans[mid]) / 2;
      }
      return mapAppealSummary({
        open: open.length,
        new: open.filter((a) => a.reviewStartedMs === null).length,
        under_review: open.filter((a) => a.reviewStartedMs !== null).length,
        older_than_hours: open.filter((a) => (store.nowMs() - a.createdMs) / HOUR > AGING_HOURS).length,
        aging_hours: AGING_HOURS,
        median_resolution_hours: round2(median)
      });
    },

    async getOverview(filter = {}) {
      await behave();
      if (state === "empty") {
        const empty = clone(F.OVERVIEW);
        empty.kpis = { ...empty.kpis, avg: null, delta: null, previous_avg: null, evaluated: 0, chats: 0, calls: 0, gross_count: 0, gross_share: null, open_appeals: 0, older_than_hours: 0, median_resolution_days: null };
        empty.distribution = empty.distribution.map((b) => ({ ...b, count: 0 }));
        empty.per_criterion = [];
        empty.by_language = [];
        empty.by_channel = [];
        empty.attention = [];
        empty.attention_total = 0;
        return mapOverview(empty);
      }
      const raw = narrowOverview(clone(F.OVERVIEW), filter);
      const order = { gross: 0, low_score: 1, appeal_pending: 2, low_confidence: 3 };
      const attention = [];
      for (const row of F.ROWS) {
        if (row.failed) continue;
        if (filter.language && row.language !== String(filter.language).toUpperCase()) continue;
        if (filter.channel && !matchesChannel(row, filter.channel)) continue;
        const { final, original } = calc(store, row);
        const display = rowDisplayAppeal(store, row);
        const reasons = [];
        if (final.grossViolation === true) reasons.push("gross");
        if (final.total !== null && final.total < 50) reasons.push("low_score");
        if (display === "new" || display === "under_review") reasons.push("appeal_pending");
        if (original.provisional) reasons.push("low_confidence");
        if (!reasons.length) continue;
        attention.push({
          conversation_pk: row.pk,
          conversation_id: row.id,
          evaluation_id: evalIdFor(row),
          language: row.language,
          reason: reasons[0],
          reasons,
          score: final.total,
          provisional: original.provisional,
          appeal_status: display
        });
      }
      attention.sort((a, b) => order[a.reason] - order[b.reason] || (a.score ?? 101) - (b.score ?? 101));
      raw.attention = attention.slice(0, filter.attentionLimit || 20);
      raw.attention_total = attention.length;
      return mapOverview(raw);
    },

    async listChecklists() {
      await behave();
      return mapChecklists(store.checklists.map((cl) => rawChecklist(store, cl)));
    },

    async getChecklist(id) {
      await behave();
      const cl = store.checklists.find((c) => c.id === Number(id));
      if (!cl) throw fail(404, "http_404", "Checklist not found");
      return mapChecklist(rawChecklist(store, cl));
    },

    async getChecklistVersion(id) {
      await behave();
      const found = versionRaw(store, Number(id));
      if (!found) throw fail(404, "http_404", "Checklist version not found");
      return mapVersion(found.raw, found.cl.name);
    },

    async saveChecklistVersion(checklistId, config, options2 = {}) {
      await behave();
      allowRole("reviewer");
      const cl = store.checklists.find((c) => c.id === Number(checklistId));
      if (!cl) throw fail(404, "http_404", "Checklist not found");
      const status = options2.status === "draft" ? "draft" : "saved";
      const problem = status === "draft" ? structuralProblem(config) : completenessProblem(config);
      if (problem) throw fail(422, "http_422", problem);
      const id = store.nextVersionId;
      store.nextVersionId += 1;
      const version = Math.max(0, ...cl.versions.map((v) => v.version)) + 1;
      cl.versions.push({ id, version, createdAt: iso(store.nowMs()), status, appliedCount: 0, firstAppliedAt: null });
      store.configs[id] = clone(config);
      const found = versionRaw(store, id);
      return mapVersion(found.raw, cl.name);
    },

    async createChecklistDraft(config, options2 = {}) {
      await behave();
      allowRole("reviewer");
      const problem = structuralProblem(config);
      if (problem) throw fail(422, "http_422", problem);
      const channels = [];
      for (const ch of options2.channels || []) {
        const text = String(ch).trim();
        if (text && !channels.some((c) => c.toLowerCase() === text.toLowerCase())) channels.push(text);
      }
      const checklistId = store.nextChecklistId;
      store.nextChecklistId += 1;
      const id = store.nextVersionId;
      store.nextVersionId += 1;
      const cl = {
        id: checklistId,
        name: config.name,
        channels,
        defaultVersionId: null,
        versions: [{ id, version: 1, createdAt: iso(store.nowMs()), status: "draft", appliedCount: 0, firstAppliedAt: null }]
      };
      store.checklists.push(cl);
      store.configs[id] = clone(config);
      const found = versionRaw(store, id);
      return mapVersion(found.raw, cl.name);
    },

    async deleteDraft(versionId) {
      await behave();
      allowRole("reviewer");
      const found = versionRaw(store, Number(versionId));
      if (!found) throw fail(404, "http_404", "Checklist version not found");
      if (found.v.status !== "draft") throw fail(409, "http_409", "Only drafts can be deleted");
      found.cl.versions = found.cl.versions.filter((v) => v.id !== found.v.id);
      delete store.configs[found.v.id];
      if (found.cl.versions.length === 0) store.checklists = store.checklists.filter((c) => c.id !== found.cl.id);
    },

    async updateDraft(versionId, config) {
      await behave();
      allowRole("reviewer");
      const found = versionRaw(store, Number(versionId));
      if (!found) throw fail(404, "http_404", "Checklist version not found");
      if (found.v.status !== "draft") throw fail(409, "http_409", "Only drafts can be edited");
      const problem = structuralProblem(config);
      if (problem) throw fail(422, "http_422", problem);
      store.configs[found.v.id] = clone(config);
      const again = versionRaw(store, found.v.id);
      return mapVersion(again.raw, found.cl.name);
    },

    async finalizeVersion(versionId) {
      await behave();
      allowRole("reviewer");
      const found = versionRaw(store, Number(versionId));
      if (!found) throw fail(404, "http_404", "Checklist version not found");
      if (found.v.status !== "draft") throw fail(409, "http_409", "Only drafts can be saved");
      const problem = completenessProblem(store.configs[found.v.id]);
      if (problem) throw fail(422, "http_422", problem);
      found.v.status = "saved";
      const again = versionRaw(store, found.v.id);
      return mapVersion(again.raw, found.cl.name);
    },

    async setActiveVersion(checklistId, versionId) {
      await behave();
      allowRole("reviewer");
      const cl = store.checklists.find((c) => c.id === Number(checklistId));
      const v = cl && cl.versions.find((x) => x.id === Number(versionId));
      if (!v) throw fail(404, "http_404", "Checklist version not found");
      if (v.status === "draft") throw fail(422, "http_422", "A draft cannot be made default");
      const previous = cl.versions.find((x) => x.id === cl.defaultVersionId);
      if (previous && previous.id !== v.id) previous.wasActive = true;
      v.wasActive = false;
      cl.defaultVersionId = v.id;
      const found = versionRaw(store, v.id);
      return mapVersion(found.raw, cl.name);
    },

    async setChecklistChannels(checklistId, channels) {
      await behave();
      allowRole("reviewer");
      const cl = store.checklists.find((c) => c.id === Number(checklistId));
      if (!cl) throw fail(404, "http_404", "Checklist not found");
      cl.channels = (channels || []).slice();
      return mapChecklist(rawChecklist(store, cl));
    },

    async listDatasets() {
      await behave();
      return state === "empty" ? [] : store.datasets.map(mapDataset);
    },

    async importDataset(input = {}) {
      await behave();
      allowRole("reviewer");
      const groupId = input.groupId || (input.file && input.file.name) || "";
      if (!groupId) throw fail(422, "group_id_required", "group_id is required");
      let ds = store.datasets.find((d) => d.group_id === groupId);
      const created = !ds;
      if (!ds) {
        ds = {
          id: store.datasets.length + 1,
          group_id: groupId,
          label: input.file ? "Файл · " + input.file.name : groupId,
          kind: "control",
          source: input.file ? "file" : "api",
          source_filename: input.file ? input.file.name : null,
          imported_at: iso(store.nowMs()),
          conversations: Number(input.file && input.file.conversations) || 10,
          chats: null,
          calls: null
        };
        store.datasets.push(ds);
      }
      return { ...mapDataset(ds), created: created ? ds.conversations : 0, updated: created ? 0 : ds.conversations };
    },

    async listModels() {
      await behave();
      return clone(F.MODELS);
    },

    async estimateRun(input = {}) {
      await behave();
      const model = F.MODELS.find((m) => m.id === input.model || m.label === input.model) || F.MODELS[0];
      let count = input.count;
      if (count === undefined || count === null) {
        const ds = store.datasets.find((d) => d.group_id === input.groupId);
        count = ds ? ds.conversations : (input.conversationIds || []).length;
      }
      return { count, model: model.id, pricePerEvaluation: model.pricePerEvaluation, cost: Math.round(count * model.pricePerEvaluation * 10000) / 10000, currency: "USD" };
    },

    async startRun(input = {}) {
      await behave();
      allowRole("reviewer");
      const ids = input.conversationIds || null;
      if (!input.groupId && !input.file && !(ids && ids.length)) throw fail(422, "dataset_required", "dataset or conversation_pks is required");
      const versionId = input.versionId || 12;
      const found = versionRaw(store, Number(versionId));
      if (!found) throw fail(404, "http_404", "Checklist version not found");
      if (found.v.status === "draft") throw fail(422, "draft_version", "Draft checklist versions cannot be evaluated");
      const model = F.MODELS.find((m) => m.id === input.model || m.label === input.model) || F.MODELS[0];
      let total;
      let datasetLabel;
      let groupId = input.groupId || null;
      if (ids && ids.length) {
        total = ids.length;
        datasetLabel = "Выбранные диалоги";
        groupId = groupId || "selection";
      } else if (input.file) {
        const ds = await impl.importDataset({ file: input.file, groupId: input.groupId });
        total = ds.conversations;
        groupId = ds.groupId;
        datasetLabel = ds.label;
      } else {
        const ds = store.datasets.find((d) => d.group_id === input.groupId);
        if (!ds) throw fail(404, "http_404", "Dataset not found");
        total = ds.conversations;
        datasetLabel = ds.label;
      }
      let items;
      if (ids && ids.length) {
        items = ids.map((id) => findRow(id)).filter(Boolean).map((r) => ({ rowPk: r.pk, status: "queued", latencyMs: null }));
      } else {
        items = F.ROWS.slice(0, Math.min(8, total)).map((r) => ({ rowPk: r.pk, status: "queued", latencyMs: null }));
      }
      const run = {
        number: store.nextRun,
        groupId,
        datasetLabel,
        versionId: found.v.id,
        checklistLabel: versionLabel(found.v.version),
        model: model.label,
        status: "running",
        force: Boolean(input.force),
        total,
        skipped: 0,
        done: 0,
        failed: 0,
        running: 0,
        queued: total,
        cancelled: 0,
        error: null,
        startedMs: store.nowMs(),
        finishedMs: null,
        items,
        averageTotal: null
      };
      found.v.appliedCount += total - run.skipped;
      if (!found.v.firstAppliedAt) found.v.firstAppliedAt = iso(store.nowMs());
      store.nextRun += 1;
      store.runs.unshift(run);
      return mapRun(rawRun(store, run, { offset: 0, limit: 50 }));
    },

    async getRun(id, paging = {}) {
      await behave();
      const run = store.runs.find((r) => r.number === runNumber(id));
      if (!run) throw fail(404, "http_404", "Run not found");
      if (run.status === "cancelling") advanceRun(store, run);
      const snapshot = mapRun(rawRun(store, run, { offset: paging.offset || 0, limit: paging.limit || 50 }));
      advanceRun(store, run);
      return snapshot;
    },

    async listRuns(paging = {}) {
      await behave();
      if (state === "empty") return [];
      const offset = paging.offset || 0;
      const limit = paging.limit || 50;
      return store.runs.slice(offset, offset + limit).map((r) => mapRun(rawRun(store, r)));
    },

    async retryRunItem(runId, conversationId) {
      await behave();
      allowRole("reviewer");
      const run = store.runs.find((r) => r.number === runNumber(runId));
      if (!run) throw fail(404, "http_404", "Run not found");
      const row = findRow(conversationId);
      const item = row && run.items.find((i) => i.rowPk === row.pk);
      if (!item || item.status !== "failed") throw fail(409, "http_409", "Only failed items can be retried");
      item.status = "queued";
      item.error = null;
      run.failed -= 1;
      run.queued += 1;
      run.status = "running";
      run.finishedMs = null;
      return mapRun(rawRun(store, run, { offset: 0, limit: 50 }));
    },

    async cancelRun(runId) {
      await behave();
      allowRole("reviewer");
      const run = store.runs.find((r) => r.number === runNumber(runId));
      if (!run) throw fail(404, "run_not_found", "Run not found");
      if (["completed", "failed", "cancelled"].includes(run.status)) throw fail(409, "run_not_active", "Run is not active");
      if (run.status === "cancelling") return mapRun(rawRun(store, run));
      for (const item of run.items) if (item.status === "queued") item.status = "cancelled";
      run.cancelled = (run.cancelled || 0) + run.queued;
      run.queued = 0;
      if (run.status === "interrupted" || run.running === 0) {
        run.status = "cancelled";
        run.running = 0;
        run.finishedMs = store.nowMs();
        return mapRun(rawRun(store, run));
      }
      run.status = "cancelling";
      return mapRun(rawRun(store, run));
    },

    async getWaveform(conversationId) {
      await behave();
      const row = findRow(conversationId);
      if (!row || channelKind(row.channel) !== "call" || !messagesFor(row)) throw fail(404, "conversation_not_found", "Conversation not found");
      const bins = 80;
      const duration = 164;
      const peaks = [];
      for (let i = 0; i < bins; i += 1) {
        const t = (i / bins) * duration;
        const hold = t > 75 && t < 156;
        const h = hold ? 3 : Math.round(8 + Math.abs(Math.sin(i * 1.7) * 18 + Math.sin(i * 0.37) * 12));
        peaks.push(Math.min(40, h));
      }
      return { bins, durationSeconds: duration, peaks };
    }
  };

  return {
    impl,
    audioUrl() {
      return null;
    },
    reset(next = {}) {
      store = freshStore({ ...options, ...next });
    },
    clock() {
      return store.nowMs();
    }
  };
}
