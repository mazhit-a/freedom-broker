const R = "cqa-app >>> cqa-eval-runs";
const APP = "document.querySelector('cqa-app').shadowRoot";

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function until(fn, timeout = 15000, step = 100) {
  const start = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await fn();
    } catch (error) {
      value = false;
    }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition: " + String(fn).slice(0, 160));
    await sleep(step);
  }
}

async function open(page, query) {
  const marker = `m=${Math.random().toString(36).slice(2, 8)}`;
  await page.eval(`setTimeout(() => { location.href = new URL('index.html?mock=1&${marker}${query ? "&" + query : ""}#/runs', location.href).href; }, 0); true`);
  await until(() => page.eval(`location.search.includes(${JSON.stringify(marker)}) && document.readyState === 'complete'`));
  await until(() => page.eval(`cqaDeep(${JSON.stringify(`${R} >>> [data-run]`)}).length > 0`));
}

async function spy(page) {
  await page.eval(`(async () => {
    const m = await import(new URL('src/api.js', location.href).href);
    window.__calls = { getRun: 0, listRuns: 0, cancel: 0 };
    for (const [name, key] of [['getRun', 'getRun'], ['listRuns', 'listRuns'], ['cancelRun', 'cancel']]) {
      const original = m.api[name];
      m.api[name] = (...args) => { window.__calls[key] += 1; return original(...args); };
    }
    return true;
  })()`);
}

const text = (page, selector) => page.eval(`(cqaDeep(${JSON.stringify(selector)})[0]?.textContent || '').replace(/\\s+/g, ' ').trim()`);
const modalOpen = (page) => page.eval(`${APP}.querySelector('[data-confirm]').hasAttribute('open')`);
const confirmClick = (page, which) => page.eval(`${APP}.querySelector('[data-confirm-${which}]').click()`);

