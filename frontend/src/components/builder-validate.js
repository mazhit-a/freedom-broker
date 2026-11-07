import { validateSteps, parseStepValue, STEP_ERRORS } from "../scale-steps.js";
import { numbering, parseHundredths, sectionInputFor } from "./builder-model.js";

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

export const DRAFT_ERROR_CODES = Object.freeze(["listNameEmpty", "listNameDup"]);

export function validate(draft, options = {}) {
  const numOf = numbering(draft);
  const sum = sumHundredths(draft);
  const errors = [];
  if (draft.isNew) {
    const name = String(draft.config.name ?? "").trim();
    const taken = (options.otherNames || []).map((n) => String(n).trim().toLowerCase());
    if (!name) errors.push({ code: "listNameEmpty", key: null });
    else if (taken.includes(name.toLowerCase())) errors.push({ code: "listNameDup", key: null, name });
  }
  if (draft.criteria.length === 0) errors.push({ code: "noCriteria", key: null });
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
  const badSection = new Map();
  const seenSections = new Map();
  draft.sections.forEach((sec, index) => {
    const name = sec.title.trim().toLowerCase();
    if (!name) {
      badSection.set(sec.id, "secNameEmpty");
      errors.push({ code: "secNameEmpty", key: null, id: sec.id, num: index + 1 });
    } else if (seenSections.has(name)) {
      badSection.set(sec.id, "secNameDup");
      if (!badSection.has(seenSections.get(name))) badSection.set(seenSections.get(name), "secNameDup");
      errors.push({ code: "secNameDup", key: null, id: sec.id, name: sec.title.trim() });
    } else {
      seenSections.set(name, sec.id);
    }
  });
  const badSectionWeight = new Set();
  draft.sections.forEach((sec, index) => {
    const entry = sectionInputFor(draft, sec.id);
    if (entry && parseHundredths(entry.text) === null) {
      badSectionWeight.add(sec.id);
      errors.push({ code: "secWeight", key: null, id: sec.id, name: sec.title.trim() || `№ ${index + 1}` });
    }
  });
  const warnings = [];
  draft.sections.forEach((sec, index) => {
    if (!draft.criteria.some((c) => c.section === sec.id)) warnings.push({ code: "emptySection", id: sec.id, name: sec.title.trim() || `№ ${index + 1}` });
  });
  const scaleBad = new Set();
  for (const c of ordered) {
    if (c.type !== "scale") continue;
    for (const problem of stepProblems(c)) {
      scaleBad.add(c.key);
      errors.push({ code: "scale", key: c.key, name: c.name.trim() || `№ ${numOf.get(c.key)}`, problem });
    }
  }
  const draftValid = !errors.some((e) => DRAFT_ERROR_CODES.includes(e.code));
  return { sum, errors, warnings, valid: errors.length === 0, draftValid, badWeight, badName, badSection, badSectionWeight, scaleBad, numOf };
}

export function errorText(error, t) {
  if (error.code === "listNameEmpty") return t("builder.err.listNameEmpty");
  if (error.code === "listNameDup") return t("builder.err.listNameDup", { name: error.name });
  if (error.code === "noCriteria") return t("builder.err.noCriteria");
  if (error.code === "sum") return t("builder.err.sum", { sum: error.sumText });
  if (error.code === "nameEmpty") return t("builder.err.nameEmpty", { num: error.num });
  if (error.code === "nameDup") return t("builder.err.nameDup", { name: error.name });
  if (error.code === "secNameEmpty") return t("builder.err.secNameEmpty", { num: error.num });
  if (error.code === "secNameDup") return t("builder.err.secNameDup", { name: error.name });
  if (error.code === "secWeight") return t("builder.err.secWeight", { name: error.name });
  if (error.code === "weight") return t("builder.err.weight", { num: error.num });
  return t("builder.err.scale", { name: error.name, reason: t(error.problem) });
}

export function warningText(warning, t) {
  return t("builder.warn.emptySection", { name: warning.name });
}
