import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const KAZAKH_SAMPLE = "Проверка әғқңөұүһі 0123456789";

function parseArgs(argv) {
  const args = { widths: [768, 1440], scenario: "shell", out: "/tmp/cqa-ui", port: 9333, height: 900 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[(i += 1)];
    if (key === "--url") args.url = next();
    else if (key === "--widths") args.widths = next().split(",").map(Number);
    else if (key === "--scenario") args.scenario = next();
    else if (key === "--out") args.out = next();
    else if (key === "--port") args.port = Number(next());
    else if (key === "--height") args.height = Number(next());
    else if (key === "--keep-open") args.keepOpen = true;
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.url) throw new Error("--url is required");
  return args;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
}

async function waitFor(fn, timeout = 15000, step = 100) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
    }
    if (Date.now() - start > timeout) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, step));
  }
}

const DEEP = `
function cqaDeep(selector, root) {
  const parts = selector.split(">>>").map((s) => s.trim());
  let scopes = [root || document];
  for (const part of parts) {
    const next = [];
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll(part)) next.push(el.shadowRoot ? { el, shadow: el.shadowRoot } : { el });
    }
    scopes = next.map((n) => n.shadow || n.el);
    scopes.els = next.map((n) => n.el);
    if (part === parts[parts.length - 1]) return next.map((n) => n.el);
  }
  return [];
}
function cqaAll(root) {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root || document);
  return out;
}
`;

