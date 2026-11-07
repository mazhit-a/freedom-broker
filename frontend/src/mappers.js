import { score, NEEDS_REVIEW } from "./scoring.js";

export const OPERATOR_LABEL = "Оператор A";
export const REVIEWER_LABEL = "QA / Проверяющий";

const DISPLAY_STATUSES = ["new", "under_review", "confirmed", "changed"];

export function channelKind(channel) {
  return /call|voice|звон/i.test(String(channel || "")) ? "call" : "chat";
}

export function versionLabel(version) {
  return version === null || version === undefined ? null : "v" + version;
}

export function mapAnswer(raw) {
  if (raw === null || raw === undefined) return NEEDS_REVIEW;
  if (typeof raw === "number") return raw;
  if (typeof raw === "boolean") return raw ? "yes" : "no";
  const text = String(raw).trim().toLowerCase();
  if (text === "yes" || text === "true") return "yes";
  if (text === "no" || text === "false") return "no";
  if (text === "na" || text === "n/a" || text === "not_applicable") return "na";
  if (text === "needs_review") return NEEDS_REVIEW;
  if (/^-?\d+$/.test(text)) return Number(text);
  return raw;
}

export function wireAnswer(answer) {
  if (answer === "yes" || answer === "no" || answer === "na") return answer;
  return typeof answer === "number" ? String(answer) : answer;
}

export function clock(raw) {
  const text = String(raw ?? "");
  const iso = /T(\d{2}:\d{2}:\d{2})/.exec(text);
  if (iso) return iso[1];
  return text;
}

export function mapMessage(raw) {
  const index = raw.message_index;
  return {
    index,
    n: index + 1,
    time: clock(raw.timestamp_raw),
    timestamp: raw.timestamp_raw ?? null,
    offsetSeconds: raw.offset_seconds ?? null,
    speaker: raw.speaker,
    text: raw.text,
    audioStart: raw.audio_start_seconds ?? null,
    audioEnd: raw.audio_end_seconds ?? null
  };
}

export function mapConversation(raw) {
  const messages = (raw.messages || []).map(mapMessage);
  return {
    id: raw.conversation_id,
    pk: raw.id,
    datasetId: raw.dataset_id ?? null,
    groupId: raw.group_id ?? null,
    channel: channelKind(raw.channel),
    channelRaw: raw.channel ?? null,
    language: raw.language ?? null,
    operator: OPERATOR_LABEL,
    hasAudio: Boolean(raw.has_audio),
    occurredAt: raw.occurred_at ?? null,
    durationSeconds: raw.duration_seconds ?? null,
    messages
  };
}

function mapConfidence(raw) {
  if (!raw) return null;
  return { level: raw.level, withRationale: raw.with_rationale, total: raw.total };
}

function mapListSections(list) {
  if (!Array.isArray(list)) return null;
  return list.map((s) => ({ id: s.id, effectivePoints: s.effective_points, effectiveMax: s.effective_max }));
}

export function mapListItem(raw) {
  const evaluated = raw.evaluation_id !== null && raw.evaluation_id !== undefined;
  const failed = raw.eval_status === "failed";
  const confidence = mapConfidence(raw.confidence);
  const total = failed || !evaluated ? null : raw.final_total ?? raw.total ?? null;
  const provisional = Boolean(raw.provisional);
  return {
    id: raw.conversation_id,
    pk: raw.id,
    groupId: raw.group_id ?? null,
    channel: channelKind(raw.channel),
    language: raw.language ?? null,
    operator: OPERATOR_LABEL,
    hasAudio: Boolean(raw.has_audio),
    messageCount: raw.message_count ?? null,
    evaluationId: raw.evaluation_id ?? null,
    evaluated,
    failed,
    status: raw.eval_status ?? null,
    total,
    originalTotal: raw.total ?? null,
    totalChanged: Boolean(raw.total_changed),
    totalStatus: raw.total_status ?? null,
    calculated: total !== null,
    provisional,
    lowConfidence: provisional || (confidence !== null && confidence.level === "low"),
    confidence,
    gross: raw.gross_violation === null || raw.gross_violation === undefined ? null : Boolean(raw.gross_violation),
    sections: mapListSections(raw.sections),
    appealStatus: raw.display_appeal_status || (raw.appeal_status && raw.appeal_status !== "none" ? raw.appeal_status : "none"),
    versionId: raw.checklist_version_id ?? null,
    versionLabel: raw.checklist_version_number ? versionLabel(raw.checklist_version_number) : null,
    checklistName: raw.checklist_name ?? null,
    modelLabel: raw.model_label ?? null,
    occurredAt: raw.occurred_at ?? null,
    evaluatedAt: raw.evaluated_at ?? null,
    durationSeconds: raw.duration_seconds ?? null
  };
}

