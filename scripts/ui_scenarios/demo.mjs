const j = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FD = "document.getElementById('app').contentDocument";
const CARD = "cqa-app >>> cqa-conversation-card >>> ";
const QUEUE = "cqa-app >>> cqa-appeal-queue >>> ";
const BUILDER = "cqa-app >>> cqa-checklist-builder >>> ";

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

async function openDemo(page, query = "mock=1") {
  await page.eval(`window.__demoStale = true`);
  const q = query.replace(/^real=1&?/, "");
  await page.eval(`(() => { const u = new URL('demo.html?${q}&_=' + Date.now(), location.href); location.href = u.href; })()`);
  await until(page, `window.__demoStale === undefined`, "navigation");
  await until(page, `document.readyState === 'complete' && !!document.getElementById('app')`, "demo document");
  await until(page, `(() => { const d = ${FD}; const a = d && d.querySelector('cqa-app'); return !!(a && a.shadowRoot && a.shadowRoot.querySelector('main')); })()`, "embedded app");
  await sleep(300);
}

const count = (page, selector) => page.eval(`cqaDeep(${j(selector)}, ${FD}).length`);
const text = (page, selector) => page.eval(`(cqaDeep(${j(selector)}, ${FD})[0]?.textContent || '').replace(/\\s+/g, ' ').trim()`);
const norm = (value) => String(value ?? "").replace(/[  ]/g, " ");
const frameHash = (page) => page.eval(`document.getElementById('app').contentWindow.location.hash`);
const top = (page, expression) => page.eval(expression);
const clickTop = (page, id) => page.eval(`document.getElementById(${j(id)}).click()`);
const stepOf = (page) => page.eval(`[...document.querySelectorAll('#steps button')].findIndex((b) => b.getAttribute('aria-current') === 'step')`);

async function waitCard(page, id) {
  await until(page, `document.getElementById('app').contentWindow.location.hash === ${j("#/conversations/" + id)}`, `hash ${id}`);
  await until(page, `cqaDeep(${j(CARD + "[data-total]")}, ${FD}).length > 0`, `card ${id}`);
}

async function type(page, selector, value) {
  await page.eval(`cqaDeep(${j(selector)}, ${FD})[0].focus()`);
  await page.type(value);
  await sleep(80);
}

