import { api } from "../api.js";
import { html } from "../base-element.js";
import { EVENTS, emit } from "../events.js";
import { captureFocus, restoreFocus } from "../focus.js";
import { date, number } from "../format.js";
import { can } from "../roles.js";
import { CARD_EVENTS, wallClock } from "./card-model.js";
import { openAppeals } from "./card-history.js";
import { allowedAnswers, answerValue, candidateIds, defaultNewAnswer, errorText, fragmentFor, isCommentValid, previewTotals, refChips } from "./appeal-model.js";
import { answerLabel, reviewPanel } from "./appeal-panel.js";

const PICKABLE = new Set(["client", "operator"]);

export class AppealFlow {
  constructor(host) {
    this.host = host;
    this.drawer = null;
    this.isOpen = false;
    this.criterionId = null;
    this.comment = "";
    this.refs = [];
    this.busy = false;
    this.error = null;
    this.opener = null;
    this.panels = new Map();
    this.convId = null;
    this.scroll = null;
    host.addEventListener(CARD_EVENTS.appealRequest, (event) => {
      if (event.detail && event.detail.criterionId) this.open(event.detail.criterionId);
    });
    const root = host.shadowRoot;
    root.addEventListener("change", (event) => this.onChange(event));
    root.addEventListener("input", (event) => this.onInput(event));
    root.addEventListener(
      "scroll",
      (event) => {
        const target = event.target;
        if (target && target.hasAttribute && target.hasAttribute("data-transcript")) this.scroll = { id: this.convId, top: target.scrollTop };
      },
      true
    );
  }

  t(key, params) {
    return this.host.t(key, params);
  }

  evaluation() {
    return this.host._evaluation;
  }

  view() {
    return this.host._view;
  }

  open(criterionId) {
    const host = this.host;
    if (!can(host.role, "file-appeal") || !this.evaluation() || !this.view()) return;
    if (this.isOpen) {
      this.setCriterion(criterionId);
      return;
    }
    this.opener = captureFocus();
    this.isOpen = true;
    this.criterionId = criterionId;
    this.comment = "";
    this.refs = [];
    this.busy = false;
    this.error = null;
    host.renderNow();
    this.syncDrawer();
  }

  setCriterion(id) {
    if (!this.view().byId[id]) return;
    this.criterionId = id;
    this.error = null;
    this.host.select(id);
    this.syncDrawer();
  }

  ensureDrawer() {
    if (this.drawer) return this.drawer;
    const el = globalThis.document.createElement("cqa-appeal-drawer");
    el.onClose = (reason) => this.close(reason);
    el.onCriterion = (id) => this.setCriterion(id);
    el.onComment = (text) => {
      this.comment = text;
      this.error = null;
    };
    el.onSubmit = () => this.submit();
    el.onJump = (index) => this.host.scrollToMessage(index);
    el.onDetach = (index) => this.toggleRef(index);
    this.host.shadowRoot.append(el);
    this.drawer = el;
    return el;
  }

  model() {
    const host = this.host;
    const view = this.view();
    const ev = this.evaluation();
    const crit = view.byId[this.criterionId];
    const def = ev.criteria.find((c) => c.id === this.criterionId);
    const ids = candidateIds(view, ev);
    if (!ids.includes(this.criterionId)) ids.push(this.criterionId);
    const days = ev.appealWindowWorkdays ?? 5;
    const deadline = ev.appealDeadline ? ` ${this.t("appeal.deadline", { date: date(ev.appealDeadline, host.locale) })}` : "";
    return {
      open: this.isOpen,
      criterionId: this.criterionId,
      options: ids.map((id) => ({ id, label: `${id} ${view.byId[id].title}` })),
      current: {
        criterion: def,
        answer: crit.answer,
        points: crit.effPoints,
        max: crit.na ? null : crit.effWeight,
        rationale: crit.rationale || crit.naCondition || ""
      },
      comment: this.comment,
      refs: refChips(view, this.refs),
      windowText: this.t("appeal.window", { days: String(days) }) + deadline,
      error: this.error,
      busy: this.busy
    };
  }

  syncDrawer() {
    const el = this.ensureDrawer();
    el.setAttribute("locale", this.host.locale);
    if (!this.isOpen || !this.view() || !this.view().byId[this.criterionId]) {
      el.update({ open: false });
      return;
    }
    el.update(this.model());
  }

