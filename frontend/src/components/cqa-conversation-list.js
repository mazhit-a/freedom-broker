import { api, ensureConfigured } from "../api.js";
import { CqaElement, html, raw } from "../base-element.js";
import { EVENTS, emit, navigate } from "../events.js";
import { integer, number } from "../format.js";
import { can } from "../roles.js";
import { SHARED_CSS } from "../shared/styles.js";
import { emptyPanel, errorPanel } from "../shared/state-panel.js";
import {
  APPEAL_STATUSES,
  CHANNELS,
  LANGUAGES,
  VIEWS,
  applyClientAppealView,
  buildFilter,
  defaultBulkVersion,
  emptyFilters,
  formatCost,
  hasNext,
  nextSort,
  normalizePageSize,
  normalizeView,
  pageRange,
  savedVersions,
  usesClientAppealView
} from "./cqa-conversation-list-model.js";
import { LIST_CSS, countsText, searchIcon, skeletonHtml, tableHtml } from "./cqa-conversation-list-table.js";

const SEARCH_DELAY = 250;
const TEXT_TARGETS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

export class CqaConversationList extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "saved-view", "page-size", "operator", "selectable"];
  }

  constructor() {
    super();
    this._view = "all";
    this._filters = emptyFilters();
    this._sort = null;
    this._offset = 0;
    this._pageSize = normalizePageSize(null);
    this._data = null;
    this._status = "loading";
    this._error = null;
    this._token = 0;
    this._selected = new Set();
    this._activeId = null;
    this._versions = [];
    this._bulkVersion = null;
    this._sectionTitles = [];
    this._queued = null;
    this._starting = false;
    this._bulkError = null;
    this._searchTimer = null;
    this._onClick = (event) => this.handleClick(event);
    this._onChange = (event) => this.handleChange(event);
    this._onInput = (event) => this.handleInput(event);
    this._onKeydown = (event) => this.handleKeydown(event);
  }

  styles() {
    return `${SHARED_CSS}${LIST_CSS}
      :host { display: block; }
      .page { display: flex; flex-direction: column; gap: 16px; }
      .head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
      .head h2 { margin: 0; font-size: var(--cqa-fs-24); font-weight: 600; letter-spacing: -0.01em; }
      .counts { font-size: var(--cqa-fs-13); color: var(--cqa-ink-3); font-variant-numeric: tabular-nums; }
      .filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .search { position: relative; display: flex; align-items: center; }
      .search svg { position: absolute; left: 10px; color: var(--cqa-ink-3); pointer-events: none; }
      .search input { padding-left: 34px; width: 280px; max-width: 100%; }
      .views { margin-left: auto; display: flex; align-items: center; gap: 8px; }
      .views span { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
      .bulk { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 14px; border-radius: 12px; background: var(--cqa-brand-deep); color: #fff; }
      .bulk b { font-size: var(--cqa-fs-13); font-variant-numeric: tabular-nums; }
      .bulk label { display: flex; align-items: center; gap: 8px; font-size: var(--cqa-fs-12); }
      .bulk .field { height: 30px; }
      .bulk .btn-light { background: #fff; color: var(--cqa-brand-deep); border-color: #fff; }
      .bulk .btn-light:hover { background: var(--cqa-brand-tint); }
      .bulk .btn-ghost-on { background: transparent; color: #fff; border-color: rgba(255,255,255,.4); }
      .bulk .btn-ghost-on:hover { background: rgba(255,255,255,.12); }
      .bulk .btn:focus-visible, .bulk .field:focus-visible, .bulk a:focus-visible { outline-color: #fff; }
      .bulk .queued, .bulk .hint { font-size: var(--cqa-fs-12); margin-left: auto; }
      .bulk .hint { opacity: .85; }
      .bulk a { color: #fff; }
      .pager { display: flex; align-items: center; gap: 8px; justify-content: flex-end; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); font-variant-numeric: tabular-nums; }
      .note { margin: 0; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
      .panel { max-width: 560px; }
      @container (max-width: 1100px) {
        .views { margin-left: 0; }
      }
    `;
  }

  connectedCallback() {
    this.shadowRoot.addEventListener("click", this._onClick);
    this.shadowRoot.addEventListener("change", this._onChange);
    this.shadowRoot.addEventListener("input", this._onInput);
    this.shadowRoot.addEventListener("keydown", this._onKeydown);
    super.connectedCallback();
  }

  disconnectedCallback() {
    this.shadowRoot.removeEventListener("click", this._onClick);
    this.shadowRoot.removeEventListener("change", this._onChange);
    this.shadowRoot.removeEventListener("input", this._onInput);
    this.shadowRoot.removeEventListener("keydown", this._onKeydown);
    clearTimeout(this._searchTimer);
    this._token += 1;
    super.disconnectedCallback();
  }

  attributeChangedCallback(name, oldValue, value) {
    super.attributeChangedCallback(name, oldValue, value);
    if (!this._ready || oldValue === value) return;
    if (name === "saved-view") {
      this.applyView(normalizeView(value));
    } else if (name === "page-size") {
      this._pageSize = normalizePageSize(value);
      this._offset = 0;
      this.load();
    } else if (name === "operator") {
      this._offset = 0;
      this.load();
    }
  }

  onReady() {
    ensureConfigured();
    this._view = normalizeView(this.getAttribute("saved-view"));
    this._pageSize = normalizePageSize(this.getAttribute("page-size"));
    this.loadMeta();
    this.load();
  }

  get selectable() {
    return this.getAttribute("selectable") !== "false";
  }

  async loadMeta() {
    try {
      const checklists = await api.listChecklists();
      this._versions = savedVersions(checklists);
      if (this._bulkVersion === null || !this._versions.some((v) => v.id === this._bulkVersion)) {
        this._bulkVersion = defaultBulkVersion(this._versions);
      }
      this.scheduleRender();
      const first = checklists.find((c) => c.defaultVersionId) || checklists[0];
      const versionId = first ? first.defaultVersionId || (first.versions[0] && first.versions[0].id) : null;
      if (versionId) {
        const version = await api.getChecklistVersion(versionId);
        const sections = Array.isArray(version.sections) ? version.sections : version.config && version.config.sections;
        this._sectionTitles = (sections || []).filter((s) => s.id !== "gross").map((s) => s.title);
        this.scheduleRender();
      }
    } catch (error) {
      this.scheduleRender();
    }
  }

  async fetchPage() {
    const base = {
      view: this._view,
      filters: this._filters,
      sort: this._sort,
      offset: this._offset,
      pageSize: this._pageSize,
      operator: this.getAttribute("operator") || undefined
    };
    const filter = buildFilter(base);
    const response = await api.listConversations(filter);
    if (usesClientAppealView(this._view, this._filters)) return applyClientAppealView(response, base);
    return response;
  }

  async load() {
    const token = (this._token += 1);
    this._status = this._data ? "refreshing" : "loading";
    this.scheduleRender();
    try {
      const result = await this.fetchPage();
      if (token !== this._token) return;
      this._data = result;
      this._status = "ready";
      this._error = null;
    } catch (error) {
      if (token !== this._token) return;
      this._status = "error";
      this._error = error;
    }
    this.renderNow();
  }

  items() {
    return this._data ? this._data.items : [];
  }

  activeId() {
    const items = this.items();
    return items.some((i) => i.pk === this._activeId) ? this._activeId : items.length ? items[0].pk : null;
  }

  filtersActive() {
    const f = this._filters;
    return Boolean(f.q || f.language || f.channel || f.versionId || f.appealStatus || this._view !== "all");
  }

  select(name, label, allLabel, options, value) {
    const opts = options.map((o) => html`<option value="${o.value}" ${raw(String(o.value) === String(value) ? "selected" : "")}>${o.label}</option>`);
    return html`<select class="field" data-filter="${name}" data-focus-id="filter-${name}" aria-label="${label}"><option value="">${allLabel}</option>${opts}</select>`;
  }

  headerHtml() {
    const total = this._data ? this._data.evaluated : 0;
    const shown = this.items().length;
    const counts = this._data ? countsText(total, shown, this.locale) : "";
    return html`<div class="head"><div class="row gap-3" style="align-items:baseline"><h2>${this.t("list.title")}</h2><span class="counts" data-counts>${counts}</span></div><div class="row gap-2"><a class="btn" href="#/runs" data-nav="runs">${this.t("list.loadSet")}</a><a class="btn" href="#/checklists" data-nav="checklists">${this.t("list.checklists")}</a></div></div>`;
  }

  filtersHtml() {
    const f = this._filters;
    const languages = LANGUAGES.map((l) => ({ value: l, label: l }));
    const channels = CHANNELS.map((c) => ({ value: c, label: this.t(`list.channel.${c}`) }));
    const versions = this._versions.map((v) => ({ value: v.id, label: v.title }));
    const appeals = APPEAL_STATUSES.map((s) => ({ value: s, label: this.t(`status.${s}`) }));
    const views = VIEWS.map(
      (v) => html`<button type="button" data-action="view" data-view="${v}" data-focus-id="view-${v}" aria-pressed="${String(this._view === v)}">${this.t(`list.view.${v}`)}</button>`
    );
    return html`<div class="filters"><div class="search">${searchIcon()}<input class="field" type="search" data-search data-focus-id="search" aria-label="${this.t("list.search.label")}" placeholder="${this.t("list.search.placeholder")}" value="${f.q}"></div>${this.select("language", this.t("list.filter.language"), this.t("list.filter.languageAll"), languages, f.language)}${this.select("channel", this.t("list.filter.channel"), this.t("list.filter.channelAll"), channels, f.channel)}${this.select("versionId", this.t("list.filter.version"), this.t("list.filter.versionAll"), versions, f.versionId)}${this.select("appealStatus", this.t("list.filter.appeal"), this.t("list.filter.appealAll"), appeals, f.appealStatus)}<div class="views"><span>${this.t("list.views.caption")}</span><div class="seg" role="group" aria-label="${this.t("list.views.label")}">${views}</div></div></div>`;
  }

  bulkHtml() {
    const count = this._selected.size;
    if (!count) return html``;
    const allowed = can(this.role, "bulk-evaluate");
    const options = this._versions.map((v) => {
      const label = v.active ? this.t("list.bulk.active", { label: v.title }) : v.title;
      return html`<option value="${v.id}" ${raw(v.id === this._bulkVersion ? "selected" : "")}>${label}</option>`;
    });
    const blocked = !allowed || this._starting || this._bulkVersion === null;
    const run = this._starting ? this.t("list.bulk.starting") : this.t("list.bulk.run");
    let message = html``;
    if (!allowed) message = html`<span class="hint" data-hint>${this.t("list.bulk.forbidden")}</span>`;
    else if (this._bulkVersion === null) message = html`<span class="hint" data-hint>${this.t("list.bulk.noVersion")}</span>`;
    else if (this._bulkError) message = html`<span class="queued" role="alert" data-bulk-error>${this._bulkError}</span>`;
    else if (this._queued) {
      message = html`<span class="queued" role="status" data-queued>${this.t("list.bulk.queued")} <a href="#/runs/${encodeURIComponent(this._queued.id)}" data-action="open-run" data-run="${this._queued.id}">${this.t("list.bulk.queuedLink")}</a></span>`;
    }
    return html`<div class="bulk" role="region" aria-label="${this.t("list.bulk.label")}" data-bulk><b>${this.t("list.bulk.selected", { count: integer(count, this.locale) })}</b><label>${this.t("list.bulk.version")}<select class="field" data-bulk-version data-focus-id="bulk-version" ${raw(allowed ? "" : "disabled")}>${options}</select></label><button type="button" class="btn btn-sm btn-light" data-action="run" data-focus-id="bulk-run" ${raw(blocked ? "disabled" : "")}>${run}</button><button type="button" class="btn btn-sm btn-ghost-on" data-action="clear" data-focus-id="bulk-clear">${this.t("list.bulk.clear")}</button>${message}</div>`;
  }

  bodyHtml() {
    if (this._status === "loading") return skeletonHtml(this.locale);
    if (this._status === "error") return errorPanel(this.locale, { title: this.t("state.error") });
    const items = this.items();
    if (!items.length) {
      return emptyPanel(this.locale, {
        title: this.t("list.empty.title"),
        hint: this.t("list.empty.hint"),
        actionLabel: this.filtersActive() ? this.t("list.empty.reset") : null,
        action: "reset"
      });
    }
    return tableHtml(items, {
      locale: this.locale,
      selected: this._selected,
      selectable: this.selectable,
      activeId: this._activeId,
      sort: this._sort,
      busy: this._status === "refreshing",
      sectionTitles: this._sectionTitles
    });
  }

  pagerHtml() {
    if (!this._data || this._status === "error") return html``;
    const total = this._data.total;
    const count = this._data.items.length;
    if (total <= this._pageSize) return html``;
    const range = pageRange(this._offset, count, total);
    const label = this.t("list.pager.range", { from: integer(range.from, this.locale), to: integer(range.to, this.locale), total: integer(range.total, this.locale) });
    const prev = this._offset <= 0;
    const next = !hasNext(this._offset, count, total);
    return html`<nav class="pager" aria-label="${this.t("list.pager.label")}"><span data-range>${label}</span><button type="button" class="btn btn-sm" data-action="prev" data-focus-id="page-prev" ${raw(prev ? "disabled" : "")}>${this.t("list.pager.prev")}</button><button type="button" class="btn btn-sm" data-action="next" data-focus-id="page-next" ${raw(next ? "disabled" : "")}>${this.t("list.pager.next")}</button></nav>`;
  }

  template() {
    const showNote = this._status === "ready" || this._status === "refreshing";
    return html`<div class="page">${this.headerHtml()}${this.filtersHtml()}${this.bulkHtml()}${this.bodyHtml()}${this.pagerHtml()}${showNote ? html`<p class="note">${this.t("list.note")}</p><p class="note">${this.t("list.keys")}</p>` : html``}</div>`;
  }

  afterRender(region) {
    const all = region.querySelector("[data-action=select-all]");
    if (all) {
      const items = this.items();
      const chosen = items.filter((i) => this._selected.has(i.pk)).length;
      all.indeterminate = chosen > 0 && chosen < items.length;
    }
  }

  resetPaging() {
    this._offset = 0;
    this._activeId = null;
  }

  applyView(view) {
    this._view = view;
    if (view === "appeals") this._filters.appealStatus = "";
    this.resetPaging();
    this.load();
  }

  resetFilters() {
    this._filters = emptyFilters();
    this._view = "all";
    this.resetPaging();
    this.load();
  }

  handleInput(event) {
    const target = event.target;
    if (!target.matches || !target.matches("[data-search]")) return;
    this._filters.q = target.value;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this.resetPaging();
      this.load();
    }, SEARCH_DELAY);
  }

  handleChange(event) {
    const target = event.target;
    if (!target.matches) return;
    if (target.matches("[data-filter]")) {
      const name = target.getAttribute("data-filter");
      this._filters[name] = target.value;
      if (name === "appealStatus" && target.value && this._view === "appeals") this._view = "all";
      this.resetPaging();
      this.load();
    } else if (target.matches("[data-bulk-version]")) {
      this._bulkVersion = Number(target.value);
      this._queued = null;
      this._bulkError = null;
      this.scheduleRender();
    } else if (target.matches("[data-action=select-row]")) {
      this.toggle(Number(target.getAttribute("data-id")), target.checked);
    } else if (target.matches("[data-action=select-all]")) {
      for (const item of this.items()) {
        if (target.checked) this._selected.add(item.pk);
        else this._selected.delete(item.pk);
      }
      this.afterSelection();
    }
  }

  toggle(pk, on) {
    const want = on === undefined ? !this._selected.has(pk) : on;
    if (want) this._selected.add(pk);
    else this._selected.delete(pk);
    this.afterSelection();
  }

  afterSelection() {
    this._queued = null;
    this._bulkError = null;
    this.renderNow();
  }

  handleClick(event) {
    const el = event.target.closest ? event.target.closest("[data-action], [data-nav]") : null;
    if (!el) return;
    const nav = el.getAttribute("data-nav");
    if (nav) {
      event.preventDefault();
      navigate(this, nav);
      return;
    }
    const action = el.getAttribute("data-action");
    if (action === "open") {
      event.preventDefault();
      navigate(this, "conversations", el.getAttribute("data-conversation"));
    } else if (action === "open-runs") {
      event.preventDefault();
      navigate(this, "runs");
    } else if (action === "open-run") {
      event.preventDefault();
      navigate(this, "runs", el.getAttribute("data-run"));
    } else if (action === "sort") {
      this._sort = nextSort(this._sort);
      this.resetPaging();
      this.load();
    } else if (action === "view") {
      this.applyView(normalizeView(el.getAttribute("data-view")));
    } else if (action === "reset") {
      this.resetFilters();
    } else if (action === "retry") {
      this.load();
    } else if (action === "prev") {
      this._offset = Math.max(0, this._offset - this._pageSize);
      this._activeId = null;
      this.load();
    } else if (action === "next") {
      this._offset += this._pageSize;
      this._activeId = null;
      this.load();
    } else if (action === "clear") {
      this._selected.clear();
      this.afterSelection();
    } else if (action === "run") {
      this.runSelected();
    }
  }

  handleKeydown(event) {
    const target = event.target;
    if (!target.closest || !target.closest("[data-table]")) return;
    if (TEXT_TARGETS.has(target.tagName) && target.type !== "checkbox") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const row = target.closest("[data-row]");
    if (!row) return;
    const key = event.key;
    if (key === "j" || key === "ArrowDown") {
      event.preventDefault();
      this.moveActive(1);
    } else if (key === "k" || key === "ArrowUp") {
      event.preventDefault();
      this.moveActive(-1);
    } else if (key === "Enter" && target === row) {
      event.preventDefault();
      navigate(this, "conversations", row.querySelector("[data-conversation]").getAttribute("data-conversation"));
    } else if (key === " " && target === row) {
      event.preventDefault();
      this.toggle(Number(row.getAttribute("data-row")));
    }
  }

  moveActive(step) {
    const rows = [...this.shadowRoot.querySelectorAll("[data-row]")];
    if (!rows.length) return;
    const current = rows.findIndex((r) => Number(r.getAttribute("data-row")) === this.activeId());
    const next = Math.max(0, Math.min(rows.length - 1, (current < 0 ? 0 : current) + step));
    for (const r of rows) {
      r.setAttribute("tabindex", "-1");
      r.classList.remove("active");
    }
    const target = rows[next];
    target.setAttribute("tabindex", "0");
    target.classList.add("active");
    this._activeId = Number(target.getAttribute("data-row"));
    target.focus();
  }

  askConfirm(detail) {
    const host = this.getRootNode() && this.getRootNode().host;
    if (!host || host.localName !== "cqa-app") return Promise.resolve(true);
    return new Promise((resolve) => emit(this, EVENTS.confirm, { ...detail, resolve }));
  }

  reasonOf(error) {
    if (error && error.code === "role_forbidden") return this.t("list.bulk.forbidden");
    return error && error.message ? error.message : this.t("state.errorHint");
  }

  async runSelected() {
    if (this._starting || !can(this.role, "bulk-evaluate") || this._bulkVersion === null || !this._selected.size) return;
    const ids = [...this._selected];
    const version = this._versions.find((v) => v.id === this._bulkVersion);
    this._starting = true;
    this._queued = null;
    this._bulkError = null;
    this.renderNow();
    let model = null;
    let estimate = null;
    try {
      const models = await api.listModels();
      model = models && models[0] ? models[0] : null;
    } catch (error) {
      model = null;
    }
    try {
      estimate = await api.estimateRun({ count: ids.length, model: model ? model.id : undefined, conversationIds: ids });
    } catch (error) {
      estimate = null;
    }
    const cost = estimate && estimate.cost !== undefined && estimate.cost !== null ? this.t("list.confirm.cost", { cost: formatCost(estimate.cost, this.locale, number) }) : this.t("list.confirm.noCost");
    const summary = this.t("list.confirm.body", {
      count: this.t("count.conversations", { count: ids.length }),
      version: version ? version.title : "",
      model: model ? model.label : "—"
    });
    const confirmed = await this.askConfirm({
      heading: this.t("list.confirm.title"),
      description: `${summary} ${cost}`,
      confirmLabel: this.t("list.confirm.ok"),
      cancelLabel: this.t("action.cancel")
    });
    if (!confirmed) {
      this._starting = false;
      this.renderNow();
      return;
    }
    try {
      const run = await api.startRun({ versionId: this._bulkVersion, conversationIds: ids, model: model ? model.id : undefined });
      this._queued = { id: run.id };
      emit(this, EVENTS.toast, {
        message: this.t("list.toast.queued", { count: this.t("count.conversations", { count: ids.length }) }),
        action: { label: this.t("list.toast.open"), to: "runs", id: run.id }
      });
    } catch (error) {
      this._bulkError = this.t("list.bulk.error", { reason: this.reasonOf(error) });
      emit(this, EVENTS.toast, { message: this._bulkError, tone: "bad" });
    }
    this._starting = false;
    this.renderNow();
  }
}
