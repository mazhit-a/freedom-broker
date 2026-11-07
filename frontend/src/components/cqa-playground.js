import { CqaElement, html, raw } from "../base-element.js";
import { LOCALES, setLocale } from "../i18n/index.js";
import { SHARED_CSS } from "../shared/styles.js";
import { icon } from "../shared/icons.js";
import { answerChip, chip, grossChip, langChip, pointsChip, statusChip, versionChip } from "../shared/chip.js";
import { scoreBadge } from "../shared/score-badge.js";
import { keyFigure } from "../shared/key-figure.js";
import { emptyPanel, errorPanel, loadingPanel, lowConfidencePanel, notCalculatedPanel } from "../shared/state-panel.js";
import { transcriptMessage } from "../shared/transcript-message.js";
import { criterionRow, scaleStepList } from "../shared/criterion-row.js";
import { dataTable } from "../shared/data-table.js";
import { barChart } from "../shared/bar-chart.js";
import { registerAll } from "../register.js";

const BRAND = [
  ["brand", "#51AF3D"],
  ["brand-strong", "#2F7D22"],
  ["brand-deep", "#0F5431"],
  ["brand-tint", "#EAF5E6"],
  ["ink", "#111418"],
  ["ink-2", "#4A5260"],
  ["ink-3", "#6B7480"],
  ["surface", "#FFFFFF"],
  ["surface-2", "#F4F6F8"],
  ["line", "#E3E7EC"]
];
const SEMANTIC = ["ok", "warn", "bad", "na", "critical", "hl"];

const ROWS = [
  { id: "p1-ru-001", lang: "ru", total: 81.88, status: "changed", s1: 31.25 },
  { id: "p1-kk-004", lang: "kk", total: 66.25, status: "under_review", s1: 28.5 },
  { id: "call-014", lang: "ru", total: 31, status: "new", s1: 12.5 },
  { id: "p1-en-009", lang: "en", total: 92.31, status: "confirmed", s1: 33.75 }
];

const BUCKETS = [4, 6, 11, 19, 38, 74, 162, 301, 392, 241].map((value, i) => ({
  value,
  from: i * 10,
  label: `${i * 10}–${i * 10 + 10}`
}));

const STEPS = [
  { step: 0, description: "Хаотично, много ошибок", points: 0 },
  { step: 4, description: "Несколько нарушений", points: 6 },
  { step: 7, description: "Одно заметное нарушение", points: 10.5 },
  { step: 10, description: "Без замечаний", points: 15 }
];

const CRITERION = {
  id: "04",
  number: "04",
  title: "Корректная и полная консультация",
  scale: true,
  earned: 15,
  max: 20,
  points: 18.75,
  maxPoints: 25,
  weight: 20,
  effectiveWeight: 25,
  selected: true,
  appealable: true,
  explanation: "Не упомянута комиссия за конвертацию валюты.",
  evidence: [
    { index: 3, role: "operator", time: 242 },
    { index: 9, expected: true, time: 291, endTime: 298 }
  ]
};

export class CqaPlayground extends CqaElement {
  constructor() {
    super();
    this.sort = { key: "total", dir: "desc" };
    this.selected = new Set(["p1-ru-001"]);
  }

  styles() {
    return `${SHARED_CSS}
      :host { display: block; container-type: normal !important; background: var(--cqa-surface-2); font-size: var(--cqa-fs-14); }
      .wrap { container-type: inline-size; }
      main { max-width: 1360px; margin: 0 auto; padding: 32px 24px 64px; display: flex; flex-direction: column; gap: 32px; }
      h1 { margin: 0; font-size: var(--cqa-fs-32); font-weight: 600; letter-spacing: -0.02em; }
      p { margin: 0; }
      section { display: flex; flex-direction: column; gap: 16px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(400px, 100%), 1fr)); gap: 16px; }
      .grid-sm { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 16px; }
      .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
      .sw { display: flex; flex-direction: column; gap: 6px; font-size: var(--cqa-fs-12); }
      .sw > i { height: 56px; border-radius: 10px; border: 1px solid var(--cqa-line); display: block; }
      .block { padding: 20px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .type-row { display: grid; grid-template-columns: 90px 1fr; gap: 16px; align-items: baseline; }
      .field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      label.lbl { display: flex; flex-direction: column; gap: 6px; font-size: var(--cqa-fs-12); font-weight: 500; color: var(--cqa-ink-2); }
      label.inline { display: flex; gap: 8px; align-items: center; font-size: var(--cqa-fs-13); }
      .toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      @container (max-width: 800px) { main { padding: 24px 16px 48px; } .field-grid { grid-template-columns: 1fr; } }
    `;
  }

  swatch(name, note) {
    return html`<div class="sw"><i style="background:var(--cqa-${raw(name)})"></i><b>--cqa-${name}</b><span class="muted tnum">${note}</span></div>`;
  }