  close(reason) {
    if (!this.isOpen) return;
    const id = this.criterionId;
    this.isOpen = false;
    this.comment = "";
    this.refs = [];
    this.busy = false;
    this.error = null;
    this.syncDrawer();
    this.host.renderNow();
    this.returnFocus(id, reason);
  }

  returnFocus(id) {
    const opener = this.opener;
    this.opener = null;
    if (restoreFocus(opener)) return;
    const row = this.host.shadowRoot.querySelector(`[data-focus-id="pick-${id}"]`);
    if (row) row.focus();
  }

  toggleRef(index) {
    this.refs = this.refs.includes(index) ? this.refs.filter((i) => i !== index) : [...this.refs, index].sort((a, b) => a - b);
    this.paintRefs();
    this.syncDrawer();
  }

  paintRefs() {
    const root = this.host.shadowRoot;
    for (const li of root.querySelectorAll("li[data-index]")) {
      const index = Number(li.getAttribute("data-index"));
      const on = this.isOpen && this.refs.includes(index);
      const bubble = li.querySelector("[data-bubble]");
      if (bubble) bubble.classList.toggle("msg-attached", on);
      const button = li.querySelector("[data-action=attach]");
      if (!button) continue;
      const n = index + 1;
      button.setAttribute("aria-pressed", on ? "true" : "false");
      button.setAttribute("aria-label", this.t(on ? "appeal.detachAria" : "appeal.attachAria", { n }));
      button.textContent = this.t(on ? "appeal.attached" : "appeal.attach");
    }
  }

  async refresh() {
    const host = this.host;
    const ev = this.evaluation();
    host._evaluation = await api.getEvaluation(host.conversationId(), ev.versionId);
  }

  async submit() {
    if (this.busy || !isCommentValid(this.comment)) return;
    const host = this.host;
    const ev = this.evaluation();
    const id = this.criterionId;
    this.busy = true;
    this.error = null;
    this.syncDrawer();
    try {
      const appeal = await api.submitAppeal(ev.id, id, { comment: this.comment.trim(), refs: this.refs.slice() });
      await this.refresh();
      this.isOpen = false;
      this.busy = false;
      this.comment = "";
      this.refs = [];
      this.syncDrawer();
      host.renderNow();
      this.returnFocus(id);
      host.toast(this.t("appeal.submitted"), "ok");
      emit(host, EVENTS.appealSubmitted, { conversationId: host._conversation.id, criterion: id, appealId: appeal.id });
    } catch (error) {
      this.busy = false;
      this.error = errorText("appeal", error, host.locale, (key) => this.t(key));
      this.syncDrawer();
    }
  }

  banner() {
    return this.isOpen ? html`<div class="appeal-banner" role="status" data-appeal-banner>${this.t("appeal.banner")}</div>` : html``;
  }

  extra(message) {
    if (!this.isOpen || !PICKABLE.has(message.kind)) return null;
    const on = this.refs.includes(message.index);
    const key = on ? "appeal.detachAria" : "appeal.attachAria";
    return html`<button type="button" class="btn btn-sm attach-btn" data-action="attach" data-msg="${message.index}" aria-pressed="${on ? "true" : "false"}" aria-label="${this.t(key, { n: message.n })}">${this.t(on ? "appeal.attached" : "appeal.attach")}</button>`;
  }

  stateFor(appeal, def) {
    let state = this.panels.get(appeal.id);
    if (!state) {
      state = { decision: "change", newAnswer: defaultNewAnswer(def), reason: "", busy: false, error: null };
      this.panels.set(appeal.id, state);
    }
    return state;
  }

