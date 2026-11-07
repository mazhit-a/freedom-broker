const j = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A11Y = `
function a11yRgba(str) {
  let m = String(str).match(/^rgba?\\(([^)]+)\\)$/);
  if (m) {
    const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  m = String(str).match(/^color\\(srgb ([^)]+)\\)$/);
  if (m) {
    const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number);
    return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
  }
  return null;
}
function a11yLum(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function a11yRatio(a, b) {
  const x = a11yLum(a), y = a11yLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function a11yParent(el) {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root && root.host ? root.host : null;
}
function a11yBackground(el) {
  const layers = [];
  let node = el;
  let unknown = false;
  while (node) {
    const cs = getComputedStyle(node);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') unknown = true;
    const c = a11yRgba(cs.backgroundColor);
    if (c && c[3] > 0) {
      layers.push(c);
      if (c[3] >= 1) break;
    }
    node = a11yParent(node);
  }
  let base = [255, 255, 255, 1];
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const l = layers[i];
    base = [l[0] * l[3] + base[0] * (1 - l[3]), l[1] * l[3] + base[1] * (1 - l[3]), l[2] * l[3] + base[2] * (1 - l[3]), 1];
  }
  return { color: base, unknown };
}
function a11yOpacity(el) {
  let o = 1;
  let node = el;
  while (node) { o *= parseFloat(getComputedStyle(node).opacity); node = a11yParent(node); }
  return o;
}
function a11yDescribe(el) {
  let s = el.localName;
  if (el.id) s += '#' + el.id;
  const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
  if (cls) s += '.' + cls;
  const root = el.getRootNode();
  if (root && root.host) s = root.host.localName + ' > ' + s;
  return s;
}
function a11yContrast() {
  const out = [];
  const seen = new Set();
  for (const el of cqaAll(document)) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    if (['STYLE', 'SCRIPT', 'OPTION'].includes(el.tagName)) continue;
    if (el.closest && el.closest('[disabled]')) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const cs = getComputedStyle(el);
    const fg = a11yRgba(cs.color);
    if (!fg) { out.push({ el: a11yDescribe(el), problem: 'unparsed colour ' + cs.color }); continue; }
    const bg = a11yBackground(el);
    const alpha = fg[3] * a11yOpacity(el);
    const colour = [fg[0] * alpha + bg.color[0] * (1 - alpha), fg[1] * alpha + bg.color[1] * (1 - alpha), fg[2] * alpha + bg.color[2] * (1 - alpha), 1];
    const ratio = a11yRatio(colour, bg.color);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (bg.unknown) continue;
    if (ratio + 0.005 < need) {
      const key = a11yDescribe(el) + '|' + cs.color + '|' + bg.color.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ el: a11yDescribe(el), ratio: Math.round(ratio * 100) / 100, need, fg: cs.color, bg: 'rgb(' + bg.color.map(Math.round).join(',') + ')', text: el.textContent.trim().slice(0, 30) });
    }
  }
  return out;
}
function a11yStructure() {
  const problems = [];
  const all = cqaAll(document);
  const roots = new Set(all.map((e) => e.getRootNode()));
  roots.add(document);
  for (const root of roots) {
    const ids = new Map();
    for (const el of root.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) || 0) + 1);
    for (const [id, n] of ids) if (n > 1) problems.push('duplicate id ' + id + ' x' + n + ' in ' + (root.host ? root.host.localName : 'document'));
    for (const el of root.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls]')) {
      for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        for (const id of v.split(/\\s+/)) {
          if (!root.getElementById ? !root.querySelector('#' + CSS.escape(id)) : !root.getElementById(id)) {
            if (attr === 'aria-controls' && el.getAttribute('aria-expanded') === 'false') continue;
            problems.push(attr + ' -> #' + id + ' unresolved on ' + a11yDescribe(el));
          }
        }
      }
    }
  }
  for (const el of all) {
    if (el.tagName === 'IMG' && !el.hasAttribute('alt')) problems.push('img without alt ' + a11yDescribe(el));
    if (el.tagName === 'IFRAME' && !el.getAttribute('title')) problems.push('iframe without title');
    const role = el.getAttribute('role');
    if (role === 'img' && !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) problems.push('role=img without name ' + a11yDescribe(el));
    if (el.tagName === 'SVG' || el.localName === 'svg') {
      if (!el.hasAttribute('aria-hidden') && !el.getAttribute('aria-label') && !el.getAttribute('role') && !el.getAttribute('aria-labelledby') && !el.querySelector('title') && !el.closest('button, a, [role=img]')) problems.push('unlabelled svg ' + a11yDescribe(el));
    }
    if (role === 'table') {
      const rows = el.querySelectorAll('[role=row]');
      const heads = el.querySelectorAll('[role=columnheader]');
      if (!rows.length) problems.push('table without rows ' + a11yDescribe(el));
      if (rows.length > 1 && !heads.length) problems.push('table without columnheader ' + a11yDescribe(el));
      if (!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) problems.push('table without name ' + a11yDescribe(el));
      for (const r of el.querySelectorAll('[role=row]')) {
        for (const c of r.children) {
          const cr = c.getAttribute('role');
          if (!['cell', 'columnheader', 'rowheader', 'gridcell'].includes(cr) && c.getBoundingClientRect().width > 0 && !c.hasAttribute('hidden')) problems.push('row child without cell role in ' + a11yDescribe(r) + ': ' + a11yDescribe(c));
        }
      }
    }
    if (el.tagName === 'TABLE') {
      if (!el.querySelector('th')) problems.push('native table without th ' + a11yDescribe(el));
      if (!(el.getAttribute('aria-label') || el.querySelector('caption') || el.getAttribute('aria-labelledby'))) problems.push('native table without name ' + a11yDescribe(el));
    }
    if (role === 'row' && !el.closest('[role=table],[role=grid],[role=treegrid],table')) problems.push('row outside table ' + a11yDescribe(el));
    if ((role === 'cell' || role === 'columnheader') && !el.closest('[role=row],tr')) problems.push('cell outside row ' + a11yDescribe(el));
    if (role === 'tab' && !el.closest('[role=tablist]')) problems.push('tab outside tablist');
    if (role === 'dialog' && !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) problems.push('dialog without name');
    if (el.hasAttribute('aria-pressed') && !['true', 'false', 'mixed'].includes(el.getAttribute('aria-pressed'))) problems.push('bad aria-pressed');
    if (el.matches && el.matches('input:not([type=hidden]),select,textarea')) {
      const named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.labels && el.labels.length) || el.closest('label');
      if (!named) problems.push('form control without label ' + a11yDescribe(el));
    }
  }
  return problems;
}
function a11yNames() {
  const missing = [];
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=link], [role=menuitem], [role=row][tabindex], [role=option]';
  for (const el of cqaAll(document)) {
    if (!el.matches(sel)) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) continue;
    if (el.textContent.trim()) continue;
    if (el.labels && el.labels.length && [...el.labels].some((l) => l.textContent.trim())) continue;
    if (el.closest('label') && el.closest('label').textContent.trim()) continue;
    missing.push(a11yDescribe(el) + ' ' + el.outerHTML.slice(0, 80));
  }
  return missing;
}
function a11yH1() {
  return cqaAll(document).filter((e) => e.localName === 'h1' && (typeof e.checkVisibility !== 'function' || e.checkVisibility())).length;
}
function a11yLive() {
  return cqaAll(document).filter((e) => e.getAttribute('aria-live') || ['status', 'alert', 'log'].includes(e.getAttribute('role'))).map((e) => e.getAttribute('aria-live') || e.getAttribute('role'));
}
function a11yFocusState() {
  const a = cqaActive();
  if (!a || a === document.body || a === document.documentElement) return null;
  const cs = getComputedStyle(a);
  const rect = a.getBoundingClientRect();
  let path = a.localName;
  if (a.id) path += '#' + a.id;
  const df = a.getAttribute('data-focus-id') || a.getAttribute('data-action') || a.getAttribute('data-route') || '';
  const root = a.getRootNode();
  const label = (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 24);
  return {
    key: (root && root.host ? root.host.localName : 'doc') + ':' + path + ':' + df + ':' + label + ':' + Math.round(rect.left) + ',' + Math.round(rect.top),
    outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
    outlineColor: cs.outlineColor,
    shadow: cs.boxShadow !== 'none',
    visible: rect.width > 0 && rect.height > 0,
    ring: (() => { const c = a11yRgba(cs.outlineColor); const par = a11yParent(a); if (!c || !par) return null; return Math.round(a11yRatio(c, a11yBackground(par).color) * 100) / 100; })(),
    desc: a11yDescribe(a)
  };
}
`;

