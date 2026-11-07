const B = "cqa-app >>> cqa-checklist-builder";
const R = "cqa-app >>> cqa-eval-runs";
const APP = "document.querySelector('cqa-app').shadowRoot";

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function until(fn, timeout = 20000, step = 100) {
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

const texts = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)}).map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
const text = async (page, selector) => (await texts(page, selector))[0];
const disabled = (page, selector) => page.eval(`cqaDeep(${JSON.stringify(selector)})[0].disabled`);
const toasts = (page) => texts(page, "cqa-app >>> cqa-toast >>> .msg-text");

async function open(page, hash, query = "role=reviewer", ready) {
  const marker = `m=${Math.random().toString(36).slice(2, 8)}`;
  await page.eval(`(() => { const b = cqaDeep(${JSON.stringify(B)})[0]; if (b) b._dirty = false; return true; })()`).catch(() => null);
  await page.eval(`setTimeout(() => { const u = new URL(location.href); u.search = '?${marker}${query ? "&" + query : ""}'; u.hash = ${JSON.stringify(hash)}; location.href = u.href; }, 0); true`);
  await until(() => page.eval(`location.search.includes(${JSON.stringify(marker)}) && document.readyState === 'complete'`));
  if (ready) await until(() => page.eval(`cqaDeep(${JSON.stringify(ready)}).length > 0`));
}

const idle = (page) => until(() => page.eval(`cqaDeep(${JSON.stringify(B)})[0]._busy === null`));

async function setField(page, selector, value, event = "input") {
  await page.eval(`(() => {
    const el = cqaDeep(${JSON.stringify(selector)})[0];
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true, composed: true }));
    return true;
  })()`);
  await sleep(80);
}

const api = (page, path, init) =>
  page.eval(`fetch(new URL('../api/v1${path}', location.href), ${JSON.stringify(init || {})}).then((r) => r.json())`);

async function chooseGroup(page, value) {
  await setField(page, `${R} >>> [data-field=custom]`, value);
}

