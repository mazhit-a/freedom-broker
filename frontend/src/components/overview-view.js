import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { date, integer, number, percent } from "../format.js";
import { barChart } from "../shared/bar-chart.js";
import { chip, langChip, provisionalChip } from "../shared/chip.js";
import { scoreBand } from "../shared/score-badge.js";

export const LANGUAGES = Object.freeze(["RU", "KZ", "EN"]);
export const CHANNELS = Object.freeze(["chat", "call"]);
export const GROSS_CRITERION_ID = "08";
export const GROSS_HIGHLIGHT_FACTOR = 1.5;
const DAY_MS = 86400000;

export function langCode(language) {
  const code = String(language || "").toLowerCase().slice(0, 2);
  return code === "kz" ? "kk" : code;
}

export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function periodRange(period, fullPeriod) {
  if (period !== "last7") return { from: undefined, to: undefined };
  const to = fullPeriod && fullPeriod.to ? fullPeriod.to : isoDay(Date.now());
  const toMs = Date.parse(`${to}T00:00:00Z`);
  return { from: isoDay(toMs - 6 * DAY_MS), to };
}

export function buildFilter(state, fullPeriod) {
  const { from, to } = periodRange(state.period, fullPeriod);
  return {
    dataset: state.dataset || undefined,
    versionId: state.versionId || undefined,
    from,
    to,
    language: state.language || undefined,
    channel: state.channel || undefined
  };
}

export function selectableVersions(checklists) {
  const out = [];
  for (const checklist of checklists || []) {
    for (const version of checklist.versions || []) {
      if (version.status === "draft") continue;
      out.push({ id: version.id, checklist: checklist.name, label: version.label, isDefault: version.isDefault });
    }
  }
  return out;
}

export function defaultVersionId(checklists) {
  const list = checklists || [];
  const first = list.find((c) => c.defaultVersionId !== null && c.defaultVersionId !== undefined);
  return first ? first.defaultVersionId : null;
}

export function defaultDataset(datasets) {
  const list = datasets || [];
  const control = list.find((d) => d.kind !== "dev");
  return (control || list[0] || {}).groupId || null;
}

export function mainRange(distribution) {
  const total = distribution.reduce((sum, b) => sum + b.count, 0);
  if (!total) return null;
  let best = 0;
  for (const b of distribution) {
    const above = distribution.filter((x) => x.from >= b.from).reduce((sum, x) => sum + x.count, 0);
    if (above / total >= 0.7) best = Math.max(best, b.from);
  }
  const last = distribution[distribution.length - 1];
  return { from: best, to: last ? last.to : 100 };
}

export function peakBucket(distribution) {
  return distribution.reduce((top, b) => (top === null || b.count > top.count ? b : top), null);
}

export function rangeLabel(from, to) {
  return `${from}–${to}`;
}

export function histogramSummary(distribution, locale) {
  const main = mainRange(distribution);
  const peak = peakBucket(distribution);
  if (!main || !peak) return t("overview.dist.ariaEmpty", {}, locale);
  return t(
    "overview.dist.aria",
    {
      mainRange: rangeLabel(main.from, main.to),
      peakRange: rangeLabel(peak.from, peak.to),
      peak: t("overview.dist.count", { count: peak.count, n: integer(peak.count, locale) }, locale)
    },
    locale
  );
}

export function visibleCriteria(list) {
  return (list || [])
    .filter((c) => String(c.id) !== GROSS_CRITERION_ID)
    .slice()
    .sort((a, b) => a.avgPercent - b.avgPercent || String(a.id).localeCompare(String(b.id)));
}

export function grossHighlighted(share, overall) {
  if (share === null || share === undefined || overall === null || overall === undefined || Number(overall) <= 0) return false;
  return Number(share) >= Number(overall) * GROSS_HIGHLIGHT_FACTOR;
}

export function criterionTitle(criterion, locale) {
  const labels = criterion.labels;
  if (labels && typeof labels === "object" && typeof labels[locale] === "string" && labels[locale]) return labels[locale];
  return criterion.title;
}

export function attentionReason(row, locale) {
  const reason = row.reason;
  if (reason === "gross") return chip({ tone: "crit", text: t("overview.att.gross", {}, locale) });
  if (reason === "low_score") return chip({ tone: "bad", text: t("overview.att.low_score", {}, locale) });
  if (reason === "appeal_pending") {
    const status = row.appealStatus === "under_review" || row.appealStatus === "new" ? row.appealStatus : "under_review";
    return chip({ tone: "warn", text: t("overview.att.appeal_pending", { status: t(`status.${status}`, {}, locale) }, locale) });
  }
  return chip({ tone: "na", text: t("overview.att.low_confidence", {}, locale) });
}

export function conversationHref(id) {
  return `#/conversations/${encodeURIComponent(id)}`;
}

