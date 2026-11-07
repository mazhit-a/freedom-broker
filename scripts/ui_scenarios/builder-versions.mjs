const B = "cqa-app >>> cqa-checklist-builder";
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
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await sleep(step);
  }
}

async function open(page, query, hash = "#/checklists/1") {
  await page.eval(`(() => { const b = cqaDeep(${JSON.stringify(B)})[0]; if (b) b._dirty = false; return true; })()`).catch(() => null);
  const marker = `m=${Math.random().toString(36).slice(2, 8)}`;
  await page.eval(`setTimeout(() => { location.href = new URL('next.html?mock=1&${marker}${query ? "&" + query : ""}${hash}', location.href).href; }, 0); true`);
  await until(() => page.eval(`location.search.includes(${JSON.stringify(marker)}) && document.readyState === 'complete'`));
  await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-row]`)}).length > 0`));
}

const texts = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)}).map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
const text = async (page, selector) => (await texts(page, selector))[0];
const disabled = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)})[0].disabled`);
const toasts = (page) => texts(page, "cqa-app >>> cqa-toast >>> .msg-text");

async function setField(page, selector, value) {
  await page.eval(`(() => {
    const el = cqaDeep(${JSON.stringify(selector)})[0];
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return true;
  })()`);
  await sleep(60);
}

const confirmOpen = (page) => page.eval(`${APP}.querySelector('[data-confirm]').hasAttribute('open')`);
const rowsText = (page) => texts(page, `${B} >>> [data-region=side] .vrow`);
const chipText = (page) => text(page, `${B} >>> [data-chip=status]`);

async function editName(page, value) {
  await page.click(`${B} >>> [data-action=pick][data-key=k3]`);
  await setField(page, `${B} >>> [data-field=e-name]`, value);
}

async function save(page) {
  await page.click(`${B} >>> [data-action=save]`);
  await until(async () => (await disabled(page, `${B} >>> [data-action=apply]`)) === false);
}

const raw = {
  async "builder-save-apply"(page) {
    await open(page, "role=reviewer");
    page.assert((await disabled(page, `${B} >>> [data-action=discard]`)) === true, "discard is disabled while nothing changed");
    page.assert((await disabled(page, `${B} >>> [data-action=apply]`)) === true, "apply is disabled before saving");
    await editName(page, "Установление контакта (новая формулировка)");
    page.assert((await disabled(page, `${B} >>> [data-action=discard]`)) === false, "discard is enabled after an edit");
    page.assert((await text(page, `${B} >>> [data-meta]`)).endsWith("изменено критериев: 1"), "one changed criterion");
    await save(page);
    page.assert((await chipText(page)) === "Сохранена v3", `status chip (${await chipText(page)})`);
    page.assert((await toasts(page)).includes("Версия v3 сохранена. v2 и её оценки не изменились."), `save toast (${await toasts(page)})`);
    page.assert((await disabled(page, `${B} >>> [data-action=save]`)) === true, "save disabled once saved");
    page.assert((await disabled(page, `${B} >>> [data-action=apply]`)) === false, "apply enabled once saved");
    const rows = await rowsText(page);
    page.assert(rows[0].startsWith("v3") && rows[0].includes("Сохранена"), `editing row now saved (${rows[0]})`);
    page.assert(rows.some((r) => r.startsWith("v3") && r.includes("Сделать активной")), "saved version offers Make active");
    await page.click(`${B} >>> [data-action=apply]`);
    await until(async () => (await chipText(page)).includes("применена к контрольной группе"));
    page.assert((await toasts(page)).includes("Запущена оценка контрольной группы (25 диалогов) по v3."), `apply toast (${await toasts(page)})`);
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=row-weight]`)}).every((e) => e.disabled)`)) === true, "applied version disables the weights");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-action=remove]`)}).every((e) => e.disabled)`)) === true, "applied version disables remove");
    page.assert((await disabled(page, `${B} >>> [data-action=reset]`)) === true, "applied version disables reset");
    page.assert((await disabled(page, `${B} >>> [data-field=e-name]`)) === true, "applied version disables the editor");
    page.assert((await text(page, `${B} >>> [data-save-reason]`)).includes("заблокирована"), "locked reason is shown");
    const after = await rowsText(page);
    page.assert(after[0].startsWith("v3") && /25 диалог/.test(after[0]), `applied count in the sidebar (${after[0]})`);
    page.assert((await page.deepCount(`${B} >>> [data-editing] svg[aria-label="Заблокирована"]`)) === 1, "lock icon on the applied version");
    await page.eval(`(() => { const b = cqaDeep('cqa-app >>> cqa-toast >>> .toast button:not(.dismiss)')[0]; b.click(); return true; })()`);
    await until(() => page.eval(`location.hash.startsWith('#/runs')`));
    page.assert((await page.eval(`location.hash`)).includes("413"), `toast link opens the new run (${await page.eval("location.hash")})`);
  },

  async "builder-duplicate-activate"(page) {
    await open(page, "role=reviewer");
    await page.click(`${B} >>> [data-version-row="12"] [data-action=duplicate]`);
    await until(async () => (await rowsText(page))[0].startsWith("v4"));
    page.assert((await toasts(page)).includes("Создан черновик v4 из v2."), `duplicate toast (${await toasts(page)})`);
    page.assert((await text(page, `${B} >>> [data-meta]`)) === "на основе v2 · изменено критериев: 0", "duplicate starts equal to v2");
    page.assert((await chipText(page)) === "Черновик v4", "duplicate is a draft");
    const rows = await rowsText(page);
    page.assert(rows.some((r) => r.startsWith("v3") && r.includes("Черновик")), "previous draft stays listed");
    await editName(page, "Другое название");
    await save(page);
    await page.click(`${B} >>> [data-editing] [data-action=activate]`);
    await until(async () => (await rowsText(page)).some((r) => r.startsWith("v4") && r.includes("Активная")));
    page.assert((await toasts(page)).includes("Версия v4 назначена активной."), "activate toast");
    const rows2 = await rowsText(page);
    page.assert(rows2.some((r) => r.startsWith("v2") && r.includes("Архив")), `v2 becomes archived (${rows2})`);
  },

  async "builder-unsaved-guard"(page) {
    await open(page, "role=reviewer");
    await editName(page, "Несохранённое название");
    await page.click(`${B} >>> [data-action=open-checklist]`);
    await until(() => confirmOpen(page));
    const info = await page.eval(`(() => { const m = ${APP}.querySelector('[data-confirm]'); return { title: m.getAttribute('heading'), ok: ${APP}.querySelector('[data-confirm-ok]').textContent, cancel: ${APP}.querySelector('[data-confirm-cancel]').textContent }; })()`);
    page.assert(info.title === "Есть несохранённые изменения" && info.ok === "Отбросить и продолжить" && info.cancel === "Остаться", `confirm texts (${JSON.stringify(info)})`);
    await page.eval(`${APP}.querySelector('[data-confirm-cancel]').click()`);
    await until(async () => !(await confirmOpen(page)));
    page.assert((await page.eval(`location.hash`)) === "#/checklists/1", "cancel keeps the builder open");
    page.assert((await text(page, `${B} >>> [data-meta]`)).endsWith("изменено критериев: 1"), "edits survive cancel");
    await page.click(`${B} >>> [data-action=open-checklist]`);
    await until(() => confirmOpen(page));
    await page.eval(`${APP}.querySelector('[data-confirm-ok]').click()`);
    await until(() => page.eval(`location.hash === '#/checklists/2'`));
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> h1`)})[0]?.textContent.includes('звонков')`));
    await open(page, "role=reviewer");
    await editName(page, "Ещё одно название");
    await page.click(`${B} >>> [data-action=discard]`);
    await until(() => confirmOpen(page));
    await page.eval(`${APP}.querySelector('[data-confirm-ok]').click()`);
    await until(async () => (await text(page, `${B} >>> [data-meta]`)).endsWith("изменено критериев: 0"));
    page.assert((await toasts(page)).includes("Изменения отброшены."), "discard toast");
    page.assert((await disabled(page, `${B} >>> [data-action=discard]`)) === true, "discard disabled again");
  },

  async "builder-save-errors"(page) {
    await open(page, "role=reviewer");
    await editName(page, "Название для ошибки");
    await page.eval(`(async () => {
      const m = await import(new URL('src/api.js', location.href).href);
      const { ApiError } = await import(new URL('src/errors.js', location.href).href);
      window.__calls = 0;
      m.api.updateDraft = async () => { window.__calls += 1; throw new ApiError(422, 'http_422', 'weights must be numbers'); };
      return true;
    })()`);
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await page.deepCount(`${B} >>> [data-error=server]`)) === 1);
    const alert = await text(page, `${B} >>> [data-error=server]`);
    page.assert(alert.includes("weights must be numbers") && alert.includes("Ничего не сохранено."), `server validation shown (${alert})`);
    page.assert((await chipText(page)) === "Черновик v3", "status stays draft after a failed save");
    page.assert((await disabled(page, `${B} >>> [data-action=save]`)) === false, "save can be retried");
    page.assert((await toasts(page)).some((x) => x.includes("Ничего не сохранено.")), "error toast");
    await page.eval(`(async () => {
      const m = await import(new URL('src/api.js', location.href).href);
      const { ApiError } = await import(new URL('src/errors.js', location.href).href);
      m.api.updateDraft = async () => { throw new ApiError(403, 'role_forbidden', 'Role exec is not allowed'); };
      return true;
    })()`);
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await text(page, `${B} >>> [data-error=server]`)).startsWith("Недостаточно прав"));
    const count = await page.eval(`(async () => { const m = await import(new URL('src/api.js', location.href).href); return (await m.api.listChecklists())[0].versions.length; })()`);
    page.assert(count === 3, `nothing was saved (${count} versions)`);
    await setField(page, `${B} >>> [data-field=e-name]`, "Ещё правка");
    page.assert((await page.deepCount(`${B} >>> [data-error=server]`)) === 0, "server error clears on edit");
  },

  async "builder-roles-channels"(page) {
    await open(page, "role=exec");
    for (const action of ["discard", "reset", "save", "apply"]) {
      page.assert((await disabled(page, `${B} >>> [data-action=${action}]`)) === true, `exec: ${action} disabled`);
    }
    page.assert((await disabled(page, `${B} >>> [data-version-row="12"] [data-action=duplicate]`)) === true, "exec: duplicate disabled");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=channel]`)}).every((e) => e.disabled)`)) === true, "exec: channels disabled");
    await open(page, "role=reviewer");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=channel]`)}).map((e) => e.checked).join()`)) === "true,false", "chat channel bound");
    await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=channel][data-channel=call]`)})[0].click()`);
    await until(async () => (await toasts(page)).includes("Каналы чек-листа обновлены."));
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=channel]`)}).map((e) => e.checked).join()`)) === "true,true", "call channel bound after toggle");
    await page.assertAccessibleNames();
  },

  async "builder-versions-i18n"(page) {
    await open(page, "role=reviewer&locale=en");
    await editName(page, "Contact opening");
    await save(page);
    page.assert((await toasts(page)).includes("Version v3 saved. v2 and its scores are unchanged."), `EN save toast (${await toasts(page)})`);
    await page.click(`${B} >>> [data-action=apply]`);
    await until(async () => (await toasts(page)).some((x) => x.includes("Evaluation of the control group started")));
    page.assert((await toasts(page)).includes("Evaluation of the control group started (25 conversations) with v3."), "EN apply toast");
    await open(page, "role=reviewer&locale=kk");
    await editName(page, "Байланысты орнату");
    await save(page);
    page.assert((await toasts(page)).includes("v3 нұсқасы сақталды. v2 және оның бағалары өзгерген жоқ."), `KZ save toast (${await toasts(page)})`);
  }
};

const CLEAR = `(() => { const b = cqaDeep("cqa-app >>> cqa-checklist-builder")[0]; if (b) b._dirty = false; return true; })()`;

export const scenarios = Object.fromEntries(
  Object.entries(raw).map(([name, fn]) => [
    name,
    async (page, ...rest) => {
      try {
        return await fn(page, ...rest);
      } finally {
        await page.eval(CLEAR).catch(() => null);
      }
    }
  ])
);
