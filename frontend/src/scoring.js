export const NA = "na";
export const NEEDS_REVIEW = "needs_review";
export const YES = "yes";
export const NO = "no";
export const ANSWERED = "answered";

export class ScoringError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScoringError";
  }
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function rat(n, d = 1n) {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n < 0n ? -n : n, d) || 1n;
  return { n: n / g, d: d / g };
}

const ZERO = rat(0n);

function add(a, b) {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

function mul(a, b) {
  return rat(a.n * b.n, a.d * b.d);
}

function div(a, b) {
  return rat(a.n * b.d, a.d * b.n);
}

function sum(list) {
  return list.reduce(add, ZERO);
}

function isPositive(a) {
  return a.n > 0n;
}

function parseDecimal(value) {
  let text = String(value).trim();
  if (/e/i.test(text)) text = Number(value).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new ScoringError(`invalid number ${value}`);
  const frac = m[3] || "";
  const n = BigInt(m[2] + frac) * (m[1] ? -1n : 1n);
  return rat(n, 10n ** BigInt(frac.length));
}

function roundCents(a) {
  const n = a.n * 100n;
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const q = (2n * abs + a.d) / (2n * a.d);
  return neg ? -q : q;
}

function toNumber(cents) {
  return Number(cents) / 100;
}

function money(a) {
  return toNumber(roundCents(a));
}

const HUNDRED = rat(100n);

function normalise(value) {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "n/a" || v === "na" || v === "not_applicable") return NA;
    if (v === "needs_review" || v === "needs review") return NEEDS_REVIEW;
    if (v === "yes" || v === "true") return YES;
    if (v === "no" || v === "false") return NO;
    if (/^-?\d+$/.test(v)) return Number(v);
    return value;
  }
  if (typeof value === "boolean") return value ? YES : NO;
  return value;
}

function stepValues(crit) {
  return (crit.scale_steps || []).map((s) => s.value);
}

function maxStep(crit) {
  if (Number.isInteger(crit.max_step) && crit.max_step > 0) return crit.max_step;
  return Math.max(...stepValues(crit));
}

function classify(crit, raw) {
  if (raw === null || raw === undefined) return [NEEDS_REVIEW, null];
  const ans = normalise(raw);
  if (ans === NEEDS_REVIEW) return [NEEDS_REVIEW, null];
  if (ans === NA) {
    if (crit.type === "flag" || !crit.na_allowed) {
      throw new ScoringError(`criterion ${crit.id}: N/A is not allowed`);
    }
    return [NA, NA];
  }
  if (crit.type === "scale") {
    if (typeof ans !== "number" || !Number.isInteger(ans)) {
      throw new ScoringError(`criterion ${crit.id}: invalid scale answer ${JSON.stringify(raw)}`);
    }
    if (!stepValues(crit).includes(ans)) {
      throw new ScoringError(`criterion ${crit.id}: ${ans} is not a configured scale step`);
    }
    return [ANSWERED, ans];
  }
  if (ans !== YES && ans !== NO) {
    throw new ScoringError(`criterion ${crit.id}: invalid answer ${JSON.stringify(raw)}`);
  }
  return [ANSWERED, ans];
}

export function score(config, answers = {}, overrides = null) {
  const merged = { ...answers, ...(overrides || {}) };
  const criteria = config.criteria || [];
  const known = new Set(criteria.map((c) => c.id));
  const unknown = Object.keys(merged).filter((k) => !known.has(k)).sort();
  if (unknown.length) throw new ScoringError(`unknown criteria: ${unknown.join(", ")}`);

  const rows = criteria.map((crit) => {
    const [status, answer] = classify(crit, merged[crit.id]);
    const weight = parseDecimal(crit.weight ?? 0);
    let points = null;
    if (status === ANSWERED && crit.type !== "flag") {
      if (crit.type === "yes_no") points = answer === YES ? weight : ZERO;
      else points = div(mul(weight, rat(BigInt(answer))), rat(BigInt(maxStep(crit))));
    }
    return { crit, status, answer, weight, points };
  });

  const counts = (r) => r.crit.type !== "flag" && r.status === ANSWERED;
  const counted = rows.filter(counts);
  const applicable = sum(counted.map((r) => r.weight));
  const earned = sum(counted.map((r) => r.points));
  const needsReviewIds = rows.filter((r) => r.status === NEEDS_REVIEW).map((r) => r.crit.id);
  const hasApplicable = isPositive(applicable);

  let total = null;
  let reason = null;
  if (hasApplicable) total = money(div(mul(HUNDRED, earned), applicable));
  else if (needsReviewIds.length) reason = "all weighted criteria are N/A or awaiting review";
  else reason = "all weighted criteria are N/A";

  const factor = hasApplicable ? div(HUNDRED, applicable) : null;

  const ledger = rows.map((r) => {
    const isCounted = counts(r) && hasApplicable;
    return {
      id: r.crit.id,
      type: r.crit.type,
      section: r.crit.section ?? null,
      status: r.status,
      answer: r.answer,
      na: r.status === NA,
      weight: toNumber(roundCents(r.weight)),
      effectiveWeight: isCounted ? money(mul(r.weight, factor)) : null,
      points: r.points === null ? null : money(r.points),
      effectivePoints: isCounted ? money(mul(r.points, factor)) : null
    };
  });

  const flags = rows.filter((r) => r.crit.type === "flag");
  let grossViolation = null;
  if (flags.length) {
    if (flags.some((r) => r.answer === YES)) grossViolation = true;
    else if (flags.some((r) => r.status === NEEDS_REVIEW)) grossViolation = null;
    else grossViolation = false;
  }

  const sections = (config.sections || []).map((sec) => {
    const members = counted.filter((r) => r.crit.section === sec.id);
    const max = sum(members.map((r) => r.weight));
    if (!isPositive(max)) {
      return {
        id: sec.id,
        title: sec.title,
        earned: null,
        applicableMax: 0,
        percent: null,
        effectivePoints: null,
        effectiveMax: null
      };
    }
    const secEarned = sum(members.map((r) => r.points));
    return {
      id: sec.id,
      title: sec.title,
      earned: money(secEarned),
      applicableMax: money(max),
      percent: money(div(mul(HUNDRED, secEarned), max)),
      effectivePoints: factor ? money(mul(secEarned, factor)) : null,
      effectiveMax: factor ? money(mul(max, factor)) : null
    };
  });

  return {
    total,
    calculated: total !== null,
    reason,
    provisional: needsReviewIds.length > 0,
    needsReviewIds,
    grossViolation,
    applicableWeight: hasApplicable ? money(applicable) : 0,
    factor: factor ? Number(factor.n * 1000000n / factor.d) / 1000000 : null,
    criteria: ledger,
    sections
  };
}

export function previewTotal(config, answers, overrides) {
  return score(config, answers, overrides).total;
}
