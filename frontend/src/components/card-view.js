import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { integer, number } from "../format.js";
import { answerChip, chip, pointsChip, provisionalChip } from "../shared/chip.js";
import { evidenceChip } from "../shared/evidence-chip.js";
import { icon } from "../shared/icons.js";
import { confidenceLevel, wallClock } from "./card-model.js";

const CHAT_ICON = raw(
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>'
);

export function chatIcon() {
  return CHAT_ICON;
}

function messageFoot(message, locale, extra) {
  const cites = message.cites.map(
    (id) => html`<button type="button" class="cite" data-action="cite" data-crit="${id}" data-msg="${message.index}" aria-label="${t("card.citeCriterion", { id }, locale)}">${t("card.citePrefix", {}, locale)}${id}</button>`
  );
  const label = cites.length ? html`<span class="foot-label">${t("card.cited", {}, locale)}</span>` : html``;
  const more = extra ? extra : html``;
  if (!cites.length && !String(more)) return html``;
  return html`<div class="foot">${label}${cites}${more}</div>`;
}

function messageItem(message, locale, extra) {
  const label = html`<span class="exp-label" data-exp-label hidden>${icon("down", 12)}<span data-exp-text></span></span>`;
  if (message.kind === "system") {
    const aria = t("card.systemMessage", { n: integer(message.n, locale), time: message.time }, locale);
    return html`<li class="m m-system" id="msg-${message.index}" data-index="${message.index}">${label}<div class="msg-system" data-bubble><button type="button" class="ts" data-action="pick-msg" data-msg="${message.index}" aria-pressed="false" aria-label="${aria}">${message.time}</button><span>${message.text}</span></div></li>`;
  }
  const who = t(`msg.${message.kind}`, {}, locale);
  const aria = t("card.pickMessage", { n: integer(message.n, locale), time: message.time }, locale);
  const bot = message.kind === "bot" ? html`<span class="msg-meta">${t("msg.notScored", {}, locale)}</span>` : html``;
  return html`<li class="m m-${message.kind}" id="msg-${message.index}" data-index="${message.index}">${label}<div class="msg msg-${message.kind}" data-bubble><div class="msg-head"><span class="msg-who">${who}</span><button type="button" class="ts" data-action="pick-msg" data-msg="${message.index}" aria-pressed="false" aria-label="${aria}">${message.time}</button><span class="msg-meta">#${integer(message.n, locale)}</span>${bot}</div><p class="msg-text">${message.text}</p>${messageFoot(message, locale, extra)}</div></li>`;
}

export function transcriptSection(view, ctx) {
  const { locale, durationText, banner = html``, messageExtra = null } = ctx;
  const count = t("card.events", { count: view.messages.length }, locale);
  const meta = durationText ? `${count} · ${durationText}` : count;
  const items = view.messages.map((m) => messageItem(m, locale, messageExtra ? messageExtra(m) : null));
  return html`<section class="card transcript" aria-labelledby="tr-h" data-transcript><div class="t-head"><h2 id="tr-h" class="blk-h">${t("card.transcript", {}, locale)}</h2><span class="tnum muted fs12">${meta}</span><div class="legend t-legend"><span><i class="lg-ev"></i>${t("card.legendEvidence", {}, locale)}</span><span><i class="lg-exp"></i>${t("card.legendExpected", {}, locale)}</span><span><i class="lg-bot"></i>${t("card.legendBot", {}, locale)}</span></div></div>${banner}<ol class="msgs">${items}</ol></section>`;
}

function confidenceText(evaluation, locale) {
  const level = confidenceLevel(evaluation.confidence, evaluation.lowConfidence);
  const conf = evaluation.confidence;
  const levelText = t(`card.conf.${level}`, {}, locale);
  if (!conf) return levelText;
  return t("card.confidence", { level: levelText, done: integer(conf.withRationale ?? 0, locale), total: integer(conf.total ?? 0, locale) }, locale);
}

function totalBlock(evaluation, locale) {
  const calculated = evaluation.calculated && evaluation.total !== null && evaluation.total !== undefined;
  const changed =
    evaluation.totalChanged && evaluation.originalTotal !== null
      ? chip({ tone: "ok", text: t("card.wasChanged", { value: number(evaluation.originalTotal, locale) }, locale) })
      : html``;
  const provisional = evaluation.provisional ? provisionalChip(locale) : html``;
  const conf = evaluation.confidence;
  const missing = conf && conf.total ? Math.max(0, conf.total - (conf.withRationale ?? 0)) : 0;
  const detail = evaluation.provisional && missing > 0 ? html`<span class="fs12 muted2" data-provisional-detail>${t("state.lowConfidenceDetail", { count: integer(missing, locale), total: integer(conf.total, locale) }, locale)}</span>` : html``;
  const note = evaluation.provisional ? html`<span class="fs12 warn-text" data-provisional-note>${t("state.lowConfidenceNote", {}, locale)}</span>${detail}` : html``;
  if (!calculated) {
    const hint = evaluation.provisional ? html`` : html`<span class="fs12 muted2" data-not-calculated-hint>${t("state.notCalculatedHint", {}, locale)}</span>`;
    return html`<div class="col gap-1"><span class="fs13 muted2">${t("card.total", {}, locale)}</span><div class="total-row"><span class="total-na" data-total>${t("state.notCalculated", {}, locale)}</span>${provisional}</div>${note}${hint}</div>`;
  }
  return html`<div class="col gap-1"><span class="fs13 muted2">${t("card.total", {}, locale)}</span><div class="total-row"><span class="total tnum" data-total>${number(evaluation.total, locale)}</span><span class="out-of">${t("card.outOf", {}, locale)}</span>${provisional}${changed}</div>${note}</div>`;
}