export function mapListResponse(body, paging = {}) {
  if (Array.isArray(body)) {
    const items = body.map(mapListItem);
    const start = paging.offset || 0;
    const page = paging.limit ? items.slice(start, start + paging.limit) : items.slice(start);
    return { items: page, total: items.length, evaluated: items.filter((i) => i.evaluated && !i.failed).length };
  }
  return {
    items: (body.items || []).map(mapListItem),
    total: body.total ?? 0,
    evaluated: body.evaluated ?? 0
  };
}

function mapRange(raw) {
  if (!raw) return null;
  const from = raw.from;
  const to = raw.to;
  return { from, to, fromN: from + 1, toN: to + 1 };
}

function mapEvidence(list) {
  return (list || [])
    .filter((e) => e && typeof e === "object" && "message_index" in e)
    .map((e) => ({ index: e.message_index, n: e.message_index + 1, quote: e.quote ?? "" }));
}

export function mapSteps(list) {
  return (list || []).map((s) => ({ value: s.value, descriptor: s.descriptor ?? "" }));
}

function safeScore(config, answers) {
  try {
    return score(config, answers);
  } catch (err) {
    return null;
  }
}

function indexBy(list, key) {
  const out = {};
  for (const item of list || []) out[item[key]] = item;
  return out;
}

export function mapAppeal(raw, extra = {}) {
  const criterion = raw.criterion || extra.criterion || null;
  const original = raw.original || null;
  const display = raw.display_status || (raw.status === "resolved" ? (raw.decision === "change" ? "changed" : "confirmed") : "new");
  const refs = (raw.message_refs || []).map((index) => ({ index, n: index + 1 }));
  return {
    id: raw.id,
    evaluationId: raw.evaluation_id,
    conversationId: raw.conversation_id ?? extra.conversationId ?? null,
    conversationPk: raw.conversation_pk ?? extra.conversationPk ?? null,
    channel: raw.channel ? channelKind(raw.channel) : extra.channel ?? null,
    language: raw.language ?? extra.language ?? null,
    criterionId: raw.criterion_id,
    criterionTitle: criterion ? criterion.title : null,
    criterionLabels: criterion ? criterion.labels ?? null : null,
    criterionType: criterion ? criterion.type : null,
    criterionWeight: criterion ? criterion.weight : null,
    criterionSteps: criterion ? mapSteps(criterion.scale_steps) : [],
    naAllowed: criterion ? Boolean(criterion.na_allowed) : null,
    comment: raw.comment ?? "",
    refs,
    status: display,
    open: raw.status === "open",
    author: OPERATOR_LABEL,
    authorRole: raw.author_role ?? null,
    createdAt: raw.created_at,
    ageHours: raw.age_hours ?? null,
    reviewStartedAt: raw.review_started_at ?? null,
    decision: raw.decision ?? null,
    newAnswer: raw.new_answer === null || raw.new_answer === undefined ? null : mapAnswer(raw.new_answer),
    reason: raw.reason ?? null,
    decidedAt: raw.decided_at ?? null,
    decidedBy: raw.decided_by_role || raw.decision ? REVIEWER_LABEL : null,
    totalBefore: raw.total_before ?? null,
    totalAfter: raw.total_after ?? null,
    original: original
      ? {
          answer: mapAnswer(original.answer),
          points: original.points ?? null,
          effPoints: original.effective_points ?? null,
          rationale: original.rationale ?? "",
          naReason: original.na_reason ?? null,
          evidence: mapEvidence(original.evidence),
          expected: mapRange(original.checked_range)
        }
      : null,
    fragment: (raw.fragment || []).map(mapMessage),
    versionLabel: raw.checklist_version_label ?? null,
    modelLabel: raw.model_label ?? null
  };
}

export function mapAppealList(body) {
  return (body || []).map((a) => mapAppeal(a));
}

export function mapAppealSummary(raw) {
  return {
    open: raw.open,
    new: raw.new,
    underReview: raw.under_review,
    olderThanHours: raw.older_than_hours,
    agingHours: raw.aging_hours,
    medianResolutionHours: raw.median_resolution_hours
  };
}

