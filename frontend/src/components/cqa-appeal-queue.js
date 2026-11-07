import { CqaElement, html, raw } from "../base-element.js";
import { api, ensureConfigured } from "../api.js";
import { EVENTS, emit } from "../events.js";
import { number } from "../format.js";
import { can } from "../roles.js";
import { SHARED_CSS } from "../shared/styles.js";
import { langChip, statusChip } from "../shared/chip.js";
import { emptyPanel, errorPanel, loadingPanel } from "../shared/state-panel.js";
import { allowedAnswers, answerValue, defaultNewAnswer, errorText, previewTotals } from "./appeal-model.js";
import { APPEAL_CSS, answerBadge, answerLabel, decisionBlock } from "./appeal-panel.js";
import { wallClock } from "./card-model.js";
import {
  DEFAULT_AGING_HOURS,
  TABS,
  ageText,
  chooseSelection,
  criterionDef,
  criterionTitle,
  decisionText,
  isAging,
  isClosed,
  nextIndex,
  parseAppealId,
  rowLabel,
  tabCounts,
  visibleRows
} from "./queue-model.js";

const TEXT_TARGETS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export class CqaAppealQueue extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "appeal-id"];
  }

  constructor() {
    super();
    this._phase = "loading";
    this._loadError = null;
    this._list = [];
    this._summary = null;
    this._tab = "all";
    this._selected = null;
    this._evals = new Map();
    this._panels = new Map();
    this._epoch = 0;
    this._busyStart = new Set();
    this.shadowRoot.addEventListener("click", (event) => this.onClick(event));
    this.shadowRoot.addEventListener("change", (event) => this.onChange(event));
    this.shadowRoot.addEventListener("input", (event) => this.onInput(event));
    this.shadowRoot.addEventListener("keydown", (event) => this.onKeydown(event));
  }

  disconnectedCallback() {
    this._epoch += 1;
    super.disconnectedCallback();
  }

  attributeChangedCallback(name, oldValue, value) {
    super.attributeChangedCallback(name, oldValue, value);
    if (name === "appeal-id" && this._ready && oldValue !== value && this._phase === "ready") {
      const id = parseAppealId(value);
      if (id !== null && this._list.some((a) => a.id === id)) this.select(id, false);
    }
  }

  onReady() {
    ensureConfigured();
    this.load();
  }

  styles() {
    return `${SHARED_CSS}${APPEAL_CSS}
      :host { display: block; }
      .screen { display: flex; flex-direction: column; gap: 16px; }
      .head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
      h1 { margin: 0; font-size: var(--cqa-fs-24); font-weight: 600; letter-spacing: -0.01em; }
      .sub { font-size: var(--cqa-fs-13); color: var(--cqa-ink-3); }
      .sum { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 0; padding: 0; list-style: none; font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); }
      .sum b { font-weight: 600; color: var(--cqa-ink); font-variant-numeric: tabular-nums; }
      .sum .warn b { color: var(--cqa-warn); }
      .grid { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
      .queue { flex: 1 1 560px; min-width: 0; overflow: hidden; }
      .detail { flex: 1.2 1 620px; min-width: 0; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
      .bar { padding: 12px 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .sort { margin-left: auto; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
      .tbl-scroll { overflow-x: auto; }
      .qrow { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1.2fr) 84px 52px 128px; gap: 10px; align-items: center; padding: 0 16px; min-height: 52px; border: 0; border-top: 1px solid var(--cqa-line); font-size: var(--cqa-fs-13); width: 100%; text-align: left; background: transparent; font-family: var(--cqa-font); color: var(--cqa-ink); cursor: pointer; }
      .qrow:hover { background: var(--cqa-surface-2); }
      .qrow.on { background: var(--cqa-brand-tint); box-shadow: inset 3px 0 0 var(--cqa-brand); }
      .qrow:focus-visible { outline-offset: -2px; }
      .qrow > [role=cell] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .qhead { cursor: default; min-height: 36px; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
      .qhead:hover { background: transparent; }
      .conv { display: flex; gap: 6px; align-items: center; }
      .conv b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
      .age { color: var(--cqa-ink-2); }
      .age.warn { color: var(--cqa-warn); font-weight: 600; }
      .none { margin: 0; padding: 24px 16px; font-size: var(--cqa-fs-13); color: var(--cqa-ink-3); border-top: 1px solid var(--cqa-line); }
      .d-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .d-head h2 { margin: 0; font-size: var(--cqa-fs-18, 18px); font-weight: 600; }
      .d-head h2:focus { outline: none; }
      .d-head .open { margin-left: auto; font-size: var(--cqa-fs-13); }
      .meta { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); font-variant-numeric: tabular-nums; }
      .cap { font-size: var(--cqa-fs-12); font-weight: 600; color: var(--cqa-ink-3); text-transform: uppercase; letter-spacing: .04em; }
      .box { padding: 14px; border-radius: 10px; background: var(--cqa-surface-2); display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .box.line { background: transparent; border: 1px solid var(--cqa-line-strong); }
      .box p { margin: 0; font-size: var(--cqa-fs-13); overflow-wrap: anywhere; }
      .box .ink2 { color: var(--cqa-ink-2); }
      .pts { font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); font-variant-numeric: tabular-nums; }
      .frag { border-radius: 10px; border: 1px solid var(--cqa-hl-line); background: var(--cqa-hl); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
      .frag-h { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .frag-h .cap { color: var(--cqa-ink-2); font-size: 11px; }
      .frag-h small { font-size: 11px; color: var(--cqa-ink-3); }
      .rv-line .t { width: 64px; }
      .closed { border-top: 1px solid var(--cqa-line); padding-top: 14px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
      .closed > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .closed span.v { font-size: var(--cqa-fs-20); font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
      .closed span.v.sm { font-size: var(--cqa-fs-14); }
      .reason { margin: 0; font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); overflow-wrap: anywhere; }
      .readonly { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--cqa-surface-2); font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); }
      .fs12 { font-size: var(--cqa-fs-12); }
      .muted2 { color: var(--cqa-ink-2); }
      .grow { flex: 1; }
      .rv-foot { border-top: 1px solid var(--cqa-line); padding-top: 14px; }
      .rv-prev b { font-size: 24px; }
      @container (max-width: 1100px) {
        .queue, .detail { flex-basis: 100%; }
        .qrow { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.2fr) 84px 44px 124px; padding: 0 12px; }
      }
      @container (max-width: 560px) {
        .closed { grid-template-columns: minmax(0, 1fr); }
      }
    `;
  }

  async load() {
    const epoch = (this._epoch += 1);
    this._phase = "loading";
    this.renderNow();
    try {
      await this.fetchAll();
      if (epoch !== this._epoch) return;
      this._phase = "ready";
      const wanted = parseAppealId(this.getAttribute("appeal-id"));
      this._selected = chooseSelection(visibleRows(this._list, this._tab), wanted !== null && this._list.some((a) => a.id === wanted) ? wanted : null, null);
      this.renderNow();
      if (this._selected !== null) this.ensureEval(this._selected);
    } catch (error) {
      if (epoch !== this._epoch) return;
      this._phase = "error";
      this._loadError = error;
      this.renderNow();
    }
  }

  async fetchAll() {
    const [list, summary] = await Promise.all([api.listAppeals({ status: "all" }), api.appealSummary().catch(() => null)]);
    this._list = list;
    this._summary = summary;
  }

  async refreshList() {
    const epoch = this._epoch;
    try {
      await this.fetchAll();
    } catch (error) {
      return;
    }
    if (epoch !== this._epoch) return;
    this.renderNow();
  }

  selectedAppeal() {
    return this._list.find((a) => a.id === this._selected) || null;
  }

  agingHours() {
    return this._summary && this._summary.agingHours ? this._summary.agingHours : DEFAULT_AGING_HOURS;
  }

  async ensureEval(id) {
    const appeal = this._list.find((a) => a.id === id);
    if (!appeal) return;
    const known = this._evals.get(id);
    if (known && known.status !== "error") return;
    this._evals.set(id, { status: "loading", ev: null });
    try {
      const ev = await api.getEvaluationById(appeal.evaluationId);
      this._evals.set(id, { status: "ok", ev });
    } catch (error) {
      this._evals.set(id, { status: "error", ev: null });
    }
    if (this._selected === id) this.renderNow();
  }

  select(id, explicit) {
    this._selected = id;
    this.renderNow();
    this.ensureEval(id);
    const appeal = this.selectedAppeal();
    if (explicit && appeal && appeal.status === "new" && can(this.role, "start-review")) this.startReview(id);
  }

  stateFor(appeal, def) {
    let state = this._panels.get(appeal.id);
    if (!state) {
      state = { decision: "change", newAnswer: defaultNewAnswer(def), reason: "", busy: false, error: null };
      this._panels.set(appeal.id, state);
    }
    return state;
  }

  template() {
    const locale = this.locale;
    const head = html`<div class="head"><h1 id="queue-title">${this.t("queue.title")}</h1><span class="sub">${this.t("queue.subtitle")}</span></div>`;
    if (this._phase === "loading") return html`<div class="screen">${head}${loadingPanel(locale)}</div>`;
    if (this._phase === "error") {
      const message = errorText("queue", this._loadError, locale, (key) => this.t(key));
      return html`<div class="screen">${head}${errorPanel(locale, { title: this.t("queue.err.title"), message })}</div>`;
    }
    return html`<div class="screen">${head}${this.summaryStrip()}<div class="grid">${this.queueCard()}${this.detailCard()}</div></div>`;
  }

  summaryStrip() {
    const s = this._summary;
    if (!s) return html``;
    const locale = this.locale;
    const cell = (key, value, extra = "") => html`<li class="${extra}" data-sum="${key}">${this.t(`queue.sum.${key}`, { hours: this.agingHours() })} <b>${number(value, locale, 0)}</b></li>`;
    return html`<ul class="sum" aria-label="${this.t("queue.sum.label")}">${cell("open", s.open)}${cell("new", s.new)}${cell("review", s.underReview)}${cell("aging", s.olderThanHours, s.olderThanHours > 0 ? "warn" : "")}</ul>`;
  }

  queueCard() {
    const locale = this.locale;
    const counts = tabCounts(this._list);
    const tabs = TABS.map(
      (tab) => html`<button type="button" aria-pressed="${this._tab === tab ? "true" : "false"}" data-action="tab" data-tab="${tab}" data-focus-id="tab-${tab}">${this.t(`queue.tab.${tab}`)} <span class="tnum" data-count="${tab}">${counts[tab]}</span></button>`
    );
    const rows = visibleRows(this._list, this._tab);
    const aging = this.agingHours();
    const body = rows.map((a) => {
      const on = a.id === this._selected;
      const warn = isAging(a, aging);
      return html`<button type="button" role="row" class="qrow${on ? " on" : ""}" aria-pressed="${on ? "true" : "false"}" aria-label="${rowLabel(a, locale)}" data-appeal-row="${a.id}" data-focus-id="row-${a.id}"><span role="cell" class="conv"><b class="tnum">${a.conversationId}</b>${langChip(a.language)}</span><span role="cell" title="${criterionTitle(a, locale)}"><span class="tnum muted">${a.criterionId}</span> ${criterionTitle(a, locale)}</span><span role="cell">${this.t("actor.operator")}</span><span role="cell" class="tnum age${warn ? " warn" : ""}" data-age>${ageText(a.ageHours, locale)}</span><span role="cell">${statusChip(a.status, locale)}</span></button>`;
    });
    const empty = rows.length ? html`` : html`<p class="none" data-queue-empty>${this.t("queue.empty")}</p>`;
    return html`<section class="card queue" aria-label="${this.t("queue.region")}"><div class="bar"><div class="seg" role="group" aria-label="${this.t("queue.tabsLabel")}">${tabs}</div><span class="sort">${this.t("queue.sort")}</span></div><div class="tbl-scroll"><div role="table" aria-label="${this.t("queue.tableLabel")}" aria-rowcount="${rows.length + 1}" data-table><div role="row" class="qrow qhead"><span role="columnheader">${this.t("queue.col.conv")}</span><span role="columnheader">${this.t("queue.col.crit")}</span><span role="columnheader">${this.t("queue.col.author")}</span><span role="columnheader">${this.t("queue.col.age")}</span><span role="columnheader">${this.t("queue.col.status")}</span></div>${body}${empty}</div></div></section>`;
  }

  detailCard() {
    const locale = this.locale;
    const appeal = this.selectedAppeal();
    if (!appeal) {
      return html`<section class="card detail" aria-label="${this.t("queue.detail")}" data-detail>${emptyPanel(locale, { title: this.t("queue.pick"), hint: this.t("queue.pickHint") })}</section>`;
    }
    const entry = this._evals.get(appeal.id) || { status: "loading", ev: null };
    const ev = entry.ev;
    const evCrit = ev ? ev.criteria.find((c) => c.id === appeal.criterionId) : null;
    const def = criterionDef(appeal);
    const title = criterionTitle(appeal, locale);
    const original = appeal.original;
    let pts = "";
    if (original && original.effPoints !== null && original.effPoints !== undefined) {
      const max = evCrit && evCrit.effWeight !== null && evCrit.effWeight !== undefined ? evCrit.effWeight : appeal.criterionWeight;
      if (max !== null && max !== undefined) pts = this.t("queue.pts", { earned: number(original.effPoints, locale), max: number(max, locale) });
    }
    const times = appeal.refs.map((r) => {
      const frag = appeal.fragment.find((f) => f.index === r.index);
      return frag && frag.time ? frag.time : `#${r.n}`;
    });
    const refsText = times.length ? this.t("review.refs", { list: times.join(", ") }) : this.t("review.refsNone");
    const versionLine = [appeal.versionLabel ? this.t("queue.version", { version: appeal.versionLabel }) : "", appeal.modelLabel ? this.t("queue.model", { model: appeal.modelLabel }) : ""].filter(Boolean).join(" · ");
    const start =
      appeal.status === "new" && can(this.role, "start-review")
        ? html`<button type="button" class="btn btn-sm" data-action="review-start" data-appeal="${appeal.id}" data-focus-id="rv-start-${appeal.id}" ${raw(this._busyStart.has(appeal.id) ? "disabled" : "")}>${this.t("review.start")}</button>`
        : html``;
    const lines = appeal.fragment.map(
      (f) => html`<div class="rv-line"><span class="t">${f.time}</span><span class="w">${this.t(`msg.${f.speaker}`)}</span><span class="x">${f.text}</span></div>`
    );
    const frag = appeal.fragment.length
      ? html`<div class="frag" data-rv-fragment><div class="frag-h"><span class="cap">${this.t("queue.fragment")}</span>${langChip(appeal.language)}<small>${this.t("queue.fragmentLang")}</small></div>${lines}</div>`
      : html``;
    const tail = isClosed(appeal) ? this.closedBlock(appeal) : this.decisionArea(appeal, entry, evCrit);
    const link = `#/conversations/${encodeURIComponent(appeal.conversationId)}`;
    return html`<section class="card detail" aria-labelledby="rv-h" data-detail="${appeal.id}"><div class="d-head"><h2 id="rv-h" tabindex="-1"><span class="tnum">${appeal.criterionId}</span> ${title}</h2>${statusChip(appeal.status, locale)}${start}<a class="open" href="${link}" data-open-card>${this.t("queue.openCard")} <span class="tnum">${appeal.conversationId}</span></a></div><span class="meta">${this.t("queue.meta", { actor: this.t("actor.operator"), age: ageText(appeal.ageHours, locale), conv: appeal.conversationId })}</span><div class="rv-grid"><div class="box"><span class="cap">${this.t("queue.original")}</span><div class="row gap-2">${original ? answerBadge(def, original.answer, locale) : html``}<span class="pts">${pts}</span></div><p class="ink2">${original ? original.rationale : ""}</p><span class="fs12 muted" data-version>${versionLine}</span></div><div class="box line"><span class="cap">${this.t("queue.argument")}</span><p>${appeal.comment}</p><span class="tnum fs12 muted">${refsText}</span></div></div>${frag}${tail}</section>`;
  }

  closedBlock(appeal) {
    const locale = this.locale;
    const fmt = (v) => (v === null || v === undefined ? "—" : number(v, locale));
    const when = appeal.decidedAt ? wallClock(appeal.decidedAt, locale) : "";
    const who = this.t("role.reviewer");
    return html`<div class="closed" data-closed><div><span class="fs12 muted">${this.t("queue.before")}</span><span class="v" data-before>${fmt(appeal.totalBefore)}</span></div><div><span class="fs12 muted">${this.t("queue.decision")}</span><span class="v sm" data-decision>${decisionText(appeal, locale)}</span></div><div><span class="fs12 muted">${this.t("queue.after")}</span><span class="v" data-after>${fmt(appeal.totalAfter)}</span></div></div><p class="reason" data-reason>${who}${when ? `, ${when}` : ""}: ${appeal.reason ?? ""}</p>`;
  }

  decisionArea(appeal, entry, evCrit) {
    const locale = this.locale;
    if (!can(this.role, "decide-appeal")) return html`<p class="readonly" data-readonly>${this.t("queue.readonly")}</p>`;
    if (entry.status === "loading") return html`<div role="status" aria-busy="true" class="muted fs12" data-eval-loading>${this.t("state.loading")}</div>`;
    if (entry.status === "error" || !evCrit) {
      return html`<div class="rv-err" role="alert" data-eval-error>${this.t("queue.evalError")} <button type="button" class="btn btn-sm" data-action="eval-retry" data-appeal="${appeal.id}">${this.t("action.retry")}</button></div>`;
    }
    const state = this.stateFor(appeal, evCrit);
    const options = allowedAnswers(evCrit).map((value) => ({ value, label: answerLabel(value, evCrit, locale) }));
    const preview = previewTotals(entry.ev, appeal.criterionId, state.decision, state.newAnswer);
    return html`<div class="dec" data-review="${appeal.id}">${decisionBlock({ id: appeal.id, state, options, preview }, locale)}</div>`;
  }

  panelOf(target) {
    const box = target && target.closest ? target.closest("[data-review]") : null;
    if (!box) return null;
    const id = Number(box.getAttribute("data-review"));
    const state = this._panels.get(id);
    return state ? { id, state, box } : null;
  }

  onChange(event) {
    const target = event.target;
    const kind = target && target.getAttribute ? target.getAttribute("data-rv") : null;
    if (!kind) return;
    const panel = this.panelOf(target);
    if (!panel) return;
    panel.state.error = null;
    if (kind === "decision") panel.state.decision = target.value;
    else if (kind === "answer") panel.state.newAnswer = answerValue(target.value);
    else return;
    this.renderNow();
  }

  onInput(event) {
    const target = event.target;
    if (!target || !target.getAttribute || target.getAttribute("data-rv") !== "reason") return;
    const panel = this.panelOf(target);
    if (!panel) return;
    panel.state.reason = target.value;
    panel.state.error = null;
    const save = panel.box.querySelector("[data-action=review-save]");
    const change = panel.state.decision === "change";
    if (save) save.disabled = panel.state.busy || !target.value.trim() || (change && (panel.state.newAnswer === null || panel.state.newAnswer === undefined));
  }

  onClick(event) {
    const el = event.target.closest ? event.target.closest("[data-action], [data-appeal-row]") : null;
    if (!el) return;
    if (el.hasAttribute("data-appeal-row")) {
      this.select(Number(el.getAttribute("data-appeal-row")), true);
      return;
    }
    const action = el.getAttribute("data-action");
    if (action === "tab") {
      this._tab = el.getAttribute("data-tab");
      this.renderNow();
    } else if (action === "retry") {
      this.load();
    } else if (action === "eval-retry") {
      this.ensureEval(Number(el.getAttribute("data-appeal")));
    } else if (action === "review-start") {
      this.startReview(Number(el.getAttribute("data-appeal")));
    } else if (action === "review-save") {
      this.saveDecision(Number(el.getAttribute("data-appeal")));
    }
  }

  onKeydown(event) {
    const target = event.target;
    if (!target || !target.closest || !target.closest("[data-table]")) return;
    if (TEXT_TARGETS.has(target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    const step = key === "j" || key === "ArrowDown" ? 1 : key === "k" || key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const rows = [...this.shadowRoot.querySelectorAll("[data-appeal-row]")];
    const at = rows.indexOf(target.closest("[data-appeal-row]"));
    const next = nextIndex(rows.length, at, step);
    if (next >= 0) rows[next].focus();
  }

  async startReview(id) {
    if (this._busyStart.has(id)) return;
    const appeal = this._list.find((a) => a.id === id);
    if (!appeal || appeal.status !== "new") return;
    this._busyStart.add(id);
    this.renderNow();
    try {
      await api.startReview(id);
      this._busyStart.delete(id);
      await this.refreshList();
      this.toast(this.t("review.started"), "ok");
    } catch (error) {
      this._busyStart.delete(id);
      const text = errorText("review", error, this.locale, (key) => this.t(key));
      this.toast(text, "bad");
      this.renderNow();
    }
  }

  async saveDecision(id) {
    const state = this._panels.get(id);
    const appeal = this._list.find((a) => a.id === id);
    const entry = this._evals.get(id);
    if (!state || !appeal || !entry || !entry.ev || state.busy) return;
    const change = state.decision === "change";
    const preview = previewTotals(entry.ev, appeal.criterionId, state.decision, state.newAnswer);
    state.busy = true;
    state.error = null;
    this.renderNow();
    try {
      const result = await api.decideAppeal(id, {
        decision: state.decision,
        newAnswer: change ? state.newAnswer : null,
        reason: state.reason.trim()
      });
      const decision = state.decision;
      this._panels.delete(id);
      this._evals.delete(id);
      await this.refreshList();
      const row = this.shadowRoot.querySelector(`[data-focus-id="row-${id}"]`);
      const target = row || this.shadowRoot.querySelector("#rv-h");
      if (target) target.focus();
      const before = result.totalBefore ?? (preview ? preview.before : null);
      const after = result.totalAfter ?? (preview ? preview.after : null);
      const locale = this.locale;
      const text =
        change && before !== after && before !== null && after !== null
          ? this.t("review.saved", { from: number(before, locale), to: number(after, locale) })
          : this.t("review.savedSame", { value: before === null ? "—" : number(before, locale) });
      this.toast(text, "ok");
      this.ensureEval(id);
      emit(this, EVENTS.decisionSaved, { conversationId: appeal.conversationId, criterion: appeal.criterionId, appealId: id, decision, totalBefore: before, totalAfter: after });
    } catch (error) {
      state.busy = false;
      state.error = errorText("review", error, this.locale, (key) => this.t(key));
      this.renderNow();
    }
  }

  toast(message, tone) {
    emit(this, EVENTS.toast, { message, tone });
  }
}
