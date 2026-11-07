const CARD = "cqa-app >>> cqa-conversation-card >>> ";
const DRAWER = CARD + "cqa-appeal-drawer >>> ";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function open(page, query, hash) {
  await page.eval(`window.__apStale = true`);
  await page.eval(`(() => { const u = new URL(location.href); u.search = ${JSON.stringify(query)} + '&_=' + Date.now(); u.hash = ${JSON.stringify(hash)}; location.href = u.href; })()`);
  await until(page, `window.__apStale === undefined`, "navigation");
  await until(page, `document.readyState === 'complete' && !!document.querySelector('cqa-app')`, "document");
  await until(page, `!!cqaDeep(${JSON.stringify(CARD + "[data-total]")})[0]`, "card total");
}

const j = JSON.stringify;
const full = (sel) => (sel.startsWith("cqa-app") ? sel : CARD + sel);
const text = (page, sel) => page.eval(`(cqaDeep(${j(full(sel))})[0]?.textContent || '').replace(/\\s+/g, ' ').trim()`);
const count = (page, sel) => page.eval(`cqaDeep(${j(full(sel))}).length`);
const norm = (value) => String(value).replace(/[  ]/g, " ");
const drawerOpen = (page) => page.eval(`!!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`);

async function setLocale(page, locale) {
  await page.eval(`document.querySelector('cqa-app').setAttribute('locale', ${j(locale)})`);
  await sleep(300);
}

async function focusType(page, selector, value) {
  await page.eval(`cqaDeep(${j(selector)})[0].focus()`);
  await page.type(value);
  await sleep(60);
}