function tile({ label, value, unit = null, note, noteClass = "", valueClass = "", cardClass = "", id }) {
  const unitHtml = unit ? html` <span class="kpi-unit">${unit}</span>` : html``;
  return html`<div class="card kpi ${cardClass}" role="group" aria-labelledby="${id}"><span class="kpi-label" id="${id}">${label}</span><span class="kpi-value tnum ${valueClass}">${value}${unitHtml}</span><span class="kpi-note tnum ${noteClass}">${note}</span></div>`;
}

export function kpiSection(k, locale) {
  const avg = k.avgScore === null || k.avgScore === undefined ? "—" : number(k.avgScore, locale, 2);
  let deltaNote = html`${t("overview.kpi.noDelta", {}, locale)}`;
  let deltaClass = "";
  if (k.deltaVsPrev !== null && k.deltaVsPrev !== undefined) {
    const d = Number(k.deltaVsPrev);
    deltaClass = d > 0 ? "up" : d < 0 ? "down" : "";
    const glyph = d > 0 ? "▲" : d < 0 ? "▼" : "●";
    deltaNote = html`<span aria-hidden="true">${glyph}</span> ${t("overview.kpi.delta", { delta: number(Math.abs(d), locale, 2) }, locale)}`;
  }
  const split = `${t("overview.kpi.chats", { count: k.chats, n: integer(k.chats, locale) }, locale)} · ${t("overview.kpi.calls", { count: k.calls, n: integer(k.calls, locale) }, locale)}`;
  const gross = k.grossShare === null || k.grossShare === undefined ? "—" : percent(k.grossShare, locale, 1);
  const days = k.agingHours ? Math.max(1, Math.round(k.agingHours / 24)) : 3;
  const agingNote = t("overview.kpi.aging", { count: days, n: integer(k.olderThanCount, locale), days: integer(days, locale) }, locale);
  const resolution = k.medianResolutionDays === null || k.medianResolutionDays === undefined ? "—" : number(k.medianResolutionDays, locale, 1);
  const resolutionUnit = k.medianResolutionDays === null || k.medianResolutionDays === undefined ? null : t("overview.kpi.resolutionUnit", { count: k.medianResolutionDays }, locale);
  const resolutionNote =
    k.targetDays === null || k.targetDays === undefined
      ? t("overview.kpi.resolutionNoTarget", {}, locale)
      : t("overview.kpi.resolutionNote", { count: k.targetDays, n: integer(k.targetDays, locale) }, locale);
  return html`<section class="kpis" aria-label="${t("overview.kpis", {}, locale)}">
    ${tile({ id: "k-avg", label: t("overview.kpi.avg", {}, locale), value: avg, unit: k.avgScore === null ? null : t("overview.kpi.avgUnit", {}, locale), note: deltaNote, noteClass: deltaClass })}
    ${tile({ id: "k-eval", label: t("overview.kpi.evaluated", {}, locale), value: integer(k.evaluatedCount, locale), note: split })}
    ${tile({ id: "k-gross", label: t("overview.kpi.gross", {}, locale), value: gross, valueClass: "hot", cardClass: "kpi-gross", note: t("overview.kpi.grossNote", { count: k.grossCount, n: integer(k.grossCount, locale) }, locale) })}
    ${tile({ id: "k-appeals", label: t("overview.kpi.appeals", {}, locale), value: integer(k.openAppeals, locale), note: k.olderThanCount > 0 ? agingNote : "", noteClass: "warn" })}
    ${tile({ id: "k-res", label: t("overview.kpi.resolution", {}, locale), value: resolution, unit: resolutionUnit, note: resolutionNote })}
  </section>`;
}

