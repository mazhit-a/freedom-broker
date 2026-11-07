import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LEGACY = [];
const TEXT = new Set([".js", ".mjs", ".css", ".html", ".json", ".txt"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (LEGACY.includes(rel.split("/")[0])) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(rel);
  }
  return out;
}

const FILES = walk(ROOT);
const ext = (file) => file.slice(file.lastIndexOf("."));
const SOURCE = FILES.filter((file) => [".js", ".mjs", ".css", ".html"].includes(ext(file)));
const RUNTIME = SOURCE.filter((file) => !file.startsWith("tests/"));
const read = (file) => readFileSync(join(ROOT, file), "utf8");

const OPEN = "/" + "*";
const CLOSE = "*" + "/";
const HTML_OPEN = "<!" + "--";

const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

export function jsComments(text) {
  const found = [];
  let i = 0;
  let last = "";
  const n = text.length;
  const templateStack = [];
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      found.push(text.slice(i, i + 30).split("\n")[0]);
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      found.push(text.slice(i, i + 30).split("\n")[0]);
      const end = text.indexOf(CLOSE, i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i += 1;
      last = "x";
      continue;
    }
    if (c === "`") {
      i += 1;
      for (;;) {
        if (i >= n) break;
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "`") {
          i += 1;
          break;
        }
        if (text[i] === "$" && text[i + 1] === "{") {
          let depth = 1;
          i += 2;
          const start = i;
          while (i < n && depth > 0) {
            if (text[i] === "{") depth += 1;
            else if (text[i] === "}") depth -= 1;
            else if (text[i] === "`") {
              i += 1;
              while (i < n && text[i] !== "`") i += text[i] === "\\" ? 2 : 1;
            } else if (text[i] === '"' || text[i] === "'") {
              const q = text[i];
              i += 1;
              while (i < n && text[i] !== q) i += text[i] === "\\" ? 2 : 1;
            }
            i += 1;
          }
          found.push(...jsComments(text.slice(start, i - 1)));
          continue;
        }
        i += 1;
      }
      last = "x";
      continue;
    }
    if (c === "/" && (last === "" || REGEX_BEFORE.has(last) || last === "r")) {
      i += 1;
      let inClass = false;
      while (i < n && (text[i] !== "/" || inClass)) {
        if (text[i] === "\\") i += 1;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        i += 1;
      }
      i += 1;
      last = "x";
      continue;
    }
    if (!/\s/.test(c)) last = /[A-Za-z0-9_$)\]]/.test(c) ? (c === ")" || c === "]" ? "x" : c === "n" || c === "r" ? "x" : "x") : c;
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      last = ["return", "typeof", "case", "in", "of", "void", "delete", "throw", "else", "do"].includes(word) ? "r" : "x";
      i = j;
      continue;
    }
    i += 1;
  }
  return found;
}

function cssComments(text) {
  const stripped = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
  return stripped.includes(OPEN) ? [OPEN] : [];
}

function htmlParts(text) {
  const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const styles = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  return { scripts, styles, markup: text.replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<style\b[\s\S]*?<\/style>/g, "") };
}

test("the new frontend tree is non-empty and excludes only the legacy UI", () => {
  assert.ok(RUNTIME.length > 40);
  assert.ok(RUNTIME.includes("demo.html") && RUNTIME.includes("index.html") && RUNTIME.includes("embed-test.html"));
  assert.ok(!FILES.some((file) => file.startsWith("js/")));
});

test("no source file contains comments", () => {
  const offenders = [];
  for (const file of SOURCE) {
    const text = read(file);
    let found = [];
    if (file.endsWith(".js") || file.endsWith(".mjs")) found = jsComments(text);
    else if (file.endsWith(".css")) found = cssComments(text);
    else {
      const parts = htmlParts(text);
      if (parts.markup.includes(HTML_OPEN)) found.push(HTML_OPEN);
      for (const code of parts.scripts) found.push(...jsComments(code));
      for (const css of parts.styles) found.push(...cssComments(css));
    }
    if (found.length) offenders.push(`${file}: ${found.slice(0, 2).join(" | ")}`);
  }
  assert.deepEqual(offenders, []);
});

test("comment scanner recognises comments and ignores strings and regexes", () => {
  assert.equal(jsComments("const a = 1; // x").length, 1);
  assert.equal(jsComments(`${OPEN} x ${CLOSE} const a = 1;`).length, 1);
  assert.equal(jsComments(`const a = "// not"; const b = \`${OPEN} not ${CLOSE}\`; const c = /\\/\\//g;`).length, 0);
  assert.equal(jsComments("const t = `${a " + OPEN + " in " + CLOSE + "}`;").length, 1);
});

test("no external URLs in runtime files and only reserved test hosts in tests", () => {
  const offenders = [];
  for (const file of SOURCE) {
    const text = read(file);
    const urls = text.match(/(?:https?:)?\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s"'`)]*|https?:\/\/[^\s"'`)]+/g) || [];
    for (const url of urls) {
      const isTest = file.startsWith("tests/");
      const allowed = isTest && /^https?:\/\/(backend\.test|127\.0\.0\.1:9)(\/|$)/.test(url);
      if (!allowed && !/^\/\/[A-Za-z0-9.-]+\.(js|mjs|css|html|json|woff2)$/.test(url)) offenders.push(`${file}: ${url}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("every src and href in html pages is relative", () => {
  const offenders = [];
  for (const file of FILES.filter((f) => f.endsWith(".html"))) {
    for (const match of read(file).matchAll(/(?:src|href)="([^"]*)"/g)) {
      const ref = match[1];
      if (ref.startsWith("#") || ref.startsWith("data:")) continue;
      if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(ref)) offenders.push(`${file}: ${ref}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("no module imports an absolute path or host", () => {
  const offenders = [];
  for (const file of RUNTIME.filter((f) => f.endsWith(".js"))) {
    const text = read(file);
    const specs = [
      ...text.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm),
      ...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
      ...text.matchAll(/\bimport\(\s*["']([^"']+)["']/g)
    ];
    for (const match of specs) {
      if (!/^\.{1,2}\//.test(match[1])) offenders.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

const FORBIDDEN_STORAGE = new RegExp(["local", "Storage|session", "Storage|indexed", "DB|document\\.cookie|caches\\."].join(""));

test("no browser storage or cookies anywhere in the new frontend", () => {
  const offenders = [];
  for (const file of SOURCE) {
    const text = read(file);
    if (FORBIDDEN_STORAGE.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("fonts are bundled and licensed", () => {
  const fonts = FILES.filter((f) => f.startsWith("src/fonts/"));
  assert.ok(fonts.includes("src/fonts/OFL.txt"));
  assert.equal(fonts.filter((f) => f.endsWith(".woff2")).length, 4);
  for (const match of read("src/fonts/fonts.css").matchAll(/url\(([^)]+)\)/g)) assert.ok(!/^["']?(https?:|\/)/.test(match[1]), match[1]);
});

test("text files are valid utf-8 without BOM", () => {
  for (const file of FILES.filter((f) => TEXT.has(ext(f)))) assert.ok(!read(file).startsWith("\uFEFF"), file);
});
