import { CqaElement, html, raw } from "../base-element.js";
import { api } from "../api.js";
import { can } from "../roles.js";
import { EVENTS, emit, navigate } from "../events.js";
import { duration, integer, number } from "../format.js";
import { SHARED_CSS } from "../shared/styles.js";
import { icon } from "../shared/icons.js";
import { chip, langChip } from "../shared/chip.js";
import { dataTable } from "../shared/data-table.js";
import { emptyPanel, errorPanel, loadingPanel } from "../shared/state-panel.js";
import {
  cancelOutcome,
  cancelledPercent,
  errorKey,
  isJsonFile,
  itemKind,
  otherVersionLabel,
  progressSegments,
  queuedCount,
  runCanCancel,
  runIsActive,
  savedVersionOptions,
  validateDatasetText,
  wallDateTime
} from "./cqa-eval-runs-model.js";

const POLL_MS = 2000;
const ITEMS_LIMIT = 100;

const UPLOAD_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="color:var(--cqa-ink-3);flex:none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m17 8-5-5-5 5"></path><path d="M12 3v12"></path></svg>';

const ITEM_TONE = { done: "ok", lowConfidence: "na", failed: "bad", running: "warn", queued: "na", cancelled: "na" };

export class CqaEvalRuns extends CqaElement {
  constructor() {
    super();
    this._phase = "loading";
    this._loadError = null;
    this._runs = [];
    this._datasets = [];
    this._checklists = [];
    this._models = [];
    this._modelsGap = false;
    this._run = null;
    this._runLoading = false;
    this._pollError = false;
    this._cancelBusy = new Set();
    this._epoch = 0;
    this._timer = null;
    this._estimateToken = 0;
    this._form = {
      source: "api",
      groupId: "",
      customGroup: "",
      versionId: null,
      modelId: null,
      force: false,
      file: null,
      fileInfo: null,
      fileError: null,
      dragging: false,
      estimate: null,
      starting: false,
      startError: null
    };
    this.shadowRoot.addEventListener("click", (event) => this.onClick(event));
    this.shadowRoot.addEventListener("change", (event) => this.onChange(event));
    this.shadowRoot.addEventListener("input", (event) => this.onInput(event));
    this.shadowRoot.addEventListener("dragover", (event) => this.onDrag(event, true));
    this.shadowRoot.addEventListener("dragleave", (event) => this.onDrag(event, false));
    this.shadowRoot.addEventListener("drop", (event) => this.onDrop(event));
  }

  disconnectedCallback() {
    this.stopPolling();
    this._epoch += 1;
    this._estimateToken += 1;
    super.disconnectedCallback();
  }

  onReady() {
    this.load();
  }

  styles() {
    return `${SHARED_CSS}
      :host { display: block; }
      h1 { margin: 0; font-size: var(--cqa-fs-24); font-weight: 600; letter-spacing: -0.01em; }
      h2 { margin: 0; font-size: var(--cqa-fs-16); font-weight: 600; }
      .screen { display: flex; flex-direction: column; gap: 16px; }
      .grid { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
      .form { flex: 0 1 380px; min-width: 300px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
      .form .seg { align-self: flex-start; }
      .cur-wrap { flex: 1 1 640px; min-width: 0; }
      .cur { overflow: hidden; }
      .lbl { display: flex; flex-direction: column; gap: 6px; font-size: var(--cqa-fs-12); font-weight: 500; color: var(--cqa-ink-2); }
      .lbl .field, .field.full { width: 100%; }
      select.field, input.field { min-width: 0; }
      select[data-field=model] { font-size: var(--cqa-fs-12); }
      .drop { border: 1px dashed var(--cqa-line-strong); border-radius: 10px; padding: 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; background: var(--cqa-surface-2); font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); }
      .drop.over { border-color: var(--cqa-brand); background: var(--cqa-brand-tint); }
      .drop-text { flex: 1 1 160px; min-width: 0; }
      .drop code { font-size: 11px; overflow-wrap: anywhere; }
      .file-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); margin: 0; }
      .file-line.bad, .msg-bad { color: var(--cqa-bad); }
      .msg-bad { margin: 0; font-size: var(--cqa-fs-12); }
      .row-between { display: flex; justify-content: space-between; gap: 12px; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
      .row-between b { color: var(--cqa-ink); font-weight: 600; font-variant-numeric: tabular-nums; }
      .check { display: flex; align-items: center; gap: 8px; font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); }
      .btn-primary { justify-content: center; }
      .hint { margin: 0; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
      .head { padding: 18px 20px 14px; display: flex; flex-direction: column; gap: 12px; }
      .head-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .head-top h2:focus { outline: none; }
      .meta { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); font-variant-numeric: tabular-nums; }
      .time { margin-left: auto; font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); font-variant-numeric: tabular-nums; }
      .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: currentColor; }
      .bar { height: 8px; border-radius: 4px; background: var(--cqa-surface-3); display: flex; overflow: hidden; }
      .bar span { display: block; height: 100%; }
      .seg-done { background: var(--cqa-brand-deep); }
      .seg-failed { background: var(--cqa-bad); }
      .seg-run { background: var(--cqa-warn); }
      .seg-cancel { background: var(--cqa-line-strong); }
      .counters { display: flex; gap: 18px; flex-wrap: wrap; font-size: var(--cqa-fs-13); font-variant-numeric: tabular-nums; }
      .counters b { font-weight: 600; }
      .counters .bad { color: var(--cqa-bad); }
      .counters .muted { color: var(--cqa-ink-3); }
      .counters .spent { margin-left: auto; color: var(--cqa-ink-3); }
      .cur .tbl-wrap, .hist .tbl-wrap { border: 0; border-radius: 0; border-top: 1px solid var(--cqa-line); }
      .foot { padding: 10px 16px; border-top: 1px solid var(--cqa-line); font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
      .hist { overflow: hidden; }
      .hist h2 { padding: 16px 16px 12px; }
      .hist .foot { margin: 0; }
      .tbl-body .num b, .strong { font-weight: 600; }
      .muted-cell { color: var(--cqa-ink-3); }
      .note { display: inline-flex; align-items: center; gap: 8px; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
      .skeleton-cell { display: inline-block; width: 40px; height: 10px; border-radius: 4px; background: var(--cqa-surface-3); }
      .linkbtn { border: 0; background: transparent; padding: 0; font: inherit; color: var(--cqa-brand-deep); cursor: pointer; text-decoration: underline; font-variant-numeric: tabular-nums; }
      .linkbtn:hover { color: var(--cqa-ink); }
      .linkbtn[aria-current="true"] { font-weight: 600; color: var(--cqa-ink); }
      .banner { margin: 0 20px 12px; padding: 8px 12px; border-radius: 8px; background: var(--cqa-bad-bg); color: var(--cqa-bad); font-size: var(--cqa-fs-12); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .banner.top { margin: 16px 20px 0; padding: 10px 14px; font-size: var(--cqa-fs-13); align-items: flex-start; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
      .banner.top b { font-weight: 600; }
      .stop { white-space: nowrap; }
      .run-err { display: block; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--cqa-fs-12); color: var(--cqa-bad); }
      .fill { padding: 20px; }
    `;
  }

