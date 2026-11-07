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
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition: " + String(fn).slice(0, 140));
    await sleep(step);
  }
}

async function open(page, query, hash = "#/checklists/1") {
  await page.eval(`(() => { const b = cqaDeep(${JSON.stringify(B)})[0]; if (b) b._dirty = false; return true; })()`).catch(() => null);
  const marker = `m=${Math.random().toString(36).slice(2, 8)}`;
  await page.eval(`setTimeout(() => { location.href = new URL('index.html?mock=1&${marker}${query ? "&" + query : ""}${hash}', location.href).href; }, 0); true`);
  await until(() => page.eval(`location.search.includes(${JSON.stringify(marker)}) && document.readyState === 'complete'`));
  await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-region=side] .vrow`)}).length > 0`));
}

const texts = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)}).map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
const text = async (page, selector) => (await texts(page, selector))[0];
const disabled = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)})[0].disabled`);
const count = (page, selector) => page.deepCount(selector);
const toasts = (page) => texts(page, "cqa-app >>> cqa-toast >>> .msg-text");
const confirmOpen = (page) => page.eval(`${APP}.querySelector('[data-confirm]').hasAttribute('open')`);
const rowsText = (page) => texts(page, `${B} >>> [data-region=side] .vrow`);
const chipText = (page) => text(page, `${B} >>> [data-chip=status]`);
const dirty = (page) => page.eval(`cqaDeep(${JSON.stringify(B)})[0]._dirty`);
const attr = (page, selector, name) => page.eval(`cqaDeep(${JSON.stringify(selector)})[0].getAttribute(${JSON.stringify(name)})`);
const value = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)})[0].value`);

const versionBtn = (id) => `${B} >>> [data-version-row="${id}"] [data-action=open-version]`;
const actBtn = `${B} >>> [data-action=save-draft]`;
const rowWeight = (key) => `${B} >>> [data-field=row-weight][data-key=${key}]`;

async function setField(page, selector, text) {
  await page.eval(`(() => {
    const el = cqaDeep(${JSON.stringify(selector)})[0];
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return true;
  })()`);
  await sleep(60);
}

async function editName(page, text) {
  await page.click(`${B} >>> [data-action=pick][data-key=k3]`);
  await setField(page, `${B} >>> [data-field=e-name]`, text);
}

async function serverLists(page) {
  return page.eval(`(async () => {
    const m = await import(new URL('src/api.js', location.href).href);
    return (await m.api.listChecklists()).map((c) => ({ id: c.id, name: c.name, channels: c.channels, defaultVersionId: c.defaultVersionId, versions: c.versions.map((v) => ({ id: v.id, version: v.version, status: v.status, weightSum: v.weightSum, criteriaCount: v.criteriaCount })) }));
  })()`);
}

async function serverConfig(page, id) {
  return page.eval(`(async () => {
    const m = await import(new URL('src/api.js', location.href).href);
    return (await m.api.getChecklistVersion(${id})).config;
  })()`);
}

async function leaveAndReturn(page, hash) {
  await page.eval(`location.hash = '#/overview'; true`);
  await until(() => page.eval(`location.hash === '#/overview' && cqaDeep('cqa-app >>> cqa-overview').length > 0`));
  await page.eval(`location.hash = ${JSON.stringify(hash)}; true`);
  await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-region=side] .vrow`)}).length > 0`));
}

async function answerConfirm(page, which) {
  await until(() => confirmOpen(page));
  await page.eval(`${APP}.querySelector('[data-confirm-${which}]').click()`);
  await until(async () => !(await confirmOpen(page)));
}

