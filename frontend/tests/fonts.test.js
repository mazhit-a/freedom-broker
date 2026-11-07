import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
import { INTER_FACES } from "../src/fonts.js";

const dir = new URL("../src/fonts/", import.meta.url);

test("font files exist, are woff2 and are listed in fonts.css", () => {
  const css = readFileSync(new URL("fonts.css", dir), "utf8");
  for (const face of INTER_FACES) {
    const file = new URL(face.file, dir);
    assert.ok(statSync(file).size > 10000, face.file);
    assert.equal(readFileSync(file).subarray(0, 4).toString("latin1"), "wOF2");
    assert.ok(css.includes(face.file), face.file);
    assert.ok(css.includes(face.range), face.file);
  }
  assert.ok(existsSync(new URL("OFL.txt", dir)));
});

test("sources contain no external URLs", () => {
  const files = ["../src/fonts.js", "../src/base-element.js", "../src/index.js", "../src/fonts/fonts.css", "../index.html"];
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/https?:\/\//.test(text), f);
  }
});
