const HOST = "document.querySelector('cqa-app').shadowRoot.querySelector('cqa-conversation-list')";
const ROOT = `${HOST}.shadowRoot`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeout = 6000, step = 60) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
    }
    if (Date.now() - start > timeout) throw new Error("timeout waiting for " + fn.toString().slice(0, 140));
    await sleep(step);
  }
}

async function open(page, query = "mock=1", hash = "#/conversations") {
  await page.eval(`window.__gone = true; location.href = location.origin + location.pathname + '?${query}&_=' + Date.now() + ${JSON.stringify(hash)}`).catch(() => {});
  await until(() => page.eval(`!window.__gone && document.readyState === 'complete' && !!${HOST}`));
}

async function ready(page) {
  await until(() => page.eval(`!!${ROOT}.querySelector('[data-table], [data-skeleton], [role=alert], .panel')`));
}

async function rows(page) {
  await until(() => page.eval(`${ROOT}.querySelectorAll('[data-row]').length > 0`));
}

const ids = (page) => page.eval(`[...${ROOT}.querySelectorAll('[data-row] .lt-id')].map((a) => a.textContent.trim())`);
const counts = (page) => page.eval(`${ROOT}.querySelector('[data-counts]').textContent.trim()`);
const set = (page, name, value) =>
  page.eval(`(() => { const s = ${ROOT}.querySelector('[data-filter=${name}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

async function settle(page, expectedFirst) {
  await sleep(120);
  await until(() => page.eval(`${ROOT}.querySelector('[data-table]') ? ${ROOT}.querySelector('[data-table]').getAttribute('aria-busy') !== 'true' : true`));
  if (expectedFirst !== undefined) await until(async () => (await ids(page))[0] === expectedFirst);
}

export const scenarios = {
  async "list-render"(page) {
    await open(page);
    await rows(page);
    const info = await page.eval(`(() => {
      const r = ${ROOT};
      const table = r.querySelector('[role=table]');
      const row = (id) => [...r.querySelectorAll('[data-row]')].find((x) => x.querySelector('.lt-id').textContent.trim() === id);
      const cells = (id) => [...row(id).querySelectorAll('[role=cell]')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim());
      const wrap = r.querySelector('.lt-wrap');
      return {
        role: table.getAttribute('role'),
        name: table.getAttribute('aria-label'),
        heads: [...table.querySelectorAll('[role=columnheader]')].map((h) => h.textContent.trim()),
        rows: r.querySelectorAll('[data-row]').length,
        counts: r.querySelector('[data-counts]').textContent.trim(),
        h2: r.querySelector('h2').textContent.trim(),
        a: cells('p1-ru-001'), b: cells('p2-en-003'), c: cells('p3-ru-call-014'), f: cells('p1-ru-019'), d: cells('p1-ru-002'), u: cells('p1-ru-015'),
        labels: [...r.querySelectorAll('[data-action=select-row]')].map((c) => c.getAttribute('aria-label')),
        selectAll: r.querySelector('[data-action=select-all]').getAttribute('aria-label'),
        grossChips: r.querySelectorAll('.c-crit').length,
        failedHref: row('p1-ru-019').querySelector('a.c-bad').getAttribute('href'),
        lowChips: [...r.querySelectorAll('[data-row]')].filter((x) => x.querySelectorAll('[role=cell]')[5].querySelector('.c-na')).map((x) => x.querySelector('.lt-id').textContent.trim()),
        phone: row('p3-ru-call-014').querySelector('svg path').getAttribute('d').startsWith('M22 16.92'),
        chat: row('p1-ru-001').querySelector('svg path').getAttribute('d').startsWith('M21 15'),
        bar: row('p1-ru-001').querySelector('.score-fill').className,
        bar2: row('p3-ru-call-014').querySelector('.score-fill').className,
        bar3: row('p1-ru-015').querySelector('.score-fill').className,
        scrolls: wrap.scrollWidth > wrap.clientWidth + 1,
        sectionTitle: table.querySelectorAll('[role=columnheader]')[6].getAttribute('title'),
        sort: table.querySelector('[aria-sort]').getAttribute('aria-sort'),
        noteLen: r.querySelectorAll('.note').length
      };
    })()`);
    page.assert(info.role === "table" && info.name === "Оценённые диалоги", `table role and name (${info.role}, ${info.name})`);
    page.assert(info.heads.length === 13, `13 columns (${info.heads.length})`);
    page.assert(JSON.stringify(info.heads.slice(1)) === JSON.stringify(["ID", "Канал", "Язык", "Оператор", "Итог ↕", "Разд. 1", "Разд. 2", "Разд. 3", "Грубые", "Апелляция", "Версия", "Оценено"]), `headers (${info.heads})`);
    page.assert(info.rows === 11, `11 rows (${info.rows})`);
    page.assert(info.h2 === "Диалоги", "title");
    page.assert(/^10 оценено · 11 показано$/.test(info.counts.replace(/\s/g, " ")), `counts (${info.counts})`);
    page.assert(info.a.includes("81,88") || info.a.some((x) => x.startsWith("81,88")), `p1-ru-001 total (${info.a})`);
    page.assert(info.a[6] === "31,25" && info.a[7] === "18,75" && info.a[8] === "31,88", `p1-ru-001 sections (${info.a.slice(6, 9)})`);
    page.assert(info.a[3] === "RU" && info.a[4] === "Оператор A" && info.a[2] === "Чат", `lang, operator, channel (${info.a})`);
    page.assert(info.a[9] === "Нет" && info.c[9].endsWith("Да"), `gross cells (${info.a[9]}, ${info.c[9]})`);
    page.assert(info.a[10] === "На рассмотрении" && info.c[10] === "Новая" && info.d[10] === "Изменено" && info.u[10] === "—", `appeal cells (${info.a[10]}, ${info.c[10]}, ${info.d[10]}, ${info.u[10]})`);
    page.assert(info.a[11] === "v2" && info.a[12] === "07.11.2026 09:42", `version and date (${info.a[11]}, ${info.a[12]})`);
    page.assert(info.c[2] === "Звонок" && info.phone && info.chat, "channel icons and labels");
    page.assert(info.f[5].includes("Ошибка оценки · повторить") && info.f[5].startsWith("—") && info.f[6] === "—", `failed row (${info.f[5]})`);
    page.assert(info.failedHref === "#/runs", "failed chip links to Runs");
    page.assert(JSON.stringify(info.lowChips) === JSON.stringify(["p2-en-003"]), `low-confidence chip only on p2-en-003 (${info.lowChips})`);
    page.assert(info.b[5].includes("92,50") && info.b[5].includes("Низкая уверенность"), `provisional score plus chip (${info.b[5]})`);
    page.assert(info.bar.includes("band-ok") && info.bar2.includes("band-bad") && info.bar3.includes("band-warn"), `bands (${info.bar}, ${info.bar2}, ${info.bar3})`);
    page.assert(info.labels.includes("Выбрать p1-ru-001") && info.selectAll === "Выбрать все", `checkbox labels (${info.labels[0]})`);
    page.assert(info.sectionTitle === "Начало и понимание запроса", `section tooltip from the checklist (${info.sectionTitle})`);
    page.assert(info.sort === "none", "aria-sort none initially");
    page.assert(info.noteLen === 2, "footnote and key hint");
    const width = await page.eval("window.innerWidth");
    if (width < 1100) page.assert(info.scrolls, "table scrolls inside its card at narrow width");
    page.assert(await page.eval(`document.documentElement.scrollWidth <= window.innerWidth`), "page itself does not scroll horizontally");
    page.assert(
      !(await page.eval(`${ROOT}.querySelector('[data-bulk]') !== null`)),
      "no bulk bar without selection"
    );
    await page.assertAccessibleNames();
  },

  async "list-filters"(page) {
    await open(page);
    await rows(page);
    await page.eval(`(() => { const i = ${ROOT}.querySelector('[data-search]'); i.focus(); })()`);
    await page.type("call");
    await settle(page);
    await until(async () => (await ids(page)).length === 3);
    page.assert(JSON.stringify(await ids(page)) === JSON.stringify(["p3-ru-call-014", "p2-ru-call-021", "p2-kz-call-004"]), `search narrows by id (${await ids(page)})`);
    page.assert(/3 показано/.test(await counts(page)), `counts follow filter (${await counts(page)})`);
    const keep = await page.eval(`(() => { const a = ${ROOT}.activeElement; return a && a.getAttribute('data-focus-id'); })()`);
    page.assert(keep === "search", `search keeps focus while results update (${keep})`);
    await set(page, "language", "KZ");
    await until(async () => (await ids(page)).join() === "p2-kz-call-004");
    await set(page, "language", "");
    await set(page, "channel", "chat");
    await until(async () => (await ids(page)).length === 0);
    page.assert(await page.eval(`!!${ROOT}.querySelector('.panel .panel-title')`), "empty state when filters exclude everything");
    page.assert((await page.eval(`${ROOT}.querySelector('.panel-title').textContent.trim()`)) === "Диалогов по фильтру нет", "empty title");
    await page.eval(`${ROOT}.querySelector('[data-action=reset]').click()`);
    await until(async () => (await ids(page)).length === 11);
    page.assert((await page.eval(`${ROOT}.querySelector('[data-search]').value`)) === "", "reset clears search");
    await set(page, "versionId", "11");
    await until(async () => (await ids(page)).length < 11);
    const v1 = await ids(page);
    page.assert(v1.every((id) => ["p2-ru-call-021", "p2-kz-call-004"].includes(id)) && v1.length === 2, `version filter (${v1})`);
    await set(page, "versionId", "");
    await set(page, "appealStatus", "new");
    await until(async () => (await ids(page)).length === 2);
    page.assert((await ids(page)).join() === "p1-kz-007,p3-ru-call-014", `appeal filter (${await ids(page)})`);
    await set(page, "appealStatus", "");
    await settle(page);
    const pressed = () => page.eval(`[...${ROOT}.querySelectorAll('[data-action=view]')].map((b) => b.getAttribute('aria-pressed')).join()`);
    page.assert((await pressed()) === "true,false,false", `views start on Все (${await pressed()})`);
    const names = await page.eval(`[...${ROOT}.querySelectorAll('[data-action=view]')].map((b) => b.textContent.trim()).join('|')`);
    page.assert(names === "Все|Грубые нарушения|С апелляциями", `no "Мои проверки" view (${names})`);
    await page.eval(`${ROOT}.querySelector('[data-view=gross]').click()`);
    await until(async () => (await ids(page)).join() === "p3-ru-call-014");
    page.assert((await pressed()) === "false,true,false", "gross view pressed");
    await page.eval(`${ROOT}.querySelector('[data-view=appeals]').click()`);
    await until(async () => (await ids(page)).length === 5);
    page.assert((await ids(page)).join() === "p1-ru-001,p1-kz-007,p3-ru-call-014,p1-ru-002,p2-ru-call-021", `appeals view (${await ids(page)})`);
    page.assert((await pressed()) === "false,false,true", "appeals view pressed");
    await page.eval(`${ROOT}.querySelector('[data-view=all]').click()`);
    await until(async () => (await ids(page)).length === 11);

    const sortState = () => page.eval(`${ROOT}.querySelector('[aria-sort]').getAttribute('aria-sort')`);
    await page.eval(`${ROOT}.querySelector('[data-action=sort]').click()`);
    await until(async () => (await sortState()) === "ascending");
    await settle(page, "p3-ru-call-014");
    let order = await ids(page);
    page.assert(order[0] === "p3-ru-call-014" && order[order.length - 1] === "p1-ru-019", `ascending, failed row last (${order})`);
    await page.eval(`${ROOT}.querySelector('[data-action=sort]').click()`);
    await until(async () => (await sortState()) === "descending");
    await settle(page, "p1-ru-002");
    order = await ids(page);
    page.assert(order[0] === "p1-ru-002" && order[order.length - 1] === "p1-ru-019", `descending, nulls still last (${order})`);
    await page.eval(`${ROOT}.querySelector('[data-action=sort]').click()`);
    await until(async () => (await sortState()) === "none");
    await settle(page, "p1-ru-001");
    page.assert((await page.eval(`${ROOT}.querySelector('[data-action=sort]').textContent.trim()`)) === "Итог ↕", "sort glyph resets");

    await page.eval(`${HOST}.setAttribute('page-size', '5')`);
    await until(async () => (await ids(page)).length === 5);
    page.assert(/^1–5 из 11$/.test(await page.eval(`${ROOT}.querySelector('[data-range]').textContent.trim()`)), "pager range");
    page.assert(await page.eval(`${ROOT}.querySelector('[data-action=prev]').disabled`), "prev disabled on first page");
    await page.eval(`${ROOT}.querySelector('[data-action=next]').click()`);
    await settle(page, "p1-kz-011");
    page.assert((await page.eval(`${ROOT}.querySelector('[data-range]').textContent.trim()`)) === "6–10 из 11", "second page range");
    await page.eval(`${ROOT}.querySelector('[data-action=next]').click()`);
    await until(async () => (await ids(page)).length === 1);
    page.assert(await page.eval(`${ROOT}.querySelector('[data-action=next]').disabled`), "next disabled on last page");
    page.assert(/1 показано/.test(await counts(page)), `counts show the page size (${await counts(page)})`);
    await page.assertAccessibleNames();
  },

  async "list-bulk"(page) {
    await open(page, "mock=1&role=reviewer");
    await rows(page);
    await until(() => page.eval(`${ROOT}.querySelectorAll('[data-action=select-row]').length > 0`));
    const click = (selector) => page.eval(`${ROOT}.querySelector(${JSON.stringify(selector)}).click()`);
    await click("[data-action=select-row][data-id='1']");
    await until(() => page.eval(`!!${ROOT}.querySelector('[data-bulk]')`));
    let bar = await page.eval(`(() => { const b = ${ROOT}.querySelector('[data-bulk]'); return { label: b.getAttribute('aria-label'), role: b.getAttribute('role'), text: b.querySelector('b').textContent.trim(), options: [...b.querySelectorAll('option')].map((o) => o.textContent.trim()), run: b.querySelector('[data-action=run]').textContent.trim(), disabled: b.querySelector('[data-action=run]').disabled }; })()`);
    page.assert(bar.role === "region" && bar.label === "Действия с выбранными", "bulk region labelled");
    page.assert(bar.text === "Выбрано: 1", `selected count (${bar.text})`);
    page.assert(JSON.stringify(bar.options) === JSON.stringify(["v2 — активная", "v1"]), `saved versions only, no draft (${bar.options})`);
    page.assert(bar.run === "Оценить выбранные" && bar.disabled === false, "run button enabled for QA / Проверяющий");
    await click("[data-action=select-row][data-id='3']");
    await until(async () => (await page.eval(`${ROOT}.querySelector('[data-bulk] b').textContent.trim()`)) === "Выбрано: 2");
    await click("[data-action=select-all]");
    await until(async () => (await page.eval(`${ROOT}.querySelector('[data-bulk] b').textContent.trim()`)) === "Выбрано: 11");
    page.assert(await page.eval(`${ROOT}.querySelector('[data-action=select-all]').checked`), "select all is checked");
    await click("[data-action=select-all]");
    await until(() => page.eval(`!${ROOT}.querySelector('[data-bulk]')`));
    await click("[data-action=select-row][data-id='4']");
    await click("[data-action=select-row][data-id='5']");
    await until(async () => (await page.eval(`${ROOT}.querySelector('[data-bulk] b')?.textContent.trim()`)) === "Выбрано: 2");
    await page.eval(`(() => { const s = ${ROOT}.querySelector('[data-bulk-version]'); s.value = '11'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await click("[data-action=run]");
    await until(() => page.eval(`document.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]').hasAttribute('open')`));
    const confirmInfo = await page.eval(`(() => { const m = document.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]'); const dlg = m.shadowRoot.querySelector('[role=dialog]'); return { title: m.getAttribute('heading'), desc: m.getAttribute('description'), modal: dlg.getAttribute('aria-modal') }; })()`);
    page.assert(confirmInfo.title === "Оценить выбранные диалоги?", `confirm heading (${confirmInfo.title})`);
    page.assert(/2 диалога · v1 · модель LLM-оценщик v3\. Ориентировочная стоимость: 0,008 \$\./.test(confirmInfo.desc), `estimate in confirm text (${confirmInfo.desc})`);
    await page.eval(`document.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm-cancel]').click()`);
    await until(() => page.eval(`!document.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]').hasAttribute('open')`));
    page.assert(!(await page.eval(`!!${ROOT}.querySelector('[data-queued]')`)), "cancelling the confirm does not queue a run");
    page.assert(!(await page.eval(`${ROOT}.querySelector('[data-action=run]').disabled`)), "run button usable again after cancel");
    await click("[data-action=run]");
    await until(() => page.eval(`document.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]').hasAttribute('open')`));
    await page.eval(`document.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm-ok]').click()`);
    await until(() => page.eval(`!!${ROOT}.querySelector('[data-queued]')`));
    const queued = await page.eval(`(() => { const q = ${ROOT}.querySelector('[data-queued]'); const a = q.querySelector('a'); return { text: q.textContent.replace(/\\s+/g, ' ').trim(), href: a.getAttribute('href'), role: q.getAttribute('role') }; })()`);
    page.assert(queued.text === "Поставлено в очередь · открыть в Запусках" && queued.role === "status", `queued status (${queued.text})`);
    page.assert(/^#\/runs\/R-\d+$/.test(queued.href), `queued link targets the new run (${queued.href})`);
    await click("[data-action=select-row][data-id='6']");
    await until(() => page.eval(`!${ROOT}.querySelector('[data-queued]')`));
    page.assert(true, "changing the selection resets the queued note");
    await page.eval(`${ROOT}.querySelector('[data-action=clear]').click()`);
    await until(() => page.eval(`!${ROOT}.querySelector('[data-bulk]')`));
    page.assert((await page.eval(`${ROOT}.querySelectorAll('[data-action=select-row]:checked').length`)) === 0, "Снять выбор clears every checkbox");
    await click("[data-action=select-row][data-id='1']");
    await until(() => page.eval(`!!${ROOT}.querySelector('[data-bulk]')`));
    await click("[data-action=run]");
    await until(() => page.eval(`document.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]').hasAttribute('open')`));
    await page.eval(`document.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm-ok]').click()`);
    await until(() => page.eval(`!!${ROOT}.querySelector('[data-queued] a')`));
    await page.eval(`${ROOT}.querySelector('[data-queued] a').click()`);
    await until(() => page.eval(`location.hash.startsWith('#/runs/R-')`));
    page.assert(true, "queued link navigates to Runs");
    await page.assertAccessibleNames();
  },

  async "list-bulk-look"(page) {
    await open(page, "mock=1&role=reviewer");
    await rows(page);
    for (const id of [1, 3, 4]) await page.eval(`${ROOT}.querySelector("[data-action=select-row][data-id='${id}']").click()`);
    await until(() => page.eval(`${ROOT}.querySelector('[data-bulk] b')?.textContent.trim() === 'Выбрано: 3'`));
    await page.eval(`${ROOT}.querySelector('[data-action=run]').click()`);
    await until(() => page.eval(`document.querySelector('cqa-app').shadowRoot.querySelector('[data-confirm]').hasAttribute('open')`));
    await sleep(300);
  },

  async "list-bulk-roles"(page) {
    await open(page, "mock=1&role=operator");
    await rows(page);
    await until(() => page.eval(`document.querySelector('cqa-app').getAttribute('role') === 'operator'`));
    await page.eval(`${ROOT}.querySelector('[data-action=select-row][data-id="1"]').click()`);
    await until(() => page.eval(`!!${ROOT}.querySelector('[data-bulk]')`));
    const state = await page.eval(`({ disabled: ${ROOT}.querySelector('[data-action=run]').disabled, hint: ${ROOT}.querySelector('[data-hint]').textContent.trim() })`);
    page.assert(state.disabled && state.hint === "Оценка доступна роли QA / Проверяющий", `operator cannot evaluate (${JSON.stringify(state)})`);
  },

  async "list-keyboard"(page) {
    await open(page, "mock=1&role=reviewer");
    await rows(page);
    await page.eval(`window.__nav = []; document.addEventListener('cqa:navigate', (e) => window.__nav.push(e.detail));`);
    const row = (n) => page.eval(`${ROOT}.querySelectorAll('[data-row]')[${n}].getAttribute('data-focus-id')`);
    const active = () => page.eval(`${ROOT}.activeElement && ${ROOT}.activeElement.getAttribute('data-focus-id')`);
    const tabbable = () => page.eval(`[...${ROOT}.querySelectorAll('[data-row]')].filter((r) => r.getAttribute('tabindex') === '0').map((r) => r.getAttribute('data-focus-id')).join()`);
    page.assert((await tabbable()) === "row-1", `one roving tab stop on the first row (${await tabbable()})`);
    await page.eval(`${ROOT}.querySelectorAll('[data-row]')[0].focus()`);
    const ring = await page.active();
    page.assert(ring && ring.focusId === "row-1", `row focusable (${JSON.stringify(ring)})`);
    await page.press("j");
    page.assert((await active()) === (await row(1)), `j moves to the second row (${await active()})`);
    await page.press("j");
    await page.press("k");
    page.assert((await active()) === (await row(1)), `k moves back (${await active()})`);
    await page.press("ArrowDown");
    page.assert((await active()) === (await row(2)), "ArrowDown moves");
    await page.press("k");
    await page.press("k");
    await page.press("k");
    page.assert((await active()) === (await row(0)), "k stops at the first row");
    const outline = await page.eval(`(() => { const r = ${ROOT}.activeElement; const cs = getComputedStyle(r); return cs.outlineStyle + ' ' + cs.outlineWidth; })()`);
    page.assert(outline === "solid 2px", `visible focus ring on a row (${outline})`);
    await page.press("j");
    await page.press(" ");
    await until(() => page.eval(`!!${ROOT}.querySelector('[data-bulk]')`));
    page.assert((await page.eval(`${ROOT}.querySelector('[data-bulk] b').textContent.trim()`)) === "Выбрано: 1", "Space toggles selection");
    page.assert((await active()) === (await row(1)), `focus stays on the row after toggling (${await active()})`);
    await page.press(" ");
    await until(() => page.eval(`!${ROOT}.querySelector('[data-bulk]')`));
    await page.press("Enter");
    await until(() => page.eval(`window.__nav.some((e) => e.to === 'conversations' && e.id === 'p1-kz-007')`));
    page.assert(true, "Enter emits cqa:navigate for the active row");
    await page.eval(`history.back()`);
    await until(() => page.eval(`!!${HOST} && location.hash === '#/conversations'`));
    await rows(page);
    await page.eval(`${ROOT}.querySelector('[data-search]').focus()`);
    await page.press("j");
    page.assert((await page.eval(`${ROOT}.activeElement.getAttribute('data-focus-id')`)) === "search", "j in the search box types, it does not move rows");
    await page.eval(`${ROOT}.querySelector('[data-search]').value = ''`);
    await page.assertAccessibleNames();
  },

  async "list-states"(page) {
    await open(page, "mock=1&state=loading");
    await until(() => page.eval(`!!${ROOT}.querySelector('[data-skeleton]')`));
    const sk = await page.eval(`(() => { const s = ${ROOT}.querySelector('[data-skeleton]'); return { busy: s.getAttribute('aria-busy'), role: s.getAttribute('role'), rows: s.querySelectorAll('.lt-skel-row').length, name: s.getAttribute('aria-label') }; })()`);
    page.assert(sk.busy === "true" && sk.role === "status" && sk.rows >= 5 && sk.name === "Загрузка", `loading skeleton (${JSON.stringify(sk)})`);
    await page.assertAccessibleNames();

    await open(page, "mock=1&state=error");
    await until(() => page.eval(`!!${ROOT}.querySelector('[role=alert]')`));
    page.assert(!!(await page.eval(`${ROOT}.querySelector('[data-action=retry]')`)), "error state has retry");
    await page.eval(`${ROOT}.querySelector('[data-action=retry]').click()`);
    await until(() => page.eval(`!!${ROOT}.querySelector('[role=alert]')`));
    await page.assertAccessibleNames();

    await open(page, "mock=1&state=empty");
    await until(() => page.eval(`!!${ROOT}.querySelector('.panel .panel-title')`));
    page.assert((await page.eval(`${ROOT}.querySelector('.panel-title').textContent.trim()`)) === "Диалогов по фильтру нет", "empty state title");
    await page.assertAccessibleNames();
  },

  async "list-locales"(page) {
    await open(page, "mock=1&locale=en&role=reviewer");
    await rows(page);
    const en = await page.eval(`(() => { const r = ${ROOT}; const row = [...r.querySelectorAll('[data-row]')][0]; return { h2: r.querySelector('h2').textContent.trim(), counts: r.querySelector('[data-counts]').textContent.trim(), heads: [...r.querySelectorAll('[role=columnheader]')].map((h) => h.textContent.trim()).slice(5, 9), cells: [...row.querySelectorAll('[role=cell]')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()), search: r.querySelector('[data-search]').getAttribute('aria-label'), views: [...r.querySelectorAll('[data-action=view]')].map((b) => b.textContent.trim()) }; })()`);
    page.assert(en.h2 === "Conversations" && /^10 evaluated · 11 shown$/.test(en.counts), `English title and counts (${en.h2}, ${en.counts})`);
    page.assert(en.cells[5].startsWith("81.88") && en.cells[6] === "31.25" && en.cells[12] === "11/07/2026, 09:42", `English numbers and date (${en.cells})`);
    page.assert(en.cells[2] === "Chat" && en.cells[9] === "No" && en.cells[10] === "Under review", `English cell text (${en.cells})`);
    page.assert(en.views.join("|") === "All|Gross violations|With appeals", `English views (${en.views})`);
    await open(page, "mock=1&locale=kk&role=reviewer");
    await rows(page);
    const kk = await page.eval(`(() => { const r = ${ROOT}; const row = [...r.querySelectorAll('[data-row]')][0]; return { h2: r.querySelector('h2').textContent.trim(), cells: [...row.querySelectorAll('[role=cell]')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()), counts: r.querySelector('[data-counts]').textContent.trim() }; })()`);
    page.assert(kk.h2 === "Диалогтар" && kk.cells[2] === "Чат" && kk.cells[5].startsWith("81,88") && kk.cells[10] === "Қарастырылуда", `Kazakh rendering (${kk.h2}, ${kk.cells})`);
    await page.eval(`document.querySelector('cqa-app').setAttribute('locale', 'ru')`);
    await until(async () => (await page.eval(`${ROOT}.querySelector('h2').textContent.trim()`)) === "Диалоги");
    page.assert(true, "locale switch re-renders without reload");
    await page.assertAccessibleNames();
  }
};
