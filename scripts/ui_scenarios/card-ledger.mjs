const CARD = "cqa-app >>> cqa-conversation-card >>> ";
const ROUTE = "#/conversations/p1-ru-001";

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
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function open(page, query, hash = ROUTE) {
  await page.eval(`window.__cardStale = true`);
  await page.eval(`(() => { const u = new URL(location.href); u.search = ${JSON.stringify(query)} + '&_=' + Date.now(); u.hash = ${JSON.stringify(hash)}; location.href = u.href; })()`);
  await until(page, `window.__cardStale === undefined`, "navigation");
  await until(page, `document.readyState === 'complete' && !!document.querySelector('cqa-app')`, "document");
}

const q = (selector) => JSON.stringify(CARD + selector);
const text = (page, selector) => page.eval(`(cqaDeep(${q(selector)})[0]?.textContent || '').replace(/\\s+/g, ' ').replace(/[\\u00a0\\u202f]/g, ' ').trim()`);
const count = (page, selector) => page.eval(`cqaDeep(${q(selector)}).length`);
const attr = (page, selector, name) => page.eval(`cqaDeep(${q(selector)})[0]?.getAttribute(${JSON.stringify(name)})`);

async function ready(page) {
  await until(page, `!!cqaDeep(${q("[data-total]")})[0] && !!cqaDeep(${q("[data-ledger]")})[0]`, "card with ledger");
}

async function setLocale(page, locale) {
  await page.eval(`document.querySelector('cqa-app').setAttribute('locale', ${JSON.stringify(locale)})`);
  await new Promise((r) => setTimeout(r, 300));
}

async function overflow(page, label) {
  const wide = await page.eval(`cqaAll().filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed').length`);
  page.assert(wide === 0, `${label}: no element extends past the viewport (${wide})`);
}

