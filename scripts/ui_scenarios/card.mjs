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

async function ready(page) {
  try {
    await until(page, `!!cqaDeep(${JSON.stringify(CARD + "[data-total]")})[0]`, "card total");
  } catch (error) {
    const info = await page.eval(`(() => { const c = cqaDeep('cqa-app >>> cqa-conversation-card')[0]; return c ? c._phase + ' ' + location.href + ' ' + (c.shadowRoot.textContent || '').slice(0, 120) : 'no card ' + location.href + ' ' + document.readyState; })()`);
    throw new Error(`${error.message}: ${info}`);
  }
}

const q = (selector) => JSON.stringify(CARD + selector);
const text = (page, selector) => page.eval(`(cqaDeep(${q(selector)})[0]?.textContent || '').replace(/\\s+/g, ' ').trim()`);
const count = (page, selector) => page.eval(`cqaDeep(${q(selector)}).length`);
const hasClass = (page, selector, cls) => page.eval(`cqaDeep(${q(selector)})[0]?.classList.contains(${JSON.stringify(cls)})`);
const norm = (value) => String(value).replace(/[  ]/g, " ");

async function setLocale(page, locale) {
  await page.eval(`document.querySelector('cqa-app').setAttribute('locale', ${JSON.stringify(locale)})`);
  await new Promise((r) => setTimeout(r, 250));
}

async function hover(page, id) {
  await page.eval(`(() => { const row = cqaDeep(${q(`[data-crit-row="${id}"] .crit-name`)})[0]; row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true })); })()`);
}

async function focusList(page) {
  await page.eval(`cqaDeep(${q("[data-crit-list]")})[0].focus()`);
}

async function selected(page) {
  return page.eval(`cqaDeep(${q("[data-crit-row] .crit-pick[aria-pressed=true]")}).map((b) => b.getAttribute('data-crit')).join()`);
}

