const INTL_LOCALE = { ru: "ru-RU", kk: "kk-KZ", en: "en-US" };

export function intlLocale(locale) {
  return INTL_LOCALE[locale] || INTL_LOCALE.ru;
}

const NUMBER_LOCALE = { ru: "ru-RU", kk: "ru-RU", en: "en-US" };

const cache = new Map();

function formatter(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let fmt = cache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(NUMBER_LOCALE[locale] || NUMBER_LOCALE.ru, options);
    cache.set(key, fmt);
  }
  return fmt;
}

export function number(value, locale = "ru", digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  return formatter(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: true
  }).format(Number(value));
}

export function integer(value, locale = "ru") {
  return number(value, locale, 0);
}

export function percent(value, locale = "ru", digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  const hundredths = Number(value) / 100;
  return formatter(locale, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(hundredths);
}

export function plural(count, locale, forms) {
  const rule = new Intl.PluralRules(intlLocale(locale)).select(Math.abs(count));
  return forms[rule] ?? forms.other ?? forms.many ?? forms.one ?? "";
}

export function date(value, locale = "ru") {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC"
  }).format(d);
}

export function dateTime(value, locale = "ru") {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).format(d);
}

export function duration(totalSeconds) {
  const secs = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export const format = { number, integer, percent, plural, date, dateTime, duration };
export default format;
