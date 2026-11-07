const j = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMPONENTS = [
  ["overview", "cqa-overview", ""],
  ["list", "cqa-conversation-list", "&selectable=1"],
  ["card", "cqa-conversation-card", "&conversation-id=p1-ru-001"],
  ["call", "cqa-conversation-card", "&conversation-id=p3-ru-call-014"],
  ["queue", "cqa-appeal-queue", "&appeal-id=1"],
  ["builder", "cqa-checklist-builder", "&checklist-id=1"],
  ["runs", "cqa-eval-runs", ""]
];

async function until(page, expression, label, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await page.eval(expression);
    } catch (error) {
      value = false;
    }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

async function host(page, src, width, height = 900) {
  await page.eval(`(() => {
    document.body.replaceChildren();
    document.body.style.cssText = 'margin:0;background:#fff';
    const wrap = document.createElement('div');
    wrap.id = 'wrap';
    wrap.style.cssText = 'overflow:hidden;width:100%';
    const f = document.createElement('iframe');
    f.id = 'host';
    f.setAttribute('title', 'embedded');
    f.style.cssText = 'border:0;display:block;width:${width}px;height:${height}px';
    window.__msgs = [];
    window.onmessage = (e) => window.__msgs.push({ type: e.data.type, to: e.data.detail && e.data.detail.to, id: e.data.detail && e.data.detail.id, origin: e.origin });
    f.src = ${j(src)};
    wrap.append(f);
    document.body.append(wrap);
  })()`);
}

const FD = "document.getElementById('host').contentDocument";
const FW = "document.getElementById('host').contentWindow";

async function waitComponent(page, tag) {
  await until(page, `(() => { const e = ${FD} && ${FD}.querySelector(${j(tag)}); return !!(e && e.shadowRoot && e.shadowRoot.querySelector('[data-root]') && !e.shadowRoot.querySelector('[aria-busy=true]') && e.shadowRoot.querySelector('[data-root]').children.length > 0); })()`, `${tag} rendered`);
  await sleep(500);
}

function embedUrl(tag, extra, query) {
  return `embed-test.html?c=${tag}&mock=1&role=reviewer&locale=ru${extra}${query || ""}`;
}

const MEASURE = `
(() => {
  const d = ${FD};
  const w = ${FW};
  const root = d.documentElement;
  const all = [];
  const walk = (node) => { for (const el of node.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(d);
  const scrollable = (el) => {
    let n = el;
    while (n) {
      const p = n.parentElement || (n.getRootNode() && n.getRootNode().host) || null;
      if (!p || p === d.documentElement) return false;
      const cs = w.getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
      if (/(auto|scroll)/.test(cs.overflowX)) return true;
      n = p;
    }
    return false;
  };
  const clipped = all.filter((el) => el.matches('button, a[href], input, select, textarea') && el.checkVisibility()).filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return false;
    return (r.right > root.clientWidth + 1 || r.left < -1) && !scrollable(el);
  }).map((el) => el.localName + ' ' + (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20)));
  const entries = w.performance.getEntriesByType('resource').map((e) => e.name);
  return {
    sw: root.scrollWidth, cw: root.clientWidth, clipped,
    external: entries.filter((n) => !n.startsWith(w.location.origin) && !n.startsWith('data:')),
    fonts: entries.filter((n) => n.endsWith('.woff2')).length,
    fontCheck: d.fonts.check('16px Inter', 'Проверка әғқңөұүһі'),
    fontsLoaded: [...d.fonts].filter((f) => f.status === 'loaded').length
  };
})()
`;

const NAV = {
  overview: `${FD}.querySelector('cqa-overview').shadowRoot.querySelector('[data-action=all], [data-action=open]')`,
  list: `${FD}.querySelector('cqa-conversation-list').shadowRoot.querySelector('[data-action=open]')`,
  card: `${FD}.querySelector('cqa-conversation-card').shadowRoot.querySelector('[data-action=crumb]')`,
  call: `${FD}.querySelector('cqa-conversation-card').shadowRoot.querySelector('[data-action=crumb]')`,
  queue: `${FD}.querySelector('cqa-appeal-queue').shadowRoot.querySelector('[data-open-card]')`,
  builder: null,
  runs: `${FD}.querySelector('cqa-eval-runs').shadowRoot.querySelector('a[data-conversation]')`
};