  template() {
    const l = this.locale;
    const t = (key) => this.t(key);
    const sorted = [...ROWS].sort((a, b) => (this.sort.dir === "asc" ? 1 : -1) * (a[this.sort.key] > b[this.sort.key] ? 1 : -1));
    const columns = [
      { key: "id", label: t("gallery.colId"), width: "130px", minPx: 130, cell: (r) => r.id },
      { key: "lang", label: t("gallery.colLang"), width: "60px", minPx: 60, cell: (r) => langChip(r.lang) },
      { key: "total", label: t("gallery.colTotal"), width: "340px", minPx: 340, sortable: true, cell: (r) => scoreBadge(r.total, l, { provisional: r.id === "call-014" }) },
      { key: "s1", label: t("gallery.colSection"), width: "100px", minPx: 100, align: "num", secondary: true, cell: (r) => scoreBadge(r.s1, l, { bar: false }) },
      { key: "status", label: t("gallery.colStatus"), width: "minmax(140px, 1fr)", minPx: 140, cell: (r) => statusChip(r.status, l) }
    ];
    const table = dataTable(
      { label: t("gallery.tableLabel"), columns, rows: sorted, rowId: (r) => r.id, rowLabel: (r) => r.id, selectable: true, selected: this.selected, sort: this.sort },
      l
    );

    const localeSwitch = LOCALES.map(
      (code) => html`<button type="button" data-locale="${code}" aria-pressed="${String(code === l)}">${code === "kk" ? "KZ" : code.toUpperCase()}</button>`
    );

    return html`
      <div class="wrap"><main>
        <div class="col gap-2">
          <span class="sub-h">${t("gallery.kicker")}</span>
          <h1>${t("gallery.title")}</h1>
          <p class="muted">${t("gallery.lead")}</p>
          <div class="toolbar"><span class="sub-h" id="loc-l">${t("gallery.locale")}</span><div class="seg" role="group" aria-labelledby="loc-l">${localeSwitch}</div></div>
        </div>

        <section aria-labelledby="col-h">
          <h2 id="col-h" class="sec-h">${t("gallery.colors")}</h2>
          <h3 class="sub-h">${t("gallery.brand")}</h3>
          <div class="swatches">${BRAND.map(([n, hex]) => this.swatch(n, hex))}</div>
          <h3 class="sub-h">${t("gallery.semantic")}</h3>
          <div class="swatches">${SEMANTIC.map((n) => this.swatch(n, n))}</div>
        </section>

        <section aria-labelledby="ty-h">
          <h2 id="ty-h" class="sec-h">${t("gallery.typography")}</h2>
          <div class="card block">
            <div class="type-row"><span class="tnum muted">32 · 600</span><span class="tnum" style="font-size:var(--cqa-fs-32);font-weight:600;letter-spacing:-0.02em">81,88</span></div>
            <div class="type-row"><span class="tnum muted">24 · 600</span><span style="font-size:var(--cqa-fs-24);font-weight:600">Обзор качества обслуживания</span></div>
            <div class="type-row"><span class="tnum muted">20 · 600</span><span style="font-size:var(--cqa-fs-20);font-weight:600">Қызмет көрсету сапасына шолу</span></div>
            <div class="type-row"><span class="tnum muted">14 · 400</span><span>Сәлеметсіз бе! ә ғ қ ң ө ұ ү һ і Ә Ғ Қ Ң Ө Ұ Ү Һ І</span></div>
            <div class="type-row"><span class="tnum muted">12 · 500</span><span class="tnum muted" style="font-size:var(--cqa-fs-12)">LLM v3 · 07.11.2026 09:42</span></div>
          </div>
        </section>

        <section aria-labelledby="cp-h">
          <h2 id="cp-h" class="sec-h">${t("gallery.components")}</h2>
          <div class="grid">
            <div class="card block" id="g-buttons">
              <h3 class="sub-h">${t("gallery.buttons")}</h3>
              <div class="row gap-2">
                <button type="button" class="btn btn-primary">${t("gallery.saveDecision")}</button>
                <button type="button" class="btn">${t("gallery.reevaluate")}</button>
                <button type="button" class="btn btn-sm">${icon("flag")}${t("criterion.appeal")}</button>
                <button type="button" class="btn btn-ghost">${t("action.cancel")}</button>
                <button type="button" class="btn" disabled>${t("gallery.unavailable")}</button>
              </div>
            </div>

            <div class="card block" id="g-chips">
              <h3 class="sub-h">${t("gallery.chips")}</h3>
              <div class="row gap-1">${answerChip("yes", l)}${answerChip("no", l)}${answerChip("na", l)}${pointsChip(15, 20, l)}${pointsChip(10, 10, l)}${grossChip(l)}</div>
              <div class="row gap-1">${statusChip("new", l)}${statusChip("under_review", l)}${statusChip("confirmed", l)}${statusChip("changed", l)}${statusChip("low_confidence", l)}${statusChip("failed", l)}</div>
              <div class="row gap-1">${langChip("ru")}${langChip("kk")}${langChip("en")}${versionChip("Чек-лист качества чатов", 2)}</div>
            </div>

            <div class="card block" id="g-kf">
              <h3 class="sub-h">${t("gallery.keyFigure")}</h3>
              <div class="row gap-4">
                ${keyFigure({ label: t("gallery.avgScore"), value: 78.42, delta: 1.84 }, l)}
                <div class="col gap-3" style="justify-content:center">${scoreBadge(81.88, l)}${scoreBadge(66.25, l)}${scoreBadge(31, l)}${scoreBadge(49.99, l)}${scoreBadge(70, l)}</div>
              </div>
            </div>

            <div class="card block" id="g-fields">
              <h3 class="sub-h">${t("gallery.fields")}</h3>
              <div class="field-grid">
                <label class="lbl">${t("gallery.name")}<input class="field" value="Установление контакта"></label>
                <label class="lbl">${t("gallery.colStatus")}<select class="field"><option>${t("answer.yes")} / ${t("answer.no")} / ${t("answer.na")}</option></select></label>
              </div>
              <div class="row gap-4">
                <label class="inline"><input type="checkbox">${t("gallery.naAllowed")}</label>
                <label class="inline"><input type="radio" name="gx">${t("gallery.confirm")}</label>
                <div class="seg" role="group" aria-label="${t("gallery.segLabel")}"><button type="button" aria-pressed="true">DEV</button><button type="button" aria-pressed="false">${t("gallery.dataset")}</button></div>
              </div>
            </div>

            <div class="card block col gap-3" id="g-messages" style="gap:10px">
              <h3 class="sub-h">${t("gallery.messages")}</h3>
              ${transcriptMessage({ index: 0, kind: "system", text: "Оператор подключился", time: 40 }, l)}
              ${transcriptMessage({ index: 1, kind: "bot", text: "Перевожу на специалиста.", time: 11 }, l)}
              ${transcriptMessage({ index: 2, kind: "client", text: "Какая комиссия на тарифе «Стандарт»?", time: 9 }, l)}
              ${transcriptMessage({ index: 3, kind: "operator", text: "Здравствуйте! Меня зовут Айгерим.", time: 44, evidence: true }, l)}
              ${transcriptMessage({ index: 4, kind: "operator", text: "Хорошего дня!", time: 298, expected: true }, l)}
            </div>

            <div class="card block" id="g-criterion">
              <h3 class="sub-h">${t("gallery.criterion")}</h3>
              ${criterionRow(CRITERION, l)}
              <h3 class="sub-h">${t("gallery.scale")}</h3>
              ${scaleStepList(STEPS, l)}
            </div>
          </div>
        </section>

        <section aria-labelledby="ov-h">
          <h2 id="ov-h" class="sec-h">${t("gallery.overlays")}</h2>
          <div class="grid">
            <div class="card block" id="g-overlays">
              <h3 class="sub-h">${t("gallery.overlays")}</h3>
              <div class="row gap-2">
                <button type="button" class="btn" data-action="open-drawer" data-focus-id="open-drawer">${t("gallery.openDrawer")}</button>
                <button type="button" class="btn" data-action="open-modal" data-focus-id="open-modal">${t("gallery.openModal")}</button>
                <button type="button" class="btn" data-action="show-toast" data-focus-id="show-toast">${t("gallery.showToast")}</button>
              </div>
            </div>
            <div class="card block" id="g-scale">
              <h3 class="sub-h">${t("gallery.scaleEditor")} · ${t("gallery.stepsHint")} 15</h3>
              <div data-editor-slot></div>
            </div>
          </div>
        </section>

        <section aria-labelledby="tb-h">
          <h2 id="tb-h" class="sec-h">${t("gallery.table")}</h2>
          <div class="card block" id="g-table">${table}</div>
          <div class="card block" id="g-chart"><h3 class="sub-h">${t("gallery.chartTitle")}</h3>${barChart({ buckets: BUCKETS }, l)}</div>
        </section>

        <section aria-labelledby="st-h">
          <h2 id="st-h" class="sec-h">${t("gallery.states")}</h2>
          <div class="grid-sm" id="g-states">
            <div class="col gap-2"><h3 class="sub-h">${t("gallery.loading")}</h3>${loadingPanel(l)}</div>
            <div class="col gap-2"><h3 class="sub-h">${t("gallery.empty")}</h3>${emptyPanel(l, { title: t("gallery.emptyTitle"), actionLabel: t("action.open") })}</div>
            <div class="col gap-2"><h3 class="sub-h">${t("gallery.error")}</h3>${errorPanel(l, { message: t("gallery.errorText") })}</div>
            <div class="col gap-2"><h3 class="sub-h">${t("gallery.partial")}</h3>${lowConfidencePanel(l, { value: 74.5, unanswered: 2, total: 8 })}</div>
            <div class="col gap-2"><h3 class="sub-h">${t("gallery.notCalculated")}</h3>${notCalculatedPanel(l)}</div>
          </div>
        </section>
      </main></div>
    `;
  }

