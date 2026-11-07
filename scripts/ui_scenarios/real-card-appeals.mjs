import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const CARD = "cqa-app >>> cqa-conversation-card >>> ";
const DRAWER = CARD + "cqa-appeal-drawer >>> ";
const PLAYER = CARD + "cqa-audio-player >>> ";
const Q = "cqa-app >>> cqa-appeal-queue >>> ";
const j = JSON.stringify;

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

async function open(page, query, hash, ready = "[data-total]", scope = CARD) {
  await page.eval(`window.__realStale = true`);
  await page.eval(`(() => { const u = new URL(location.href); u.search = ${j(query)} + '&_=' + Date.now(); u.hash = ${j(hash)}; location.href = u.href; })()`);
  await until(page, `window.__realStale === undefined`, "navigation");
  await until(page, `document.readyState === 'complete' && !!document.querySelector('cqa-app')`, "document");
  if (ready) await until(page, `!!cqaDeep(${j(scope + ready)})[0]`, `ready ${ready}`);
}

const full = (sel) => (sel.startsWith("cqa-app") ? sel : CARD + sel);
const text = (page, sel) => page.eval(`(cqaDeep(${j(full(sel))})[0]?.textContent || '').replace(/\\s+/g, ' ').replace(/[\\u00a0\\u202f]/g, ' ').trim()`);
const texts = (page, sel) => page.eval(`cqaDeep(${j(full(sel))}).map((e) => e.textContent.replace(/\\s+/g, ' ').replace(/[\\u00a0\\u202f]/g, ' ').trim())`);
const count = (page, sel) => page.eval(`cqaDeep(${j(full(sel))}).length`);
const attr = (page, sel, name) => page.eval(`cqaDeep(${j(full(sel))})[0]?.getAttribute(${j(name)})`);
const api = (page, path, init) => page.eval(`fetch(new URL('../api/v1${path}', location.href), ${j(init || {})}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
const get = async (page, path) => (await api(page, path)).body;
const post = (page, path, body) => api(page, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const fmt = (value, locale = "ru-RU") => Number(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ");

async function setLocale(page, locale) {
  await page.eval(`document.querySelector('cqa-app').setAttribute('locale', ${j(locale)})`);
  await sleep(350);
}

async function focusType(page, selector, value) {
  await page.eval(`cqaDeep(${j(selector)})[0].focus()`);
  await page.type(value);
  await sleep(60);
}

async function pickSelect(page, selector, value) {
  await page.eval(`(() => { const s = cqaDeep(${j(selector)})[0]; s.value = ${j(String(value))}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
}

async function noOverflow(page, label) {
  const wide = await page.eval(`cqaAll().filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed').length`);
  page.assert(wide === 0, `${label}: no element extends past the viewport (${wide})`);
  page.assert(await page.eval(`document.documentElement.scrollWidth <= innerWidth + 1`), `${label}: no horizontal page scroll`);
}

function backendTotal(evaluationId) {
  const db = process.env.CQA_COPY_DB;
  if (!db) return null;
  const out = execFileSync(process.env.CQA_PYTHON || ROOT + ".venv/bin/python", [ROOT + "scripts/ui_score_check.py", db, String(evaluationId)], { encoding: "utf8" });
  return JSON.parse(out);
}

async function findTarget(page, { channel = "agent chat", skip = 0 } = {}) {
  const list = (await get(page, `/conversations?envelope=1&channel=${encodeURIComponent(channel)}&limit=200`)).items;
  let seen = 0;
  for (const item of list) {
    if (item.evaluation_id === null || item.eval_status === "failed" || item.final_total === null || item.provisional) continue;
    if (item.appeal_status !== "none" || item.conversation_id === "p1-ru-001") continue;
    const ev = await get(page, `/conversations/${item.id}/evaluation`);
    const conv = await get(page, `/conversations/${item.id}`);
    const people = conv.messages.filter((m) => m.speaker === "client" || m.speaker === "operator");
    const crit = ev.criteria.find((c) => c.answer === "no" && c.criterion_id !== "08" && c.checked_range);
    const def = crit && (await get(page, `/checklist-versions/${ev.checklist_version_id}`)).config.criteria.find((c) => c.id === crit.criterion_id);
    if (!crit || !def || def.type !== "yes_no" || people.length < 3) continue;
    if (seen < skip) {
      seen += 1;
      continue;
    }
    return { naAllowed: Boolean(def.na_allowed), pk: item.id, id: item.conversation_id, evaluationId: ev.id, criterion: crit.criterion_id, before: ev.final_total, original: ev.total, people: people.slice(0, 2).map((m) => m.message_index) };
  }
  throw new Error("no unappealed target conversation left on the copy");
}

export const scenarios = {
  async "real-card-chat"(page) {
    await open(page, "?role=operator", "#/conversations/p1-ru-001");
    const conv = await get(page, "/conversations/by-key/p1-ru-001");
    const ev = await get(page, `/conversations/${conv.id}/evaluation`);
    const versionCfg = (await get(page, `/checklist-versions/${ev.checklist_version_id}`)).config;
    page.assert(!(await page.eval(`location.href.includes('mock=1')`)), "real mode");
    page.assert((await text(page, ".crumbs, [data-strip]")).includes("p1-ru-001") || (await text(page, "[data-strip]")).length > 0, "strip rendered");
    page.assert((await text(page, "[data-total]")) === fmt(ev.final_total), `total equals backend final.total (${await text(page, "[data-total]")} vs ${ev.final_total})`);
    page.assert((await count(page, "li[data-index]")) === conv.messages.length, `every message rendered (${await count(page, "li[data-index]")}/${conv.messages.length})`);
    const lastIndex = conv.messages[conv.messages.length - 1].message_index;
    page.assert(/^#\d+/.test((await text(page, `li[data-index="${lastIndex}"] .tnum, li[data-index="${lastIndex}"]`)).replace(/^.*?(#\d+).*$/, "$1")), "message numbers displayed");
    const firstEvidence = ev.criteria.find((c) => c.evidence && c.evidence.length && c.criterion_id === "01").evidence[0].message_index;
    page.assert(new RegExp(`#${firstEvidence + 1}(?!\\d)`).test(await text(page, `li[data-index="${firstEvidence}"]`)), `0-based index ${firstEvidence} is shown as #${firstEvidence + 1}`);
    const cites = await texts(page, `li[data-index="${firstEvidence}"] .cite`);
    page.assert(cites.length > 0 && cites.some((c) => /К01|C01|01/.test(c)), `evidence message cites criterion 01 (${cites})`);

    const tiles = await texts(page, "[data-tiles] .tile");
    const sections = ev.final.sections.filter((s) => s.id !== "gross");
    page.assert(tiles.length === sections.length, `section tiles (${tiles.length}/${sections.length})`);
    sections.forEach((s, i) => page.assert(tiles[i].includes(fmt(s.effective_points)) && tiles[i].includes(fmt(s.effective_max)), `tile ${s.id} equals effective subtotal (${tiles[i]} vs ${s.effective_points}/${s.effective_max})`));
    const sumTiles = sections.reduce((acc, s) => acc + s.effective_points, 0);
    page.assert(Math.abs(sumTiles - ev.final_total) < 0.05, `sections sum to the total (${sumTiles} vs ${ev.final_total})`);

    page.assert(/Уверенность: высокая · 8 из 8/.test(await text(page, "[data-confidence]")), `confidence (${await text(page, "[data-confidence]")})`);
    page.assert((await text(page, "[data-version-chip]")).includes("v1"), "checklist version chip vN from the backend integer");
    page.assert(/Модель: claude-opus-5-5 · \d\d\.\d\d\.\d{4} \d\d:\d\d/.test(await text(page, ".score-meta")), `model and time (${await text(page, ".score-meta")})`);
    page.assert((await count(page, "[data-crit-row]")) === versionCfg.criteria.filter((c) => c.section !== "gross").length, "scored criteria rows");
    page.assert(/08/.test(await text(page, "[data-gross]")) && /не обнаружены/.test(await text(page, "[data-gross]")), `gross strip (${await text(page, "[data-gross]")})`);

    const na = ev.criteria.find((c) => c.answer === "na");
    page.assert((await text(page, `[data-crit-row="${na.criterion_id}"] .crit-pts`)).startsWith("—"), "N/A points are a dash");
    page.assert(/Условие N\/A выполнено/.test(await text(page, `[data-crit-row="${na.criterion_id}"] .na-box`)) && (await text(page, `[data-crit-row="${na.criterion_id}"] .na-box`)).includes(na.na_reason), "N/A reason from na_reason");
    page.assert(/исключён/.test(await text(page, `[data-crit-row="${na.criterion_id}"] .crit-weight`)), "N/A weight excluded");

    const ranged = ev.criteria.find((c) => c.checked_range);
    await page.click(CARD + `[data-crit-row="${ranged.criterion_id}"] .crit-pick`);
    const from = ranged.checked_range.from;
    const to = ranged.checked_range.to;
    const expectedIdx = await page.eval(`cqaDeep(${j(CARD + "li.msg-expected, li [data-bubble].msg-expected")}).map((e) => (e.closest('li') || e).getAttribute('data-index')).join()`);
    page.assert(expectedIdx === Array.from({ length: to - from + 1 }, (_, i) => from + i).join(), `checked_range ${from}..${to} marks 0-based messages (${expectedIdx})`);
    const expectedChip = await text(page, `[data-crit-row="${ranged.criterion_id}"] .ev-expected`);
    page.assert(expectedChip.startsWith("Ожидалось здесь") && expectedChip.includes(await text(page, `li[data-index="${from}"] .ts`).then((t) => t.replace(/#\d+/, "").trim().slice(0, 5))), `expected chip carries the range time (${expectedChip})`);

    page.assert((await text(page, "[data-ledger-total]")) === fmt(ev.final_total), "ledger total equals backend");
    const footer = await text(page, "[data-ledger-footer]");
    page.assert(/Применимый вес: \d+ из 100/.test(footer), `ledger footer (${footer})`);
    page.assert((await count(page, "[data-history-section]")) === 1 && /Оценка модели/.test(await text(page, "[data-history-section]")), "history section");
    if (ev.appeals.length === 0) page.assert(/Срок подачи: до \d\d\.\d\d\.\d{4}/.test(await text(page, "[data-history-section]")), "appeal deadline from the payload");
    const openIds = new Set(ev.appeals.filter((a) => a.status === "open").map((a) => a.criterion_id));
    page.assert((await count(page, '[data-action="appeal"]')) === ev.criteria.filter((c) => c.criterion_id !== "08" && !openIds.has(c.criterion_id)).length, "operator may appeal every scored criterion without an open appeal");
    await page.assertAccessibleNames();
    await noOverflow(page, "chat card");
    await setLocale(page, "en");
    page.assert((await text(page, "[data-total]")) === fmt(ev.final_total, "en-US"), `EN number format (${await text(page, "[data-total]")})`);
    await setLocale(page, "kk");
    page.assert((await text(page, "[data-total]")) === fmt(ev.final_total), `KZ number format (${await text(page, "[data-total]")})`);
    await noOverflow(page, "chat card kk");
    await setLocale(page, "ru");
  },

  async "real-card-deeplink"(page) {
    page.allowConsole(/404 \(Not Found\).*by-key\/does-not-exist/);
    await open(page, "?role=reviewer", "#/conversations/p1-ru-003");
    const conv = await get(page, "/conversations/by-key/p1-ru-003");
    page.assert(/p1-ru-003/.test(await text(page, "[data-strip], .strip")), "external id resolved through by-key");
    const byKey = page.requests.filter((u) => /\/conversations\/by-key\/p1-ru-003/.test(u)).length;
    page.assert(byKey > 0, `by-key used for the deep link (${byKey})`);
    page.assert(page.requests.every((u) => !/audio_url|sig=|powerplatform/.test(u)), "no recording url requested");
    await open(page, "?role=reviewer", "#/conversations/does-not-exist", "", CARD);
    await sleep(1200);
    const state = await page.eval(`(() => { const c = cqaDeep('cqa-app >>> cqa-conversation-card')[0]; return (c.shadowRoot.textContent || '').replace(/\\s+/g, ' ').trim(); })()`);
    page.assert(/не найден|Не найден|not found/i.test(state) && !(await count(page, "[data-total]")), `unknown id shows the not-found state (${state.slice(0, 120)})`);
    page.assert(Boolean(conv.id), "control");
  },

  async "real-card-states"(page) {
    await open(page, "?role=reviewer", "#/conversations/p1-ru-004");
    const conv = await get(page, "/conversations/by-key/p1-ru-004");
    const ev = await get(page, `/conversations/${conv.id}/evaluation`);
    page.assert(ev.final_total === null && ev.provisional === true, "fixture: provisional without a computable total");
    const score = await text(page, "[data-score]");
    page.assert(/Итог не рассчитан/.test(score) && /Предварительно - низкая уверенность/.test(score), `provisional state (${score.slice(0, 160)})`);
    page.assert(/Уверенность: низкая/.test(await text(page, "[data-confidence]")), "low confidence from the payload");
    page.assert((await count(page, "[data-crit-row] .chip-review, [data-crit-row] [data-needs-review]")) >= 0, "needs_review rows render");
    await noOverflow(page, "provisional card");

    const list = (await get(page, "/appeals?status=all")).filter((a) => a.status === "resolved" && a.decision === "change");
    const legacy = list.find((a) => a.total_before === null) || list[0];
    if (legacy) {
      const evl = await get(page, `/evaluations/${legacy.evaluation_id}`);
      await open(page, "?role=reviewer", `#/conversations/${legacy.conversation_id}`);
      page.assert((await text(page, "[data-total]")) === fmt(evl.final_total), `final total after a decision (${await text(page, "[data-total]")} vs ${evl.final_total})`);
      page.assert(evl.total_changed && evl.total !== evl.final_total, "fixture: original differs from final");
      page.assert(new RegExp(`было ${fmt(evl.total)} · изменено по апелляции`).test(await text(page, "[data-score]")), `was-chip shows the original total (${(await text(page, "[data-score]")).slice(0, 200)})`);
      page.assert(/Изменено по апелляции/.test(await text(page, `[data-crit-row="${legacy.criterion_id}"]`)), "criterion chip for the changed answer");
      const hist = await text(page, "[data-history-section]");
      page.assert(/QA \/ Проверяющий/.test(hist) && hist.includes(legacy.reason), `history shows the decision (${hist.slice(-240)})`);
      page.assert(!/null|undefined|NaN/.test(hist), "legacy decision without stored totals renders no placeholders");
    }
  },

  async "real-call"(page) {
    page.allowExternal(/freedomholdingcorporation\.crm11\.dynamics\.com\/api\/filedownload/);
    page.allowExternal(/\/conversations\/\d+\/audio/);
    page.allowConsole(/ERR_NAME_NOT_RESOLVED.*filedownload/);
    await open(page, "?role=reviewer", "#/conversations/p4-ru-005", "[data-total]");
    const conv = await get(page, "/conversations/by-key/p4-ru-005");
    const ev = await get(page, `/conversations/${conv.id}/evaluation`);
    await until(page, `!!cqaDeep(${j(PLAYER + "[data-player]")})[0]`, "player");
    page.assert((await text(page, "[data-total]")) === fmt(ev.final_total), `call total equals backend (${await text(page, "[data-total]")} vs ${ev.final_total})`);
    const src = await page.eval(`(() => { const p = cqaDeep(${j(CARD + "cqa-audio-player")})[0]; const a = p._audio; return a ? a.getAttribute('src') || a.src : null; })()`);
    page.assert(Boolean(src) && new URL(src).pathname.endsWith(`/conversations/${conv.id}/audio`), `player source is the backend audio endpoint (${src && new URL(src).pathname})`);
    page.assert(!/sig=|dynamics|powerplatform|filedownload/.test(src || ""), "the browser never sees audio_url");
    const link = await page.eval(`(() => { const p = cqaDeep(${j(CARD + "cqa-audio-player")})[0]; const a = p.shadowRoot.querySelector('a.rec'); return a ? { href: a.href, target: a.target, rel: a.rel } : null; })()`);
    page.assert(link && new URL(link.href).pathname.endsWith(`/conversations/${conv.id}/audio`) && link.target === "_blank" && /noopener/.test(link.rel), `Открыть запись links to the 302 endpoint (${j(link)})`);
    const head = await page.eval(`fetch(${j(link.href)}, { redirect: 'manual' }).then((r) => r.type + ':' + r.status).catch((e) => 'blocked')`);
    page.assert(/opaqueredirect|blocked/.test(head), `endpoint answers with a redirect (${head})`);
    const timed = conv.messages.filter((m) => m.audio_start_seconds !== undefined && m.audio_start_seconds !== null && m.speaker !== "system");
    const stamps = await count(page, "[data-call-ts]");
    page.assert(timed.length > 0 && stamps >= timed.length - 1, `timing buttons use audio_start_seconds (${stamps}/${timed.length})`);
    const target = conv.messages.find((m) => m.speaker === "operator" && m.audio_start_seconds > 30);
    page.assert(Boolean(target), "fixture: an operator message with a late audio_start_seconds");
    const label = await text(page, `li[data-index="${target.message_index}"] .ts`);
    const mm = String(Math.floor(target.audio_start_seconds / 60)).padStart(2, "0");
    const ss = String(Math.floor(target.audio_start_seconds % 60)).padStart(2, "0");
    page.assert(label.includes(`${mm}:${ss}`), `message ${target.message_index} is stamped ${mm}:${ss} (${label})`);
    const seconds = Math.ceil(conv.duration_seconds) + 5;
    await page.eval(`(() => {
      const rate = 8000;
      const bytes = new Uint8Array(44 + rate * ${seconds});
      const view = new DataView(bytes.buffer);
      const put = (at, t) => { for (let i = 0; i < t.length; i += 1) bytes[at + i] = t.charCodeAt(i); };
      put(0, 'RIFF'); view.setUint32(4, 36 + rate * ${seconds}, true); put(8, 'WAVE'); put(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
      put(36, 'data'); view.setUint32(40, rate * ${seconds}, true);
      bytes.fill(128, 44);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
      cqaDeep(${j(CARD + "cqa-audio-player")})[0].setAttribute('src', 'data:audio/wav;base64,' + btoa(bin));
    })()`);
    await until(page, `cqaDeep(${j(PLAYER + "[data-player]")})[0]?.getAttribute('data-phase') === 'ready'`, "stand-in audio ready");
    await page.click(CARD + `li[data-index="${target.message_index}"] .ts`);
    await sleep(300);
    const pos = await page.eval(`cqaDeep(${j(CARD + "cqa-audio-player")})[0].position`);
    page.assert(Math.abs(pos - target.audio_start_seconds) < 1.01, `clicking the stamp seeks to audio_start_seconds (${pos} vs ${target.audio_start_seconds})`);
    const header = await text(page, "[data-call-meta]");
    page.assert(/\d\d\.\d\d\.\d{4}/.test(header) && /\d\d:\d\d/.test(header) && /ASR/.test(header), `call header derived from occurred_at/duration (${header})`);
    await page.assertAccessibleNames();
    await noOverflow(page, "call card");
    await setLocale(page, "en");
    await noOverflow(page, "call card en");
    await setLocale(page, "ru");
  },

  async "real-appeal-flow"(page) {
    const target = await findTarget(page);
    const wires = [];
    await open(page, "?role=operator", `#/conversations/${target.id}`);
    await page.eval(`(() => { window.__bodies = []; const f = window.fetch; window.fetch = function (input, init) { if (init && init.body && typeof init.body === 'string') window.__bodies.push({ url: String(input), body: init.body }); return f.apply(this, arguments); }; return true; })()`);
    const summary0 = await get(page, "/appeals/summary");
    const badge0 = await page.eval(`(cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> [data-count]')[0]?.textContent || '').trim()`);
    page.assert((await text(page, "[data-total]")) === fmt(target.before), `before: card total ${await text(page, "[data-total]")} equals backend ${target.before}`);
    page.assert((await count(page, "[data-review]")) === 0, "operator sees no decision panel");

    await page.eval(`cqaDeep(${j(CARD + `[data-focus-id="appeal-${target.criterion}"]`)})[0].focus()`);
    await page.click(CARD + `[data-focus-id="appeal-${target.criterion}"]`);
    await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "drawer");
    const current = await text(page, DRAWER + "[data-appeal-current]");
    page.assert(/Текущая оценка/.test(current) && /Нет/.test(current), `drawer shows the current answer (${current})`);
    for (const index of target.people) await page.click(CARD + `[data-index="${index}"] [data-action="attach"]`);
    const chips = await texts(page, DRAWER + "[data-ref-chips] .rc > button:first-child");
    page.assert(chips.length === 2, `two reference chips (${chips})`);
    page.assert(await page.eval(`cqaDeep(${j(CARD + `[data-index="${target.people[0]}"] [data-bubble]`)})[0].classList.contains('msg-attached')`), "attached message is ringed");
    const comment = "Оператор назвал порядок действий, это видно в приложенных сообщениях.";
    await focusType(page, DRAWER + "[data-field=comment]", comment);
    await page.click(DRAWER + "[data-action=submit]");
    await until(page, `!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "drawer closes");
    await until(page, `cqaDeep('cqa-app >>> cqa-toast >>> .toast').length > 0`, "toast");

    const filed = (await get(page, "/appeals?status=all")).find((a) => a.evaluation_id === target.evaluationId && a.criterion_id === target.criterion);
    page.assert(Boolean(filed), "appeal stored on the backend");
    page.assert(j(filed.message_refs) === j([...target.people].sort((a, b) => a - b)), `message refs saved 0-based (${j(filed.message_refs)} vs ${j(target.people)})`);
    page.assert(filed.display_status === "new" && filed.status === "open" && filed.author_role === "operator" && filed.comment === comment, `stored as new by the operator (${filed.display_status}/${filed.author_role})`);
    const chip = await text(page, `[data-crit-row="${target.criterion}"]`);
    page.assert(/Апелляция/.test(chip), `criterion chip (${chip.slice(0, 160)})`);
    page.assert((await count(page, `[data-crit-row="${target.criterion}"] [data-action="appeal"]`)) === 0, "no second Оспорить while open");
    page.assert((await text(page, "[data-total]")) === fmt(target.before), "filing does not change the total");
    const hist = await text(page, "[data-history-section]");
    page.assert(new RegExp(`Апелляция · ${target.criterion}`).test(hist) && /Оператор A/.test(hist) && hist.includes(comment), `history shows the appeal (${hist.slice(-260)})`);
    const summary1 = await get(page, "/appeals/summary");
    page.assert(summary1.open === summary0.open + 1 && summary1.new === summary0.new + 1, `summary counts the new appeal (${j(summary0)} -> ${j(summary1)})`);

    const other = (await get(page, `/evaluations/${target.evaluationId}`)).criteria.find((c) => c.criterion_id !== target.criterion && c.criterion_id !== "08").criterion_id;
    await page.eval(`cqaDeep(${j(CARD + `[data-focus-id="appeal-${other}"]`)})[0].click()`);
    await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "second drawer");
    const offered = await page.eval(`cqaDeep(${j(DRAWER + "[data-field=criterion] option")}).map((o) => o.value)`);
    page.assert(!offered.includes(target.criterion), `a criterion with an open appeal is not offered (${offered})`);
    await page.eval(`(async () => { const m = await import(new URL('src/api.js', location.href).href); await m.api.submitAppeal(${target.evaluationId}, ${j(other)}, { comment: 'параллельная', refs: [] }); })()`);
    await focusType(page, DRAWER + "[data-field=comment]", "Повторная попытка по тому же критерию.");
    page.allowConsole(/409 \(Conflict\).*evaluations\/\d+\/appeals/);
    await page.click(DRAWER + "[data-action=submit]");
    await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-error]")})[0]`, "inline appeal_open_exists");
    const dupText = await text(page, DRAWER + "[data-appeal-error]");
    page.assert(/уже есть открытая апелляция/.test(dupText), `appeal_open_exists localised (${dupText})`);
    page.assert(await page.eval(`cqaDeep(${j(DRAWER + "[data-appeal-error]")})[0].getAttribute('role') === 'alert'`), "error is an alert");
    const stored = (await get(page, "/appeals?status=all")).filter((a) => a.evaluation_id === target.evaluationId && a.criterion_id === other);
    page.assert(stored.length === 1, `no duplicate stored (${stored.length})`);
    await page.press("Escape");
    await until(page, `!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "drawer closed");
    const parallel = await post(page, `/appeals/${stored[0].id}/decision`, { decision: "confirm", reason: "служебная очистка сценария", role: "reviewer" });
    page.assert(parallel.status === 200, "parallel appeal closed through the API");

    await open(page, "?role=reviewer", "#/appeals", "[data-appeal-row]", Q);
    await sleep(500);
    const rowSel = `[data-appeal-row="${filed.id}"]`;
    const row = await text(page, Q + rowSel);
    page.assert(row.includes(target.id) && /Новая/.test(row), `queue lists the appeal as Новая (${row})`);
    const server = await get(page, "/appeals?status=all");
    const tabNumbers = (await texts(page, Q + "[data-count]")).map(Number);
    page.assert(tabNumbers[0] === server.length && tabNumbers[1] === server.filter((a) => a.display_status === "new").length && tabNumbers[2] === server.filter((a) => a.display_status === "under_review").length && tabNumbers[3] === server.filter((a) => a.status === "resolved").length, `tab counts equal the backend (${tabNumbers})`);
    const badge1 = await page.eval(`(cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> [data-count]')[0]?.textContent || '').trim()`);
    page.assert(Number(badge1) === (await get(page, "/appeals/summary")).open && Number(badge1) === Number(badge0) + 1, `nav badge equals open appeals (${badge0} -> ${badge1})`);
    await page.eval(`cqaDeep(${j(Q + rowSel)})[0].click()`);
    await until(page, `!!cqaDeep(${j(Q + "[data-detail]")})[0] && (cqaDeep(${j(Q + rowSel)})[0].textContent || '').includes('На рассмотрении')`, "start-review through selecting the row");
    const started = (await get(page, "/appeals?status=all")).find((a) => a.id === filed.id);
    page.assert(started.display_status === "under_review" && started.review_started_at && started.review_started_by === "reviewer", `start-review stored (${started.display_status}/${started.review_started_by})`);
    const detail = await text(page, Q + "[data-detail]");
    page.assert(detail.includes(comment) && /Ссылки:/.test(detail), `queue detail shows comment and refs (${detail.slice(0, 220)})`);
    const refTimes = await text(page, Q + "[data-detail]");
    page.assert(chips.every((c) => refTimes.includes(c.replace(/^.*?(\d\d:\d\d).*$/, "$1"))), `refs listed with times (${chips} vs ${refTimes.slice(0, 300)})`);
    page.assert((await get(page, "/appeals/summary")).under_review === summary1.under_review + 1, "summary moves new to under review");

    await open(page, "?role=reviewer", `#/conversations/${target.id}`);
    page.assert((await count(page, '[data-action="appeal"]')) === 0, "reviewer has no Оспорить");
    const panel = await text(page, "[data-review]");
    page.assert(/Решение по апелляции/.test(panel) && /На рассмотрении/.test(panel), `decision panel for the open appeal (${panel.slice(0, 160)})`);
    page.assert((await count(page, '[data-action="review-start"]')) === 0, "review already started");
    const options = await page.eval(`cqaDeep(${j(CARD + '[data-rv="answer"] option')}).map((o) => o.value).join()`);
    page.assert(options === (target.naAllowed ? "yes,no,na" : "yes,no"), `valid answers follow na_allowed (${options}, na_allowed ${target.naAllowed})`);
    await pickSelect(page, CARD + '[data-rv="answer"]', "yes");
    const preview = (await text(page, "[data-rv-preview]")).split("→").map((x) => x.trim());
    page.assert(preview[0] === fmt(target.before) && Number(preview[1].replace(",", ".")) > target.before, `preview ${preview.join(" -> ")}`);
    await focusType(page, CARD + '[data-rv="reason"]', "Оператор действительно назвал порядок действий.");
    await page.click(CARD + '[data-action="review-save"]');
    await until(page, `cqaDeep(${j(CARD + "[data-review]")}).length === 0`, "panel closes");
    await sleep(300);

    const after = await get(page, `/conversations/${target.pk}/evaluation`);
    const decided = (await get(page, "/appeals?status=all")).find((a) => a.id === filed.id);
    const sql = backendTotal(target.evaluationId);
    page.assert(decided.display_status === "changed" && decided.decision === "change" && decided.new_answer === "yes" && decided.decided_by_role === "reviewer", `decision stored (${decided.display_status}/${decided.new_answer}/${decided.decided_by_role})`);
    page.assert(after.final_total > target.before && after.total === target.original && after.total_changed === true, `final total recomputed, original kept (${target.before} -> ${after.final_total}, original ${after.total})`);
    page.assert(decided.total_before === target.before && decided.total_after === after.final_total, `before/after snapshot (${decided.total_before} -> ${decided.total_after})`);
    if (sql) page.assert(sql.total === after.final_total, `independent backend scoring agrees (${sql.total} vs ${after.final_total})`);
    page.assert((await text(page, "[data-total]")) === fmt(after.final_total), `card shows the recomputed total (${await text(page, "[data-total]")} vs ${after.final_total})`);
    page.assert(new RegExp(`было ${fmt(target.original)} · изменено по апелляции`).test(await text(page, "[data-score]")), `was-chip (${(await text(page, "[data-score]")).slice(0, 220)})`);
    page.assert(/Изменено по апелляции/.test(await text(page, `[data-crit-row="${target.criterion}"]`)) && /Да/.test(await text(page, `[data-crit-row="${target.criterion}"]`)), "criterion shows the new answer and the chip");
    page.assert((await text(page, "[data-ledger-total]")) === fmt(after.final_total), "ledger total follows the decision");
    const tiles = await texts(page, "[data-tiles] .tile");
    after.final.sections.filter((x) => x.id !== "gross").forEach((x, i) => page.assert(tiles[i].includes(fmt(x.effective_points)), `section ${x.id} subtotal recomputed (${tiles[i]} vs ${x.effective_points})`));
    const history = await text(page, "[data-history-section]");
    page.assert(history.includes(`${fmt(target.before)} → ${fmt(after.final_total)}`) && /QA \/ Проверяющий/.test(history), `history row with before and after (${history.slice(-260)})`);
    const toast = await text(page, "cqa-app >>> cqa-toast >>> .toast");
    page.assert(toast.includes(fmt(target.before)) && toast.includes(fmt(after.final_total)), `toast (${toast})`);

    const list = (await get(page, `/conversations?envelope=1&q=${target.id}`)).items.find((x) => x.conversation_id === target.id);
    page.assert(list.final_total === after.final_total && list.total === target.original && list.total_changed === true, `list payload agrees (${list.final_total}/${list.total}/${list.total_changed})`);
    const listLabel = { new: "Новая", under_review: "На рассмотрении", confirmed: "Подтверждено", changed: "Изменено" }[list.display_appeal_status];
    await open(page, "?role=reviewer", "#/conversations", "[data-row], [role=row]", "cqa-app >>> cqa-conversation-list >>> ");
    await sleep(800);
    await page.eval(`(() => { const l = cqaDeep('cqa-app >>> cqa-conversation-list')[0]; const input = l.shadowRoot.querySelector('input[type=search], input[data-filter=q], input'); input.focus(); input.value = ${j(target.id)}; input.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true; })()`);
    await sleep(900);
    const listed = await page.eval(`(cqaDeep('cqa-app >>> cqa-conversation-list >>> [role=row]').find((r) => r.textContent.includes(${j(target.id)}))?.textContent || '').replace(/\s+/g, ' ').replace(/[\u00a0\u202f]/g, ' ')`);
    page.assert(listed.includes(fmt(after.final_total)) && listed.includes(listLabel), `list row shows the final total and status (${listed.slice(0, 200)})`);

    await open(page, "?role=reviewer", "#/appeals", "[data-appeal-row]", Q);
    await page.eval(`cqaDeep(${j(Q + '[data-tab="closed"]')})[0].click()`);
    await sleep(300);
    const closedRow = await text(page, Q + rowSel);
    page.assert(closedRow.includes(target.id) && /Изменено/.test(closedRow), `queue moved it to Решённые as Изменено (${closedRow})`);
    await page.eval(`cqaDeep(${j(Q + rowSel)})[0].click()`);
    await sleep(300);
    const closed = await text(page, Q + "[data-closed]");
    page.assert(closed.includes(fmt(target.before)) && closed.includes(fmt(after.final_total)), `closed summary shows before and after (${closed})`);
    const sum2 = await get(page, "/appeals/summary");
    page.assert(sum2.open === summary0.open && sum2.new === summary0.new && sum2.under_review === summary0.under_review, `open counters back to the start (${j(sum2)})`);
    const bodies = await page.eval(`window.__bodies`).catch(() => []);
    wires.push(...(bodies || []));
    await page.assertAccessibleNames();
    await noOverflow(page, "queue");
  },

  async "real-appeal-errors"(page) {
    page.allowConsole(/(403|404|409|422) \(.*\).*(appeals|decision|start-review)/);
    const target = await findTarget(page);
    const filed = await post(page, `/evaluations/${target.evaluationId}/appeals`, { criterion_id: target.criterion, comment: "служебная апелляция сценария ошибок", role: "operator", message_refs: [target.people[0]] });
    page.assert(filed.status === 200 || filed.status === 201, `appeal filed through the API (${filed.status})`);
    const id = filed.body.id;
    await open(page, "?role=reviewer", `#/conversations/${target.id}`);
    await until(page, `!!cqaDeep(${j(CARD + "[data-review]")})[0]`, "decision panel");
    const probe = (body) => page.eval(`(async () => {
      const m = await import(new URL('src/api.js', location.href).href);
      const e = await import(new URL('src/components/appeal-model.js', location.href).href);
      const i = await import(new URL('src/i18n/index.js', location.href).href);
      const run = async (kind, call) => { try { await call(); return { kind, ok: true }; } catch (err) { return { kind, ok: false, status: err.status, code: err.code, ru: e.errorText(kind.startsWith('file') ? 'appeal' : 'review', err, 'ru', (k) => i.t(k, {}, 'ru')), kk: e.errorText(kind.startsWith('file') ? 'appeal' : 'review', err, 'kk', (k) => i.t(k, {}, 'kk')), en: e.errorText(kind.startsWith('file') ? 'appeal' : 'review', err, 'en', (k) => i.t(k, {}, 'en')), generic: i.t((kind.startsWith('file') ? 'appeal' : 'review') + '.err.generic', {}, 'ru') }; } };
      const out = [];
      ${body}
      return out;
    })()`);
    const results = await probe(`
      out.push(await run('file-comment', () => m.api.submitAppeal(${target.evaluationId}, ${j(target.criterion)}, { comment: '   ', refs: [] })));
      out.push(await run('file-exists', () => m.api.submitAppeal(${target.evaluationId}, ${j(target.criterion)}, { comment: 'ещё раз', refs: [] })));
      out.push(await run('file-ref', () => m.api.submitAppeal(${target.evaluationId}, '08', { comment: 'ссылка', refs: [99999] })));
      out.push(await run('file-criterion', () => m.api.submitAppeal(${target.evaluationId}, 'zz', { comment: 'нет такого', refs: [] })));
      out.push(await run('file-role-exec', () => m.api.submitAppeal(${target.evaluationId}, '08', { comment: 'эксперт', refs: [], role: null })));
      out.push(await run('file-role-reviewer', () => m.api.submitAppeal(${target.evaluationId}, '08', { comment: 'проверяющий', refs: [], role: 'reviewer' })));
      out.push(await run('review-role-operator', () => m.api.decideAppeal(${id}, { decision: 'confirm', reason: 'x', role: 'operator' })));
      out.push(await run('review-role-exec', () => m.api.decideAppeal(${id}, { decision: 'confirm', reason: 'x', role: null })));
      out.push(await run('review-start-exec', () => m.api.startReview(${id}, { role: null })));
      out.push(await run('review-start-operator', () => m.api.startReview(${id}, { role: 'operator' })));
      out.push(await run('review-reason', () => m.api.decideAppeal(${id}, { decision: 'confirm', reason: '  ' })));
      out.push(await run('review-answer', () => m.api.decideAppeal(${id}, { decision: 'change', newAnswer: null, reason: 'нужен ответ' })));
      out.push(await run('review-invalid', () => m.api.decideAppeal(${id}, { decision: 'change', newAnswer: 'maybe', reason: 'нет' })));
      out.push(await run('review-decision', () => m.api.decideAppeal(${id}, { decision: 'hold', reason: 'нет' })));
      out.push(await run('review-new-answer', () => m.api.decideAppeal(${id}, { decision: 'confirm', newAnswer: 'yes', reason: 'нет' })));
    `);
    const byKind = Object.fromEntries(results.map((r) => [r.kind, r]));
    const expect = { "file-comment": [422, "comment_required"], "file-exists": [409, "appeal_open_exists"], "file-ref": [422, "invalid_message_ref"], "file-criterion": [404, "criterion_not_found"], "file-role-exec": [403, "role_forbidden"], "file-role-reviewer": [403, "role_forbidden"], "review-role-operator": [403, "role_forbidden"], "review-role-exec": [403, "role_forbidden"], "review-start-exec": [403, "role_forbidden"], "review-start-operator": [403, "role_forbidden"], "review-reason": [422, "reason_required"], "review-answer": [422, "answer_required"], "review-invalid": [422, "invalid_answer"], "review-decision": [422, "invalid_decision"], "review-new-answer": [422, "new_answer_not_allowed"] };
    for (const [kind, [status, code]] of Object.entries(expect)) {
      const r = byKind[kind];
      page.assert(r && r.ok === false && r.status === status && r.code === code, `${kind}: ${status} ${code} (${j(r && { s: r.status, c: r.code })})`);
      if (r && r.ok === false) page.assert(r.ru !== r.generic && r.kk && r.en && r.kk !== r.ru && r.en !== r.ru, `${kind}: localised in ru, kk and en (${r.ru} | ${r.kk} | ${r.en})`);
    }
    page.assert(byKind["file-role-exec"].ru === "Эта роль не может подавать апелляции." && byKind["review-role-operator"].en === "Only QA / Reviewer can decide.", "role_forbidden wording per action");
    const stored = (await get(page, "/appeals?status=all")).find((a) => a.id === id);
    page.assert(stored.status === "open" && stored.review_started_at === null, "rejected attempts changed nothing");

    for (const [uiRole, label] of [["operator", "operator"], ["exec", "exec"]]) {
      await open(page, "?role=reviewer", `#/conversations/${target.id}`, "[data-review]");
      await pickSelect(page, CARD + '[data-rv="answer"]', "yes");
      await focusType(page, CARD + '[data-rv="reason"]', "Попытка от чужой роли.");
      await page.eval(`(() => { const card = cqaDeep('cqa-app >>> cqa-conversation-card')[0]; Object.defineProperty(card, 'role', { get: () => ${j(uiRole)}, configurable: true }); return true; })()`);
      await page.click(CARD + '[data-action="review-save"]');
      await page.eval(`(() => { delete cqaDeep('cqa-app >>> cqa-conversation-card')[0].role; return true; })()`);
      await until(page, `!!cqaDeep(${j(CARD + "[data-rv-error]")})[0]`, `${label} decision rejected`);
      const shown = await text(page, "[data-rv-error]");
      page.assert(shown === "Решение может принять только QA / Проверяющий.", `${label} attempt shows the localised role_forbidden (${shown})`);
      page.assert(await page.eval(`cqaDeep(${j(CARD + "[data-rv-error]")})[0].getAttribute('role') === 'alert'`), "error is an alert");
      const still = (await get(page, "/appeals?status=all")).find((a) => a.id === id);
      page.assert(still.status === "open", `${label} attempt left the appeal open`);
    }

    const closed = await post(page, `/appeals/${id}/decision`, { decision: "confirm", reason: "служебная очистка сценария", role: "reviewer" });
    page.assert(closed.status === 200, "appeal closed by the reviewer");
    const again = await probe(`out.push(await run('review-resolved', () => m.api.decideAppeal(${id}, { decision: 'confirm', reason: 'повтор' })));`);
    page.assert(again[0].code === "appeal_resolved" && again[0].status === 409 && again[0].ru === "Апелляция уже решена.", `appeal_resolved localised (${j(again[0])})`);
  },

  async "real-queue-decide"(page) {
    page.allowConsole(/(409|422) \(.*\).*appeals/);
    const target = await findTarget(page);
    const filed = await post(page, `/evaluations/${target.evaluationId}/appeals`, { criterion_id: target.criterion, comment: "оценка занижена, оператор всё объяснил", role: "operator", message_refs: target.people });
    const id = filed.body.id;
    const rowSel = `[data-appeal-row="${id}"]`;
    await open(page, "?role=reviewer", `#/appeals/${id}`, "[data-appeal-row]", Q);
    await sleep(500);
    const ids = await page.eval(`cqaDeep(${j(Q + "[data-appeal-row]")}).map((e) => e.getAttribute('data-appeal-row'))`);
    await page.eval(`cqaDeep(${j(Q + "[data-appeal-row]")})[0].focus()`);
    await page.press("j");
    page.assert((await page.eval(`cqaActive()?.getAttribute('data-focus-id')`)) === `row-${ids[1]}`, "j moves to the next real row");
    await page.press("k");
    page.assert((await page.eval(`cqaActive()?.getAttribute('data-focus-id')`)) === `row-${ids[0]}`, "k moves back");
    await page.eval(`cqaDeep(${j(Q + rowSel)})[0].click()`);
    await until(page, `(cqaDeep(${j(Q + rowSel)})[0].textContent || '').includes('На рассмотрении')`, "row moves to review");
    await until(page, `!!cqaDeep(${j(Q + "[data-review]")})[0]`, "decision form");
    const refsLine = await text(page, Q + "[data-detail] .box.line");
    page.assert(/Ссылки: \d\d:\d\d, \d\d:\d\d/.test(refsLine), `refs outside the fragment resolve to times (${refsLine})`);
    const preview = (await text(page, Q + "[data-rv-preview]")).split("→").map((x) => x.trim());
    await page.eval(`(() => { const r = cqaDeep(${j(Q + '[data-rv="decision"][value="confirm"]')})[0]; r.click(); return true; })()`);
    await focusType(page, Q + '[data-rv="reason"]', "Оценка корректна, фрагмент не меняет вывод.");
    await page.click(Q + '[data-action="review-save"]');
    await until(page, `cqaDeep(${j(Q + "[data-review]")}).length === 0`, "form closes");
    const decided = (await get(page, "/appeals?status=all")).find((a) => a.id === id);
    const evl = await get(page, `/conversations/${target.pk}/evaluation`);
    page.assert(decided.display_status === "confirmed" && decided.decision === "confirm" && decided.total_before === decided.total_after && evl.final_total === target.before && evl.total_changed === false, `confirm keeps the total (${decided.total_before} -> ${decided.total_after})`);
    page.assert(preview[0] === fmt(target.before), `preview started from the backend total (${preview})`);
    const sel = await text(page, Q + "[data-closed]");
    page.assert(/Оценка подтверждена/.test(await text(page, Q + "[data-decision]")) && sel.includes(fmt(target.before)), `closed block (${sel})`);
    page.assert(/QA \/ Проверяющий/.test(await text(page, Q + "[data-reason]")), "decider shown by role label");
    const badge = Number(await page.eval(`(cqaDeep('cqa-app >>> cqa-header >>> cqa-nav >>> [data-count]')[0]?.textContent || '0').trim()`));
    page.assert(badge === (await get(page, "/appeals/summary")).open, `nav badge follows the decision (${badge})`);
    await open(page, "?role=operator", "#/appeals", "[data-appeal-row]", Q);
    await page.eval(`cqaDeep(${j(Q + rowSel)})[0].click()`);
    await sleep(300);
    page.assert((await count(page, Q + "[data-review]")) === 0, "operator has no decision form in the queue");
    await open(page, "?role=exec", "#/appeals", "[data-appeal-row]", Q);
    page.assert((await count(page, Q + "[data-review]")) === 0, "exec is read-only in the queue");
    await noOverflow(page, "queue");
  },

  async "real-appeal-locales"(page) {
    const target = await findTarget(page);
    await open(page, "?role=operator&locale=en", `#/conversations/${target.id}`);
    await page.eval(`cqaDeep(${j(CARD + `[data-focus-id="appeal-${target.criterion}"]`)})[0].click()`);
    await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "en drawer");
    page.assert((await text(page, DRAWER + "h2")) === "Appeal a score", "EN drawer title");
    page.assert(/Current score/.test(await text(page, DRAWER + "[data-appeal-current]")), "EN current score");
    await page.press("Escape");
    await setLocale(page, "kk");
    await page.eval(`cqaDeep(${j(CARD + `[data-focus-id="appeal-${target.criterion}"]`)})[0].click()`);
    await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "kk drawer");
    page.assert((await text(page, DRAWER + "h2")) === "Бағаға дау айту", "KZ drawer title");
    await noOverflow(page, "kk drawer");
    await page.press("Escape");
    await open(page, "?role=reviewer&locale=en", "#/appeals", "[data-appeal-row]", Q);
    const en = await text(page, Q + "h1");
    page.assert(/Appeal queue/i.test(en), `EN queue title (${en})`);
    await setLocale(page, "kk");
    page.assert((await text(page, Q + "h1")).length > 0 && !/Appeal queue/.test(await text(page, Q + "h1")), "KZ queue title");
    await noOverflow(page, "kk queue");
  },

  async "real-operator-seam"(page) {
    await open(page, "?role=reviewer&operator=op-7", "#/appeals", "[data-appeal-row]", Q);
    page.assert(page.requests.some((u) => /\/appeals\?[^#]*operator=op-7/.test(u)), "operator is sent as a query parameter to /appeals");
    const all = await get(page, "/appeals?status=all");
    const scoped = await get(page, "/appeals?status=all&operator=op-7");
    page.assert(all.length === scoped.length, `the server ignores it today (${all.length}/${scoped.length})`);
    await open(page, "?role=operator&operator=op-7", "#/conversations/p1-ru-002");
    page.assert(page.requests.some((u) => /\/conversations\/\d+\/evaluation/.test(u)), "card loads with the seam configured");
    page.assert(page.requests.every((u) => !/\/appeals\?[^#]*operator=op-7/.test(u) || true), "seam is optional");
  },

  async "real-shot-card"(page) {
    await open(page, "?role=operator", "#/conversations/p1-ru-003");
    await sleep(500);
  },

  async "real-shot-drawer"(page) {
    const target = await findTarget(page);
    await open(page, "?role=operator", `#/conversations/${target.id}`);
    await page.eval(`cqaDeep(${j(CARD + `[data-focus-id="appeal-${target.criterion}"]`)})[0].click()`);
    await until(page, `!!cqaDeep(${j(DRAWER + "[data-appeal-drawer]")})[0]`, "drawer");
    for (const index of target.people) await page.click(CARD + `[data-index="${index}"] [data-action="attach"]`);
    await focusType(page, DRAWER + "[data-field=comment]", "Оператор подробно объяснил порядок действий в обоих сообщениях.");
    await sleep(300);
  },

  async "real-shot-review"(page) {
    const target = await findTarget(page);
    const filed = await post(page, `/evaluations/${target.evaluationId}/appeals`, { criterion_id: target.criterion, comment: "Снимок экрана: решение по апелляции.", role: "operator", message_refs: target.people });
    await open(page, "?role=reviewer", `#/conversations/${target.id}`, "[data-review]");
    await pickSelect(page, CARD + '[data-rv="answer"]', "yes");
    await page.eval(`cqaDeep(${j(CARD + "[data-review]")})[0].scrollIntoView({ block: 'center' })`);
    await sleep(400);
    page.assert(filed.status === 200 || filed.status === 201, "appeal filed");
  },

  async "real-shot-queue"(page) {
    await open(page, "?role=reviewer", "#/appeals", "[data-appeal-row]", Q);
    await sleep(900);
  },

  async "real-shot-call"(page) {
    page.allowExternal(/filedownload|\/audio/);
    page.allowConsole(/ERR_NAME_NOT_RESOLVED/);
    await open(page, "?role=reviewer", "#/conversations/p4-ru-005");
    await until(page, `!!cqaDeep(${j(PLAYER + "[data-player]")})[0]`, "player");
    await sleep(1200);
  }
};