export function distributionCard(distribution, locale) {
  const buckets = distribution.map((b) => ({ value: b.count, from: b.from, label: rangeLabel(b.from, b.to) }));
  const rows = distribution.map((b) => html`<tr><th scope="row">${rangeLabel(b.from, b.to)}</th><td>${integer(b.count, locale)}</td></tr>`);
  return html`<section class="card block" aria-labelledby="h-dist"><div class="block-head"><h2 id="h-dist">${t("overview.dist.heading", {}, locale)}</h2><span class="block-cap">${t("overview.dist.caption", {}, locale)}</span></div>${barChart({ buckets, height: 184, label: histogramSummary(distribution, locale) }, locale)}<div class="sr-only"><table><caption>${t("overview.dist.tableCaption", {}, locale)}</caption><thead><tr><th scope="col">${t("overview.dist.colRange", {}, locale)}</th><th scope="col">${t("overview.dist.colCount", {}, locale)}</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

export function criteriaCard(list, locale) {
  const items = visibleCriteria(list);
  const bars = items.map((c) => {
    const pct = Math.max(0, Math.min(100, Number(c.avgPercent) || 0));
    const band = scoreBand(pct);
    const title = criterionTitle(c, locale);
    const tip = t("overview.crit.applicable", { count: c.applicableCount, n: integer(c.applicableCount, locale) }, locale);
    return html`<li class="crit-row" title="${tip}"><span class="crit-name"><span class="tnum muted">${c.id}</span> ${title}</span><span class="crit-track" role="img" aria-label="${title}: ${integer(pct, locale)} %"><span class="crit-fill band-${raw(band)}" style="width:${pct}%"></span></span><span class="crit-val tnum">${integer(pct, locale)} %</span></li>`;
  });
  const body = items.length ? html`<ul class="crit-list">${bars}</ul>` : html`<p class="muted">${t("overview.crit.none", {}, locale)}</p>`;
  return html`<section class="card block" aria-labelledby="h-crit"><div class="block-head"><h2 id="h-crit">${t("overview.crit.heading", {}, locale)}</h2><span class="block-cap">${t("overview.crit.caption", {}, locale)}</span></div>${body}<p class="block-note">${t("overview.crit.note", {}, locale)}</p></section>`;
}

export function splitCard(data, locale) {
  const overall = data.kpis.grossShare;
  const cell = (row) => {
    const share = row.grossShare === null || row.grossShare === undefined ? "—" : percent(row.grossShare, locale, 1);
    const hot = grossHighlighted(row.grossShare, overall);
    return html`<td class="num ${raw(hot ? "gross-hot" : "")}">${share}</td>`;
  };
  const avg = (row) => (row.avg === null || row.avg === undefined ? "—" : number(row.avg, locale, 2));
  const langRows = data.byLanguage.map((r) => {
    const code = langCode(r.language);
    return html`<tr><td>${langChip(r.language)} ${t(`overview.lang.${code}`, {}, locale)}</td><td class="num">${integer(r.count, locale)}</td><td class="num">${avg(r)}</td>${cell(r)}</tr>`;
  });
  const channelRows = data.byChannel.map(
    (r) => html`<tr><td class="strong">${t(`overview.channel.${r.channel}`, {}, locale)}</td><td class="num">${integer(r.count, locale)}</td><td class="num">${avg(r)}</td>${cell(r)}</tr>`
  );
  const empty = !langRows.length && !channelRows.length;
  const body = empty
    ? html`<p class="muted pad">${t("overview.split.none", {}, locale)}</p>`
    : html`<div class="dt-wrap"><table class="dt" aria-labelledby="h-split"><thead><tr><th scope="col">${t("overview.split.slice", {}, locale)}</th><th scope="col" class="num">${t("overview.split.count", {}, locale)}</th><th scope="col" class="num">${t("overview.split.avg", {}, locale)}</th><th scope="col" class="num">${t("overview.split.gross", {}, locale)}</th></tr></thead><tbody>${langRows}${channelRows}</tbody></table></div>`;
  return html`<section class="card block block-flush" aria-labelledby="h-split"><h2 id="h-split" class="pad-h">${t("overview.split.heading", {}, locale)}</h2>${body}</section>`;
}

export function attentionScore(row, locale) {
  if (row.score === null || row.score === undefined) {
    return html`<span class="muted" aria-label="${t("overview.att.failed", {}, locale)}">—</span>`;
  }
  const num = number(row.score, locale, 2);
  return row.provisional ? html`<span class="att-score"><span>${num}</span>${provisionalChip(locale)}</span>` : html`${num}`;
}

export function attentionCard(data, locale) {
  const rows = data.attention.map(
    (a) => html`<tr><td><a href="${conversationHref(a.id)}" class="strong" data-action="open" data-id="${a.id}">${a.id}</a> ${langChip(a.language)}</td><td>${attentionReason(a, locale)}</td><td class="num">${attentionScore(a, locale)}</td><td class="num"><a href="${conversationHref(a.id)}" data-action="open" data-id="${a.id}" aria-label="${t("overview.att.openFor", { id: a.id }, locale)}">${t("overview.att.open", {}, locale)}</a></td></tr>`
  );
  const shown = data.attention.length;
  const more =
    data.attentionTotal > shown
      ? html`<p class="block-note pad-h">${t("overview.att.shown", { shown: integer(shown, locale), total: integer(data.attentionTotal, locale) }, locale)}</p>`
      : html``;
  const provisional = data.attention.some((a) => a.provisional) ? html`<p class="block-note pad-h">${t("overview.provisional.note", {}, locale)}</p>` : html``;
  const body = shown
    ? html`<div class="dt-wrap"><table class="dt" aria-labelledby="h-att"><thead><tr><th scope="col">${t("overview.att.conversation", {}, locale)}</th><th scope="col">${t("overview.att.reason", {}, locale)}</th><th scope="col" class="num">${t("overview.att.score", {}, locale)}</th><th scope="col"><span class="sr-only">${t("overview.att.open", {}, locale)}</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : html`<p class="muted pad">${t("overview.att.empty", {}, locale)}</p>`;
  return html`<section class="card block block-flush" aria-labelledby="h-att"><div class="block-head pad-h"><h2 id="h-att">${t("overview.att.heading", {}, locale)}</h2><a href="#/conversations" data-action="all">${t("overview.att.all", {}, locale)}</a></div>${body}${more}${provisional}</section>`;
}

export function formatRange(period, locale) {
  if (!period || !period.from || !period.to) return null;
  return { from: date(period.from, locale), to: date(period.to, locale) };
}
