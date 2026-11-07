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
  await page.eval(`setTimeout(() => { location.href = new URL('index.html?mock=1&${marker}${query ? "&" + query : ""}${hash}', location.href).href; }, 0); true`);
  await until(() => page.eval(`location.search.includes(${JSON.stringify(marker)}) && document.readyState === 'complete'`));
  await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-row]`)}).length > 0`));
}

const texts = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)}).map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
const text = async (page, selector) => (await texts(page, selector))[0];
const value = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)})[0].value`);
const attr = (page, selector, name) => page.eval(`cqaDeep(${JSON.stringify(selector)})[0].getAttribute(${JSON.stringify(name)})`);
const disabled = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)})[0].disabled`);
const names = (page) => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=sec-name]`)}).map((e) => e.value)`);
const sumText = (page) => text(page, `${B} >>> [data-sum]`);
const alerts = (page) => texts(page, `${B} >>> [data-alerts] span`);
const warnings = (page) => texts(page, `${B} >>> [data-warnings] span`);
const saveOff = (page) => disabled(page, `${B} >>> [data-action=save]`);
const confirmOpen = (page) => page.eval(`${APP}.querySelector('[data-confirm]').hasAttribute('open')`);
const nameField = (id) => `${B} >>> [data-field=sec-name][data-section=${id}]`;
const weightField = (id) => `${B} >>> [data-field=sec-weight][data-section=${id}]`;
const rowWeight = (key) => `${B} >>> [data-field=row-weight][data-key=${key}]`;
const rowNames = (page) => texts(page, `${B} >>> [data-row] .nm`);

async function setField(page, selector, text, event = "input") {
  await page.eval(`(() => {
    const el = cqaDeep(${JSON.stringify(selector)})[0];
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true, composed: true }));
    return true;
  })()`);
  await sleep(50);
}

const pencil = (id) => `${B} >>> [data-action=toggle-section][data-section=${id}]`;
const IDS = ["opening", "security", "conduct", "gross"];

async function openSecs(page, ...ids) {
  for (const id of ids) {
    if ((await attr(page, pencil(id), "aria-expanded")) !== "true") await page.click(pencil(id));
  }
  await sleep(50);
}

const parseHundredthsOf = (text) => Math.round(Number(String(text).replace(",", ".")) * 100);

const confirmDesc = (page) => page.eval(`(${APP}.querySelector('[data-confirm]').getAttribute('description') || '')`);

