import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { integer } from "../format.js";
import { scoreBand } from "./score-badge.js";

export function barChart({ buckets, height = 184, label = null }, locale) {
  const max = Math.max(1, ...buckets.map((b) => Number(b.value) || 0));
  const peak = buckets.reduce((best, b) => (Number(b.value) > Number(best.value) ? b : best), buckets[0] || { value: 0, label: "" });
  const aria =
    label ||
    t("chart.summary", { count: integer(buckets.length, locale), range: peak.label, max: integer(peak.value, locale) }, locale);
  const inner = Math.max(40, height - 20);
  const bars = buckets.map((b) => {
    const band = scoreBand(b.from !== undefined ? b.from : 0);
    const h = Math.round(((Number(b.value) || 0) / max) * inner);
    const strong = Number(b.value) === max ? " font-weight:600;color:var(--cqa-ink)" : "";
    return html`<div class="chart-bar"><span class="chart-val" style="${strong}">${integer(b.value, locale)}</span><i class="band-${raw(band)}" style="height:${h}px"></i></div>`;
  });
  const labels = buckets.map((b) => html`<span>${b.label}</span>`);
  return html`<figure class="chart" role="img" aria-label="${aria}" style="--n:${buckets.length};--h:${height}px"><div class="chart-bars">${bars}</div><div class="chart-labels">${labels}</div><div class="legend"><span><i class="band-bad"></i>${t("chart.legend.bad", {}, locale)}</span><span><i class="band-warn"></i>${t("chart.legend.warn", {}, locale)}</span><span><i class="band-ok"></i>${t("chart.legend.ok", {}, locale)}</span></div></figure>`;
}