export const scenarios = {
  async "runs-cancel"(page) {
    await open(page, "role=reviewer");
    await spy(page);
    const btn = `${R} >>> [data-run] [data-action=cancel-run]`;
    page.assert((await page.deepCount(btn)) === 1, "stop button on the running run");
    page.assert((await text(page, btn)) === "Остановить", "stop button label");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(btn)})[0].getAttribute('aria-label')`)) === "Остановить запуск R-0412", "stop button accessible name");
    page.assert((await page.deepCount(`${R} >>> [data-history] [data-action=cancel-run]`)) === 1, "stop button in the history row of the active run");

    await page.click(btn);
    await until(() => modalOpen(page));
    const info = await page.eval(`(() => { const m = ${APP}.querySelector('[data-confirm]'); return [m.getAttribute('heading'), m.getAttribute('description'), ${APP}.querySelector('[data-confirm-ok]').textContent, ${APP}.querySelector('[data-confirm-cancel]').textContent]; })()`);
    page.assert(info[0] === "Остановить запуск R-0412?", `confirm heading (${info[0]})`);
    page.assert(/уже оценённые диалоги сохранятся/i.test(info[1]) && /будут оплачены/.test(info[1]) && /пропущены/.test(info[1]), `confirm text (${info[1]})`);
    page.assert(info[2] === "Остановить запуск" && info[3] === "Продолжить запуск", `confirm buttons (${info[2]} / ${info[3]})`);
    await page.press("Escape");
    await until(async () => !(await modalOpen(page)));
    page.assert((await page.eval(`window.__calls.cancel`)) === 0, "declining does not call the api");
    page.assert((await page.deepText(`${R} >>> [data-run-status]`)) === "Выполняется", "still running after declining");

    await page.click(btn);
    await until(() => modalOpen(page));
    await confirmClick(page, "ok");
    await until(() => page.eval(`cqaDeep('${R} >>> [data-run-status]')[0]?.getAttribute('data-run-status') === 'cancelling'`), 3000, 50);
    page.assert((await page.deepText(`${R} >>> [data-run-status]`)) === "Останавливается", "cancelling chip");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(btn)})[0].disabled`)) === true, "stop button disabled while cancelling");
    page.assert((await page.eval(`window.__calls.cancel`)) === 1, "cancelRun called once");
    await until(() => page.eval(`cqaDeep('cqa-app >>> cqa-toast >>> .toast').length > 0`), 3000);
    await until(() => page.eval(`cqaDeep('${R} >>> [data-run-status]')[0]?.getAttribute('data-run-status') === 'cancelled'`), 8000, 100);
    page.assert((await page.deepText(`${R} >>> [data-run-status]`)) === "Остановлен пользователем", "cancelled chip");
    page.assert((await page.deepCount(btn)) === 0, "no stop button on a cancelled run");
    page.assert((await page.deepCount(`${R} >>> [data-count=cancelled]`)) === 1, "cancelled counter");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-count=failed]')[0].textContent.trim()`)).startsWith("1 "), "cancelled items are not counted as errors");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-count=queued]')[0].textContent.trim()`)).startsWith("0 "), "cancelled items are not pending");
    page.assert((await page.deepCount(`${R} >>> [data-history] [data-action=cancel-run]`)) === 0, "history row loses the stop button");
    const frozen = await page.eval(`window.__calls.getRun + window.__calls.listRuns`);
    await sleep(4500);
    page.assert((await page.eval(`window.__calls.getRun + window.__calls.listRuns`)) === frozen, "polling stops at the final status");
    await page.assertAccessibleNames();
  },

  async "runs-cancel-roles"(page) {
    await open(page, "role=exec");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-run] [data-action=cancel-run]')[0].disabled`)) === true, "exec cannot stop a run");
    await open(page, "role=reviewer&locale=en");
    await until(() => page.eval(`cqaDeep('${R} >>> h1')[0]?.textContent.trim() === 'Evaluation runs'`));
    page.assert((await text(page, `${R} >>> [data-run] [data-action=cancel-run]`)) === "Stop", "EN label");
    await page.eval(`document.querySelector('cqa-app').setAttribute('locale', 'kk')`);
    await until(() => page.eval(`cqaDeep('${R} >>> h1')[0]?.textContent.trim() === 'Бағалау іске қосулары'`));
    page.assert((await text(page, `${R} >>> [data-run] [data-action=cancel-run]`)) === "Тоқтату", "KZ label");
  },

  async "runs-cancel-states"(page) {
    await open(page, "role=reviewer&state=extraruns");
    page.assert((await page.deepCount(`${R} >>> [data-run-error]`)) === 0, "no banner on a running run");
    const rows = await page.eval(`cqaDeep('${R} >>> [data-history] [role=row]').map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`);
    const failedRow = rows.find((r) => /R-0409/.test(r));
    const interruptedRow = rows.find((r) => /R-0408/.test(r));
    page.assert(failedRow && /Ошибка/.test(failedRow) && /нет кредитов/.test(failedRow), `failed history row with secondary line (${failedRow})`);
    page.assert(interruptedRow && /Прерван/.test(interruptedRow) && /Остановить/.test(interruptedRow), `interrupted history row with stop (${interruptedRow})`);
    page.assert((await page.deepCount(`${R} >>> [data-history] [data-action=cancel-run][data-id=R-0409]`)) === 0, "failed run cannot be stopped");

    await page.click(`${R} >>> [data-action=open-run][data-id=R-0409]`);
    await until(() => page.eval(`cqaDeep('${R} >>> h2#cur-h')[0]?.textContent.trim() === 'Запуск R-0409'`));
    await until(() => page.eval(`cqaDeep('${R} >>> [data-run-error]').length === 1`));
    page.assert(/нет кредитов на аккаунте или неверный ключ, прогон остановлен/.test(await page.deepText(`${R} >>> [data-run-error-text]`)), "error banner text");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-run-error]')[0].getAttribute('role')`)) === "alert", "banner is an alert");
    page.assert((await page.deepText(`${R} >>> [data-run-status]`)) === "Ошибка", "failed chip says Ошибка");
    page.assert((await page.deepCount(`${R} >>> [data-run] [data-action=cancel-run]`)) === 0, "no stop button on a failed run");

    await spy(page);
    await page.click(`${R} >>> [data-history] [data-action=cancel-run][data-id=R-0408]`);
    await until(() => modalOpen(page));
    await confirmClick(page, "ok");
    await until(() => page.eval(`/Остановлен пользователем/.test(cqaDeep('${R} >>> [data-history]')[0]?.textContent || '')`), 5000);
    page.assert((await page.eval(`window.__calls.cancel`)) === 1, "interrupted run cancelled through the list");
    page.assert((await page.deepCount(`${R} >>> [data-history] [data-action=cancel-run]`)) === 1, "only the running run keeps its stop button");
  }
};
