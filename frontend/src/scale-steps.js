import { number } from "./format.js";

export const STEP_ERRORS = Object.freeze({
  min: "scale.errMin",
  ascending: "scale.errAscending",
  zero: "scale.errZero",
  number: "scale.errNumber"
});

export function parseStepValue(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const text = String(raw ?? "").trim().replace(",", ".");
  if (text === "" || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

export function validateSteps(steps) {
  const errors = [];
  const list = Array.isArray(steps) ? steps : [];
  const values = list.map((s) => parseStepValue(s.value));
  if (list.length < 2) errors.push("min");
  if (values.some((v) => v === null)) errors.push("number");
  if (values.length > 0 && values.every((v) => v !== null)) {
    for (let i = 1; i < values.length; i += 1) {
      if (values[i] <= values[i - 1]) {
        errors.push("ascending");
        break;
      }
    }
  }
  if (values.length > 0 && values[0] !== null && values[0] !== 0) errors.push("zero");
  return errors;
}

export function topStep(steps) {
  const values = (steps || []).map((s) => parseStepValue(s.value)).filter((v) => v !== null);
  return values.length ? Math.max(...values) : null;
}

export function stepPoints(steps, weight) {
  const top = topStep(steps);
  const w = Number(weight);
  return (steps || []).map((s) => {
    const value = parseStepValue(s.value);
    if (value === null || top === null || top <= 0 || !Number.isFinite(w)) return null;
    return Math.round((value / top) * w * 1e8) / 1e8;
  });
}

export function formatPoints(value, locale) {
  return value === null ? "—" : number(value, locale);
}
