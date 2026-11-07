import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { date, number } from "../format.js";
import { wallClock } from "./card-model.js";

export const HISTORY_CSS = `
.history { padding: 16px 20px 20px; display: flex; flex-direction: column; gap: 12px; }
.hist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.hist li { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 12px; }
.hist-rail { display: flex; flex-direction: column; align-items: center; }
.hist-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 5px; flex: none; }
.hist-line { flex: 1; width: 1px; background: var(--cqa-line-strong); }
.hist li:last-child .hist-line { background: transparent; }
.hist-body { padding-bottom: 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.hist-title { font-weight: 600; font-size: var(--cqa-fs-13); }
.hist-meta { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
.hist-text { margin: 0; font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); overflow-wrap: anywhere; }
.hist-none { margin: 0; font-size: var(--cqa-fs-13); color: var(--cqa-ink-3); }
`;

const DOT = { model: "var(--cqa-ink-3)", appeal: "var(--cqa-warn)", changed: "var(--cqa-ok)", confirmed: "var(--cqa-na)" };

function answerText(answer, criterion, locale) {
  if (answer === "yes") return t("answer.yes", {}, locale);
  if (answer === "no") return t("answer.no", {}, locale);
  if (answer === "na") return t("answer.na", {}, locale);
  if (typeof answer === "number") return t("card.ofMax", { value: String(answer), max: criterion && criterion.max !== null ? String(criterion.max) : "" }, locale);
  return "—";
}

function originalOf(evaluation, id) {
  const found = (evaluation.criteria || []).find((c) => c.id === id);
  return found ? found.originalAnswer : null;
}

function stamp(value) {
  const ms = Date.parse(value || "");
  return Number.isNaN(ms) ? 0 : ms;
}

export function openAppeals(evaluation) {
  return ((evaluation && evaluation.appeals) || []).filter((a) => a.open);
}

export function buildHistory(view, evaluation, locale) {
  const calculated = evaluation.originalTotal !== null && evaluation.originalTotal !== undefined;
  const version = evaluation.versionLabel || "";
  const meta = [evaluation.modelLabel, version ? t("history.checklist", { version }, locale) : "", wallClock(evaluation.createdAt, locale)].filter(Boolean).join(" · ");
  const entries = [
    {
      at: stamp(evaluation.createdAt),
      kind: "model",
      title: t("history.model", {}, locale),
      chip: { tone: "na", text: t("history.original", {}, locale) },
      meta,
      body: calculated ? t("history.total", { value: number(evaluation.originalTotal, locale) }, locale) : t("history.totalNone", {}, locale)
    }
  ];
  const appeals = (evaluation.appeals || []).slice().sort((a, b) => stamp(a.createdAt) - stamp(b.createdAt));
  const decided = appeals.filter((a) => !a.open);
  const times = new Map(view.messages.map((m) => [m.index, m.time]));
  for (const a of appeals) {
    const crit = view.byId[a.criterionId] || null;
    const title = crit ? crit.title : a.criterionTitle || "";
    const refs = a.refs.map((r) => times.get(r.index) || `#${r.n}`).join(", ");
    const body = [a.comment, refs ? t("history.refs", { list: refs }, locale) : ""].filter(Boolean).join(" ");
    const statusText = a.open ? t(`status.${a.status === "under_review" ? "under_review" : "new"}`, {}, locale) : t("history.resolved", {}, locale);
    const tone = a.open ? (a.status === "under_review" ? "warn" : "brand") : "na";
    entries.push({
      at: stamp(a.createdAt),
      kind: "appeal",
      title: t("history.appeal", { id: a.criterionId, title }, locale),
      chip: { tone, text: statusText },
      meta: t("history.actorMeta", { actor: t("actor.operator", {}, locale), when: wallClock(a.createdAt, locale) }, locale),
      body
    });
    if (a.open) continue;
    const changed = a.status === "changed";
    let before = a.totalBefore;
    let after = a.totalAfter;
    if ((before === null || before === undefined) && decided.length === 1) {
      before = evaluation.originalTotal;
      after = evaluation.total;
    }
    const parts = [];
    if (changed) parts.push(t("history.answer", { from: answerText(a.original ? a.original.answer : originalOf(evaluation, a.criterionId), crit, locale), to: answerText(a.newAnswer, crit, locale) }, locale));
    if (a.reason) parts.push(a.reason);
    const haveTotals = before !== null && before !== undefined && after !== null && after !== undefined;
    if (haveTotals) {
      parts.push(changed ? t("history.totalShift", { from: number(before, locale), to: number(after, locale) }, locale) : t("history.totalSame", { value: number(before, locale) }, locale));
    }
    entries.push({
      at: stamp(a.decidedAt),
      kind: changed ? "changed" : "confirmed",
      title: t(changed ? "history.decisionChanged" : "history.decisionConfirmed", {}, locale),
      chip: { tone: changed ? "ok" : "na", text: t(changed ? "status.changed" : "status.confirmed", {}, locale) },
      meta: t("history.actorMeta", { actor: t("role.reviewer", {}, locale), when: wallClock(a.decidedAt, locale) }, locale),
      body: parts.join(" ")
    });
  }
  const order = { model: 0, appeal: 1, changed: 2, confirmed: 2 };
  entries.sort((x, y) => x.at - y.at || order[x.kind] - order[y.kind]);
  const days = evaluation.appealWindowWorkdays ?? 5;
  const none = appeals.length
    ? ""
    : [t("history.none", { days: String(days) }, locale), evaluation.appealDeadline ? t("history.deadline", { date: date(evaluation.appealDeadline, locale) }, locale) : ""].filter(Boolean).join(" ");
  return { entries, none };
}

const TONE = { ok: "c-ok", warn: "c-warn", brand: "c-brand", na: "c-na" };

export function historyView(model, locale) {
  const items = model.entries.map(
    (e) => html`<li data-history="${e.kind}"><span class="hist-rail" aria-hidden="true"><span class="hist-dot" style="background:${raw(DOT[e.kind])}"></span><span class="hist-line"></span></span><div class="hist-body"><div class="row gap-2"><b class="hist-title">${e.title}</b><span class="chip ${raw(TONE[e.chip.tone] || "c-na")}">${e.chip.text}</span></div><span class="tnum hist-meta">${e.meta}</span><p class="tnum hist-text">${e.body}</p></div></li>`
  );
  const none = model.none ? html`<p class="hist-none" data-history-none>${model.none}</p>` : html``;
  return html`<section class="card history" aria-labelledby="hs-h" data-history-section><h2 id="hs-h" class="blk-h">${t("history.title", {}, locale)}</h2><ol class="hist">${items}</ol>${none}</section>`;
}