  async load() {
    const epoch = (this._epoch += 1);
    this._phase = "loading";
    this.stopPolling();
    this.renderNow();
    try {
      const [runs, datasets, checklists] = await Promise.all([api.listRuns({ limit: 50 }), api.listDatasets(), api.listChecklists()]);
      let models = [];
      let gap = false;
      try {
        models = await api.listModels();
      } catch (error) {
        if (error && error.code === "not_implemented") gap = true;
        else throw error;
      }
      if (epoch !== this._epoch) return;
      this._runs = runs;
      this._datasets = datasets;
      this._checklists = checklists;
      this._models = models;
      this._modelsGap = gap;
      this.initForm();
      this._phase = "ready";
      this._run = null;
      const wanted = this.getAttribute("run-id");
      const pick = (wanted && runs.find((r) => r.id === wanted || String(r.number) === wanted)) || runs.find((r) => runIsActive(r)) || runs[0] || null;
      this.renderNow();
      this.refreshEstimate();
      if (pick) await this.selectRun(pick.id, epoch);
    } catch (error) {
      if (epoch !== this._epoch) return;
      this._phase = "error";
      this._loadError = error;
      this.renderNow();
    }
  }

  initForm() {
    const f = this._form;
    if (!this._datasets.some((d) => d.groupId === f.groupId)) f.groupId = this._datasets.length ? this._datasets[0].groupId : "";
    const versions = savedVersionOptions(this._checklists);
    if (!versions.some((v) => v.id === f.versionId)) {
      const active = versions.find((v) => v.isDefault) || versions[0];
      f.versionId = active ? active.id : null;
    }
    if (!this._models.some((m) => m.id === f.modelId)) f.modelId = this._models.length ? this._models[0].id : null;
  }

  async selectRun(id, epochGuard = null) {
    const epoch = epochGuard === null ? (this._epoch += 1) : epochGuard;
    this.stopPolling();
    this._runLoading = true;
    this._pollError = false;
    this.renderPart();
    try {
      const run = await api.getRun(id, { limit: ITEMS_LIMIT });
      if (epoch !== this._epoch) return;
      this._run = run;
      this._runLoading = false;
      this.mergeRun(run);
      this.renderPart();
      this.schedulePoll();
    } catch (error) {
      if (epoch !== this._epoch) return;
      this._runLoading = false;
      this._pollError = true;
      this.renderPart();
    }
  }

  mergeRun(run) {
    const index = this._runs.findIndex((r) => r.id === run.id);
    if (index >= 0) this._runs[index] = { ...this._runs[index], ...run, items: [] };
    else this._runs.unshift({ ...run, items: [] });
  }

  stopPolling() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  schedulePoll() {
    this.stopPolling();
    if (!this.isConnected || !runIsActive(this._run)) return;
    this._timer = setTimeout(() => this.poll(), POLL_MS);
  }

