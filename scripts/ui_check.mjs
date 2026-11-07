import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
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
function cqaActive() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}
function cqaWithin(host, el) {
  while (el) {
    if (el === host) return true;
    const root = el.getRootNode();
    el = el.parentElement || (root && root.host) || null;
  }
  return false;
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
    await page.waitForDeep("cqa-app >>> cqa-header >>> header");
    await page.waitForDeep("cqa-app >>> cqa-header >>> cqa-nav >>> a");
    page.assert(await page.deepCount("cqa-app >>> cqa-header >>> cqa-nav >>> a") === 5, "nav has 5 links");
    page.assert(await page.deepCount("cqa-app >>> cqa-header >>> select") === 1, "role select present");
    page.assert(await page.deepCount("cqa-app >>> cqa-header >>> .seg button") === 3, "three language buttons");
    const options = await page.eval(`[...cqaDeep('cqa-app >>> cqa-header >>> select option')].map((o) => o.textContent.trim())`);
    page.assert(JSON.stringify(options) === JSON.stringify(["Руководитель", "QA / Проверяющий", "Оператор"]), `three roles (${options})`);
    page.assert((await page.deepText("cqa-app >>> cqa-header >>> .brand .logo")) === "FB", "FB brand block");
    page.assert((await page.eval(`cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> a[aria-current=page]')[0]?.getAttribute('data-route')`)) === "overview", "overview is current by default");
    page.assert((await page.deepCount("cqa-app >>> cqa-header >>> .seg [aria-pressed=true]")) === 1, "one pressed language button");
    await page.assertAccessibleNames();
  },

  async routing(page) {
    await page.waitForDeep("cqa-app >>> cqa-header >>> cqa-nav >>> a");
    await waitFor(() => page.eval(`!!cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> [data-count]')[0]`));
    const count = await page.deepText("cqa-app >>> cqa-header >>> cqa-nav >>> [data-count]");
    page.assert(/^\d+$/.test(count) && Number(count) > 0, `open appeals badge from appealSummary (${count})`);
    const expected = await page.eval(`(async () => { const m = await import(new URL('src/api.js', location.href).href); return (await m.api.appealSummary()).open; })()`);
    page.assert(String(expected) === count, `badge equals adapter count (${count} vs ${expected})`);
    await page.eval(`window.__nav = []; document.addEventListener('cqa:navigate', (e) => window.__nav.push({ to: e.detail.to, id: e.detail.id }));`);
    const routes = [
      ["#/overview", "overview", "overview"],
      ["#/conversations", "conversations", "conversations"],
      ["#/conversations/p1-ru-001", "conversations", "conversations/p1-ru-001"],
      ["#/appeals", "appeals", "appeals"],
      ["#/appeals/ap-1", "appeals", "appeals/ap-1"],
      ["#/checklists", "checklists", "checklists"],
      ["#/checklists/2", "checklists", "checklists/2"],
      ["#/runs", "runs", "runs"],
      ["#/runs/R-0001", "runs", "runs/R-0001"]
    ];
    for (const [hash, current, path] of routes) {
      await page.eval(`location.hash = ${JSON.stringify(hash)}`);
      await waitFor(() => page.eval(`cqaDeep('cqa-app >>> [data-placeholder]')[0]?.getAttribute('data-placeholder') === ${JSON.stringify(path)}`));
      const cur = await page.eval(`cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> a[aria-current=page]').map((a) => a.getAttribute('data-route')).join()`);
      page.assert(cur === current, `${hash}: aria-current is ${current} (${cur})`);
    }
    await page.eval(`location.hash = '#/nope/1/2'`);
    await waitFor(() => page.eval(`cqaDeep('cqa-app >>> [data-outlet] .panel-title')[0]?.textContent.trim() === 'Раздел не найден'`));
    page.assert((await page.deepCount("cqa-app >>> cqa-header >>> cqa-nav >>> a[aria-current=page]")) === 0, "unknown hash has no current nav item");
    await page.click("cqa-app >>> [data-action=empty-action]");
    await waitFor(() => page.eval(`location.hash === '#/overview'`));
    await page.click("cqa-app >>> cqa-header >>> cqa-nav >>> a[data-route=runs]");
    await waitFor(() => page.eval(`location.hash === '#/runs'`));
    const events = await page.eval("window.__nav");
    page.assert(events.some((e) => e.to === "runs"), `cqa:navigate reached the document from nested shadow roots (${JSON.stringify(events.slice(-3))})`);
    await page.eval(`history.back()`);
    await waitFor(() => page.eval(`location.hash === '#/overview'`));
    await waitFor(() => page.eval(`cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> a[aria-current=page]')[0]?.getAttribute('data-route') === 'overview'`));
  },

  async "shell-keys"(page) {
    await page.waitForDeep("cqa-app >>> cqa-header >>> cqa-nav >>> a");
    await page.eval(`document.activeElement && document.activeElement.blur()`);
    const order = [];
    for (let i = 0; i < 10; i += 1) {
      await page.press("Tab");
      const a = await page.active();
      order.push(a && a.focusId);
      page.assert(a && a.outline === "solid 2px", `focus ring on ${a && a.focusId} (${a && a.outline})`);
    }
    const expected = ["brand", "nav-overview", "nav-conversations", "nav-appeals", "nav-checklists", "nav-runs", "role", "locale-ru", "locale-kk", "locale-en"];
    page.assert(JSON.stringify(order) === JSON.stringify(expected), `tab order header, nav, role, language (${order})`);
    await page.press("Tab", 8);
    page.assert((await page.active()).focusId === "locale-kk", "Shift+Tab goes back");
    await page.press("Tab");
    await page.press("Enter");
    await waitFor(() => page.eval(`document.querySelector('cqa-app').getAttribute('locale') === 'en'`));
    const after = await page.active();
    page.assert(after && after.focusId === "locale-en", `focus stays on the language button after re-render (${JSON.stringify(after)})`);
    const label = await page.deepText("cqa-app >>> cqa-header >>> cqa-nav >>> a[data-route=overview]");
    page.assert(label === "Overview", `nav switched to English without reload (${label})`);
    const pressed = await page.eval(`cqaDeep('cqa-app >>> cqa-header >>> .seg button').map((b) => b.getAttribute('aria-pressed')).join()`);
    page.assert(pressed === "false,false,true", `aria-pressed group (${pressed})`);
    const stored = await page.eval(`(() => { try { return Object.keys(localStorage).filter((k) => k.startsWith('cqa')).length; } catch (e) { return 0; } })()`);
    page.assert(stored === 0, "locale switch wrote nothing to localStorage");
    await page.eval(`(() => { const s = cqaDeep('cqa-app >>> cqa-header >>> select')[0]; s.focus(); s.value = 'operator'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(() => page.eval(`document.querySelector('cqa-app').getAttribute('role') === 'operator'`));
    await waitFor(() => page.eval(`!!cqaDeep('cqa-app >>> cqa-header >>> [data-actor]')[0]`));
    page.assert((await page.deepText("cqa-app >>> cqa-header >>> [data-actor]")) === "Оператор A", "operator shows the constant actor label");
    const select = await page.active();
    page.assert(select && select.focusId === "role", "focus stays on the role select after role change");
    await page.assertAccessibleNames();
  },

  async iframe(page) {
    const target = (await page.eval("location.href"));
    await page.eval(`(() => { document.body.replaceChildren(); const f = document.createElement('iframe'); f.id = 'host'; f.src = ${JSON.stringify("__URL__")}; f.style.cssText = 'border:0;width:100%;height:700px;display:block'; document.body.append(f); })()`.replace("__URL__", target.split("#")[0]));
    await waitFor(() => page.eval(`(() => { const d = document.getElementById('host').contentDocument; const app = d && d.querySelector('cqa-app'); return !!(app && app.shadowRoot && app.shadowRoot.querySelector('cqa-header') && app.shadowRoot.querySelector('cqa-header').shadowRoot && app.shadowRoot.querySelector('cqa-header').shadowRoot.querySelector('cqa-nav') && app.shadowRoot.querySelector('cqa-header').shadowRoot.querySelector('cqa-nav').shadowRoot.querySelector('a')); })()`));
    await page.eval(`(() => { const d = document.getElementById('host').contentDocument; window.__outer = []; d.addEventListener('cqa:navigate', (e) => window.__outer.push(e.detail.to)); })()`);
    await page.eval(`document.getElementById('host').contentDocument.querySelector('cqa-app').shadowRoot.querySelector('cqa-header').shadowRoot.querySelector('cqa-nav').shadowRoot.querySelector('a[data-route=appeals]').click()`);
    await waitFor(() => page.eval(`window.__outer.includes('appeals')`));
    const hash = await page.eval(`document.getElementById('host').contentWindow.location.hash`);
    page.assert(hash === "#/appeals", `iframe hash routed (${hash})`);
    const inner = await page.eval(`(() => { const d = document.getElementById('host').contentDocument; return { sw: d.documentElement.scrollWidth, iw: d.documentElement.clientWidth }; })()`);
    page.assert(inner.sw <= inner.iw, `no horizontal overflow inside the iframe (${inner.sw} > ${inner.iw})`);
  },

  async gallery(page) {
    await page.waitForDeep("cqa-playground >>> #g-table [role=table]");
    const q = (sel) => page.deepCount(`cqa-playground >>> ${sel}`);
    page.assert((await q("#g-chips .chip")) === 13, "twelve answer and status chips plus the version chip");
    page.assert((await q("#g-chips .lang")) === 3, "three language chips");
    page.assert((await q("#g-messages .msg, #g-messages .msg-system")) >= 5, "five transcript messages");
    page.assert((await q("#g-criterion .crit")) === 1, "criterion row");
    page.assert((await q("#g-criterion .steps li")) === 4, "four scale steps");
    page.assert((await q("#g-states [aria-busy=true]")) === 1, "loading state has aria-busy");
    page.assert((await q("#g-states [data-action=retry]")) === 1, "error state has retry");
    page.assert((await q("#g-chart [role=img]")) === 1, "histogram figure");
    const heights = await page.eval(`(() => {
      const root = document.querySelector('cqa-playground').shadowRoot;
      const h = (s) => Math.round(root.querySelector(s).getBoundingClientRect().height);
      return { normal: h('#g-buttons .btn-primary'), small: h('#g-buttons .btn-sm') };
    })()`);
    page.assert(heights.normal === 34, `button is 34px (${heights.normal})`);
    page.assert(heights.small === 28, `small button is 28px (${heights.small})`);
    const table = await page.eval(`(() => {
      const root = document.querySelector('cqa-playground').shadowRoot;
      const tbl = root.querySelector('#g-table [role=table]');
      const wrap = root.querySelector('#g-table .tbl-wrap');
      return {
        rows: tbl.querySelectorAll('[role=row]').length,
        headers: tbl.querySelectorAll('[role=columnheader]').length,
        cells: tbl.querySelectorAll('[role=cell]').length,
        sort: tbl.querySelector('[aria-sort]')?.getAttribute('aria-sort'),
        secondary: getComputedStyle(root.querySelector('#g-table .secondary')).display,
        wrapClient: wrap.clientWidth, wrapScroll: wrap.scrollWidth
      };
    })()`);
    page.assert(table.rows === 5 && table.headers === 6 && table.cells === 24, `table roles ${JSON.stringify(table)}`);
    page.assert(table.sort === "none" || table.sort === "descending" || table.sort === "ascending", "aria-sort present");
    const width = await page.eval("window.innerWidth");
    if (width < 1100) page.assert(table.secondary === "none", "secondary column hidden at narrow container");
    else page.assert(table.secondary !== "none", "secondary column visible at wide container");
    const focusRing = await page.eval(`(() => {
      const root = document.querySelector('cqa-playground').shadowRoot;
      const b = root.querySelector('#g-buttons .btn-primary');
      b.focus();
      return getComputedStyle(b).outlineStyle + ' ' + getComputedStyle(b).outlineWidth;
    })()`);
    page.assert(focusRing === "none 0px" ? false : true, `focus ring on keyboard focus (${focusRing})`);
    await page.press("Tab");
    const ring = await page.eval(`(() => {
      const a = document.querySelector('cqa-playground').shadowRoot.activeElement;
      const cs = getComputedStyle(a);
      return { outline: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
    })()`);
    page.assert(ring.outline === "solid" && ring.width === "2px", `visible focus ring after Tab ${JSON.stringify(ring)}`);
    await page.click("cqa-playground >>> #g-table [data-action=sort]");
    await waitFor(() => page.eval(`!!document.querySelector('cqa-playground').shadowRoot.querySelector('#g-table [aria-sort=ascending]')`));
    await page.click("cqa-playground >>> #g-table [data-action=sort]");
    await waitFor(() => page.eval(`!!document.querySelector('cqa-playground').shadowRoot.querySelector('#g-table [aria-sort=descending]')`));
    await page.click(`cqa-playground >>> #g-table [data-action=select-row][data-id=call-014]`);
    await waitFor(() => page.eval(`document.querySelector('cqa-playground').shadowRoot.querySelectorAll('#g-table [aria-selected=true]').length === 2`));
    await page.eval(`document.querySelector('cqa-playground').setAttribute('locale', 'en')`);
    await waitFor(() => page.eval(`document.querySelector('cqa-playground').shadowRoot.querySelector('#g-kf .kf-value').textContent.trim() === '78.42'`));
    const en = await page.deepText("cqa-playground >>> #g-chips .chip");
    page.assert(en === "Yes", `English chips (${en})`);
    await page.eval(`document.querySelector('cqa-playground').setAttribute('locale', 'kk')`);
    await waitFor(() => page.eval(`document.querySelector('cqa-playground').shadowRoot.querySelector('#g-kf .kf-value').textContent.trim().startsWith('78')`));
    await page.eval(`document.querySelector('cqa-playground').setAttribute('locale', 'ru')`);
    await waitFor(() => page.eval(`document.querySelector('cqa-playground').shadowRoot.querySelector('#g-kf .kf-value').textContent.trim() === '78,42'`));
    const colours = await page.eval(`(() => {
      const root = document.querySelector('cqa-playground').shadowRoot;
      const probe = (cls) => { const e = root.querySelector('#g-chips .' + cls); return getComputedStyle(e).backgroundColor; };
      return [probe('c-ok'), probe('c-bad'), probe('c-crit'), probe('c-brand')];
    })()`);
    page.assert(new Set(colours).size === 4, `chip tones resolve to four token colours ${colours.join(", ")}`);
    await page.assertAccessibleNames();
    const noScroll = await page.eval(`(() => {
      const root = document.querySelector('cqa-playground').shadowRoot;
      return [...root.querySelectorAll('.card')].filter((c) => c.scrollWidth > c.clientWidth + 1 && !c.querySelector('.tbl-wrap')).length;
    })()`);
    page.assert(noScroll === 0, `no card overflows horizontally (${noScroll})`);
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
    await page.waitForDeep("cqa-app >>> cqa-header");
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
    await page.waitForDeep("cqa-app >>> cqa-header >>> cqa-nav >>> a");
    await page.eval(`(() => { const app = document.querySelector('cqa-app'); app.setAttribute('locale', 'en'); })()`);
    await waitFor(async () => (await page.deepText("cqa-app >>> cqa-header >>> cqa-nav >>> a")) === "Overview");
    page.assert(true, "locale attribute switches nav to English");
  },

  async "mock-adapter"(page) {
    const result = await page.eval(`(async () => {
      const mod = await import(new URL('src/api.js', location.href).href);
      mod.configure();
      const list = await mod.api.listConversations();
      const ev = await mod.api.getEvaluation('p1-ru-001');
      const appeals = await mod.api.listAppeals();
      return { mock: mod.getSettings().mock, total: list.total, evaluation: ev.total, appeals: appeals.length, first: list.items[0].id };
    })()`);
    page.assert(result.mock === true, "mock mode enabled by the ?mock=1 query");
    page.assert(result.total === 11 && result.first === "p1-ru-001", `mock list served (${JSON.stringify(result)})`);
    page.assert(result.evaluation === 81.88, `p1-ru-001 total computed by scoring.js (${result.evaluation})`);
    page.assert(result.appeals === 5, "mock appeals served");
    page.assert(!page.requests.some((u) => u.includes("/api/v1")), "mock mode made no backend requests");
  },

  async overlays(page) {
    await page.waitForDeep("cqa-playground >>> #g-overlays [data-action=open-drawer]");
    const PG = "document.querySelector('cqa-playground').shadowRoot";
    const focusBtn = (id) => page.eval(`${PG}.querySelector('[data-focus-id=${id}]').focus()`);
    await focusBtn("open-drawer");
    await page.press("Enter");
    await waitFor(() => page.eval(`${PG}.querySelector('#g-drawer').hasAttribute('open')`));
    await new Promise((r) => setTimeout(r, 150));
    const aria = await page.eval(`(() => {
      const d = ${PG}.querySelector('#g-drawer');
      const dlg = d.shadowRoot.querySelector('[role=dialog]');
      const label = d.shadowRoot.getElementById(dlg.getAttribute('aria-labelledby'));
      const box = dlg.getBoundingClientRect();
      return { modal: dlg.getAttribute('aria-modal'), label: label && label.textContent.trim(), right: Math.round(box.right), width: Math.round(box.width), height: Math.round(box.height), vw: innerWidth, vh: innerHeight };
    })()`);
    page.assert(aria.modal === "false" && aria.label === "Апелляция", `drawer is a non-modal dialog labelled by its heading (${JSON.stringify(aria)})`);
    page.assert(aria.right === aria.vw && aria.width <= 440 && aria.height === aria.vh, `drawer pinned to the viewport right edge (${JSON.stringify(aria)})`);
    let a = await page.active();
    page.assert(a && a.tag === "input", `focus moved into the drawer (${JSON.stringify(a)})`);
    await page.eval(`window.scrollTo(0, 600)`);
    const still = await page.eval(`(() => { const dlg = ${PG}.querySelector('#g-drawer').shadowRoot.querySelector('[role=dialog]'); return Math.round(dlg.getBoundingClientRect().top); })()`);
    page.assert(still === 0, `drawer stays fixed to the viewport after scrolling (${still})`);
    const bgInert = await page.eval(`${PG}.querySelector('[data-root]').hasAttribute('inert')`);
    page.assert(!bgInert, "page behind a non-modal drawer stays interactive");
    await page.press("Escape");
    await waitFor(() => page.eval(`!${PG}.querySelector('#g-drawer').hasAttribute('open')`));
    await new Promise((r) => setTimeout(r, 100));
    a = await page.active();
    page.assert(a && a.focusId === "open-drawer", `focus returned to the drawer opener (${JSON.stringify(a)})`);
    await page.eval(`window.scrollTo(0, 0)`);

    await focusBtn("open-modal");
    await page.press("Enter");
    await waitFor(() => page.eval(`${PG}.querySelector('#g-modal').hasAttribute('open')`));
    await new Promise((r) => setTimeout(r, 150));
    const modal = await page.eval(`(() => {
      const m = ${PG}.querySelector('#g-modal');
      const dlg = m.shadowRoot.querySelector('[role=dialog]');
      const title = m.shadowRoot.getElementById(dlg.getAttribute('aria-labelledby'));
      const desc = m.shadowRoot.getElementById(dlg.getAttribute('aria-describedby'));
      return { modal: dlg.getAttribute('aria-modal'), title: title && title.textContent.trim(), desc: desc && desc.textContent.trim(), inert: ${PG}.querySelector('[data-root]').hasAttribute('inert') };
    })()`);
    page.assert(modal.modal === "true" && modal.title === "Применить v3?" && modal.desc === "25 диалогов будут переоценены.", `modal ARIA wiring (${JSON.stringify(modal)})`);
    page.assert(modal.inert, "page behind the modal is inert");
    const trail = [];
    for (let i = 0; i < 7; i += 1) {
      const inside = await page.eval(`(() => { const a = cqaActive(); return cqaWithin(${PG}.querySelector('#g-modal'), a); })()`);
      trail.push(inside);
      await page.press("Tab");
    }
    page.assert(trail.every(Boolean), `focus never leaves the modal while tabbing (${trail})`);
    for (let i = 0; i < 4; i += 1) {
      await page.press("Tab", 8);
      const inside = await page.eval(`cqaWithin(${PG}.querySelector('#g-modal'), cqaActive())`);
      page.assert(inside, "Shift+Tab stays inside the modal");
    }
    await page.press("Escape");
    await waitFor(() => page.eval(`!${PG}.querySelector('#g-modal').hasAttribute('open')`));
    await new Promise((r) => setTimeout(r, 100));
    a = await page.active();
    page.assert(a && a.focusId === "open-modal", `focus returned to the modal opener (${JSON.stringify(a)})`);
    page.assert(!(await page.eval(`${PG}.querySelector('[data-root]').hasAttribute('inert')`)), "inert removed after the modal closes");

    await focusBtn("open-modal");
    await page.press("Enter");
    await waitFor(() => page.eval(`${PG}.querySelector('#g-modal').hasAttribute('open')`));
    await page.eval(`${PG}.querySelector('#g-modal [data-modal-ok]').click()`);
    await waitFor(() => page.eval(`!${PG}.querySelector('#g-modal').hasAttribute('open')`));
    await new Promise((r) => setTimeout(r, 100));
    a = await page.active();
    page.assert(a && a.focusId === "open-modal", "focus returned after confirming");
    page.assert((await page.eval(`${PG}.querySelector('#g-toast').count`)) === 1, "confirm showed a toast");
    await page.eval(`${PG}.querySelector('#g-toast').clear()`);

    const started = await page.eval(`(() => {
      const toast = ${PG}.querySelector('#g-toast');
      const btn = ${PG}.querySelector('[data-action=show-toast]');
      btn.click(); btn.click(); btn.click();
      const stack = toast.shadowRoot.querySelector('[data-stack]');
      const rects = [...stack.querySelectorAll('.toast')].map((n) => n.getBoundingClientRect());
      let overlap = false;
      for (let i = 1; i < rects.length; i += 1) if (rects[i].top < rects[i - 1].bottom - 0.5 && rects[i].bottom > rects[i - 1].top + 0.5) overlap = true;
      window.__toastStart = performance.now();
      return { role: stack.getAttribute('role'), count: toast.count, overlap, text: stack.querySelector('.msg-text').textContent };
    })()`);
    page.assert(started.role === "status" && started.count === 3 && !started.overlap, `toasts stack without overlap in a role=status region (${JSON.stringify(started)})`);
    await waitFor(() => page.eval(`${PG}.querySelector('#g-toast').count === 0`), 8000);
    const elapsed = await page.eval(`Math.round(performance.now() - window.__toastStart)`);
    page.assert(elapsed >= 3500 && elapsed <= 4500, `toast auto-dismissed after about 4s (${elapsed}ms)`);
    await page.assertAccessibleNames();
  },

  async "drawer-open"(page) {
    await page.waitForDeep("cqa-playground >>> #g-overlays [data-action=open-drawer]");
    const PG = "document.querySelector('cqa-playground').shadowRoot";
    await page.eval(`${PG}.querySelector('[data-focus-id=open-drawer]').scrollIntoView({ block: 'center' })`);
    await page.eval(`${PG}.querySelector('[data-focus-id=open-drawer]').click()`);
    await page.eval(`${PG}.querySelector('[data-action=show-toast]').click()`);
    await new Promise((r) => setTimeout(r, 300));
  },

  async "modal-open"(page) {
    await page.waitForDeep("cqa-playground >>> #g-overlays [data-action=open-modal]");
    const PG = "document.querySelector('cqa-playground').shadowRoot";
    await page.eval(`${PG}.querySelector('[data-focus-id=open-modal]').scrollIntoView({ block: 'center' })`);
    await page.eval(`${PG}.querySelector('[data-focus-id=open-modal]').click()`);
    await page.eval(`${PG}.querySelector('[data-action=show-toast]').click()`);
    await new Promise((r) => setTimeout(r, 300));
  },

  async "scale-editor"(page) {
    await page.waitForDeep("cqa-playground >>> #g-scale cqa-scale-step-editor");
    await new Promise((r) => setTimeout(r, 300));
    const ED = "document.querySelector('cqa-playground').shadowRoot.querySelector('cqa-scale-step-editor').shadowRoot";
    const read = () => page.eval(`(() => {
      const r = ${ED};
      return {
        rows: r.querySelectorAll('[data-field=value]').length,
        points: [...r.querySelectorAll('[data-points]')].map((n) => n.textContent.trim()),
        rule: (r.querySelector('[data-rule]') || {}).textContent,
        errors: [...r.querySelectorAll('[data-errors] li')].map((n) => n.textContent.trim()),
        labels: [...r.querySelectorAll('input')].map((i) => i.getAttribute('aria-label'))
      };
    })()`);
    const set = (index, value, field = "value") => page.eval(`(() => { const i = ${ED}.querySelector('[data-field=${field}][data-index="${index}"]'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    let st = await read();
    page.assert(st.rows === 4 && JSON.stringify(st.points) === JSON.stringify(["0,00", "6,00", "10,50", "15,00"]), `points 0/4/7/10 at weight 15 (${JSON.stringify(st.points)})`);
    page.assert(st.rule === "верхний шаг 10 = полный вес 15", `rule chip (${st.rule})`);
    page.assert(st.labels[0] === "Значение шага 1" && st.labels[1] === "Описание шага 1" && st.labels[6] === "Значение шага 4", `input labels (${st.labels})`);
    page.assert(st.errors.length === 0, "no validation messages for a valid scale");
    await page.eval(`${ED}.querySelector('[data-action=add]').click()`);
    st = await read();
    page.assert(st.rows === 5, "add step row");
    const focusedNew = await page.active();
    page.assert(focusedNew && focusedNew.focusId === "value-4", `focus moves to the new row (${JSON.stringify(focusedNew)})`);
    await page.eval(`${ED}.querySelector('[data-action=remove][data-index="4"]').click()`);
    st = await read();
    page.assert(st.rows === 4, "remove step row");
    await set(0, "5");
    st = await read();
    page.assert(st.errors.includes("Нижний шаг должен быть 0"), `lowest step must be 0 (${st.errors})`);
    await set(0, "0");
    await set(2, "4");
    st = await read();
    page.assert(st.errors.includes("Шаги должны возрастать"), `steps must increase (${st.errors})`);
    await set(2, "7");
    await page.eval(`(() => { const r = ${ED}; for (let i = 0; i < 2; i += 1) r.querySelector('[data-action=remove][data-index="0"]').click(); })()`);
    await page.eval(`${ED}.querySelector('[data-action=remove][data-index="0"]').click()`);
    st = await read();
    page.assert(st.errors.includes("Нужно минимум 2 шага"), `at least 2 steps (${st.errors})`);
    await page.eval(`${ED}.querySelector('[data-action=add]').click()`);
    st = await read();
    page.assert(st.rows === 2, `rows after removals and one add (${st.rows})`);
    await page.eval(`${ED}.querySelector('[data-field=description][data-index="0"]').focus()`);
    await page.type("ab");
    await page.type("c");
    const typed = await page.eval(`(() => { const a = ${ED}.activeElement; return { focus: a && a.getAttribute('data-focus-id'), value: a && a.value }; })()`);
    page.assert(typed.focus === "description-0" && typed.value.startsWith("abc"), `typing keeps focus (${JSON.stringify(typed)})`);
    await page.eval(`document.querySelector('cqa-playground').setAttribute('locale', 'en')`);
    await new Promise((r) => setTimeout(r, 200));
    st = await read();
    page.assert(st.labels[0] === "Step 1 value", `English labels (${st.labels[0]})`);
    await page.eval(`document.querySelector('cqa-playground').setAttribute('locale', 'ru')`);
    await page.assertAccessibleNames();
  },

  async keys(page) {
    await page.waitForDeep("cqa-app >>> cqa-header >>> cqa-nav >>> a");
    await page.eval(`cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> a')[0].focus()`);
    await page.press("Tab");
    const tag = (await page.active()).text;
    page.assert(tag === "Диалоги", `Tab moves focus to the second nav link (${tag})`);
  }
};

async function loadExternalScenarios() {
  const dir = new URL("./ui_scenarios/", import.meta.url);
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    const mod = await import(new URL(file, dir).href);
    Object.assign(scenarios, mod.scenarios || {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await loadExternalScenarios();
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
    const urlById = new Map();
    cdp.on("Network.requestWillBeSent", (p) => {
      const url = p.request.url;
      urlById.set(p.requestId, url);
      if (url.startsWith("data:") || url.startsWith("about:")) return;
      requests.push(url);
      if (!url.startsWith(origin) && !url.startsWith("http://localhost")) external.push(url);
    });
    cdp.on("Network.loadingFailed", (p) => failed.push(`${p.errorText} ${urlById.get(p.requestId) || p.requestId}`));
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
        const allowedConsole = [];
        const allowedExternal = [];
        const page = {
          requests,
          allowConsole(pattern) {
            allowedConsole.push(pattern);
          },
          allowExternal(pattern) {
            allowedExternal.push(pattern);
          },
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
          async press(key, modifiers = 0) {
            const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
            const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: codes[key] || key.toUpperCase().charCodeAt(0), modifiers };
            if (key === "Enter") {
              await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...base });
            } else {
              await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
              if (key.length === 1) await cdp.send("Input.dispatchKeyEvent", { type: "char", text: key, ...base });
            }
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
            await new Promise((r) => setTimeout(r, 60));
          },
          async type(text) {
            await cdp.send("Input.insertText", { text });
            await new Promise((r) => setTimeout(r, 40));
          },
          async active() {
            return this.eval(`(() => { const a = cqaActive(); return a ? { tag: a.localName, focusId: a.getAttribute('data-focus-id'), text: (a.textContent || '').trim().slice(0, 40), outline: getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth } : null; })()`);
          },
          async assertAccessibleNames() {
            const missing = await this.eval(`cqaAll().filter((el) => {
              if (!el.matches('button, a[href], input, select, textarea, [role="button"], [role="tab"]')) return false;
              if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return false;
              if (el.textContent.trim()) return false;
              if (el.closest('label')?.textContent.trim()) return false;
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
          const unexpected = consoleErrors.filter((m) => !allowedConsole.some((re) => re.test(m)));
          page.assert(unexpected.length === 0, `console errors: ${unexpected.join(" | ")}`);
          const leaked = external.filter((u) => !allowedExternal.some((re) => re.test(u)));
          page.assert(leaked.length === 0, `requests left the origin: ${leaked.join(", ")}`);
          const broken = failed.filter((u) => !allowedExternal.some((re) => re.test(u)));
          page.assert(broken.length === 0, `failed requests: ${broken.join(", ")}`);
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
