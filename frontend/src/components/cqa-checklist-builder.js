import { CqaElement, html } from "../base-element.js";
import { api } from "../api.js";
import { EVENTS, emit, navigate } from "../events.js";
import { integer } from "../format.js";
import { can } from "../roles.js";
import { SHARED_CSS } from "../shared/styles.js";
import { emptyPanel, errorPanel, loadingPanel } from "../shared/state-panel.js";
import { addCriterion, changedCount, createDraft, moveCriterion, removeCriterion, reset, setNaCondition, setType, toConfig } from "./builder-model.js";
import { validate } from "./builder-validate.js";
import { computePreview } from "./builder-preview.js";
import { alertBox, channelKind, editor, preview, sidebar, structure, topBar } from "./builder-views.js";

export const BUILDER_EVENTS = Object.freeze({
  change: "cqa:builder-change",
  saved: "cqa:builder-saved",
  applied: "cqa:builder-applied"
});

const KNOWN_ERRORS = new Set(["role_forbidden", "draft_version", "dataset_required", "not_implemented", "http_409", "http_404"]);
const CHANNEL_RAW = { chat: "agent chat", call: "voice call" };

const REGIONS = ["bar", "alert", "structure", "editor", "preview", "side"];

const CSS = `${SHARED_CSS}
  :host { display: block; font-size: var(--cqa-fs-14); color: var(--cqa-ink); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .dim { color: var(--cqa-ink-3); }
  .dim12 { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
  .r { text-align: right; }
  .bold { font-weight: 500; }
  .page { display: flex; flex-direction: column; gap: 16px; }
  .bar { padding: 14px 16px; }
  .bar-in { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .h1 { margin: 0; font-size: var(--cqa-fs-20); font-weight: 600; overflow-wrap: anywhere; }
  .h2 { margin: 0; font-size: var(--cqa-fs-16); font-weight: 600; }
  .h3 { margin: 0; font-size: var(--cqa-fs-14); font-weight: 600; }
  .meta { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
  .sum { font-size: var(--cqa-fs-13); font-weight: 600; padding: 4px 10px; border-radius: 8px; }
  .sum-ok { background: var(--cqa-ok-bg); color: var(--cqa-ok); }
  .sum-warn { background: var(--cqa-warn-bg); color: var(--cqa-warn); }
  .sum-bad { background: var(--cqa-bad-bg); color: var(--cqa-bad); }
  .actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
  .chans { border: 0; margin: 0; padding: 4px 12px 8px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .chans legend { padding: 0; }
  .chan { display: flex; align-items: center; gap: 8px; font-size: var(--cqa-fs-13); cursor: pointer; }
  .chan input { accent-color: var(--cqa-brand-strong); }
  .btn-apply { border-color: var(--cqa-brand-strong); color: var(--cqa-brand-deep); }
  .reason { flex-basis: 100%; margin: 0; font-size: var(--cqa-fs-12); color: var(--cqa-warn); }
  .reason:empty { display: none; }
  main.layout { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  aside.side { flex: 0 1 260px; min-width: 220px; padding: 12px; display: flex; flex-direction: column; gap: 4px; }
  section.structure { flex: 1 1 520px; min-width: 0; overflow: hidden; }
  section.right { flex: 1 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .side-block { display: flex; flex-direction: column; gap: 4px; }
  .side-block + .side-block { border-top: 1px solid var(--cqa-line); margin-top: 8px; padding-top: 4px; }
  .side-t { font-size: var(--cqa-fs-12); font-weight: 600; color: var(--cqa-ink-3); padding: 4px 12px; text-transform: uppercase; letter-spacing: .04em; text-align: left; }
  .side-link { border: 0; background: transparent; cursor: pointer; font-family: var(--cqa-font); border-radius: 6px; }
  .side-link:hover { color: var(--cqa-ink); background: var(--cqa-surface-2); }
  .vrow { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; border: 1px solid transparent; }
  .vedit { background: var(--cqa-brand-tint); border-color: var(--cqa-brand); }
  .vline { display: flex; align-items: center; gap: 6px; }
  .vline b { font-weight: 600; }
  .lockic { color: var(--cqa-ink-3); }
  .sub2 { font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); }
  .dup, .newc { align-self: flex-start; margin-top: 4px; }
  .newc { margin-top: 8px; }
  .alert { margin: 12px 16px 0; padding: 10px 12px; border-radius: 8px; background: var(--cqa-bad-bg); color: var(--cqa-bad); font-size: var(--cqa-fs-13); display: flex; flex-direction: column; gap: 2px; }
  .crow { display: grid; grid-template-columns: 28px minmax(0, 1fr) 112px 72px 60px 32px; gap: 10px; align-items: center; padding: 6px 16px; min-height: 48px; border-top: 1px solid var(--cqa-line); }
  .crow.chead { border-top: 0; min-height: 40px; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
  .crow.sel { background: var(--cqa-brand-tint); box-shadow: inset 3px 0 0 var(--cqa-brand); }
  .pick { min-width: 0; text-align: left; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 2px; border-radius: 6px; }
  .pick .nm { font-weight: 500; font-size: var(--cqa-fs-14); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; overflow-wrap: anywhere; }
  .pick .nm .chip { height: 18px; }
  .pick .ds { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl { font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); }
  .noPts { text-align: right; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
  .wf { width: 100%; min-width: 0; text-align: right; height: 30px; }
  .mv { display: flex; }
  .ib { padding: 0; width: 28px; justify-content: center; }
  .sech { display: flex; align-items: center; gap: 8px; padding: 14px 16px 8px; border-top: 1px solid var(--cqa-line); background: var(--cqa-surface-2); }
  .sech-t { margin: 0; font-size: var(--cqa-fs-12); font-weight: 600; color: var(--cqa-ink-2); text-transform: uppercase; letter-spacing: .04em; }
  .addc { margin-left: auto; height: 24px; }
  cqa-scale-step-editor { background: transparent; }
  .edit { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .ed-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .lbl { display: flex; flex-direction: column; gap: 6px; font-size: var(--cqa-fs-12); font-weight: 500; color: var(--cqa-ink-2); }
  .lbl .field { width: 100%; font-weight: 400; }
  textarea.field { height: auto; min-height: 76px; padding: 8px 10px; line-height: 1.45; resize: vertical; }
  .field:disabled { background: var(--cqa-surface-2); color: var(--cqa-ink-3); }
  .field[aria-invalid="true"] { border-color: var(--cqa-bad); }
  .two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .lbl-t { font-size: var(--cqa-fs-12); font-weight: 500; color: var(--cqa-ink-2); }
  .rosteps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: var(--cqa-fs-13); }
  .rosteps li { display: grid; grid-template-columns: 56px minmax(0, 1fr) 72px; gap: 8px; }
  .pv { overflow: hidden; }
  .pv-h { padding: 12px 14px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .lrow { display: grid; grid-template-columns: minmax(0, 1fr) 64px 48px 60px 60px; gap: 6px; align-items: center; padding: 0 14px; min-height: 30px; border-top: 1px solid var(--cqa-line); font-size: var(--cqa-fs-12); }
  .lrow > span:nth-child(n+3) { text-align: right; font-variant-numeric: tabular-nums; }
  .lrow.lhead { color: var(--cqa-ink-3); }
  .lrow.na { color: var(--cqa-ink-3); }
  .lrow.sel { background: var(--cqa-brand-tint); }
  .lrow .strike { text-decoration: line-through; color: var(--cqa-ink-3); }
  .lrow .clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lrow.ltotal { min-height: 40px; border-top: 2px solid var(--cqa-ink); }
  .totnum { font-weight: 700; font-size: var(--cqa-fs-15, 15px); white-space: nowrap; }
  .pv-note { margin: 0; padding: 10px 14px 14px; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
  @container (max-width: 1099px) {
    aside.side { flex: 1 1 100%; }
    .lrow { grid-template-columns: minmax(0, 1fr) 72px 48px 56px 56px; }
  }
  @container (max-width: 640px) {
    .crow { grid-template-columns: 24px minmax(0, 1fr) 64px 60px 32px; }
    .crow .tl, .crow.chead span:nth-child(3) { display: none; }
    .crow .mv { grid-column: 2 / 4; grid-row: 2; }
    .two { grid-template-columns: minmax(0, 1fr); }
  }
`;