  async poll() {
    this._timer = null;
    if (!this.isConnected || !this._run) return;
    const epoch = this._epoch;
    const id = this._run.id;
    try {
      const run = await api.getRun(id, { limit: ITEMS_LIMIT });
      if (epoch !== this._epoch) return;
      const wasActive = runIsActive(this._run);
      const previous = this._run.status;
      this._run = run;
      this._pollError = false;
      this.mergeRun(run);
      this.renderPart();
      if (previous === "cancelling" && run.status === "cancelled") this.toast(this.t("runs.cancel.done", { id: run.id }), "ok");
      if (wasActive && !runIsActive(run)) this.refreshRuns();
    } catch (error) {
      if (epoch !== this._epoch) return;
      this._pollError = true;
      this.renderPart();
      return;
    }
    this.schedulePoll();
  }

  async refreshRuns() {
    const epoch = this._epoch;
    try {
      const runs = await api.listRuns({ limit: 50 });
      if (epoch !== this._epoch) return;
      this._runs = runs;
      this.renderPart();
    } catch (error) {
      return;
    }
  }

  async refreshEstimate() {
    const f = this._form;
    const token = (this._estimateToken += 1);
    const count = this.estimateCount();
    if (count === null || this._modelsGap || !f.modelId) {
      f.estimate = null;
      this.scheduleRender();
      return;
    }
    const groupId = f.source === "api" ? this.activeGroup() : undefined;
    try {
      const result = await api.estimateRun({ groupId, model: f.modelId, count, versionId: f.versionId === null ? undefined : f.versionId, force: f.force });
      if (token !== this._estimateToken) return;
      f.estimate = { cost: result.cost, count: result.count };
    } catch (error) {
      if (token !== this._estimateToken) return;
      f.estimate = null;
    }
    this.scheduleRender();
  }

  activeGroup() {
    const f = this._form;
    const custom = f.customGroup.trim();
    return custom || f.groupId;
  }

  estimateCount() {
    const f = this._form;
    if (f.source === "file") return f.fileInfo ? f.fileInfo.count : null;
    const group = this.activeGroup();
    const found = this._datasets.find((d) => d.groupId === group);
    return found && found.conversations !== null ? found.conversations : null;
  }

  canStart() {
    const f = this._form;
    if (!can(this.role, "start-run") || f.starting) return false;
    if (f.versionId === null) return false;
    if (!f.modelId && !this._modelsGap) return false;
    if (f.source === "file") return Boolean(f.fileInfo);
    return Boolean(this.activeGroup());
  }

  async start() {
    const f = this._form;
    if (!this.canStart()) return;
    f.starting = true;
    f.startError = null;
    this.renderNow();
    try {
      const payload = { versionId: f.versionId, model: f.modelId || undefined, force: f.force };
      if (f.source === "file") payload.file = f.file;
      else payload.groupId = this.activeGroup();
      const run = await api.startRun(payload);
      f.starting = false;
      const epoch = (this._epoch += 1);
      this.stopPolling();
      this._run = run;
      this._runLoading = false;
      this._pollError = false;
      this.mergeRun(run);
      this.toast(this.t("runs.start.done", { id: run.id }), "ok");
      this.renderNow();
      this.schedulePoll();
      this.refreshAfterStart(epoch);
    } catch (error) {
      f.starting = false;
      f.startError = error;
      this.renderNow();
      this.toast(this.errorText(error, "start"), "bad");
    }
  }

  async refreshAfterStart(epoch) {
    try {
      const [runs, datasets] = await Promise.all([api.listRuns({ limit: 50 }), api.listDatasets()]);
      if (epoch !== this._epoch) return;
      this._runs = runs;
      this._datasets = datasets;
      this.renderNow();
    } catch (error) {
      return;
    }
  }

  async retryItem(conversationId) {
    if (!this._run) return;
    const epoch = this._epoch;
    try {
      const run = await api.retryRunItem(this._run.id, conversationId);
      if (epoch !== this._epoch) return;
      this._run = run;
      this._pollError = false;
      this.mergeRun(run);
      this.renderPart();
      const heading = this.shadowRoot.querySelector("[data-run-heading]");
      if (heading) heading.focus({ preventScroll: true });
      this.toast(this.t("runs.item.retried", { id: conversationId }), "ok");
      this.schedulePoll();
    } catch (error) {
      if (epoch !== this._epoch) return;
      this.toast(this.errorText(error), "bad");
    }
  }

  askConfirm(detail) {
    let node = this;
    let hasApp = false;
    while (node) {
      if (node.localName === "cqa-app") hasApp = true;
      node = node.parentNode || node.host || null;
    }
    if (!hasApp) return Promise.resolve(globalThis.confirm ? globalThis.confirm(`${detail.heading}. ${detail.description}`) : false);
    return new Promise((resolve) => emit(this, EVENTS.confirm, { ...detail, resolve }));
  }

  canCancel(run) {
    return runCanCancel(run) && can(this.role, "start-run") && run.status !== "cancelling" && !this._cancelBusy.has(run.id);
  }