const raw = {
  async "builder-sections"(page) {
    await open(page, "role=reviewer");
    page.assert((await page.deepCount(`${B} >>> [data-field=sec-name]`)) === 0 && (await page.deepCount(`${B} >>> [data-field=sec-weight]`)) === 0, "sections are read-only by default");
    page.assert((await text(page, `${B} >>> [data-section-weight=security]`)) === "вес раздела 40", "default look shows the derived weight as text");
    page.assert((await attr(page, pencil("opening"), "aria-label")) === "Редактировать раздел «Начало и понимание запроса»" && (await attr(page, pencil("opening"), "aria-expanded")) === "false", "pencil is labelled and collapsed");
    await openSecs(page, ...IDS);
    page.assert(JSON.stringify(await names(page)) === JSON.stringify(["Начало и понимание запроса", "Безопасность и решение", "Ведение и завершение диалога", "Грубые нарушения"]), `section names editable (${await names(page)})`);
    page.assert((await attr(page, nameField("opening"), "aria-label")) === "Название раздела 1", "name field is labelled");
    page.assert((await page.deepCount(`${B} >>> .sech-t`)) === 4, "four section headings");
    page.assert((await value(page, weightField("opening"))) === "25" && (await value(page, weightField("security"))) === "40" && (await value(page, weightField("conduct"))) === "35", "section weights are the derived sums");
    page.assert((await disabled(page, weightField("gross"))) === true, "flag-only section: weight disabled");
    page.assert((await text(page, `${B} >>> [data-sec-hint=weight]`)).includes("нет критериев с баллами"), "explanatory hint for the disabled weight");
    page.assert((await attr(page, weightField("opening"), "aria-label")) === "Вес раздела «Начало и понимание запроса»", "weight field is labelled");

    await setField(page, nameField("opening"), "Старт диалога");
    page.assert((await page.active()).focusId === "sn-opening", "typing a name keeps focus");
    page.assert((await text(page, `${B} >>> [data-section-id=opening] .chip`)) === "изменён", "renamed section is marked изменён");
    page.assert((await text(page, `${B} >>> .ed-h .dim12`)) === "Старт диалога", "editor header follows the new name");
    page.assert((await text(page, `${B} >>> [data-meta]`)) === "на основе v2 · изменено критериев: 0", "criteria counter untouched by a rename");
    await setField(page, nameField("opening"), "безопасность и РЕШЕНИЕ");
    page.assert((await alerts(page)).includes("Повторяется название раздела «Безопасность и решение»."), `duplicate name (${await alerts(page)})`);
    page.assert((await attr(page, nameField("opening"), "aria-invalid")) === "true", "aria-invalid on the duplicate");
    page.assert((await text(page, `${B} >>> [data-section-id=opening] [data-sec-error=name]`)) === "Раздел с таким названием уже есть.", "inline error");
    page.assert((await saveOff(page)) === true, "duplicate name blocks save");
    await setField(page, nameField("opening"), "   ");
    page.assert((await alerts(page)).includes("У раздела 1 нет названия."), `empty name (${await alerts(page)})`);
    page.assert((await saveOff(page)) === true, "empty name blocks save");
    await setField(page, nameField("opening"), "Старт диалога");
    page.assert((await alerts(page)).length === 0 && (await saveOff(page)) === false, "fixed name unblocks save");

    await setField(page, weightField("security"), "33,33");
    page.assert((await page.active()).focusId === "sw-security", "typing a section weight keeps focus");
    page.assert((await value(page, rowWeight("k2"))) === "16,67" && (await value(page, rowWeight("k3"))) === "16,66", `criteria scaled with remainder to the first (${await value(page, rowWeight("k2"))} / ${await value(page, rowWeight("k3"))})`);
    page.assert((await sumText(page)) === "Сумма весов: 93,33 / 100", `global pill follows (${await sumText(page)})`);
    page.assert((await saveOff(page)) === true, "sum != 100 blocks save");
    page.assert((await text(page, `${B} >>> [data-preview-row=k2]`)).length > 0, "preview still renders");
    await setField(page, weightField("security"), "abc");
    page.assert((await attr(page, weightField("security"), "aria-invalid")) === "true", "bad section weight is aria-invalid");
    page.assert((await alerts(page)).some((a) => a.startsWith("Вес раздела «Безопасность и решение» должен быть числом")), `bad section weight reported (${await alerts(page)})`);
    page.assert((await value(page, weightField("security"))) === "abc", "typed text is not overwritten");
    await setField(page, weightField("security"), "40");
    await setField(page, weightField("security"), "40", "change");
    page.assert((await sumText(page)) === "Сумма весов: 100 / 100" && (await saveOff(page)) === false, "back to 100 enables save");
    const k2 = parseHundredthsOf(await value(page, rowWeight("k2")));
    const k3 = parseHundredthsOf(await value(page, rowWeight("k3")));
    page.assert(k2 + k3 === 4000 && k2 >= 1990 && k2 <= 2010, `rescaling to 40 sums to exactly 40 (${k2}, ${k3})`);
    await setField(page, rowWeight("k2"), "20");
    await setField(page, rowWeight("k3"), "20");
    await setField(page, rowWeight("k2"), "25");
    page.assert((await value(page, weightField("security"))) === "45", "section weight follows individual criteria edits");
    await setField(page, rowWeight("k2"), "20");
    page.assert((await text(page, `${B} >>> [data-meta]`)) === "на основе v2 · изменено критериев: 0", "restoring the original weights to the original leaves no changed criteria");

    await setField(page, weightField("conduct"), "0");
    page.assert((await value(page, rowWeight("k4"))) === "0" && (await value(page, rowWeight("k5"))) === "0" && (await value(page, rowWeight("k6"))) === "0", "weight 0 zeroes the section");
    await setField(page, weightField("conduct"), "35");
    page.assert((await value(page, rowWeight("k4"))) === "11,67" && (await value(page, rowWeight("k5"))) === "11,67" && (await value(page, rowWeight("k6"))) === "11,66", `all-zero section splits equally (${await value(page, rowWeight("k4"))}, ${await value(page, rowWeight("k5"))}, ${await value(page, rowWeight("k6"))})`);
    page.assert((await sumText(page)) === "Сумма весов: 100 / 100", "sum stays exactly 100");

    await page.click(`${B} >>> [data-action=add-section]`);
    page.assert(JSON.stringify((await names(page)).slice(-1)) === JSON.stringify(["Новый раздел 5"]), `new section default name (${await names(page)})`);
    page.assert((await page.active()).focusId.startsWith("sn-section-"), "new section name is focused");
    page.assert((await text(page, `${B} >>> [data-section-id^=section-] .chip`)) === "новый", "new section is marked новый");
    page.assert((await warnings(page)).some((w) => w.includes("Раздел «Новый раздел 5» пуст")), `empty section warning (${await warnings(page)})`);
    page.assert((await saveOff(page)) === false, "an empty section does not block save");
    page.assert((await disabled(page, `${B} >>> [data-field=sec-weight][data-section^=section-]`)) === true, "empty section: weight disabled");
    const newId = await attr(page, `${B} >>> [data-field=sec-name][data-section^=section-]`, "data-section");
    await page.click(`${B} >>> [data-action=add][data-section=${newId}]`);
    page.assert((await page.deepCount(`${B} >>> [data-warnings]`)) === 0, "warning disappears once the section has a criterion");
    page.assert((await disabled(page, weightField(newId))) === false, "weight field active once a scored criterion exists");
    await setField(page, weightField(newId), "0");
    page.assert((await sumText(page)) === "Сумма весов: 100 / 100", "sum unchanged by a zero section");
    await page.click(`${B} >>> [data-action=remove-section][data-section=${newId}]`);
    await sleep(200);
    page.assert((await confirmOpen(page)) === true, "deleting a section with criteria asks for confirmation");
    const info = await page.eval(`(() => ({ title: ${APP}.querySelector('[data-confirm]').getAttribute('heading'), ok: ${APP}.querySelector('[data-confirm-ok]').textContent, cancel: ${APP}.querySelector('[data-confirm-cancel]').textContent, desc: ${APP}.querySelector('[data-confirm]').getAttribute('description') || '' }))()`);
    page.assert(info.title === "Удалить раздел «Новый раздел 5»?" && info.ok === "Удалить раздел" && info.cancel === "Отмена" && info.desc.includes("удалён 1 критерий"), `confirm texts (${JSON.stringify(info)})`);
    await page.eval(`${APP}.querySelector('[data-confirm-ok]').click()`);
    await until(async () => (await names(page)).length === 4);

    await page.click(`${B} >>> [data-action=add-section]`);
    const emptyId = await attr(page, `${B} >>> [data-field=sec-name][data-section^=section-]`, "data-section");
    page.assert(emptyId !== newId, `a deleted id is not reused (${newId} -> ${emptyId})`);
    await page.click(`${B} >>> [data-action=remove-section][data-section=${emptyId}]`);
    await sleep(200);
    page.assert(!(await confirmOpen(page)) && (await names(page)).length === 4, "an empty section is deleted without confirmation");

    await page.click(`${B} >>> [data-action=section-down][data-section=opening]`);
    page.assert(JSON.stringify((await names(page)).slice(0, 2)) === JSON.stringify(["Безопасность и решение", "Старт диалога"]), `section moved down (${await names(page)})`);
    const movedRows = await rowNames(page);
    page.assert(movedRows[0].startsWith("Идентификация") && movedRows[1].startsWith("Корректная") && movedRows[2].startsWith("Установление контакта") && movedRows[3].startsWith("Выявление потребности"), `criteria moved together with their section (${movedRows})`);
    page.assert((await page.active()).focusId === "sdown-opening", "focus stays on the move button");
    page.assert((await disabled(page, `${B} >>> [data-action=section-up][data-section=security]`)) === true, "first section cannot move up");
    page.assert((await disabled(page, `${B} >>> [data-action=section-down][data-section=gross]`)) === true, "last section cannot move down");
    const reordered = await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-row] .tnum.dim`)}).map((e) => e.textContent.trim()).join()`);
    page.assert(reordered === "01,02,03,04,05,06,07,08", `numbering follows the new order (${reordered})`);

    await page.click(`${B} >>> [data-action=remove-section][data-section=conduct]`);
    await until(() => confirmOpen(page));
    const desc = await confirmDesc(page);
    page.assert(desc.includes("Вместе с разделом будут удалены 3 критерия"), `confirm counts the criteria (${desc})`);
    await page.eval(`${APP}.querySelector('[data-confirm-cancel]').click()`);
    await until(async () => !(await confirmOpen(page)));
    page.assert((await names(page)).length === 4 && (await page.deepCount(`${B} >>> [data-row]`)) === 8, "cancel keeps the section");
    await page.click(`${B} >>> [data-action=pick][data-key=k5]`);
    await page.click(`${B} >>> [data-action=remove-section][data-section=conduct]`);
    await until(() => confirmOpen(page));
    await page.eval(`${APP}.querySelector('[data-confirm-ok]').click()`);
    await until(async () => (await page.deepCount(`${B} >>> [data-row]`)) === 5);
    page.assert((await names(page)).length === 3, "section deleted with its criteria");
    page.assert((await sumText(page)) === "Сумма весов: 65 / 100", `pill follows the deletion (${await sumText(page)})`);
    page.assert((await alerts(page)).includes("Сумма весов должна быть 100, сейчас 65."), "alert follows the deletion");
    page.assert((await page.deepCount(`${B} >>> [data-row].sel`)) === 1, "selection moved to a surviving criterion");
    page.assert((await text(page, `${B} >>> [data-meta]`)).endsWith("изменено критериев: 3"), `removed criteria are counted (${await text(page, `${B} >>> [data-meta]`)})`);
    await setField(page, weightField("security"), "75");
    page.assert((await sumText(page)) === "Сумма весов: 100 / 100" && (await saveOff(page)) === false, "weights fixed after deletion");

    await page.click(`${B} >>> [data-action=remove-section][data-section=gross]`);
    await sleep(200);
    page.assert((await confirmOpen(page)) === true, "flag section has a criterion and asks");
    await page.eval(`${APP}.querySelector('[data-confirm-ok]').click()`);
    await until(async () => (await names(page)).length === 2);
    await page.click(`${B} >>> [data-action=remove-section][data-section=opening]`);
    await until(() => confirmOpen(page));
    await page.eval(`${APP}.querySelector('[data-confirm-ok]').click()`);
    await until(async () => (await names(page)).length === 1);
    page.assert((await page.deepCount(`${B} >>> [data-action=remove-section]:not([disabled])`)) === 0, "the last section cannot be deleted");
    page.assert((await text(page, `${B} >>> [data-sec-hint=delete]`)).startsWith("Нельзя удалить"), "hint explains why");
    await page.assertAccessibleNames();
  },

  async "builder-sections-save"(page) {
    await open(page, "role=reviewer");
    await openSecs(page, "conduct", "security");
    await setField(page, nameField("conduct"), "Завершение");
    await page.click(`${B} >>> [data-action=add-section]`);
    const id = await attr(page, `${B} >>> [data-field=sec-name][data-section^=section-]`, "data-section");
    await page.click(`${B} >>> [data-action=add][data-section=${id}]`);
    await setField(page, weightField(id), "10");
    await setField(page, weightField("security"), "30");
    await page.click(`${B} >>> [data-action=section-up][data-section=${id}]`);
    page.assert((await saveOff(page)) === false, "valid after the edits");
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await text(page, `${B} >>> [data-chip=status]`)).startsWith("Сохранена"));
    const saved = await page.eval(`(async () => {
      const m = await import(new URL('src/api.js', location.href).href);
      const lists = await m.api.listChecklists();
      const v = lists[0].versions.find((x) => x.status === 'saved' && x.version === 3);
      const full = await m.api.getChecklistVersion(v.id);
      return { sections: full.config.sections.map((s) => s.id + ':' + s.title), criteria: full.config.criteria.map((c) => c.id + ':' + c.section + ':' + c.weight) };
    })()`);
    page.assert(saved.sections.length === 5 && saved.sections[0] === "opening:Начало и понимание запроса" && saved.sections[1] === "security:Безопасность и решение" && saved.sections[2] === "conduct:Завершение" && saved.sections[4] === "gross:Грубые нарушения", `saved sections in UI order (${saved.sections})`);
    page.assert(saved.sections[3] === `${id}:Новый раздел 5`, "new section saved");
    page.assert(saved.criteria.some((c) => c.endsWith(`:${id}:10`)), `new criterion saved with the section (${saved.criteria})`);
    page.assert(saved.criteria.filter((c) => c.includes(":security:")).reduce((a, c) => a + Number(c.split(":")[2]), 0) === 30, "scaled weights saved");
    await page.assertAccessibleNames();
  },

  async "builder-sections-readonly"(page) {
    await open(page, "role=exec");
    page.assert((await page.deepCount(`${B} >>> [data-field=sec-name]`)) === 0, "no name inputs for a read-only role");
    page.assert((await page.deepCount(`${B} >>> [data-action=add-section]`)) === 0, "no add-section for a read-only role");
    page.assert((await page.deepCount(`${B} >>> [data-action=remove-section], ${B} >>> [data-action=section-up]`)) === 0, "no section controls");
    page.assert((await text(page, `${B} >>> [data-section-weight=security]`)) === "вес раздела 40", "weight shown as text");
    page.assert((await text(page, `${B} >>> .sech-t`)) === "Начало и понимание запроса", "name shown as heading text");
    page.assert((await page.deepCount(`${B} >>> [data-action=toggle-section]`)) === 0, "no pencil for a read-only role");
  },

  async "builder-sections-keys"(page) {
    await open(page, "role=reviewer");
    await openSecs(page, "opening");
    await page.eval(`cqaDeep(${JSON.stringify(nameField("opening"))})[0].focus()`);
    const seen = [];
    for (let i = 0; i < 8; i += 1) {
      await page.press("Tab");
      const a = await page.active();
      seen.push(a && a.focusId);
      page.assert(a && a.outline === "solid 2px", `focus ring on ${a && a.focusId}`);
    }
    page.assert(seen.join() === "edit-opening,sw-opening,sdown-opening,rms-opening,done-opening,add-opening,pick-k0,rw-k0", `section tab order (${seen})`);
    await page.eval(`cqaDeep(${JSON.stringify(nameField("opening"))})[0].select()`);
    await page.type("Раздел А");
    page.assert((await value(page, nameField("opening"))) === "Раздел А", "real typing renames");
    await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-action=section-down][data-section=opening]`)})[0].focus()`);
    await page.press("Enter");
    await sleep(100);
    const order = await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> .sech`)}).map((e) => e.getAttribute('data-section-id')).join()`);
    page.assert(order === "security,opening,conduct,gross", `Enter on the move button moves the section (${order})`);
    await page.assertAccessibleNames();
  },

  async "builder-sections-toggle"(page) {
    await open(page, "role=reviewer");
    page.assert((await page.deepCount(`${B} >>> [data-action=done-section]`)) === 0, "no Done button in the default look");
    await page.click(pencil("security"));
    page.assert((await attr(page, pencil("security"), "aria-expanded")) === "true", "pencil reports expanded");
    page.assert((await page.active()).focusId === "sn-security", "opening focuses the name input");
    page.assert((await page.deepCount(`${B} >>> [data-field=sec-name]`)) === 1, "only the edited section shows inputs");
    await openSecs(page, "conduct");
    page.assert((await page.deepCount(`${B} >>> [data-field=sec-name]`)) === 2, "several sections can be open");
    await page.click(`${B} >>> [data-action=done-section][data-section=conduct]`);
    page.assert((await attr(page, pencil("conduct"), "aria-expanded")) === "false" && (await page.deepCount(`${B} >>> [data-field=sec-name]`)) === 1, "Done collapses the section");
    page.assert((await page.active()).focusId === "edit-conduct", "closing returns focus to the pencil");
    await page.eval(`cqaDeep(${JSON.stringify(pencil("conduct"))})[0].focus()`);
    await page.press("Enter");
    await sleep(100);
    page.assert((await page.active()).focusId === "sn-conduct", "Enter on the pencil opens the section");
    await page.press("Escape");
    await sleep(100);
    page.assert((await attr(page, pencil("conduct"), "aria-expanded")) === "false" && (await page.active()).focusId === "edit-conduct", "Escape collapses and returns focus");
    await setField(page, nameField("security"), "");
    page.assert((await attr(page, nameField("security"), "aria-invalid")) === "true", "invalid name shown");
    await page.click(`${B} >>> [data-action=done-section][data-section=security]`);
    await page.click(pencil("security"));
    page.assert((await page.deepCount(nameField("security"))) === 1 && (await attr(page, pencil("security"), "aria-expanded")) === "true", "an invalid section cannot collapse");
    page.assert((await attr(page, pencil("security"), "aria-disabled")) === "true", "pencil is aria-disabled while invalid");
    page.assert((await text(page, `${B} >>> [data-section-id=security] [data-sec-hint=keep-open]`)).length > 0, "reason is shown");
    await page.press("Escape");
    page.assert((await page.deepCount(nameField("security"))) === 1, "Escape does not collapse an invalid section");
    await setField(page, nameField("security"), "Безопасность");
    await page.click(`${B} >>> [data-action=done-section][data-section=security]`);
    page.assert((await page.deepCount(`${B} >>> [data-field=sec-name]`)) === 0, "valid section collapses");
    page.assert((await text(page, `${B} >>> [data-section-id=security] .sech-t`)) === "Безопасность", "collapsed heading shows the new name");
    page.assert((await text(page, `${B} >>> [data-section-id=security] .chip`)) === "изменён", "изменён badge in the default look");
    await page.click(`${B} >>> [data-action=add-section]`);
    page.assert((await page.active()).focusId.startsWith("sn-section-"), "new section opens with its name focused");
    const sel = await page.eval(`(() => { const a = cqaDeep(${JSON.stringify(`${B} >>> [data-field=sec-name][data-section^=section-]`)})[0]; return a.selectionStart === 0 && a.selectionEnd === a.value.length; })()`);
    page.assert(sel === true, "new section name is selected");
    await page.click(`${B} >>> [data-action=done-section][data-section^=section-]`);
    page.assert((await text(page, `${B} >>> [data-section-id^=section-] [data-sec-hint=empty]`)).includes("пуст"), "empty-section note shows in the default look");
    page.assert((await text(page, `${B} >>> [data-section-id^=section-] .chip`)) === "новый", "новый badge in the default look");
    await page.assertAccessibleNames();
  },

  async "builder-sections-i18n"(page) {
    await open(page, "role=reviewer&locale=en");
    page.assert((await attr(page, pencil("opening"), "aria-label")).startsWith("Edit section "), "EN pencil label");
    await openSecs(page, "opening", "security", "conduct");
    page.assert((await text(page, `${B} >>> [data-action=done-section][data-section=opening]`)) === "Done", "EN Done");
    page.assert((await attr(page, nameField("opening"), "aria-label")) === "Name of section 1", "EN name label");
    page.assert((await text(page, `${B} >>> [data-action=add-section]`)) === "Add section", "EN add section");
    await page.click(`${B} >>> [data-action=add-section]`);
    page.assert((await names(page)).slice(-1)[0] === "New section 5", "EN default name");
    page.assert((await warnings(page))[0] === "Section \"New section 5\" is empty and does not affect the score.", `EN warning (${await warnings(page)})`);
    await setField(page, nameField("security"), "new section 5");
    page.assert((await alerts(page)).includes("The section name \"New section 5\" is repeated."), `EN duplicate (${await alerts(page)})`);
    await setField(page, nameField("security"), "Security");
    await page.click(`${B} >>> [data-action=remove-section][data-section=conduct]`);
    await until(() => confirmOpen(page));
    const en = await confirmDesc(page);
    page.assert(en.includes("3 criteria will be deleted with the section"), `EN confirm (${en})`);
    await page.eval(`${APP}.querySelector('[data-confirm-cancel]').click()`);
    await until(async () => !(await confirmOpen(page)));
    await open(page, "role=reviewer&locale=kk");
    page.assert((await attr(page, pencil("opening"), "aria-label")).endsWith("бөлімін өңдеу"), "KZ pencil label");
    await openSecs(page, "opening", "conduct");
    page.assert((await text(page, `${B} >>> [data-action=done-section][data-section=opening]`)) === "Дайын", "KZ Done");
    page.assert((await text(page, `${B} >>> [data-action=add-section]`)) === "Бөлім қосу", "KZ add section");
    page.assert((await attr(page, nameField("opening"), "aria-label")) === "1-бөлімнің атауы", "KZ name label");
    await page.click(`${B} >>> [data-action=remove-section][data-section=conduct]`);
    await until(() => confirmOpen(page));
    const kk = await confirmDesc(page);
    page.assert(kk.includes("Бөліммен бірге 3 критерий жойылады"), `KZ confirm (${kk})`);
    await page.eval(`${APP}.querySelector('[data-confirm-cancel]').click()`);
    await until(async () => !(await confirmOpen(page)));
    await page.assertAccessibleNames();
  },

  async "builder-sections-look"(page) {
    await open(page, "role=reviewer");
    await openSecs(page, "opening", "security", "conduct");
    await setField(page, nameField("opening"), "Старт диалога");
    await setField(page, weightField("security"), "33,33");
    await page.click(`${B} >>> [data-action=add-section]`);
    await setField(page, nameField("conduct"), "Старт диалога");
    await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> .structure`)})[0].scrollIntoView({ block: 'start' })`);
    await sleep(200);
    page.assert((await page.deepCount(`${B} >>> [data-warnings]`)) === 1 && (await page.deepCount(`${B} >>> [data-alerts]`)) === 1, "errors and warnings both visible");
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
