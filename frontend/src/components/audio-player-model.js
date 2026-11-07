import { duration } from "../format.js";
import { t } from "../i18n/index.js";

export const SPEEDS = Object.freeze([1, 1.5, 2]);
export const SEEK_STEP = 5;
export const SEEK_PAGE = 30;
export const BAR_COUNT = 80;
export const BAR_MAX = 40;
export const BAR_MIN = 3;

export function finiteOr(value, fallback = null) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
}

export function resolveDuration({ media = null, declared = null, lastStart = null } = {}) {
  const m = finiteOr(media);
  if (m !== null && m > 0) return m;
  const d = finiteOr(declared);
  if (d !== null && d > 0) return d;
  const l = finiteOr(lastStart);
  return l !== null && l > 0 ? l : 0;
}

export function clamp(position, total) {
  const p = finiteOr(position, 0);
  const max = Math.max(0, finiteOr(total, 0));
  return Math.min(max, Math.max(0, p));
}

export function formatClock(seconds) {
  return duration(Math.floor(clamp(seconds, Number.MAX_SAFE_INTEGER)));
}

export function positionText(position, total) {
  return `${formatClock(position)} / ${formatClock(total)}`;
}

export function valueText(position, total, locale) {
  return t("audio.valueText", { pos: formatClock(position), total: formatClock(total) }, locale);
}

export function speedLabel(speed, locale) {
  const text = Number.isInteger(speed) ? String(speed) : String(speed).replace(".", locale === "en" ? "." : ",");
  return `${text}×`;
}

export function percentOf(seconds, total) {
  const max = finiteOr(total, 0);
  if (!(max > 0)) return 0;
  return Math.min(100, Math.max(0, (finiteOr(seconds, 0) / max) * 100));
}

export function nextPosition(position, key, total) {
  const p = clamp(position, total);
  if (key === "ArrowRight" || key === "ArrowUp") return clamp(p + SEEK_STEP, total);
  if (key === "ArrowLeft" || key === "ArrowDown") return clamp(p - SEEK_STEP, total);
  if (key === "PageUp") return clamp(p + SEEK_PAGE, total);
  if (key === "PageDown") return clamp(p - SEEK_PAGE, total);
  if (key === "Home") return 0;
  if (key === "End") return clamp(total, total);
  return null;
}

export function barHeights(peaks, count = BAR_COUNT) {
  if (!Array.isArray(peaks) || !peaks.length) return [];
  const values = peaks.map((p) => Math.max(0, finiteOr(p, 0)));
  const top = Math.max(...values) || 1;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor((i * values.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / count));
    let peak = 0;
    for (let j = from; j < to && j < values.length; j += 1) peak = Math.max(peak, values[j]);
    out.push(Math.max(BAR_MIN, Math.round((peak / top) * BAR_MAX)));
  }
  return out;
}

export function sourceList(url, proxyUrl) {
  const list = [];
  if (url) list.push(url);
  if (proxyUrl && proxyUrl !== url) list.push(proxyUrl);
  return list;
}

export function playerPhase({ sources = [], failed = false, loaded = false } = {}) {
  if (!sources.length) return "unavailable";
  if (failed) return "error";
  return loaded ? "ready" : "loading";
}
