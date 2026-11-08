export const ROLES = Object.freeze(["exec", "reviewer", "operator"]);
export const DEFAULT_ROLE = "exec";

const LEGACY = { qa: "reviewer", reviewer: "reviewer", operator: "operator", exec: "exec" };

const CAPABILITIES = {
  exec: [],
  reviewer: [
    "select-criteria",
    "bulk-evaluate",
    "edit-checklist",
    "start-run",
    "re-evaluate",
    "open-queue",
    "start-review",
    "decide-appeal"
  ],
  operator: ["file-appeal"]
};

const SECTION_ACCESS = {
  operator: ["overview", "conversations", "appeals"]
};

export function allowedSections(role, sections) {
  const allowed = SECTION_ACCESS[normalizeRole(role)];
  return allowed ? sections.filter((s) => allowed.includes(s)) : sections.slice();
}

export function canOpenSection(role, section) {
  const allowed = SECTION_ACCESS[normalizeRole(role)];
  return !allowed || allowed.includes(section);
}

export function normalizeRole(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return LEGACY[key] || DEFAULT_ROLE;
}

export function can(role, capability) {
  return CAPABILITIES[normalizeRole(role)].includes(capability);
}

export function capabilities(role) {
  return CAPABILITIES[normalizeRole(role)].slice();
}

export function wireRole(role) {
  const normalized = normalizeRole(role);
  return normalized === "exec" ? null : normalized;
}