export const scenarios = {
  async "real-runs"(page) {
    page.allowConsole(/502 \(Bad Gateway\).*datasets\/import/);
    await open(page, "#/runs", "role=reviewer", `${R} >>> [data-run]`);
    page.assert((await text(page, `${R} >>> h1`)) === "Запуски оценки", "h1");
    const serverRuns = await api(page, "/runs");
    const rows = await texts(page, `${R} >>> [data-run]`);
    page.assert(rows.length >= 1 && serverRuns.length >= 1, `runs listed (${rows.length}/${serverRuns.length})`);
    const history = await page.eval(`cqaDeep(${JSON.stringify(`${R} >>> [data-action=open-run]`)}).map((e) => e.textContent.trim())`);
    page.assert(serverRuns.every((r) => history.includes(r.code)), `history shows every persisted run (${history}) vs (${serverRuns.map((r) => r.code)})`);
    const models = await api(page, "/models");
    const modelText = await text(page, `${R} >>> [data-field=model]`);
    page.assert(modelText.includes(models[0].label) && modelText.includes("платная"), `model select from the server (${modelText})`);
    const group = await page.eval(`cqaDeep(${JSON.stringify(`${R} >>> [data-field=group]`)})[0].value`);
    const datasets = await api(page, "/datasets");
    const dataset = datasets.find((d) => d.group_id === group);
    const versions = await api(page, "/checklists");
    const activeVersion = versions[0].default_version_id;
    const est = await api(page, `/runs/estimate?dataset=${group}&checklist_version_id=${activeVersion}`);
    const estText = await text(page, `${R} >>> [data-estimate]`);
    const expected = est.cost_estimate.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    page.assert(estText.replace(/\s/g, " ").includes(expected), `estimate equals count x mean (${estText} vs ${expected}, ${est.to_run} x ${est.price_per_evaluation})`);
    page.assert(Math.abs(est.cost_estimate - est.to_run * est.price_per_evaluation) < 0.0001 && est.total === dataset.conversations, "server estimate is count x price");
    await page.eval(`(() => { const s = cqaDeep(${JSON.stringify(`${R} >>> [data-field=version]`)})[0]; const first = [...s.options].find((o) => Number(o.value) !== ${activeVersion}); if (first) { s.value = first.value; s.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } return true; })()`);
    await sleep(600);
    const other = await text(page, `${R} >>> [data-estimate]`);
    await page.eval(`(() => { const c = cqaDeep(${JSON.stringify(`${R} >>> [data-field=force]`)})[0]; c.click(); return true; })()`);
    await until(async () => (await text(page, `${R} >>> [data-estimate]`)) !== other || other.includes("2,"));
    const forced = await text(page, `${R} >>> [data-estimate]`);
    page.assert(/≈ \d+,\d\d \$/.test(forced), `forced estimate is formatted (${forced})`);
    await page.eval(`(() => { cqaDeep(${JSON.stringify(`${R} >>> [data-field=force]`)})[0].click(); return true; })()`);

    const failed = await page.eval(`cqaDeep(${JSON.stringify(`${R} >>> [data-action=retry-item]`)}).length`);
    if (failed > 0) {
      const before = page.requests.length;
      const id = await page.eval(`cqaDeep(${JSON.stringify(`${R} >>> [data-action=retry-item]`)})[0].getAttribute('data-id')`);
      await page.click(`${R} >>> [data-action=retry-item]`);
      await until(() => page.requests.slice(before).some((u) => /\/runs\/\d+\/items\/\d+\/retry$/.test(u)));
      await until(async () => (await toasts(page)).length > 0);
      page.assert((await toasts(page)).some((m) => m.includes(id)), `retry toast names the conversation (${await toasts(page)})`);
      page.assert((await page.deepCount(`${R} >>> [data-action=retry-item]`)) === failed, "LLM unreachable: item stays failed and the retry button stays");
    }

    await chooseGroup(page, "zzz-no-such-group");
    await page.click(`${R} >>> [data-action=start]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${R} >>> [role=alert]`)}).length > 0`));
    const err = await text(page, `${R} >>> [role=alert]`);
    page.assert(err.startsWith("Источник данных вернул ошибку:") && err.includes("zzz-no-such-group"), `organisers error is localised with the server text (${err})`);
    await open(page, "#/runs", "role=reviewer&locale=en", `${R} >>> [data-run]`);
    await chooseGroup(page, "zzz-no-such-group");
    await page.click(`${R} >>> [data-action=start]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${R} >>> [role=alert]`)}).length > 0`));
    const errEn = await text(page, `${R} >>> [role=alert]`);
    page.assert(errEn.startsWith("The data source reported an error:") && errEn.includes("zzz-no-such-group"), `English error text (${errEn})`);
    await open(page, "#/runs", "role=reviewer&locale=kk", `${R} >>> [data-run]`);
    await chooseGroup(page, "zzz-no-such-group");
    await page.click(`${R} >>> [data-action=start]`);
    await until(() => page.eval(`cqaDeep(${JSON.stringify(`${R} >>> [role=alert]`)}).length > 0`));
    const errKk = await text(page, `${R} >>> [role=alert]`);
    page.assert(errKk.startsWith("Дерек көзі қате қайтарды:"), `Kazakh error text (${errKk})`);
  },

  async "real-builder"(page) {
    page.allowConsole(/422 \(Unprocessable Content\).*versions\?status=draft/);
    page.allowConsole(/409 \(Conflict\).*checklist-versions\/\d+/);
    await open(page, "#/checklists/1", "role=reviewer", `${B} >>> [data-version-row]`);
    await sleep(500);
    const chip = () => text(page, `${B} >>> [data-chip=status]`);
    const rowsText = () => texts(page, `${B} >>> [data-region=side] .vrow`);
    const server = await api(page, "/checklists");
    const uiRows = await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-version-row]`)}).map((e) => Number(e.getAttribute('data-version-row')))`);
    page.assert(JSON.stringify([...uiRows].sort()) === JSON.stringify(server[0].versions.map((v) => v.id).sort()), `sidebar lists the server versions (${uiRows})`);
    const baseVersion = server[0].versions.find((v) => v.is_default);
    const baseApplied = baseVersion.applied_count;
    const rows0 = await rowsText();
    page.assert(rows0.some((r) => r.startsWith(`v${baseVersion.version}`) && r.includes("Активная")), `active version labelled vN from the backend integer (${rows0})`);

    const chans = server[0].channels;
    const chatBound = chans.includes("agent chat");
    await page.eval(`(() => { cqaDeep(${JSON.stringify(`${B} >>> [data-channel=chat]`)})[0].click(); return true; })()`);
    await until(async () => (await api(page, "/checklists"))[0].channels.includes("agent chat") === !chatBound);
    await idle(page);
    page.assert((await toasts(page)).length > 0, "channel toast");
    page.assert((await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-channel=chat]`)})[0].checked`)) === !chatBound, "checkbox reflects the server binding");
    await page.eval(`(() => { cqaDeep(${JSON.stringify(`${B} >>> [data-channel=chat]`)})[0].click(); return true; })()`);
    await until(async () => (await api(page, "/checklists"))[0].channels.includes("agent chat") === chatBound);
    await idle(page);

    const before = server[0].versions.length;
    await page.click(`${B} >>> [data-version-row="${baseVersion.id}"] [data-action=duplicate]`);
    await until(async () => (await api(page, "/checklists"))[0].versions.length === before + 1);
    const afterDup = (await api(page, "/checklists"))[0].versions;
    const draft = afterDup.find((v) => v.status === "draft" && !server[0].versions.some((o) => o.id === v.id));
    page.assert(Boolean(draft), "duplicate creates a server draft");
    await until(async () => (await chip()).includes("Черновик"));
    page.assert((await chip()).includes(`v${draft.version}`), `chip names the draft (${await chip()})`);

    await open(page, "#/checklists/1", "role=reviewer", `${B} >>> [data-version-row]`);
    await until(async () => (await chip()).includes("Черновик"));
    page.assert((await chip()).includes(`v${draft.version}`), `draft survives a reload from the server (${await chip()})`);

    await page.click(`${B} >>> [data-action=pick][data-key=k1]`);
    const orig = await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=e-name]`)})[0].value`);
    await setField(page, `${B} >>> [data-field=e-name]`, orig + " (v+)");
    page.assert((await text(page, `${B} >>> [data-meta]`)).endsWith("изменено критериев: 1"), "one changed criterion");

    const w0 = await page.eval(`cqaDeep(${JSON.stringify(`${B} >>> [data-field=row-weight]`)})[0].value`);
    await setField(page, `${B} >>> [data-field=row-weight]`, "11");
    page.assert((await disabled(page, `${B} >>> [data-action=save]`)) === true, "weights not summing to 100 block save");
    page.assert((await text(page, `${B} >>> [data-save-reason]`)).length > 0, "block reason is shown");
    const alertText = (await texts(page, `${B} >>> [role=alert]`)).join(" ");
    page.assert(/Сумма весов должна быть 100/.test(alertText + (await text(page, `${B} >>> [data-save-reason]`))), `weight rule message (${alertText})`);
    await setField(page, `${B} >>> [data-field=row-weight]`, w0);
    page.assert((await disabled(page, `${B} >>> [data-action=save]`)) === false, "restoring the weight re-enables save");

    const before2 = page.requests.length;
    await page.click(`${B} >>> [data-action=save]`);
    await until(async () => (await chip()).startsWith("Сохранена"));
    const sent = page.requests.slice(before2).filter((u) => /checklist-versions/.test(u));
    page.assert(sent.some((u) => u.endsWith(`/checklist-versions/${draft.id}/save`)), `finalize request sent (${sent})`);
    const serverAfter = (await api(page, "/checklists"))[0].versions;
    const saved = serverAfter.find((v) => v.id === draft.id);
    page.assert(saved.status === "saved", `draft became saved on the server (${saved.status})`);
    const savedFull = await api(page, `/checklist-versions/${draft.id}`);
    page.assert(savedFull.config.criteria.some((c) => c.title.endsWith("(v+)")), "edited criterion name stored");
    page.assert(serverAfter.find((v) => v.id === baseVersion.id).applied_count === baseApplied, "original version's applied count untouched");
    page.assert((await toasts(page)).some((m) => m.includes(`v${draft.version}`) && m.includes("сохранена")), `save toast (${await toasts(page)})`);
    page.assert((await disabled(page, `${B} >>> [data-action=apply]`)) === false, "apply enabled once saved");

    const err = await page.eval(`(async () => {
      const m = await import(new URL('src/api.js', location.href).href);
      const full = await m.api.getChecklistVersion(${draft.id});
      const dup = JSON.parse(JSON.stringify(full.config));
      dup.criteria[1].id = dup.criteria[0].id;
      try { await m.api.saveChecklistVersion(1, dup, { status: 'draft' }); return null; } catch (e) { const b = document.querySelector('cqa-app').shadowRoot.querySelector('cqa-checklist-builder'); return { status: e.status, code: e.code, message: e.message, shown: b ? b.errorMessage(e, true) : null }; }
    })()`);
    page.assert(err && err.status === 422 && /duplicate criterion ids/.test(err.message), `server 422 surfaces its text (${JSON.stringify(err)})`);
    page.assert(err && err.shown && err.shown.includes("duplicate criterion ids") && err.shown.includes("Ничего не сохранено"), `builder shows the 422 text (${err && err.shown})`);

    const immutable = await page.eval(`(async () => {
      const m = await import(new URL('src/api.js', location.href).href);
      const full = await m.api.getChecklistVersion(${draft.id});
      try { await m.api.updateDraft(${draft.id}, full.config); return null; } catch (e) { return { status: e.status, code: e.code, message: e.message }; }
    })()`);
    page.assert(immutable && immutable.status === 409 && /immutable/.test(immutable.message), `saved version is immutable (${JSON.stringify(immutable)})`);
  }
};
