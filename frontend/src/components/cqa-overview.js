import { api, ensureConfigured } from "../api.js";
import { CqaElement, html, raw } from "../base-element.js";
import { navigate } from "../events.js";
import { SHARED_CSS } from "../shared/styles.js";
import { emptyPanel, errorPanel, loadingPanel } from "../shared/state-panel.js";
import {
  CHANNELS,
  LANGUAGES,
  attentionCard,
  buildFilter,
  criteriaCard,
  defaultDataset,
  defaultVersionId,
  distributionCard,
  formatRange,
  kpiSection,
  selectableVersions,
  splitCard
} from "./overview-view.js";

const STYLES = `${SHARED_CSS}
:host { display: block; font-size: var(--cqa-fs-14); color: var(--cqa-ink); }
.page { container-type: inline-size; display: flex; flex-direction: column; gap: 20px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.titles { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
h1 { margin: 0; font-size: var(--cqa-fs-24); font-weight: 600; letter-spacing: -0.01em; }
.lead { margin: 0; font-size: var(--cqa-fs-13); color: var(--cqa-ink-3); }
.filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0; }
.filters .field { max-width: 100%; }
.filters .seg { height: 30px; }
.body { display: flex; flex-direction: column; gap: 20px; }
.body[aria-busy="true"] { opacity: .6; transition: opacity .15s; }
.kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
.kpi { padding: 20px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.kpi-gross { border-color: var(--cqa-critical-bg); }
.kpi-label { font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); }
.kpi-value { font-size: var(--cqa-fs-32); font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; }
.kpi-value.hot { color: var(--cqa-critical); }
.kpi-unit { font-size: var(--cqa-fs-14); font-weight: 500; color: var(--cqa-ink-3); letter-spacing: 0; }
.kpi-note { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); min-height: 1.45em; }
.kpi-note.up { color: var(--cqa-ok); }
.kpi-note.down { color: var(--cqa-bad); }
.kpi-note.warn { color: var(--cqa-warn); }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
.grid2.skew { grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); }
.block { padding: 20px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.block-flush { padding: 20px 8px 8px; gap: 8px; }
.block-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.block h2 { margin: 0; font-size: var(--cqa-fs-16); font-weight: 600; }
.block-cap { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
.block-note { margin: 0; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
.pad-h { margin: 0 12px; }
h2.pad-h { margin: 0 12px; }
.pad { padding: 0 12px 12px; margin: 0; }
.block-head.pad-h { margin: 0 12px; }
.crit-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.crit-row { display: grid; grid-template-columns: 220px minmax(0, 1fr) 56px; gap: 12px; align-items: center; }
.crit-name { font-size: var(--cqa-fs-13); overflow-wrap: anywhere; }
.crit-track { height: 10px; background: var(--cqa-surface-3); border-radius: 5px; display: block; }
.crit-fill { display: block; height: 10px; border-radius: 5px; }
.crit-val { text-align: right; font-size: var(--cqa-fs-13); font-weight: 600; }
.dt-wrap { overflow-x: auto; }
.dt { width: 100%; border-collapse: collapse; font-size: var(--cqa-fs-13); }
.dt th { text-align: left; font-weight: 500; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); padding: 8px 12px; border-bottom: 1px solid var(--cqa-line); white-space: nowrap; }
.dt td { padding: 0 12px; height: 40px; border-bottom: 1px solid var(--cqa-line); white-space: nowrap; }
.dt tbody tr:last-child td { border-bottom: 0; }
.dt tbody tr:hover td { background: var(--cqa-surface-2); }
.dt .num { text-align: right; font-variant-numeric: tabular-nums; }
.dt .strong { font-weight: 500; }
.dt .gross-hot { color: var(--cqa-critical); font-weight: 600; }
.att-score { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 2px; padding: 4px 0; }
.state { display: flex; flex-direction: column; gap: 12px; }
@container (max-width: 1099px) {
  .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .grid2, .grid2.skew { grid-template-columns: minmax(0, 1fr); }
}
@container (max-width: 640px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .crit-row { grid-template-columns: minmax(0, 1fr) 56px; }
  .crit-track { grid-column: 1 / -1; grid-row: 2; }
  .crit-name { grid-column: 1; grid-row: 1; }
  .crit-val { grid-column: 2; grid-row: 1; }
}
@container (max-width: 420px) {
  .kpis { grid-template-columns: minmax(0, 1fr); }
}
`;

