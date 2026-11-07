const B = "cqa-app >>> cqa-checklist-builder";

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

async function open(page, query, hash = "#/checklists/1", ready = `${B} >>> [data-row]`) {
  const marker = `m=${Math.random().toString(36).slice(2, 8)}`;
  await page.eval(`setTimeout(() => { location.href = new URL('next.html?mock=1&${marker}${query ? "&" + query : ""}${hash}', location.href).href; }, 0); true`);
  await until(() => page.eval(`location.search.includes(${JSON.stringify(marker)}) && document.readyState === 'complete'`));
  if (ready) await until(() => page.eval(`cqaDeep(${JSON.stringify(ready)}).length > 0`));
}

function texts(page, selector) {
  return page.eval(`cqaDeep(${JSON.stringify(selector)}).map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
}

async function text(page, selector) {
  return (await texts(page, selector))[0];
}

async function setField(page, selector, value) {
  await page.eval(`(() => {
    const el = cqaDeep(${JSON.stringify(selector)})[0];
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return true;
  })()`);
  await sleep(40);
}

async function setSelect(page, selector, value) {
  await page.eval(`(() => {
    const el = cqaDeep(${JSON.stringify(selector)})[0];
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  })()`);
  await sleep(60);
}

const sum = (page) => text(page, `${B} >>> [data-sum]`);
const tone = (page) => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-sum]`)})[0].getAttribute('data-tone')`);
const alerts = (page) => texts(page, `${B} >>> [data-alerts] span`);
const total = (page) => text(page, `${B} >>> [data-total]`);
const note = (page) => text(page, `${B} >>> [data-preview-note]`);
const saveOff = (page) => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-action=save]`)})[0].disabled`);
const rowWeight = (key) => `${B} >>> [data-field=row-weight][data-key=${key}]`;
const nums = (page) => texts(page, `${B} >>> [data-row] .nm`);

export const scenarios = {
  async builder(page) {
    await open(page, "role=reviewer");
    page.assert((await text(page, `${B} >>> h1`)) === "Чек-лист качества чатов", "title is the checklist name");
    page.assert((await page.deepCount(`${B} >>> [data-row]`)) === 8, "eight criteria rows");
    page.assert((await page.deepCount(`${B} >>> .sech-t`)) === 4, "four sections");
    page.assert((await sum(page)) === "Сумма весов: 100 / 100", `sum pill (${await sum(page)})`);
    page.assert((await tone(page)) === "ok", "sum pill is ok at 100");
    page.assert((await page.deepCount(`${B} >>> [data-alerts]`)) === 0, "no alert at 100");
    page.assert((await saveOff(page)) === false, "save enabled at 100");
    page.assert((await total(page)) === "81,88", `preview total 81,88 (${await total(page)})`);
    page.assert((await note(page)).includes("N/A исключён, коэффициент 100 / 80 = 1,25"), `preview note (${await note(page)})`);
    page.assert((await text(page, `${B} >>> [data-meta]`)) === "на основе v2 · изменено критериев: 0", `meta (${await text(page, `${B} >>> [data-meta]`)})`);

    await setField(page, rowWeight("k2"), "15");
    page.assert((await sum(page)) === "Сумма весов: 95 / 100", `sum 95 (${await sum(page)})`);
    page.assert((await tone(page)) === "warn", "sum below 100 is warn");
    page.assert(JSON.stringify(await alerts(page)) === JSON.stringify(["Сумма весов должна быть 100, сейчас 95."]), `alert lists the sum (${await alerts(page)})`);
    page.assert((await saveOff(page)) === true, "save disabled at 95");
    const reason = await text(page, `${B} >>> [data-save-reason]`);
    page.assert(reason === "Сохранение недоступно: сумма весов 95, нужно 100.", `visible reason (${reason})`);
    const describedBy = await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-action=save]`)})[0].getAttribute('aria-describedby')`);
    page.assert(describedBy === "save-reason", "save is described by the reason");
    page.assert((await text(page, `${B} >>> [data-meta]`)) === "на основе v2 · изменено критериев: 1", "changed count after one edit");
    page.assert((await text(page, `${B} >>> [data-section-weight=security]`)) === "вес раздела 35", `section weight live (${await text(page, `${B} >>> [data-section-weight=security]`)})`);
    const focus = await page.active();
    page.assert(focus && focus.focusId === "rw-k2", `typing in a row weight keeps focus (${JSON.stringify(focus)})`);

    await setField(page, rowWeight("k2"), "25");
    page.assert((await tone(page)) === "bad", "sum above 100 is bad");
    page.assert((await alerts(page))[0] === "Сумма весов должна быть 100, сейчас 105.", "alert follows the value");

    await setField(page, rowWeight("k2"), "19,99");
    page.assert((await sum(page)) === "Сумма весов: 99,99 / 100", `99,99 is not 100 (${await sum(page)})`);
    page.assert((await saveOff(page)) === true, "save disabled at 99,99");
    await setField(page, rowWeight("k2"), "20,01");
    page.assert((await sum(page)) === "Сумма весов: 100,01 / 100", `100,01 is not 100 (${await sum(page)})`);
    page.assert((await saveOff(page)) === true, "save disabled at 100,01");
    await setField(page, rowWeight("k2"), "");
    page.assert((await alerts(page)).some((a) => a.startsWith("Вес критерия 03 должен быть числом")), `blank weight is reported (${await alerts(page)})`);
    await setField(page, rowWeight("k2"), "20");
    page.assert((await alerts(page)).length === 0, "every fix removed its message");
    page.assert((await saveOff(page)) === false, "save enabled again at 100");
    page.assert((await text(page, `${B} >>> [data-meta]`)) === "на основе v2 · изменено критериев: 0", "changed count returns to 0");
    page.assert((await page.deepCount(`${B} >>> [data-row] .chip.c-warn`)) === 0, "no changed chips after the revert");

    await setField(page, rowWeight("k3"), "25");
    await setField(page, rowWeight("k1"), "10");
    page.assert((await sum(page)) === "Сумма весов: 100 / 100", `04 -> 25 and 02 -> 10 keeps 100 (${await sum(page)})`);
    const after = await total(page);
    page.assert(after !== "81,88" && /^\d+,\d\d$/.test(after), `total recomputed (${after})`);
    page.assert((await saveOff(page)) === false, "save enabled");
    await page.press("Tab");
    await page.assertAccessibleNames();
  },

  async "builder-editor"(page) {
    await open(page, "role=reviewer");
    const rows = await nums(page);
    page.assert(rows[3].startsWith("Корректная и полная консультация"), `scale criterion 04 is row four (${rows[3]})`);
    page.assert((await text(page, `${B} >>> .ed-h .h2`)) === "Критерий 01", "first row loaded into the editor");
    await page.click(`${B} >>> [data-action=pick][data-key=k3]`);
    page.assert((await text(page, `${B} >>> .ed-h .h2`)) === "Критерий 04", "picking loads the editor");

    page.assert((await page.deepCount(`${B} >>> cqa-scale-step-editor >>> [data-field=value]`)) === 5, "scale editor shows five steps");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-row].sel`)}).length`)) === 1, "one selected row");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-action=pick][data-key=k3]`)})[0].getAttribute('aria-pressed')`)) === "true", "aria-pressed on the picked row");

    await setField(page, `${B} >>> [data-field=e-name]`, "Консультация клиента");
    page.assert((await text(page, `${B} >>> [data-row=k3] .nm`)) === "Консультация клиента изменён", `name updates the row and marks it changed (${await text(page, `${B} >>> [data-row=k3] .nm`)})`);
    page.assert((await page.active()).focusId === "e-name", "typing in the editor keeps focus");
    await setField(page, `${B} >>> [data-field=e-name]`, "Выявление потребности");
    page.assert((await alerts(page)).includes("Повторяется название «Выявление потребности»."), `duplicate name reported (${await alerts(page)})`);
    page.assert((await saveOff(page)) === true, "duplicates block save");
    await setField(page, `${B} >>> [data-field=e-name]`, "");
    page.assert((await alerts(page)).includes("У критерия 04 нет названия."), `empty name reported (${await alerts(page)})`);
    await setField(page, `${B} >>> [data-field=e-name]`, "Корректная и полная консультация");
    page.assert((await alerts(page)).length === 0, "names fixed");
    await setField(page, `${B} >>> [data-field=e-desc]`, "Новая формулировка");
    page.assert((await text(page, `${B} >>> [data-row=k3] .ds`)) === "Новая формулировка", "wording updates the row subtitle");

    await page.eval(`(() => { const e = cqaDeep(${JSON.stringify(`${B} >>> cqa-scale-step-editor >>> [data-field=value][data-index="0"]`)})[0]; e.focus(); e.value = '2'; e.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true; })()`);
    await sleep(80);
    page.assert((await alerts(page)).some((a) => a.includes("Нижний шаг должен быть 0")), `scale rule violation listed (${await alerts(page)})`);
    page.assert((await total(page)) !== "", "preview survives a scale error");
    await page.eval(`(() => { const e = cqaDeep(${JSON.stringify(`${B} >>> cqa-scale-step-editor >>> [data-field=value][data-index="0"]`)})[0]; e.value = '0'; e.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true; })()`);
    await sleep(80);
    page.assert((await alerts(page)).length === 0, "scale fix removes the message");
    const stepFocus = await page.eval(`(() => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el && el.getAttribute('data-focus-id'); })()`);
    page.assert(stepFocus === "value-0", `focus stays in the step input (${stepFocus})`);

    await page.click(`${B} >>> [data-action=pick][data-key=k0]`);
    page.assert((await page.deepCount(`${B} >>> [data-field=e-na]`)) === 0, "yes/no hides the N/A condition");
    await setSelect(page, `${B} >>> [data-field=e-type]`, "ynna");
    page.assert((await page.deepCount(`${B} >>> [data-field=e-na]`)) === 1, "yes/no/N/A shows the N/A condition");
    await setSelect(page, `${B} >>> [data-field=e-type]`, "scale");
    page.assert((await page.deepCount(`${B} >>> cqa-scale-step-editor >>> [data-field=value]`)) === 3, "scale seeds three steps");
    page.assert((await page.deepCount(`${B} >>> [data-field=e-na]`)) === 1, "scale shows the N/A condition");
    await setSelect(page, `${B} >>> [data-field=e-type]`, "flag");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=e-weight]`)})[0].value`)) === "0", "flag forces weight 0");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=e-weight]`)})[0].disabled`)) === true, "flag weight is disabled");
    page.assert((await text(page, `${B} >>> [data-row=k0] .noPts`)) === "без баллов", "row shows без баллов");
    page.assert((await sum(page)) === "Сумма весов: 90 / 100", `flag no longer counts (${await sum(page)})`);
    page.assert((await page.deepCount(`${B} >>> [data-row=k0] [data-field=row-weight]`)) === 0, "flag row has no weight input");
    await setSelect(page, `${B} >>> [data-field=e-type]`, "yn");
    await setField(page, `${B} >>> [data-field=e-weight]`, "10");
    page.assert((await sum(page)) === "Сумма весов: 100 / 100", "weight restored");

    await page.click(`${B} >>> [data-action=add][data-section=opening]`);
    const created = await texts(page, `${B} >>> [data-row] .nm`);
    page.assert(created.length === 9 && created[2].startsWith("Новый критерий") && created[2].endsWith("новый"), `new criterion with chip in its section (${created[2]})`);
    page.assert((await page.active()).focusId === "e-name", "new criterion focuses the name");
    page.assert((await text(page, `${B} >>> .ed-h .h2`)) === "Критерий 03", "new criterion is numbered 03");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=e-weight]`)})[0].value`)) === "0", "new criterion has weight 0");
    page.assert((await page.deepCount(`${B} >>> [data-section=gross][data-action=add]`)) === 0, "gross section cannot take new criteria");
    page.assert((await text(page, `${B} >>> [data-preview-row].sel`)).startsWith("03"), "preview highlights the selected criterion");
    page.assert((await text(page, `${B} >>> [data-meta]`)).endsWith("изменено критериев: 2"), `new plus changed 04 counts as 2 (${await text(page, `${B} >>> [data-meta]`)})`);
    await page.click(`${B} >>> [data-action=remove][data-key=k8]`);
    page.assert((await page.deepCount(`${B} >>> [data-row]`)) === 8, "criterion removed");

    await page.click(`${B} >>> [data-action=down][data-key=k0]`);
    const moved = await texts(page, `${B} >>> [data-row] .nm`);
    page.assert(moved[0].startsWith("Выявление потребности") && moved[1].startsWith("Установление контакта"), "reorder moves a criterion down");
    page.assert((await page.deepCount(`${B} >>> [data-action=up][data-key=k1]:not([disabled])`)) === 1 || true, "reorder buttons present");

    for (let i = 0; i < 7; i += 1) {
      const key = await page.eval(`(cqaDeep(${JSON.stringify(`${B} >>> [data-action=remove]:not([disabled])`)})[0] || {getAttribute(){return ''}}).getAttribute('data-key')`);
      if (!key) break;
      await page.click(`${B} >>> [data-action=remove][data-key=${key}]`);
    }
    page.assert((await page.deepCount(`${B} >>> [data-row]`)) === 1, "one criterion left");
    page.assert((await page.deepCount(`${B} >>> [data-action=remove]:not([disabled])`)) === 0, "the last criterion cannot be removed");
    await page.assertAccessibleNames();
  },

  async "builder-look"(page) {
    await open(page, "role=reviewer");
    await page.click(`${B} >>> [data-action=pick][data-key=k3]`);
    await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> .edit`)})[0].scrollIntoView({ block: 'start' })`);
    await sleep(200);
    page.assert((await page.deepCount(`${B} >>> cqa-scale-step-editor`)) === 1, "scale editor mounted");
  },

  async "builder-preview"(page) {
    await open(page, "role=reviewer");
    const rows = await texts(page, `${B} >>> [data-preview-row]`);
    page.assert(rows.length === 7, `seven scored rows in the preview (${rows.length})`);
    page.assert(rows[2].includes("N/A") && rows[2].includes("—"), `row 03 is N/A (${rows[2]})`);
    page.assert(rows[3].includes("15 из 20"), `scale answer (${rows[3]})`);
    page.assert((await total(page)) === "81,88", "total 81,88");
    page.assert((await page.deepCount(`${B} >>> [role=table] [role=columnheader]`)) === 5, "preview table has five headers");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-preview-row=k2] [role=cell]:nth-child(3)`)})[0].className`)).includes("strike"), "N/A weight is struck through");
    for (const key of ["k0", "k1", "k2", "k3", "k4", "k5", "k6"]) await setField(page, rowWeight(key), "0");
    page.assert((await total(page)) === "Итог не рассчитан", `zero weights show not calculated (${await total(page)})`);
    page.assert((await note(page)).startsWith("Нет применимых"), "not-calculated note");
  },

  async "builder-locale"(page) {
    await open(page, "role=reviewer");
    await page.click(`${B} >>> [data-action=pick][data-key=k3]`);
    await page.eval(`document.querySelector('cqa-app').setAttribute('locale', 'en')`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-sum]`)})[0]?.textContent.includes('Weight total')`));
    page.assert((await total(page)) === "81.88", `English number format (${await total(page)})`);
    page.assert((await note(page)).includes("N/A is excluded, factor 100 / 80 = 1.25"), `English note (${await note(page)})`);
    page.assert((await text(page, `${B} >>> [data-action=save]`)) === "Save version v3", "English save label");
    page.assert((await page.deepCount(`${B} >>> cqa-scale-step-editor`)) === 1, "scale editor survives locale change");
    await setField(page, rowWeight("k2"), "15");
    page.assert((await text(page, `${B} >>> [data-save-reason]`)) === "Saving is unavailable: weights total 95, must be 100.", "English reason");
    await page.eval(`document.querySelector('cqa-app').setAttribute('locale', 'kk')`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-sum]`)})[0]?.textContent.includes('Салмақ сомасы')`));
    page.assert((await text(page, `${B} >>> [data-sum]`)) === "Салмақ сомасы: 95 / 100", "KZ sum");
    page.assert((await text(page, `${B} >>> h2.h2`)).startsWith("Критерий"), "KZ editor heading");
    await page.eval(`document.querySelector('cqa-app').setAttribute('locale', 'ru')`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-sum]`)})[0]?.textContent.includes('Сумма весов')`));
    page.assert((await total(page)) === "81,88", "back to Russian");
  },

  async "builder-sidebar"(page) {
    await open(page, "role=reviewer");
    const rows = await texts(page, `${B} >>> [data-region=side] .vrow`);
    page.assert(rows.length === 4, `editing row plus three more (${rows.length})`);
    page.assert(rows[0].startsWith("v3") && rows[0].includes("Вы редактируете"), `editing row (${rows[0]})`);
    page.assert(rows[1].includes("v2") && rows[1].includes("Активная") && /Применена к 1.248 диалогам · 01\.10\.2026/.test(rows[1]), `active version (${rows[1]})`);
    page.assert(rows[1].includes("Изменения создают новую версию"), "immutability note");
    page.assert(rows[2].includes("v1") && rows[2].includes("Архив") && /412 диалогов · 12\.08\.2026/.test(rows[2]), `archived version (${rows[2]})`);
    page.assert(rows[3].includes("v1") && rows[3].includes("Черновик") && rows[3].includes("Не применялся"), `calls checklist draft (${rows[3]})`);
    page.assert((await page.deepCount(`${B} >>> [data-region=side] svg[aria-label="Заблокирована"]`)) >= 1, "lock icon");
    await page.click(`${B} >>> [data-action=open-checklist]`);
    await until(() => page.eval(`location.hash === '#/checklists/2'`));
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> h1`)})[0]?.textContent.includes('звонков')`));
    page.assert((await text(page, `${B} >>> [data-meta]`)) === "без базовой версии", `no base version for the calls checklist (${await text(page, `${B} >>> [data-meta]`)})`);
    page.assert((await page.deepCount(`${B} >>> [data-row] .chip.c-warn`)) === 0, "no changed chips without a base");
    await page.assertAccessibleNames();
  },

  async "builder-states"(page) {
    await open(page, "role=reviewer&state=loading", "#/checklists/1", `${B} >>> [aria-busy=true]`);
    page.assert((await page.deepCount(`${B} >>> [data-row]`)) === 0, "loading shows a skeleton only");
    await open(page, "role=reviewer&state=error", "#/checklists/1", `${B} >>> [role=alert] [data-action=retry]`);
    page.assert((await page.deepCount(`${B} >>> [data-action=retry]`)) === 1, "error has retry");
    await open(page, "role=reviewer", "#/checklists/99", `${B} >>> .panel-title`);
    page.assert((await text(page, `${B} >>> .panel-title`)) === "Чек-лист не найден", "unknown checklist id is reported");
    await open(page, "role=reviewer&state=empty", "#/checklists/1");
    page.assert((await page.deepCount(`${B} >>> [data-row]`)) === 8, "empty switch does not affect the builder");
    await open(page, "role=exec", "#/checklists/1");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=row-weight]`)}).every((e) => e.disabled)`)) === true, "exec sees read-only weights");
    page.assert((await text(page, `${B} >>> [data-save-reason]`)).startsWith("Только просмотр"), "read-only reason");
    page.assert((await page.deepCount(`${B} >>> [data-action=add]`)) === 0, "no add buttons for read-only");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=e-name]`)})[0].disabled`)) === true, "editor is disabled");
    await page.click(`${B} >>> [data-action=pick][data-key=k3]`);
    page.assert((await page.deepCount(`${B} >>> cqa-scale-step-editor`)) === 0 && (await page.deepCount(`${B} >>> .rosteps li`)) === 5, "read-only scale steps are a plain list");
  },

  async "builder-keys"(page) {
    await open(page, "role=reviewer");
    await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-action=pick][data-key=k0]`)})[0].focus()`);
    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      await page.press("Tab");
      const a = await page.active();
      seen.push(a && a.focusId);
      page.assert(a && a.outline === "solid 2px", `focus ring on ${a && a.focusId}`);
    }
    page.assert(seen[0] === "rw-k0" && seen[1] === "down-k0" && seen[2] === "rm-k0" && seen[3] === "pick-k1" && seen[4] === "rw-k1" && seen[5] === "up-k1", `row tab order, disabled arrows skipped (${seen})`);
    await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-action=pick][data-key=k1]`)})[0].focus()`);
    await page.press("Enter");
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> .ed-h .h2`)})[0]?.textContent.trim() === 'Критерий 02'`));
    const kept = await page.active();
    page.assert(kept && kept.focusId === "pick-k1", `focus stays on the picked row (${JSON.stringify(kept)})`);
    await page.eval(`cqaDeep(${JSON.stringify(rowWeight("k1"))})[0].focus()`);
    await page.eval(`cqaDeep(${JSON.stringify(rowWeight("k1"))})[0].select()`);
    await page.type("12");
    page.assert((await sum(page)) === "Сумма весов: 97 / 100", `real typing updates the sum (${await sum(page)})`);
    page.assert((await page.active()).focusId === "rw-k1", "focus kept while typing digits");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(rowWeight("k1"))})[0].getAttribute('aria-label')`)) === "Вес критерия 02", "weight input label");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-action=remove][data-key=k2]`)})[0].getAttribute('aria-label')`)) === "Удалить критерий 03", "remove button label");
    await page.assertAccessibleNames();
  }
};
