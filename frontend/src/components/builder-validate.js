import { validateSteps, parseStepValue, STEP_ERRORS } from "../scale-steps.js";
import { numbering, parseHundredths } from "./builder-model.js";

export const TARGET_HUNDREDTHS = 10000;

export function sumHundredths(draft) {
  return draft.criteria.reduce((sum, c) => {
    if (c.type === "flag") return sum;
    const value = parseHundredths(c.weight);
    return sum + (value === null ? 0 : value);
  }, 0);
}

export function stepProblems(c) {
  const problems = validateSteps(c.steps).map((code) => STEP_ERRORS[code]);
  const values = c.steps.map((s) => parseStepValue(s.value));
  if (values.every((v) => v !== null) && values.some((v) => !Number.isInteger(v))) problems.push("builder.err.stepInteger");
  return problems;
}

export function validate(draft) {
  const numOf = numbering(draft);
  const sum = sumHundredths(draft);
  const errors = [];
  if (sum !== TARGET_HUNDREDTHS) errors.push({ code: "sum", key: null, sum });
  const badWeight = new Set();
  const badName = new Set();
  const seen = new Map();
  const ordered = [...draft.criteria].sort((a, b) => numOf.get(a.key).localeCompare(numOf.get(b.key)));
  for (const c of ordered) {
    const num = numOf.get(c.key);
    if (c.type !== "flag" && parseHundredths(c.weight) === null) {
      badWeight.add(c.key);
      errors.push({ code: "weight", key: c.key, num });
    }
  }
  for (const c of ordered) {
    const num = numOf.get(c.key);
    const name = c.name.trim().toLowerCase();
    if (!name) {
      badName.add(c.key);
      errors.push({ code: "nameEmpty", key: c.key, num });
    } else if (seen.has(name)) {
      badName.add(c.key);
      badName.add(seen.get(name));
      errors.push({ code: "nameDup", key: c.key, name: c.name.trim() });
    } else {
      seen.set(name, c.key);
    }
  }
  const scaleBad = new Set();
  for (const c of ordered) {
    if (c.type !== "scale") continue;
    for (const problem of stepProblems(c)) {
      scaleBad.add(c.key);
      errors.push({ code: "scale", key: c.key, name: c.name.trim() || `№ ${numOf.get(c.key)}`, problem });
    }
  }
  return { sum, errors, valid: errors.length === 0, badWeight, badName, scaleBad, numOf };
}

export function errorText(error, t) {
  if (error.code === "sum") return t("builder.err.sum", { sum: error.sumText });
  if (error.code === "nameEmpty") return t("builder.err.nameEmpty", { num: error.num });
  if (error.code === "nameDup") return t("builder.err.nameDup", { name: error.name });
  if (error.code === "weight") return t("builder.err.weight", { num: error.num });
  return t("builder.err.scale", { name: error.name, reason: t(error.problem) });
}