export class CqaOverview extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "dataset", "checklist-version"];
  }

  constructor() {
    super();
    this.status = "loading";
    this.data = null;
    this.error = null;
    this.datasets = [];
    this.checklists = [];
    this.fullPeriod = null;
    this.token = 0;
    this.filter = { dataset: null, versionId: null, period: "full", language: "", channel: "" };
    this.shadowRoot.addEventListener("click", (event) => this.onClick(event));
    this.shadowRoot.addEventListener("change", (event) => this.onChange(event));
    this.shadowRoot.addEventListener("submit", (event) => event.preventDefault());
  }

  styles() {
    return STYLES;
  }

  onReady() {
    ensureConfigured();
    this.start();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.token += 1;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "dataset" || name === "checklist-version") {
      if (!this._ready || oldValue === newValue) return;
      if (name === "dataset") this.filter.dataset = newValue || this.filter.dataset;
      else this.filter.versionId = newValue ? Number(newValue) || newValue : this.filter.versionId;
      this.load();
      return;
    }
    super.attributeChangedCallback(name, oldValue, newValue);
  }

  async start() {
    const token = (this.token += 1);
    this.status = "loading";
    this.scheduleRender();
    const [datasets, checklists] = await Promise.all([
      api.listDatasets().catch(() => []),
      api.listChecklists().catch(() => [])
    ]);
    if (token !== this.token || !this.isConnected) return;
    this.datasets = datasets;
    this.checklists = checklists;
    const datasetAttr = this.getAttribute("dataset");
    const versionAttr = this.getAttribute("checklist-version");
    this.filter.dataset = datasetAttr || this.filter.dataset || defaultDataset(datasets);
    this.filter.versionId = versionAttr ? Number(versionAttr) || versionAttr : this.filter.versionId || defaultVersionId(checklists);
    await this.load();
  }

  async load() {
    const token = (this.token += 1);
    if (this.status !== "ready") this.status = "loading";
    this.busy = true;
    this.scheduleRender();
    try {
      const data = await api.getOverview(buildFilter(this.filter, this.fullPeriod));
      if (token !== this.token || !this.isConnected) return;
      this.data = data;
      this.error = null;
      this.status = "ready";
      if (this.filter.period === "full" && data.period && data.period.to) this.fullPeriod = data.period;
    } catch (error) {
      if (token !== this.token || !this.isConnected) return;
      this.error = error;
      this.status = "error";
    }
    this.busy = false;
    this.scheduleRender();
  }

  onClick(event) {
    const target = event.target.closest ? event.target.closest("[data-action]") : null;
    if (!target) return;
    const action = target.getAttribute("data-action");
    if (action === "retry") {
      this.start();
    } else if (action === "dataset") {
      this.filter.dataset = target.getAttribute("data-value");
      this.load();
    } else if (action === "open") {
      event.preventDefault();
      navigate(this, "conversations", target.getAttribute("data-id"));
    } else if (action === "all") {
      event.preventDefault();
      navigate(this, "conversations");
    } else if (action === "runs") {
      navigate(this, "runs");
    }
  }

  onChange(event) {
    const target = event.target;
    const key = target.getAttribute ? target.getAttribute("data-filter") : null;
    if (!key) return;
    if (key === "versionId") {
      const value = target.value;
      this.filter.versionId = value ? Number(value) || value : null;
    } else {
      this.filter[key] = target.value;
    }
    this.load();
  }

  subtitle(locale) {
    const range = this.data ? formatRange(this.data.period, locale) : null;
    const version = selectableVersions(this.checklists).find((v) => String(v.id) === String(this.filter.versionId));
    if (!range || !version) return "";
    return this.t("overview.subtitle", { from: range.from, to: range.to, checklist: version.checklist, version: version.label });
  }

  filtersForm(locale) {
    const f = this.filter;
    const datasets = this.datasets.map(
      (d) => html`<button type="button" data-action="dataset" data-value="${d.groupId}" aria-pressed="${String(String(d.groupId) === String(f.dataset))}">${d.label}</button>`
    );
    const versions = selectableVersions(this.checklists);
    const versionOptions = versions.map((v) => {
      const key = v.isDefault ? "overview.filter.versionActive" : "overview.filter.versionPlain";
      const text = this.t(key, { checklist: v.checklist, version: v.label });
      return html`<option value="${v.id}" ${raw(String(v.id) === String(f.versionId) ? "selected" : "")}>${text}</option>`;
    });
    const full = this.fullPeriod && this.fullPeriod.from ? formatRange(this.fullPeriod, locale) : null;
    const fullLabel = full ? this.t("overview.filter.periodFull", full) : this.t("overview.filter.periodFullPlain");
    const langOptions = LANGUAGES.map((l) => html`<option value="${l}" ${raw(f.language === l ? "selected" : "")}>${l}</option>`);
    const channelOptions = CHANNELS.map((c) => html`<option value="${c}" ${raw(f.channel === c ? "selected" : "")}>${this.t(`overview.channel.${c}`)}</option>`);
    const sel = (value, current) => (value === current ? "selected" : "");
    return html`<form class="filters" aria-label="${this.t("overview.filters")}">
      ${this.datasets.length ? html`<div class="seg" role="group" aria-label="${this.t("overview.filter.dataset")}">${datasets}</div>` : html``}
      ${versions.length ? html`<select class="field" data-filter="versionId" data-focus-id="f-version" aria-label="${this.t("overview.filter.version")}">${versionOptions}</select>` : html``}
      <select class="field" data-filter="period" data-focus-id="f-period" aria-label="${this.t("overview.filter.period")}"><option value="full" ${raw(sel("full", f.period))}>${fullLabel}</option><option value="last7" ${raw(sel("last7", f.period))}>${this.t("overview.filter.periodLast7")}</option></select>
      <select class="field" data-filter="language" data-focus-id="f-language" aria-label="${this.t("overview.filter.language")}"><option value="">${this.t("overview.filter.languageAll")}</option>${langOptions}</select>
      <select class="field" data-filter="channel" data-focus-id="f-channel" aria-label="${this.t("overview.filter.channel")}"><option value="">${this.t("overview.filter.channelAll")}</option>${channelOptions}</select>
    </form>`;
  }

  content(locale) {
    if (this.status === "loading" && !this.data) {
      return html`<div class="state" role="status" aria-label="${this.t("overview.loading")}" aria-busy="true"><div class="kpis">${[1, 2, 3, 4, 5].map(() => loadingPanel(locale))}</div><div class="grid2">${loadingPanel(locale)}${loadingPanel(locale)}</div></div>`;
    }
    if (this.status === "error") {
      return errorPanel(locale, { title: this.t("overview.error.title"), message: this.t("overview.error.hint") });
    }
    const d = this.data;
    if (!d || d.kpis.evaluatedCount === 0) {
      return emptyPanel(locale, { title: this.t("overview.empty.title"), hint: this.t("overview.empty.hint"), actionLabel: this.t("overview.empty.action"), action: "runs" });
    }
    return html`<div class="body" aria-busy="${String(Boolean(this.busy))}">
      ${kpiSection(d.kpis, locale)}
      <div class="grid2">${distributionCard(d.distribution, locale)}${criteriaCard(d.perCriterion, locale)}</div>
      <div class="grid2 skew">${splitCard(d, locale)}${attentionCard(d, locale)}</div>
    </div>`;
  }

  template() {
    const locale = this.locale;
    const sub = this.subtitle(locale);
    const subtitle = sub ? html`<p class="lead" title="${this.t("overview.subtitleBasis")}">${sub}</p>` : html``;
    return html`<div class="page"><div class="top"><div class="titles"><h1 id="title">${this.t("overview.title")}</h1>${subtitle}</div>${this.filtersForm(locale)}</div>${this.content(locale)}</div>`;
  }
}

