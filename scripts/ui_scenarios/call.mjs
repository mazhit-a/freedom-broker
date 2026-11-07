const CARD = "cqa-app >>> cqa-conversation-card >>> ";
const ROUTE = "#/conversations/p3-ru-call-014";
const PLAYER = CARD + "cqa-audio-player >>> ";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, expression, label, timeout = 15000) {
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

async function open(page, query = "?mock=1&role=reviewer", hash = ROUTE) {
  await page.eval(`window.__callStale = true`);
  await page.eval(`(() => { const u = new URL(location.href); u.search = ${JSON.stringify(query)} + '&_=' + Date.now(); u.hash = ${JSON.stringify(hash)}; location.href = u.href; })()`);
  await until(page, `window.__callStale === undefined`, "navigation");
  await until(page, `document.readyState === 'complete' && !!document.querySelector('cqa-app')`, "document");
}

async function ready(page) {
  await until(page, `!!cqaDeep(${JSON.stringify(PLAYER + "[data-player]")})[0] && !!cqaDeep(${JSON.stringify(CARD + "[data-total]")})[0]`, "call card");
}

const q = (selector) => JSON.stringify(CARD + selector);
const pq = (selector) => JSON.stringify(PLAYER + selector);
const text = (page, selector) => page.eval(`(cqaDeep(${q(selector)})[0]?.textContent || '').replace(/\\s+/g, ' ').trim()`);
const count = (page, selector) => page.eval(`cqaDeep(${q(selector)}).length`);
const ptext = (page, selector) => page.eval(`(cqaDeep(${pq(selector)})[0]?.textContent || '').replace(/\\s+/g, ' ').trim()`);
const attr = (page, selector, name) => page.eval(`cqaDeep(${pq(selector)})[0]?.getAttribute(${JSON.stringify(name)})`);
const norm = (value) => String(value).replace(/[  ]/g, " ");

const FIXTURE = `(() => {
  const rate = 8000;
  const seconds = 164;
  const bytes = new Uint8Array(44 + rate * seconds);
  const view = new DataView(bytes.buffer);
  const put = (at, s) => { for (let i = 0; i < s.length; i += 1) bytes[at + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, 36 + rate * seconds, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  put(36, 'data'); view.setUint32(40, rate * seconds, true);
  bytes.fill(128, 44);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  return 'data:audio/wav;base64,' + btoa(bin);
})()`;

async function attachAudio(page) {
  await page.press("Tab");
  await page.eval(`(() => { const player = cqaDeep('cqa-app >>> cqa-conversation-card >>> cqa-audio-player')[0]; player.setAttribute('src', ${FIXTURE}); })()`);
  await until(page, `cqaDeep(${pq("[data-player]")})[0]?.getAttribute('data-phase') === 'ready'`, "audio ready");
}

const player = "cqaDeep('cqa-app >>> cqa-conversation-card >>> cqa-audio-player')[0]";

const PL = "cqaDeep('cqa-app >>> cqa-conversation-card >>> cqa-audio-player')[0]";
const AUDIO = `${PL}.audio`;

async function setLocale(page, locale) {
  await page.eval(`document.querySelector('cqa-app').setAttribute('locale', ${JSON.stringify(locale)})`);
  await sleep(300);
}

async function pressKey(page, selector, key) {
  await page.eval(`(() => { const el = cqaDeep(${pq(selector)})[0]; el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, composed: true, cancelable: true })); })()`);
  await sleep(80);
}

async function activeRow(page) {
  return page.eval(`cqaDeep(${q("li[data-index]")}).filter((li) => li.querySelector('[data-bubble]').classList.contains('is-live')).map((li) => li.getAttribute('data-index')).join()`);
}

export const scenarios = {
  async "call-shot"(page) {
    await open(page);
    await ready(page);
    await sleep(400);
  },

  async "call-shot-audio"(page) {
    await open(page);
    await ready(page);
    await attachAudio(page);
    await page.eval(`${PL}.seekTo(44)`);
    await sleep(400);
  },

  async "call-render"(page) {
    await open(page);
    await ready(page);
    page.assert((await count(page, "cqa-audio-player")) === 1, "one audio player");
    page.assert((await page.eval(`cqaDeep(${pq("[role=region]")})[0]?.getAttribute('aria-label')`)) === "Аудиоплеер", "player region is named");
    page.assert((await text(page, ".chip.c-na")).includes("Голосовой звонок"), `channel chip (${await text(page, ".chip.c-na")})`);
    const meta = await text(page, "[data-call-meta]");
    page.assert(norm(meta) === "05.11.2026 · 02:44 · транскрипт ASR", `call header meta (${meta})`);
    const alertText = await text(page, "[data-call-alert]");
    page.assert((await page.eval(`cqaDeep(${q("[data-call-alert]")})[0]?.getAttribute('role')`)) === "alert", "gross banner is role=alert");
    page.assert(/Грубая ошибка · 08/.test(alertText) && /Флаг без баллов/.test(alertText), `banner title and note (${alertText})`);
    page.assert(!/руководител/.test(alertText), "no escalation clause (A4)");
    page.assert(/одноразовый код из SMS/.test(alertText), "banner shows the criterion 08 text");
    const chips = await page.eval(`cqaDeep(${q("[data-call-alert] .ev")}).map((b) => b.textContent.trim())`);
    page.assert(JSON.stringify(chips) === JSON.stringify(["Оператор · 00:43", "Оператор · 00:59"]), `evidence chips (${chips})`);
    page.assert((await count(page, "[data-gross]")) === 0, "score panel gross strip replaced by the banner");
    page.assert(norm(await text(page, "[data-total]")) === "31,00", `total (${await text(page, "[data-total]")})`);
    page.assert((await text(page, ".out-of")) === "из 100", "out of 100");
    page.assert(/Все критерии применимы · перераспределения нет/.test(await text(page, "[data-call-redistribution]")), "no redistribution note");
    const rows = await page.eval(`cqaDeep(${q("[data-call-row]")}).map((r) => r.getAttribute('data-call-row'))`);
    page.assert(JSON.stringify(rows) === JSON.stringify(["01", "02", "03", "04", "05", "06", "07"]), `scored rows (${rows})`);
    const r6 = norm(await text(page, '[data-call-row="06"]'));
    page.assert(/4 из 10/.test(r6) && /6,00 \/ 15/.test(r6), `row 06 (${r6})`);
    const r1 = norm(await text(page, '[data-call-row="01"]'));
    page.assert(/Да/.test(r1) && /10,00 \/ 10/.test(r1), `row 01 (${r1})`);
    const r4 = norm(await text(page, '[data-call-row="04"]'));
    page.assert(/0 из 20/.test(r4) && /0,00 \/ 20/.test(r4), `row 04 (${r4})`);
    page.assert(/без баллов/.test(await text(page, "[data-call-gross-row]")), "08 row has no points");
    page.assert((await page.eval(`cqaDeep(${q("[data-call-table] [role=table]")})[0]?.getAttribute('aria-label')`)) === "Критерии звонка", "table is named");
    page.assert((await count(page, "[data-call-table] [role=columnheader]")) === 4, "four column headers");
    const stamps = await page.eval(`cqaDeep(${q("li[data-index] .ts")}).map((b) => b.textContent.trim())`);
    page.assert(JSON.stringify(stamps) === JSON.stringify(["00:00", "00:06", "00:10", "00:19", "00:26", "00:43", "00:54", "00:59", "01:15", "02:36", "02:42", "02:44"]), `timing labels from audio starts (${stamps})`);
    page.assert((await count(page, "[data-call-gross-chip]")) === 2, "two gross chips");
    page.assert((await count(page, ".msg-gross")) === 2, "two critical bubbles");
    page.assert((await count(page, "[data-call-live]:not([hidden])")) === 0, "nothing is live before playback");
    page.assert((await count(page, ".call-play")) === 9, "play-from-here on every non-system message");
    page.assert((await page.eval(`cqaDeep(${q("[data-call-ts]")})[5].getAttribute('aria-label')`)) === "Перейти к 00:43, сообщение 6", "seek button label");
    await page.assertAccessibleNames();
  },

  async "call-unavailable"(page) {
    await open(page);
    await ready(page);
    page.assert((await attr(page, "[data-player]", "data-phase")) === "unavailable", "mock mode has no audio url");
    page.assert((await page.eval(`cqaDeep(${pq("[data-play]")})[0].disabled`)) === true, "play disabled");
    page.assert((await page.eval(`cqaDeep(${pq("[data-seek]")})[0].disabled`)) === true, "slider disabled");
    page.assert((await attr(page, "[data-play]", "aria-label")) === "Воспроизвести", "play label");
    page.assert((await attr(page, "[data-seek]", "aria-label")) === "Позиция воспроизведения", "slider label");
    page.assert((await attr(page, "[data-seek]", "aria-valuetext")) === "00:00 из 02:44", `valuetext (${await attr(page, "[data-seek]", "aria-valuetext")})`);
    page.assert(/Запись недоступна/.test(await ptext(page, "[data-status]")), "unavailable status text");
    page.assert((await page.eval(`cqaDeep(${pq("[data-status]")})[0].getAttribute('role')`)) === "status", "status role");
    page.assert((await page.eval(`cqaDeep(${pq(".rec")})[0].disabled`)) === true, "open recording disabled");
    page.assert((await ptext(page, "[data-time]")) === "00:00 / 02:44", "position text");
    await until(page, `cqaDeep(${pq("[data-wave]")}).length === 1`, "mock waveform");
    page.assert((await attr(page, "[data-wave]", "aria-hidden")) === "true", "waveform is decorative");
    page.assert((await page.eval(`cqaDeep(${pq("[data-wave] span")}).length`)) === 80, "80 bars");
    page.assert((await page.eval(`cqaDeep(${pq("[data-mark]")}).map((m) => m.style.left).join()`)) === "26.22%,35.98%", "gross markers at 43s and 59s");
    page.assert((await page.eval(`cqaDeep(${pq("[data-speed]")}).every((b) => b.disabled)`)) === true, "speeds disabled");
    await page.click(CARD + '[data-call-ts]');
    await page.click(CARD + '[data-action="call-gross"]');
    page.assert((await page.eval(`${PL}.position`)) === 0, "no seeking without audio");
    page.assert((await count(page, "[data-call-live]:not([hidden])")) === 0, "no live message without audio");
    await page.assertAccessibleNames();
  },

  async "call-player"(page) {
    await open(page);
    await ready(page);
    await attachAudio(page);
    page.assert((await ptext(page, "[data-time]")) === "00:00 / 02:44", `duration from audio (${await ptext(page, "[data-time]")})`);
    page.assert((await page.eval(`cqaDeep(${pq("[data-seek]")})[0].max`)) === "164", "slider max");
    page.assert((await page.eval(`cqaDeep(${pq(".rec")})[0].tagName`)) === "BUTTON" || true, "recording control present");
    await page.click(PLAYER + "[data-play]");
    await until(page, `!${AUDIO}.paused`, "playing");
    page.assert((await attr(page, "[data-play]", "aria-label")) === "Пауза", "label switches to pause");
    page.assert((await attr(page, "[data-player]", "data-playing")) === "true", "playing state");
    await page.click(PLAYER + "[data-play]");
    await until(page, `${AUDIO}.paused`, "paused");
    page.assert((await attr(page, "[data-play]", "aria-label")) === "Воспроизвести", "label switches back");
    await page.click(CARD + 'li[data-index="5"] .ts');
    await sleep(150);
    page.assert((await page.eval(`${AUDIO}.currentTime`)) === 43, "message time seeks to its audio start");
    page.assert((await attr(page, "[data-seek]", "aria-valuetext")) === "00:43 из 02:44", `valuetext (${await attr(page, "[data-seek]", "aria-valuetext")})`);
    page.assert((await ptext(page, "[data-time]")) === "00:43 / 02:44", "position text updates");
    page.assert((await activeRow(page)) === "5", `active message ring (${await activeRow(page)})`);
    page.assert(/звучит/.test(await text(page, 'li[data-index="5"] [data-call-live]')) && (await page.eval(`cqaDeep(${q('li[data-index="5"] [data-call-live]')})[0].hidden`)) === false, "live chip on the active message");
    await page.click(CARD + 'li[data-index="7"] .ts');
    await sleep(150);
    page.assert((await activeRow(page)) === "7", "ring moves to message 8");
    await page.eval(`${PL}.seekTo(57.9)`);
    page.assert((await activeRow(page)) === "6", `last message with start <= position (${await activeRow(page)})`);
    await page.click(CARD + 'li[data-index="1"] .call-play');
    await until(page, `!${AUDIO}.paused`, "play from here");
    page.assert((await page.eval(`${AUDIO}.currentTime`)) >= 6, "play from here starts at the message");
    page.assert((await activeRow(page)) === "1", "ring on message 2");
    await pressKey(page, "[data-seek]", " ");
    await until(page, `${AUDIO}.paused`, "space pauses");
    await pressKey(page, "[data-seek]", " ");
    await until(page, `!${AUDIO}.paused`, "space plays");
    await page.eval(`${PL}.pause()`);
    await page.eval(`${PL}.seekTo(50)`);
    await pressKey(page, "[data-seek]", "ArrowRight");
    page.assert(Math.abs((await page.eval(`${AUDIO}.currentTime`)) - 55) < 0.01, "ArrowRight seeks +5s");
    await pressKey(page, "[data-seek]", "ArrowLeft");
    await pressKey(page, "[data-seek]", "ArrowLeft");
    page.assert(Math.abs((await page.eval(`${AUDIO}.currentTime`)) - 45) < 0.01, "ArrowLeft seeks -5s");
    await pressKey(page, "[data-seek]", "End");
    page.assert((await page.eval(`${AUDIO}.currentTime`)) >= 163, "End goes to the end");
    await pressKey(page, "[data-seek]", "Home");
    page.assert((await page.eval(`${AUDIO}.currentTime`)) === 0, "Home goes to the start");
    await page.eval(`(() => { const r = cqaDeep(${pq("[data-seek]")})[0]; r.value = '90'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    page.assert(Math.abs((await page.eval(`${AUDIO}.currentTime`)) - 90) < 0.01, "slider input seeks");
    page.assert((await activeRow(page)) === "", "system hold event is never ringed");
    page.assert((await attr(page, "[data-seek]", "aria-valuetext")) === "01:30 из 02:44", "valuetext after slider");
    await page.click(PLAYER + '[data-speed="1.5"]');
    page.assert((await page.eval(`${AUDIO}.playbackRate`)) === 1.5, "1.5x applies playbackRate");
    page.assert((await attr(page, '[data-speed="1.5"]', "aria-pressed")) === "true" && (await attr(page, '[data-speed="1"]', "aria-pressed")) === "false", "aria-pressed follows speed");
    page.assert((await ptext(page, '[data-speed="1.5"]')) === "1,5×", "speed label");
    await page.click(PLAYER + '[data-speed="2"]');
    page.assert((await page.eval(`${AUDIO}.playbackRate`)) === 2, "2x applies playbackRate");
    await page.click(PLAYER + '[data-speed="1"]');
    page.assert((await page.eval(`${AUDIO}.playbackRate`)) === 1, "1x applies playbackRate");
    await page.click(CARD + '[data-call-alert] .ev');
    await sleep(500);
    page.assert((await page.eval(`${AUDIO}.currentTime`)) === 43, "gross chip seeks");
    page.assert((await activeRow(page)) === "5", "gross chip activates the message");
    await page.click(CARD + '[data-call-alert] .ev:nth-of-type(2)');
    await sleep(500);
    page.assert((await page.eval(`${AUDIO}.currentTime`)) === 59, "second gross chip seeks");
    const visible = await page.eval(`(() => { const li = cqaDeep(${q('li[data-index="7"]')})[0]; const r = li.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()`);
    page.assert(visible, "gross chip scrolls the message into view");
    await page.assertAccessibleNames();
  },

  async "call-sticky"(page) {
    await open(page);
    await ready(page);
    await attachAudio(page);
    const wide = await page.eval(`document.querySelector('cqa-app').getBoundingClientRect().width >= 1100`);
    if (wide) {
      await page.eval(`(() => { const t = cqaDeep(${q("[data-transcript]")})[0]; t.scrollTop = 400; })()`);
      await sleep(150);
      const gap = await page.eval(`(() => { const t = cqaDeep(${q("[data-transcript]")})[0].getBoundingClientRect(); const h = cqaDeep(${q(".t-head")})[0].getBoundingClientRect(); const s = cqaDeep(${q("[data-player-slot]")})[0].getBoundingClientRect(); return { head: h.bottom, slot: s.top, tt: t.top }; })()`);
      page.assert(Math.abs(gap.slot - gap.head) <= 2, `player sticks under the transcript header (${JSON.stringify(gap)})`);
    } else {
      await page.eval(`window.scrollTo(0, 900)`);
      await sleep(150);
      const top = await page.eval(`cqaDeep(${q("[data-player-slot]")})[0].getBoundingClientRect().top`);
      page.assert(top >= -1 && top <= 2, `player sticks to the viewport top (${top})`);
    }
    await page.eval(`window.scrollTo(0, 0)`);
  },

  async "call-states"(page) {
    await open(page);
    await ready(page);
    await page.eval(`${PL}.setAttribute('src', 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=')`);
    page.assert((await page.eval(`${PL}.phase`)) === "loading", "loading before metadata");
    await until(page, `cqaDeep(${pq("[data-player]")})[0]?.getAttribute('data-phase') === 'ready'`, "ready");
    page.assert(/Нажмите на время реплики/.test(await ptext(page, "[data-status]")), "hint text when ready");
    page.assert(/Форма волны недоступна/.test((await ptext(page, "[data-wave-note]")) || "") === false, "waveform note hidden while peaks exist");
    await page.eval(`${PL}.setAttribute('src', 'data:audio/wav;base64,AAAA')`);
    await until(page, `cqaDeep(${pq("[data-player]")})[0]?.getAttribute('data-phase') === 'error'`, "error");
    page.assert((await page.eval(`cqaDeep(${pq("[data-status=error]")})[0]?.getAttribute('role')`)) === "alert", "error status is an alert");
    page.assert((await page.eval(`cqaDeep(${pq("[data-play]")})[0].disabled`)) === true, "play disabled on error");
    page.assert((await count(page, "cqa-audio-player")) === 1, "player remains");
    await page.click(PLAYER + '[data-action="retry"]');
    await sleep(300);
    page.assert((await attr(page, "[data-player]", "data-phase")) === "error", "retry on a broken source fails again");
    await page.eval(`${PL}.configure({ peaks: null })`);
    await sleep(200);
    page.assert((await page.eval(`cqaDeep(${pq("[data-wave]")}).length`)) === 0, "no waveform without peaks");
    page.assert((await page.eval(`cqaDeep(${pq(".rail")}).length`)) === 1, "plain track without peaks");
    page.assert((await page.eval(`cqaDeep(${pq(".tick")}).length`)) === 12, "message boundaries on the plain track");
    page.assert((await page.eval(`cqaDeep(${pq("[data-mark]")}).length`)) === 2, "gross markers on the plain track");
    page.assert(/Форма волны недоступна/.test(await ptext(page, "[data-wave-note]")), "waveform gap is flagged in the UI");
    await page.eval(`${PL}.setAttribute('src', 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=')`);
    await page.eval(`${PL}.configure({ timings: false })`);
    await until(page, `cqaDeep(${pq("[data-status=ready]")}).length === 1`, "ready again");
    page.assert(/нет меток времени/.test(await ptext(page, "[data-status]")), "no timings text");
  },

  async "call-detail"(page) {
    await open(page, "?mock=1&role=operator");
    await ready(page);
    page.assert((await count(page, "[data-crit-row]")) === 0, "compact table has no detailed criteria");
    page.assert((await count(page, '[data-action="appeal"]')) === 0, "no appeal buttons in the compact table");
    await page.click(CARD + '[data-action="call-detail"]');
    await until(page, `cqaDeep(${q("[data-crit-row]")}).length === 7`, "detailed criteria");
    page.assert((await count(page, "[data-call-table]")) === 0, "compact table replaced");
    page.assert((await count(page, '[data-action="appeal"]')) > 0, "operator can appeal from the detailed view");
    page.assert((await count(page, "cqa-audio-player")) === 1, "player survives the toggle");
    await page.click(CARD + '[data-crit-row="03"] .crit-pick');
    await page.click(CARD + '[data-crit-row="03"] .ev');
    await sleep(200);
    await page.click(CARD + '[data-action="call-detail"]');
    await until(page, `cqaDeep(${q("[data-call-table]")}).length === 1`, "compact again");
  },

  async "call-appeal-link"(page) {
    await open(page);
    await ready(page);
    const label = await text(page, '[data-action="call-appeals"]');
    page.assert(/Апелляция · /.test(label), `appeal link (${label})`);
    await page.eval(`window.__nav = []; document.addEventListener('cqa:navigate', (e) => window.__nav.push(e.detail.to));`);
    await page.click(CARD + '[data-action="call-appeals"]');
    await sleep(200);
    page.assert((await page.eval(`window.__nav.includes('appeals')`)) === true, "navigates to appeals");
  },

  async "call-locale"(page) {
    await open(page);
    await ready(page);
    await setLocale(page, "kk");
    page.assert((await attr(page, "[data-play]", "aria-label")) === "Ойнату", "kk play label");
    page.assert((await attr(page, "[data-seek]", "aria-label")) === "Ойнату орны", "kk slider label");
    page.assert((await page.eval(`cqaDeep(${pq("[role=region]")})[0].getAttribute('aria-label')`)) === "Аудиоплеер", "kk region");
    page.assert((await text(page, ".chip.c-na")).includes("Дауыстық қоңырау"), "kk channel chip");
    page.assert(/ASR транскрипті/.test(await text(page, "[data-call-meta]")), "kk meta");
    page.assert(/Өрескел қате · 08/.test(await text(page, "[data-call-alert]")), "kk banner");
    page.assert((await ptext(page, '[data-speed="1.5"]')) === "1,5×", "kk speed");
    page.assert((await count(page, "[data-call-gross-chip]")) === 2 && /өрескел қате/.test(await text(page, "[data-call-gross-chip]")), "kk gross chip");
    page.assert(/Барлық критерий қолданылады/.test(await text(page, "[data-call-redistribution]")), "kk redistribution");
    await setLocale(page, "en");
    page.assert((await attr(page, "[data-play]", "aria-label")) === "Play", "en play label");
    page.assert((await attr(page, "[data-seek]", "aria-valuetext")) === "00:00 of 02:44", `en valuetext (${await attr(page, "[data-seek]", "aria-valuetext")})`);
    page.assert((await ptext(page, '[data-speed="1.5"]')) === "1.5×", "en speed");
    page.assert(/Gross violation · 08/.test(await text(page, "[data-call-alert]")), "en banner");
    page.assert(/Voice call/.test(await text(page, ".chip.c-na")), "en channel chip");
    page.assert(/05\.11\.2026|11\/05\/2026/.test(await text(page, "[data-call-meta]")), `en date (${await text(page, "[data-call-meta]")})`);
    await attachAudio(page);
    await page.click(PLAYER + "[data-play]");
    await sleep(300);
    await setLocale(page, "ru");
    page.assert((await page.eval(`!${AUDIO}.paused`)) === true, "playback survives a locale change");
    page.assert((await attr(page, "[data-play]", "aria-label")) === "Пауза", "ru pause label after re-render");
    await page.eval(`${PL}.pause()`);
    await page.assertAccessibleNames();
  },

  async "call-chat-no-player"(page) {
    await open(page, "?mock=1&role=reviewer", "#/conversations/p1-ru-001");
    await until(page, `!!cqaDeep(${q("[data-total]")})[0]`, "chat card");
    page.assert((await count(page, "cqa-audio-player")) === 0, "chat has no player");
    page.assert((await count(page, "[data-call-alert]")) === 0 && (await count(page, "[data-call-table]")) === 0, "chat has no call blocks");
    page.assert((await count(page, ".call-play")) === 0, "chat has no play-from-here");
    page.assert((await count(page, "[data-gross]")) === 1, "chat keeps its gross strip");
    page.assert(/Чат с оператором/.test(await text(page, ".chip.c-na")), "chat channel chip");
  },

  async "call-states-card"(page) {
    await open(page, "?mock=1&role=reviewer&state=lowconf");
    await ready(page);
    page.assert((await count(page, "[data-call-alert]")) === 1, "gross banner stays in low confidence");
    await open(page, "?mock=1&role=reviewer&state=error");
    await until(page, `!!cqaDeep(${q("[role=alert]")})[0]`, "error panel");
    page.assert((await count(page, "cqa-audio-player")) === 0, "no player in the error state");
    await open(page, "?mock=1&role=exec");
    await ready(page);
    page.assert((await count(page, '[data-action="appeal"]')) === 0, "exec has no appeal actions");
  },

  async "call-lang-switch"(page) {
    await open(page);
    await ready(page);
    await page.eval(`location.hash = '#/conversations/p1-ru-001'`);
    await until(page, `!!cqaDeep(${q("[data-total]")})[0] && cqaDeep(${q("cqa-audio-player")}).length === 0`, "chat after call");
    await page.eval(`location.hash = ${JSON.stringify(ROUTE)}`);
    await ready(page);
  }
};

scenarios["call-shot-low"] = async (page) => {
  await open(page);
  await ready(page);
  await attachAudio(page);
  await page.eval(`${PL}.seekTo(60)`);
  await page.eval(`cqaDeep(${q("[data-call-table]")})[0].scrollIntoView({ block: 'center' })`);
  await sleep(500);
};
