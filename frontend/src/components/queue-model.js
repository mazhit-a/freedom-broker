import { t } from "../i18n/index.js";

export const TABS = Object.freeze(["all", "new", "under_review", "closed"]);
export const DEFAULT_AGING_HOURS = 72;

export function isClosed(appeal) {
  return appeal.status === "confirmed" || appeal.status === "changed";
}

export function inTab(appeal, tab) {
  if (tab === "all") return true;
  if (tab === "closed") return isClosed(appeal);
  return appeal.status === tab;
}

export function tabCounts(list) {
  const out = {};
  for (const tab of TABS) out[tab] = list.filter((a) => inTab(a, tab)).length;
  return out;
}

export function sortOldest(list) {
  return list.slice().sort((a, b) => (b.ageHours ?? 0) - (a.ageHours ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id - b.id);
}

export function visibleRows(list, tab) {
  return sortOldest(list.filter((a) => inTab(a, tab)));
}

export function isAging(appeal, agingHours = DEFAULT_AGING_HOURS) {
  return Boolean(appeal.open) && (appeal.ageHours ?? 0) > agingHours;
}

export function ageText(hours, locale) {
  const value = Number(hours) || 0;
  if (value < 24) return t("queue.age.hours", { n: Math.max(1, Math.round(value)) }, locale);
  return t("queue.age.days", { n: Math.floor(value / 24) }, locale);
}

export function parseAppealId(attr) {
  if (attr === null || attr === undefined) return null;
  const match = /^a?(\d+)$/i.exec(String(attr).trim());
  return match ? Number(match[1]) : null;
}

export function chooseSelection(rows, wantedId, currentId) {
  if (currentId !== null && currentId !== undefined) return currentId;
  if (wantedId !== null && wantedId !== undefined) return wantedId;
  const first = rows.find((a) => a.open) || rows[0];
  return first ? first.id : null;
}

export function criterionDef(appeal) {
  return {
    id: appeal.criterionId,
    type: appeal.criterionType,
    steps: appeal.criterionSteps || [],
    naAllowed: Boolean(appeal.naAllowed),
    maxStep: null,
    answer: appeal.original ? appeal.original.answer : null
  };
}

export function shortAnswer(answer, locale) {
  if (answer === "yes" || answer === "no" || answer === "na") return t(`answer.${answer}`, {}, locale);
  if (typeof answer === "number") return String(answer);
  return "—";
}

export function decisionText(appeal, locale) {
  if (appeal.decision === "change" && appeal.original) {
    return `${shortAnswer(appeal.original.answer, locale)} → ${shortAnswer(appeal.newAnswer, locale)}`;
  }
  return t("queue.decisionConfirmed", {}, locale);
}

export function criterionTitle(appeal, locale) {
  const labels = appeal.criterionLabels && appeal.criterionLabels[locale];
  if (labels && labels.title) return labels.title;
  return appeal.criterionTitle || "";
}

export function rowLabel(appeal, locale) {
  return t(
    "queue.rowLabel",
    { conv: appeal.conversationId, id: appeal.criterionId, title: criterionTitle(appeal, locale), status: t(`status.${appeal.status}`, {}, locale), age: ageText(appeal.ageHours, locale) },
    locale
  );
}

export function nextIndex(count, current, step) {
  if (count <= 0) return -1;
  if (current < 0) return step > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + step));
}