export const scenarios = {
  async "embed-components"(page) {
    page.allowExternal(/dynamics\.com/);
    const outer = await page.eval("innerWidth");
    for (const width of [768, 1440]) {
      for (const [name, tag, extra] of COMPONENTS) {
        const label = `${name}@iframe${width}`;
        await host(page, embedUrl(tag, extra), width);
        await waitComponent(page, tag);
        const m = await page.eval(MEASURE);
        page.assert(m.sw <= m.cw, `${label}: no horizontal overflow (${m.sw} > ${m.cw})`);
        page.assert(m.clipped.length === 0, `${label}: no clipped controls (${m.clipped.slice(0, 3)})`);
        page.assert(m.external.length === 0, `${label}: no external requests (${m.external.slice(0, 2)})`);
        page.assert(m.fonts >= 2 && m.fontCheck && m.fontsLoaded >= 2, `${label}: Inter loaded from the bundled files (${m.fonts} woff2, check ${m.fontCheck}, loaded ${m.fontsLoaded})`);
        const selector = NAV[name];
        if (selector) {
          await page.eval(`window.__msgs.length = 0; (() => { const target = ${selector}; if (!target) throw new Error('no nav target'); target.click(); })(); true`);
          await until(page, `window.__msgs.some((m) => m.type === 'cqa:navigate')`, `${label}: cqa:navigate relayed`, 3000).catch(() => null);
          const msgs = await page.eval("window.__msgs");
          const nav = msgs.find((m) => m.type === "cqa:navigate");
          page.assert(!!nav && nav.origin === (await page.eval("location.origin")), `${label}: cqa:navigate reached the parent by postMessage (${j(msgs)})`);
        }
        const names = await page.eval(`(() => { const d = ${FD}; const out = []; const walk = (n) => { for (const el of n.querySelectorAll('*')) { if (el.matches('button, a[href], input:not([type=hidden]), select, textarea') && el.checkVisibility() && !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent.trim() || el.title || (el.labels && el.labels.length))) out.push(el.outerHTML.slice(0, 60)); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(d); return out; })()`);
        page.assert(names.length === 0, `${label}: names (${names.slice(0, 2)})`);
      }
    }
    page.assert(outer > 0, "harness ok");
  },

  async "embed-container"(page) {
    const stacks = async (tag, extra, probe) => {
      const r = [];
      for (const w of [700, 1300]) {
        await host(page, embedUrl(tag, extra, `&w=${w}`), 1440);
        await waitComponent(page, tag);
        r.push(await page.eval(`(() => { const el = ${FD}.querySelector(${j(tag)}).shadowRoot.querySelector(${j(probe)}); return el ? ${FW}.getComputedStyle(el).gridTemplateColumns.split(' ').length : -1; })()`));
      }
      return r;
    };
    const card = await stacks("cqa-conversation-card", "&conversation-id=p1-ru-001", ".cols");
    page.assert(card[0] === 1 && card[1] === 2, `card columns follow the container width, not the window: 700px -> ${card[0]}, 1300px -> ${card[1]}`);
    for (const w of [700, 1300]) {
      await host(page, embedUrl("cqa-conversation-list", "", `&w=${w}`), 1440);
      await waitComponent(page, "cqa-conversation-list");
      await sleep(400);
      const m = await page.eval(MEASURE);
      const wrap = await page.eval(`(() => { const el = ${FD}.querySelector('cqa-conversation-list').shadowRoot.querySelector('.lt-wrap'); return el ? { sw: el.scrollWidth, cw: el.clientWidth, ov: ${FW}.getComputedStyle(el).overflowX } : null; })()`);
      page.assert(m.sw <= m.cw && m.clipped.length === 0, `list in a ${w}px panel does not overflow the frame (${m.sw}/${m.cw})`);
      page.assert(!!wrap && /(auto|scroll)/.test(wrap.ov), `list table scrolls inside its own wrapper (${j(wrap)})`);
      if (w === 700) page.assert(wrap.sw > wrap.cw, `13-column table scrolls horizontally inside a 700px panel (${j(wrap)})`);
    }
    await host(page, embedUrl("cqa-overview", "", "&w=700"), 1440);
    await waitComponent(page, "cqa-overview");
    const m = await page.eval(MEASURE);
    page.assert(m.sw <= m.cw && m.clipped.length === 0, `overview in a 700px panel has no overflow (${m.sw}/${m.cw}, ${m.clipped})`);
  },

  async "embed-overlays"(page) {
    page.allowExternal(/dynamics\.com/);
    for (const width of [768, 1440]) {
      const height = 700;
      await host(page, `index.html?mock=1&role=operator&locale=ru#/conversations/p1-ru-001`, width, height);
      await until(page, `!!${FD}.querySelector('cqa-app') && !!${FD}.querySelector('cqa-app').shadowRoot.querySelector('cqa-conversation-card')`, "app in iframe");
      const CARD = "cqa-app >>> cqa-conversation-card >>> ";
      const inner = (sel) => `cqaDeep(${j(sel)}, ${FD})`;
      await until(page, `${inner(CARD + "[data-total]")}.length > 0`, "card total");
      await sleep(400);
      await page.eval(`${FD}.defaultView.scrollTo(0, 400)`);
      await page.eval(`${inner(CARD + '[data-focus-id="appeal-04"]')}[0].focus()`);
      await page.eval(`${inner(CARD + '[data-focus-id="appeal-04"]')}[0].click()`);
      await until(page, `${inner(CARD + "cqa-appeal-drawer >>> [role=dialog]")}.length > 0`, "drawer");
      await sleep(300);
      const box = await page.eval(`(() => { const d = ${inner(CARD + "cqa-appeal-drawer >>> [role=dialog]")}[0]; const r = d.getBoundingClientRect(); const w = ${FW}; return { right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), vw: w.innerWidth, vh: w.innerHeight }; })()`);
      page.assert(box.right === box.vw && box.top === 0 && box.bottom === box.vh, `drawer pinned to the iframe viewport at ${width} (${j(box)})`);
      page.assert(box.width <= box.vw, `drawer fits the iframe at ${width} (${box.width} <= ${box.vw})`);
      const outerScroll = await page.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      page.assert(outerScroll <= 0 || width > (await page.eval("innerWidth")), `drawer does not widen the outer page (${outerScroll})`);
      await page.eval(`${inner(CARD + "cqa-appeal-drawer >>> [data-field=comment]")}[0].focus()`);
      await page.type("Проверка во фрейме.");
      await page.eval(`${inner(CARD + "cqa-appeal-drawer >>> [data-action=submit]")}[0].click()`);
      await until(page, `${inner("cqa-app >>> cqa-toast >>> .toast")}.length > 0`, "toast");
      await sleep(300);
      const toast = await page.eval(`(() => { const t = ${inner("cqa-app >>> cqa-toast >>> .toast")}[0].getBoundingClientRect(); const w = ${FW}; return { right: Math.round(t.right), bottom: Math.round(t.bottom), left: Math.round(t.left), vw: w.innerWidth, vh: w.innerHeight }; })()`);
      page.assert(toast.right <= toast.vw && toast.left >= 0 && toast.bottom <= toast.vh && toast.bottom > toast.vh / 2, `toast sits inside the iframe viewport at ${width} (${j(toast)})`);
      const returned = await page.eval(`(() => { const a = ${FD}.querySelector('cqa-app'); let el = ${FD}.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el ? (el.getAttribute('data-focus-id') || el.localName) : null; })()`);
      page.assert(!!returned && returned !== "body", `focus stays on a real control after submit in the iframe (${returned})`);
      await page.eval(`${inner(CARD + '[data-focus-id="appeal-05"]')}[0].focus()`);
      await page.eval(`${inner(CARD + '[data-focus-id="appeal-05"]')}[0].click()`);
      await until(page, `${inner(CARD + "cqa-appeal-drawer >>> [role=dialog]")}.length > 0`, "second drawer");
      await sleep(250);
      await page.press("Escape");
      await until(page, `${inner(CARD + "cqa-appeal-drawer >>> [role=dialog]")}.length === 0`, "drawer closes on Escape");
      await sleep(250);
      const back = await page.eval(`(() => { let el = ${FD}.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el ? el.getAttribute('data-focus-id') : null; })()`);
      page.assert(back === "appeal-05", `Escape returns focus to the opener inside the iframe at ${width} (${back})`);
    }
    for (const width of [768, 1440]) {
      await host(page, `index.html?mock=1&role=reviewer&locale=ru#/conversations`, width, 700);
      const LIST = "cqa-app >>> cqa-conversation-list >>> ";
      const inner = (sel) => `cqaDeep(${j(sel)}, ${FD})`;
      await until(page, `${inner(LIST + "[data-action=select-row]")}.length > 0`, "list rows");
      await sleep(300);
      await page.eval(`${inner(LIST + '[data-action=select-row][data-id="1"]')}[0].click()`);
      await until(page, `${inner(LIST + "[data-bulk]")}.length > 0`, "bulk bar");
      const runButton = LIST + "[data-bulk] [data-action=run]";
      await until(page, `${inner(runButton)}[0] && !${inner(runButton)}[0].disabled`, "run enabled");
      await page.eval(`${inner(runButton)}[0].focus()`);
      await page.eval(`${inner(runButton)}[0].click()`);
      await until(page, `${FD}.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]').hasAttribute('open')`, "confirm modal");
      await sleep(300);
      const modal = await page.eval(`(() => { const m = ${FD}.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]'); const d = m.shadowRoot.querySelector('[role=dialog]'); const r = d.getBoundingClientRect(); const w = ${FW}; const cx = (r.left + r.right) / 2; return { cx: Math.round(cx), vw: w.innerWidth, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: w.innerHeight, inert: ${FD}.querySelector('cqa-app').shadowRoot.querySelector('[data-root]') ? true : false }; })()`);
      page.assert(Math.abs(modal.cx - modal.vw / 2) <= 2 && modal.top >= 0 && modal.bottom <= modal.vh, `modal centred in the iframe viewport at ${width} (${j(modal)})`);
      const trail = [];
      for (let i = 0; i < 5; i += 1) {
        await page.press("Tab");
        trail.push(await page.eval(`(() => { const m = ${FD}.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]'); let el = ${FD}.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; let n = el; while (n) { if (n === m) return true; const root = n.getRootNode(); n = n.parentElement || (root && root.host) || null; } return false; })()`));
      }
      page.assert(trail.every(Boolean), `Tab stays inside the modal in the iframe at ${width} (${trail})`);
      await page.press("Escape");
      await until(page, `!${FD}.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]').hasAttribute('open')`, "modal closes");
      await sleep(250);
      const focus = await page.eval(`(() => { let el = ${FD}.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el ? (el.getAttribute('data-action') || el.localName) : null; })()`);
      page.assert(focus === "run", `focus returns to the bulk Run button after the modal closes at ${width} (${focus})`);
    }
  },

  async "embed-navigate"(page) {
    await host(page, `index.html?mock=1&role=reviewer&locale=ru#/overview`, 1440, 700);
    await until(page, `!!cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> a', ${FD})[0]`, "nav");
    await page.eval(`window.__outer = []; ${FD}.addEventListener('cqa:navigate', (e) => window.__outer.push(e.detail.to)); true`);
    await page.eval(`cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> a[data-route=appeals]', ${FD})[0].click()`);
    await until(page, `window.__outer.includes('appeals')`, "navigate crosses shadow roots to the iframe document");
    page.assert((await page.eval(`${FW}.location.hash`)) === "#/appeals", "iframe hash routed");
    await until(page, `cqaDeep('cqa-app >>> cqa-appeal-queue', ${FD}).length === 1`, "queue screen");
    await page.eval(`cqaDeep('cqa-app >>> cqa-appeal-queue >>> [data-open-card]', ${FD})[0].click()`);
    await until(page, `${FW}.location.hash.startsWith('#/conversations/')`, "queue link navigates in the app");
    page.assert((await page.eval(`window.__outer.filter((t) => t === 'conversations').length`)) >= 1, "queue link emitted cqa:navigate");
    const outerHash = await page.eval(`location.hash`);
    page.assert(outerHash === "" || outerHash === "#", `outer page hash untouched (${outerHash})`);
  }
};

for (const [name, tag, extra] of COMPONENTS) {
  scenarios[`embed-shot-${name}`] = async (page) => {
    page.allowExternal(/dynamics\.com/);
    const width = await page.eval("innerWidth");
    await host(page, embedUrl(tag, extra), width, 880);
    await waitComponent(page, tag);
    await sleep(600);
  };
}
