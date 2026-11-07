import test from "node:test";
import assert from "node:assert/strict";
import {
  barHeights,
  clamp,
  formatClock,
  nextPosition,
  percentOf,
  playerPhase,
  positionText,
  resolveDuration,
  sourceList,
  speedLabel,
  valueText
} from "../src/components/audio-player-model.js";

test("clock and position text", () => {
  assert.equal(formatClock(44.9), "00:44");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(positionText(44, 164), "00:44 / 02:44");
  assert.equal(valueText(44, 164, "ru"), "00:44 из 02:44");
  assert.equal(valueText(44, 164, "en"), "00:44 of 02:44");
});

test("clamp and percent", () => {
  assert.equal(clamp(-4, 100), 0);
  assert.equal(clamp(120, 100), 100);
  assert.equal(clamp("x", 100), 0);
  assert.equal(percentOf(43, 164).toFixed(2), "26.22");
  assert.equal(percentOf(5, 0), 0);
});

test("keyboard seeking moves by 5 seconds and stays in range", () => {
  assert.equal(nextPosition(50, "ArrowRight", 164), 55);
  assert.equal(nextPosition(50, "ArrowLeft", 164), 45);
  assert.equal(nextPosition(2, "ArrowLeft", 164), 0);
  assert.equal(nextPosition(162, "ArrowRight", 164), 164);
  assert.equal(nextPosition(10, "Home", 164), 0);
  assert.equal(nextPosition(10, "End", 164), 164);
  assert.equal(nextPosition(10, "x", 164), null);
});

test("duration prefers the media, then the declared value, then the last message", () => {
  assert.equal(resolveDuration({ media: 170.2, declared: 164, lastStart: 162 }), 170.2);
  assert.equal(resolveDuration({ media: NaN, declared: 164, lastStart: 162 }), 164);
  assert.equal(resolveDuration({ declared: null, lastStart: 162 }), 162);
  assert.equal(resolveDuration({}), 0);
});

test("speed labels per locale", () => {
  assert.equal(speedLabel(1, "ru"), "1×");
  assert.equal(speedLabel(1.5, "ru"), "1,5×");
  assert.equal(speedLabel(1.5, "kk"), "1,5×");
  assert.equal(speedLabel(1.5, "en"), "1.5×");
});

test("waveform bars are normalised, and absent without peaks", () => {
  assert.deepEqual(barHeights(null), []);
  assert.deepEqual(barHeights([]), []);
  const bars = barHeights([10, 20, 40, 5], 4);
  assert.equal(bars.length, 4);
  assert.equal(Math.max(...bars), 40);
  assert.ok(Math.min(...bars) >= 3);
});

test("phases", () => {
  assert.equal(playerPhase({ sources: [] }), "unavailable");
  assert.equal(playerPhase({ sources: ["a"] }), "loading");
  assert.equal(playerPhase({ sources: ["a"], loaded: true }), "ready");
  assert.equal(playerPhase({ sources: ["a"], failed: true }), "error");
  assert.deepEqual(sourceList(null, null), []);
  assert.deepEqual(sourceList("a", "b"), ["a", "b"]);
  assert.deepEqual(sourceList("a", "a"), ["a"]);
});
