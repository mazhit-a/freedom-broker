import { html } from "../base-element.js";
import { t } from "../i18n/index.js";
import { integer, number } from "../format.js";

const TONE_CLASS = {
  ok: "c-ok",
  warn: "c-warn",
  bad: "c-bad",
  na: "c-na",
  crit: "c-crit",
  brand: "c-brand"
};

const STATUS_TONE = {
  new: "brand",
  under_review: "warn",
  confirmed: "na",
  changed: "ok",
  low_confidence: "na",
  failed: "bad"
};

const ANSWER_TONE = { yes: "ok", no: "bad", na: "na", needs_review: "warn" };
const ANSWER_KEY = { yes: "answer.yes", no: "answer.no", na: "answer.na", needs_review: "answer.needsReview" };

function quantity(value, locale) {
  return Number.isInteger(Number(value)) ? integer(value, locale) : number(value, locale, 2);
}

export function chip({ tone = "na", text = "", title = "" } = {}) {
  const cls = TONE_CLASS[tone] || TONE_CLASS.na;
  return html`<span class="chip ${cls}" title="${title}">${text}</span>`;
}

export function answerChip(answer, locale) {
  const key = ANSWER_KEY[answer];
  if (!key) return html``;
  return chip({ tone: ANSWER_TONE[answer], text: t(key, {}, locale) });
}

export function pointsChip(earned, max, locale) {
  let tone = "warn";
  if (Number(earned) >= Number(max)) tone = "ok";
  else if (Number(earned) <= 0) tone = "bad";
  return chip({
    tone,
    text: t("chip.points", { earned: quantity(earned, locale), max: quantity(max, locale) }, locale)
  });
}

export function grossChip(locale) {
  return chip({ tone: "crit", text: t("chip.gross", {}, locale) });
}

export function statusChip(status, locale) {
  const tone = STATUS_TONE[status];
  if (!tone) return html``;
  return chip({ tone, text: t(`status.${status}`, {}, locale) });
}

export function provisionalChip(locale) {
  return chip({ tone: "warn", text: t("state.lowConfidence", {}, locale) });
}

export function langChip(lang) {
  const code = String(lang || "").toLowerCase().slice(0, 2);
  const shown = code === "kk" || code === "kz" ? "KZ" : code.toUpperCase();
  return html`<span class="lang">${shown}</span>`;
}

export function versionChip(name, version) {
  const label = version === null || version === undefined || version === "" ? name : `${name} · v${version}`;
  return chip({ tone: "brand", text: label });
}