function lastAppealByCriterion(appeals) {
  const out = {};
  for (const a of appeals || []) out[a.criterion_id] = a;
  return out;
}

export function mapEvaluation(raw, version = null) {
  const config = version ? version.config : null;
  const finalBlock = raw.final || null;
  const originalBlock = raw.original || null;
  const results = indexBy(raw.criteria, "criterion_id");
  const finals = indexBy(finalBlock ? finalBlock.criteria : [], "criterion_id");
  const originals = indexBy(originalBlock ? originalBlock.criteria : [], "criterion_id");
  const appealsByCriterion = lastAppealByCriterion(raw.appeals);
  const answers = {};
  for (const id of Object.keys(results)) {
    const f = finals[id];
    const src = f || results[id];
    answers[id] = src.answer === null || src.answer === undefined ? null : src.answer;
  }
  const calc = config ? safeScore(config, answers) : null;
  const ledger = indexBy(calc ? calc.criteria : [], "id");
  const defs = config ? config.criteria : Object.keys(results).map((id) => ({ id }));
  const criteria = defs.map((def) => {
    const res = results[def.id] || {};
    const fin = finals[def.id] || null;
    const orig = originals[def.id] || res;
    const led = ledger[def.id];
    const appeal = appealsByCriterion[def.id];
    const answer = mapAnswer(fin ? fin.answer : res.answer);
    return {
      id: def.id,
      number: def.id,
      title: def.title ?? null,
      labels: def.labels ?? null,
      description: def.description ?? null,
      section: def.section ?? null,
      type: def.type ?? null,
      naAllowed: Boolean(def.na_allowed),
      naCondition: def.na_condition ?? null,
      steps: mapSteps(def.scale_steps),
      maxStep: def.max_step ?? null,
      weight: def.weight ?? null,
      effWeight: led ? led.effectiveWeight : null,
      answer,
      originalAnswer: mapAnswer(orig.answer),
      points: fin ? fin.points ?? null : res.points ?? null,
      effPoints: fin ? fin.effective_points ?? null : res.effective_points ?? null,
      overridden: fin ? Boolean(fin.overridden) : false,
      rationale: res.rationale ?? "",
      naReason: res.na_reason ?? null,
      needsReview: Boolean(res.needs_review) || answer === NEEDS_REVIEW,
      evidence: mapEvidence(res.evidence),
      expected: mapRange(res.checked_range),
      appeal: appeal ? { id: appeal.id, status: appeal.display_status || (appeal.status === "open" ? "new" : "confirmed") } : null
    };
  });
  const confidence = mapConfidence(raw.confidence);
  const provisional = Boolean(finalBlock ? finalBlock.provisional : raw.provisional);
  const total = raw.final_total ?? (finalBlock ? finalBlock.total : raw.total) ?? null;
  const sections = (finalBlock && finalBlock.sections ? finalBlock.sections : []).map((s) => ({
    id: s.id,
    title: s.title,
    earned: s.earned ?? null,
    applicableMax: s.applicable_max ?? null,
    percent: s.percent ?? null,
    effectivePoints: s.effective_points ?? null,
    effectiveMax: s.effective_max ?? null
  }));
  return {
    id: raw.id,
    conversationPk: raw.conversation_id,
    versionId: raw.checklist_version_id,
    versionLabel: version ? version.label : null,
    checklistName: version ? version.name : null,
    config,
    model: raw.model ?? null,
    modelLabel: raw.model_label ?? raw.model ?? null,
    status: raw.status,
    createdAt: raw.created_at,
    total,
    originalTotal: raw.total ?? null,
    totalChanged: Boolean(raw.total_changed),
    totalStatus: raw.total_status ?? null,
    calculated: finalBlock ? Boolean(finalBlock.calculated) : total !== null,
    reason: finalBlock ? finalBlock.reason ?? null : null,
    provisional,
    lowConfidence: provisional || (confidence !== null && confidence.level === "low") || criteria.some((c) => c.needsReview),
    confidence,
    grossViolation: finalBlock ? finalBlock.gross_violation ?? null : raw.gross_violation ?? null,
    applicableWeight: calc ? calc.applicableWeight : null,
    factor: calc ? calc.factor : null,
    criteria,
    sections,
    appeals: (raw.appeals || []).map((a) => mapAppeal(a)),
    appealStatus: raw.display_appeal_status || "none",
    appealDeadline: raw.appeal_deadline ?? null,
    appealWindowWorkdays: raw.appeal_window_workdays ?? null,
    occurredAt: raw.occurred_at ?? null,
    durationSeconds: raw.duration_seconds ?? null,
    cost: raw.cost ?? null,
    tokensIn: raw.tokens_input ?? null,
    tokensOut: raw.tokens_output ?? null,
    latencyMs: raw.latency_ms ?? null
  };
}