export class CqaChecklistBuilder extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "checklist-id"];
  }

  constructor() {
    super();
    this._phase = "loading";
    this._error = null;
    this._token = 0;
    this._status = "draft";
    this._lists = [];
    this._current = null;
    this._draft = null;
    this._baseConfig = null;
    this._selected = null;
    this._bound = false;
    this._view = null;
    this._dirty = false;
    this._busy = null;
    this._saveError = null;
    this._onNavCapture = (event) => this.guardNavigation(event);
    this._onBeforeUnload = (event) => {
      if (!this._dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
  }

  get dirty() {
    return this._dirty;
  }

  get busy() {
    return this._busy !== null;
  }

  get locked() {
    return this._status === "applied";
  }

  get roleReadOnly() {
    return !can(this.role, "edit-checklist");
  }

  get status() {
    return this._status;
  }

  set status(value) {
    this._status = ["draft", "saved", "applied"].includes(value) ? value : "draft";
    if (this._draft) this.refreshAll({ editor: false });
  }

  get draft() {
    return this._draft;
  }

  get valid() {
    return Boolean(this._view && this._view.validation.valid);
  }

  get readOnly() {
    return this.roleReadOnly || this.locked;
  }

  getConfig() {
    return this._draft ? toConfig(this._draft) : null;
  }

  styles() {
    return CSS;
  }

  onReady() {
    window.addEventListener(EVENTS.navigate, this._onNavCapture, true);
    window.addEventListener("beforeunload", this._onBeforeUnload);
    this.load();
  }

  disconnectedCallback() {
    window.removeEventListener(EVENTS.navigate, this._onNavCapture, true);
    window.removeEventListener("beforeunload", this._onBeforeUnload);
    super.disconnectedCallback();
  }

  guardNavigation(event) {
    const detail = event.detail || {};
    if (!this._dirty || detail.guarded) return;
    const stays = detail.to === "checklists" && (!detail.id || (this._current && String(detail.id) === String(this._current.id)));
    if (stays) return;
    event.stopImmediatePropagation();
    this.confirmLeave().then((ok) => {
      if (!ok) return;
      this._dirty = false;
      this.dispatchEvent(new CustomEvent(EVENTS.navigate, { detail: { ...detail, guarded: true }, bubbles: true, composed: true }));
    });
  }

  confirmLeave() {
    if (!this._dirty) return Promise.resolve(true);
    const t = (key) => this.t(key);
    let node = this;
    let hasApp = false;
    while (node) {
      if (node.localName === "cqa-app") hasApp = true;
      node = node.parentNode || node.host || null;
    }
    if (!hasApp) return Promise.resolve(window.confirm(`${t("builder.confirm.heading")}. ${t("builder.confirm.description")}`));
    return new Promise((resolve) => {
      emit(this, EVENTS.confirm, {
        heading: t("builder.confirm.heading"),
        description: t("builder.confirm.description"),
        confirmLabel: t("builder.confirm.leave"),
        cancelLabel: t("builder.confirm.stay"),
        resolve
      });
    });
  }

  toast(message, tone = "ok", action = null) {
    emit(this, EVENTS.toast, { message, tone, action });
  }

  errorMessage(error, nothingSaved) {
    const code = error && error.code ? String(error.code) : "";
    const status = error && error.status ? Number(error.status) : 0;
    let text;
    if (KNOWN_ERRORS.has(code)) text = this.t(`builder.err.${code}`, { gap: error.gap || "" });
    else if (status === 422 || status === 400) text = this.t("builder.err.validation", { detail: error.message || code });
    else text = this.t("builder.err.generic");
    return nothingSaved ? `${text} ${this.t("builder.err.nothingSaved")}` : text;
  }

  attributeChangedCallback(name, previous, next) {
    if (name === "checklist-id") {
      if (this._ready && previous !== next) this.load();
      return;
    }
    super.attributeChangedCallback(name, previous, next);
  }

  async load() {
    const token = (this._token += 1);
    this._phase = "loading";
    this._dirty = false;
    this._busy = null;
    this._saveError = null;
    this.renderNow();
    try {
      const lists = await api.listChecklists();
      if (token !== this._token) return;
      const wanted = this.getAttribute("checklist-id");
      const current = wanted ? lists.find((c) => String(c.id) === String(wanted)) : lists[0];
      this._lists = lists;
      if (!current) {
        this._phase = "notfound";
        this.renderNow();
        return;
      }
      if (current.versions.length === 0) {
        this._current = current;
        this._phase = "noversions";
        this.renderNow();
        return;
      }
      const versions = [...current.versions].sort((a, b) => b.version - a.version);
      const draftVersion = versions.find((v) => v.status === "draft") || null;
      const baseVersion = versions.find((v) => v.id === current.defaultVersionId) || versions.find((v) => v.status !== "draft" && v !== draftVersion) || null;
      const [baseFull, draftFull] = await Promise.all([
        baseVersion ? api.getChecklistVersion(baseVersion.id) : null,
        draftVersion ? api.getChecklistVersion(draftVersion.id) : null
      ]);
      if (token !== this._token) return;
      const source = draftFull || baseFull;
      this._current = current;
      this._baseConfig = baseFull ? baseFull.config : null;
      this._draft = createDraft(source.config, this._baseConfig, {
        checklistId: current.id,
        versionId: draftVersion ? draftVersion.id : null,
        versionNumber: draftVersion ? draftVersion.version : Math.max(...versions.map((v) => v.version)) + 1,
        baseNumber: baseVersion ? baseVersion.version : null,
        createdAt: draftVersion ? draftVersion.createdAt : new Date().toISOString()
      }, this.locale);
      this._status = "draft";
      this._selected = null;
      this.recompute();
      this._selected = this.firstKey();
      this._phase = "ready";
      this.renderNow();
    } catch (error) {
      if (token !== this._token) return;
      this._phase = "error";
      this._error = error;
      this.renderNow();
    }
  }

  firstKey() {
    const draft = this._draft;
    const first = draft.sections.flatMap((s) => draft.criteria.filter((c) => c.section === s.id))[0];
    return first ? first.key : null;
  }

  recompute() {
    const draft = this._draft;
    const validation = validate(draft);
    this._view = {
      validation,
      preview: computePreview(draft),
      changedCount: changedCount(draft)
    };
  }

  context() {
    return {
      t: (key, params) => this.t(key, params),
      locale: this.locale,
      draft: this._draft,
      view: this._view,
      selectedKey: this._selected,
      readOnly: this.readOnly,
      roleReadOnly: this.roleReadOnly,
      locked: this.locked,
      busy: this.busy,
      dirty: this._dirty,
      saveError: this._saveError,
      status: this._status,
      lists: this._lists,
      current: this._current
    };
  }

  template() {
    if (this._phase === "loading") return loadingPanel(this.locale);
    if (this._phase === "error") return errorPanel(this.locale, { message: this._error && this._error.message ? this._error.message : null });
    if (this._phase === "notfound") {
      return emptyPanel(this.locale, { title: this.t("builder.notFound"), hint: this.t("builder.notFoundHint"), actionLabel: this.t("nav.checklists") });
    }
    if (this._phase === "noversions") {
      return emptyPanel(this.locale, { title: this.t("builder.noVersions"), hint: this.t("builder.noVersionsHint"), actionLabel: this.t("nav.checklists") });
    }
    const ctx = this.context();
    return html`
      <div class="page">
        <div class="card bar" data-region="bar">${topBar(ctx)}</div>
        <main class="layout">
          <aside class="card side" aria-label="${this.t("builder.versionsLabel")}" data-region="side">${sidebar(ctx)}</aside>
          <section class="card structure" aria-label="${this.t("builder.structureLabel")}">
            <div data-region="alert">${alertBox(ctx)}</div>
            <div data-region="structure">${structure(ctx)}</div>
          </section>
          <section class="right" aria-label="${this.t("builder.editorLabel")}">
            <div class="card edit" data-region="editor">${editor(ctx)}</div>
            <div class="card pv" data-region="preview">${preview(ctx)}</div>
          </section>
        </main>
      </div>`;
  }

  afterRender(region) {
    if (!this._bound) {
      this._bound = true;
      this.bind(region);
    }
    if (this._phase === "ready") this.mountScaleEditor();
  }

  mountScaleEditor() {
    const el = this.shadowRoot.querySelector("cqa-scale-step-editor");
    const c = this.selectedCriterion();
    if (!el || !c) return;
    if (el.getAttribute("locale") !== this.locale) el.setAttribute("locale", this.locale);
    el.steps = c.steps;
    const next = String(this.weightNumber(c));
    if (el.getAttribute("weight") !== next) el.setAttribute("weight", next);
  }

  weightNumber(c) {
    const text = String(c.weight).trim().replace(",", ".");
    const value = Number(text);
    return text !== "" && Number.isFinite(value) ? value : 0;
  }

  selectedCriterion() {
    return this._draft ? this._draft.criteria.find((c) => c.key === this._selected) || null : null;
  }

  swap(name, content) {
    const node = this.shadowRoot.querySelector(`[data-region="${name}"]`);
    if (!node) return;
    const active = this.shadowRoot.activeElement;
    const focusKey = active && node.contains(active) ? active.getAttribute("data-focus-id") : null;
    const caret = focusKey && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
    node.innerHTML = String(content);
    if (!focusKey) return;
    const target = node.querySelector(`[data-focus-id="${focusKey}"]`);
    if (!target || target.disabled) return;
    target.focus({ preventScroll: true });
    if (caret && caret[0] !== null) {
      try {
        target.setSelectionRange(caret[0], caret[1]);
      } catch (error) {
        return;
      }
    }
  }

  refreshAll({ editor: withEditor = true } = {}) {
    this.recompute();
    const ctx = this.context();
    this.swap("bar", topBar(ctx));
    this.swap("alert", alertBox(ctx));
    this.swap("structure", structure(ctx));
    this.swap("preview", preview(ctx));
    this.swap("side", sidebar(ctx));
    if (withEditor) {
      this.swap("editor", editor(ctx));
      this.mountScaleEditor();
    } else {
      this.syncEditorFlags();
    }
  }

  syncEditorFlags() {
    const root = this.shadowRoot;
    const c = this.selectedCriterion();
    if (!c) return;
    const validation = this._view.validation;
    const mark = (selector, bad) => {
      const el = root.querySelector(selector);
      if (!el) return;
      if (bad) el.setAttribute("aria-invalid", "true");
      else el.removeAttribute("aria-invalid");
    };
    mark('[data-field="e-name"]', validation.badName.has(c.key));
    mark('[data-field="e-weight"]', validation.badWeight.has(c.key));
    const weight = root.querySelector('[data-field="e-weight"]');
    if (weight && weight !== root.activeElement && weight.value !== c.weight) weight.value = c.weight;
    const scale = root.querySelector("cqa-scale-step-editor");
    const next = String(this.weightNumber(c));
    if (scale && scale.getAttribute("weight") !== next) scale.setAttribute("weight", next);
  }

  announceChange() {
    emit(this, BUILDER_EVENTS.change, { valid: this.valid, status: this._status, changed: this._view.changedCount });
  }

  nextVersionNumber() {
    const numbers = (this._current ? this._current.versions : []).map((v) => v.version);
    return Math.max(this._draft.versionNumber, ...numbers) + 1;
  }

  edited() {
    if (this._status !== "draft") {
      this._status = "draft";
      this._draft.versionId = null;
      this._draft.versionNumber = this.nextVersionNumber();
      this._draft.createdAt = new Date().toISOString();
    }
    this._dirty = true;
    this._saveError = null;
    this.refreshAll({ editor: false });
    this.announceChange();
  }

  select(key) {
    this._selected = key;
    this.refreshAll();
  }

  bind(region) {
    region.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button || button.disabled) return;
      this.onAction(button.getAttribute("data-action"), button);
    });
    region.addEventListener("input", (event) => {
      const field = event.target.closest("[data-field]");
      if (field) this.onInput(field);
    });
    region.addEventListener("change", (event) => {
      const field = event.target.closest("[data-field]");
      if (!field) return;
      const name = field.getAttribute("data-field");
      if (name === "e-type") this.onType(field.value);
      else if (name === "channel") this.doChannels(field.getAttribute("data-channel"), field.checked);
    });
    region.addEventListener(EVENTS.stepsChange, (event) => {
      const c = this.selectedCriterion();
      if (!c || this.readOnly) return;
      c.steps = event.detail.steps.map((s) => ({ value: s.value, description: s.description }));
      this.edited();
    });
  }

  onAction(action, button) {
    const key = button.getAttribute("data-key");
    const draft = this._draft;
    if (this._busy) return;
    if (action === "retry" || action === "empty-action") {
      if (action === "retry") this.load();
      else navigate(this, "checklists");
      return;
    }
    if (!draft) return;
    if (action === "pick") {
      this.select(key);
    } else if (action === "add") {
      if (this.readOnly) return;
      const created = addCriterion(draft, button.getAttribute("data-section"), {
        name: this.t("builder.newName"),
        description: this.t("builder.newDescription")
      });
      this._selected = created;
      this.edited();
      this.swap("editor", editor(this.context()));
      this.mountScaleEditor();
      const name = this.shadowRoot.querySelector('[data-field="e-name"]');
      if (name) {
        name.focus();
        name.select();
      }
    } else if (action === "remove") {
      if (this.readOnly) return;
      const next = removeCriterion(draft, key);
      if (next === null) return;
      if (this._selected === key) this._selected = next;
      this.edited();
      this.swap("editor", editor(this.context()));
      this.mountScaleEditor();
      const target = this.shadowRoot.querySelector(`[data-focus-id="pick-${next}"]`);
      if (target) target.focus();
    } else if (action === "up" || action === "down") {
      if (this.readOnly) return;
      if (moveCriterion(draft, key, action === "up" ? -1 : 1)) {
        this.edited();
        this.swap("editor", editor(this.context()));
        this.mountScaleEditor();
        const target = this.shadowRoot.querySelector(`[data-focus-id="${action}-${key}"]`);
        if (target && !target.disabled) target.focus();
        else {
          const other = this.shadowRoot.querySelector(`[data-focus-id="${action === "up" ? "down" : "up"}-${key}"]`);
          if (other && !other.disabled) other.focus();
        }
      }
    } else if (action === "reset") {
      if (this.readOnly || !this._baseConfig) return;
      reset(draft, this._baseConfig, this.locale);
      if (!draft.criteria.some((c) => c.key === this._selected)) this._selected = this.firstKey();
      this._status = "draft";
      this._saveError = null;
      this._dirty = draft.versionId !== null;
      this.refreshAll();
      this.announceChange();
    } else if (action === "save") {
      this.doSave();
    } else if (action === "apply") {
      this.doApply();
    } else if (action === "duplicate") {
      this.doDuplicate(Number(button.getAttribute("data-version")));
    } else if (action === "activate") {
      this.doActivate(Number(button.getAttribute("data-version")));
    } else if (action === "discard") {
      this.doDiscard();
    } else if (action === "open-checklist") {
      navigate(this, "checklists", button.getAttribute("data-id"));
    }
  }

  async setBusy(name, fn) {
    this._busy = name;
    this.refreshAll({ editor: false });
    try {
      return await fn();
    } finally {
      this._busy = null;
      if (this._draft) this.refreshAll({ editor: this._status === "applied" });
    }
  }

  async refreshLists() {
    try {
      const lists = await api.listChecklists();
      const current = lists.find((c) => c.id === this._current.id);
      if (current) {
        this._lists = lists;
        this._current = current;
      }
    } catch (error) {
      return;
    }
  }

  async doSave() {
    const draft = this._draft;
    if (!draft || !this.valid || this.readOnly || this._status !== "draft" || this._busy) return;
    const config = toConfig(draft);
    const base = draft.baseNumber;
    await this.setBusy("save", async () => {
      try {
        let saved;
        if (draft.versionId !== null) {
          await api.updateDraft(draft.versionId, config);
          saved = await api.finalizeVersion(draft.versionId);
        } else {
          saved = await api.saveChecklistVersion(draft.checklistId, config);
        }
        draft.versionId = saved.id;
        draft.versionNumber = saved.version;
        this._status = "saved";
        this._dirty = false;
        this._saveError = null;
        await this.refreshLists();
        const version = `v${saved.version}`;
        this.toast(base === null ? this.t("builder.toast.savedNoBase", { version }) : this.t("builder.toast.saved", { version, base: `v${base}` }));
        emit(this, BUILDER_EVENTS.saved, { checklistId: draft.checklistId, versionId: saved.id, version: saved.version });
      } catch (error) {
        const message = this.errorMessage(error, true);
        this._saveError = message;
        this.toast(message, "bad");
      }
    });
    this.announceChange();
  }

  async doApply() {
    const draft = this._draft;
    if (!draft || this._status !== "saved" || this.readOnly || this._busy) return;
    await this.setBusy("apply", async () => {
      try {
        const datasets = await api.listDatasets();
        const control = datasets.find((d) => d.kind === "control") || datasets[0];
        if (!control) throw Object.assign(new Error("dataset"), { code: "dataset_required" });
        const run = await api.startRun({ versionId: draft.versionId, groupId: control.groupId });
        this._status = "applied";
        this._saveError = null;
        await this.refreshLists();
        this.toast(
          this.t("builder.toast.applied", { count: run.total, n: integer(run.total, this.locale), version: `v${draft.versionNumber}` }),
          "ok",
          { label: this.t("builder.toast.openRun"), to: "runs", id: run.number }
        );
        emit(this, BUILDER_EVENTS.applied, { checklistId: draft.checklistId, versionId: draft.versionId, run: run.number });
      } catch (error) {
        const message = this.errorMessage(error, false);
        this._saveError = message;
        this.toast(message, "bad");
      }
    });
    this.announceChange();
  }

  async doDuplicate(versionId) {
    if (this.roleReadOnly || this._busy || !this._current) return;
    if (!(await this.confirmLeave())) return;
    this._dirty = false;
    const source = this._current.versions.find((v) => v.id === versionId);
    await this.setBusy("duplicate", async () => {
      try {
        const full = await api.getChecklistVersion(versionId);
        const created = await api.saveChecklistVersion(this._current.id, full.config, { status: "draft" });
        this.toast(this.t("builder.toast.duplicated", { version: `v${created.version}`, base: `v${source ? source.version : full.version}` }));
        await this.load();
      } catch (error) {
        const message = this.errorMessage(error, true);
        this._saveError = message;
        this.toast(message, "bad");
      }
    });
  }

  async doActivate(versionId) {
    if (this.roleReadOnly || this._busy || !this._current) return;
    await this.setBusy("activate", async () => {
      try {
        const done = await api.setActiveVersion(this._current.id, versionId);
        await this.refreshLists();
        this.toast(this.t("builder.toast.activated", { version: `v${done.version}` }));
      } catch (error) {
        this.toast(this.errorMessage(error, false), "bad");
      }
    });
  }

  async doDiscard() {
    if (this.roleReadOnly || this._busy || !this._dirty) return;
    if (!(await this.confirmLeave())) return;
    this._dirty = false;
    await this.load();
    if (this._phase === "ready") this.toast(this.t("builder.toast.discarded"));
  }

  async doChannels(kind, on) {
    if (this.roleReadOnly || this._busy || !this._current) return;
    const bound = new Set(this._current.channels.map(channelKind));
    if (on) bound.add(kind);
    else bound.delete(kind);
    const next = ["chat", "call"].filter((k) => bound.has(k)).map((k) => (this._current.channels.find((c) => channelKind(c) === k) || CHANNEL_RAW[k]));
    await this.setBusy("channels", async () => {
      try {
        await api.setChecklistChannels(this._current.id, next);
        await this.refreshLists();
        this.toast(this.t("builder.toast.channels"));
      } catch (error) {
        this.toast(this.errorMessage(error, false), "bad");
      }
    });
  }

  onInput(field) {
    if (this.readOnly || this._busy) return;
    const name = field.getAttribute("data-field");
    const draft = this._draft;
    if (name === "row-weight") {
      const c = draft.criteria.find((x) => x.key === field.getAttribute("data-key"));
      if (!c) return;
      c.weight = field.value;
    } else {
      const c = this.selectedCriterion();
      if (!c) return;
      if (name === "e-name") c.name = field.value;
      else if (name === "e-desc") c.description = field.value;
      else if (name === "e-weight") c.weight = field.value;
      else if (name === "e-na") setNaCondition(c, field.value);
      else return;
    }
    this.edited();
  }

  onType(type) {
    const c = this.selectedCriterion();
    if (!c || this.readOnly) return;
    setType(this._draft, c.key, type, [
      { value: "0", description: this.t("builder.seed.step0") },
      { value: "5", description: this.t("builder.seed.step1") },
      { value: "10", description: this.t("builder.seed.step2") }
    ]);
    this.edited();
    this.swap("editor", editor(this.context()));
    this.mountScaleEditor();
    const select = this.shadowRoot.querySelector('[data-field="e-type"]');
    if (select) select.focus();
  }
}
