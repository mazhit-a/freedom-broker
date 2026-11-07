import { api, ensureConfigured } from "../api.js";
import { CqaElement, html, raw } from "../base-element.js";
import { EVENTS, emit, navigate } from "../events.js";
import { duration } from "../format.js";
import { can } from "../roles.js";
import { SHARED_CSS } from "../shared/styles.js";
import { chip, langChip } from "../shared/chip.js";
import { emptyPanel, errorPanel } from "../shared/state-panel.js";
import { CARD_EVENTS, buildCard, enterTarget, moveSelection, paintState, wallClock } from "./card-model.js";
import { chatIcon, criteriaSection, loadingSkeleton, scoreSection, transcriptSection } from "./card-view.js";
import { LEDGER_CSS, buildLedger, ledgerView } from "./card-ledger.js";
import { HISTORY_CSS, buildHistory, historyView, openAppeals } from "./card-history.js";
import { CallChannel, isCall } from "./call-controller.js";
import { CALL_CSS } from "./call-view.js";
import { AppealFlow } from "./appeal-controller.js";
import { APPEAL_CSS } from "./appeal-panel.js";

const STYLES = `${SHARED_CSS}${LEDGER_CSS}${HISTORY_CSS}${CALL_CSS}${APPEAL_CSS}
:host { display: block; container-type: normal !important; font-size: var(--cqa-fs-14); color: var(--cqa-ink); }
[hidden] { display: none !important; }
.page { container-type: inline-size; display: flex; flex-direction: column; gap: 16px; }
.fs12 { font-size: var(--cqa-fs-12); }
.fs13 { font-size: var(--cqa-fs-13); }
.muted2 { color: var(--cqa-ink-2); }
.grow { flex: 1; }
.warn-text { color: var(--cqa-warn); }
.strip { padding: 10px 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.crumb { font-size: var(--cqa-fs-13); color: var(--cqa-ink-3); display: flex; gap: 6px; align-items: center; }
.crumb .cur { color: var(--cqa-ink); font-weight: 600; }
.strip-meta { font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); }
.strip-meta b { font-weight: 600; color: var(--cqa-ink); }
.strip-tools { display: flex; gap: 8px; align-items: center; margin-left: auto; flex-wrap: wrap; }
.strip-tools label { display: flex; gap: 6px; align-items: center; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
.strip-tools .field { height: 30px; max-width: 220px; }
.hint { flex: 1 1 100%; font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); gap: 16px; align-items: start; }
.evalcol { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.transcript { position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow: auto; display: flex; flex-direction: column; min-width: 0; }
.t-head { position: sticky; top: 0; z-index: 2; background: var(--cqa-surface); border-bottom: 1px solid var(--cqa-line); padding: 12px 16px; display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; border-radius: var(--cqa-radius-card) var(--cqa-radius-card) 0 0; }
.blk-h { margin: 0; font-size: var(--cqa-fs-16); font-weight: 600; }
.t-legend { margin-left: auto; gap: 10px; font-size: 11px; color: var(--cqa-ink-3); }
.t-legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.lg-ev { background: var(--cqa-hl); border: 1px solid var(--cqa-hl-line); }
.lg-exp { background: var(--cqa-warn-bg); border: 1px dashed var(--cqa-warn); }
.lg-bot { background: var(--cqa-surface-2); border: 1px dashed var(--cqa-line-strong); }
.msgs { list-style: none; margin: 0; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.m { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; scroll-margin: 80px; min-width: 0; }
.m-operator { align-items: flex-end; }
.m-system { align-items: center; }
.m .msg { transition: background .15s, box-shadow .15s; }
.msg-expected.msg-client, .msg-expected.msg-bot { align-self: flex-start; }
.msg.is-sel { box-shadow: 0 0 0 2px var(--cqa-brand); }
.msg-system.is-sel { box-shadow: 0 0 0 2px var(--cqa-brand); }
.msg-system { display: inline-flex; gap: 8px; align-items: center; }
.msg-head { align-items: center; gap: 8px; }
.msg-text { margin: 4px 0 0; font-size: var(--cqa-fs-14); line-height: 1.5; text-wrap: pretty; white-space: pre-wrap; }
.ts { border: 0; background: transparent; padding: 0 2px; font: 500 var(--cqa-fs-12) var(--cqa-font); font-variant-numeric: tabular-nums; color: var(--cqa-ink-3); cursor: pointer; border-radius: 4px; text-decoration: underline dotted; text-underline-offset: 3px; }
.ts:hover { color: var(--cqa-ink); }
.ts[aria-pressed="true"] { color: var(--cqa-ink); font-weight: 700; }
.exp-label { font-size: 11px; font-weight: 600; color: var(--cqa-warn); letter-spacing: .02em; display: inline-flex; gap: 6px; align-items: center; }
.foot { display: flex; align-items: center; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
.foot-label { font-size: 11px; color: var(--cqa-ink-3); margin-right: 2px; }
.cite { height: 20px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--cqa-line-strong); background: var(--cqa-surface); font: 600 11px var(--cqa-font); color: var(--cqa-ink-2); cursor: pointer; font-variant-numeric: tabular-nums; }
.cite.on { background: var(--cqa-ink); color: var(--cqa-surface); border-color: var(--cqa-ink); }
.score-card { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.score-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.total-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.total { font-size: 44px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.05; }
.total-na { font-size: var(--cqa-fs-24); font-weight: 600; line-height: 1.2; }
.out-of { font-size: var(--cqa-fs-16); color: var(--cqa-ink-3); }
.score-meta { margin-left: auto; display: flex; flex-direction: column; gap: 4px; align-items: flex-end; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); text-align: right; min-width: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 8px; }
.tile { padding: 10px 12px; border-radius: 10px; background: var(--cqa-surface-2); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.tile-v { font-size: var(--cqa-fs-16); font-weight: 600; }
.tile-of { font-size: var(--cqa-fs-12); font-weight: 400; color: var(--cqa-ink-3); }
.tile-track { height: 4px; border-radius: 2px; background: var(--cqa-surface-3); display: block; }
.tile-fill { display: block; height: 4px; border-radius: 2px; background: var(--cqa-brand-deep); }
.gross { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--cqa-line); }
.gross-found { border-color: var(--cqa-critical); background: var(--cqa-critical-bg); }
.gross-desc { margin-left: auto; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
.gross-why { flex: 1 1 100%; }
.criteria { padding: 8px 0; display: flex; flex-direction: column; }
.cr-head { padding: 10px 20px 8px; display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; }
.pad { padding: 0 20px 12px; margin: 0; }
.crit-list { display: flex; flex-direction: column; outline-offset: -2px; }
.sec-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 12px 20px 6px; border-top: 1px solid var(--cqa-line); }
.crit-row { display: flex; flex-direction: column; gap: 8px; padding: 14px 20px; transition: background .15s; scroll-margin: 16px; }
.crit-row.is-sel { background: var(--cqa-brand-tint); box-shadow: inset 3px 0 0 var(--cqa-brand); }
.crit-row.is-cited { background: var(--cqa-hl); }
.crit-row.is-hover { background: var(--cqa-surface-2); }
.crit-top { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
.crit-pick { flex: 1 1 240px; min-width: 0; text-align: left; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; border-radius: 4px; }
.crit-no { color: var(--cqa-ink-3); font-size: var(--cqa-fs-12); width: 20px; flex: none; font-variant-numeric: tabular-nums; }
.crit-name { font-weight: 600; font-size: var(--cqa-fs-14); overflow-wrap: anywhere; min-width: 0; }
.cites-chip { background: var(--cqa-hl); color: var(--cqa-ink); height: 20px; }
.crit-pts { min-width: 108px; text-align: right; font-size: var(--cqa-fs-13); }
.crit-pts b { font-size: var(--cqa-fs-16); font-weight: 600; }
.crit-rest { padding-left: 30px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.crit-why { margin: 0; font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); text-wrap: pretty; overflow-wrap: anywhere; }
.na-box { font-size: var(--cqa-fs-13); padding: 8px 10px; border-radius: 8px; background: var(--cqa-na-bg); color: var(--cqa-ink); overflow-wrap: anywhere; }
.step { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 22px; border-radius: 6px; font-size: var(--cqa-fs-12); font-weight: 600; border: 1px solid var(--cqa-line-strong); color: var(--cqa-ink-3); font-variant-numeric: tabular-nums; }
.step-on { background: var(--cqa-ink); color: var(--cqa-surface); border-color: var(--cqa-ink); }
.ev { text-align: left; }
@container (max-width: 1099px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .transcript { position: static; max-height: none; overflow: visible; }
  .t-head { position: static; }
  .t-legend { margin-left: 0; }
  .strip-tools { margin-left: 0; }
  .score-meta { margin-left: 0; align-items: flex-start; text-align: left; }
}
@media (prefers-reduced-motion: reduce) { .m .msg, .crit-row { transition: none; } }
`;