async function setSelect(page, selector, value) {
  await page.eval(`(() => { const s = cqaDeep(${j(selector)}, ${FD})[0]; s.value = ${j(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
}

async function next(page) {
  const before = await stepOf(page);
  await clickTop(page, "btn-next");
  await until(page, `[...document.querySelectorAll('#steps button')].findIndex((b) => b.getAttribute('aria-current') === 'step') === ${before + 1}`, "step advance");
  await sleep(150);
}

const MOCK = {
  query: "mock=1",
  chat: "p1-ru-001",
  gross: "p3-ru-call-014",
  call: "p3-ru-call-014",
  crit: "04",
  attach: '[data-index="10"] [data-action="attach"]',
  cite: '[data-index="10"] .cite[data-crit="04"]',
  mockMode: true
};

export const REAL = {
  query: "real=1",
  chat: "p1-ru-001",
  gross: "p1-ru-022",
  call: "p4-ru-004",
  crit: "07",
  attach: null,
  cite: ".cite",
  mockMode: false
};

export async function walk(page, cfg) {
  const crit = (suffix) => CARD + `[data-crit-row="${cfg.crit}"]` + suffix;
  await openDemo(page, cfg.query);
  page.assert((await count(page, "cqa-app >>> cqa-conversation-list")) === 1, "step 1: list");
  await until(page, `cqaDeep('cqa-app >>> cqa-conversation-list >>> [role=row]', ${FD}).length > 5`, "list rows");

  await next(page);
  await waitCard(page, cfg.chat);
  page.assert(/N\/A/.test(await text(page, CARD + '[data-crit-row="03"]')), "step 2: criterion 03 shows N/A");
  await page.eval(`cqaDeep(${j(CARD + cfg.cite)}, ${FD})[0].click()`);
  await sleep(300);
  const lit = await page.eval(`cqaDeep(${j(CARD + "[data-bubble].msg-evidence")}, ${FD}).length`);
  page.assert(lit > 0, `step 2: evidence messages highlighted (${lit})`);

  await next(page);
  await waitCard(page, cfg.gross);
  if (cfg.mockMode) page.assert((await count(page, CARD + "[data-call-alert]")) === 1, "step 3: gross banner on the flagged conversation");
  else page.assert(!/не обнаружены/.test(await text(page, CARD + "[data-gross]")), `step 3: gross violation shown (${await text(page, CARD + "[data-gross]")})`);

  await next(page);
  await waitCard(page, cfg.call);
  page.assert((await count(page, CARD + ".call-play")) > 0, "step 4: play-from-here buttons");
  if (cfg.mockMode) {
    await page.eval(`cqaDeep(${j(CARD + ".call-play")}, ${FD})[0].click()`);
    await sleep(200);
  }

  await next(page);
  await waitCard(page, cfg.chat);
  page.assert((await page.eval(`${FD}.querySelector('cqa-app').getAttribute('role')`)) === "operator", "step 5: role switched to operator");
  const badge0 = Number(await page.eval(`(cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> [data-count]', ${FD})[0]?.textContent || '0').trim()`));
  await page.eval(`cqaDeep(${j(CARD + `[data-action="appeal"][data-crit="${cfg.crit}"]`)}, ${FD})[0].click()`);
  const DRAWER = CARD + "cqa-appeal-drawer >>> ";
  await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")}, ${FD})[0]`, "drawer");
  await sleep(200);
  if (cfg.attach) await page.eval(`cqaDeep(${j(CARD + cfg.attach)}, ${FD})[0].click()`);
  await type(page, DRAWER + "[data-field=comment]", "Сроки названы в двух сообщениях подряд.");
  await page.eval(`cqaDeep(${j(DRAWER + "[data-action=submit]")}, ${FD})[0].click()`);
  await until(page, `!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")}, ${FD})[0]`, "drawer closes");
  await until(page, `Number((cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> [data-count]', ${FD})[0]?.textContent || '0').trim()) === ${badge0 + 1}`, "badge grows");
  page.assert(/Апелляция · На рассмотрении/.test(await text(page, crit(""))), "step 5: appeal filed");
  const totalBefore = norm(await text(page, CARD + "[data-total]"));

  await next(page);
  await until(page, `${FD}.defaultView.location.hash === '#/appeals'`, "queue hash");
  page.assert((await page.eval(`${FD}.querySelector('cqa-app').getAttribute('role')`)) === "reviewer", "step 6: role switched to reviewer");
  await until(page, `cqaDeep(${j(QUEUE + "[data-appeal-row]")}, ${FD}).length > 0`, "queue rows");
  const mine = await page.eval(`(() => { const rows = cqaDeep(${j(QUEUE + "[data-appeal-row]")}, ${FD}); const r = rows.find((x) => /Новая/.test(x.textContent) && x.textContent.includes(${j(cfg.chat)})); return r ? r.getAttribute('data-appeal-row') : null; })()`);
  page.assert(mine !== null, "step 6: the new appeal is in the queue");
  await page.eval(`cqaDeep(${j(QUEUE + "[data-appeal-row]")}, ${FD}).find((x) => x.getAttribute('data-appeal-row') === ${j(String(mine))}).click()`);
  await until(page, `cqaDeep(${j(QUEUE + "[data-rv=reason]")}, ${FD}).length > 0`, "decision form");
  await type(page, QUEUE + "[data-rv=reason]", "Сроки названы корректно, оценка изменена.");
  await page.eval(`cqaDeep(${j(QUEUE + '[data-action="review-save"]')}, ${FD})[0].click()`);
  await until(page, `cqaDeep(${j(QUEUE + "[data-closed]")}, ${FD}).length > 0`, "decision saved");

  await next(page);
  await waitCard(page, cfg.chat);
  await until(page, `/было/.test(cqaDeep(${j(CARD + "[data-score]")}, ${FD})[0]?.textContent || '')`, "was-chip");
  const totalAfter = norm(await text(page, CARD + "[data-total]"));
  page.assert(totalAfter !== totalBefore, `step 7: total recomputed (${totalBefore} -> ${totalAfter})`);

  await next(page);
  await until(page, `${FD}.defaultView.location.hash === '#/checklists'`, "builder hash");
  await until(page, `cqaDeep(${j(BUILDER + "[data-row]")}, ${FD}).length > 0`, "builder rows");
  await page.eval(`cqaDeep(${j(BUILDER + "[data-action=pick]")}, ${FD})[0].click()`);
  await sleep(150);
  await page.eval(`(() => { const el = cqaDeep(${j(BUILDER + "[data-field=e-name]")}, ${FD})[0]; el.focus(); el.value = 'Новая формулировка критерия'; el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); })()`);
  await sleep(150);
  await page.eval(`cqaDeep(${j(BUILDER + "[data-action=save]")}, ${FD})[0].click()`);
  await until(page, `cqaDeep(${j(BUILDER + "[data-action=apply]")}, ${FD})[0]?.disabled === false`, "saved, apply enabled");
  if (cfg.mockMode) {
    await page.eval(`cqaDeep(${j(BUILDER + "[data-action=apply]")}, ${FD})[0].click()`);
    await until(page, `cqaDeep('cqa-app >>> cqa-toast >>> .toast', ${FD}).length > 0`, "apply toast");
  }

  await next(page);
  await until(page, `${FD}.defaultView.location.hash === '#/runs'`, "runs hash");
  await until(page, `cqaDeep('cqa-app >>> cqa-eval-runs >>> [role=table]', ${FD}).length > 0 || cqaDeep('cqa-app >>> cqa-eval-runs >>> [data-form]', ${FD}).length > 0 || cqaDeep('cqa-app >>> cqa-eval-runs >>> button', ${FD}).length > 0`, "runs screen");
  page.assert((await page.eval(`document.getElementById('btn-next').disabled`)) === true, "last step: Next disabled");
  await clickTop(page, "btn-prev");
  await until(page, `${FD}.defaultView.location.hash === '#/checklists'`, "back to the builder");
  await page.eval(`(() => { const b = cqaDeep(${j(BUILDER.slice(0, -5))}, ${FD})[0]; if (b) b._dirty = false; return true; })()`);
}

export const scenarios = {
  async "demo-shot"(page) {
    await openDemo(page, "mock=1");
    await until(page, `cqaDeep('cqa-app >>> cqa-conversation-list >>> [role=row]', ${FD}).length > 2`, "list rows");
    await sleep(400);
  },

  async "demo-shot-card"(page) {
    await openDemo(page, "mock=1&step=na");
    await waitCard(page, "p1-ru-001");
    await sleep(500);
  },

  async "demo-shot-call"(page) {
    await openDemo(page, "mock=1&step=call&locale=en");
    await waitCard(page, "p3-ru-call-014");
    await sleep(500);
  },

  async "demo-shot-builder"(page) {
    await openDemo(page, "mock=1&step=builder&locale=kk");
    await until(page, `cqaDeep(${j(BUILDER + "[data-row]")}, ${FD}).length > 0`, "builder");
    await sleep(500);
  },

  async "demo-render"(page) {
    await openDemo(page, "mock=1");
    const info = await page.eval(`(() => ({
      steps: document.querySelectorAll('#steps li').length,
      current: [...document.querySelectorAll('#steps button')].filter((b) => b.getAttribute('aria-current') === 'step').length,
      h1: document.querySelectorAll('h1').length,
      roles: [...document.querySelectorAll('#seg-role button')].map((b) => b.textContent.trim()),
      locales: [...document.querySelectorAll('#seg-locale button')].map((b) => b.textContent.trim()),
      widths: [...document.querySelectorAll('#seg-width button')].map((b) => b.textContent.trim()),
      mode: document.getElementById('demo-mode').getAttribute('data-mode'),
      src: document.getElementById('app').getAttribute('src'),
      title: document.getElementById('app').getAttribute('title'),
      groups: [...document.querySelectorAll('[role=group]')].every((g) => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby'))),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      links: [...document.querySelectorAll('[src],[href]')].map((e) => e.getAttribute('src') || e.getAttribute('href')).filter((v) => /^(https?:)?\\/\\//.test(v) || v.startsWith('/'))
    }))()`);
    page.assert(info.steps === 9 && info.current === 1, `nine steps, one current (${j(info)})`);
    page.assert(info.h1 === 1, "one h1");
    page.assert(j(info.roles) === j(["Руководитель", "QA / Проверяющий", "Оператор"]), `roles (${info.roles})`);
    page.assert(j(info.locales) === j(["RU", "KZ", "EN"]), `locales (${info.locales})`);
    page.assert(j(info.widths) === j(["768", "1024", "1440", "Авто"]), `widths (${info.widths})`);
    page.assert(info.mode === "mock", "mock mode chip");
    page.assert(/^next\.html\?mock=1&locale=ru#\/conversations$/.test(info.src), `relative frame url (${info.src})`);
    page.assert(info.title === "Приложение CQA", "iframe has a title");
    page.assert(info.groups, "segment groups are labelled");
    page.assert(info.overflow <= 0, `no horizontal overflow of the demo page (${info.overflow})`);
    page.assert(info.links.length === 0, `no absolute or external references (${info.links})`);
    page.assert((await frameHash(page)) === "#/conversations", "iframe shows the list");
    page.assert((await count(page, "cqa-app >>> cqa-conversation-list")) === 1, "list screen mounted");
    const names = await page.eval(`[...document.querySelectorAll('button, select, input, a[href]')].filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim())).length`);
    page.assert(names === 0, "all demo controls have names");
    page.assert((await page.eval(`document.getElementById('live').getAttribute('role')`)) === "status", "step announcements use role=status");
    page.assert((await page.eval(`(() => { try { return Object.keys(localStorage).length; } catch (e) { return 0; } })()`)) === 0, "nothing in localStorage");
  },

  async "demo-controls"(page) {
    await openDemo(page, "mock=1");
    await clickTop(page, "btn-next");
    await until(page, `${FD}.defaultView.location.hash === '#/conversations/p1-ru-001'`, "step 2 hash");
    await top(page, `document.querySelector('#seg-role [data-value=operator]').click()`);
    await until(page, `${FD}.querySelector('cqa-app').getAttribute('role') === 'operator'`, "role pushed into the iframe");
    page.assert((await page.eval(`document.querySelector('#seg-role [aria-pressed=true]').getAttribute('data-value')`)) === "operator", "role button pressed");
    await until(page, `!!cqaDeep('cqa-app >>> cqa-header >>> [data-actor]', ${FD})[0]`, "operator chip in the embedded header");
    await top(page, `document.querySelector('#seg-locale [data-value=en]').click()`);
    await until(page, `(cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> a', ${FD})[0]?.textContent || '').trim() === 'Overview'`, "locale pushed into the iframe");
    page.assert((await page.eval(`document.documentElement.lang`)) === "en", "demo page lang follows");
    page.assert((await page.eval(`document.getElementById('btn-next').textContent`)) === "Next", "demo texts translated to English");
    await until(page, `/Appeal/.test(cqaDeep(${j(CARD + "[data-crit-row]")}, ${FD})[0]?.textContent || '')`, "card strings in English");
    await top(page, `document.querySelector('#seg-locale [data-value=kk]').click()`);
    await until(page, `(cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> a', ${FD})[0]?.textContent || '').trim() !== 'Overview'`, "kk applied");
    const role = await page.eval(`(() => { const s = cqaDeep('cqa-app >>> cqa-header >>> select', ${FD})[0]; s.value = 'exec'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await until(page, `document.querySelector('#seg-role [aria-pressed=true]').getAttribute('data-value') === 'exec'`, "header role change reaches the demo bar");
    page.assert(role === true, "role changed inside the iframe");
    await top(page, `document.querySelector('#seg-locale [data-value=ru]').click()`);
    await until(page, `document.documentElement.lang === 'ru'`, "ru back");
  },

  async "demo-width"(page) {
    await openDemo(page, "mock=1");
    const results = [];
    for (const width of ["768", "1024", "1440", "0"]) {
      await top(page, `document.querySelector('#seg-width [data-value="${width}"]').click()`);
      await sleep(400);
      results.push(await page.eval(`(() => {
        const f = document.getElementById('app');
        const d = f.contentDocument.documentElement;
        const v = document.getElementById('viewport').getBoundingClientRect();
        const stage = document.getElementById('stage').getBoundingClientRect();
        return { want: ${width}, frameW: parseFloat(f.style.width), inner: d.clientWidth, scroll: d.scrollWidth, vw: Math.round(v.width), stage: Math.round(stage.width), pressed: document.querySelector('#seg-width [aria-pressed=true]').getAttribute('data-value') };
      })()`));
    }
    for (const r of results) {
      page.assert(r.scroll <= r.inner, `iframe has no horizontal overflow at ${r.want} (${j(r)})`);
      page.assert(r.vw <= r.stage + 1, `viewport fits the stage at ${r.want} (${j(r)})`);
      page.assert(r.pressed === String(r.want), `width button pressed ${r.want}`);
      if (r.want > 0) page.assert(r.frameW === r.want, `iframe CSS width ${r.want} (${r.frameW})`);
    }
  },

  async "demo-walk"(page) {
    await walk(page, MOCK);
  }
};