async function pickSelect(page, selector, value) {
  await page.eval(`(() => { const s = cqaDeep(${j(selector)})[0]; s.value = ${j(String(value))}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(120);
}

async function openDrawer(page, id) {
  await page.eval(`cqaDeep(${j(CARD + `[data-focus-id="appeal-${id}"]`)})[0].focus()`);
  await page.click(CARD + `[data-focus-id="appeal-${id}"]`);
  await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "drawer");
  await sleep(150);
}

export const scenarios = {
  async "appeal-shot"(page) {
    await open(page, "?mock=1&role=operator", "#/conversations/p1-ru-001");
    await openDrawer(page, "04");
    await page.click(CARD + '[data-index="10"] [data-action="attach"]');
    await page.click(CARD + '[data-index="11"] [data-action="attach"]');
    await focusType(page, DRAWER + "[data-field=comment]", "Оператор подробно объяснил сроки и порядок действий в обоих сообщениях.");
    await sleep(200);
  },

  async "appeal-review-shot"(page) {
    await open(page, "?mock=1&role=reviewer", "#/conversations/p1-ru-001");
    await pickSelect(page, CARD + '[data-rv="answer"]', "yes");
    await sleep(200);
  },

  async "appeal-operator"(page) {
    await open(page, "?mock=1&role=operator", "#/conversations/p1-ru-001");
    const buttons = await page.eval(`cqaDeep(${j(CARD + '[data-action="appeal"]')}).map((b) => b.getAttribute('data-crit')).join()`);
    page.assert(buttons === "01,02,03,04,05,06", `appeal button on every criterion without an open appeal (${buttons})`);
    page.assert((await count(page, '[data-action="review-save"]')) === 0, "operator sees no decision panel");
    page.assert(!(await drawerOpen(page)), "drawer closed initially");

    await openDrawer(page, "04");
    page.assert(await drawerOpen(page), "drawer opens");
    const info = await page.eval(`(() => { const d = cqaDeep(${j(CARD + "cqa-appeal-drawer")})[0]; const dlg = d.shadowRoot.querySelector('[role=dialog]'); const r = dlg.getBoundingClientRect(); return { modal: dlg.getAttribute('aria-modal'), label: d.shadowRoot.getElementById(dlg.getAttribute('aria-labelledby')).textContent.trim(), select: d.shadowRoot.querySelector('[data-field=criterion]').value, right: Math.round(r.right), vw: innerWidth, req: d.shadowRoot.querySelector('[data-field=comment]').getAttribute('aria-required'), focus: d.shadowRoot.activeElement && d.shadowRoot.activeElement.getAttribute('data-field') }; })()`);
    page.assert(info.modal === "false" && info.label === "Апелляция по оценке", `dialog wiring (${j(info)})`);
    page.assert(info.select === "04", "criterion preselected");
    page.assert(info.right === info.vw, "drawer pinned to the right edge");
    page.assert(info.req === "true", "comment is aria-required");
    page.assert(info.focus === "comment", `focus moved to the comment (${info.focus})`);
    const current = await text(page, DRAWER + "[data-appeal-current]");
    page.assert(/Текущая оценка/.test(current) && /15 из 20/.test(norm(current)) && /\d/.test(current), `current score shown (${current})`);
    const first = current;
    await pickSelect(page, DRAWER + "[data-field=criterion]", "01");
    const second = await text(page, DRAWER + "[data-appeal-current]");
    page.assert(second !== first && /Да/.test(second), `changing the select updates the current score (${second})`);
    await pickSelect(page, DRAWER + "[data-field=criterion]", "04");

    page.assert((await count(page, "[data-appeal-banner]")) === 1, "attach banner shown");
    const attachable = await page.eval(`cqaDeep(${j(CARD + '[data-action="attach"]')}).length`);
    const people = (await count(page, "li.m-client")) + (await count(page, "li.m-operator"));
    page.assert(attachable > 0 && attachable === people, `attach buttons on client and operator messages only (${attachable}/${people})`);
    page.assert((await count(page, '.m-bot [data-action="attach"]')) === 0, "no attach on bot messages");
    const disabled = () => page.eval(`cqaDeep(${j(DRAWER + "[data-action=submit]")})[0].disabled`);
    page.assert(await disabled(), "submit disabled with an empty comment");
    await focusType(page, DRAWER + "[data-field=comment]", "   ");
    page.assert(await disabled(), "whitespace comment keeps submit disabled");

    await page.click(CARD + '[data-index="10"] [data-action="attach"]');
    await page.click(CARD + '[data-index="11"] [data-action="attach"]');
    page.assert(await page.eval(`cqaDeep(${j(CARD + '[data-index="10"] [data-bubble]')})[0].classList.contains('msg-attached')`), "attached message gets the brand ring class");
    const chips = await page.eval(`cqaDeep(${j(DRAWER + "[data-ref-chips] .rc > button:first-child")}).map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).join('|')`);
    page.assert(/Клиент · 04:\d\d/.test(chips) || /Оператор ·/.test(chips), `reference chips (${chips})`);
    page.assert(chips.split("|").length === 2, `two chips (${chips})`);
    await page.click(CARD + '[data-index="11"] [data-action="attach"]');
    page.assert((await count(page, DRAWER + "[data-ref-chips] .rc")) === 1, "detaching removes the chip");
    await page.click(CARD + '[data-index="11"] [data-action="attach"]');

    page.assert(/5 рабочих дней/.test(await text(page, DRAWER + "[data-appeal-window]")), "five working day window text");
    await focusType(page, DRAWER + "[data-field=comment]", "Сроки названы в двух сообщениях подряд.");
    page.assert(!(await disabled()), "submit enabled with a comment");
    const seen = await page.eval(`(() => { window.__apEvents = []; document.addEventListener('cqa:appeal-submitted', (e) => window.__apEvents.push(e.detail)); return true; })()`);
    await page.click(DRAWER + "[data-action=submit]");
    await until(page, `!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "drawer closes after submit");
    await until(page, `cqaDeep('cqa-app >>> cqa-toast >>> .toast').length > 0`, "toast");
    const toast = await text(page, "cqa-app >>> cqa-toast >>> .toast");
    page.assert(/Апелляция отправлена · статус «На рассмотрении»/.test(toast), `toast (${toast})`);
    const chip = await text(page, CARD + '[data-crit-row="04"]');
    page.assert(/Апелляция · На рассмотрении/.test(chip), `criterion chip (${chip})`);
    page.assert((await count(page, '[data-crit-row="04"] [data-action="appeal"]')) === 0, "no appeal button while open");
    const events = await page.eval(`window.__apEvents`);
    page.assert(events.length === 1 && events[0].criterion === "04" && events[0].conversationId === "p1-ru-001" && Number.isInteger(events[0].appealId), `cqa:appeal-submitted (${j(events)})`);
    const hist = await text(page, "[data-history-section]");
    page.assert(/Апелляция · 04/.test(hist) && /Оператор A/.test(hist) && /Сроки названы/.test(hist), "history shows the appeal and the operator");
    page.assert(!/Иван|Айгерим/.test(hist), "no personal names");
    const active = await page.active();
    page.assert(active && /^(pick-04|appeal-04)$/.test(active.focusId || ""), `focus returns near the criterion (${j(active)})`);
    page.assert(seen === true, "listener attached");
    await page.assertAccessibleNames();
  },

  async "appeal-escape"(page) {
    await open(page, "?mock=1&role=operator", "#/conversations/p1-ru-001");
    await openDrawer(page, "05");
    await focusType(page, DRAWER + "[data-field=comment]", "черновик");
    await page.press("Escape");
    await until(page, `!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "drawer closed by Escape");
    await sleep(150);
    const active = await page.active();
    page.assert(active && active.focusId === "appeal-05", `focus returned to the Оспорить button (${j(active)})`);
    page.assert((await count(page, "[data-appeal-banner]")) === 0, "banner removed");
    page.assert((await count(page, '[data-action="attach"]')) === 0, "attach buttons removed");
    await openDrawer(page, "05");
    page.assert((await page.eval(`cqaDeep(${j(DRAWER + "[data-field=comment]")})[0].value`)) === "", "cancelled draft is not kept");
    await page.click(DRAWER + '[data-focus-id="ad-cancel"]');
    await until(page, `!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "closed by cancel");
    await sleep(150);
    page.assert((await page.active()).focusId === "appeal-05", "focus returned after cancel");
  },

  async "appeal-error"(page) {
    await open(page, "?mock=1&role=operator", "#/conversations/p1-ru-001");
    await openDrawer(page, "02");
    await page.eval(`(async () => { const m = await import(new URL('src/api.js', location.href).href); const c = cqaDeep(${j(CARD.slice(0, -5))})[0]; await m.api.submitAppeal(c._evaluation.id, '02', { comment: 'параллельная', refs: [] }); })()`);
    await focusType(page, DRAWER + "[data-field=comment]", "Вторая попытка по тому же критерию.");
    await page.click(DRAWER + "[data-action=submit]");
    await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-error]")})[0]`, "inline error");
    const err = await text(page, DRAWER + "[data-appeal-error]");
    page.assert(/уже есть открытая апелляция/.test(err), `appeal_open_exists shown inline (${err})`);
    page.assert(await drawerOpen(page), "drawer stays open on error");
    page.assert((await page.eval(`cqaDeep(${j(DRAWER + "[data-appeal-error]")})[0].getAttribute('role')`)) === "alert", "error is an alert");
    page.assert((await page.eval(`cqaDeep(${j(DRAWER + "[data-field=comment]")})[0].value`)).startsWith("Вторая"), "comment kept after error");
  },

  async "appeal-review"(page) {
    await open(page, "?mock=1&role=reviewer", "#/conversations/p1-ru-001");
    page.assert((await count(page, "[data-review]")) === 1, "decision panel for the pending appeal");
    page.assert((await count(page, '[data-action="appeal"]')) === 0, "no Оспорить for the reviewer");
    const panel = await text(page, "[data-review]");
    page.assert(/Решение по апелляции/.test(panel) && /На рассмотрении/.test(panel), "panel title and status");
    page.assert(/Исходная оценка · 07/.test(panel) && /Комментарий оператора/.test(panel) && /Ссылки: 04:51, 04:58/.test(norm(panel)), `original, comment and refs (${panel.slice(0, 260)})`);
    page.assert(/Фрагмент переписки/.test(panel) && /Хорошего дня/.test(panel), "fragment of the checked range");
    page.assert(/Оператор A/.test(panel), "appellant constant");
    page.assert((await count(page, '[data-action="review-start"]')) === 0, "no start button once review has started");
    const options = await page.eval(`cqaDeep(${j(CARD + '[data-rv="answer"] option')}).map((o) => o.textContent.trim()).join()`);
    page.assert(options === "Да,Нет,N/A", `valid answers for a yes/no criterion with N/A (${options})`);
    const preview = () => text(page, "[data-rv-preview]");
    page.assert(norm(await preview()) === "81,88 → 88,13", `preview for Да (${await preview()})`);
    const save = () => page.eval(`cqaDeep(${j(CARD + '[data-action="review-save"]')})[0].disabled`);
    page.assert(await save(), "save disabled without a reason");
    await pickSelect(page, CARD + '[data-rv="answer"]', "na");
    page.assert(norm(await preview()) === "81,88 → 87,33", `preview for N/A (${await preview()})`);
    await pickSelect(page, CARD + '[data-rv="answer"]', "yes");
    await page.click(CARD + '[data-rv="decision"][value="confirm"]');
    page.assert(norm(await preview()) === "81,88 → 81,88", `confirm keeps the total (${await preview()})`);
    page.assert((await count(page, '[data-rv="answer"]')) === 0, "no answer select on confirm");
    await page.click(CARD + '[data-rv="decision"][value="change"]');
    await focusType(page, CARD + '[data-rv="reason"]', "   ");
    page.assert(await save(), "whitespace reason keeps save disabled");
    await focusType(page, CARD + '[data-rv="reason"]', "Клиент сам завершил разговор.");
    page.assert(!(await save()), "save enabled with a reason");
    page.assert((await page.eval(`cqaDeep(${j(CARD + '[data-rv="reason"]')})[0].getAttribute('aria-required')`)) === "true", "reason is aria-required");
    await page.eval(`(() => { window.__dEvents = []; document.addEventListener('cqa:decision-saved', (e) => window.__dEvents.push(e.detail)); })()`);
    await page.click(CARD + '[data-action="review-save"]');
    await until(page, `cqaDeep(${j(CARD + "[data-review]")}).length === 0`, "panel closes");
    page.assert(norm(await text(page, CARD + "[data-total]")) === "88,13", "total updated");
    const score = norm(await text(page, CARD + "[data-score]"));
    page.assert(/было 81,88 · изменено по апелляции/.test(score), `was-chip (${score.slice(0, 120)})`);
    page.assert(/Изменено по апелляции/.test(await text(page, CARD + '[data-crit-row="07"]')), "criterion chip Изменено по апелляции");
    const hist = norm(await text(page, CARD + "[data-history-section]"));
    page.assert(/QA \/ Проверяющий/.test(hist) && /81,88 → 88,13/.test(hist), `history entry (${hist.slice(-200)})`);
    await until(page, `cqaDeep('cqa-app >>> cqa-toast >>> .toast').length > 0`, "toast");
    page.assert(/Решение сохранено · итог 81,88 → 88,13/.test(norm(await text(page, "cqa-app >>> cqa-toast >>> .toast"))), "toast text");
    const events = await page.eval(`window.__dEvents`);
    page.assert(events.length === 1 && events[0].criterion === "07" && events[0].decision === "change" && events[0].totalAfter === 88.13, `cqa:decision-saved (${j(events)})`);
    page.assert((await count(page, "[data-review]")) === 0, "no panel after the decision");
    await page.assertAccessibleNames();
  },

  async "appeal-confirm"(page) {
    await open(page, "?mock=1&role=reviewer", "#/conversations/p1-ru-001");
    await page.click(CARD + '[data-rv="decision"][value="confirm"]');
    await focusType(page, CARD + '[data-rv="reason"]', "Оценка корректна.");
    await page.click(CARD + '[data-action="review-save"]');
    await until(page, `cqaDeep(${j(CARD + "[data-review]")}).length === 0`, "chat panel closes");
    page.assert(norm(await text(page, CARD + "[data-total]")) === "81,88", "chat total unchanged after confirm");
    page.assert(/Оценка подтверждена/.test(await text(page, CARD + '[data-crit-row="07"]')), "chip Оценка подтверждена");
    page.assert(!/было/.test(await text(page, CARD + "[data-score]")), "no was-chip after confirm");
    await open(page, "?mock=1&role=reviewer", "#/conversations/p3-ru-call-014");
    page.assert((await count(page, "[data-review]")) === 1, "panel for the new appeal");
    const total = norm(await text(page, CARD + "[data-total]"));
    page.assert((await count(page, '[data-action="review-start"]')) === 1, "start review offered for a new appeal");
    page.assert(/Новая/.test(await text(page, "[data-review]")), "status Новая");
    await page.click(CARD + '[data-action="review-start"]');
    await until(page, `(cqaDeep(${j(CARD + "[data-review]")})[0]?.textContent || '').includes('На рассмотрении')`, "status changes");
    page.assert((await count(page, '[data-action="review-start"]')) === 0, "start button gone");
    await page.click(CARD + '[data-rv="decision"][value="confirm"]');
    await focusType(page, CARD + '[data-rv="reason"]', "Клиент назвал номер договора, этого недостаточно.");
    await page.click(CARD + '[data-action="review-save"]');
    await until(page, `cqaDeep(${j(CARD + "[data-review]")}).length === 0`, "panel closes");
    page.assert(norm(await text(page, CARD + "[data-total]")) === total, "total unchanged after confirm");
    const hist = await text(page, CARD + "[data-history-section]");
    page.assert(/Подтверждено/.test(hist), "history entry for the confirmation");
  },

  async "appeal-roles"(page) {
    await open(page, "?mock=1&role=exec", "#/conversations/p1-ru-001");
    page.assert((await count(page, '[data-action="appeal"]')) === 0 && (await count(page, "[data-review]")) === 0, "exec sees neither Оспорить nor the decision panel");
    await open(page, "?mock=1&role=operator", "#/conversations/p1-ru-001");
    page.assert((await count(page, "[data-review]")) === 0, "operator sees no decision panel");
    const hasInput = await page.eval(`cqaDeep(${j(CARD + 'input[type=text], input[name*=name i]')}).length`);
    page.assert(hasInput === 0, "no name inputs on the card");
  },

  async "appeal-locales"(page) {
    await open(page, "?mock=1&role=operator", "#/conversations/p1-ru-001");
    for (const [locale, title, banner] of [["kk", "Бағаға дау айту", /Тіркеу/], ["en", "Appeal a score", /Attach/]]) {
      await setLocale(page, locale);
      await page.eval(`cqaDeep(${j(CARD + '[data-action="appeal"]')})[0].click()`);
      await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, `drawer ${locale}`);
      await sleep(200);
      page.assert((await text(page, DRAWER + "h2")) === title, `${locale} drawer title`);
      page.assert(banner.test(await text(page, CARD + "[data-appeal-banner]")), `${locale} banner`);
      page.assert(banner.test(await text(page, CARD + '[data-action="attach"]')), `${locale} attach button`);
      await page.press("Escape");
      await until(page, `!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, `closed ${locale}`);
    }
    await open(page, "?mock=1&role=reviewer&locale=en", "#/conversations/p1-ru-001");
    await setLocale(page, "en");
    const panel = await text(page, CARD + "[data-review]");
    page.assert(/Appeal decision/.test(panel) && /Save decision/.test(panel) && /Change score/.test(panel), `EN panel (${panel.slice(0, 120)})`);
    await setLocale(page, "kk");
    page.assert(/Апелляция бойынша шешім/.test(await text(page, CARD + "[data-review]")), "KZ panel");
  }
};