export class CqaConversationCard extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "conversation-id"];
  }

  constructor() {
    super();
    this._phase = "loading";
    this._conversation = null;
    this._evaluation = null;
    this._versions = [];
    this._datasetName = null;
    this._view = null;
    this._sel = null;
    this._hover = null;
    this._msg = null;
    this._busy = false;
    this._ledgerOpen = true;
    this._token = 0;
    this._versionId = null;
    this._nodes = null;
    this._appeal = new AppealFlow(this);
    this._bind();
  }

  _bind() {
    const root = this.shadowRoot;
    root.addEventListener("click", (event) => this.onClick(event));
    root.addEventListener("keydown", (event) => this.onKey(event));
    root.addEventListener("change", (event) => this.onChange(event));
    root.addEventListener("mouseover", (event) => this.onOver(event));
    this.addEventListener("mouseleave", () => this.setHover(null));
  }

  styles() {
    return STYLES;
  }

  attributeChangedCallback(name, oldValue, value) {
    if (name === "conversation-id") {
      if (this._ready && oldValue !== value) {
        this._versionId = null;
        this.load();
      }
      return;
    }
    super.attributeChangedCallback(name, oldValue, value);
  }

  onReady() {
    ensureConfigured();
    this.load();
  }

  conversationId() {
    return this.getAttribute("conversation-id");
  }

  async load() {
    const token = (this._token += 1);
    const id = this.conversationId();
    this._phase = "loading";
    this._conversation = null;
    this._evaluation = null;
    this._view = null;
    this.renderNow();
    if (!id) {
      this._phase = "notfound";
      this.renderNow();
      return;
    }
    const [conv, evaluation, evaluations, checklists, datasets] = await Promise.allSettled([
      api.getConversation(id),
      api.getEvaluation(id, this._versionId),
      api.listEvaluations(id),
      api.listChecklists(),
      api.listDatasets()
    ]);
    if (token !== this._token) return;
    if (conv.status === "rejected") {
      this._phase = conv.reason && conv.reason.status === 404 ? "notfound" : "error";
      this.renderNow();
      return;
    }
    if (evaluation.status === "rejected" && !(evaluation.reason && evaluation.reason.status === 404)) {
      this._phase = "error";
      this.renderNow();
      return;
    }
    this._conversation = conv.value;
    this._evaluation = evaluation.status === "fulfilled" ? evaluation.value : null;
    this._versions = this.versionOptions(evaluations.status === "fulfilled" ? evaluations.value : [], checklists.status === "fulfilled" ? checklists.value : []);
    this._datasetName = this.datasetName(conv.value, datasets.status === "fulfilled" ? datasets.value : []);
    this._phase = "ready";
    this.prepare();
    this.renderNow();
  }

  versionOptions(evaluations, checklists) {
    const labels = new Map();
    for (const cl of checklists) for (const v of cl.versions) labels.set(v.id, v.label);
    return evaluations.map((e) => ({ id: e.id, versionId: e.versionId, label: labels.get(e.versionId) || `#${e.versionId}`, createdAt: e.createdAt }));
  }

  datasetName(conversation, datasets) {
    const group = String(conversation.groupId || "").toLowerCase();
    const found = datasets.find((d) => String(d.groupId || "").toLowerCase() === group);
    return found ? found.label : conversation.groupId;
  }

  prepare() {
    this._view = buildCard(this._conversation, this._evaluation, this.locale);
    if (!this._view.byId[this._sel]) this._sel = this._view.order[0] || null;
    this._hover = null;
    this._msg = null;
  }

  renderNow() {
    if (this._phase === "ready" && this._conversation) {
      this._view = buildCard(this._conversation, this._evaluation, this.locale);
      if (!this._view.byId[this._sel]) this._sel = this._view.order[0] || null;
      this.syncCall();
    }
    super.renderNow();
  }

  syncCall() {
    const conv = this._conversation;
    if (!isCall(conv)) {
      if (this._call) this._call.dispose();
      this._call = null;
      return;
    }
    if (this._call && this._call.conversationId !== conv.id) {
      this._call.dispose();
      this._call = null;
    }
    if (!this._call) {
      this._call = new CallChannel(this);
      this._call.conversationId = conv.id;
    }
    this._call.update(conv, this._evaluation, this._view);
  }

  channelChip() {
    if (this._call) return this._call.channelChip();
    const call = this._conversation.channel === "call";
    const text = this.t(call ? "card.channelCall" : "card.channelChat");
    return html`<span class="chip c-na">${call ? html`` : chatIcon()}${text}</span>`;
  }

  stripTemplate() {
    const conv = this._conversation;
    const id = conv ? conv.id : this.conversationId() || "";
    const crumbs = html`<nav class="crumb" aria-label="${this.t("card.breadcrumb")}"><a href="#/conversations" data-action="crumb">${this.t("nav.conversations")}</a><span aria-hidden="true">/</span><span class="cur tnum" aria-current="page">${id}</span></nav>`;
    if (!conv) return html`<div class="card strip">${crumbs}</div>`;
    const dataset = this._datasetName ? html`<span class="tnum strip-meta muted">${this.t("card.dataset", { name: this._datasetName })}</span>` : html``;
    const when = this._call
      ? this._call.metaTemplate()
      : conv.occurredAt ? html`<span class="tnum strip-meta muted">${this.t("card.occurredAt", { when: wallClock(conv.occurredAt, this.locale) })}</span>` : html``;
    return html`<div class="card strip" data-strip>${crumbs}${langChip(conv.language)}${this.channelChip()}<span class="strip-meta">${this.t("card.operatorLabel")}: <b>${this.t("actor.operator")}</b></span>${dataset}${when}${this.versionTools()}<span class="hint" data-role-hint>${this.hintText()}</span></div>`;
  }

  hintText() {
    const pending = this.role === "reviewer" && this._evaluation ? openAppeals(this._evaluation) : [];
    if (pending.length) return this.t("card.hint.reviewerAppeal", { id: pending[0].criterionId });
    return this.t(`card.hint.${this.role}`);
  }

  versionTools() {
    const ev = this._evaluation;
    if (!ev) return html``;
    const options = this._versions.length
      ? this._versions
      : [{ id: ev.id, versionId: ev.versionId, label: ev.versionLabel || `#${ev.versionId}`, createdAt: ev.createdAt }];
    const items = options.map((o) => {
      const text = `${o.label} · ${wallClock(o.createdAt, this.locale)}`;
      const selected = o.versionId === ev.versionId ? "selected" : "";
      return html`<option value="${o.versionId}" ${raw(selected)}>${text}</option>`;
    });
    const re = can(this.role, "re-evaluate")
      ? html`<button type="button" class="btn btn-sm" data-action="reevaluate" data-focus-id="reevaluate" ${raw(this._busy ? "disabled" : "")}>${this.t("card.reevaluate")}</button>`
      : html``;
    return html`<div class="strip-tools"><label>${this.t("card.version")}<select class="field" data-action="version" data-focus-id="version">${items}</select></label>${re}</div>`;
  }

  transcriptBanner() {
    const call = this._call ? this._call.banner() : html``;
    return html`${call}${this._appeal.banner()}`;
  }

  messageExtra(message) {
    const call = this._call ? this._call.extra(message) : null;
    const attach = this._appeal.extra(message);
    if (!call) return attach;
    return attach ? html`${call}${attach}` : call;
  }

  reviewSection(view, ev) {
    return this._appeal.reviewSection(view, ev);
  }

  ledgerSection(view, ev) {
    const model = buildLedger(view, ev);
    if (!model.reconciled && globalThis.console) console.warn(`ledger total does not reconcile with the score panel for ${this.conversationId()}`);
    return ledgerView(model, { locale: this.locale, open: this._ledgerOpen });
  }

  historySection(view, ev) {
    return historyView(buildHistory(view, ev, this.locale), this.locale);
  }

  overlays() {
    return html``;
  }

  template() {
    const phase = this._phase;
    const locale = this.locale;
    if (phase === "loading") {
      return loadingSkeleton(locale, this.stripTemplate());
    }
    if (phase === "error") {
      return html`<div class="page">${this.stripTemplate()}${errorPanel(locale)}</div>`;
    }
    if (phase === "notfound") {
      return html`<div class="page">${this.stripTemplate()}${emptyPanel(locale, { title: this.t("card.notFound"), hint: this.t("card.notFoundHint"), actionLabel: this.t("nav.conversations"), action: "crumb" })}</div>`;
    }
    const view = this._view;
    const conv = this._conversation;
    const ev = this._evaluation;
    const durationText = conv.durationSeconds !== null && conv.durationSeconds !== undefined ? duration(conv.durationSeconds) : "";
    const transcript = transcriptSection(view, { locale, durationText, banner: this.transcriptBanner(), messageExtra: (m) => this.messageExtra(m) });
    let right;
    if (ev) {
      const ctx = { locale, canAppeal: can(this.role, "file-appeal"), hideGross: Boolean(this._call && this._call.hidesGross()) };
      const lead = this._call ? this._call.lead() : html``;
      const criteria = this._call ? this._call.criteria(view, ctx) : criteriaSection(view, ctx);
      right = html`${lead}${scoreSection(view, ev, ctx)}${this.reviewSection(view, ev)}${criteria}${this.ledgerSection(view, ev)}${this.historySection(view, ev)}`;
    } else {
      right = emptyPanel(locale, { title: this.t("card.noEvaluation"), hint: this.t("card.noEvaluationHint") });
    }
    return html`<div class="page">${this.stripTemplate()}<div class="cols">${transcript}<section class="evalcol" aria-label="${this.t("card.evaluation")}">${right}</section></div></div>${this.overlays()}`;
  }

  afterRender(region) {
    if (this._phase !== "ready") {
      this._nodes = null;
      return;
    }
    this._nodes = {
      items: [...region.querySelectorAll("li[data-index]")],
      rows: [...region.querySelectorAll("[data-crit-row]")],
      list: region.querySelector("[data-crit-list]"),
      transcript: region.querySelector("[data-transcript]")
    };
    this.paint();
    if (this._call) this._call.afterRender(region);
    this._appeal.afterRender(region);
  }

  paint() {
    if (!this._nodes || !this._view) return;
    const state = paintState(this._view, this._hover, this._sel, this._msg);
    for (const li of this._nodes.items) {
      const index = Number(li.getAttribute("data-index"));
      const bubble = li.querySelector("[data-bubble]");
      const isExp = state.expected.has(index);
      const isEv = state.evidence.has(index);
      bubble.classList.toggle("msg-evidence", isEv && !bubble.classList.contains("msg-system"));
      bubble.classList.toggle("msg-expected", isExp && !bubble.classList.contains("msg-system"));
      bubble.classList.toggle("is-sel", this._msg === index);
      const label = li.querySelector("[data-exp-label]");
      const first = isExp && state.expectedFirst === index;
      label.hidden = !first;
      if (first) label.querySelector("[data-exp-text]").textContent = this.t("card.expectedLabel", { criterion: state.expectedLabel });
      const ts = li.querySelector(".ts");
      if (ts) ts.setAttribute("aria-pressed", this._msg === index ? "true" : "false");
      for (const cite of li.querySelectorAll(".cite")) cite.classList.toggle("on", cite.getAttribute("data-crit") === state.activeId);
    }
    for (const row of this._nodes.rows) {
      const id = row.getAttribute("data-crit-row");
      const selected = this._sel === id;
      const cited = state.citedBy.has(id);
      row.classList.toggle("is-sel", selected);
      row.classList.toggle("is-cited", !selected && cited);
      row.classList.toggle("is-hover", !selected && !cited && this._hover === id);
      row.querySelector(".crit-pick").setAttribute("aria-pressed", selected ? "true" : "false");
      const tag = row.querySelector("[data-cites-chip]");
      tag.hidden = !cited;
      if (cited) tag.textContent = this.t("card.citesMsg", { n: this._msg + 1 });
    }
  }

  setHover(id) {
    if (this._hover === id) return;
    this._hover = id;
    this.paint();
  }

  select(id, { message, reveal = false } = {}) {
    if (!this._view || !this._view.byId[id]) return;
    this._sel = id;
    if (message !== undefined) this._msg = message;
    this.paint();
    if (reveal) this.reveal(this.shadowRoot.querySelector(`[data-crit-row="${id}"]`), "nearest");
  }

  scrollBehavior() {
    const reduce = globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return reduce ? "auto" : "smooth";
  }

  reveal(element, block) {
    if (!element) return;
    element.scrollIntoView({ block, behavior: this.scrollBehavior() });
  }

  scrollToMessage(index) {
    const li = this.shadowRoot.querySelector(`li[data-index="${index}"]`);
    if (!li) return;
    const box = this._nodes && this._nodes.transcript;
    if (box && box.scrollHeight > box.clientHeight + 1) {
      const c = box.getBoundingClientRect();
      const r = li.getBoundingClientRect();
      const delta = r.top - c.top - (box.clientHeight / 2 - r.height / 2);
      box.scrollBy({ top: delta, behavior: this.scrollBehavior() });
    } else {
      this.reveal(li, "center");
    }
  }

  onOver(event) {
    if (this._phase !== "ready") return;
    const target = event.target;
    const row = target && target.closest ? target.closest("[data-crit-row]") : null;
    this.setHover(row ? row.getAttribute("data-crit-row") : null);
  }

  onChange(event) {
    const target = event.target;
    if (target && target.getAttribute && target.getAttribute("data-action") === "version") {
      this._versionId = Number(target.value);
      this.load();
    }
  }

  onClick(event) {
    const el = event.target && event.target.closest ? event.target.closest("[data-action]") : null;
    if (!el) return;
    const action = el.getAttribute("data-action");
    const crit = el.getAttribute("data-crit");
    const msg = el.getAttribute("data-msg");
    if (this._call && this._call.handleClick(action, el, event)) return;
    if (this._appeal.handleClick(action, el, event)) return;
    if (action === "pick-crit") this.select(crit);
    else if (action === "pick-msg") {
      this._msg = this._msg === Number(msg) ? null : Number(msg);
      this.paint();
    } else if (action === "cite") {
      this.select(crit, { message: Number(msg), reveal: true });
    } else if (action === "jump") {
      const row = el.closest("[data-crit-row]");
      const id = row ? row.getAttribute("data-crit-row") : null;
      const expected = el.classList.contains("ev-expected");
      if (id) this.select(id, { message: expected ? null : Number(msg) });
      this.scrollToMessage(Number(msg));
    } else if (action === "appeal") {
      event.preventDefault();
      const ev = this._evaluation;
      this.select(crit);
      emit(this, CARD_EVENTS.appealRequest, { criterionId: crit, evaluationId: ev ? ev.id : null, conversationId: this._conversation ? this._conversation.id : null });
    } else if (action === "toggle-ledger") {
      this._ledgerOpen = !this._ledgerOpen;
      this.renderNow();
    } else if (action === "crumb") {
      event.preventDefault();
      navigate(this, "conversations");
    } else if (action === "retry") {
      this.load();
    } else if (action === "reevaluate") {
      this.reevaluate();
    }
  }

  onKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const list = this._nodes && this._nodes.list;
    if (!list || !event.target.closest || !event.target.closest("[data-crit-list]")) return;
    const key = event.key;
    if (key === "j" || key === "k" || key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const next = moveSelection(this._view.order, this._sel, key);
      if (next && next !== this._sel) this.select(next, { reveal: true });
    } else if (key === "Enter" && event.target === list) {
      event.preventDefault();
      const target = enterTarget(this._view.byId[this._sel]);
      if (!target) return;
      if (target.select) this._msg = target.index;
      this.paint();
      this.scrollToMessage(target.index);
    }
  }

  askConfirm(detail) {
    return new Promise((resolve) => emit(this, EVENTS.confirm, { ...detail, resolve }));
  }

  toast(message, tone) {
    emit(this, EVENTS.toast, { message, tone });
  }

  async reevaluate() {
    const ev = this._evaluation;
    if (!ev || this._busy) return;
    const ok = await this.askConfirm({
      heading: this.t("card.reevaluateTitle"),
      description: this.t("card.reevaluateText", { version: ev.versionLabel || "" }),
      confirmLabel: this.t("card.reevaluate")
    });
    if (!ok) return;
    this._busy = true;
    this.renderNow();
    try {
      await api.evaluate(this._conversation.id, ev.versionId);
      this._busy = false;
      this.toast(this.t("card.reevaluated"), "ok");
      await this.load();
    } catch (error) {
      this._busy = false;
      this.toast(this.t("card.reevaluateFailed"), "bad");
      this.renderNow();
    }
  }
}