  mountOverlays(region) {
    const t = (key) => this.t(key);
    if (!this._editor) {
      this._editor = document.createElement("cqa-scale-step-editor");
      this._editor.setAttribute("weight", "15");
      this._editor.steps = STEPS.map((s) => ({ value: s.step, description: s.description }));
    }
    this._editor.setAttribute("locale", this.locale);
    region.querySelector("[data-editor-slot]").append(this._editor);
    if (!this._drawer) {
      this._drawer = document.createElement("cqa-drawer");
      this._drawer.id = "g-drawer";
      this._drawer.innerHTML = '<p data-drawer-text></p><label class="lbl"><span data-drawer-field></span><input class="field" data-autofocus></label><button slot="footer" type="button" class="btn" data-drawer-close></button>';
      this._drawer.querySelector("[data-drawer-close]").addEventListener("click", () => this._drawer.close("button"));
      this._modal = document.createElement("cqa-modal");
      this._modal.id = "g-modal";
      this._modal.innerHTML = '<button slot="footer" type="button" class="btn" data-modal-cancel></button><button slot="footer" type="button" class="btn btn-primary" data-modal-ok></button>';
      this._modal.querySelector("[data-modal-cancel]").addEventListener("click", () => this._modal.close("cancel"));
      this._modal.querySelector("[data-modal-ok]").addEventListener("click", () => {
        this._modal.close("confirm");
        this._toast.show(this.t("gallery.toastText"));
      });
      this._toast = document.createElement("cqa-toast");
      this._toast.id = "g-toast";
      this.shadowRoot.append(this._drawer, this._modal, this._toast);
    }
    for (const el of [this._drawer, this._modal, this._toast]) el.setAttribute("locale", this.locale);
    this._drawer.setAttribute("heading", t("gallery.drawerTitle"));
    this._drawer.querySelector("[data-drawer-text]").textContent = t("gallery.drawerBody");
    this._drawer.querySelector("[data-drawer-field]").textContent = t("gallery.name");
    this._drawer.querySelector("[data-drawer-close]").textContent = t("action.close");
    this._modal.setAttribute("heading", t("gallery.modalTitle"));
    this._modal.setAttribute("description", t("gallery.modalBody"));
    this._modal.querySelector("[data-modal-cancel]").textContent = t("action.cancel");
    this._modal.querySelector("[data-modal-ok]").textContent = t("action.apply");
  }