export const scenarios = {
  async "card-ledger"(page) {
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    page.assert((await attr(page, '[data-ledger] [role="table"]', "aria-label")) === "Расчёт итогового балла", "ledger is a labelled role=table");
    page.assert((await count(page, '[data-ledger] [role="columnheader"]')) === 5, "five column headers");
    const heads = await page.eval(`cqaDeep(${q('[data-ledger] [role="columnheader"]')}).map((e) => e.textContent.trim()).join('|')`);
    page.assert(heads === "Критерий|Ответ|Ном. вес|Эфф. вес|Баллы", `column headers (${heads})`);
    page.assert((await count(page, "[data-ledger-row]")) === 7, "seven criterion rows");
    page.assert((await count(page, ".lrow-sec")) === 3, "three section header rows");
    page.assert((await count(page, "[data-ledger-subtotal]")) === 3, "three subtotal rows");
    page.assert((await count(page, ".lrow-na")) === 1, "one striped N/A row");
    page.assert(/исключён · вес перераспределён на применимые критерии/.test(await text(page, ".lrow-na")), "N/A row explains redistribution");
    page.assert((await text(page, "[data-ledger-total]")) === "81,88", `ledger total (${await text(page, "[data-ledger-total]")})`);
    page.assert((await text(page, "[data-total]")) === "81,88", "score panel total");
    page.assert((await text(page, "[data-ledger-footer]")) === "Применимый вес: 80 из 100 · коэффициент перераспределения 100 / 80 = 1,25", `footer (${await text(page, "[data-ledger-footer]")})`);
    page.assert((await attr(page, "[data-ledger]", "data-reconciled")) === "true", "ledger reconciles");
    page.assert((await attr(page, ".ledger-toggle", "aria-expanded")) === "true", "ledger expanded by default");
    await page.assertAccessibleNames();

    await page.eval(`cqaDeep(${q(".ledger-toggle")})[0].focus()`);
    await page.click(CARD + ".ledger-toggle");
    await until(page, `cqaDeep(${q(".ledger-toggle")})[0]?.getAttribute('aria-expanded') === 'false'`, "collapsed");
    page.assert((await count(page, '[data-ledger] [role="table"]')) === 0, "collapsed ledger hides the table");
    const focused = await page.eval(`cqaDeep('cqa-app >>> cqa-conversation-card')[0].shadowRoot.activeElement?.getAttribute('data-focus-id')`);
    page.assert(focused === "ledger-toggle", `focus stays on the toggle (${focused})`);
    await page.click(CARD + ".ledger-toggle");
    await until(page, `!!cqaDeep(${q('[data-ledger] [role="table"]')})[0]`, "expanded again");
    await overflow(page, "ledger");
  },

  async "card-ledger-appeal"(page) {
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    page.assert((await count(page, "[data-history]")) === 2, "history: model + open appeal");
    const first = await text(page, '[data-history="model"]');
    page.assert(/Оценка модели\s*Исходная/.test(first) && /чек-лист v2/.test(first) && /Итог 81,88 из 100/.test(first), `model entry (${first})`);
    page.assert(/Апелляция · 07 Завершение/.test(await text(page, '[data-history="appeal"]')), "appeal entry");
    page.assert(/Есть открытая апелляция по критерию 07/.test(await text(page, "[data-role-hint]")), "reviewer hint names the open appeal");
    await page.eval(`(async () => {
      const mod = await import(new URL('./src/api.js', location.href).href);
      await mod.api.decideAppeal(1, { decision: 'change', newAnswer: 'yes', reason: 'Клиент сам завершил диалог.' });
      cqaDeep('cqa-app >>> cqa-conversation-card')[0].load();
    })()`);
    await until(page, `cqaDeep(${q("[data-ledger-total]")})[0]?.textContent.trim() === '88,13'`, "ledger total after decision");
    page.assert((await text(page, "[data-total]")).startsWith("88,13"), "score panel total after decision");
    page.assert((await attr(page, "[data-ledger]", "data-reconciled")) === "true", "still reconciles");
    page.assert((await count(page, ".lrow-na")) === 1, "N/A row remains");
    page.assert(/Применимый вес: 80 из 100/.test(await text(page, "[data-ledger-footer]")), `factor after override (${await text(page, "[data-ledger-footer]")})`);
    const decision = await text(page, '[data-history="changed"]');
    page.assert(/Решение: оценка изменена/.test(decision) && /Ответ: Нет → Да\./.test(decision) && /Итог: 81,88 → 88,13\./.test(decision), `decision entry (${decision})`);
    page.assert(/QA \/ Проверяющий/.test(decision), "decider shown by role label");
    page.assert(!/руководителя группы/.test(await text(page, "[data-score]")), "no group-lead clause");
    await overflow(page, "history");
  },

  async "card-ledger-hint"(page) {
    await open(page, "?mock=1&role=operator");
    await ready(page);
    page.assert((await count(page, '[data-action="reevaluate"]')) === 0, "operator has no re-evaluate");
    page.assert(/Это ваша оценка/.test(await text(page, "[data-role-hint]")), "operator hint");
    await open(page, "?mock=1&role=exec");
    await ready(page);
    page.assert((await count(page, '[data-action="reevaluate"], [data-action="appeal"]')) === 0, "exec has no action buttons");
  },

  async "card-ledger-lowconf"(page) {
    await open(page, "?mock=1&state=lowconf&role=reviewer");
    await ready(page);
    page.assert(/\d/.test(await text(page, "[data-total]")), "provisional number shown");
    page.assert(/Предварительно - низкая уверенность/.test(await text(page, ".total-row")), "provisional chip text");
    page.assert(/Итог предварительный - требуется проверка ОКК/.test(await text(page, "[data-provisional-note]")), "provisional note");
    page.assert((await text(page, "[data-ledger-total]")) === (await text(page, "[data-total]")), "ledger reconciles to the provisional number");
    page.assert(/ожидает проверки/.test(await text(page, '[data-ledger-row="04"]')), "review row marked in the ledger");
    page.assert((await count(page, "[data-ledger-provisional]")) === 1, "ledger provisional note");
    await overflow(page, "lowconf");
  },

  async "card-ledger-states"(page) {
    await open(page, "?mock=1&state=loading&role=reviewer");
    await until(page, `!!cqaDeep(${q("[data-card-loading]")})[0]`, "skeleton");
    page.assert((await attr(page, "[data-card-loading]", "aria-busy")) === "true", "skeleton is aria-busy");
    page.assert((await count(page, "[data-total]")) === 0, "no score while loading");
    await overflow(page, "loading");
    await open(page, "?mock=1&state=error&role=reviewer");
    await until(page, `!!cqaDeep(${q('[role="alert"]')})[0]`, "error");
    page.assert((await count(page, '[data-action="retry"]')) === 1, "retry button");
    page.assert((await count(page, "[data-ledger]")) === 0, "no ledger on error");
  },

  async "card-ledger-locale"(page) {
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    await setLocale(page, "kk");
    page.assert(/Қорытынды қалай есептелді/.test(await text(page, ".ledger-toggle")), "KZ ledger title");
    page.assert(/Бағалау және апелляциялар тарихы/.test(await text(page, "[data-history-section]")), "KZ history title");
    await overflow(page, "kk");
    await setLocale(page, "en");
    page.assert(/How the total is calculated/.test(await text(page, ".ledger-toggle")), "EN ledger title");
    page.assert((await text(page, "[data-ledger-total]")) === "81.88", `EN decimal (${await text(page, "[data-ledger-total]")})`);
    page.assert(/Applicable weight: 80 of 100 · redistribution factor 100 \/ 80 = 1\.25/.test(await text(page, "[data-ledger-footer]")), "EN footer");
    await overflow(page, "en");
    await page.assertAccessibleNames();
  },

  async "card-ledger-shot"(page) {
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    await page.eval(`cqaDeep(${q("[data-ledger]")})[0].scrollIntoView({ block: 'start' })`);
    await new Promise((r) => setTimeout(r, 300));
  }
};
