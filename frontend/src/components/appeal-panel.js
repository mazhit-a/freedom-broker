import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { number } from "../format.js";
import { answerChip, chip, pointsChip } from "../shared/chip.js";
import { maxStepOf } from "./card-model.js";

export const APPEAL_CSS = `
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.rv { padding: 20px; display: flex; flex-direction: column; gap: 14px; border-color: var(--cqa-brand); box-shadow: 0 0 0 1px var(--cqa-brand); }
.rv-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 12px; }
.rv-box { padding: 12px; border-radius: 10px; background: var(--cqa-surface-2); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.rv-box.line { background: transparent; border: 1px solid var(--cqa-line-strong); }
.rv-box p { margin: 0; font-size: var(--cqa-fs-13); overflow-wrap: anywhere; }
.rv-frag { border-radius: 10px; border: 1px dashed var(--cqa-warn); background: var(--cqa-warn-bg); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.rv-frag-h { font-size: 11px; font-weight: 600; color: var(--cqa-warn); }
.rv-line { display: flex; gap: 8px; font-size: var(--cqa-fs-13); }
.rv-line .t { color: var(--cqa-ink-3); width: 56px; flex: none; font-variant-numeric: tabular-nums; }
.rv-line .w { font-weight: 600; width: 76px; flex: none; }
.rv-line .x { min-width: 0; overflow-wrap: anywhere; }
.rv-dec { border: 0; margin: 0; padding: 0; display: flex; gap: 8px 16px; flex-wrap: wrap; align-items: center; }
.rv-radio { display: inline-flex; gap: 8px; align-items: center; font-size: var(--cqa-fs-13); cursor: pointer; }
.rv-new { display: inline-flex; align-items: center; gap: 8px; font-size: var(--cqa-fs-13); }
.rv-lbl { display: flex; flex-direction: column; gap: 6px; font-size: var(--cqa-fs-13); font-weight: 500; }
.rv-lbl small { font-weight: 400; color: var(--cqa-ink-3); font-size: var(--cqa-fs-12); }
.rv-text { height: auto; min-height: 84px; padding: 8px 10px; resize: vertical; font-family: var(--cqa-font); line-height: 1.45; }
.rv-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 10px; border-top: 1px solid var(--cqa-line); }
.rv-prev { display: flex; align-items: baseline; gap: 8px; }
.rv-prev b { font-size: var(--cqa-fs-20); font-weight: 600; }
.rv-err { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--cqa-bad-bg); color: var(--cqa-bad); font-size: var(--cqa-fs-13); }
.attach-btn { margin-left: auto; height: 24px; }
.attach-btn[aria-pressed="true"] { background: var(--cqa-brand-tint); border-color: var(--cqa-brand); color: var(--cqa-brand-deep); }
.appeal-banner { margin: 12px 16px 0; padding: 8px 12px; border-radius: 8px; background: var(--cqa-brand-tint); color: var(--cqa-brand-deep); font-size: var(--cqa-fs-12); }
.msg.msg-attached { box-shadow: 0 0 0 2px var(--cqa-brand); }
`;

export function answerBadge(criterion, answer, locale) {
  if (criterion.type === "scale" && typeof answer === "number") return pointsChip(answer, maxStepOf(criterion), locale);
  return answerChip(answer, locale);
}

export function answerLabel(answer, criterion, locale) {
  if (answer === "yes" || answer === "no" || answer === "na") return t(`answer.${answer}`, {}, locale);
  if (typeof answer === "number") {
    const step = (criterion.steps || []).find((s) => s.value === answer);
    return step && step.descriptor ? `${answer} · ${step.descriptor}` : String(answer);
  }
  return "—";
}

function previewText(preview, locale) {
  if (!preview) return "—";
  const fmt = (v) => (v === null || v === undefined ? "—" : number(v, locale));
  return `${fmt(preview.before)} → ${fmt(preview.after)}`;
}

