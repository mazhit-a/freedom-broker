import { date, duration } from "../format.js";

export function messageStart(message) {
  const v = message ? message.audioStart : null;
  return v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
}

export function timeline(messages) {
  const out = [];
  for (const m of messages || []) {
    const start = messageStart(m);
    if (start !== null) out.push({ index: m.index, start });
  }
  return out;
}

export function activeMessageIndex(points, position) {
  let best = null;
  for (const p of points) {
    if (p.start <= position && (best === null || p.start >= best.start)) best = p;
  }
  return best ? best.index : null;
}

export function lastStart(points) {
  return points.length ? Math.max(...points.map((p) => p.start)) : null;
}

export function grossIndices(view) {
  if (!view || !view.gross || view.gross.state !== "found") return [];
  return view.gross.evidence.map((e) => e.index);
}

export function grossMarkers(view, points) {
  const byIndex = new Map(points.map((p) => [p.index, p.start]));
  const out = [];
  for (const index of grossIndices(view)) {
    if (byIndex.has(index)) out.push({ index, start: byIndex.get(index) });
  }
  return out;
}

export function wallDate(value, locale) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!m) return "";
  return date(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))), locale);
}

export function headerParts(conversation, locale) {
  const parts = [];
  const day = conversation.occurredAt ? wallDate(conversation.occurredAt, locale) : "";
  if (day) parts.push(day);
  const total = conversation.durationSeconds;
  if (total !== null && total !== undefined && Number.isFinite(Number(total))) parts.push(duration(total));
  return parts;
}

export function redistributionNote(evaluation, view) {
  const anyNa = view.criteria.some((c) => c.na);
  const factor = evaluation && evaluation.factor !== null && evaluation.factor !== undefined ? Number(evaluation.factor) : null;
  if (!anyNa && (factor === null || Math.abs(factor - 1) < 1e-9)) return { redistributed: false, factor: 1 };
  return { redistributed: true, factor };
}

export function compactRows(view) {
  const rows = [];
  for (const section of view.sections) {
    for (const c of section.criteria) {
      const showReason = c.answer !== "yes" && (c.na ? c.naCondition : c.rationale);
      rows.push({
        id: c.id,
        title: c.title,
        reason: showReason ? (c.na ? c.naCondition : c.rationale) : "",
        answer: c.answer,
        scale: c.scale,
        max: c.max,
        na: c.na,
        needsReview: c.needsReview,
        effPoints: c.na ? null : c.effPoints,
        effWeight: c.na ? null : c.effWeight,
        weight: c.weight,
        appeal: c.appeal
      });
    }
  }
  return rows;
}

export function appealSummary(view) {
  const found = view.criteria.filter((c) => c.appeal).map((c) => c.appeal.status);
  if (!found.length) return null;
  const rank = ["new", "under_review", "changed", "confirmed"];
  found.sort((a, b) => rank.indexOf(a) - rank.indexOf(b));
  return found[0];
}
