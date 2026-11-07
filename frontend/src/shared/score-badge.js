import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { number } from "../format.js";
import { provisionalChip } from "./chip.js";

export function scoreBand(value) {
  const v = Number(value);
  if (v < 50) return "bad";
  if (v < 70) return "warn";
  return "ok";
}

export function scoreBadge(value, locale, { provisional = false, bar = true } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return html`<span class="score"><span class="score-dash" aria-label="${t("state.failed", {}, locale)}">—</span></span>`;
  }
  const v = Number(value);
  const width = Math.max(0, Math.min(100, v));
  const band = scoreBand(v);
  const track = bar
    ? html`<span class="score-track" aria-hidden="true"><span class="score-fill band-${raw(band)}" style="width:${width}%"></span></span>`
    : html``;
  const chip = provisional ? provisionalChip(locale) : html``;
  return html`<span class="score"><span class="score-num">${number(v, locale)}</span>${track}${chip}</span>`;
}
