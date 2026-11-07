import { execFileSync } from "node:child_process";

const APP = "document.querySelector('cqa-app')";
const LIST = `${APP}.shadowRoot.querySelector('cqa-conversation-list')`;
const LR = `(${LIST} && ${LIST}.shadowRoot || document.createDocumentFragment())`;
const OV = "cqa-app >>> cqa-overview";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeout = 8000, step = 80) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
    }
    if (Date.now() - start > timeout) throw new Error("timeout waiting for " + fn.toString().slice(0, 120));
    await sleep(step);
  }
}

const norm = (text) => String(text).replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

async function open(page, hash, extra = "") {
  const base = (await page.eval("location.href")).split("?")[0].split("#")[0];
  await page.eval(`window.__gone = true; location.href = ${JSON.stringify(`${base}?real=${Date.now()}${extra}${hash}`)}`).catch(() => {});
  await until(() => page.eval(`!window.__gone && document.readyState === 'complete' && !!document.querySelector('cqa-app')`));
}

async function apiJson(page, path) {
  return page.eval(`fetch(new URL('../api/v1${path}', location.href)).then((r) => r.json())`);
}

async function listReady(page) {
  await until(() => page.eval(`!!${LIST} && !!${LR}.querySelector('[data-row]')`));
  await until(() => page.eval(`${LR}.querySelector('[data-table]').getAttribute('aria-busy') !== 'true'`));
}