const raw = {
  async "builder-drafts-save"(page) {
    await open(page, "role=reviewer");
    page.assert((await disabled(page, actBtn)) === true, "save draft is disabled while nothing changed");
    page.assert((await count(page, `${B} >>> [data-action=delete-draft]`)) === 1, "a server draft offers Discard draft");
    await editName(page, "Черновая формулировка");
    await setField(page, rowWeight("k0"), "5");
    page.assert((await disabled(page, actBtn)) === false, "save draft is enabled with unsaved edits");
    page.assert((await disabled(page, `${B} >>> [data-action=save]`)) === true, "save version stays blocked while weights are not 100");
    page.assert((await text(page, `${B} >>> [data-save-reason]`)).includes("Сохранение недоступно"), "save version explains why it is blocked");
    page.assert((await dirty(page)) === true, "edits are unsaved");
    await page.click(actBtn);
    await until(async () => (await toasts(page)).includes("Черновик сохранён · не применён"));
    page.assert((await dirty(page)) === false, "the unsaved-changes guard is cleared after a draft save");
    page.assert((await disabled(page, actBtn)) === true, "save draft is disabled again after saving");
    page.assert((await disabled(page, `${B} >>> [data-action=apply]`)) === true, "apply stays disabled for a draft");
    page.assert((await text(page, `${B} >>> [data-apply-reason]`)).includes("Черновик нельзя применить"), "the reason is stated inline instead of a failing button");
    page.assert((await chipText(page)) === "Черновик v3", `still a draft (${await chipText(page)})`);
    const server = await serverLists(page);
    const v3 = server[0].versions.find((v) => v.version === 3);
    page.assert(v3.status === "draft" && v3.weightSum === 95, `server holds the draft with weights 95 (${JSON.stringify(v3)})`);
    page.assert(server[0].defaultVersionId === 12, "active version untouched");
    await leaveAndReturn(page, "#/checklists/1");
    page.assert(!(await confirmOpen(page)), "no guard after a draft save");
    page.assert((await value(page, rowWeight("k0"))) === "5", "weight survives leaving and coming back");
    await page.click(`${B} >>> [data-action=pick][data-key=k3]`);
    page.assert((await value(page, `${B} >>> [data-field=e-name]`)) === "Черновая формулировка", "name survives");
    page.assert((await text(page, `${B} >>> [data-sum]`)).includes("95"), "sum 95 survives");
    const rows = await rowsText(page);
    page.assert(rows[0].startsWith("v3") && rows[0].includes("Черновик"), "sidebar lists the draft");
    await page.click(`${B} >>> [data-action=delete-draft]`);
    await until(() => confirmOpen(page));
    page.assert((await attr(page, "cqa-app >>> [data-confirm]", "heading")) === "Отбросить черновик v3?", "delete asks first");
    await answerConfirm(page, "ok");
    await until(async () => (await toasts(page)).includes("Черновик v3 удалён."));
    await until(async () => (await serverLists(page))[0].versions.length === 2);
    page.assert((await serverLists(page))[0].versions.every((v) => v.status !== "draft"), "the draft is gone from the server");
  },

  async "builder-drafts-memory"(page) {
    await open(page, "role=reviewer");
    await editName(page, "Первая правка");
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await chipText(page)) === "Сохранена v3");
    await setField(page, `${B} >>> [data-field=e-name]`, "Вторая правка");
    await until(async () => (await chipText(page)) === "Черновик v4");
    page.assert((await count(page, `${B} >>> [data-version-row=new]`)) === 1, "unsaved edit of a saved version is an in-memory v4");
    page.assert((await disabled(page, actBtn)) === false, "save draft is enabled for it");
    page.assert((await count(page, `${B} >>> [data-action=delete-draft]`)) === 0, "nothing to discard on the server yet");
    await page.click(actBtn);
    await until(async () => (await toasts(page)).includes("Черновик сохранён · не применён"));
    const server = await serverLists(page);
    const v4 = server[0].versions.find((v) => v.version === 4);
    page.assert(v4 && v4.status === "draft", `v4 persisted as a draft (${JSON.stringify(server[0].versions)})`);
    page.assert((await count(page, `${B} >>> [data-version-row=new]`)) === 0, "the row now has a server id");
    page.assert(server[0].versions.find((v) => v.version === 3).status === "saved", "v3 stays saved");
    await setField(page, `${B} >>> [data-field=e-name]`, "Третья правка");
    await page.click(actBtn);
    await until(async () => (await toasts(page)).length >= 1 && (await disabled(page, actBtn)) === true);
    const cfg = await serverConfig(page, v4.id);
    page.assert(cfg.criteria.find((c) => c.id === "04").title === "Третья правка", "second save updates the same draft");
    page.assert((await serverLists(page))[0].versions.length === 4, "no duplicate drafts");
    await page.click(`${B} >>> [data-action=add-section]`);
    await sleep(80);
    await page.click(actBtn);
    await until(async () => (await disabled(page, actBtn)) === true);
    const cfg2 = await serverConfig(page, v4.id);
    page.assert(cfg2.sections.length === 5 && !cfg2.criteria.some((c) => c.section === cfg2.sections[4].id), "an empty section is accepted in a draft");
  },

  async "builder-drafts-versions"(page) {
    await open(page, "role=reviewer");
    await page.click(versionBtn(12));
    await until(async () => (await chipText(page)) === "v2 · Активная");
    const banner = await text(page, `${B} >>> [data-view-banner]`);
    page.assert(banner.includes("Просмотр v2 · Активная.") && /1.248 диалогам · 01\.10\.2026/.test(banner), `banner names version, status, applied (${banner})`);
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=row-weight]`)}).every((e) => e.disabled)`)) === true, "active version is read-only");
    page.assert((await attr(page, versionBtn(12), "aria-current")) === "true", "viewed row has aria-current");
    page.assert((await count(page, `${B} >>> [data-version-row="11"] [aria-current]`)) === 0, "other rows do not");
    page.assert((await count(page, `${B} >>> [data-active-marker]`)) === 1 && (await count(page, `${B} >>> [data-view-banner] ~ * [data-action=activate], ${B} >>> .actions [data-action=activate]`)) === 0, "active version shows a marker and no Make-active button");
    page.assert((await count(page, `${B} >>> .actions [data-action=duplicate]`)) === 1, "duplicate is offered");
    page.assert((await count(page, `${B} >>> [data-action=add]`)) === 0 && (await count(page, `${B} >>> [data-action=save]`)) === 0, "no editing actions in a read-only view");
    await page.click(versionBtn(11));
    await until(async () => (await chipText(page)) === "v1 · Архив");
    const archived = await text(page, `${B} >>> [data-view-banner]`);
    page.assert(archived.includes("412 диалогов · 12.08.2026"), `archived banner (${archived})`);
    page.assert((await count(page, `${B} >>> .actions [data-action=activate]`)) === 1, "archived version offers Make active");
    await page.eval(`cqaDeep(${JSON.stringify(versionBtn(13))})[0].focus(); true`);
    await page.press("Enter");
    await until(async () => (await chipText(page)) === "Черновик v3");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=row-weight]`)}).every((e) => !e.disabled)`)) === true, "a draft opens editable (keyboard)");
    page.assert((await attr(page, versionBtn(13), "aria-current")) === "true", "draft row is current");
    await page.click(versionBtn(11));
    await until(async () => (await chipText(page)) === "v1 · Архив");
    await page.click(`${B} >>> .actions [data-action=activate]`);
    await until(() => confirmOpen(page));
    const desc = await attr(page, "cqa-app >>> [data-confirm]", "description");
    page.assert(desc === "Новые оценки будут идти по v1; прошлые оценки не изменятся.", `confirm text (${desc})`);
    await answerConfirm(page, "cancel");
    page.assert((await serverLists(page))[0].defaultVersionId === 12, "cancel changes nothing");
    await page.click(`${B} >>> .actions [data-action=activate]`);
    await answerConfirm(page, "ok");
    await until(async () => (await chipText(page)) === "v1 · Активная");
    page.assert((await toasts(page)).includes("Версия v1 назначена активной."), "activation toast");
    const server = (await serverLists(page))[0];
    page.assert(server.defaultVersionId === 11, "v1 is the default");
    page.assert(server.versions.find((v) => v.version === 2).status === "archived", `previous active is archived (${JSON.stringify(server.versions)})`);
    const rows = await rowsText(page);
    page.assert(rows.some((r) => r.startsWith("v1") && r.includes("Активная")) && rows.some((r) => r.startsWith("v2") && r.includes("Архив")), `sidebar updated (${rows.join(" | ")})`);
    page.assert((await count(page, `${B} >>> [data-active-marker]`)) === 1 && (await count(page, `${B} >>> .actions [data-action=activate]`)) === 0, "marker replaces the button");
    await page.click(`${B} >>> [data-version-row="21"] [data-action=open-version]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> h1`)})[0]?.textContent.includes('звонков')`));
    page.assert((await chipText(page)) === "Черновик v1", `calls checklist draft opens (${await chipText(page)})`);
    page.assert((await attr(page, versionBtn(21), "aria-current")) === "true", "calls draft row is current");
    await page.click(versionBtn(12));
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> h1`)})[0]?.textContent.includes('чатов')`));
    await until(async () => (await chipText(page)).startsWith("v2"));
    page.assert((await chipText(page)) === "v2 · Активная" || (await chipText(page)) === "v2 · Архив", `rows of another checklist open it (${await chipText(page)})`);
    await page.assertAccessibleNames();
  },

  async "builder-drafts-draftonly"(page) {
    await open(page, "role=reviewer", "#/checklists/2");
    await until(async () => (await chipText(page)) === "Черновик v1");
    page.assert((await disabled(page, `${B} >>> [data-action=apply]`)) === true, "a draft-only checklist cannot be applied");
    page.assert((await count(page, `${B} >>> [data-version-row="21"] [data-action=activate]`)) === 0, "no Make-active button on a draft");
    page.assert((await text(page, `${B} >>> [data-apply-reason]`)).includes("нельзя применить или сделать активным"), "inline reason for the draft");
    const server = await serverLists(page);
    page.assert(server[1].defaultVersionId === null, "the draft-only checklist has no default");
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await chipText(page)) === "Сохранена v1");
    page.assert((await count(page, `${B} >>> [data-version-row="21"] [data-action=activate]`)) === 1, "a saved first version can be made active");
    await page.click(`${B} >>> [data-version-row="21"] [data-action=activate]`);
    await answerConfirm(page, "ok");
    await until(async () => (await rowsText(page)).some((r) => r.startsWith("v1") && r.includes("Активная")));
    page.assert((await serverLists(page))[1].defaultVersionId === 21, "default set");
  },

  async "builder-drafts-new"(page) {
    await open(page, "role=reviewer");
    const before = await serverLists(page);
    page.assert((await disabled(page, `${B} >>> [data-action=new-checklist]`)) === false, "the New checklist button is enabled");
    await page.click(`${B} >>> [data-action=new-checklist]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-name]`)}).length === 1`));
    page.assert((await value(page, `${B} >>> [data-field=new-name]`)) === "Новый чек-лист", "default name");
    page.assert((await count(page, `${B} >>> [data-row]`)) === 0, "no criteria");
    page.assert((await count(page, `${B} >>> [data-section-id]`)) === 1 && (await text(page, `${B} >>> .sech-t`)) === "Раздел 1", "one default section");
    page.assert((await text(page, `${B} >>> [data-new-block]`)).includes("новый") && (await text(page, `${B} >>> [data-new-block]`)).includes("Черновик"), "sidebar shows the new entry with a badge and a draft");
    page.assert((await dirty(page)) === true, "unsaved");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-channel]`)}).map((e) => e.checked).join()`)) === "true,false", "chats are preselected");
    page.assert((await disabled(page, `${B} >>> [data-action=save]`)) === true, "finalising is blocked");
    page.assert((await disabled(page, actBtn)) === false, "draft can be saved immediately");
    page.assert((await text(page, `${B} >>> [data-preview-state]`)).includes("Добавьте критерии"), "preview explains the empty state");
    const other = (await rowsText(page)).join("|");
    page.assert(!other.includes("Черновая") && (await serverLists(page)).length === before.length, "no leftover content and nothing created yet");
    await setField(page, `${B} >>> [data-field=new-name]`, "  ");
    page.assert((await text(page, `${B} >>> [data-name-error]`)).includes("Укажите название"), "empty name error");
    page.assert((await disabled(page, actBtn)) === true, "draft save is blocked by the name");
    await setField(page, `${B} >>> [data-field=new-name]`, "чек-лист качества ЧАТОВ");
    page.assert((await text(page, `${B} >>> [data-name-error]`)).includes("уже есть"), "duplicate name error (case-insensitive)");
    page.assert((await attr(page, `${B} >>> [data-field=new-name]`, "aria-invalid")) === "true", "field marked invalid");
    await setField(page, `${B} >>> [data-field=new-name]`, "Чек-лист жалоб");
    page.assert((await count(page, `${B} >>> [data-name-error]`)) === 0, "error clears");
    await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-channel][data-channel=call]`)})[0].click(); true`);
    await sleep(80);
    await page.click(`${B} >>> [data-action=add][data-section=section-1]`);
    await sleep(80);
    page.assert((await count(page, `${B} >>> [data-row]`)) === 1, "criterion added with the normal editor");
    await setField(page, rowWeight("k0"), "100");
    page.assert((await disabled(page, `${B} >>> [data-action=save]`)) === false, "valid checklist can be finalised");
    await page.click(actBtn);
    await until(async () => (await toasts(page)).includes("Черновик сохранён · не применён"));
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> h1`)})[0]?.textContent.includes('Чек-лист жалоб')`));
    const after = await serverLists(page);
    const created = after.find((c) => c.name === "Чек-лист жалоб");
    page.assert(created && created.defaultVersionId === null && created.versions.length === 1 && created.versions[0].status === "draft", `created as a draft-only checklist (${JSON.stringify(created)})`);
    page.assert(JSON.stringify(created.channels) === JSON.stringify(["agent chat", "voice call"]), `channel bound (${JSON.stringify(created.channels)})`);
    page.assert(JSON.stringify(after[0]) === JSON.stringify(before[0]) && JSON.stringify(after[1]) === JSON.stringify(before[1]), "existing checklists unchanged");
    page.assert((await chipText(page)) === "Черновик v1", "builder shows the saved draft");
    page.assert((await dirty(page)) === false, "clean after saving");
    const rows = await rowsText(page);
    page.assert(rows.length === 5 && rows.filter((r) => r.startsWith("v1") && r.includes("Черновик")).length === 2, `three checklists listed (${rows.length})`);
    await setField(page, `${B} >>> [data-field=e-name]`, "Критерий жалобы");
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await toasts(page)).includes("Версия v1 сохранена."));
    await until(async () => (await chipText(page)) === "Сохранена v1");
    page.assert((await serverLists(page)).find((c) => c.name === "Чек-лист жалоб").defaultVersionId === null, "finalising does not activate");
    await page.click(`${B} >>> [data-editing] [data-action=activate]`);
    await answerConfirm(page, "ok");
    await until(async () => (await rowsText(page)).some((r) => r.startsWith("v1") && r.includes("Активная") && r.includes("Сохранена") === false));
    const final = await serverLists(page);
    page.assert(final.find((c) => c.name === "Чек-лист жалоб").versions[0].status === "active", "v1 active");
    page.assert(final[0].defaultVersionId === before[0].defaultVersionId, "the chat checklist keeps its active version");
  },

  async "builder-drafts-new-direct"(page) {
    await open(page, "role=reviewer");
    await page.click(`${B} >>> [data-action=new-checklist]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-name]`)}).length === 1`));
    await page.click(`${B} >>> [data-action=add][data-section=section-1]`);
    await sleep(80);
    await setField(page, `${B} >>> [data-field=e-name]`, "Единственный критерий");
    await setField(page, rowWeight("k0"), "100");
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await chipText(page)) === "v1 · Сохранена");
    const created = (await serverLists(page)).find((c) => c.name === "Новый чек-лист");
    page.assert(created && created.versions[0].status === "saved" && created.defaultVersionId === null, `finalised straight away (${JSON.stringify(created)})`);
  },

  async "builder-drafts-guard"(page) {
    await open(page, "role=reviewer");
    await editName(page, "Правка до перехода");
    await page.click(`${B} >>> [data-action=open-checklist]`);
    await until(() => confirmOpen(page));
    const info = await page.eval(`(() => { const a = ${APP}; return { heading: a.querySelector('[data-confirm]').getAttribute('heading'), ok: a.querySelector('[data-confirm-ok]').textContent, cancel: a.querySelector('[data-confirm-cancel]').textContent, extra: a.querySelector('[data-confirm-extra]').textContent, extraHidden: a.querySelector('[data-confirm-extra]').hidden }; })()`);
    page.assert(info.extra === "Сохранить черновик" && info.extraHidden === false && info.ok === "Отбросить и продолжить" && info.cancel === "Остаться", `three choices (${JSON.stringify(info)})`);
    await page.eval(`${APP}.querySelector('[data-confirm-extra]').click(); true`);
    await until(() => page.eval(`location.hash === '#/checklists/2'`));
    page.assert((await toasts(page)).includes("Черновик сохранён · не применён"), "saved as a draft before leaving");
    const cfg = await serverConfig(page, 13);
    page.assert(cfg.criteria.find((c) => c.id === "04").title === "Правка до перехода", "the draft on the server has the edit");
    await open(page, "role=reviewer");
    await editName(page, "Правка для переключения");
    await page.click(versionBtn(12));
    await until(() => confirmOpen(page));
    await answerConfirm(page, "cancel");
    page.assert((await chipText(page)) === "Черновик v3" && (await dirty(page)) === true, "cancel keeps the edits");
    await page.click(versionBtn(12));
    await answerConfirm(page, "ok");
    await until(async () => (await chipText(page)) === "v2 · Активная");
    page.assert((await dirty(page)) === false, "discard clears the guard");
    page.assert((await serverConfig(page, 13)).criteria.find((c) => c.id === "04").title !== "Правка для переключения", "discarded edits are not saved");
    await page.click(versionBtn(13));
    await until(async () => (await chipText(page)) === "Черновик v3");
    await editName(page, "Правка с сохранением");
    await page.click(versionBtn(11));
    await page.eval(`${APP}.querySelector('[data-confirm-extra]').click(); true`);
    await until(async () => (await chipText(page)) === "v1 · Архив");
    page.assert((await serverConfig(page, 13)).criteria.find((c) => c.id === "04").title === "Правка с сохранением", "switching with save-as-draft stores the edit");
    await page.click(`${B} >>> [data-action=new-checklist]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-name]`)}).length === 1`));
    await page.click(`${B} >>> [data-action=open-checklist]`);
    await until(() => confirmOpen(page));
    await answerConfirm(page, "ok");
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-name]`)}).length === 0`));
    page.assert((await serverLists(page)).length === 2, "discarded new checklist is never created");
  },

  async "builder-drafts-roles"(page) {
    for (const role of ["exec", "operator"]) {
      await open(page, `role=${role}`);
      page.assert((await disabled(page, `${B} >>> [data-action=new-checklist]`)) === true, `${role}: New checklist is disabled`);
      page.assert((await disabled(page, actBtn)) === true, `${role}: save draft is disabled`);
      page.assert((await count(page, `${B} >>> [data-action=delete-draft]`)) === 0, `${role}: no discard`);
      await page.click(versionBtn(11));
      await until(async () => (await chipText(page)) === "v1 · Архив");
      page.assert((await count(page, `${B} >>> [data-action=activate]`)) === 0, `${role}: no Make-active anywhere`);
      page.assert((await count(page, `${B} >>> .actions [data-action=duplicate]`)) === 0, `${role}: no duplicate in the banner`);
      page.assert((await text(page, `${B} >>> [data-save-reason]`)).startsWith("Только просмотр"), `${role}: read-only reason`);
      await page.click(versionBtn(13));
      await until(async () => (await chipText(page)) === "Черновик v3");
      page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=row-weight]`)}).every((e) => e.disabled)`)) === true, `${role}: draft is read-only`);
    }
    await open(page, "role=reviewer");
    page.assert((await count(page, `${B} >>> [data-version-row="11"] [data-action=activate]`)) === 1, "reviewer sees Make active on an archived row");
  },

  async "builder-drafts-i18n"(page) {
    await open(page, "role=reviewer&locale=en");
    await editName(page, "Contact opening");
    page.assert((await text(page, actBtn)) === "Save draft", "EN save draft");
    await page.click(actBtn);
    await until(async () => (await toasts(page)).includes("Draft saved · not applied"));
    await page.click(versionBtn(12));
    await until(async () => (await chipText(page)) === "v2 · Active");
    page.assert((await text(page, `${B} >>> [data-view-banner]`)).startsWith("Viewing v2 · Active."), `EN banner (${await text(page, `${B} >>> [data-view-banner]`)})`);
    await page.click(`${B} >>> [data-action=new-checklist]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-name]`)}).length === 1`));
    page.assert((await value(page, `${B} >>> [data-field=new-name]`)) === "New checklist" && (await text(page, `${B} >>> .sech-t`)) === "Section 1", "EN defaults");
    await open(page, "role=reviewer&locale=kk");
    await editName(page, "Байланысты орнату");
    await page.click(actBtn);
    await until(async () => (await toasts(page)).includes("Жоба сақталды · қолданылмады"));
    await page.click(versionBtn(11));
    await until(async () => (await chipText(page)) === "v1 · Мұрағат");
    await page.click(`${B} >>> .actions [data-action=activate]`);
    await until(() => confirmOpen(page));
    page.assert((await attr(page, "cqa-app >>> [data-confirm]", "description")) === "Жаңа бағалар v1 бойынша жүреді; бұрынғы бағалар өзгермейді.", "KZ confirm");
    await answerConfirm(page, "cancel");
    await page.click(`${B} >>> [data-action=new-checklist]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-name]`)}).length === 1`));
    page.assert((await value(page, `${B} >>> [data-field=new-name]`)) === "Жаңа чек-лист", "KZ default name");
  },

  async "builder-drafts-look"(page) {
    await open(page, "role=reviewer");
    await page.click(versionBtn(11));
    await until(async () => (await chipText(page)) === "v1 · Архив");
    await sleep(150);
  },

  async "builder-drafts-look-new"(page) {
    await open(page, "role=reviewer");
    await page.click(`${B} >>> [data-action=new-checklist]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-name]`)}).length === 1`));
    await sleep(150);
  },

  async "builder-drafts-look-guard"(page) {
    await open(page, "role=reviewer");
    await editName(page, "Правка до перехода");
    await page.click(versionBtn(12));
    await until(() => confirmOpen(page));
    await sleep(250);
  }
};

const jget = (page, path, init) =>
  page.eval(`fetch(new URL('../api/v1${path}', location.href), ${JSON.stringify(init || {})}).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))`);

async function openReal(page, hash, query = "role=reviewer") {
  await page.eval(`(() => { const b = cqaDeep(${JSON.stringify(B)})[0]; if (b) b._dirty = false; return true; })()`).catch(() => null);
  const marker = `m=${Math.random().toString(36).slice(2, 8)}`;
  await page.eval(`setTimeout(() => { const u = new URL(location.href); u.search = '?${marker}${query ? "&" + query : ""}'; u.hash = ${JSON.stringify(hash)}; location.href = u.href; }, 0); true`);
  await until(() => page.eval(`location.search.includes(${JSON.stringify(marker)}) && document.readyState === 'complete'`));
  await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-region=side] .vrow`)}).length > 0`), 20000);
}

async function reloadReal(page) {
  await page.eval(`(() => { const b = cqaDeep(${JSON.stringify(B)})[0]; if (b) b._dirty = false; return true; })()`).catch(() => null);
  await page.eval(`setTimeout(() => location.reload(), 0); true`);
  await sleep(600);
  await until(() => page.eval(`document.readyState === 'complete' && cqaDeep(${JSON.stringify(`${B} >>> [data-region=side] .vrow`)}).length > 0`), 20000);
}

Object.assign(raw, {
  async "real-builder-drafts"(page) {
    page.allowConsole(/422 .*checklists\/\d+\/default/);
    page.allowConsole(/409 .*checklist-versions/);
    await openReal(page, "#/checklists/1");
    const lists = (await jget(page, "/checklists")).body;
    const chat = lists[0];
    const active = chat.versions.find((v) => v.status === "active");
    const archived = chat.versions.find((v) => v.status === "archived");
    const draft = chat.versions.find((v) => v.status === "draft");
    page.assert(active && archived && draft, `copy has active, archived and draft versions (${chat.versions.map((v) => v.status)})`);
    page.assert((await disabled(page, actBtn)) === true, "real: save draft disabled while clean");
    await editName(page, "Реальная правка черновика");
    await setField(page, rowWeight("k0"), "7");
    page.assert((await disabled(page, `${B} >>> [data-action=save]`)) === true && (await disabled(page, actBtn)) === false, "real: weights not 100 block the version but not the draft");
    await page.click(actBtn);
    await until(async () => (await toasts(page)).includes("Черновик сохранён · не применён"));
    const stored = (await jget(page, `/checklist-versions/${draft.id}`)).body;
    page.assert(stored.status === "draft" && stored.config.criteria[0].weight === 7 && stored.config.criteria.find((c) => c.title === "Реальная правка черновика"), "real: server stored the incomplete draft");
    page.assert((await jget(page, "/checklists")).body[0].default_version_id === active.id, "real: active untouched");
    await reloadReal(page);
    await page.click(`${B} >>> [data-action=pick][data-key=k3]`);
    page.assert((await value(page, `${B} >>> [data-field=e-name]`)) === "Реальная правка черновика" && (await value(page, rowWeight("k0"))) === "7", "real: draft survives a page reload");
    page.assert((await chipText(page)).startsWith("Черновик"), "real: reopened as a draft");
    await page.click(versionBtn(archived.id));
    await until(async () => (await chipText(page)) === `v${archived.version} · Архив`);
    page.assert((await count(page, `${B} >>> .actions [data-action=activate]`)) === 1, "real: archived offers Make active");
    await page.click(versionBtn(active.id));
    await until(async () => (await chipText(page)) === `v${active.version} · Активная`);
    page.assert((await count(page, `${B} >>> [data-active-marker]`)) === 1, "real: active shows the marker");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=row-weight]`)}).every((e) => e.disabled)`)) === true, "real: saved versions are read-only");
    await page.click(versionBtn(archived.id));
    await until(async () => (await chipText(page)) === `v${archived.version} · Архив`);
    await page.click(`${B} >>> .actions [data-action=activate]`);
    await answerConfirm(page, "ok");
    await until(async () => (await chipText(page)) === `v${archived.version} · Активная`);
    const flipped = (await jget(page, "/checklists")).body[0];
    page.assert(flipped.default_version_id === archived.id && flipped.versions.find((v) => v.id === active.id).status === "archived", `real: activation flipped statuses (${JSON.stringify(flipped.versions.map((v) => v.status))})`);
    await page.click(versionBtn(active.id));
    await until(async () => (await chipText(page)) === `v${active.version} · Архив`);
    await page.click(`${B} >>> .actions [data-action=activate]`);
    await answerConfirm(page, "ok");
    await until(async () => (await chipText(page)) === `v${active.version} · Активная`);
    const draftRow = await jget(page, `/checklists/${chat.id}/default`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version_id: draft.id }) });
    page.assert(draftRow.status === 422, "real: the server refuses to activate a draft");
    page.assert((await jget(page, `/checklist-versions/${active.id}`, { method: "DELETE" })).status === 409, "real: deleting a saved version is 409");
    await page.click(versionBtn(draft.id));
    await until(async () => (await chipText(page)).startsWith("Черновик"));
    await page.click(`${B} >>> [data-action=delete-draft]`);
    await answerConfirm(page, "ok");
    await until(async () => (await toasts(page)).some((x) => x.includes("удалён")));
    await until(async () => (await jget(page, "/checklists")).body[0].versions.every((v) => v.status !== "draft"));
  },

  async "real-builder-new"(page) {
    await openReal(page, "#/checklists/1");
    const before = (await jget(page, "/checklists")).body;
    await page.click(`${B} >>> [data-action=new-checklist]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-name]`)}).length === 1`));
    page.assert((await count(page, `${B} >>> [data-row]`)) === 0, "real: clean checklist");
    await setField(page, `${B} >>> [data-field=new-name]`, before[0].name.toUpperCase());
    page.assert((await text(page, `${B} >>> [data-name-error]`)).includes("уже есть"), "real: duplicate name is refused inline");
    await setField(page, `${B} >>> [data-field=new-name]`, "Реальный чек-лист звонков");
    await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=new-channel][data-channel=call]`)})[0].click(); true`);
    await page.click(`${B} >>> [data-action=add][data-section=section-1]`);
    await sleep(80);
    await page.click(actBtn);
    await until(async () => (await toasts(page)).includes("Черновик сохранён · не применён"));
    await until(() => page.eval(`location.hash !== '#/checklists/1' && cqaDeep(${JSON.stringify(`${B} >>> h1`)})[0]?.textContent.includes('Реальный')`));
    const after = (await jget(page, "/checklists")).body;
    const created = after.find((c) => c.name === "Реальный чек-лист звонков");
    page.assert(created && created.default_version_id === null && created.channels.includes("voice call") && created.versions[0].status === "draft", `real: created as a draft-only checklist (${JSON.stringify(created)})`);
    page.assert(JSON.stringify(after[0]) === JSON.stringify(before[0]), "real: the existing checklist is unchanged");
    await reloadReal(page);
    page.assert((await text(page, `${B} >>> h1`)).includes("Реальный чек-лист звонков") && (await chipText(page)) === "Черновик v1", `real: new draft survives a reload (${await chipText(page)})`);
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await toasts(page)).some((x) => x.includes("недоступно")) || (await disabled(page, `${B} >>> [data-action=save]`)) === true);
    page.assert((await disabled(page, `${B} >>> [data-action=save]`)) === true, "real: finalising is blocked while weights are not 100");
    await setField(page, rowWeight("k0"), "100");
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await chipText(page)) === "Сохранена v1");
    const saved = (await jget(page, "/checklists")).body.find((c) => c.id === created.id);
    page.assert(saved.versions[0].status === "saved" && saved.default_version_id === null, "real: finalised, not active");
    await page.click(`${B} >>> [data-editing] [data-action=activate]`);
    await answerConfirm(page, "ok");
    await until(async () => (await jget(page, "/checklists")).body.find((c) => c.id === created.id).default_version_id !== null);
    page.assert((await jget(page, "/checklists")).body[0].default_version_id === before[0].default_version_id, "real: the chat checklist keeps its active version");
  }
});

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
