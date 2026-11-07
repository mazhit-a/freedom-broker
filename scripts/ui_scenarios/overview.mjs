const OV = "cqa-app >>> cqa-overview";

async function until(fn, timeout = 8000, step = 80) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
    }
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

const norm = (text) => String(text).replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

async function open(page, query = "mock=1", hash = "#/overview") {
  const base = (await page.eval("location.href")).split("?")[0].split("#")[0];
  await page.eval(`location.href = ${JSON.stringify(`${base}?${query}${hash}`)}`);
  await until(() => page.eval(`document.readyState === 'complete' && !!document.querySelector('cqa-app')`));
  await until(() => page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .page`)}).length > 0`));
}

async function ready(page) {
  await until(() => page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .kpis .kpi`)}).length === 5`));
}

async function kpis(page) {
  return page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .kpis .kpi`)}).map((k) => ({
    label: k.querySelector('.kpi-label').textContent.trim(),
    value: k.querySelector('.kpi-value').textContent.trim(),
    note: k.querySelector('.kpi-note').textContent.trim(),
    noteClass: k.querySelector('.kpi-note').className,
    valueColor: getComputedStyle(k.querySelector('.kpi-value')).color,
    border: getComputedStyle(k).borderTopColor
  }))`);
}

async function setSelect(page, name, value) {
  await page.eval(`(() => { const s = cqaDeep(${JSON.stringify(`${OV} >>> select[data-filter=${name}]`)})[0]; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}

export const scenarios = {
  async overview(page) {
    await open(page);
    await ready(page);
    const k = (await kpis(page)).map((x) => ({ ...x, value: norm(x.value), note: norm(x.note) }));
    page.assert(k[0].value === "78,42 из 100", `avg tile (${k[0].value})`);
    page.assert(k[0].note.includes("1,84 к прошлому периоду") && k[0].noteClass.includes("up"), `delta line (${k[0].note} / ${k[0].noteClass})`);
    page.assert(k[1].value === "1 248" && k[1].note === "1 034 чата · 214 звонков", `evaluated tile (${k[1].value} / ${k[1].note})`);
    page.assert(k[2].value === "3,4 %" && k[2].note === "42 диалога · не входит в балл", `gross tile (${k[2].value} / ${k[2].note})`);
    page.assert(k[3].value === "17" && k[3].note === "5 старше 3 дней" && k[3].noteClass.includes("warn"), `appeals tile (${k[3].value} / ${k[3].note})`);
    page.assert(k[4].value === "1,6 дня" && k[4].note === "медиана · цель ≤ 2 дней", `resolution tile (${k[4].value} / ${k[4].note})`);
    const critical = await page.eval(`(() => { const host = cqaDeep(${JSON.stringify(OV)})[0]; const probe = document.createElement('i'); probe.style.color = 'var(--cqa-critical)'; host.shadowRoot.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })()`);
    page.assert(k[2].valueColor === critical, `gross value uses --cqa-critical (${k[2].valueColor} vs ${critical})`);
    const h1 = await page.deepText(`${OV} >>> h1`);
    page.assert(h1 === "Обзор качества обслуживания", `h1 (${h1})`);
    const sub = norm(await page.deepText(`${OV} >>> .lead`));
    page.assert(/^01\.10\.2026 — 07\.11\.2026 · «Чек-лист качества чатов» v2 · оценено моделью, проверено ОКК$/.test(sub), `subtitle (${sub})`);

    const fig = await page.eval(`(() => { const f = cqaDeep(${JSON.stringify(`${OV} >>> figure.chart`)})[0]; return { role: f.getAttribute('role'), label: f.getAttribute('aria-label'), bands: [...f.querySelectorAll('.chart-bar i')].map((i) => i.className.replace('band-', '')), vals: [...f.querySelectorAll('.chart-val')].map((v) => v.textContent.trim()), legend: f.querySelectorAll('.legend span').length, labels: [...f.querySelectorAll('.chart-labels span')].map((s) => s.textContent) }; })()`);
    page.assert(fig.role === "img" && norm(fig.label).includes("70–100 баллов") && norm(fig.label).includes("80–90 — 392 диалога"), `histogram aria-label (${fig.label})`);
    page.assert(fig.bands.length === 10 && fig.bands.slice(0, 5).every((b) => b === "bad") && fig.bands.slice(5, 7).every((b) => b === "warn") && fig.bands.slice(7).every((b) => b === "ok"), `bands (${fig.bands})`);
    page.assert(fig.vals.map(norm).join() === "4,6,11,19,38,74,162,301,392,241", `bar counts (${fig.vals})`);
    page.assert(fig.legend === 3 && fig.labels[0] === "0–10" && fig.labels[9] === "90–100", "legend and axis labels");
    const hidden = await page.eval(`(() => { const t = cqaDeep(${JSON.stringify(`${OV} >>> .sr-only table`)})[0]; const r = t.getBoundingClientRect(); return { rows: t.querySelectorAll('tbody tr').length, text: [...t.querySelectorAll('tbody tr')].map((tr) => tr.textContent.replace(/\\s+/g, ' ').trim()).join('|'), w: t.parentElement.getBoundingClientRect().width, caption: t.querySelector('caption').textContent }; })()`);
    page.assert(hidden.rows === 10 && hidden.text.includes("80–90") && hidden.text.includes("392") && hidden.w <= 1, `visually hidden data table (${hidden.rows}, w=${hidden.w})`);

    const crit = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .crit-row`)}).map((r) => ({ name: r.querySelector('.crit-name').textContent.replace(/\\s+/g, ' ').trim(), val: r.querySelector('.crit-val').textContent.trim(), band: r.querySelector('.crit-fill').className, w: r.querySelector('.crit-fill').style.width }))`);
    page.assert(crit.length === 7, `seven criterion bars (${crit.length})`);
    page.assert(norm(crit[0].val) === "61 %" && norm(crit[1].val) === "68 %" && crit[0].band.includes("band-warn") && crit[2].band.includes("band-ok"), `weakest first (${JSON.stringify(crit.slice(0, 3))})`);
    page.assert(crit.every((c, i) => i === 0 || parseInt(c.val, 10) >= parseInt(crit[i - 1].val, 10)), "sorted ascending");
    page.assert(!crit.some((c) => c.name.startsWith("08")), "08 is not a bar");
    const note = await page.deepText(`${OV} >>> .block-note`);
    page.assert(note.includes("N/A") && note.includes("08"), `N/A and 08 note (${note})`);

    const split = await page.eval(`(() => { const t = cqaDeep(${JSON.stringify(`${OV} >>> #h-split`)})[0].parentElement.querySelector('table'); return { heads: [...t.querySelectorAll('th[scope=col]')].map((h) => h.textContent.trim()), rows: [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent.replace(/\\s+/g, ' ').trim())), hot: [...t.querySelectorAll('.gross-hot')].map((c) => c.parentElement.firstElementChild.textContent.trim()) }; })()`);
    page.assert(split.rows.length === 5 && split.heads.length === 4, `split table 5 rows, 4 columns (${split.rows.length})`);
    page.assert(split.rows[0].map(norm).join("|") === "RU Русский|812|79,10|3,1 %", `RU row (${split.rows[0]})`);
    page.assert(split.rows[4].map(norm).join("|") === "Звонок|214|73,88|6,1 %", `call row (${split.rows[4]})`);
    page.assert(split.hot.length === 1 && split.hot[0] === "Звонок", `only the call gross cell is highlighted (${split.hot})`);

    const att = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> #h-att`)})[0].closest('section').querySelectorAll('tbody tr').length`);
    page.assert(att >= 3, `attention rows (${att})`);
    const chips = await page.eval(`[...cqaDeep(${JSON.stringify(`${OV} >>> #h-att`)})[0].closest('section').querySelectorAll('tbody tr')].map((tr) => tr.children[1].textContent.trim() + '|' + tr.children[2].textContent.replace(/\\s+/g, ' ').trim())`);
    page.assert(chips[0].startsWith("Грубая ошибка|"), `gross row first (${chips[0]})`);
    page.assert(chips.some((c) => c.startsWith("Низкая уверенность модели|") && /\d+,\d{2}/.test(c) && c.includes("Предварительно")), `low-confidence row shows the provisional score (${chips})`);
    page.assert(chips.some((c) => c.startsWith("Апелляция · ")), "appeal row");
    await page.eval(`window.__nav = []; document.addEventListener('cqa:navigate', (e) => window.__nav.push(e.detail));`);
    await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> #h-att`)})[0].closest('section').querySelector('tbody a[data-action=open]').click()`);
    const nav = await page.eval("window.__nav");
    page.assert(nav.some((n) => n.to === "conversations" && n.id), `attention link dispatches cqa:navigate (${JSON.stringify(nav)})`);
    await until(() => page.eval(`location.hash.startsWith('#/conversations/')`));
    await page.eval(`location.hash = '#/overview'`);
    await ready(page);
    await page.click(`${OV} >>> a[data-action=all]`);
    await until(() => page.eval(`location.hash === '#/conversations'`));

    await page.assertAccessibleNames();
  },

  async "overview-layout"(page) {
    await open(page);
    await ready(page);
    const width = await page.eval("window.innerWidth");
    const cols = await page.eval(`getComputedStyle(cqaDeep(${JSON.stringify(`${OV} >>> .kpis`)})[0]).gridTemplateColumns.split(' ').length`);
    const grid = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .grid2`)}).map((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length)`);
    if (width < 1100) {
      page.assert(cols === 3, `KPI grid has 3 columns at ${width} (${cols})`);
      page.assert(grid.every((c) => c === 1), `cards stack at ${width} (${grid})`);
    } else {
      page.assert(cols === 5, `KPI grid has 5 columns at ${width} (${cols})`);
      page.assert(grid.every((c) => c === 2), `cards sit in two columns at ${width} (${grid})`);
    }
    const inner = await page.eval(`(() => { const p = cqaDeep(${JSON.stringify(`${OV} >>> .page`)})[0]; const wraps = [...p.querySelectorAll('.dt-wrap')]; return { page: p.scrollWidth - p.clientWidth, wraps: wraps.map((w) => w.scrollWidth - w.clientWidth) }; })()`);
    page.assert(inner.page <= 0, `overview itself does not overflow (${inner.page})`);
    const heights = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> select.field`)}).map((s) => Math.round(s.getBoundingClientRect().height))`);
    page.assert(heights.every((h) => h >= 30 && h <= 36), `controls 30-36px (${heights})`);
  },

  async "overview-filters"(page) {
    await open(page);
    await ready(page);
    await page.eval(`window.__calls = []; (async () => { const m = await import(new URL('src/api.js', location.href).href); const orig = m.api.getOverview; m.api.getOverview = (f) => { window.__calls.push(f); return orig.call(m.api, f); }; })()`);
    const before = await kpis(page);
    const pressed = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .seg button`)}).map((b) => b.textContent.trim() + ':' + b.getAttribute('aria-pressed'))`);
    page.assert(pressed.join() === "Контрольная группа:true,DEV:false", `dataset toggle (${pressed})`);

    await setSelect(page, "language", "KZ");
    await until(() => page.eval(`window.__calls.length >= 1`));
    await until(async () => norm((await kpis(page))[1].value) === "286");
    let k = await kpis(page);
    page.assert(norm(k[0].value) === "75,84 из 100", `KZ average (${k[0].value})`);
    const rows = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> #h-split`)})[0].parentElement.querySelectorAll('tbody tr').length`);
    page.assert(rows === 3, `split table narrowed by language (${rows})`);
    const calls = await page.eval("window.__calls");
    page.assert(calls[0].language === "KZ" && calls[0].dataset === "control" && calls[0].versionId === 12, `getOverview filter (${JSON.stringify(calls[0])})`);

    await setSelect(page, "language", "");
    await setSelect(page, "channel", "call");
    await until(async () => norm((await kpis(page))[1].value) === "214");
    k = await kpis(page);
    page.assert(norm(k[1].note) === "0 чатов · 214 звонков", `channel filter note (${k[1].note})`);
    await setSelect(page, "channel", "");
    await until(async () => norm((await kpis(page))[1].value) === "1 248");

    await setSelect(page, "period", "last7");
    await until(async () => norm((await kpis(page))[1].value) !== "1 248");
    const last = (await page.eval("window.__calls")).pop();
    page.assert(last.from === "2026-11-01" && last.to === "2026-11-07", `last 7 days range (${last.from}..${last.to})`);
    const distSum = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .chart-val`)}).reduce((s, v) => s + Number(v.textContent.replace(/\\s/g, '')), 0)`);
    page.assert(distSum < 1248 && distSum > 0, `histogram follows the filter (${distSum})`);
    await setSelect(page, "period", "full");

    await page.click(`${OV} >>> .seg button:last-child`);
    await until(() => page.eval(`window.__calls.pop().dataset === 'DEV'`));
    const after = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .seg button`)}).map((b) => b.getAttribute('aria-pressed')).join()`);
    page.assert(after === "false,true", `dataset toggle switched (${after})`);
    page.assert(before.length === 5, "five tiles before filtering");
    await page.assertAccessibleNames();
  },

  async "overview-locale"(page) {
    await open(page);
    await ready(page);
    const app = `document.querySelector('cqa-app')`;
    await page.eval(`${app}.setAttribute('locale', 'en')`);
    await until(async () => norm((await kpis(page))[0].label) === "Average score");
    let k = await kpis(page);
    page.assert(norm(k[0].value) === "78.42 out of 100", `EN average (${k[0].value})`);
    page.assert(norm(k[1].value) === "1,248" && norm(k[2].value) === "3.4%" && norm(k[4].value) === "1.6 days", `EN formats (${k.map((x) => x.value)})`);
    const enText = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .page`)})[0].shadowRoot ? '' : cqaDeep(${JSON.stringify(OV)})[0].shadowRoot.textContent`);
    page.assert(!/overview\.[a-z]/.test(enText), "no raw EN keys");
    page.assert((await page.deepText(`${OV} >>> h1`)) === "Service quality overview", "EN title");
    const enHead = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> h2`)}).map((h) => h.textContent.trim()).join('|')`);
    page.assert(enHead === "Distribution of final scores|Average result by criterion|Language and channel|Needs attention", `EN headings (${enHead})`);
    await page.eval(`${app}.setAttribute('locale', 'kk')`);
    await until(async () => norm((await kpis(page))[0].label) === "Орташа балл");
    k = await kpis(page);
    page.assert(norm(k[0].value) === "78,42 100-ден", `KZ average (${k[0].value})`);
    const kkText = await page.eval(`cqaDeep(${JSON.stringify(OV)})[0].shadowRoot.textContent`);
    page.assert(!/overview\.[a-z]/.test(kkText), "no raw KZ keys");
    page.assert(/[әғқңөұүһі]/.test(kkText), "Kazakh letters rendered");
    const fontOk = await page.eval(`document.fonts.check('14px Inter', 'әғқңөұүһі')`);
    page.assert(fontOk !== undefined, "font check ran");
    await page.eval(`${app}.setAttribute('locale', 'ru')`);
    await until(async () => norm((await kpis(page))[0].label) === "Средний балл");
    await page.assertAccessibleNames();
  },

  async "overview-states"(page) {
    await open(page, "mock=1&state=loading");
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> [aria-busy=true]`)}).length > 0`));
    const busy = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> [role=status][aria-label]`)})[0].getAttribute('aria-label')`);
    page.assert(busy === "Загрузка обзора", `loading status named (${busy})`);
    page.assert((await page.deepCount(`${OV} >>> .kpi`)) === 0, "no tiles while loading");
    page.assert((await page.deepCount(`${OV} >>> .skel`)) >= 5, "skeleton blocks");
    page.assert((await page.deepCount(`${OV} >>> h1`)) === 1, "title and filters stay visible while loading");

    await open(page, "mock=1&state=empty");
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .panel-title`)}).length > 0`));
    page.assert((await page.deepText(`${OV} >>> .panel-title`)) === "Оценённых диалогов нет", "empty title");
    page.assert((await page.deepCount(`${OV} >>> .kpi`)) === 0, "no tiles when empty");
    await page.click(`${OV} >>> [data-action=runs]`);
    await until(() => page.eval(`location.hash === '#/runs'`));

    await open(page, "mock=1&state=error");
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> [role=alert]`)}).length > 0`));
    page.assert((await page.deepText(`${OV} >>> .panel-title`)) === "Не удалось загрузить обзор", "error title");
    page.assert((await page.deepCount(`${OV} >>> [data-action=retry]`)) === 1, "retry button");
    await page.click(`${OV} >>> [data-action=retry]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> [role=alert]`)}).length > 0`));
    await page.assertAccessibleNames();
  },

  async "overview-lowconf"(page) {
    await open(page, "mock=1&state=lowconf");
    await ready(page);
    const rows = await page.eval(`[...cqaDeep(${JSON.stringify(`${OV} >>> #h-att`)})[0].closest('section').querySelectorAll('tbody tr')].map((tr) => ({ reason: tr.children[1].textContent.trim(), score: tr.children[2].textContent.replace(/\\s+/g, ' ').trim(), chip: !!tr.children[2].querySelector('.chip') }))`);
    const prov = rows.filter((r) => r.chip);
    page.assert(prov.length >= 1, `provisional rows carry the chip (${JSON.stringify(rows)})`);
    page.assert(prov.every((r) => /\d+,\d{2}/.test(r.score) && r.score.includes("Предварительно - низкая уверенность")), `provisional score is shown with the chip (${JSON.stringify(prov)})`);
    page.assert(rows.every((r) => r.score !== "—"), "no dash for provisional rows");
    page.assert(rows.some((r) => r.reason === "Низкий балл"), `low score row (${JSON.stringify(rows.map((r) => r.reason))})`);
    const note = await page.eval(`cqaDeep(${JSON.stringify(`${OV} >>> .block-note`)}).map((n) => n.textContent).join('|')`);
    page.assert(note.includes("Предварительно - низкая уверенность"), "provisional note under the list");
    await page.assertAccessibleNames();
  },

  async "overview-keys"(page) {
    await open(page);
    await ready(page);
    await page.eval(`document.activeElement && document.activeElement.blur(); cqaDeep(${JSON.stringify(`${OV} >>> h1`)})[0].setAttribute('tabindex', '-1'); cqaDeep(${JSON.stringify(`${OV} >>> h1`)})[0].focus()`);
    const order = [];
    for (let i = 0; i < 9; i += 1) {
      await page.press("Tab");
      const a = await page.active();
      order.push(a ? `${a.tag}:${a.focusId || a.text}` : "none");
      page.assert(a && a.outline.startsWith("solid"), `focus ring on ${order[i]} (${a && a.outline})`);
    }
    page.assert(order.slice(0, 6).join() === "button:Контрольная группа,button:DEV,select:f-version,select:f-period,select:f-language,select:f-channel", `filter tab order (${order})`);
    page.assert(order[6].startsWith("a:") && order[7].startsWith("a:"), `then data links (${order.slice(6)})`);
    await page.eval(`window.__nav = []; document.addEventListener('cqa:navigate', (e) => window.__nav.push(e.detail));`);
    await page.press("Enter");
    await until(() => page.eval(`window.__nav.length > 0`));
    const nav = await page.eval("window.__nav");
    page.assert(nav[0].to === "conversations", `Enter on a link navigates (${JSON.stringify(nav)})`);
    await page.assertAccessibleNames();
  }
};
