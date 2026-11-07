const R = "cqa-app >>> cqa-eval-runs";

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

async function open(page, query, ready = `${R} >>> [data-run]`) {
  const marker = `m=${Math.random().toString(36).slice(2, 8)}`;
  await page.eval(`setTimeout(() => { location.href = new URL('next.html?mock=1&${marker}${query ? "&" + query : ""}#/runs', location.href).href; }, 0); true`);
  await until(() => page.eval(`location.search.includes(${JSON.stringify(marker)}) && document.readyState === 'complete'`));
  if (ready) await until(() => page.eval(`cqaDeep(${JSON.stringify(ready)}).length > 0`));
}

async function texts(page, selector) {
  return page.eval(`cqaDeep(${JSON.stringify(selector)}).map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
}

async function spy(page) {
  await page.eval(`(async () => {
    const m = await import(new URL('src/api.js', location.href).href);
    window.__calls = { getRun: 0, listRuns: 0, retry: 0 };
    for (const [name, key] of [['getRun', 'getRun'], ['listRuns', 'listRuns'], ['retryRunItem', 'retry']]) {
      const original = m.api[name];
      m.api[name] = (...args) => { window.__calls[key] += 1; return original(...args); };
    }
    return true;
  })()`);
}

function calls(page) {
  return page.eval(`window.__calls.getRun + window.__calls.listRuns`);
}

export const scenarios = {
  async runs(page) {
    await open(page, "role=reviewer");
    page.assert((await page.deepCount(`${R} >>> h1`)) === 1, "one h1");
    page.assert((await page.deepText(`${R} >>> h1`)) === "Запуски оценки", "h1 text");
    const bar = await page.eval(`(() => { const b = cqaDeep('${R} >>> [role=progressbar]')[0]; return [b.getAttribute('aria-valuemin'), b.getAttribute('aria-valuemax'), b.getAttribute('aria-valuenow'), b.getAttribute('aria-label'), b.children.length].join('|'); })()`);
    page.assert(bar === "0|25|18|Прогресс запуска|3", `progressbar attributes (${bar})`);
    const counters = await texts(page, `${R} >>> [data-count]`);
    page.assert(JSON.stringify(counters) === JSON.stringify(["17 готово", "2 оценивается", "5 в очереди", "1 ошибка"]), `counters (${counters})`);
    page.assert((await page.deepText(`${R} >>> [data-spent]`)) === "потрачено ≈ 0,07 $", "spend");
    page.assert(/прошло/.test(await page.deepText(`${R} >>> [data-time]`)) && /осталось/.test(await page.deepText(`${R} >>> [data-time]`)), "elapsed and ETA");
    page.assert((await page.deepText(`${R} >>> h2#cur-h`)) === "Запуск R-0412", "current run title");
    page.assert((await page.deepText(`${R} >>> [data-run-status]`)) === "Выполняется", "running chip");
    const statuses = await page.eval(`cqaDeep('${R} >>> [data-item-status]').map((e) => e.getAttribute('data-item-status') + ':' + e.textContent.trim())`);
    for (const s of ["done:Готово", "lowConfidence:Низкая уверенность", "failed:Ошибка", "running:Оценивается", "queued:В очереди"]) page.assert(statuses.includes(s), `item status ${s} (${statuses})`);
    const rowsText = await texts(page, `${R} >>> [data-run] [role=row]`);
    page.assert(rowsText.some((r) => /p1-ru-001.*Готово.*6,2 с.*81,88/.test(r)), `done row with total and time (${rowsText[1]})`);
    page.assert(rowsText.some((r) => /Низкая уверенность.*Требует проверки ОКК/.test(r)), "low confidence row");
    page.assert(rowsText.some((r) => /Грубая ошибка/.test(r)), "gross error chip");
    page.assert(rowsText.some((r) => /Таймаут модели.*Повторить/.test(r)), "failed row with reason and retry");
    page.assert(rowsText.some((r) => /v2: \d+,\d{2} - другая версия чек-листа/.test(r)), "other version note");
    page.assert(/Показано 8 из 25/.test(await page.deepText(`${R} >>> [data-run] .foot`)), "shown 8 of 25");
    page.assert((await page.deepCount(`${R} >>> [data-run] [role=table]`)) === 1, "items table role");
    const hist = await texts(page, `${R} >>> [data-history] [role=row]`);
    page.assert(hist.length === 5, `history rows (${hist.length})`);
    page.assert(/R-0412.*v3.*18 \/ 25.*выполняется/.test(hist[1]), `running history row (${hist[1]})`);
    page.assert(/R-0411.*v2.*25.*74,36/.test(hist[2]), `completed history row (${hist[2]})`);
    page.assert(/R-0388.*Файл · export_okt\.json.*v1.*Локальная модель.*412.*76,04/.test(hist[4]), `file history row (${hist[4]})`);
    page.assert(/напрямую не сравниваются/.test(await page.deepText(`${R} >>> [data-history] .foot`)), "versions note");
    page.assert((await page.deepText(`${R} >>> [data-estimate]`)) === "≈ 0,10 $", "estimate 0,10");
    const versionOptions = await texts(page, `${R} >>> select[data-field=version] option`);
    page.assert(versionOptions.length === 2 && !versionOptions.some((o) => /v3/.test(o)), `saved versions only (${versionOptions})`);
    const modelOptions = await texts(page, `${R} >>> select[data-field=model] option`);
    page.assert(/платная.*≈ 0,004 \$ за диалог/.test(modelOptions[0]), `model option with price (${modelOptions[0]})`);
    page.assert(/бесплатно/.test(modelOptions[1]), "free model option");
    const datasetOptions = await texts(page, `${R} >>> select[data-field=group] option`);
    page.assert(/control - Контрольная группа · 25 диалогов/.test(datasetOptions[0]), `dataset option name - count (${datasetOptions[0]})`);
    page.assert((await page.eval(`!cqaDeep('${R} >>> [data-action=start]')[0].disabled`)) === true, "start enabled when valid");
    await page.assertAccessibleNames();

    await spy(page);
    await page.click(`${R} >>> [data-action=retry-item]`);
    await until(() => page.eval(`cqaDeep('${R} >>> [data-item-status=failed]').length === 0`), 4000);
    page.assert((await page.eval(`window.__calls.retry`)) === 1, "retry called once");
    const queued = await page.eval(`cqaDeep('${R} >>> [role=row]').filter((r) => /p1-ru-019/.test(r.textContent))[0]?.querySelector('[data-item-status]')?.getAttribute('data-item-status')`);
    page.assert(queued === "queued", `retried row moved to queue (${queued})`);
    const failedCounter = await page.deepText(`${R} >>> [data-count=failed]`);
    page.assert(/^0 /.test(failedCounter), `failed counter dropped (${failedCounter})`);

    const before = await page.eval(`cqaDeep('${R} >>> [role=progressbar]')[0].getAttribute('aria-valuenow')`);
    await until(() => page.eval(`cqaDeep('${R} >>> [role=progressbar]')[0].getAttribute('aria-valuenow') !== ${JSON.stringify(before)}`), 6000);
    page.assert(true, "progress advances");
    await until(() => page.eval(`cqaDeep('${R} >>> [data-run-status]')[0]?.getAttribute('data-run-status') === 'completed'`), 30000, 250);
    page.assert((await page.deepText(`${R} >>> [data-run-status]`)) === "Завершён", "completed chip");
    page.assert(/заняло/.test(await page.deepText(`${R} >>> [data-time]`)), "took time shown after completion");
    await until(async () => /^25$/.test((await texts(page, `${R} >>> [data-history] [role=row]`))[1]?.split(" ").slice(-5)[0] ?? "") || true, 500);
    const frozen = await calls(page);
    await sleep(5000);
    page.assert((await calls(page)) === frozen, `no requests after completion (${frozen} -> ${await calls(page)})`);
  },

  async "runs-poll-cleanup"(page) {
    await open(page, "role=reviewer");
    await spy(page);
    await sleep(2600);
    page.assert((await page.eval(`window.__calls.getRun`)) >= 1, "polling is active while the run is running");
    await page.eval(`location.hash = '#/overview'`);
    await until(() => page.eval(`cqaDeep('cqa-app >>> cqa-eval-runs').length === 0`));
    await sleep(300);
    const frozen = await calls(page);
    await sleep(5000);
    page.assert((await calls(page)) === frozen, `no further requests after leaving the screen (${frozen} -> ${await calls(page)})`);
  },

  async "runs-start"(page) {
    await open(page, "role=reviewer");
    await page.eval(`(() => { const s = cqaDeep('${R} >>> select[data-field=model]')[0]; s.value = 'local'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(() => page.eval(`cqaDeep('${R} >>> [data-estimate]')[0].textContent.trim() === '≈ 0,00 $'`));
    await page.eval(`(() => { const s = cqaDeep('${R} >>> select[data-field=model]')[0]; s.value = 'llm-v3'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(() => page.eval(`cqaDeep('${R} >>> [data-estimate]')[0].textContent.trim() === '≈ 0,10 $'`));
    await page.click(`${R} >>> [data-action=start]`);
    await until(() => page.eval(`cqaDeep('${R} >>> h2#cur-h')[0]?.textContent.trim() === 'Запуск R-0413'`));
    page.assert((await page.deepText(`${R} >>> [data-run-status]`)) === "Выполняется", "new run is current and running");
    const hist = await texts(page, `${R} >>> [data-history] [role=row]`);
    page.assert(/R-0413.*0 \/ 25.*выполняется/.test(hist[1]), `new run first in history (${hist[1]})`);
    const counters = await texts(page, `${R} >>> [data-count]`);
    page.assert(counters[2] === "25 в очереди", `25 queued (${counters})`);
    await until(() => page.eval(`+cqaDeep('${R} >>> [role=progressbar]')[0].getAttribute('aria-valuenow') > 0`), 8000);
    page.assert(true, "new run progresses");
    await page.click(`${R} >>> [data-action=open-run][data-id=R-0411]`);
    await until(() => page.eval(`cqaDeep('${R} >>> h2#cur-h')[0]?.textContent.trim() === 'Запуск R-0411'`));
    page.assert((await page.eval(`!!cqaDeep('${R} >>> [data-no-items]')[0]`)) === true, "history run without rows says so");
  },

  async "runs-file"(page) {
    await open(page, "role=reviewer");
    const setFile = (name, body, type = 'application/json') => page.eval(`(() => {
      const input = cqaDeep('${R} >>> input[type=file]')[0];
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.click(`${R} >>> [data-action=source][data-value=file]`);
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-action=source][data-value=file]')[0].getAttribute('aria-pressed')`)) === "true", "file source pressed");
    page.assert((await page.deepCount(`${R} >>> select[data-field=group]`)) === 0, "dataset select hidden for file source");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-action=start]')[0].disabled`)) === true, "start disabled with no file");
    await setFile("bad.json", JSON.stringify([{ conversation_id: "a", language: "ru" }]));
    await until(() => page.eval(`!!cqaDeep('${R} >>> [role=alert]')[0]`));
    page.assert(/Запись 1: нет полей channel, transcript/.test(await page.deepText(`${R} >>> .msg-bad`)), "missing keys error");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-action=start]')[0].disabled`)) === true, "start still disabled");
    await setFile("broken.json", "{oops");
    await until(() => page.eval(`/не является корректным JSON/.test(cqaDeep('${R} >>> .msg-bad')[0]?.textContent || '')`));
    await setFile("x.csv", "a,b", "text/csv");
    await until(() => page.eval(`/расширением \\.json/.test(cqaDeep('${R} >>> .msg-bad')[0]?.textContent || '')`));
    const good = JSON.stringify([1, 2, 3].map((i) => ({ conversation_id: `f-${i}`, channel: "agent chat", language: "ru", transcript: [] })));
    await setFile("export_new.json", good);
    await until(() => page.eval(`/Файл готов: export_new\\.json, 3 диалога/.test(cqaDeep('${R} >>> .file-line')[0]?.textContent || '')`));
    await until(() => page.eval(`cqaDeep('${R} >>> [data-estimate]')[0].textContent.trim() === '≈ 0,01 $'`));
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-action=start]')[0].disabled`)) === false, "start enabled for valid file");
    await page.click(`${R} >>> [data-action=start]`);
    await until(() => page.eval(`cqaDeep('${R} >>> h2#cur-h')[0]?.textContent.trim() === 'Запуск R-0413'`));
    await until(() => page.eval(`/Файл · export_new\\.json/.test(cqaDeep('${R} >>> [data-history]')[0]?.textContent || '')`));
    page.assert(true, "file imported and run started");
    await page.assertAccessibleNames();
  },

  async "runs-states"(page) {
    await open(page, "state=error", `${R} >>> [role=alert]`);
    page.assert(/Не удалось загрузить запуски/.test(await page.deepText(`${R} >>> [role=alert]`)), "error state");
    page.assert((await page.deepCount(`${R} >>> [data-action=retry]`)) === 1, "error has retry");
    await open(page, "state=loading", `${R} >>> [aria-busy=true]`);
    page.assert((await page.deepCount(`${R} >>> [aria-busy=true]`)) === 1, "loading state");
    await open(page, "state=empty&role=reviewer", `${R} >>> [data-history]`);
    page.assert(/Запусков пока нет/.test(await page.deepText(`${R} >>> [data-history]`)), "empty history");
    page.assert(/Запусков пока нет/.test(await page.deepText(`${R} >>> [data-current]`)), "empty current");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-action=start]')[0].disabled`)) === true, "start disabled with no datasets");
    await open(page, "state=lowconf&role=reviewer");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-item-status=lowConfidence]').length`)) >= 1, "low confidence rows present");
    await open(page, "role=exec");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-action=start]')[0].disabled`)) === true, "exec cannot start");
    page.assert((await page.deepCount(`${R} >>> [data-role-hint]`)) === 1, "role hint shown");
    page.assert((await page.eval(`cqaDeep('${R} >>> [data-action=retry-item]')[0].disabled`)) === true, "exec cannot retry");
  },

  async "runs-locale"(page) {
    await open(page, "role=reviewer&locale=en");
    await until(() => page.eval(`cqaDeep('${R} >>> h1')[0]?.textContent.trim() === 'Evaluation runs'`));
    page.assert((await page.deepText(`${R} >>> [data-spent]`)) === "spent ≈ 0.07 $", "EN decimal point");
    page.assert(/p1-ru-001.*Done.*6\.2 s.*81\.88/.test((await texts(page, `${R} >>> [data-run] [role=row]`))[1]), "EN row");
    page.assert(/R-0412.*\d\d\/\d\d\/2026 \d\d:\d\d/.test((await texts(page, `${R} >>> [data-history] [role=row]`))[1]), "EN date");
    await page.eval(`document.querySelector('cqa-app').setAttribute('locale', 'kk')`);
    await until(() => page.eval(`cqaDeep('${R} >>> h1')[0]?.textContent.trim() === 'Бағалау іске қосулары'`));
    page.assert((await page.deepText(`${R} >>> [data-spent]`)) === "жұмсалды ≈ 0,07 $", "KZ decimal comma");
    const kk = await texts(page, `${R} >>> [data-history] [role=row]`);
    page.assert(/74,36/.test(kk[2]), "KZ average");
    const fontOk = await until(() => page.eval(`document.fonts.check('600 14px Inter', 'әғқңөұүһі')`), 5000).catch(() => false);
    page.assert(fontOk === true, "Kazakh letters render in Inter");
    await page.eval(`document.querySelector('cqa-app').setAttribute('locale', 'ru')`);
    await until(() => page.eval(`cqaDeep('${R} >>> h1')[0]?.textContent.trim() === 'Запуски оценки'`));
    const raw = await page.eval(`(() => { const out = []; for (const el of cqaAll(document.querySelector('cqa-app').shadowRoot)) if (/^runs\\./.test(el.textContent.trim()) && el.children.length === 0) out.push(el.textContent.trim()); return out; })()`);
    page.assert(raw.length === 0, `no raw keys on screen (${raw})`);
  },

  async "runs-keys"(page) {
    await open(page, "role=reviewer");
    await page.eval(`cqaDeep('${R} >>> [data-action=source][data-value=api]')[0].focus()`);
    const seen = [];
    for (let i = 0; i < 8; i += 1) {
      await page.press("Tab");
      const a = await page.active();
      seen.push(a && (a.focusId || a.tag));
      page.assert(a && a.outline === "solid 2px", `focus ring on ${a && a.focusId} (${a && a.outline})`);
    }
    const expected = ["source-file", "group", "custom", "choose-file", "version", "model", "force", "start"];
    page.assert(JSON.stringify(seen) === JSON.stringify(expected), `tab order of the form (${seen})`);
    await page.eval(`cqaDeep('${R} >>> [data-action=source][data-value=file]')[0].focus()`);
    await page.press("Enter");
    await until(() => page.eval(`cqaDeep('${R} >>> [data-action=source][data-value=file]')[0].getAttribute('aria-pressed') === 'true'`));
    const active = await page.active();
    page.assert(active && active.focusId === "source-file", `focus kept on the toggle after re-render (${JSON.stringify(active)})`);
    await page.eval(`cqaDeep('${R} >>> [data-action=retry-item]')[0]?.focus()`);
    const retryFocus = await page.active();
    page.assert(retryFocus && /^retry-/.test(retryFocus.focusId || ""), "retry button reachable");
    await sleep(2300);
    const still = await page.active();
    page.assert(still && still.focusId === retryFocus.focusId, `focus survives a poll re-render (${JSON.stringify(still)})`);
    await page.assertAccessibleNames();
  }
};
