import { score } from "../scoring.js";
import { parseStepValue } from "../scale-steps.js";
import { numbering, ordered, parseHundredths, toDecimalString } from "./builder-model.js";
import { stepProblems } from "./builder-validate.js";

export const SAMPLE_ANSWERS = Object.freeze({
  "01": "yes",
  "02": "yes",
  "03": "na",
  "04": 15,
  "05": "yes",
  "06": 7,
  "07": "no"
});

function stepValues(c) {
  return c.steps.map((s) => parseStepValue(s.value));
}

export function sampleAnswer(c, answers = SAMPLE_ANSWERS) {
  let answer = answers[c.id];
  const isScale = c.type === "scale";
  if (isScale) {
    const values = stepValues(c);
    if (typeof answer !== "number" || !values.includes(answer)) answer = values[Math.max(0, values.length - 2)];
    return answer;
  }
  if (answer === "na" && c.type !== "ynna") answer = "yes";
  if (typeof answer === "number" || answer === undefined) answer = "yes";
  return answer;
}

export function scoringConfig(draft) {
  return {
    sections: draft.sections.map((s) => ({ id: s.id, title: s.title })),
    criteria: ordered(draft).map((c) => {
      const hundredths = parseHundredths(c.weight);
      const base = {
        id: c.key,
        section: c.section,
        weight: c.type === "flag" || hundredths === null ? "0" : toDecimalString(hundredths),
        type: c.type === "scale" ? "scale" : c.type === "flag" ? "flag" : "yes_no",
        na_allowed: c.type === "ynna",
        scale_steps: []
      };
      if (c.type === "scale") {
        const steps = c.steps.map((s) => ({ value: parseStepValue(s.value) }));
        return { ...base, scale_steps: steps, max_step: Math.max(...steps.map((s) => s.value)) };
      }
      return base;
    })
  };
}

export function computePreview(draft, answers = SAMPLE_ANSWERS, answerFor = sampleAnswer) {
  if (draft.criteria.length === 0) return { ok: false, reason: "empty" };
  const blocked = draft.criteria.some((c) => c.type === "scale" && stepProblems(c).length > 0);
  if (blocked) return { ok: false, reason: "scale" };
  const config = scoringConfig(draft);
  const given = {};
  for (const c of draft.criteria) given[c.key] = c.type === "flag" ? "no" : answerFor(c, answers);
  const result = score(config, given);
  const numOf = numbering(draft);
  const byId = new Map(result.criteria.map((r) => [r.id, r]));
  const rows = ordered(draft)
    .filter((c) => c.type !== "flag")
    .map((c) => {
      const r = byId.get(c.key);
      const answer = given[c.key];
      return {
        key: c.key,
        num: numOf.get(c.key),
        name: c.name,
        type: c.type,
        answer,
        top: c.type === "scale" ? Math.max(...stepValues(c)) : null,
        na: r.na,
        weight: r.weight,
        weightText: c.weight,
        effectiveWeight: r.effectiveWeight,
        effectivePoints: r.effectivePoints
      };
    });
  return {
    ok: true,
    rows,
    total: result.total,
    calculated: result.calculated,
    applicableWeight: result.applicableWeight,
    factor: result.factor,
    anyNa: rows.some((r) => r.na)
  };
}
