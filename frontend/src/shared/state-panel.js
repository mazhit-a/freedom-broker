import { html } from "../base-element.js";
import { t } from "../i18n/index.js";
import { integer, number } from "../format.js";
import { provisionalChip } from "./chip.js";
import { icon } from "./icons.js";

export function loadingPanel(locale, { title = null } = {}) {
  const name = title || t("state.loading", {}, locale);
  return html`<div class="card panel" aria-busy="true" role="status" aria-label="${name}"><span class="skel" style="height:36px;width:40%"></span><span class="skel" style="height:10px;width:90%"></span><span class="skel" style="height:10px;width:75%"></span><span class="skel" style="height:10px;width:82%"></span></div>`;
}

export function emptyPanel(locale, { title = null, hint = null, actionLabel = null, action = "empty-action" } = {}) {
  const button = actionLabel
    ? html`<button type="button" class="btn btn-sm" style="align-self:flex-start" data-action="${action}">${actionLabel}</button>`
    : html``;
  return html`<div class="card panel"><b class="panel-title">${title || t("state.empty", {}, locale)}</b><span class="panel-text">${hint || t("state.emptyHint", {}, locale)}</span>${button}</div>`;
}

export function errorPanel(locale, { title = null, message = null, retry = true } = {}) {
  const button = retry
    ? html`<button type="button" class="btn btn-sm" style="align-self:flex-start" data-action="retry">${icon("retry", 12)}${t("action.retry", {}, locale)}</button>`
    : html``;
  return html`<div class="card panel panel-error" role="alert"><b class="panel-title bad">${title || t("state.failed", {}, locale)}</b><span class="panel-text">${message || t("state.errorHint", {}, locale)}</span>${button}</div>`;
}

export function lowConfidencePanel(locale, { value = null, unanswered = null, total = null } = {}) {
  const num = value === null || value === undefined ? "—" : number(value, locale);
  const detail =
    unanswered !== null && total !== null
      ? html`<span class="panel-text">${t("state.lowConfidenceDetail", { count: integer(unanswered, locale), total: integer(total, locale) }, locale)}</span>`
      : html``;
  return html`<div class="card panel"><div class="row gap-2"><span class="panel-big">${num}</span>${provisionalChip(locale)}</div>${detail}<span class="panel-text">${t("state.lowConfidenceNote", {}, locale)}</span></div>`;
}

export function notCalculatedPanel(locale) {
  return html`<div class="card panel"><span class="panel-big">${t("state.notCalculated", {}, locale)}</span><span class="panel-text">${t("state.notCalculatedHint", {}, locale)}</span></div>`;
}
