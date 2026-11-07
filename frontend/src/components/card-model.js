import { dateTime, duration } from "../format.js";
import { NEEDS_REVIEW } from "../scoring.js";

export const CARD_EVENTS = Object.freeze({ appealRequest: "cqa:card-appeal" });

const SPEAKERS = ["client", "operator", "bot", "system"];

export function localized(item, locale, field) {
  if (!item) return null;
  const labels = item.labels && item.labels[locale];
  if (labels && labels[field]) return labels[field];
  return item[field] ?? null;
}

export function speakerKind(speaker) {
  const key = String(speaker || "").toLowerCase();
  return SPEAKERS.includes(key) ? key : "client";
}

export function messageTime(message, channel) {
  if (channel === "call" && message.offsetSeconds !== null && message.offsetSeconds !== undefined) {
    return duration(message.offsetSeconds);
  }
  return message.time || "";
}

export function wallClock(value, locale) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value));
  if (!m) return dateTime(value, locale);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  return dateTime(d, locale).replace(",", "");
}

export function expectedIndices(criterion) {
  if (!criterion || !criterion.expected || criterion.answer !== "no") return [];
  const out = [];
  for (let i = criterion.expected.from; i <= criterion.expected.to; i += 1) out.push(i);
  return out;
}

export function maxStepOf(criterion) {
  if (criterion.maxStep !== null && criterion.maxStep !== undefined) return criterion.maxStep;
  const values = (criterion.steps || []).map((s) => s.value);
  return values.length ? Math.max(...values) : null;
}

function describeCriterion(c, locale, messagesByIndex, channel) {
  const scale = c.type === "scale";
  const max = scale ? maxStepOf(c) : null;
  const chosen = scale && typeof c.answer === "number" ? (c.steps || []).find((s) => s.value === c.answer) : null;
  const evidence = c.evidence
    .filter((e) => messagesByIndex.has(e.index))
    .map((e) => {
      const m = messagesByIndex.get(e.index);
      return { index: e.index, n: e.n, role: speakerKind(m.speaker), time: messageTime(m, channel) };
    });
  const expectedIdx = expectedIndices(c);
  let expected = null;
  if (expectedIdx.length) {
    const first = messagesByIndex.get(expectedIdx[0]);
    const last = messagesByIndex.get(expectedIdx[expectedIdx.length - 1]);
    if (first && last) {
      expected = {
        index: expectedIdx[0],
        time: messageTime(first, channel),
        endTime: messageTime(last, channel),
        role: speakerKind(first.speaker)
      };
    }
  }
  const na = c.answer === "na";
  return {
    id: c.id,
    title: localized(c, locale, "title") || c.id,
    type: c.type,
    scale,
    max,
    answer: c.answer,
    na,
    needsReview: c.answer === NEEDS_REVIEW,
    steps: scale ? c.steps.map((s) => ({ value: s.value, chosen: s.value === c.answer })) : [],
    stepLabel: chosen ? chosen.descriptor : "",
    weight: c.weight,
    effWeight: c.effWeight,
    effPoints: na ? null : c.effPoints,
    rationale: c.rationale || "",
    naCondition: na ? c.naReason || localized(c, locale, "naCondition") || "" : "",
    description: localized(c, locale, "description") || "",
    evidence,
    evidenceIdx: evidence.map((e) => e.index),
    expectedIdx: expected ? expectedIdx : [],
    expected,
    appeal: c.appeal || null,
    section: c.section
  };
}

function sectionView(def, locale, evaluation, criteria) {
  const calc = evaluation.sections.find((s) => s.id === def.id) || null;
  const points = calc ? calc.effectivePoints : null;
  const max = calc ? calc.effectiveMax : null;
  return {
    id: def.id,
    title: localized(def, locale, "title") || def.id,
    points,
    max,
    ratio: points !== null && max ? Math.max(0, Math.min(1, points / max)) : 0,
    criteria: criteria.filter((c) => c.section === def.id)
  };
}

export function buildCard(conversation, evaluation, locale) {
  const messagesByIndex = new Map(conversation.messages.map((m) => [m.index, m]));
  const messages = conversation.messages.map((m) => ({
    index: m.index,
    n: m.n,
    kind: speakerKind(m.speaker),
    time: messageTime(m, conversation.channel),
    text: m.text,
    cites: []
  }));
  if (!evaluation) {
    return { messages, sections: [], order: [], byId: {}, gross: null, tiles: [], criteria: [] };
  }
  const all = evaluation.criteria.map((c) => describeCriterion(c, locale, messagesByIndex, conversation.channel));
  const flagIds = new Set(evaluation.criteria.filter((c) => c.type === "flag").map((c) => c.id));
  const scored = all.filter((c) => !flagIds.has(c.id));
  const byId = {};
  for (const c of scored) byId[c.id] = c;
  const byIndex = new Map(messages.map((m) => [m.index, m]));
  for (const c of scored) {
    for (const index of c.evidenceIdx) {
      const target = byIndex.get(index);
      if (target && !target.cites.includes(c.id)) target.cites.push(c.id);
    }
  }
  const defs = (evaluation.config && evaluation.config.sections) || [];
  const sections = defs
    .map((def) => sectionView(def, locale, evaluation, scored))
    .filter((s) => s.criteria.length > 0);
  const grossDef = evaluation.criteria.find((c) => c.type === "flag");
  const grossView = all.find((c) => grossDef && c.id === grossDef.id) || null;
  const grossState = evaluation.grossViolation === true ? "found" : evaluation.grossViolation === false ? "none" : "review";
  return {
    messages,
    sections,
    order: sections.flatMap((s) => s.criteria.map((c) => c.id)),
    byId,
    gross: grossView ? { ...grossView, state: grossState } : null,
    tiles: sections,
    criteria: scored
  };
}

export function paintState(view, hover, selected, messageIndex) {
  const activeId = hover || selected || null;
  const active = activeId ? view.byId[activeId] || null : null;
  const citedBy = messageIndex === null || messageIndex === undefined
    ? []
    : (view.messages.find((m) => m.index === messageIndex) || { cites: [] }).cites;
  return {
    activeId: active ? active.id : null,
    evidence: new Set(active ? active.evidenceIdx : []),
    expected: new Set(active ? active.expectedIdx : []),
    expectedFirst: active && active.expectedIdx.length ? active.expectedIdx[0] : null,
    expectedLabel: active ? `${active.id} ${active.title}` : "",
    citedBy: new Set(citedBy)
  };
}

export function moveSelection(order, current, key) {
  if (!order.length) return null;
  const at = order.indexOf(current);
  if (key === "j" || key === "ArrowDown") return order[at < 0 ? 0 : Math.min(order.length - 1, at + 1)];
  if (key === "k" || key === "ArrowUp") return order[at < 0 ? 0 : Math.max(0, at - 1)];
  return current;
}

export function enterTarget(criterion) {
  if (!criterion) return null;
  if (criterion.evidenceIdx.length) return { index: criterion.evidenceIdx[0], select: true };
  if (criterion.expectedIdx.length) return { index: criterion.expectedIdx[0], select: false };
  return null;
}

export function confidenceLevel(confidence, lowConfidence) {
  if (confidence && confidence.level) return confidence.level;
  return lowConfidence ? "low" : "high";
}