const rowIds = (page) => page.eval(`[...${LR}.querySelectorAll('[data-row] .lt-id')].map((a) => a.textContent.trim())`);
const counts = (page) => page.eval(`${LR}.querySelector('[data-counts]').textContent.trim()`);
const setFilter = (page, name, value) =>
  page.eval(`(() => { const s = ${LR}.querySelector('[data-filter=${name}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

async function settle(page) {
  await sleep(150);
  await until(() => page.eval(`${LR}.querySelector('[data-table]') ? ${LR}.querySelector('[data-table]').getAttribute('aria-busy') !== 'true' : true`));
}

function sql(query) {
  const db = process.env.CQA_COPY_DB;
  if (!db) return null;
  return execFileSync("sqlite3", ["-readonly", db, query], { encoding: "utf8" }).trim();
}

function comma(value, digits = 2) {
  return Number(value).toFixed(digits).replace(".", ",");
}

export const scenarios = {
  async "real-list"(page) {
    await open(page, "#/conversations");
    await listReady(page);
    const all = await apiJson(page, "/conversations?envelope=1");
    page.assert(all.total === 65, `backend reports 65 conversations (${all.total})`);
    const firstPage = await rowIds(page);
    page.assert(firstPage.length === 50, `first page holds 50 rows (${firstPage.length})`);
    const pager = await page.eval(`${LR}.querySelector('[data-range]').textContent.trim()`);
    page.assert(/1.50.+65/.test(norm(pager)), `pager range (${pager})`);
    const heading = norm(await counts(page));
    page.assert(heading.includes("65"), `counts text shows 65 evaluated (${heading})`);

    const cells = await page.eval(`(() => {
      const r = ${LR};
      const row = (id) => [...r.querySelectorAll('[data-row]')].find((x) => x.querySelector('.lt-id').textContent.trim() === id);
      const cellsOf = (id) => { const x = row(id); return x ? [...x.querySelectorAll('[role=cell]')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()) : null; };
      return { a: cellsOf('p1-ru-001'), operators: [...new Set([...r.querySelectorAll('[data-row]')].map((x) => x.querySelectorAll('[role=cell]')[4].textContent.trim()))], hasAudioLeak: r.innerHTML.includes('audio_url') };
    })()`);
    const first = all.items.find((i) => i.conversation_id === "p1-ru-001");
    page.assert(cells.a && cells.a[1] === "p1-ru-001" && cells.a[2].includes("Чат") && cells.a[3] === "RU", `p1-ru-001 channel and language (${cells.a})`);
    page.assert(cells.a[5].startsWith(comma(first.final_total)), `final total ${first.final_total} (${cells.a[5]})`);
    const sections = first.sections.filter((s) => s.id !== "gross").map((s) => comma(s.effective_points));
    page.assert(JSON.stringify(cells.a.slice(6, 9)) === JSON.stringify(sections), `section subtotals ${sections} (${cells.a.slice(6, 9)})`);
    page.assert(cells.operators.length === 1 && cells.operators[0] === "Оператор A", `operator column constant (${cells.operators})`);
    page.assert(!cells.hasAudioLeak, "audio_url never rendered");

    const rowsFromApi = all.items.slice(0, 50);
    const mismatches = await page.eval(`(() => {
      const expected = ${JSON.stringify(rowsFromApi.map((i) => ({ id: i.conversation_id, total: i.final_total, gross: i.gross_violation, status: i.eval_status })))};
      const bad = [];
      for (const e of expected) {
        const row = [...${LR}.querySelectorAll('[data-row]')].find((x) => x.querySelector('.lt-id').textContent.trim() === e.id);
        if (!row) { bad.push(e.id + ' missing'); continue; }
        const cells = [...row.querySelectorAll('[role=cell]')];
        const total = cells[5].textContent.replace(/\\s+/g, ' ').trim();
        const wanted = e.total === null ? '—' : e.total.toFixed(2).replace('.', ',');
        if (e.total === null ? !total.includes('—') : !total.startsWith(wanted)) bad.push(e.id + ' total ' + total + ' vs ' + wanted);
        const gross = cells[9].textContent.trim();
        if (e.gross && !/Грубое|Да|нарушен/i.test(gross)) bad.push(e.id + ' gross ' + gross);
      }
      return bad;
    })()`);
    page.assert(mismatches.length === 0, `rows equal backend payload: ${mismatches.slice(0, 5).join(" | ")}`);

    await page.eval(`${LR}.querySelector('[data-action=next]').click()`);
    await settle(page);
    await until(async () => (await rowIds(page)).length === 15);
    const second = await rowIds(page);
    page.assert(second.every((id) => !firstPage.includes(id)), "second page has no overlap with the first");
    page.assert(second.length + firstPage.length === 65, "pages cover all 65");
    page.assert(await page.eval(`${LR}.querySelector('[data-action=next]').disabled`), "next disabled on last page");
    await page.eval(`${LR}.querySelector('[data-action=prev]').click()`);
    await settle(page);
    await until(async () => (await rowIds(page)).length === 50);
  },

  async "real-list-search-sort"(page) {
    await open(page, "#/conversations");
    await listReady(page);
    await page.eval(`(() => { const i = ${LR}.querySelector('[data-search]'); i.value = 'p4-ru-005'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const hit = await apiJson(page, "/conversations?envelope=1&q=" + encodeURIComponent("p4-ru-005"));
    await until(async () => (await rowIds(page)).length === hit.items.length && hit.items.length > 0);
    page.assert((await rowIds(page)).includes("p4-ru-005"), "search by id returns the conversation");
    await page.eval(`(() => { const i = ${LR}.querySelector('[data-search]'); i.value = 'спасибо'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const text = await apiJson(page, "/conversations?envelope=1&q=" + encodeURIComponent("спасибо"));
    await until(async () => (await rowIds(page)).length === Math.min(50, text.total));
    page.assert(text.total > 0, `message text search has hits (${text.total})`);
    page.assert((await rowIds(page)).length === Math.min(50, text.total), "message-text search rows equal server total");
    await page.eval(`(() => { const i = ${LR}.querySelector('[data-search]'); i.value = 'zzzz-no-such-text'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(() => page.eval(`!!${LR}.querySelector('.panel')`));
    page.assert(await page.eval(`!!${LR}.querySelector('[data-action=reset]')`), "empty search offers reset");
    await page.eval(`${LR}.querySelector('[data-action=reset]').click()`);
    await listReady(page);

    await page.eval(`${LR}.querySelector('[data-action=sort]').click()`);
    await settle(page);
    const asc = await apiJson(page, "/conversations?envelope=1&sort=final_total&limit=50");
    await until(async () => (await rowIds(page))[0] === asc.items[0].conversation_id);
    page.assert(JSON.stringify(await rowIds(page)) === JSON.stringify(asc.items.map((i) => i.conversation_id)), "ascending order comes from the server");
    page.assert((await page.eval(`${LR}.querySelector('[aria-sort]').getAttribute('aria-sort')`)) === "ascending", "aria-sort ascending");
    await page.eval(`${LR}.querySelector('[data-action=sort]').click()`);
    await settle(page);
    const desc = await apiJson(page, "/conversations?envelope=1&sort=-final_total&limit=50");
    await until(async () => (await rowIds(page))[0] === desc.items[0].conversation_id);
    page.assert(desc.items[0].final_total >= desc.items[1].final_total, "descending from the server");
  },

  async "real-list-filters"(page) {
    await open(page, "#/conversations");
    await listReady(page);
    await setFilter(page, "channel", "call");
    await settle(page);
    const calls = await apiJson(page, "/conversations?envelope=1&channel=voice%20call");
    await until(async () => (await rowIds(page)).length === calls.total);
    page.assert(calls.total === 5, `5 voice calls (${calls.total})`);
    const callIcons = await page.eval(`[...${LR}.querySelectorAll('[data-row] .lt-chan')].every((c) => c.textContent.includes('Звонок'))`);
    page.assert(callIcons, "all rows are calls");
    await setFilter(page, "channel", "");
    await setFilter(page, "language", "KZ");
    await settle(page);
    const kz = await apiJson(page, "/conversations?envelope=1&language=KZ");
    await until(async () => (await rowIds(page)).length === kz.total);
    await setFilter(page, "language", "");
    await settle(page);
    await page.eval(`${LR}.querySelector('[data-view=gross]').click()`);
    await settle(page);
    await until(async () => (await rowIds(page)).length === 8);
    page.assert((await rowIds(page)).length === 8, "gross view lists 8 conversations");
    const grossChips = await page.eval(`${LR}.querySelectorAll('.c-crit').length`);
    page.assert(grossChips === 8, `8 gross chips (${grossChips})`);
    await page.eval(`${LR}.querySelector('[data-view=all]').click()`);
    await settle(page);
    await setFilter(page, "appealStatus", "new");
    await settle(page);
    await sleep(200);
    const none = await page.eval(`${LR}.querySelectorAll('[data-row]').length`);
    const openAppeals = await apiJson(page, "/conversations?envelope=1&appeal_status=open");
    page.assert(none === openAppeals.total, `new-appeals filter equals server open count (${none} vs ${openAppeals.total})`);
    await page.eval(`${LR}.querySelector('[data-action=reset]') && ${LR}.querySelector('[data-action=reset]').click()`);
    await setFilter(page, "appealStatus", "");
    await settle(page);
    await page.assertAccessibleNames();
  },

  async "real-list-bulk"(page) {
    await open(page, "#/conversations", "&role=reviewer");
    await listReady(page);
    await page.eval(`(() => {
      window.__posts = [];
      const real = window.fetch;
      window.fetch = async (input, options = {}) => {
        const target = new URL(String(input), location.href);
        if ((options.method || 'GET') === 'POST' && target.pathname.endsWith('/runs')) {
          window.__posts.push(JSON.parse(options.body));
          return new Response(JSON.stringify({ id: 9001, run_id: 9001, code: 'R-9001', dataset: null, checklist_version_id: 1, model: 'x', force: false, status: 'queued', total: 2, to_run: 2, skipped: 0, processed: 0, completed: 0, needs_review: 0, failed: 0, done: 0, running: 0, queued: 2, percent: 0, items: [], failures: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (target.pathname.endsWith('/runs/9001')) {
          return new Response(JSON.stringify({ id: 9001, run_id: 9001, code: 'R-9001', checklist_version_id: 1, status: 'queued', total: 2, to_run: 2, skipped: 0, processed: 0, completed: 0, needs_review: 0, failed: 0, done: 0, running: 0, queued: 2, percent: 0, items: [], failures: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return real(input, options);
      };
    })()`);
    await page.eval(`${LR}.querySelectorAll('[data-action=select-row]')[0].click()`);
    await until(() => page.eval(`!!${LR}.querySelector('[data-bulk]')`));
    await page.eval(`${LR}.querySelectorAll('[data-action=select-row]')[1].click()`);
    await until(async () => /2/.test(await page.eval(`${LR}.querySelector('[data-bulk] b').textContent`)));
    const selectedText = norm(await page.eval(`${LR}.querySelector('[data-bulk] b').textContent`));
    page.assert(/2/.test(selectedText), `bulk shows the selection (${selectedText})`);
    const picked = await page.eval(`[...${LR}.querySelectorAll('[data-action=select-row]')].slice(0, 2).map((c) => Number(c.getAttribute('data-id')))`);
    const versionOptions = await page.eval(`[...${LR}.querySelectorAll('[data-bulk-version] option')].map((o) => o.textContent.trim())`);
    page.assert(versionOptions.length >= 1, `bulk version select has options (${versionOptions})`);
    await page.eval(`${LR}.querySelector('[data-action=run]').click()`);
    await until(() => page.eval(`${APP}.shadowRoot.querySelector('[data-confirm]').hasAttribute('open')`));
    const desc = await page.eval(`${APP}.shadowRoot.querySelector('[data-confirm]').getAttribute('description')`);
    page.assert(/2/.test(desc), `confirm text mentions two conversations (${desc})`);
    await page.eval(`${APP}.shadowRoot.querySelector('[data-confirm-ok]').click()`);
    await until(() => page.eval(`window.__posts.length === 1`));
    const posted = await page.eval(`window.__posts[0]`);
    page.assert(JSON.stringify(posted.conversation_pks) === JSON.stringify(picked), `run posted with the two pks (${JSON.stringify(posted)})`);
    page.assert(posted.checklist_version_id > 0 && posted.force === false && !posted.dataset, `run body shape (${JSON.stringify(posted)})`);
    await until(() => page.eval(`!!${LR}.querySelector('[data-queued]')`));
    await page.eval(`${LR}.querySelector('[data-queued] a').click()`);
    await until(() => page.eval(`location.hash.startsWith('#/runs')`));
    page.assert((await page.eval(`location.hash`)).includes("9001"), "toast link navigates to the run");
  },

  async "real-locales"(page) {
    const all = await apiJson(page, "/conversations?envelope=1");
    const target = all.items.find((i) => i.final_total !== null);
    page.assert(Boolean(target), "the database has at least one evaluated conversation");
    const targetId = target.conversation_id;
    const stats = await apiJson(page, "/stats/overview");
    const fixed = (value, locale) => Number(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
    await open(page, "#/conversations", "&locale=en");
    await listReady(page);
    const en = await page.eval(`(() => { const row = [...${LR}.querySelectorAll('[data-row]')].find((x) => x.querySelector('.lt-id').textContent.trim() === ${JSON.stringify(targetId)}); return { found: !!row, cells: row ? [...row.querySelectorAll('[role=cell]')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()) : [], h2: ${LR}.querySelector('h1').textContent.trim(), counts: ${LR}.querySelector('[data-counts]').textContent.trim() }; })()`);
    page.assert(en.found, `conversation ${targetId} is on the first page`);
    page.assert(en.cells[5].startsWith(fixed(target.final_total, "en-US")), `English decimal point (${en.cells[5]} vs ${fixed(target.final_total, "en-US")})`);
    page.assert(en.cells[2].includes("Chat") || en.cells[2].includes("Call"), `English labels (${en.cells[2]})`);
    page.assert(en.h2 === "Conversations", `English heading (${en.h2})`);
    page.assert(en.counts.includes(String(all.total)), `English counts (${en.counts} vs ${all.total})`);
    await open(page, "#/conversations", "&locale=kk");
    await listReady(page);
    const kk = await page.eval(`(() => { const row = [...${LR}.querySelectorAll('[data-row]')].find((x) => x.querySelector('.lt-id').textContent.trim() === ${JSON.stringify(targetId)}); return { total: row.querySelectorAll('[role=cell]')[5].textContent.trim(), h2: ${LR}.querySelector('h1').textContent.trim() }; })()`);
    page.assert(kk.total.startsWith(fixed(target.final_total, "en-US").replace(".", ",")) && kk.h2 !== "Диалоги" && kk.h2 !== "Conversations", `Kazakh render (${kk.total}, ${kk.h2})`);
    await open(page, "#/overview", "&locale=en");
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .kpis .kpi`)}).length === 5`));
    const avg = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .kpis .kpi`)})[0].querySelector('.kpi-value').textContent.trim()`);
    page.assert(norm(avg).startsWith(fixed(stats.kpis.avg, "en-US")), `English overview average (${avg} vs ${stats.kpis.avg})`);
  },

  async "real-overview"(page) {
    await open(page, "#/overview");
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .kpis .kpi`)}).length === 5`));
    await sleep(300);
    const tiles = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .kpis .kpi`)}).map((k) => ({ label: k.querySelector('.kpi-label').textContent.trim(), value: k.querySelector('.kpi-value').textContent.trim(), note: k.querySelector('.kpi-note').textContent.trim() }))`);
    const stats = await apiJson(page, "/stats/overview");
    const all = await apiJson(page, "/conversations?envelope=1");
    const totals = all.items.map((i) => i.final_total).filter((v) => v !== null);
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    page.assert(Math.abs(stats.kpis.avg - mean) < 0.01, `server average equals mean of list final totals (${stats.kpis.avg} vs ${mean})`);
    page.assert(norm(tiles[0].value).startsWith(comma(stats.kpis.avg)), `avg tile (${tiles[0].value})`);
    page.assert(norm(tiles[1].value).replace(/\s/g, "") === String(stats.kpis.evaluated), `evaluated tile (${tiles[1].value})`);
    page.assert(norm(tiles[2].note).includes(String(stats.kpis.gross_count)), `gross tile note (${tiles[2].note})`);
    page.assert(stats.kpis.gross_count === 8, `gross count 8 (${stats.kpis.gross_count})`);
    const sum = stats.distribution.reduce((a, b) => a + b.count, 0);
    page.assert(sum === stats.kpis.evaluated && sum + stats.kpis.not_calculated === 65, `distribution ${sum} + not calculated ${stats.kpis.not_calculated} = 65`);
    const bars = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .chart-bar`)}).length`);
    page.assert(bars > 0, `distribution chart rendered (${bars})`);
    const criterionRows = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .crit-row`)}).length`);
    page.assert(criterionRows === stats.per_criterion.length, `per-criterion rows (${criterionRows} vs ${stats.per_criterion.length})`);
    if (process.env.CQA_COPY_DB) {
      const gross = Number(sql("with l as (select * from evaluation e where id=(select max(id) from evaluation where conversation_id=e.conversation_id)) select sum(gross_violation) from l"));
      const count = Number(sql("select count(*) from conversation"));
      page.assert(gross === stats.kpis.gross_count && count === 65, `SQL gross ${gross} and conversations ${count} equal the API`);
    }
    await setSelect(page, "language", "RU");
    await sleep(500);
    const ru = await apiJson(page, "/stats/overview?language=RU");
    const ruTile = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .kpis .kpi`)})[1].querySelector('.kpi-value').textContent.trim()`);
    page.assert(norm(ruTile).replace(/\s/g, "") === String(ru.kpis.evaluated), `RU filter evaluated (${ruTile} vs ${ru.kpis.evaluated})`);
    await setSelect(page, "language", "");
    await sleep(400);
    await setSelect(page, "period", "last7");
    await sleep(600);
    const range = await page.eval(`(() => { const to = new Date().toISOString().slice(0, 10); const from = new Date(Date.parse(to + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10); return { from, to }; })()`);
    const week = await apiJson(page, `/stats/overview?from=${range.from}&to=${range.to}`);
    const weekTile = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .kpis .kpi`)})[1].querySelector('.kpi-value').textContent.trim()`);
    page.assert(norm(weekTile).replace(/\s/g, "") === String(week.kpis.evaluated), `last 7 days evaluated (${weekTile} vs ${week.kpis.evaluated})`);
    await setSelect(page, "channel", "call");
    await sleep(600);
    const callOnly = await apiJson(page, `/stats/overview?from=${range.from}&to=${range.to}&channel=call`);
    const callTile = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .kpis .kpi`)})[1].querySelector('.kpi-value').textContent.trim()`);
    page.assert(norm(callTile).replace(/\s/g, "") === String(callOnly.kpis.evaluated), `calls only (${callTile} vs ${callOnly.kpis.evaluated})`);
    await page.assertAccessibleNames();
  }
};

async function setSelect(page, name, value) {
  await page.eval(`(() => { const s = cqaDeep(${JSON.stringify(`${OV} >>> select[data-filter=${name}]`)})[0]; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
