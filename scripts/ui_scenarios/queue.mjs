const Q = "cqa-app >>> cqa-appeal-queue >>> ";
const j = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, expression, label, timeout = 15000) {
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

async function open(page, query, hash, ready = "[data-appeal-row]") {
  await page.eval(`window.__qStale = true`);
  await page.eval(`(() => { const u = new URL(location.href); u.search = ${j(query)} + '&_=' + Date.now(); u.hash = ${j(hash)}; location.href = u.href; })()`);
  await until(page, `window.__qStale === undefined`, "navigation");
  await until(page, `document.readyState === 'complete' && !!document.querySelector('cqa-app')`, "document");
  if (ready) await until(page, `cqaDeep(${j(Q + ready)}).length > 0`, `ready ${ready}`);
}

const all = (page, sel) => page.eval(`cqaDeep(${j(Q + sel)}).map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
const one = async (page, sel) => (await all(page, sel))[0] ?? null;
const count = (page, sel) => page.eval(`cqaDeep(${j(Q + sel)}).length`);
const norm = (value) => String(value ?? "").replace(/[  ]/g, " ");
const tabs = async (page) => (await all(page, "[data-count]")).map(Number);
const sums = (page) => page.eval(`cqaDeep(${j(Q + "[data-sum] b")}).map((e) => Number(e.textContent.replace(/\\D/g, '')))`);
const badge = (page) => page.eval(`(cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> [data-count]')[0]?.textContent || '').trim()`);
const setLocale = async (page, locale) => {
  await page.eval(`document.querySelector('cqa-app').setAttribute('locale', ${j(locale)})`);
  await sleep(300);
};
const selectedRow = (page) => page.eval(`cqaDeep(${j(Q + "[data-appeal-row][aria-pressed=true]")})[0]?.getAttribute('data-appeal-row') ?? null`);
const click = (page, sel) => page.eval(`cqaDeep(${j(Q + sel)})[0].click()`);

async function pick(page, id, form = true) {
  await click(page, `[data-appeal-row="${id}"]`);
  await sleep(250);
  if (form) await until(page, `cqaDeep(${j(Q + "[data-review], [data-readonly], [data-closed]")}).length > 0`, "detail ready");
}

export const scenarios = {
  async "queue-layout"(page) {
    await open(page, "?mock=1&role=reviewer", "#/appeals");
    await sleep(400);
    page.assert((await count(page, "h1")) === 1 && (await one(page, "h1")) === "Очередь апелляций", "one h1 Очередь апелляций");
    page.assert(JSON.stringify(await tabs(page)) === "[5,2,1,2]", `tab counts 5/2/1/2 (${await tabs(page)})`);
    const labels = (await all(page, ".seg button")).map((t) => t.replace(/\s*\d+$/, ""));
    page.assert(JSON.stringify(labels) === JSON.stringify(["Все", "Новые", "На рассмотрении", "Решённые"]), `tab labels (${labels})`);
    page.assert((await one(page, ".sort")) === "Сортировка: старые сверху", "sort caption");
    page.assert((await count(page, '[role=table][aria-label="Апелляции"]')) === 1, "labelled table");
    page.assert((await count(page, "[role=table] > [role=row]")) === 6, "header row plus five rows");
    page.assert((await count(page, "[role=columnheader]")) === 5, "five column headers");
    page.assert((await count(page, "button[role=row][aria-pressed]")) === 5, "rows are button role=row with aria-pressed");
    page.assert((await count(page, 'button[role=row][aria-label*="p1-kz-007"]')) === 1, "rows are labelled");
    const ids = await page.eval(`cqaDeep(${j(Q + "[data-appeal-row]")}).map((e) => e.getAttribute('data-appeal-row')).join(',')`);
    const order = await page.eval(`(async () => { const m = await import(new URL('src/api.js', location.href).href); const l = await m.api.listAppeals({status:'all'}); return l.slice().sort((a,b) => b.ageHours - a.ageHours).map((a) => a.id).join(','); })()`);
    page.assert(ids === order, `oldest first (${ids} vs ${order})`);
    const warn = await page.eval(`cqaDeep(${j(Q + "[data-age].warn")}).map((e) => e.closest('[data-appeal-row]').getAttribute('data-appeal-row')).join(',')`);
    page.assert(warn === "3", `only the open appeal older than 72h is warn (${warn})`);
    page.assert((await selectedRow(page)) === "3", "oldest preselected");
    const s = await sums(page);
    const badgeNow = Number(await badge(page));
    page.assert(JSON.stringify(s) === "[3,2,1,1]", `summary open/new/review/aging (${s})`);
    page.assert(s[0] === badgeNow, `summary open equals nav badge (${s[0]} vs ${badgeNow})`);
    const detail = norm(await one(page, "[data-detail]"));
    page.assert(/02 Выявление потребности/.test(detail) && /Исходная оценка/.test(detail) && /Довод заявителя/.test(detail) && /Фрагмент переписки/.test(detail) && /в исходном языке/.test(detail), `detail sections (${detail.slice(0, 160)})`);
    page.assert(/Чек-лист v\d/.test(await one(page, "[data-version]")) && /Модель:/.test(await one(page, "[data-version]")), "version line");
    page.assert((await count(page, "[data-rv-fragment] .lang")) === 1, "fragment language chip");
    page.assert((await count(page, "[data-open-card]")) === 1, "open card link");
    page.assert((await count(page, "[data-detail] .rv-line")) === 3, "three fragment lines");
    await page.assertAccessibleNames();
    const wide = await page.eval(`(() => { const e = cqaDeep(${j(Q + ".grid")})[0]; return e.scrollWidth <= e.clientWidth + 1; })()`);
    page.assert(wide, "grid does not overflow");
  },

  async "queue-tabs"(page) {
    await open(page, "?mock=1&role=reviewer", "#/appeals");
    const rowsOf = () => page.eval(`cqaDeep(${j(Q + "[data-appeal-row]")}).map((e) => e.getAttribute('data-appeal-row')).join(',')`);
    await click(page, '[data-tab="new"]');
    await sleep(150);
    page.assert((await rowsOf()) === "3,2", `new tab rows (${await rowsOf()})`);
    page.assert((await page.eval(`cqaDeep(${j(Q + '[data-tab="new"]')})[0].getAttribute('aria-pressed')`)) === "true", "tab pressed");
    await click(page, '[data-tab="under_review"]');
    await sleep(150);
    page.assert((await rowsOf()) === "1", "review tab rows");
    await click(page, '[data-tab="closed"]');
    await sleep(150);
    const closed = await rowsOf();
    page.assert(closed.split(",").sort().join(",") === "4,5", `closed tab rows (${closed})`);
    page.assert((await count(page, ".age.warn")) === 0, "closed rows are never warn");
    await click(page, '[data-appeal-row="4"]');
    await sleep(250);
    const text = norm(await one(page, "[data-closed]"));
    page.assert(/Исходно/.test(text) && /Решение/.test(text) && /Итог/.test(text), `closed summary (${text})`);
    page.assert(/15 → 20/.test(await one(page, "[data-decision]")), `scale decision text (${await one(page, "[data-decision]")})`);
    page.assert(/QA \/ Проверяющий/.test(await one(page, "[data-reason]")), "decider is the combined role");
    page.assert((await count(page, "[data-review]")) === 0, "no decision form for a resolved appeal");
    await click(page, '[data-appeal-row="5"]');
    await sleep(250);
    page.assert((await one(page, "[data-decision]")) === "Оценка подтверждена", "confirmed text");
    page.assert((await one(page, "[data-before]")) === (await one(page, "[data-after]")), "confirmed total unchanged");
  },

  async "queue-keyboard"(page) {
    await open(page, "?mock=1&role=reviewer", "#/appeals");
    const order = (await page.eval(`cqaDeep(${j(Q + "[data-appeal-row]")}).map((e) => e.getAttribute('data-appeal-row'))`)).map(Number);
    const newPos = order.indexOf(2);
    await page.eval(`cqaDeep(${j(Q + "[data-appeal-row]")})[0].focus()`);
    const focused = () => page.eval(`cqaActive()?.getAttribute('data-focus-id')`);
    page.assert((await focused()) === `row-${order[0]}`, `first row focused (${await focused()})`);
    await page.press("j");
    page.assert((await focused()) === `row-${order[1]}`, `j moves down (${await focused()})`);
    await page.press("j");
    await page.press("k");
    page.assert((await focused()) === `row-${order[1]}`, `k moves up (${await focused()})`);
    await page.press("k");
    await page.press("k");
    page.assert((await focused()) === `row-${order[0]}`, "k stops at the first row");
    for (let i = 0; i < newPos; i += 1) await page.press("j");
    page.assert((await focused()) === "row-2", `reached the new appeal (${await focused()})`);
    await page.press("Enter");
    await sleep(400);
    page.assert((await selectedRow(page)) === "2", `Enter opens the focused row (${await selectedRow(page)})`);
    page.assert((await focused()) === "row-2", `focus stays on the row after open (${await focused()})`);
    page.assert(/На рассмотрении/.test(norm(await one(page, "[data-detail] .d-head"))), "opening a new appeal starts the review");
    page.assert(JSON.stringify(await tabs(page)) === "[5,1,2,2]", `counts after start (${await tabs(page)})`);
    const s = await sums(page);
    page.assert(JSON.stringify(s) === "[3,1,2,1]", `summary after start (${s})`);
    page.assert(s[0] === Number(await badge(page)), "badge equals summary open");
  },

  async "queue-decide"(page) {
    await open(page, "?mock=1&role=reviewer", "#/appeals");
    await pick(page, 3);
    page.assert((await selectedRow(page)) === "3", "selected");
    page.assert(JSON.stringify(await tabs(page)) === "[5,1,2,2]", `selecting started the review (${await tabs(page)})`);
    page.assert((await count(page, '[data-action="review-start"]')) === 0, "no start button once started");
    const saveDisabled = () => page.eval(`cqaDeep(${j(Q + '[data-action="review-save"]')})[0].disabled`);
    page.assert(await saveDisabled(), "save disabled without a reason");
    page.assert((await count(page, 'textarea[aria-required="true"]')) === 1, "reason is aria-required");
    const prev = norm(await one(page, "[data-rv-preview]"));
    page.assert(/^52,63 → 68,42$/.test(prev), `preview before/after (${prev})`);
    await page.eval(`(() => { const s = cqaDeep(${j(Q + '[data-rv=answer]')})[0]; s.value = 'na'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(150);
    page.assert(/^52,63 → 62,50$/.test(norm(await one(page, "[data-rv-preview]"))), `N/A preview (${await one(page, "[data-rv-preview]")})`);
    await page.eval(`(() => { const s = cqaDeep(${j(Q + '[data-rv=answer]')})[0]; s.value = 'yes'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(150);
    await page.eval(`cqaDeep(${j(Q + '[data-rv=reason]')})[0].focus()`);
    await page.type("Вопрос задан в 00:37, оценка изменена.");
    page.assert(!(await saveDisabled()), "save enabled with a reason");
    const open0 = Number(await badge(page));
    await click(page, '[data-action="review-save"]');
    await until(page, `cqaDeep(${j(Q + "[data-closed]")}).length > 0`, "closed summary");
    await sleep(300);
    page.assert(JSON.stringify(await tabs(page)) === "[5,1,1,3]", `counts after decision (${await tabs(page)})`);
    page.assert(norm(await one(page, "[data-decision]")) === "Нет → Да", `decision text (${await one(page, "[data-decision]")})`);
    page.assert(norm(await one(page, "[data-before]")) === "52,63" && norm(await one(page, "[data-after]")) === "68,42", "before and after totals");
    page.assert(/QA \/ Проверяющий/.test(await one(page, "[data-reason]")) && /Вопрос задан/.test(await one(page, "[data-reason]")), "closed reason line");
    page.assert(/Изменено/.test(await one(page, "[data-detail] .d-head")), "status Изменено");
    await until(page, `(cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> [data-count]')[0]?.textContent || '').trim() === ${j(String(open0 - 1))}`, "badge decremented");
    const toast = await page.eval(`cqaDeep('cqa-app >>> cqa-toast >>> .toast').map((e) => e.textContent.replace(/\\s+/g, ' ')).join(' | ')`);
    page.assert(/Решение сохранено/.test(toast), `toast (${toast})`);
    const s = await sums(page);
    page.assert(s[0] === Number(await badge(page)) && s[0] === 2, `summary equals badge (${s})`);
    await click(page, '[data-tab="closed"]');
    await sleep(150);
    page.assert((await count(page, "[data-appeal-row]")) === 3, "row moved to Решённые");
  },

  async "queue-confirm"(page) {
    await open(page, "?mock=1&role=reviewer", "#/appeals/1");
    await until(page, `cqaDeep(${j(Q + "[data-review]")}).length > 0`, "decision form");
    page.assert((await selectedRow(page)) === "1", "deep link selects");
    await page.eval(`(() => { const r = cqaDeep(${j(Q + '[data-rv=decision][value=confirm]')})[0]; r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(150);
    page.assert((await count(page, "[data-rv=answer]")) === 0, "no new-answer select on confirm");
    page.assert(/^81,88 → 81,88$/.test(norm(await one(page, "[data-rv-preview]"))), `confirm preview (${await one(page, "[data-rv-preview]")})`);
    await page.eval(`cqaDeep(${j(Q + '[data-rv=reason]')})[0].focus()`);
    await page.type("Нарушение подтверждено.");
    await click(page, '[data-action="review-save"]');
    await until(page, `cqaDeep(${j(Q + "[data-closed]")}).length > 0`, "closed");
    page.assert((await one(page, "[data-decision]")) === "Оценка подтверждена", "confirmed");
    page.assert(/Подтверждено/.test(await one(page, "[data-detail] .d-head")), "status Подтверждено");
  },

  async "queue-roles"(page) {
    for (const role of ["operator", "exec"]) {
      await open(page, `?mock=1&role=${role}`, "#/appeals");
      page.assert((await count(page, "[data-appeal-row]")) === 5, `${role} reads the queue`);
      await pick(page, 2);
      page.assert((await count(page, "[data-review]")) === 0 && (await count(page, '[data-action="review-save"]')) === 0, `${role} has no decision form`);
      page.assert((await count(page, '[data-action="review-start"]')) === 0, `${role} has no start button`);
      page.assert((await count(page, "[data-readonly]")) === 1, `${role} sees the read-only note`);
      page.assert(JSON.stringify(await tabs(page)) === "[5,2,1,2]", `${role} selecting does not start review (${await tabs(page)})`);
    }
    await open(page, "?mock=1&role=reviewer", "#/appeals");
    await pick(page, 2);
    page.assert((await count(page, "[data-readonly]")) === 0 && (await count(page, "[data-review]")) === 1, "reviewer has the form");
    const inputs = await page.eval(`cqaDeep(${j(Q + 'input[type=text], input[name*=name i]')}).length`);
    page.assert(inputs === 0, "no name inputs");
  },

  async "queue-deeplink"(page) {
    await open(page, "?mock=1&role=reviewer", "#/appeals/2");
    await sleep(300);
    page.assert((await selectedRow(page)) === "2", `#/appeals/2 preselects (${await selectedRow(page)})`);
    page.assert(JSON.stringify(await tabs(page)) === "[5,2,1,2]", "deep link does not start the review");
    page.assert((await count(page, '[data-action="review-start"]')) === 1, "start button offered for the new appeal");
    page.assert(/p3-ru-call-014/.test(await one(page, "[data-open-card]")), "open card link names the conversation");
    await open(page, "?mock=1&role=reviewer", "#/appeals/a3");
    page.assert((await selectedRow(page)) === "3", "a3 form accepted");
    await open(page, "?mock=1&role=reviewer", "#/appeals/5");
    await sleep(300);
    page.assert((await selectedRow(page)) === "5" && (await count(page, "[data-closed]")) === 1, "closed appeal by deep link");
    await click(page, '[data-action="review-start"]').catch(() => {});
  },

  async "queue-states"(page) {
    await open(page, "?mock=1&role=reviewer&state=empty", "#/appeals", "[data-queue-empty]");
    page.assert((await one(page, "[data-queue-empty]")) === "В этом статусе апелляций нет.", "empty text");
    page.assert(JSON.stringify(await tabs(page)) === "[0,0,0,0]", "zero counts");
    await click(page, '[data-tab="new"]');
    await sleep(150);
    page.assert((await one(page, "[data-queue-empty]")) === "В этом статусе апелляций нет.", "empty tab text");
    page.assert((await count(page, "[data-detail]")) === 1, "detail pane stays with a hint");
    await open(page, "?mock=1&role=reviewer&state=error", "#/appeals", '[role=alert]');
    page.assert((await count(page, '[data-action="retry"]')) === 1, "retry offered on error");
    page.assert(/Очередь не загрузилась/.test(await one(page, '[role=alert]')), "error title");
    page.allowConsole(/./);
    await open(page, "?mock=1&role=reviewer&state=slow", "#/appeals", '[aria-busy="true"]');
    page.assert((await count(page, '[role=status][aria-busy="true"]')) >= 1, "loading panel announces busy");
    await until(page, `cqaDeep(${j(Q + "[data-appeal-row]")}).length > 0`, "rows after slow");
  },

  async "queue-locales"(page) {
    await open(page, "?mock=1&role=reviewer", "#/appeals");
    await until(page, `cqaDeep(${j(Q + "[data-review]")}).length > 0`, "form");
    await setLocale(page, "en");
    page.assert((await one(page, "h1")) === "Appeal queue", "EN title");
    const en = (await all(page, ".seg button")).join("|");
    page.assert(/All 5\|New 2\|Under review 1\|Resolved 2/.test(en), `EN tabs (${en})`);
    page.assert((await one(page, ".sort")) === "Sorted: oldest first", "EN sort");
    page.assert(/Original score/.test(norm(await one(page, "[data-detail]"))) && /Save decision/.test(norm(await one(page, "[data-detail]"))), "EN detail");
    page.assert(/ 4 d$/.test(await one(page, '[data-appeal-row="3"] [data-age]') ? " " + (await one(page, '[data-appeal-row="3"] [data-age]')) : ""), "EN age 4 d");
    await setLocale(page, "kk");
    page.assert((await one(page, "h1")) === "Апелляциялар кезегі", "KZ title");
    page.assert(/Шешілген/.test((await all(page, ".seg button")).join("|")), "KZ tabs");
    page.assert(/Бастапқы баға/.test(norm(await one(page, "[data-detail]"))), "KZ detail");
    page.assert(/Бастапқы баға/.test(norm(await one(page, "[data-detail]"))) && !/queue\.|review\./.test(norm(await one(page, "[data-detail]"))), "no raw keys in KZ");
    await setLocale(page, "ru");
    page.assert(!/queue\./.test(norm(await one(page, ".screen"))), "no raw keys in RU");
  },

  async "queue-shot"(page) {
    await open(page, "?mock=1&role=reviewer", "#/appeals/3");
    await sleep(500);
  },

  async "queue-shot-closed"(page) {
    await open(page, "?mock=1&role=exec", "#/appeals/4");
    await sleep(500);
  }
};
