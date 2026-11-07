import { score } from "../scoring.js";
import { DICTIONARIES } from "../i18n/index.js";

export function answerValue(text) {
  if (text === "yes" || text === "no" || text === "na") return text;
  const n = Number(text);
  return Number.isNaN(n) ? text : n;
}

export function allowedAnswers(def) {
  if (!def) return [];
  const out = [];
  if (def.type === "scale") {
    const values = (def.steps || []).map((s) => s.value).sort((a, b) => a - b);
    for (const value of values) out.push(value);
  } else {
    out.push("yes", "no");
  }
  if (def.naAllowed && def.type !== "flag") out.push("na");
  return out;
}

export function defaultNewAnswer(def) {
  const options = allowedAnswers(def);
  const other = options.find((o) => o !== def.answer);
  return other === undefined ? null : other;
}

export function answersOf(evaluation) {
  const out = {};
  for (const c of evaluation.criteria) out[c.id] = c.answer;
  return out;
}

export function previewTotals(evaluation, criterionId, decision, newAnswer) {
  if (!evaluation || !evaluation.config) return null;
  try {
    const answers = answersOf(evaluation);
    const before = score(evaluation.config, answers).total;
    if (decision !== "change" || newAnswer === null || newAnswer === undefined) return { before, after: before };
    const after = score(evaluation.config, answers, { [criterionId]: newAnswer }).total;
    return { before, after };
  } catch (error) {
    return null;
  }
}

export function openFor(evaluation, criterionId) {
  return ((evaluation && evaluation.appeals) || []).some((a) => a.open && a.criterionId === criterionId);
}

export function candidateIds(view, evaluation) {
  return view.order.filter((id) => !openFor(evaluation, id));
}

export function refChips(view, refs) {
  const byIndex = new Map(view.messages.map((m) => [m.index, m]));
  return refs
    .map((index) => byIndex.get(index))
    .filter(Boolean)
    .map((m) => ({ index: m.index, n: m.n, time: m.time, kind: m.kind }));
}

export function fragmentFor(view, criterion, appeal) {
  const byIndex = new Map(view.messages.map((m) => [m.index, m]));
  let indices = [];
  if (criterion && criterion.expected && criterion.answer !== "yes") {
    for (let i = criterion.expected.from; i <= criterion.expected.to; i += 1) indices.push(i);
  }
  if (!indices.length && criterion && criterion.evidence && criterion.evidence.length) indices = criterion.evidence.map((e) => e.index);
  if (!indices.length && appeal) indices = appeal.refs.map((r) => r.index);
  return indices
    .map((index) => byIndex.get(index))
    .filter(Boolean)
    .map((m) => ({ index: m.index, n: m.n, time: m.time, kind: m.kind, text: m.text }));
}

export function errorText(prefix, error, locale, translate) {
  const code = error && error.code ? String(error.code) : "";
  const dict = DICTIONARIES[locale] || {};
  const key = `${prefix}.err.${code}`;
  if (code && dict[key]) return translate(key);
  if (error && error.status === 403) return translate(`${prefix}.err.role_forbidden`);
  return translate(`${prefix}.err.generic`);
}

export function isCommentValid(text) {
  return String(text || "").trim().length > 0;
}