export function mapEvaluationSummary(raw) {
  return {
    id: raw.id,
    versionId: raw.checklist_version_id,
    createdAt: raw.created_at,
    status: raw.status,
    total: raw.final_total ?? raw.total ?? null,
    modelLabel: raw.model_label ?? raw.model ?? null
  };
}

export function mapVersionSummary(raw, defaultVersionId = null) {
  const isDefault = raw.is_default ?? raw.id === defaultVersionId;
  const status = raw.status || (isDefault ? "active" : "saved");
  return {
    id: raw.id,
    checklistId: raw.checklist_id ?? null,
    version: raw.version,
    label: versionLabel(raw.version),
    status,
    isDefault: Boolean(isDefault),
    createdAt: raw.created_at ?? null,
    criteriaCount: raw.criteria_count ?? null,
    weightSum: raw.weight_sum ?? null,
    appliedCount: raw.applied_count ?? 0,
    firstAppliedAt: raw.first_applied_at ?? null,
    locked: status !== "draft"
  };
}

export function mapVersion(raw, name = null) {
  return {
    ...mapVersionSummary(raw),
    name: raw.config ? raw.config.name : name,
    config: raw.config,
    warnings: raw.warnings || []
  };
}

export function mapChecklist(raw) {
  return {
    id: raw.id,
    name: raw.name,
    channels: raw.channels || [],
    defaultVersionId: raw.default_version_id ?? null,
    versions: (raw.versions || []).map((v) => ({ ...mapVersionSummary(v, raw.default_version_id), checklistId: raw.id }))
  };
}

export function mapChecklists(list) {
  return (list || []).map(mapChecklist);
}

export function mapDataset(raw) {
  return {
    id: raw.id,
    groupId: raw.group_id,
    label: raw.label || raw.group_id,
    kind: raw.kind || (String(raw.group_id).toUpperCase() === "DEV" ? "dev" : "control"),
    source: raw.source ?? null,
    sourceFilename: raw.source_filename ?? null,
    importedAt: raw.imported_at ?? null,
    conversations: raw.conversations ?? null,
    chats: raw.chats ?? null,
    calls: raw.calls ?? null
  };
}

export function runLabel(id) {
  if (typeof id === "string" && /^R-/.test(id)) return id;
  return "R-" + String(id).padStart(4, "0");
}

export function runNumber(id) {
  if (typeof id === "number") return id;
  const text = String(id).replace(/^R-/i, "");
  return Number(text);
}

export function mapRunItem(raw) {
  return {
    conversationPk: raw.conversation_pk ?? null,
    conversationId: raw.conversation_id,
    channel: raw.channel ? channelKind(raw.channel) : null,
    language: raw.language ?? null,
    status: raw.status,
    evaluationId: raw.evaluation_id ?? null,
    latencyMs: raw.latency_ms ?? null,
    total: raw.total ?? null,
    gross: raw.gross === null || raw.gross === undefined ? null : Boolean(raw.gross),
    error: raw.error ?? null,
    otherVersionTotal: raw.other_version_total ?? null
  };
}

