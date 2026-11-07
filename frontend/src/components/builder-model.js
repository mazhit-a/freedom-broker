import { integer, number } from "../format.js";
import { parseStepValue } from "../scale-steps.js";

export const TYPES = Object.freeze(["yn", "ynna", "scale", "flag"]);

export function parseHundredths(text) {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(text ?? "").trim().replace(",", "."));
  if (!m) return null;
  const hundredths = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return hundredths > 10000 ? null : hundredths;
}

export function formatHundredths(hundredths, locale) {
  if (hundredths % 100 === 0) return integer(hundredths / 100, locale);
  return number(hundredths / 100, locale, hundredths % 10 === 0 ? 1 : 2);
}

export function toDecimalString(hundredths) {
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

export function inputWeight(value, locale) {
  const text = String(value ?? "");
  const hundredths = parseHundredths(text);
  if (hundredths === null) return text;
  const plain = hundredths % 100 === 0 ? String(hundredths / 100) : toDecimalString(hundredths).replace(/0$/, "");
  return locale === "en" ? plain : plain.replace(".", ",");
}

export function hasNa(type) {
  return type === "ynna" || type === "scale";
}

export function typeOf(criterion) {
  if (criterion.type === "flag") return "flag";
  if (criterion.type === "scale") return "scale";
  return criterion.na_allowed ? "ynna" : "yn";
}

export function sectionTitle(section, locale) {
  const labels = section.labels && section.labels[locale];
  return (labels && labels.title) || section.title || section.id;
}

function normalizeSteps(steps) {
  const list = (steps || []).map((s) => ({ value: String(s.value ?? ""), description: String(s.descriptor ?? s.description ?? "") }));
  if (list.every((s) => parseStepValue(s.value) !== null)) list.sort((x, y) => parseStepValue(x.value) - parseStepValue(y.value));
  return list;
}

function fromCriterion(c, index, locale) {
  const type = typeOf(c);
  return {
    key: `k${index}`,
    id: c.id,
    section: c.section,
    name: c.title ?? "",
    description: c.description ?? "",
    type,
    weight: type === "flag" ? "0" : inputWeight(c.weight ?? 0, locale),
    naCondition: c.na_condition ?? "",
    naAllowed: Boolean(c.na_allowed),
    steps: type === "scale" ? normalizeSteps(c.scale_steps) : [],
    labels: c.labels ?? null,
    origName: c.title ?? "",
    origNa: c.na_condition ?? ""
  };
}

export function staleLabels(c) {
  if (!c.labels) return null;
  const titleChanged = c.name !== c.origName;
  const naChanged = (hasNa(c.type) ? c.naCondition : "") !== c.origNa;
  if (!titleChanged && !naChanged) return c.labels;
  const out = {};
  for (const [lang, entry] of Object.entries(c.labels)) {
    if (!entry || typeof entry !== "object") continue;
    const next = { ...entry };
    if (titleChanged) delete next.title;
    if (naChanged) delete next.na_condition;
    if (Object.keys(next).length) out[lang] = next;
  }
  return Object.keys(out).length ? out : null;
}

export function snapshot(c) {
  const hundredths = parseHundredths(c.weight);
  return JSON.stringify([
    c.name,
    c.description,
    c.type,
    c.type === "flag" ? 0 : hundredths === null ? `raw:${c.weight}` : hundredths,
    hasNa(c.type) ? c.naCondition : "",
    c.type === "scale" ? c.naCondition.trim() !== "" || c.naAllowed : false,
    c.type === "scale" ? c.steps.map((s) => [parseStepValue(s.value) ?? s.value, s.description]) : []
  ]);
}

export function createDraft(config, baseConfig, meta, locale) {
  const sections = (config.sections || []).map((s) => ({ ...s }));
  const known = new Set(sections.map((s) => s.id));
  for (const c of config.criteria || []) {
    if (!known.has(c.section)) {
      known.add(c.section);
      sections.push({ id: c.section, title: String(c.section ?? ""), labels: null });
    }
  }
  const criteria = (config.criteria || []).map((c, i) => fromCriterion(c, i, locale));
  const baseline = new Map();
  if (baseConfig) {
    (baseConfig.criteria || []).forEach((c, i) => baseline.set(c.id, snapshot(fromCriterion(c, i, locale))));
  }
  return {
    checklistId: meta.checklistId,
    versionId: meta.versionId ?? null,
    versionNumber: meta.versionNumber,
    baseNumber: meta.baseNumber ?? null,
    createdAt: meta.createdAt ?? null,
    config,
    sections,
    criteria,
    baseline,
    counter: criteria.length
  };
}

export function reset(draft, baseConfig, locale) {
  const next = createDraft(baseConfig || draft.config, baseConfig, draft, locale);
  Object.assign(draft, {
    sections: next.sections,
    criteria: next.criteria,
    counter: next.counter
  });
}

export function ordered(draft) {
  return draft.sections.flatMap((s) => draft.criteria.filter((c) => c.section === s.id));
}

export function numbering(draft) {
  const out = new Map();
  ordered(draft).forEach((c, i) => out.set(c.key, String(i + 1).padStart(2, "0")));
  return out;
}

export function isNew(draft, c) {
  return draft.baseline.size > 0 && !draft.baseline.has(c.id);
}

export function isChanged(draft, c) {
  return draft.baseline.has(c.id) && draft.baseline.get(c.id) !== snapshot(c);
}

export function changedCount(draft) {
  if (draft.baseline.size === 0) return 0;
  const present = new Set(draft.criteria.map((c) => c.id));
  let removed = 0;
  for (const id of draft.baseline.keys()) if (!present.has(id)) removed += 1;
  return draft.criteria.filter((c) => isNew(draft, c) || isChanged(draft, c)).length + removed;
}

function nextId(draft) {
  const numeric = draft.criteria.map((c) => Number(c.id)).filter((n) => Number.isInteger(n));
  const taken = new Set(draft.criteria.map((c) => String(c.id)));
  for (const id of draft.baseline.keys()) taken.add(String(id));
  let n = Math.max(0, ...numeric) + 1;
  let id = String(n).padStart(2, "0");
  while (taken.has(id)) {
    n += 1;
    id = String(n).padStart(2, "0");
  }
  return id;
}

export function addCriterion(draft, sectionId, defaults) {
  const created = {
    key: `k${draft.counter}`,
    id: nextId(draft),
    section: sectionId,
    name: defaults.name,
    description: defaults.description,
    type: "yn",
    weight: "0",
    naCondition: "",
    naAllowed: false,
    steps: [],
    labels: null
  };
  draft.counter += 1;
  let at = draft.criteria.length;
  for (let i = draft.criteria.length - 1; i >= 0; i -= 1) {
    if (draft.criteria[i].section === sectionId) {
      at = i + 1;
      break;
    }
  }
  draft.criteria.splice(at, 0, created);
  return created.key;
}

export function removeCriterion(draft, key) {
  if (draft.criteria.length <= 1) return null;
  const list = ordered(draft);
  const index = list.findIndex((c) => c.key === key);
  if (index < 0) return null;
  draft.criteria = draft.criteria.filter((c) => c.key !== key);
  const rest = ordered(draft);
  return rest[Math.min(index, rest.length - 1)].key;
}

export function moveCriterion(draft, key, direction) {
  const at = draft.criteria.findIndex((c) => c.key === key);
  if (at < 0) return false;
  const section = draft.criteria[at].section;
  let to = at + direction;
  while (to >= 0 && to < draft.criteria.length && draft.criteria[to].section !== section) to += direction;
  if (to < 0 || to >= draft.criteria.length) return false;
  const [item] = draft.criteria.splice(at, 1);
  draft.criteria.splice(to, 0, item);
  return true;
}

export function setType(draft, key, type, seedSteps) {
  const c = draft.criteria.find((x) => x.key === key);
  if (!c || !TYPES.includes(type)) return;
  c.type = type;
  if (type === "flag") c.weight = "0";
  if (type === "scale" && c.steps.length === 0) c.steps = seedSteps.map((s) => ({ ...s }));
  if (type === "scale") c.naAllowed = c.naCondition.trim() !== "";
}

export function setNaCondition(c, text) {
  c.naCondition = text;
  if (c.type === "scale") c.naAllowed = text.trim() !== "";
}

export function toConfig(draft) {
  const criteria = ordered(draft).map((c) => {
    const hundredths = parseHundredths(c.weight);
    const weight = c.type === "flag" || hundredths === null ? 0 : hundredths / 100;
    const out = {
      id: c.id,
      title: c.name,
      description: c.description,
      section: c.section,
      weight,
      type: c.type === "scale" ? "scale" : c.type === "flag" ? "flag" : "yes_no",
      na_allowed: c.type === "ynna" || (c.type === "scale" && c.naAllowed),
      na_condition: hasNa(c.type) && c.naCondition.trim() !== "" ? c.naCondition : null,
      scale_steps: [],
      max_step: null,
      labels: staleLabels(c)
    };
    if (c.type === "scale") {
      const steps = c.steps.map((s) => ({ value: parseStepValue(s.value), descriptor: s.description }));
      out.scale_steps = steps;
      const values = steps.map((s) => s.value).filter((v) => v !== null);
      out.max_step = values.length ? Math.max(...values) : null;
    }
    return out;
  });
  return { ...draft.config, sections: draft.sections.map((s) => ({ ...s })), criteria };
}