function tile(section, locale) {
  const has = section.points !== null && section.max !== null;
  const value = has
    ? html`<span class="tnum tile-v">${number(section.points, locale)} <span class="tile-of">/ ${number(section.max, locale)}</span></span>`
    : html`<span class="tnum tile-v">—</span>`;
  const title = has ? "" : t("card.sectionNone", {}, locale);
  return html`<div class="tile" title="${title}"><span class="fs12 muted2">${section.title}</span>${value}<span class="tile-track" aria-hidden="true"><span class="tile-fill" style="width:${(section.ratio * 100).toFixed(1)}%"></span></span></div>`;
}

function grossStrip(view, evaluation, locale) {
  const g = view.gross;
  if (!g) return html``;
  let badge;
  let tail;
  if (g.state === "found") {
    badge = chip({ tone: "crit", text: t("answer.yes", {}, locale) });
    tail = t("card.grossFound", {}, locale);
  } else if (g.state === "none") {
    badge = chip({ tone: "ok", text: t("answer.no", {}, locale) });
    tail = t("card.grossNone", {}, locale);
  } else {
    badge = chip({ tone: "warn", text: t("answer.needsReview", {}, locale) });
    tail = t("card.grossReview", {}, locale);
  }
  const quotes = g.state === "found" ? g.evidence.map((e) => evidenceChip({ index: e.index, role: e.role, time: e.time }, locale)) : [];
  const why = g.state === "found" && g.rationale ? html`<span class="fs13 muted2 gross-why">${g.rationale}</span>` : html``;
  const desc = g.state === "found" ? html`` : html`<span class="gross-desc">${g.description}</span>`;
  const cls = g.state === "found" ? "gross gross-found" : "gross";
  return html`<div class="${raw(cls)}" data-gross="${g.state}">${badge}<span class="fs13"><b>${g.id} ${g.title}</b> — ${tail}</span>${desc}${why}<span class="row gap-1">${quotes}</span></div>`;
}

export function scoreSection(view, evaluation, ctx) {
  const { locale, dataset = null } = ctx;
  const checklist = chip({ tone: "brand", text: `${evaluation.checklistName || ""} · ${evaluation.versionLabel || ""}`.replace(/^ · | · $/g, "") });
  const when = wallClock(evaluation.createdAt, locale);
  const model = [evaluation.modelLabel, when].filter(Boolean);
  const modelText = t("card.model", { model: evaluation.modelLabel || "", time: when }, locale);
  const modelLine = model.length ? modelText.replace(/ · $/, "") : "";
  const tiles = view.tiles.map((s) => tile(s, locale));
  return html`<div class="card score-card" data-score><div class="score-top">${totalBlock(evaluation, locale)}<div class="score-meta"><span data-version-chip>${checklist}</span><span class="tnum">${modelLine}</span><span data-confidence>${confidenceText(evaluation, locale)}</span></div></div><div class="tiles" data-tiles>${tiles}</div>${ctx.hideGross ? html`` : grossStrip(view, evaluation, locale)}</div>`;
}

function answerBadge(c, locale) {
  if (c.scale && typeof c.answer === "number") return pointsChip(c.answer, c.max, locale);
  return answerChip(c.answer, locale);
}

function stepsRow(c, locale) {
  if (!c.scale) return html``;
  const steps = c.steps.map(
    (s) => html`<span class="step ${raw(s.chosen ? "step-on" : "")}" ${raw(s.chosen ? 'aria-current="true"' : "")}>${integer(s.value, locale)}</span>`
  );
  const label = c.stepLabel ? html`<span class="fs12 muted2">— ${c.stepLabel}</span>` : html``;
  return html`<div class="row gap-2" role="group" aria-label="${t("card.scaleSteps", { id: c.id }, locale)}"><span class="fs12 muted">${t("card.scale", {}, locale)}</span>${steps}${label}</div>`;
}

function weightText(c, locale) {
  if (c.na) return t("card.weightExcluded", { weight: integer(c.weight, locale) }, locale);
  if (c.effWeight === null || c.effWeight === undefined) return t("card.weightPlain", { weight: integer(c.weight, locale) }, locale);
  return t("criterion.weight", { weight: integer(c.weight, locale), effective: number(c.effWeight, locale) }, locale);
}

