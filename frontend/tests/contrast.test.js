import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");
const light = css.split("@media")[0].split("[data-theme")[0];
const tokens = {};
for (const match of light.matchAll(/--cqa-([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) tokens[match[1]] = match[2];

function luminance(hex) {
  const channel = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2];
}

export function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["surface", "surface-2", "surface-3", "brand-tint", "op-tint", "hl", "critical-bg", "warn-bg", "na-bg", "ok-bg", "bad-bg"];

const TEXT_PAIRS = [
  ...["ink", "ink-2", "ink-3"].flatMap((fg) => ["surface", "surface-2", "surface-3", "brand-tint", "op-tint", "hl", "critical-bg"].map((bg) => [fg, bg])),
  ["ok", "ok-bg"],
  ["warn", "warn-bg"],
  ["bad", "bad-bg"],
  ["na", "na-bg"],
  ["critical", "critical-bg"],
  ["ok", "surface"],
  ["warn", "surface"],
  ["bad", "surface"],
  ["na", "surface"],
  ["critical", "surface"],
  ["brand-strong", "surface"],
  ["brand-strong", "brand-tint"],
  ["brand-deep", "surface"],
  ["brand-deep", "brand-tint"],
  ["brand-deep", "surface-2"],
  ["on-brand", "brand-deep"],
  ["on-brand", "brand-strong"]
];

const UI_PAIRS = [
  ["focus", "surface"],
  ["focus", "surface-2"],
  ["focus", "brand-tint"],
  ["brand-deep", "surface"],
  ["brand-strong", "surface"]
];

test("tokens used by the light theme parse", () => {
  for (const name of SURFACES.concat(["ink", "ink-2", "ink-3", "ok", "warn", "bad", "na", "critical", "brand-strong", "brand-deep", "on-brand", "focus"])) {
    assert.match(tokens[name] || "", /^#[0-9A-Fa-f]{6}$/, name);
  }
});

test("normal text pairs reach 4.5:1", () => {
  const failures = TEXT_PAIRS.map(([fg, bg]) => ({ fg, bg, value: ratio(tokens[fg], tokens[bg]) })).filter((r) => r.value < 4.5);
  assert.deepEqual(failures.map((f) => `${f.fg} on ${f.bg} ${f.value.toFixed(2)}`), []);
});

test("focus ring and UI component pairs reach 3:1", () => {
  const failures = UI_PAIRS.map(([fg, bg]) => ({ fg, bg, value: ratio(tokens[fg], tokens[bg]) })).filter((r) => r.value < 3);
  assert.deepEqual(failures.map((f) => `${f.fg} on ${f.bg} ${f.value.toFixed(2)}`), []);
});

test("ratio helper matches the WCAG reference values", () => {
  assert.equal(ratio("#000000", "#FFFFFF").toFixed(1), "21.0");
  assert.equal(ratio("#777777", "#FFFFFF").toFixed(2), "4.48");
});
