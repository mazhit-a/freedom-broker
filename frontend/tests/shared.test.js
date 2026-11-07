import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chip, answerChip, pointsChip, grossChip, statusChip, langChip, versionChip, provisionalChip } from "../src/shared/chip.js";
import { scoreBadge, scoreBand } from "../src/shared/score-badge.js";
import { keyFigure } from "../src/shared/key-figure.js";
import { loadingPanel, emptyPanel, errorPanel, lowConfidencePanel, notCalculatedPanel } from "../src/shared/state-panel.js";
import { evidenceChip } from "../src/shared/evidence-chip.js";
import { transcriptMessage } from "../src/shared/transcript-message.js";
import { criterionRow, scaleStepList } from "../src/shared/criterion-row.js";
import { dataTable } from "../src/shared/data-table.js";
import { barChart } from "../src/shared/bar-chart.js";
import { icon } from "../src/shared/icons.js";
import { SHARED_CSS } from "../src/shared/styles.js";

const XSS = '<img src=x onerror="alert(1)">';
const s = (x) => String(x);

function assertInert(out) {
  assert.ok(!/<img/i.test(out), out);
  assert.ok(!/onerror="/i.test(out), out);
  assert.ok(out.includes("&lt;img"), out);
}

test("score bands: <50 bad, 50-70 warn, >=70 ok", () => {
  assert.equal(scoreBand(49.99), "bad");
  assert.equal(scoreBand(50), "warn");
  assert.equal(scoreBand(69.99), "warn");
  assert.equal(scoreBand(70), "ok");
  assert.equal(scoreBand(100), "ok");
  assert.match(s(scoreBadge(31, "ru")), /band-bad/);
  assert.match(s(scoreBadge(66.25, "ru")), /band-warn/);
  assert.match(s(scoreBadge(81.88, "ru")), /band-ok/);
});

test("score badge formats per locale and shows provisional chip next to the number", () => {
  assert.match(s(scoreBadge(81.88, "ru")), />81,88</);
  assert.match(s(scoreBadge(81.88, "kk")), />81,88</);
  assert.match(s(scoreBadge(81.88, "en")), />81\.88</);
  const prov = s(scoreBadge(74.5, "ru", { provisional: true }));
  assert.match(prov, />74,50</);
  assert.match(prov, /Предварительно - низкая уверенность/);
  assert.match(s(scoreBadge(null, "ru")), /—/);
});

test("answer, points, status, language and version chips", () => {
  assert.match(s(answerChip("yes", "ru")), /c-ok[^>]*>Да</);
  assert.match(s(answerChip("no", "ru")), /c-bad[^>]*>Нет</);
  assert.match(s(answerChip("na", "ru")), /c-na[^>]*>N\/A</);
  assert.match(s(pointsChip(15, 20, "ru")), /c-warn[^>]*>15 из 20</);
  assert.match(s(pointsChip(10, 10, "ru")), /c-ok[^>]*>10 из 10</);
  assert.match(s(pointsChip(0, 10, "ru")), /c-bad/);
  assert.match(s(pointsChip(15, 20, "en")), />15 of 20</);
  assert.match(s(grossChip("ru")), /c-crit[^>]*>Грубая ошибка</);
  const names = { new: "Новая", under_review: "На рассмотрении", confirmed: "Подтверждено", changed: "Изменено", low_confidence: "Низкая уверенность", failed: "Ошибка оценки" };
  for (const [key, name] of Object.entries(names)) assert.match(s(statusChip(key, "ru")), new RegExp(`>${name}<`));
  assert.equal(s(statusChip("bogus", "ru")), "");
  assert.match(s(langChip("kk")), />KZ</);
  assert.match(s(langChip("en")), />EN</);
  assert.match(s(versionChip("Чек-лист", 2)), /Чек-лист · v2/);
  assert.match(s(provisionalChip("en")), /Provisional - low confidence/);
});

test("key figure shows a formatted value and a delta", () => {
  const ru = s(keyFigure({ label: "L", value: 78.42, delta: 1.84 }, "ru"));
  assert.match(ru, />78,42</);
  assert.match(ru, /kf-delta up/);
  assert.match(ru, /1,84 к прошлому периоду/);
  assert.match(s(keyFigure({ label: "L", value: 78.42, delta: -1.5 }, "en")), /kf-delta down/);
  assert.match(s(keyFigure({ label: "L", value: 78.42, delta: -1.5 }, "en")), /1\.50 vs previous period/);
});

test("state panels", () => {
  const loading = s(loadingPanel("ru"));
  assert.match(loading, /aria-busy="true"/);
  assert.match(s(emptyPanel("ru", { actionLabel: "Go" })), /data-action="empty-action"/);
  const err = s(errorPanel("ru"));
  assert.match(err, /role="alert"/);
  assert.match(err, /data-action="retry"/);
  assert.ok(!/data-action="retry"/.test(s(errorPanel("ru", { retry: false }))));
  const low = s(lowConfidencePanel("ru", { value: 74.5, unanswered: 2, total: 8 }));
  assert.match(low, /74,50/);
  assert.match(low, /Предварительно - низкая уверенность/);
  assert.match(low, /Итог предварительный - требуется проверка ОКК/);
  assert.match(low, /2 из 8 критериев/);
  assert.match(s(notCalculatedPanel("ru")), /Итог не рассчитан/);
  assert.match(s(notCalculatedPanel("kk")), /Қорытынды есептелмеді/);
});

test("transcript messages: kinds, one-based numbers, markers", () => {
  const sys = s(transcriptMessage({ index: 0, kind: "system", text: "joined", time: 40 }, "ru"));
  assert.match(sys, /msg-system/);
  assert.match(sys, /00:40/);
  const bot = s(transcriptMessage({ index: 1, kind: "bot", text: "x" }, "ru"));
  assert.match(bot, /msg-bot/);
  assert.match(bot, /не оценивается/);
  assert.match(bot, /#2/);
  assert.match(s(transcriptMessage({ index: 2, kind: "client", text: "x" }, "ru")), /msg-client/);
  const ev = s(transcriptMessage({ index: 3, kind: "operator", text: "x", evidence: true }, "ru"));
  assert.match(ev, /msg-evidence/);
  assert.match(ev, /id="msg-3"/);
  const exp = s(transcriptMessage({ index: 4, kind: "operator", text: "x", expected: true }, "ru"));
  assert.match(exp, /msg-expected/);
  assert.match(exp, /Ожидалось здесь/);
});

test("evidence chip is a labelled button with a jump target", () => {
  const out = s(evidenceChip({ index: 3, role: "operator", time: 242 }, "ru"));
  assert.match(out, /<button type="button" class="ev"/);
  assert.match(out, /data-msg="3"/);
  assert.match(out, />Оператор · 04:02</);
  const exp = s(evidenceChip({ index: 9, expected: true, time: 291, endTime: 298 }, "ru"));
  assert.match(exp, /ev-expected/);
  assert.match(exp, /Ожидалось здесь · 04:51–04:58/);
});

test("criterion row shows chip, effective points, weight line and evidence", () => {
  const out = s(
    criterionRow(
      {
        id: "04",
        number: "04",
        title: "T",
        scale: true,
        earned: 15,
        max: 20,
        points: 18.75,
        maxPoints: 25,
        weight: 20,
        effectiveWeight: 25,
        selected: true,
        appealable: true,
        explanation: "E",
        evidence: [{ index: 3, role: "operator", time: 242 }]
      },
      "ru"
    )
  );
  assert.match(out, /15 из 20/);
  assert.match(out, /<b>18,75<\/b>/);
  assert.match(out, /\/ 25,00/);
  assert.match(out, /Вес 20 → 25,00/);
  assert.match(out, /crit selected/);
  assert.match(out, /data-action="appeal" data-criterion="04"/);
  assert.match(out, /aria-labelledby="crit-04-t"/);
  const gross = s(criterionRow({ id: "g1", number: "G1", title: "T", gross: true, evidence: [] }, "ru"));
  assert.match(gross, /Грубая ошибка/);
  assert.match(gross, /Флаг без баллов/);
  assert.ok(!/Вес/.test(gross));
  const yes = s(criterionRow({ id: "01", number: "01", title: "T", answer: "yes", points: 12.5, maxPoints: 12.5, weight: 10, effectiveWeight: 12.5, evidence: [] }, "en"));
  assert.match(yes, /Yes/);
  assert.match(yes, /12\.50/);
  assert.match(yes, /Weight 10 → 12\.50/);
});

test("scale step list", () => {
  const out = s(scaleStepList([{ step: 0, description: "a", points: 0 }, { step: 10, description: "b", points: 15 }], "ru"));
  assert.match(out, /<ol class="steps"/);
  assert.match(out, /15,00/);
  assert.equal((out.match(/<li>/g) || []).length, 2);
});

test("escaping: injected markup is inert everywhere", () => {
  assertInert(s(transcriptMessage({ index: 0, kind: "client", text: XSS }, "ru")));
  assertInert(s(transcriptMessage({ index: 0, kind: "system", text: XSS }, "ru")));
  assertInert(s(criterionRow({ id: "1", number: "1", title: XSS, answer: "yes", explanation: XSS, evidence: [] }, "ru")));
  assertInert(s(chip({ tone: "ok", text: XSS })));
  assertInert(s(keyFigure({ label: XSS, value: 1 }, "ru")));
  assertInert(s(emptyPanel("ru", { title: XSS, hint: XSS, actionLabel: XSS })));
  assertInert(s(errorPanel("ru", { title: XSS, message: XSS })));
  assertInert(s(scaleStepList([{ step: 1, description: XSS, points: 1 }], "ru")));
  assertInert(s(barChart({ buckets: [{ value: 1, from: 0, label: XSS }] }, "ru")));
  const table = s(
    dataTable(
      { label: XSS, columns: [{ key: "a", label: XSS, sortable: true, cell: (r) => r.a }], rows: [{ id: XSS, a: XSS }], rowId: (r) => r.id, rowLabel: (r) => r.a, selectable: true },
      "ru"
    )
  );
  assertInert(table);
  const attr = s(evidenceChip({ index: '"><script>x</script>', role: "operator" }, "ru"));
  assert.ok(!/<script/.test(attr), attr);
  const quote = s(chip({ text: "x", title: '" onmouseover="x' }));
  assert.ok(!/onmouseover="x"/.test(quote), quote);
});

test("data table: ARIA roles, aria-sort, labelled checkboxes, secondary columns", () => {
  const columns = [
    { key: "id", label: "ID", cell: (r) => r.id },
    { key: "total", label: "Итог", sortable: true, align: "num", cell: (r) => r.total },
    { key: "s1", label: "S1", secondary: true, cell: (r) => r.s1 }
  ];
  const rows = [{ id: "a", total: 1, s1: 2 }, { id: "b", total: 3, s1: 4 }];
  const out = s(dataTable({ label: "Tbl", columns, rows, rowId: (r) => r.id, rowLabel: (r) => r.id, selectable: true, selected: new Set(["a"]), sort: { key: "total", dir: "asc" } }, "ru"));
  assert.match(out, /role="table"[^>]*aria-label="Tbl"/);
  assert.equal((out.match(/role="row"/g) || []).length, 3);
  assert.equal((out.match(/role="columnheader"/g) || []).length, 4);
  assert.equal((out.match(/role="cell"/g) || []).length, 8);
  assert.match(out, /aria-sort="ascending"/);
  assert.match(out, /aria-label="Выбрать все"/);
  assert.match(out, /aria-label="Выбрать a"/);
  assert.match(out, /aria-label="Выбрать b"/);
  assert.match(out, /aria-selected="true"/);
  assert.match(out, /aria-selected="false"/);
  assert.match(out, /class="secondary"/);
  const desc = s(dataTable({ label: "T", columns, rows, rowId: (r) => r.id, sort: { key: "total", dir: "desc" } }, "ru"));
  assert.match(desc, /aria-sort="descending"/);
  assert.ok(!/aria-selected/.test(desc));
  const none = s(dataTable({ label: "T", columns, rows, rowId: (r) => r.id }, "ru"));
  assert.match(none, /aria-sort="none"/);
});

test("bar chart: bands by range, localized counts and legend", () => {
  const buckets = [{ value: 4, from: 0, label: "0–10" }, { value: 74, from: 50, label: "50–60" }, { value: 392, from: 80, label: "80–90" }];
  const out = s(barChart({ buckets }, "ru"));
  assert.match(out, /role="img"/);
  assert.match(out, /band-bad/);
  assert.match(out, /band-warn/);
  assert.match(out, /band-ok/);
  assert.match(out, /70 и выше - норма/);
  assert.match(out, /80–90 - 392/);
  assert.match(out, /--n:3/);
});

test("icons are decorative", () => {
  assert.match(s(icon("flag")), /aria-hidden="true"/);
  assert.equal(s(icon("nope")), "");
});

test("no hard-coded colours outside icons; every colour is a token", () => {
  const dir = fileURLToPath(new URL("../src/shared/", import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "icons.js")) {
    const text = readFileSync(join(dir, file), "utf8");
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(text), `${file} has a hex colour`);
    assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/.test(text), `${file} has a functional colour`);
  }
  const colourProps = SHARED_CSS.match(/(?:^|[;\s{])(?:color|background|border(?:-color)?|box-shadow|outline|accent-color)\s*:[^;}]*/g) || [];
  for (const decl of colourProps) {
    const value = decl.split(":").slice(1).join(":");
    const words = value.replace(/var\([^)]*\)/g, "").split(/\s+/).filter(Boolean);
    for (const w of words) assert.ok(!/^(red|green|blue|black|white|gray|grey|yellow|orange)$/i.test(w), decl);
  }
});

test("shared markup never reads a theme attribute", () => {
  assert.ok(!/data-theme|\[theme/.test(SHARED_CSS));
});