function appealChips(c, locale) {
  if (!c.appeal) return html``;
  const s = c.appeal.status;
  if (s === "changed") return chip({ tone: "ok", text: t("card.changedByAppeal", {}, locale) });
  if (s === "confirmed") return chip({ tone: "na", text: t("card.confirmedByAppeal", {}, locale) });
  return chip({ tone: "warn", text: t("card.appealStatus", { status: t(`status.${s}`, {}, locale) }, locale) });
}

function criterionArticle(c, ctx) {
  const { locale, canAppeal } = ctx;
  const points = c.effPoints === null || c.effPoints === undefined ? "—" : number(c.effPoints, locale);
  const maxText = c.na ? t("answer.na", {}, locale) : c.effWeight === null || c.effWeight === undefined ? "—" : number(c.effWeight, locale);
  const na = c.na
    ? html`<div class="na-box"><b>${t("card.naMet", {}, locale)}</b> ${c.naCondition}</div>`
    : html``;
  const chips = c.evidence.map((e) => evidenceChip({ index: e.index, role: e.role, time: e.time }, locale));
  const expected = c.expected
    ? evidenceChip({ index: c.expected.index, role: c.expected.role, time: c.expected.time, endTime: c.expected.endTime, expected: true }, locale)
    : html``;
  const appeal =
    canAppeal && !c.appeal
      ? html`<button type="button" class="btn btn-sm" data-action="appeal" data-crit="${c.id}" aria-label="${t("criterion.appeal", {}, locale)} ${c.id}">${icon("flag")}${t("criterion.appeal", {}, locale)}</button>`
      : html``;
  return html`<article class="crit-row" data-crit-row="${c.id}" id="crit-${c.id}"><div class="crit-top"><button type="button" class="crit-pick" data-action="pick-crit" data-crit="${c.id}" aria-pressed="false" data-focus-id="pick-${c.id}"><span class="crit-no">${c.id}</span><span class="crit-name">${c.title}</span><span class="chip cites-chip" data-cites-chip hidden></span></button>${answerBadge(c, locale)}<span class="tnum crit-pts"><b>${points}</b> <span class="muted">/ ${maxText}</span></span></div><div class="crit-rest">${c.rationale ? html`<p class="crit-why">${c.rationale}</p>` : c.needsReview ? html`<p class="crit-why warn-text" data-no-rationale>${t("card.noRationale", {}, locale)}</p>` : html``}${na}${stepsRow(c, locale)}<div class="row gap-2"><span class="crit-weight">${weightText(c, locale)}</span>${chips}${expected}<span class="grow"></span>${appealChips(c, locale)}${appeal}</div></div></article>`;
}

export function criteriaSection(view, ctx) {
  const { locale } = ctx;
  if (!view.sections.length) {
    return html`<section class="card" aria-labelledby="cr-h"><div class="cr-head"><h2 id="cr-h" class="blk-h">${t("card.criteria", {}, locale)}</h2></div><p class="pad muted fs13">${t("card.noCriteria", {}, locale)}</p></section>`;
  }
  const groups = view.sections.map((s) => {
    const has = s.points !== null && s.max !== null;
    const sum = has ? t("card.sectionOf", { points: number(s.points, locale), max: number(s.max, locale) }, locale) : "—";
    return html`<div class="sec-row"><h3 class="sub-h">${s.title}</h3><span class="tnum muted fs12">${sum}</span></div>${s.criteria.map((c) => criterionArticle(c, ctx))}`;
  });
  return html`<section class="card criteria" aria-labelledby="cr-h"><div class="cr-head"><h2 id="cr-h" class="blk-h">${t("card.criteria", {}, locale)}</h2><span class="fs12 muted">${t("card.keysHint", {}, locale)}</span></div><div class="crit-list" tabindex="0" role="group" data-crit-list data-focus-id="crit-list" aria-label="${t("card.listLabel", {}, locale)}">${groups}</div></section>`;
}

function skeletonBars(widths) {
  return widths.map((w) => html`<span class="skel" style="height:10px;width:${w}%"></span>`);
}

export function loadingSkeleton(locale, strip) {
  const name = t("state.loading", {}, locale);
  const messages = [70, 55, 80, 45, 65, 75].map((w, i) => html`<div class="col gap-2" style="align-items:${i % 2 ? "flex-end" : "flex-start"}"><span class="skel" style="height:10px;width:60px"></span><span class="skel" style="height:44px;width:${w}%"></span></div>`);
  const rows = [1, 2, 3, 4].map(() => html`<div class="col gap-2" style="padding:12px 20px"><span class="skel" style="height:14px;width:45%"></span>${skeletonBars([90, 70])}</div>`);
  return html`<div class="page" aria-busy="true" role="status" aria-label="${name}" data-card-loading>${strip}<div class="cols"><section class="card transcript"><div class="t-head"><span class="skel" style="height:16px;width:120px"></span></div><div class="msgs">${messages}</div></section><section class="evalcol"><div class="card score-card"><span class="skel" style="height:44px;width:40%"></span><div class="tiles"><span class="skel" style="height:56px"></span><span class="skel" style="height:56px"></span><span class="skel" style="height:56px"></span></div></div><div class="card criteria">${rows}</div></section></div></div>`;
}