export function mapRun(raw) {
  const failures = raw.failures || [];
  return {
    id: runLabel(raw.code || raw.run_id || raw.id),
    number: raw.run_id ?? raw.id,
    groupId: raw.dataset ?? null,
    datasetLabel: raw.dataset_label ?? raw.dataset ?? null,
    versionId: raw.checklist_version_id ?? null,
    checklistLabel: raw.checklist_label ?? null,
    versionLabel: (/\b(v\d+)\s*$/.exec(raw.checklist_label || "") || [])[1] ?? null,
    model: raw.model ?? null,
    status: raw.status,
    force: Boolean(raw.force),
    total: raw.total ?? 0,
    skipped: raw.skipped ?? 0,
    toRun: raw.to_run ?? null,
    processed: raw.processed ?? 0,
    done: raw.done ?? (raw.completed ?? 0) + (raw.needs_review ?? 0),
    needsReview: raw.needs_review ?? 0,
    failed: raw.failed ?? 0,
    running: raw.running ?? raw.in_flight ?? 0,
    queued: raw.queued ?? null,
    percent: raw.percent ?? 0,
    averageTotal: raw.average_total ?? null,
    cost: raw.cost_total ?? null,
    tokensIn: raw.tokens_in ?? null,
    tokensOut: raw.tokens_out ?? null,
    elapsedSeconds: raw.elapsed_s ?? null,
    etaSeconds: raw.eta_s ?? null,
    startedAt: raw.started_at ?? null,
    finishedAt: raw.finished_at ?? null,
    failures: failures.map((f) => ({ conversationPk: f.conversation_pk ?? null, conversationId: f.conversation_id ?? null, error: f.error })),
    items: Array.isArray(raw.items) ? raw.items.map(mapRunItem) : [],
    itemsTotal: raw.items_total ?? (Array.isArray(raw.items) ? raw.items.length : 0)
  };
}

export function mapModel(raw) {
  return {
    id: raw.id,
    label: raw.label || raw.id,
    paid: Boolean(raw.paid),
    default: Boolean(raw.default),
    pricePerEvaluation: raw.price_per_evaluation ?? 0,
    priceSource: raw.price_source ?? null,
    measuredEvaluations: raw.measured_evaluations ?? 0,
    avgLatencySeconds: raw.avg_latency_s ?? null,
    note: null
  };
}

export function mapEstimate(raw) {
  return {
    count: raw.to_run,
    total: raw.total,
    skipped: raw.skipped ?? 0,
    model: raw.model,
    pricePerEvaluation: raw.price_per_evaluation,
    priceSource: raw.price_source ?? null,
    cost: raw.cost_estimate,
    secondsEstimate: raw.seconds_estimate ?? null,
    concurrency: raw.concurrency ?? null,
    versionId: raw.checklist_version_id ?? null,
    currency: raw.currency || "USD"
  };
}

export function mapOverview(raw) {
  const k = raw.kpis || {};
  return {
    period: raw.period ? { basis: raw.period.basis, from: raw.period.from, to: raw.period.to, previousFrom: raw.period.previous_from, previousTo: raw.period.previous_to } : null,
    kpis: {
      avgScore: k.avg ?? null,
      deltaVsPrev: k.delta ?? null,
      previousAvg: k.previous_avg ?? null,
      evaluatedCount: k.evaluated ?? 0,
      notCalculated: k.not_calculated ?? 0,
      chats: k.chats ?? 0,
      calls: k.calls ?? 0,
      grossShare: k.gross_share ?? null,
      grossCount: k.gross_count ?? 0,
      openAppeals: k.open_appeals ?? 0,
      olderThanCount: k.older_than_hours ?? 0,
      agingHours: k.aging_hours ?? null,
      medianResolutionDays: k.median_resolution_days ?? null,
      targetDays: k.target_days ?? null
    },
    distribution: (raw.distribution || []).map((b) => ({ from: b.range_from, to: b.range_to, count: b.count })),
    perCriterion: (raw.per_criterion || []).map((c) => ({
      id: c.criterion_id,
      title: c.title,
      labels: c.labels ?? null,
      avgPercent: c.avg_percent,
      applicableCount: c.applicable_count
    })),
    byLanguage: (raw.by_language || []).map((r) => ({ language: r.language, count: r.count, avg: r.avg, grossCount: r.gross_count, grossShare: r.gross_share })),
    byChannel: (raw.by_channel || []).map((r) => ({ channel: channelKind(r.channel), count: r.count, avg: r.avg, grossCount: r.gross_count, grossShare: r.gross_share })),
    attention: (raw.attention || []).map((a) => ({
      conversationPk: a.conversation_pk,
      id: a.conversation_id,
      evaluationId: a.evaluation_id,
      language: a.language,
      reason: a.reason,
      reasons: a.reasons || [a.reason],
      score: a.score ?? null,
      provisional: Boolean(a.provisional),
      appealStatus: a.appeal_status ?? "none"
    })),
    attentionTotal: raw.attention_total ?? (raw.attention || []).length
  };
}

export function isDisplayStatus(value) {
  return DISPLAY_STATUSES.includes(value);
}

export function coarseAppealStatus(display) {
  if (display === "new" || display === "under_review") return "open";
  if (display === "confirmed" || display === "changed") return "resolved";
  return display;
}
