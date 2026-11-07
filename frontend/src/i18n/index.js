import { plural } from "../format.js";
import ru from "./ru.js";
import kk from "./kk.js";
import en from "./en.js";
import card from "./screens/card.js";
import cardLedger from "./screens/card-ledger.js";
import builder from "./screens/builder.js";
import list from "./screens/list.js";
import overview from "./screens/overview.js";
import runs from "./screens/runs.js";
import call from "./screens/call.js";
import appeal from "./screens/appeal.js";
import queue from "./screens/queue.js";

export const LOCALES = Object.freeze(["ru", "kk", "en"]);
export const DEFAULT_LOCALE = "ru";
const SCREENS = [card, cardLedger, builder, list, overview, runs, call, appeal, queue];

function merge(base, lang) {
  return Object.assign({}, base, ...SCREENS.map((screen) => screen[lang] || {}));
}

export const DICTIONARIES = { ru: merge(ru, "ru"), kk: merge(kk, "kk"), en: merge(en, "en") };

const STORAGE_KEY = "cqa.locale";
const listeners = new Set();
let current = DEFAULT_LOCALE;

export function normalizeLocale(value) {
  const key = String(value ?? "").trim().toLowerCase().slice(0, 2);
  if (key === "kz") return "kk";
  return LOCALES.includes(key) ? key : DEFAULT_LOCALE;
}

export function getLocale() {
  return current;
}

export function setLocale(value, { persist = false } = {}) {
  const next = normalizeLocale(value);
  const changed = next !== current;
  current = next;
  if (changed) listeners.forEach((fn) => fn(next));
  if (persist) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch (error) {
      return next;
    }
  }
  return next;
}

export function storedLocale() {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return value ? normalizeLocale(value) : null;
  } catch (error) {
    return null;
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function interpolate(text, params) {
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function t(key, params = {}, locale = current) {
  const lang = normalizeLocale(locale);
  let entry = DICTIONARIES[lang][key];
  if (entry === undefined) entry = DICTIONARIES[DEFAULT_LOCALE][key];
  if (entry === undefined) return key;
  if (typeof entry === "object") {
    const count = Number(params.count ?? 0);
    entry = plural(count, lang, entry);
  }
  return interpolate(entry, params);
}

export function hasKey(key, locale = DEFAULT_LOCALE) {
  return key in DICTIONARIES[normalizeLocale(locale)];
}
