export const REQUIRED_KEYS = Object.freeze(["conversation_id", "channel", "language", "transcript"]);

export function validateDatasetText(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (error) {
    return { ok: false, code: "json", params: {} };
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.conversations) ? data.conversations : null;
  if (!list) return { ok: false, code: "shape", params: {} };
  if (list.length === 0) return { ok: false, code: "empty", params: {} };
  for (let i = 0; i < list.length; i += 1) {
    const record = list[i];
    const missing = REQUIRED_KEYS.filter((key) => !record || typeof record !== "object" || !(key in record) || record[key] === null || record[key] === undefined);
    if (missing.length) return { ok: false, code: "keys", params: { index: i + 1, keys: missing.join(", ") } };
  }
  return { ok: true, count: list.length };
}

export function isJsonFile(file) {
  if (!file) return false;
  const name = String(file.name || "").toLowerCase();
  return name.endsWith(".json") || file.type === "application/json";
}

export function itemKind(item) {
  if (item.status === "failed") return "failed";
  if (item.status === "running") return "running";
  if (item.status === "queued") return "queued";
  if (item.status === "needs_review") return "lowConfidence";
  return "done";
}

export function progressSegments(run) {
  const base = run.toRun ?? run.total - run.skipped;
  if (!base || base <= 0) return { max: 0, now: 0, done: 0, failed: 0, running: 0 };
  const pct = (n) => Math.max(0, Math.min(100, (100 * n) / base));
  return {
    max: base,
    now: Math.min(base, run.done + run.failed),
    done: pct(run.done),
    failed: pct(run.failed),
    running: pct(run.running)
  };
}

export function queuedCount(run) {
  if (run.queued !== null && run.queued !== undefined) return run.queued;
  const base = run.toRun ?? run.total - run.skipped;
  return Math.max(0, base - run.done - run.failed - run.running);
}

export function savedVersionOptions(checklists) {
  const withSaved = checklists.filter((c) => c.versions.some((v) => v.status !== "draft"));
  const multi = withSaved.length > 1;
  const out = [];
  for (const c of withSaved) {
    for (const v of c.versions) {
      if (v.status === "draft") continue;
      out.push({
        id: v.id,
        label: v.label,
        isDefault: v.id === c.defaultVersionId || v.isDefault,
        createdAt: v.createdAt,
        checklistName: multi ? c.name : null,
        number: v.version,
        checklistId: c.id
      });
    }
  }
  return out;
}

export function otherVersionLabel(run, checklists) {
  const options = savedVersionOptions(checklists);
  const current = options.find((o) => o.id === run.versionId);
  const pool = current ? options.filter((o) => o.checklistId === current.checklistId && o.id !== current.id) : options.filter((o) => o.id !== run.versionId);
  const active = pool.find((o) => o.isDefault);
  if (active) return active.label;
  const lower = pool.filter((o) => !current || o.number < current.number).sort((a, b) => b.number - a.number)[0];
  return lower ? lower.label : null;
}

export function wallDateTime(value, locale, withTime = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(value ?? ""));
  if (!m) return "";
  const [, y, mo, d, h, mi] = m;
  const date = locale === "en" ? `${mo}/${d}/${y}` : `${d}.${mo}.${y}`;
  return withTime && h !== undefined ? `${date} ${h}:${mi}` : date;
}

export function latencyText(ms) {
  if (ms === null || ms === undefined) return null;
  return Number(ms) / 1000;
}

export function errorKey(error) {
  const code = error && error.code ? String(error.code) : "";
  if (["role_forbidden", "draft_version", "dataset_required", "not_implemented"].includes(code)) return code;
  return "generic";
}

export function runIsActive(run) {
  return Boolean(run) && run.status === "running";
}