export const scenarios = {
  async "card-shot"(page) {
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    await page.click(CARD + '[data-crit-row="04"] .crit-pick');
    await page.eval(`window.scrollTo(0, 0)`);
    await new Promise((r) => setTimeout(r, 300));
  },

  async "card-chat"(page) {
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    page.assert(norm(await text(page, "[data-total]")) === "81,88", `total 81,88 (${await text(page, "[data-total]")})`);
    page.assert((await text(page, ".out-of")) === "из 100", "out of 100");
    page.assert((await count(page, "li[data-index]")) === 15, "15 transcript events");
    page.assert((await text(page, ".t-head .tnum")) === "15 событий · 05:05", `events and duration (${await text(page, ".t-head .tnum")})`);
    const chipText = await text(page, "[data-version-chip]");
    page.assert(/Чек-лист качества чатов · v2/.test(chipText), `checklist version chip (${chipText})`);
    page.assert(/Модель: LLM-оценщик v3 · 07\.11\.2026 09:42/.test(await text(page, ".score-meta")), `model and time (${await text(page, ".score-meta")})`);
    page.assert(/Уверенность: высокая · 8 из 8/.test(await text(page, "[data-confidence]")), `confidence (${await text(page, "[data-confidence]")})`);
    page.assert((await count(page, "[data-tiles] .tile")) === 3, "three section tiles");
    const tiles = await page.eval(`cqaDeep(${q("[data-tiles] .tile")}).map((t) => t.textContent.replace(/\\s+/g, ' ').trim())`);
    page.assert(tiles.every((t) => /\d+,\d\d \/ \d+,\d\d/.test(t)), `tile points over effective max (${tiles.join(" | ")})`);
    page.assert((await page.eval(`cqaDeep(${q("[data-tiles] .tile-fill")}).every((f) => parseFloat(f.style.width) > 0)`)), "tile bars have width");
    const gross = await text(page, "[data-gross]");
    page.assert(/08 Грубые ошибки/.test(gross) && /не обнаружены/.test(gross), `gross strip (${gross})`);
    page.assert(!/руководител/i.test(gross), "gross strip has no escalation clause");
    page.assert(/Оператор: Оператор A/.test(await text(page, "[data-strip]")), "constant operator label");
    page.assert(/Набор:/.test(await text(page, "[data-strip]")), "dataset label");
    page.assert(/Есть открытая апелляция по критерию 07/.test(await text(page, "[data-role-hint]")), "reviewer role hint names the open appeal");

    await hover(page, "04");
    page.assert(await hasClass(page, '[data-index="10"] [data-bubble]', "msg-evidence"), "hover 04 highlights message 11");
    page.assert(await hasClass(page, '[data-index="11"] [data-bubble]', "msg-evidence"), "hover 04 highlights message 12");
    page.assert(!(await hasClass(page, '[data-index="5"] [data-bubble]', "msg-evidence")), "hover 04 leaves message 6 alone");
    await page.eval(`cqaDeep(${q(".strip")})[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }))`);
    page.assert(!(await hasClass(page, '[data-index="10"] [data-bubble]', "msg-evidence")), "leaving the criterion clears the hover highlight");

    await page.click(CARD + '[data-index="10"] .ts');
    const cites = await page.eval(`cqaDeep(${q("[data-cites-chip]:not([hidden])")}).map((c) => c.closest('[data-crit-row]').getAttribute('data-crit-row') + ':' + c.textContent.trim()).join()`);
    page.assert(cites === "04:цитирует #11,05:цитирует #11,06:цитирует #11", `message 11 marks citing criteria (${cites})`);
    page.assert((await page.eval(`cqaDeep(${q('[data-index="10"] .ts')})[0].getAttribute('aria-pressed')`)) === "true", "selected message is aria-pressed");

    await page.click(CARD + '[data-index="6"] .cite[data-crit="02"]');
    page.assert((await selected(page)) === "02", "cite button selects criterion 02");
    page.assert(await hasClass(page, '[data-index="6"] [data-bubble]', "msg-evidence"), "message 7 evidence for 02");

    await page.click(CARD + '[data-index="10"] .cite[data-crit="04"]');
    page.assert((await selected(page)) === "04", "К04 cite selects criterion 04");

    await page.click(CARD + '[data-crit-row="07"] .crit-pick');
    page.assert((await selected(page)) === "07", "07 selected");
    page.assert(await hasClass(page, '[data-index="12"] [data-bubble]', "msg-expected"), "message 13 expected");
    page.assert(await hasClass(page, '[data-index="13"] [data-bubble]', "msg-expected"), "message 14 expected");
    page.assert(!(await hasClass(page, '[data-index="14"] [data-bubble]', "msg-expected")), "message 15 not expected");
    const visibleLabels = await page.eval(`cqaDeep(${q("[data-exp-label]:not([hidden])")}).map((l) => l.closest('li').getAttribute('data-index') + ':' + l.textContent.trim()).join()`);
    page.assert(visibleLabels === "12:Ожидалось здесь · 07 Завершение", `first expected message carries the label (${visibleLabels})`);
    const chipExpected = await text(page, '[data-crit-row="07"] .ev-expected');
    page.assert(chipExpected === "Ожидалось здесь · 04:51–04:58", `expected chip (${chipExpected})`);
    await page.click(CARD + '[data-crit-row="07"] .ev-expected');
    page.assert(await page.eval(`(() => { const li = cqaDeep(${q('li[data-index="12"]')})[0]; const r = li.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })()`), "expected chip jumps to the range");

    const na = await text(page, '[data-crit-row="03"] .na-box');
    page.assert(/^Условие N\/A выполнено: Запрос не требовал идентификации/.test(na), `N/A condition text (${na})`);
    page.assert((await text(page, '[data-crit-row="03"] .crit-pts')).startsWith("—"), "N/A points are a dash");
    page.assert((await text(page, '[data-crit-row="03"] .crit-weight')) === "Вес 20 → исключён", "N/A weight text");
    page.assert((await text(page, '[data-crit-row="04"] .step-on')) === "15", "scale step 15 inverted");
    page.assert((await count(page, '[data-crit-row="04"] .step')) === 5, "five scale steps");
    page.assert(/Корректно, но неполно/.test(await text(page, '[data-crit-row="04"]')), "scale step descriptor");
    page.assert((await count(page, '[data-crit-row="01"] .step')) === 0, "yes/no criteria have no scale");
    page.assert((await count(page, "[data-crit-row]")) === 7, "seven scored criteria");
    page.assert((await count(page, '[data-action="appeal"]')) === 0, "reviewer has no appeal buttons");
    page.assert((await count(page, '[data-action="reevaluate"]')) === 1, "reviewer has re-evaluate");
    page.assert((await count(page, 'select[data-action="version"] option')) >= 1, "version select");
    await page.assertAccessibleNames();
  },

  async "card-layout"(page) {
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    const info = await page.eval(`(() => {
      const t = cqaDeep(${q("[data-transcript]")})[0];
      const e = cqaDeep(${q(".evalcol")})[0];
      const rt = t.getBoundingClientRect();
      const re = e.getBoundingClientRect();
      return { pos: getComputedStyle(t).position, sideBySide: re.left >= rt.right - 1, w: innerWidth };
    })()`);
    if (info.w >= 1100) page.assert(info.pos === "sticky" && info.sideBySide, `wide: sticky transcript beside evaluation (${JSON.stringify(info)})`);
    else page.assert(info.pos === "static" && !info.sideBySide, `narrow: stacked, transcript not sticky (${JSON.stringify(info)})`);
    const wide = await page.eval(`cqaAll().filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed').length`);
    page.assert(wide === 0, `no element extends past the viewport (${wide})`);
  },

  async "card-keyboard"(page) {
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    page.assert((await selected(page)) === "01", `initial selection is the first criterion (${await selected(page)})`);
    await page.eval(`cqaDeep(${q('li[data-index="14"] .ts')})[0].focus()`);
    let active = null;
    for (let i = 0; i < 12; i += 1) {
      await page.press("Tab");
      active = await page.active();
      if (active && active.focusId === "crit-list") break;
    }
    page.assert(active && active.focusId === "crit-list", "criteria list is focusable");
    page.assert(active.outline === "solid 2px", `visible focus ring on list (${active.outline})`);
    await page.press("j");
    page.assert((await selected(page)) === "02", `j moves to 02 (${await selected(page)})`);
    await page.press("ArrowDown");
    page.assert((await selected(page)) === "03", "ArrowDown moves to 03");
    await page.press("k");
    page.assert((await selected(page)) === "02", "k moves back to 02");
    await page.press("ArrowUp");
    await page.press("ArrowUp");
    page.assert((await selected(page)) === "01", "ArrowUp clamps at the first criterion");
    for (let i = 0; i < 9; i += 1) await page.press("j");
    page.assert((await selected(page)) === "07", "j clamps at the last criterion");
    page.assert((await page.active()).focusId === "crit-list", "focus stays on the list while moving");
    await page.press("k");
    await page.press("k");
    await page.press("k");
    page.assert((await selected(page)) === "04", "back to 04");
    await page.press("Enter");
    page.assert(await hasClass(page, '[data-index="10"] .ts', "ts") && (await page.eval(`cqaDeep(${q('[data-index="10"] .ts')})[0].getAttribute('aria-pressed')`)) === "true", "Enter selects the first evidence message of 04");
    page.assert(await page.eval(`(() => { const li = cqaDeep(${q('li[data-index="10"]')})[0]; const r = li.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })()`), "Enter scrolls the evidence into view");
    await page.press("j");
    await page.press("j");
    await page.press("j");
    page.assert((await selected(page)) === "07", "j to 07");
    await page.press("Enter");
    page.assert(await page.eval(`(() => { const li = cqaDeep(${q('li[data-index="12"]')})[0]; const r = li.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })()`), "Enter on 07 (no evidence) scrolls to the expected range");
    page.assert((await page.eval(`cqaDeep(${q('li[data-index="12"] .ts')})[0].getAttribute('aria-pressed')`)) === "false", "expected range jump does not select a message");
    const pressed = await page.eval(`cqaDeep(${q("[data-crit-row] .crit-pick")}).map((b) => b.getAttribute('aria-pressed')).join()`);
    page.assert(pressed === "false,false,false,false,false,false,true", `aria-pressed on criterion buttons (${pressed})`);
    await page.eval(`cqaDeep(${q('[data-crit-row="02"] .crit-pick')})[0].focus()`);
    const ring = await page.active();
    page.assert(ring && ring.outline === "solid 2px", `focus ring on criterion button (${ring && ring.outline})`);
    await page.press("Enter");
    page.assert((await selected(page)) === "02", "Enter on a criterion button selects it");
    await page.assertAccessibleNames();
  },

  async "card-locale"(page) {
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    await setLocale(page, "en");
    page.assert((await text(page, "[data-total]")) === "81.88", `EN total (${await text(page, "[data-total]")})`);
    page.assert((await text(page, ".out-of")) === "out of 100", "EN out of");
    page.assert((await text(page, ".t-head .tnum")) === "15 events · 05:05", `EN events (${await text(page, ".t-head .tnum")})`);
    page.assert((await text(page, '[data-crit-row="03"] .crit-weight')) === "Weight 20 → excluded", "EN weight");
    page.assert(/N\/A condition met:/.test(await text(page, '[data-crit-row="03"] .na-box')), "EN N/A condition");
    page.assert((await text(page, '[data-crit-row="07"] .ev-expected')).startsWith("Expected here · "), "EN expected chip");
    const enLeft = await page.eval(`cqaAll(cqaDeep('cqa-app >>> cqa-conversation-card')[0].shadowRoot).filter((el) => /(^|\\s)card\\.[a-zA-Z]+/.test(el.textContent) && el.children.length === 0).length`);
    page.assert(enLeft === 0, "no raw i18n keys in EN");
    await setLocale(page, "kk");
    page.assert((await text(page, "[data-total]")) === "81,88", "KZ total");
    page.assert((await text(page, ".out-of")) === "100-ден", "KZ out of");
    page.assert(/07 критерийі бойынша ашық апелляция/.test(await text(page, "[data-role-hint]")), "KZ role hint");
    const kkLeft = await page.eval(`cqaAll(cqaDeep('cqa-app >>> cqa-conversation-card')[0].shadowRoot).filter((el) => /(^|\\s)card\\.[a-zA-Z]+/.test(el.textContent) && el.children.length === 0).length`);
    page.assert(kkLeft === 0, "no raw i18n keys in KZ");
    await page.click(CARD + '[data-crit-row="07"] .crit-pick');
    page.assert(/Осы жерде күтілді · 07/.test(await text(page, "[data-exp-label]:not([hidden])")), "KZ expected label");
    await setLocale(page, "ru");
    page.assert(norm(await text(page, "[data-total]")) === "81,88", "RU total again");
    page.assert((await selected(page)) === "07", "selection survives a locale switch");
    page.assert((await text(page, "[data-version-chip]")).includes("v2"), "version chip on locale switch");
    await page.assertAccessibleNames();
  },

  async "card-roles"(page) {
    await open(page, "?mock=1&role=operator");
    await ready(page);
    page.assert((await count(page, '[data-action="appeal"]')) === 6, `operator sees appeal buttons on the 6 criteria without an appeal (${await count(page, '[data-action="appeal"]')})`);
    page.assert((await count(page, '[data-crit-row="07"] [data-action="appeal"]')) === 0, "criterion with an open appeal has no appeal button");
    page.assert(/Апелляция · /.test(await text(page, '[data-crit-row="07"]')), "appeal status chip on the appealed criterion");
    page.assert((await count(page, '[data-action="reevaluate"]')) === 0, "operator has no re-evaluate");
    page.assert(/Оспорить/.test(await text(page, '[data-role-hint]')), "operator hint mentions appeals");
    await page.eval(`window.__appeal = null; document.addEventListener('cqa:card-appeal', (e) => { window.__appeal = e.detail; })`);
    await page.click(CARD + '[data-crit-row="06"] [data-action="appeal"]');
    const detail = await page.eval("window.__appeal");
    page.assert(detail && detail.criterionId === "06" && detail.conversationId === "p1-ru-001", `appeal request event leaves the card (${JSON.stringify(detail)})`);
    await open(page, "?mock=1&role=exec");
    await ready(page);
    page.assert((await count(page, '[data-action="appeal"]')) === 0, "exec has no appeal buttons");
    page.assert((await count(page, '[data-action="reevaluate"]')) === 0, "exec has no re-evaluate");
    page.assert(/без действий/.test(await text(page, "[data-role-hint]")), "exec hint");
    await open(page, "?mock=1&role=reviewer");
    await ready(page);
    const modalOpen = `!!cqaDeep('cqa-app >>> cqa-modal[data-confirm]')[0] && cqaDeep('cqa-app >>> cqa-modal[data-confirm]')[0].hasAttribute('open')`;
    await page.click(CARD + '[data-action="reevaluate"]');
    await until(page, modalOpen, "confirm modal");
    page.assert(/Переоценить диалог/.test(await page.eval(`cqaDeep('cqa-app >>> cqa-modal[data-confirm]')[0].getAttribute('heading')`)), "confirm asks before re-evaluating");
    await page.eval(`cqaDeep('cqa-app >>> [data-confirm-cancel]')[0].click()`);
    await until(page, `!(${modalOpen})`, "confirm modal closed");
    page.assert((await count(page, '[data-action="reevaluate"]')) === 1, "cancelling the confirm leaves the card intact");
    await page.click(CARD + '[data-action="reevaluate"]');
    await until(page, modalOpen, "confirm modal again");
    await page.eval(`cqaDeep('cqa-app >>> [data-confirm-ok]')[0].click()`);
    await until(page, `cqaDeep('cqa-app >>> cqa-toast >>> .toast').length > 0`, "re-evaluate toast");
    await ready(page);
    page.assert(norm(await text(page, "[data-total]")) === "81,88", "total unchanged after re-evaluation");
  },

  async "card-states"(page) {
    await open(page, "?mock=1&state=error&role=reviewer");
    await until(page, `!!cqaDeep(${q('[role="alert"]')})[0]`, "error panel");
    page.assert((await count(page, '[data-action="retry"]')) === 1, "error state has retry");
    page.assert((await count(page, "[data-total]")) === 0, "error state shows no score");
    await page.assertAccessibleNames();

    await open(page, "?mock=1&state=loading&role=reviewer");
    await until(page, `!!cqaDeep(${q('[aria-busy="true"]')})[0]`, "loading panel");
    page.assert((await count(page, "[data-total]")) === 0, "loading state shows no score");

    await open(page, "?mock=1&state=empty&role=reviewer");
    await until(page, `!!cqaDeep(${q(".panel-title")})[0]`, "not found panel");
    page.assert((await text(page, ".panel-title")) === "Диалог не найден", "empty state says not found");

    await open(page, "?mock=1&role=reviewer", "#/conversations/does-not-exist");
    await until(page, `!!cqaDeep(${q(".panel-title")})[0]`, "unknown id panel");
    page.assert((await text(page, ".panel-title")) === "Диалог не найден", "unknown id says not found");

    await open(page, "?mock=1&state=lowconf&role=reviewer");
    await ready(page);
    page.assert((await count(page, "[data-provisional-note]")) === 1, "low confidence note");
    page.assert(/Предварительно/.test(await text(page, ".total-row")), "low confidence chip beside the total");
    page.assert(/\d/.test(await text(page, "[data-total]")), "provisional total is still shown");
    page.assert(/Нужна проверка/.test(await text(page, '[data-crit-row="04"]')), "criterion awaiting review is labelled");
    await page.assertAccessibleNames();
  }
};