  afterRender(region) {
    registerAll();
    this.mountOverlays(region);
    if (this._bound === region) {
      this.restoreFocus(region);
      return;
    }
    this._bound = region;
    region.addEventListener("click", (event) => {
      const target = event.target.closest("[data-locale], [data-action]");
      if (!target) return;
      if (target.dataset.locale) {
        setLocale(target.dataset.locale);
        this.locale = target.dataset.locale;
        return;
      }
      if (target.dataset.action === "open-drawer") {
        this._drawer.show();
        return;
      }
      if (target.dataset.action === "open-modal") {
        this._modal.show();
        return;
      }
      if (target.dataset.action === "show-toast") {
        this._toast.show(this.t("gallery.toastText"));
        return;
      }
      if (target.dataset.action === "sort") {
        const key = target.dataset.key;
        const dir = this.sort.key === key && this.sort.dir === "desc" ? "asc" : "desc";
        this.sort = { key, dir };
        this._focus = `[data-action="sort"][data-key="${key}"]`;
        this.renderNow();
      }
    });
    region.addEventListener("change", (event) => {
      const target = event.target;
      if (target.dataset.action === "select-row") {
        if (target.checked) this.selected.add(target.dataset.id);
        else this.selected.delete(target.dataset.id);
        this._focus = `[data-action="select-row"][data-id="${target.dataset.id}"]`;
        this.renderNow();
      } else if (target.dataset.action === "select-all") {
        if (target.checked) ROWS.forEach((r) => this.selected.add(r.id));
        else this.selected.clear();
        this._focus = '[data-action="select-all"]';
        this.renderNow();
      }
    });
  }
}

CqaPlayground.prototype.restoreFocus = function restoreFocus(region) {
  if (!this._focus) return;
  region.querySelector(this._focus)?.focus();
  this._focus = null;
};

if (globalThis.customElements && !customElements.get("cqa-playground")) {
  customElements.define("cqa-playground", CqaPlayground);
}