  reviewSection(view, ev) {
    const host = this.host;
    if (!can(host.role, "decide-appeal")) return html``;
    const locale = host.locale;
    const panels = openAppeals(ev).map((appeal) => {
      const def = ev.criteria.find((c) => c.id === appeal.criterionId);
      const crit = view.byId[appeal.criterionId];
      if (!def || !crit) return html``;
      const state = this.stateFor(appeal, def);
      const options = allowedAnswers(def).map((value) => ({ value, label: answerLabel(value, def, locale) }));
      const times = refChips(view, appeal.refs.map((r) => r.index)).map((r) => r.time);
      return reviewPanel(
        {
          id: appeal.id,
          criterion: def,
          title: crit.title,
          appeal,
          state,
          options,
          preview: previewTotals(ev, appeal.criterionId, state.decision, state.newAnswer),
          fragment: fragmentFor(view, def, appeal),
          refsText: times.length ? this.t("review.refs", { list: times.join(", ") }) : this.t("review.refsNone"),
          filed: this.t("review.filed", { when: wallClock(appeal.createdAt, locale), actor: this.t("actor.operator") })
        },
        locale
      );
    });
    return html`${panels}`;
  }

  panelOf(target) {
    const box = target && target.closest ? target.closest("[data-review]") : null;
    if (!box) return null;
    const id = Number(box.getAttribute("data-review"));
    const state = this.panels.get(id);
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
    this.host.renderNow();
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

  handleClick(action, el) {
    if (action === "attach") {
      this.toggleRef(Number(el.getAttribute("data-msg")));
      return true;
    }
    if (action === "review-start") {
      this.startReview(Number(el.getAttribute("data-appeal")));
      return true;
    }
    if (action === "review-save") {
      this.saveDecision(Number(el.getAttribute("data-appeal")));
      return true;
    }
    return false;
  }

  async startReview(id) {
    const state = this.panels.get(id);
    if (!state || state.busy) return;
    const host = this.host;
    state.busy = true;
    state.error = null;
    host.renderNow();
    try {
      await api.startReview(id);
      await this.refresh();
      state.busy = false;
      host.renderNow();
      host.toast(this.t("review.started"), "ok");
    } catch (error) {
      state.busy = false;
      state.error = errorText("review", error, host.locale, (key) => this.t(key));
      host.renderNow();
    }
  }

  async saveDecision(id) {
    const state = this.panels.get(id);
    const host = this.host;
    const ev = this.evaluation();
    const appeal = ev && openAppeals(ev).find((a) => a.id === id);
    if (!state || !appeal || state.busy) return;
    const change = state.decision === "change";
    const preview = previewTotals(ev, appeal.criterionId, state.decision, state.newAnswer);
    state.busy = true;
    state.error = null;
    host.renderNow();
    try {
      const result = await api.decideAppeal(id, {
        decision: state.decision,
        newAnswer: change ? state.newAnswer : null,
        reason: state.reason.trim()
      });
      await this.refresh();
      this.panels.delete(id);
      host.renderNow();
      const row = host.shadowRoot.querySelector(`[data-focus-id="pick-${appeal.criterionId}"]`);
      if (row) row.focus();
      const before = result.totalBefore ?? (preview ? preview.before : null);
      const after = result.totalAfter ?? (preview ? preview.after : null);
      const locale = host.locale;
      const text =
        change && before !== after && before !== null && after !== null
          ? this.t("review.saved", { from: number(before, locale), to: number(after, locale) })
          : this.t("review.savedSame", { value: before === null ? "—" : number(before, locale) });
      host.toast(text, "ok");
      emit(host, EVENTS.decisionSaved, {
        conversationId: host._conversation.id,
        criterion: appeal.criterionId,
        appealId: id,
        decision: state.decision,
        totalBefore: before,
        totalAfter: after
      });
    } catch (error) {
      state.busy = false;
      state.error = errorText("review", error, host.locale, (key) => this.t(key));
      host.renderNow();
    }
  }

  afterRender() {
    const host = this.host;
    const conv = host._conversation;
    const id = conv ? conv.id : null;
    if (id === null || (this.convId !== null && id !== this.convId)) {
      this.scroll = null;
      this.panels.clear();
      if (this.isOpen) {
        this.isOpen = false;
        this.refs = [];
        this.comment = "";
        this.syncDrawer();
      }
    }
    this.convId = id;
    if (this.isOpen && !can(host.role, "file-appeal")) {
      this.isOpen = false;
      this.syncDrawer();
    }
    this.paintRefs();
    const box = host.shadowRoot.querySelector("[data-transcript]");
    if (box && this.scroll && this.scroll.id === this.convId && box.scrollTop !== this.scroll.top) box.scrollTop = this.scroll.top;
    if (this.drawer && this.isOpen) this.syncDrawer();
  }
}