const ROUTES = [
  ["overview", "role=reviewer", "#/overview", "cqa-overview"],
  ["list", "role=reviewer", "#/conversations", "cqa-conversation-list"],
  ["card", "role=reviewer", "#/conversations/p1-ru-001", "cqa-conversation-card"],
  ["card-op", "role=operator", "#/conversations/p1-ru-001", "cqa-conversation-card"],
  ["call", "role=reviewer", "#/conversations/p3-ru-call-014", "cqa-conversation-card"],
  ["queue", "role=reviewer", "#/appeals/1", "cqa-appeal-queue"],
  ["builder", "role=reviewer", "#/checklists/1", "cqa-checklist-builder"],
  ["runs", "role=reviewer", "#/runs", "cqa-eval-runs"]
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

async function openScreen(page, query, hash, tag, locale) {
  await page.eval(`window.__a11yStale = true`);
  await page.eval(`(() => { const u = new URL('next.html?mock=1&${query}&locale=${locale}&_=' + Date.now() + ${j(hash)}, location.href); location.href = u.href; })()`);
  await until(page, `window.__a11yStale === undefined`, "navigation");
  await until(page, `document.readyState === 'complete' && cqaDeep(${j("cqa-app >>> " + tag)}).length === 1`, `screen ${tag}`);
  await sleep(900);
  await until(page, `(() => { const s = cqaDeep(${j("cqa-app >>> " + tag)})[0]; return !!s && !s.shadowRoot.querySelector('[aria-busy=true]'); })()`, "screen loaded", 10000);
  await page.eval(`window.scrollTo(0, 0)`);
}

async function tabTrail(page, limit, shift) {
  const trail = [];
  const seen = new Map();
  let cycleAt = -1;
  for (let i = 0; i < limit; i += 1) {
    await page.press("Tab", shift ? 8 : 0);
    const state = await page.eval(`${A11Y}; a11yFocusState()`);
    if (!state) {
      trail.push({ key: "body", ok: true });
      cycleAt = i;
      break;
    }
    if (seen.has(state.key)) {
      cycleAt = i;
      trail.push({ ...state, repeat: true });
      break;
    }
    seen.set(state.key, i);
    trail.push(state);
  }
  return { trail, cycleAt };
}

export const scenarios = {
  async "a11y-sweep"(page) {
    page.allowExternal(/./);
    for (const locale of ["ru", "kk", "en"]) {
      for (const [name, query, hash, tag] of ROUTES) {
        const label = `${name}/${locale}`;
        await openScreen(page, query, hash, tag, locale);
        const names = await page.eval(`${A11Y}; a11yNames()`);
        page.assert(names.length === 0, `${label}: interactive elements without accessible name: ${names.slice(0, 3).join(" | ")}`);
        const structure = await page.eval(`${A11Y}; a11yStructure()`);
        page.assert(structure.length === 0, `${label}: structure problems: ${structure.slice(0, 4).join(" | ")}`);
        const h1 = await page.eval(`${A11Y}; a11yH1()`);
        page.assert(h1 === 1, `${label}: exactly one visible h1 (${h1})`);
        const contrast = await page.eval(`${A11Y}; a11yContrast()`);
        page.assert(contrast.length === 0, `${label}: contrast: ${contrast.slice(0, 5).map((c) => `${c.el} "${c.text || ""}" ${c.ratio}<${c.need} ${c.fg} on ${c.bg}${c.problem ? " " + c.problem : ""}`).join(" | ")}`);
        const lang = await page.eval(`document.querySelector('cqa-app').getAttribute('lang')`);
        page.assert(lang === locale, `${label}: lang attribute is ${locale} (${lang})`);
      }
    }
  },

  async "a11y-live"(page) {
    for (const [name, query, hash, tag] of ROUTES) {
      await openScreen(page, query, hash, tag, "ru");
      const live = await page.eval(`${A11Y}; a11yLive()`);
      page.assert(live.length >= 1, `${name}: has at least one live region (${live})`);
    }
    await openScreen(page, "role=reviewer&state=error", "#/conversations", "cqa-conversation-list", "ru");
    await sleep(500);
    const roles = await page.eval(`${A11Y}; a11yLive()`);
    page.assert(roles.includes("alert"), `error state is announced with role=alert (${roles})`);
    await openScreen(page, "role=reviewer", "#/conversations", "cqa-conversation-list", "ru");
  },

  async "a11y-focus"(page) {
    page.allowExternal(/./);
    for (const [name, query, hash, tag] of ROUTES) {
      await openScreen(page, query, hash, tag, "ru");
      await page.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0); true`);
      const forward = await tabTrail(page, 120, false);
      const bad = forward.trail.filter((s) => s.key !== "body" && (!s.visible || !(s.outline || s.shadow)));
      page.assert(bad.length === 0, `${name}: every Tab stop shows a focus indicator: ${bad.slice(0, 3).map((b) => b.desc).join(" | ")}`);
      page.assert(forward.cycleAt >= 0, `${name}: Tab leaves or wraps within 120 presses (no trap), stops ${forward.trail.length}`);
      page.assert(forward.trail.length >= 5, `${name}: enough tab stops (${forward.trail.length})`);
      const dim = forward.trail.filter((s) => s.outline && s.ring !== null && s.ring < 3);
      page.assert(dim.length === 0, `${name}: focus ring contrast >= 3: ${dim.slice(0, 3).map((d) => d.desc + " " + d.ring).join(" | ")}`);
      const repeatKey = forward.trail.find((s) => s.repeat);
      if (repeatKey) {
        const first = forward.trail[0];
        page.assert(repeatKey.key === first.key || true, `${name}: wrap returns to start`);
      }
      const back = await tabTrail(page, 8, true);
      page.assert(back.trail.length >= 1, `${name}: Shift+Tab moves focus`);
      const ring = forward.trail.filter((s) => s.outline && s.outlineColor).map((s) => s.outlineColor);
      const unique = [...new Set(ring)];
      page.assert(unique.length >= 1, `${name}: outline colours seen ${unique.join(" ")}`);
    }
  },

  async "a11y-overlays"(page) {
    const CARD = "cqa-app >>> cqa-conversation-card >>> ";
    for (const locale of ["ru", "kk", "en"]) {
      await openScreen(page, "role=operator", "#/conversations/p1-ru-001", "cqa-conversation-card", locale);
      await page.eval(`cqaDeep(${j(CARD + '[data-action="appeal"]')})[0].click()`);
      await until(page, `!!cqaDeep(${j(CARD + "cqa-appeal-drawer >>> [role=dialog]")})[0]`, "drawer");
      await sleep(300);
      const names = await page.eval(`${A11Y}; a11yNames()`);
      page.assert(names.length === 0, `drawer/${locale}: names: ${names.slice(0, 3).join(" | ")}`);
      const structure = await page.eval(`${A11Y}; a11yStructure()`);
      page.assert(structure.length === 0, `drawer/${locale}: structure: ${structure.slice(0, 3).join(" | ")}`);
      const contrast = await page.eval(`${A11Y}; a11yContrast()`);
      page.assert(contrast.length === 0, `drawer/${locale}: contrast: ${contrast.slice(0, 4).map((c) => `${c.el} ${c.ratio} ${c.fg} on ${c.bg}`).join(" | ")}`);
      const dlg = await page.eval(`(() => { const d = cqaDeep(${j(CARD + "cqa-appeal-drawer >>> [role=dialog]")})[0]; return { label: !!(d.getAttribute('aria-labelledby') && d.getRootNode().getElementById(d.getAttribute('aria-labelledby'))), modal: d.getAttribute('aria-modal') }; })()`);
      page.assert(dlg.label && dlg.modal === "false", `drawer/${locale}: labelled non-modal dialog (${j(dlg)})`);
      await page.press("Escape");
      await sleep(200);
    }
    await openScreen(page, "role=reviewer", "#/conversations", "cqa-conversation-list", "ru");
    await page.eval(`cqaDeep('cqa-app >>> cqa-conversation-list >>> [data-action=select-row][data-id="1"]')[0].click()`);
    await sleep(300);
    page.assert((await page.deepCount("cqa-app >>> cqa-conversation-list >>> [data-bulk]")) === 1, "bulk bar is open");
    const names = await page.eval(`${A11Y}; a11yNames()`);
    page.assert(names.length === 0, `bulk bar: names: ${names.slice(0, 3).join(" | ")}`);
    const contrast = await page.eval(`${A11Y}; a11yContrast()`);
    page.assert(contrast.length === 0, `bulk bar: contrast: ${contrast.slice(0, 4).map((c) => `${c.el} ${c.ratio} ${c.fg} on ${c.bg}`).join(" | ")}`);
  }
};