export const scenarios = {
  async shell(page) {
    await page.waitForSelector("cqa-app");
    await page.waitForDeep("cqa-app >>> header");
    page.assert(await page.deepCount("cqa-app >>> nav a") === 5, "nav has 5 links");
    page.assert(await page.deepCount("cqa-app >>> select") === 2, "role and locale selects present");
    await page.assertAccessibleNames();
  },

  async fonts(page) {
    await page.waitForDeep("cqa-app >>> h1");
    const result = await page.eval(`(async () => {
      await document.fonts.load('600 16px Inter', ${JSON.stringify(KAZAKH_SAMPLE)});
      await document.fonts.load('400 16px Inter', 'Abc');
      const host = document.querySelector('cqa-app');
      const h1 = host.shadowRoot.querySelector('h1');
      return {
        check: document.fonts.check('16px Inter', ${JSON.stringify(KAZAKH_SAMPLE)}),
        family: getComputedStyle(h1).fontFamily,
        loaded: [...document.fonts].filter((f) => f.status === 'loaded').length
      };
    })()`);
    page.assert(result.check === true, "document.fonts.check for Inter with Cyrillic and Kazakh text");
    page.assert(/^"?Inter"?/.test(result.family), `font-family inside shadow root starts with Inter (${result.family})`);
    page.assert(result.loaded >= 2, `at least two Inter subsets loaded (${result.loaded})`);
    const fontRequests = page.requests.filter((u) => u.endsWith(".woff2"));
    page.assert(fontRequests.length >= 2, `woff2 files fetched from origin (${fontRequests.length})`);
  },

  async "base-element"(page) {
    await page.waitForDeep("cqa-app >>> header");
    const result = await page.eval(`(async () => {
      const mod = await import(new URL('src/base-element.js', location.href).href);
      class CqaProbe extends mod.CqaElement {
        template() { return mod.raw('<p id="probe">' + this.t('state.loading') + '</p>'); }
      }
      customElements.define('cqa-probe', CqaProbe);
      const el = document.createElement('cqa-probe');
      document.body.append(el);
      await new Promise((r) => setTimeout(r, 300));
      return {
        hasShadow: !!el.shadowRoot,
        text: el.shadowRoot.querySelector('#probe')?.textContent,
        brand: getComputedStyle(el).getPropertyValue('--cqa-brand').trim(),
        control: getComputedStyle(el).getPropertyValue('--cqa-control-h').trim(),
        adopted: el.shadowRoot.adoptedStyleSheets.length,
        themeAttr: el.hasAttribute('theme')
      };
    })()`);
    page.assert(result.hasShadow, "element renders in a shadow root");
    page.assert(result.text === "Загрузка", `probe text rendered (${result.text})`);
    page.assert(result.brand === "#51AF3D", `--cqa-brand is #51AF3D (${result.brand})`);
    page.assert(result.control === "34px", `--cqa-control-h is 34px (${result.control})`);
    page.assert(result.adopted === 1, "tokens adopted as a constructable stylesheet");
    page.assert(!result.themeAttr, "no theme attribute handling");
  },

  async locale(page) {
    await page.waitForDeep("cqa-app >>> header");
    await page.eval(`(() => { const app = document.querySelector('cqa-app'); app.setAttribute('locale', 'en'); })()`);
    await waitFor(async () => (await page.deepText("cqa-app >>> nav a")) === "Overview");
    page.assert(true, "locale attribute switches nav to English");
  },

  async keys(page) {
    await page.waitForDeep("cqa-app >>> header");
    await page.eval(`document.querySelector('cqa-app').shadowRoot.querySelector('nav a').focus()`);
    await page.press("Tab");
    const tag = await page.eval(`document.querySelector('cqa-app').shadowRoot.activeElement?.textContent`);
    page.assert(tag === "Диалоги", `Tab moves focus to the second nav link (${tag})`);
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarioNames = args.scenario === "all" ? Object.keys(scenarios) : args.scenario.split(",");
  for (const name of scenarioNames) if (!scenarios[name]) throw new Error(`unknown scenario ${name}`);
  mkdirSync(args.out, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "cqa-chrome-"));
  const origin = new URL(args.url).origin;
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${args.port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  const failures = [];
  try {
    const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json());
    const targets = await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json();
    const pageTarget = targets.find((t) => t.type === "page");
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const cdp = new Cdp(ws);
    const consoleErrors = [];
    const requests = [];
    const external = [];
    const failed = [];
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error") consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(" "));
    });
    cdp.on("Runtime.exceptionThrown", (p) => consoleErrors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    cdp.on("Log.entryAdded", (p) => {
      if (p.entry.level === "error") consoleErrors.push(`${p.entry.text} ${p.entry.url || ""}`.trim());
    });
    cdp.on("Network.requestWillBeSent", (p) => {
      const url = p.request.url;
      if (url.startsWith("data:") || url.startsWith("about:")) return;
      requests.push(url);
      if (!url.startsWith(origin) && !url.startsWith("http://localhost")) external.push(url);
    });
    cdp.on("Network.loadingFailed", (p) => failed.push(`${p.errorText} ${p.requestId}`));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

    for (const name of scenarioNames) {
      for (const width of args.widths) {
        const label = `${name}@${width}`;
        const problems = [];
        consoleErrors.length = 0;
        requests.length = 0;
        external.length = 0;
        failed.length = 0;
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: args.height,
          deviceScaleFactor: 1,
          mobile: false
        });
        await cdp.send("Page.navigate", { url: args.url });
        const page = {
          requests,
          assert(cond, message) {
            if (!cond) problems.push(`assertion failed: ${message}`);
          },
          async eval(expression) {
            const res = await cdp.send("Runtime.evaluate", {
              expression: `${DEEP}\n${expression}`,
              awaitPromise: true,
              returnByValue: true
            });
            if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
            return res.result.value;
          },
          async waitForSelector(selector) {
            await waitFor(() => this.eval(`!!document.querySelector(${JSON.stringify(selector)})`));
          },
          async waitForDeep(selector) {
            await waitFor(() => this.eval(`cqaDeep(${JSON.stringify(selector)}).length > 0`));
          },
          async deepCount(selector) {
            return this.eval(`cqaDeep(${JSON.stringify(selector)}).length`);
          },
          async deepText(selector) {
            return this.eval(`cqaDeep(${JSON.stringify(selector)})[0]?.textContent.trim()`);
          },
          async click(selector) {
            await this.eval(`cqaDeep(${JSON.stringify(selector)})[0].click()`);
          },
          async press(key) {
            const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
            const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: codes[key] || key.toUpperCase().charCodeAt(0) };
            await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
            if (key.length === 1) await cdp.send("Input.dispatchKeyEvent", { type: "char", text: key, ...base });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
          },
          async assertAccessibleNames() {
            const missing = await this.eval(`cqaAll().filter((el) => {
              if (!el.matches('button, a[href], input, select, textarea, [role="button"], [role="tab"]')) return false;
              if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return false;
              if (el.textContent.trim()) return false;
              if (el.id && el.getRootNode().querySelector('label[for="' + el.id + '"]')) return false;
              return true;
            }).map((el) => el.outerHTML.slice(0, 80))`);
            page.assert(missing.length === 0, `interactive elements without accessible names: ${missing.join(" | ")}`);
          }
        };
        try {
          await waitFor(() => page.eval(`document.readyState === 'complete'`));
          await scenarios[name](page);
          await new Promise((r) => setTimeout(r, 200));
          const overflow = await page.eval(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })`);
          page.assert(overflow.sw <= overflow.iw, `no horizontal overflow (scrollWidth ${overflow.sw} > ${overflow.iw})`);
          page.assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
          page.assert(external.length === 0, `requests left the origin: ${external.join(", ")}`);
          page.assert(failed.length === 0, `failed requests: ${failed.join(", ")}`);
        } catch (error) {
          problems.push(`exception: ${error.message}`);
        }
        try {
          const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
          writeFileSync(join(args.out, `${name}-${width}.png`), Buffer.from(shot.data, "base64"));
        } catch (error) {
          problems.push(`screenshot failed: ${error.message}`);
        }
        console.log(`${problems.length ? "FAIL" : "PASS"} ${label}`);
        for (const p of problems) console.log(`  ${p}`);
        if (problems.length) failures.push(label);
      }
    }
    ws.close();
  } finally {
    chrome.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(profile, { recursive: true, force: true });
  }
  if (failures.length) {
    console.log(`failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
