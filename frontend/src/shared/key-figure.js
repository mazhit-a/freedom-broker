import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { number } from "../format.js";

export function keyFigure({ label, value, digits = 2, unit = "", delta = null, deltaLabel = null }, locale) {
  const shown = value === null || value === undefined ? "—" : number(value, locale, digits);
  let deltaHtml = html``;
  if (delta !== null && delta !== undefined && !Number.isNaN(Number(delta))) {
    const d = Number(delta);
    const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    const glyph = d > 0 ? "▲" : d < 0 ? "▼" : "●";
    const text = deltaLabel || t("kf.delta", { delta: number(Math.abs(d), locale, digits) }, locale);
    deltaHtml = html`<span class="kf-delta ${raw(dir)}"><span aria-hidden="true">${glyph}</span> ${text}</span>`;
  }
  return html`<div class="kf"><span class="kf-label">${label}</span><span class="kf-value">${shown}${unit ? html` <span class="kf-delta">${unit}</span>` : html``}</span>${deltaHtml}</div>`;
}