  async cancelRunById(id) {
    const known = (this._run && this._run.id === id ? this._run : null) || this._runs.find((r) => r.id === id);
    if (!known || !this.canCancel(known)) return;
    const ok = await this.askConfirm({
      heading: this.t("runs.cancel.title", { id }),
      description: this.t("runs.cancel.text"),
      confirmLabel: this.t("runs.cancel.confirm"),
      cancelLabel: this.t("runs.cancel.keep")
    });
    if (!ok) return;
    const epoch = this._epoch;
    this._cancelBusy.add(id);
    this.renderPart();
    try {
      const run = await api.cancelRun(id);
      this._cancelBusy.delete(id);
      if (epoch !== this._epoch) return;
      if (this._run && this._run.id === id) this._run = { ...run, items: this._run.items, itemsTotal: this._run.itemsTotal };
      this.mergeRun(run);
      this.renderPart();
      this.toast(this.t(run.status === "cancelled" ? "runs.cancel.done" : "runs.cancel.started", { id }), "ok");
      this.schedulePoll();
    } catch (error) {
      this._cancelBusy.delete(id);
      if (epoch !== this._epoch) return;
      this.renderPart();
      const outcome = cancelOutcome(error);
      if (outcome === "finished") this.toast(this.t("runs.cancel.finished"), "ok");
      else this.toast(this.errorText(error), "bad");
      if (outcome !== "failed") this.refreshAfterCancel(id);
    }
  }

  async refreshAfterCancel(id) {
    const epoch = this._epoch;
    try {
      const [runs, run] = await Promise.all([api.listRuns({ limit: 50 }), this._run && this._run.id === id ? api.getRun(id, { limit: ITEMS_LIMIT }) : Promise.resolve(null)]);
      if (epoch !== this._epoch) return;
      this._runs = runs;
      if (run) {
        this._run = run;
        this.mergeRun(run);
        this.schedulePoll();
      }
      this.renderPart();
    } catch (error) {
      return;
    }
  }

  errorText(error, scope = "") {
    const key = errorKey(error);
    if (key === "generic" && scope === "start") return `${this.t("runs.error.start")} (${error && error.code ? error.code : "error"})`;
    return this.t(`runs.error.${key}`, { gap: error && error.gap ? error.gap : "", detail: error && error.message ? error.message : "" });
  }

  toast(message, tone) {
    emit(this, EVENTS.toast, { message, tone });
  }