export function decisionBlock({ id, state, options, preview }, locale) {
  const change = state.decision === "change";
  const opts = options.map((o) => html`<option value="${o.value}" ${raw(String(o.value) === String(state.newAnswer) ? "selected" : "")}>${o.label}</option>`);
  const select = change
    ? html`<label class="rv-new">${t("review.newAnswer", {}, locale)}<select class="field" data-rv="answer" data-focus-id="rv-answer-${id}">${opts}</select></label>`
    : html``;
  const blocked = state.busy || !String(state.reason).trim() || (change && (state.newAnswer === null || state.newAnswer === undefined));
  const error = state.error ? html`<p class="rv-err" role="alert" data-rv-error>${state.error}</p>` : html``;
  return html`<fieldset class="rv-dec"><legend class="sr">${t("review.decision", {}, locale)}</legend><label class="rv-radio"><input type="radio" name="dec-${id}" value="confirm" data-rv="decision" data-focus-id="rv-confirm-${id}" ${raw(change ? "" : "checked")}>${t("review.confirm", {}, locale)}</label><label class="rv-radio"><input type="radio" name="dec-${id}" value="change" data-rv="decision" data-focus-id="rv-change-${id}" ${raw(change ? "checked" : "")}>${t("review.change", {}, locale)}</label>${select}</fieldset><label class="rv-lbl">${t("review.reason", {}, locale)} <small>${t("review.required", {}, locale)}</small><textarea class="field rv-text" data-rv="reason" data-focus-id="rv-reason-${id}" aria-required="true">${state.reason}</textarea></label>${error}<div class="rv-foot"><div class="rv-prev" role="status"><span class="fs12 muted">${t("review.after", {}, locale)}</span><b class="tnum" data-rv-preview>${previewText(preview, locale)}</b></div><button type="button" class="btn btn-primary" style="margin-left:auto" data-action="review-save" data-appeal="${id}" data-focus-id="rv-save-${id}" ${raw(blocked ? "disabled" : "")}>${state.busy ? t("review.saving", {}, locale) : t("review.save", {}, locale)}</button></div>`;
}

export function reviewPanel(model, locale) {
  const { id, criterion, appeal, state, options, preview, fragment, refsText, filed } = model;
  const status = appeal.status === "under_review" ? "under_review" : "new";
  const tone = status === "under_review" ? "warn" : "brand";
  const start =
    status === "new"
      ? html`<button type="button" class="btn btn-sm" data-action="review-start" data-appeal="${id}" data-focus-id="rv-start-${id}" ${raw(state.busy ? "disabled" : "")}>${t("review.start", {}, locale)}</button>`
      : html``;
  const lines = fragment.map(
    (f) => html`<div class="rv-line"><span class="t">${f.time}</span><span class="w">${t(`msg.${f.kind}`, {}, locale)}</span><span class="x">${f.text}</span></div>`
  );
  const frag = fragment.length ? html`<div class="rv-frag" data-rv-fragment><span class="rv-frag-h">${t("review.fragment", {}, locale)}</span>${lines}</div>` : html``;
  return html`<section class="card rv" aria-labelledby="rv-h-${id}" data-review="${id}"><div class="rv-head"><h2 id="rv-h-${id}" class="blk-h">${t("review.title", {}, locale)}</h2>${chip({ tone, text: t(`status.${status}`, {}, locale) })}<span class="tnum fs12 muted">${filed}</span><span class="grow"></span>${start}</div><div class="rv-grid"><div class="rv-box"><span class="fs12 muted">${t("review.original", { id: criterion.id, title: model.title }, locale)}</span><span>${answerBadge(criterion, criterion.originalAnswer, locale)}</span><p class="muted2">${criterion.rationale}</p></div><div class="rv-box line"><span class="fs12 muted">${t("review.operatorComment", {}, locale)}</span><p>${appeal.comment}</p><span class="tnum fs12 muted">${refsText}</span></div></div>${frag}${decisionBlock({ id, state, options, preview }, locale)}</section>`;
}