  onClick(event) {
    const link = event.target.closest ? event.target.closest("a[data-conversation]") : null;
    if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      navigate(this, "conversations", link.getAttribute("data-conversation") || null);
      return;
    }
    const target = event.target.closest("[data-action]");
    if (!target || !this.shadowRoot.contains(target)) return;
    const action = target.getAttribute("data-action");
    const f = this._form;
    if (action === "source") {
      f.source = target.getAttribute("data-value");
      this.renderNow();
      this.refreshEstimate();
    } else if (action === "choose-file") {
      const input = this.shadowRoot.querySelector("[data-file]");
      if (input) input.click();
    } else if (action === "remove-file") {
      f.file = null;
      f.fileInfo = null;
      f.fileError = null;
      this.renderNow();
      this.refreshEstimate();
    } else if (action === "start") {
      this.start();
    } else if (action === "cancel-run") {
      this.cancelRunById(target.getAttribute("data-id"));
    } else if (action === "retry-item") {
      this.retryItem(target.getAttribute("data-id"));
    } else if (action === "open-run") {
      this.selectRun(target.getAttribute("data-id"));
    } else if (action === "retry") {
      this.load();
    } else if (action === "retry-poll") {
      this._pollError = false;
      this.renderPart();
      this.poll();
    }
  }

  onChange(event) {
    const el = event.target;
    const field = el.getAttribute && el.getAttribute("data-field");
    const f = this._form;
    if (!field) return;
    if (field === "group") {
      f.groupId = el.value;
      f.customGroup = "";
      this.renderNow();
      this.refreshEstimate();
    } else if (field === "version") {
      f.versionId = Number(el.value);
      this.renderNow();
      this.refreshEstimate();
    } else if (field === "model") {
      f.modelId = el.value;
      this.renderNow();
      this.refreshEstimate();
    } else if (field === "force") {
      f.force = el.checked;
      this.renderNow();
      this.refreshEstimate();
    } else if (field === "file") {
      const file = el.files && el.files[0];
      el.value = "";
      if (file) this.acceptFile(file);
    }
  }

  onInput(event) {
    const el = event.target;
    if (el.getAttribute && el.getAttribute("data-field") === "custom") {
      this._form.customGroup = el.value;
      this.scheduleRender();
      this.refreshEstimate();
    }
  }

  onDrag(event, over) {
    if (!event.target.closest || !event.target.closest("[data-drop]")) return;
    event.preventDefault();
    if (this._form.dragging !== over) {
      this._form.dragging = over;
      const zone = this.shadowRoot.querySelector("[data-drop]");
      if (zone) zone.classList.toggle("over", over);
      const text = this.shadowRoot.querySelector("[data-drop-text]");
      if (text) text.textContent = over ? this.t("runs.drop.active") : this.t("runs.drop.text");
    }
  }

  onDrop(event) {
    if (!event.target.closest || !event.target.closest("[data-drop]")) return;
    event.preventDefault();
    this._form.dragging = false;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) this.acceptFile(file);
    else this.renderNow();
  }

  async acceptFile(file) {
    const f = this._form;
    f.source = "file";
    f.file = null;
    f.fileInfo = null;
    f.fileError = null;
    if (!isJsonFile(file)) {
      f.fileError = { code: "type", params: {} };
    } else {
      try {
        const text = await file.text();
        const result = validateDatasetText(text);
        if (result.ok) {
          f.file = file;
          f.fileInfo = { name: file.name, count: result.count };
        } else {
          f.fileError = { code: result.code, params: result.params };
        }
      } catch (error) {
        f.fileError = { code: "read", params: {} };
      }
    }
    this.renderNow();
    this.refreshEstimate();
  }

  renderPart() {
    if (!this._ready) return;
    const cur = this.shadowRoot.querySelector("[data-current]");
    const hist = this.shadowRoot.querySelector("[data-history]");
    if (!cur || !hist) {
      this.scheduleRender();
      return;
    }
    const active = this.shadowRoot.activeElement;
    const focusKey = active && active.getAttribute ? active.getAttribute("data-focus-id") : null;
    cur.innerHTML = String(this.currentSection());
    hist.innerHTML = String(this.historySection());
    if (focusKey && active && !active.isConnected) {
      const target = this.shadowRoot.querySelector(`[data-focus-id="${focusKey.replace(/"/g, '\\"')}"]`);
      if (target) target.focus({ preventScroll: true });
    }
  }

  template() {
    if (this._phase === "loading") {
      return html`<div class="screen"><h1>${this.t("runs.title")}</h1>${loadingPanel(this.locale)}</div>`;
    }
    if (this._phase === "error") {
      return html`<div class="screen"><h1>${this.t("runs.title")}</h1>${errorPanel(this.locale, { title: this.t("runs.error.title") })}</div>`;
    }
    return html`<div class="screen"><h1>${this.t("runs.title")}</h1>
      <div class="grid">${this.formSection()}<div class="cur-wrap" data-current>${this.currentSection()}</div></div>
      <section class="card hist" aria-labelledby="hist-h" data-history>${this.historySection()}</section>
    </div>`;
  }

  formSection() {
    const f = this._form;
    const locale = this.locale;
    const allowed = can(this.role, "start-run");
    const versions = savedVersionOptions(this._checklists);
    const source = (value, label) => html`<button type="button" data-action="source" data-value="${value}" data-focus-id="source-${value}" aria-pressed="${String(f.source === value)}">${label}</button>`;

    const datasetOptions = this._datasets.map((d) => {
      const name = d.label && d.label !== d.groupId ? `${d.groupId} - ${d.label}` : d.groupId;
      const count = d.conversations === null ? "" : ` · ${this.t("count.conversations", { count: d.conversations })}`;
      const selected = d.groupId === f.groupId && !f.customGroup.trim();
      return html`<option value="${d.groupId}" ${raw(selected ? "selected" : "")}>${name}${count}</option>`;
    });
    const datasetBlock =
      f.source === "api"
        ? html`<label class="lbl">${this.t("runs.dataset.label")}
            <select class="field" data-field="group" data-focus-id="group" ${raw(this._datasets.length ? "" : "disabled")}>
              ${this._datasets.length ? datasetOptions : html`<option value="">${this.t("runs.dataset.none")}</option>`}
            </select></label>
          <label class="lbl">${this.t("runs.dataset.custom")}
            <input class="field" type="text" data-field="custom" data-focus-id="custom" value="${f.customGroup}" autocomplete="off" spellcheck="false"></label>`
        : html``;

    let fileLine = html``;
    if (f.fileInfo) {
      fileLine = html`<p class="file-line">${chip({ tone: "ok", text: this.t("runs.file.ready", { name: f.fileInfo.name, count: this.t("count.conversations", { count: f.fileInfo.count }) }) })}<button type="button" class="btn btn-sm btn-ghost" data-action="remove-file" data-focus-id="remove-file">${icon("close", 12)}${this.t("runs.file.remove")}</button></p>`;
    } else if (f.fileError) {
      fileLine = html`<p class="msg-bad" role="alert">${this.t(`runs.file.err.${f.fileError.code}`, f.fileError.params)}</p>`;
    }

    const versionSelect = versions.length
      ? html`<select class="field" data-field="version" data-focus-id="version">${versions.map((v) => {
          const parts = [v.checklistName ? `${v.checklistName} ${v.label}` : v.label];
          parts.push(v.isDefault ? this.t("runs.version.active") : this.t("runs.version.saved", { date: wallDateTime(v.createdAt, locale, false) }));
          return html`<option value="${v.id}" ${raw(v.id === f.versionId ? "selected" : "")}>${parts.join(" - ")}</option>`;
        })}</select>`
      : html`<select class="field" disabled data-focus-id="version"><option>${this.t("runs.version.none")}</option></select>`;

    let modelSelect;
    if (this._modelsGap) {
      modelSelect = html`<select class="field" disabled data-focus-id="model"><option>${this.t("runs.model.server")}</option></select><p class="hint" data-gap="BG-18">${this.t("runs.model.gap")}</p>`;
    } else {
      modelSelect = html`<select class="field" data-field="model" data-focus-id="model">${this._models.map((m) => {
        const text = m.paid
          ? `${m.label} · ${this.t("runs.model.paid")} · ≈ ${number(m.pricePerEvaluation, locale, 3)} $ ${this.t("runs.model.perDialog")}`
          : `${m.label} · ${this.t("runs.model.free")} · ${this.t("runs.model.lowerAccuracy")}`;
        return html`<option value="${m.id}" ${raw(m.id === f.modelId ? "selected" : "")}>${text}</option>`;
      })}</select>`;
    }

    const estimate = f.estimate ? `≈ ${number(f.estimate.cost, locale, 2)} $` : this._modelsGap ? this.t("runs.estimate.none") : "—";
    const startLabel = f.starting ? this.t("runs.starting") : this.t("runs.start");
    const startError = f.startError ? html`<p class="msg-bad" role="alert">${this.errorText(f.startError, "start")}</p>` : html``;
    const roleHint = allowed ? html`` : html`<p class="hint" data-role-hint>${this.t("runs.start.roleHint")}</p>`;

    return html`<section class="card form" aria-labelledby="new-h">
      <h2 id="new-h">${this.t("runs.new.title")}</h2>
      <div class="seg" role="group" aria-label="${this.t("runs.source.label")}">${source("api", this.t("runs.source.api"))}${source("file", this.t("runs.source.file"))}</div>
      ${datasetBlock}
      <div class="drop${f.dragging ? " over" : ""}" data-drop role="group" aria-label="${this.t("runs.drop.label")}">
        ${raw(UPLOAD_ICON)}
        <span class="drop-text"><span data-drop-text>${this.t("runs.drop.text")}</span> <code>conversation_id · channel · language · transcript</code></span>
        <button type="button" class="btn btn-sm" data-action="choose-file" data-focus-id="choose-file">${this.t("runs.drop.choose")}</button>
        <input type="file" hidden accept=".json,application/json" data-field="file" aria-label="${this.t("runs.drop.choose")}">
      </div>
      ${fileLine}
      <label class="lbl">${this.t("runs.version.label")}${versionSelect}</label>
      <label class="lbl">${this.t("runs.model.label")}${modelSelect}</label>
      <label class="check"><input type="checkbox" data-field="force" data-focus-id="force" ${raw(f.force ? "checked" : "")}>${this.t("runs.force")}</label>
      <div class="row-between"><span>${this.t("runs.estimate.label")}</span><b data-estimate>${estimate}</b></div>
      <button type="button" class="btn btn-primary" data-action="start" data-focus-id="start" ${raw(this.canStart() ? "" : "disabled")}>${startLabel}</button>
      ${startError}${roleHint}
      <p class="hint">${this.t("runs.adapterNote")}</p>
    </section>`;
  }

  statusChip(run) {
    const status = run.status;
    if (status === "running" || status === "cancelling") return html`<span class="chip c-warn" data-run-status="${status}"><span class="dot"></span>${this.t(`runs.run.${status}`)}</span>`;
    if (status === "completed") return html`<span class="chip c-ok" data-run-status="completed">${this.t("runs.run.completed")}</span>`;
    if (status === "failed") return html`<span class="chip c-bad" data-run-status="failed">${this.t("runs.run.failed")}</span>`;
    if (status === "queued" || status === "cancelled" || status === "interrupted") return html`<span class="chip c-na" data-run-status="${status}">${this.t(`runs.run.${status}`)}</span>`;
    return html`<span class="chip c-na" data-run-status="${status}">${this.t("runs.run.failed")}</span>`;
  }

  stopButton(run, compact) {
    if (!runCanCancel(run)) return html``;
    const busy = this._cancelBusy.has(run.id) || run.status === "cancelling";
    const allowed = can(this.role, "start-run");
    const label = busy ? this.t("runs.cancel.busy") : this.t("runs.cancel");
    return html`<button type="button" class="btn btn-sm stop${compact ? " btn-ghost" : ""}" data-action="cancel-run" data-id="${run.id}" data-focus-id="${compact ? "stop-row-" : "stop-"}${run.id}" aria-label="${this.t("runs.cancel.for", { id: run.id })}" ${raw(allowed && !busy ? "" : "disabled")}>${icon("close", 12)}${label}</button>`;
  }

  currentSection() {
    const locale = this.locale;
    if (this._runLoading) return loadingPanel(locale);
    if (!this._run) {
      if (this._pollError) return errorPanel(locale, { title: this.t("runs.error.title"), message: this.t("runs.error.poll") });
      return emptyPanel(locale, { title: this.t("runs.empty.title"), hint: this.t("runs.empty.hint") });
    }
    const run = this._run;
    const seg = progressSegments(run);
    const active = runIsActive(run);
    const meta = [run.datasetLabel, run.versionLabel, run.model].filter(Boolean).join(" · ");
    let time = "";
    if (run.elapsedSeconds !== null) {
      time = active
        ? [this.t("runs.run.elapsed", { elapsed: duration(run.elapsedSeconds) }), run.etaSeconds !== null ? this.t("runs.run.eta", { eta: duration(run.etaSeconds) }) : ""].filter(Boolean).join(" · ")
        : this.t("runs.run.took", { elapsed: duration(run.elapsedSeconds) });
    }
    const spent = run.cost !== null ? this.t("runs.run.spent", { cost: number(run.cost, locale, 2) }) : this.t("runs.run.spentNone");
    const banner = this._pollError
      ? html`<p class="banner" role="alert">${this.t("runs.error.poll")}<button type="button" class="btn btn-sm" data-action="retry-poll" data-focus-id="retry-poll">${icon("retry", 12)}${this.t("action.retry")}</button></p>`
      : html``;
    const queued = queuedCount(run);
    const errorBanner = run.error ? html`<div class="banner top" role="alert" data-run-error><b>${this.t("runs.run.errorLabel")}</b><span data-run-error-text>${run.error}</span></div>` : html``;
    return html`<section class="card cur" aria-labelledby="cur-h" data-run="${run.id}">
      ${errorBanner}
      <div class="head">
        <div class="head-top">
          <h2 id="cur-h" tabindex="-1" data-run-heading>${this.t("runs.run.title", { id: run.id })}</h2>
          ${this.statusChip(run)}
          <span class="meta">${meta}</span>
          <span class="time" data-time>${time}</span>
          ${this.stopButton(run, false)}
        </div>
        <div class="bar" role="progressbar" aria-label="${this.t("runs.run.progress")}" aria-valuemin="0" aria-valuemax="${seg.max}" aria-valuenow="${seg.now}">
          <span class="seg-done" style="width:${seg.done}%"></span><span class="seg-failed" style="width:${seg.failed}%"></span><span class="seg-run" style="width:${seg.running}%"></span>${run.cancelled ? html`<span class="seg-cancel" style="width:${cancelledPercent(run)}%"></span>` : html``}
        </div>
        <div class="counters">
          <span data-count="done"><b>${integer(run.done, locale)}</b> ${this.t("runs.counter.done")}</span>
          <span data-count="running"><b>${integer(run.running, locale)}</b> ${this.t("runs.counter.running")}</span>
          <span data-count="queued"><b>${integer(queued, locale)}</b> ${this.t("runs.counter.queued")}</span>
          <span class="bad" data-count="failed"><b>${integer(run.failed, locale)}</b> ${this.t("runs.counter.failed")}</span>
          ${run.cancelled ? html`<span class="muted" data-count="cancelled"><b>${integer(run.cancelled, locale)}</b> ${this.t("runs.counter.cancelled")}</span>` : html``}
          <span class="spent" data-spent>${spent}</span>
        </div>
      </div>
      ${banner}
      ${this.itemsTable(run)}
    </section>`;
  }

  itemsTable(run) {
    const locale = this.locale;
    const allowed = can(this.role, "start-run");
    if (!run.items.length) {
      return html`<p class="foot" data-no-items>${this.t("runs.items.none")}</p>`;
    }
    const otherLabel = otherVersionLabel(run, this._checklists);
    const link = (item) => {
      const kind = itemKind(item);
      if (kind === "done" || kind === "lowConfidence") return html`<a class="tnum" href="#/conversations/${encodeURIComponent(item.conversationId)}" data-conversation="${item.conversationId}">${item.conversationId}</a>`;
      return html`<span class="tnum">${item.conversationId}</span>`;
    };
    const columns = [
      { key: "id", label: this.t("runs.col.conversation"), width: "minmax(130px, 1.1fr)", minPx: 130, cell: link },
      { key: "lang", label: this.t("runs.col.language"), width: "52px", minPx: 52, cell: (i) => langChip(i.language) },
      { key: "channel", label: this.t("runs.col.channel"), width: "68px", minPx: 68, cell: (i) => (i.channel ? this.t(`runs.channel.${i.channel}`) : "—") },
      {
        key: "status",
        label: this.t("runs.col.status"),
        width: "164px",
        minPx: 164,
        cell: (i) => {
          const kind = itemKind(i);
          return html`<span data-item-status="${kind}">${chip({ tone: ITEM_TONE[kind], text: this.t(`runs.item.${kind}`) })}</span>`;
        }
      },
      {
        key: "time",
        label: this.t("runs.col.time"),
        width: "66px",
        minPx: 66,
        cell: (i) => (i.latencyMs === null || itemKind(i) === "queued" || itemKind(i) === "cancelled" ? html`<span class="muted-cell">—</span>` : html`<span class="tnum">${this.t("runs.seconds", { value: number(i.latencyMs / 1000, locale, 1) })}</span>`)
      },
      {
        key: "total",
        label: this.t("runs.col.total"),
        width: "70px",
        minPx: 70,
        align: "num",
        cell: (i) => {
          const kind = itemKind(i);
          if (kind === "running") return html`<span class="skeleton-cell" aria-hidden="true"></span>`;
          if (i.total === null || kind === "failed" || kind === "queued" || kind === "cancelled") return html`<span class="muted-cell">—</span>`;
          return html`<span class="strong" data-total>${number(i.total, locale, 2)}</span>`;
        }
      },
      {
        key: "note",
        label: this.t("runs.col.note"),
        width: "minmax(250px, 1.6fr)",
        minPx: 250,
        cell: (i) => this.noteCell(i, otherLabel, allowed)
      }
    ];
    const shown = run.items.length;
    return html`${dataTable({ label: this.t("runs.items.label"), columns, rows: run.items, rowId: (i) => i.conversationId }, locale)}
      <div class="foot">${this.t("runs.items.shown", { shown: integer(shown, locale), total: integer(Math.max(run.total, shown), locale) })} · <a href="#/conversations" data-conversation="">${this.t("runs.items.all")}</a></div>`;
  }

  noteCell(item, otherLabel, allowed) {
    const locale = this.locale;
    const kind = itemKind(item);
    const parts = [];
    if (kind === "failed") {
      parts.push(html`<span class="note"><span data-reason>${item.error || this.t("runs.item.noReason")}</span><button type="button" class="btn btn-sm" data-action="retry-item" data-id="${item.conversationId}" data-focus-id="retry-${item.conversationId}" aria-label="${this.t("runs.item.retryFor", { id: item.conversationId })}" ${raw(allowed ? "" : "disabled")}>${icon("retry", 14)}${this.t("action.retry")}</button></span>`);
    }
    if (kind === "lowConfidence") parts.push(html`<span class="note">${this.t("runs.item.needsQa")}</span>`);
    if (kind === "cancelled") parts.push(html`<span class="note muted-cell" data-skipped>${this.t("runs.item.cancelled")}</span>`);
    if (item.gross && (kind === "done" || kind === "lowConfidence")) parts.push(chip({ tone: "crit", text: this.t("runs.item.gross") }));
    if (item.otherVersionTotal !== null && (kind === "done" || kind === "lowConfidence")) {
      const total = number(item.otherVersionTotal, locale, 2);
      const text = otherLabel ? this.t("runs.item.otherVersion", { version: otherLabel, total }) : this.t("runs.item.otherVersionUnknown", { total });
      parts.push(html`<span class="note" data-other-version>${text}</span>`);
    }
    return html`<span class="note">${parts}</span>`;
  }

  historySection() {
    const locale = this.locale;
    const current = this._run ? this._run.id : null;
    const head = html`<h2 id="hist-h">${this.t("runs.history.title")}</h2>`;
    if (!this._runs.length) {
      return html`${head}<div class="fill">${emptyPanel(locale, { title: this.t("runs.empty.title"), hint: this.t("runs.empty.hint") })}</div>`;
    }
    const columns = [
      {
        key: "run",
        label: this.t("runs.hcol.run"),
        width: "84px",
        minPx: 84,
        cell: (r) => html`<button type="button" class="linkbtn" data-action="open-run" data-id="${r.id}" data-focus-id="open-${r.id}" aria-current="${String(r.id === current)}" aria-label="${this.t("runs.history.open", { id: r.id })}">${r.id}</button>`
      },
      { key: "dataset", label: this.t("runs.hcol.dataset"), width: "minmax(120px, 1.2fr)", minPx: 120, cell: (r) => r.datasetLabel || r.groupId || "—" },
      {
        key: "checklist",
        label: this.t("runs.hcol.checklist"),
        width: "68px",
        minPx: 68,
        cell: (r) => (r.versionLabel ? chip({ tone: r.id === current ? "brand" : "na", text: r.versionLabel }) : html`<span class="muted-cell">—</span>`)
      },
      { key: "model", label: this.t("runs.hcol.model"), width: "minmax(120px, 1fr)", minPx: 120, cell: (r) => r.model || "—" },
      {
        key: "count",
        label: this.t("runs.hcol.count"),
        width: "92px",
        minPx: 92,
        align: "num",
        cell: (r) => (runIsActive(r) ? `${integer(r.processed, locale)} / ${integer(r.total, locale)}` : integer(r.total, locale))
      },
      {
        key: "average",
        label: this.t("runs.hcol.average"),
        width: "112px",
        minPx: 112,
        align: "num",
        cell: (r) => (runIsActive(r) ? html`<span class="muted-cell">${this.t("runs.history.running")}</span>` : r.averageTotal === null ? html`<span class="muted-cell">—</span>` : html`<span class="strong">${number(r.averageTotal, locale, 2)}</span>`)
      },
      { key: "date", label: this.t("runs.hcol.date"), width: "136px", minPx: 136, cell: (r) => html`<span class="tnum">${wallDateTime(r.startedAt, locale)}</span>` },
      {
        key: "status",
        label: this.t("runs.hcol.status"),
        width: "minmax(150px, 1fr)",
        minPx: 150,
        cell: (r) => html`<span title="${r.error || ""}" data-history-status="${r.status}">${raw(String(this.statusChip(r)).replace(" data-run-status=", " data-hist-status="))}${r.error ? html`<span class="run-err" data-run-error-line>${r.error}</span>` : html``}</span>`
      },
      { key: "actions", label: this.t("runs.hcol.actions"), width: "112px", minPx: 112, cell: (r) => this.stopButton(r, true) }
    ];
    return html`${head}${dataTable({ label: this.t("runs.history.label"), columns, rows: this._runs, rowId: (r) => r.id }, locale)}<p class="foot">${this.t("runs.history.note")}</p>`;
  }
}

