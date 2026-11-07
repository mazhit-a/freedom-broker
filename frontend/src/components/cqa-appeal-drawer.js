import { CqaElement, html, raw } from "../base-element.js";
import { initialFocus } from "../focus.js";
import { icon } from "../shared/icons.js";
import { SHARED_CSS } from "../shared/styles.js";
import { number } from "../format.js";
import { isCommentValid } from "./appeal-model.js";
import { answerBadge } from "./appeal-panel.js";

const STYLES = `${SHARED_CSS}
:host { display: contents; container-type: normal !important; }
[hidden] { display: none !important; }
aside { position: fixed; top: 0; right: 0; bottom: 0; z-index: 800; width: min(440px, 100%); display: flex; flex-direction: column; background: var(--cqa-surface); border-left: 1px solid var(--cqa-line); box-shadow: var(--cqa-shadow); font-size: var(--cqa-fs-14); color: var(--cqa-ink); }
aside:focus { outline: none; }
.head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--cqa-line); }
h2 { margin: 0; flex: 1; font-size: var(--cqa-fs-16); font-weight: 600; }
.body { flex: 1; overflow: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 16px; }
.foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--cqa-line); }
label.f { display: flex; flex-direction: column; gap: 6px; font-size: var(--cqa-fs-13); font-weight: 500; }
label.f small { font-weight: 400; color: var(--cqa-ink-3); font-size: var(--cqa-fs-12); }
select.field { width: 100%; }
textarea.field { height: auto; min-height: 120px; padding: 8px 10px; resize: vertical; font-family: var(--cqa-font); line-height: 1.45; }
.cur { padding: 12px; border-radius: 10px; background: var(--cqa-surface-2); display: flex; flex-direction: column; gap: 6px; }
.cur-top { display: flex; align-items: center; gap: 8px; }
.cur p { margin: 0; font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); overflow-wrap: anywhere; }
.refs { display: flex; flex-direction: column; gap: 6px; }
.refs-h { font-size: var(--cqa-fs-13); font-weight: 500; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.rc { display: inline-flex; align-items: center; height: 24px; border-radius: 6px; border: 1px solid var(--cqa-line-strong); background: var(--cqa-surface); font-size: var(--cqa-fs-12); font-variant-numeric: tabular-nums; }
.rc button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; height: 100%; padding: 0 6px; }
.rc button:first-child { border-radius: 6px 0 0 6px; }
.rc button:last-child { border-radius: 0 6px 6px 0; display: inline-flex; align-items: center; }
.rc button:hover { background: var(--cqa-surface-2); }
.hint { font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
.err { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--cqa-bad-bg); color: var(--cqa-bad); font-size: var(--cqa-fs-13); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

export class CqaAppealDrawer extends CqaElement {
  constructor() {
    super();
    this._model = null;
    this._wasOpen = false;
    this.onClose = null;
    this.onCriterion = null;
    this.onComment = null;
    this.onSubmit = null;
    this.onJump = null;
    this.onDetach = null;
    this._key = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented && this._model && this._model.open) {
        event.preventDefault();
        if (this.onClose) this.onClose("escape");
      }
    };
    const root = this.shadowRoot;
    root.addEventListener("click", (event) => this.click(event));
    root.addEventListener("change", (event) => {
      const target = event.target;
      if (target && target.getAttribute && target.getAttribute("data-field") === "criterion" && this.onCriterion) this.onCriterion(target.value);
    });
    root.addEventListener("input", (event) => {
      const target = event.target;
      if (!target || !target.getAttribute || target.getAttribute("data-field") !== "comment") return;
      this._model.comment = target.value;
      this.syncSubmit();
      if (this.onComment) this.onComment(target.value);
    });
  }

  styles() {
    return STYLES;
  }

  disconnectedCallback() {
    globalThis.document.removeEventListener("keydown", this._key);
    this._wasOpen = false;
    super.disconnectedCallback();
  }

  update(model) {
    this._model = model;
    if (this._ready) this.renderNow();
  }

  click(event) {
    const el = event.target && event.target.closest ? event.target.closest("[data-action]") : null;
    if (!el) return;
    const action = el.getAttribute("data-action");
    if (action === "close" && this.onClose) this.onClose("button");
    else if (action === "submit" && this.onSubmit) this.onSubmit();
    else if (action === "jump" && this.onJump) this.onJump(Number(el.getAttribute("data-index")));
    else if (action === "detach" && this.onDetach) this.onDetach(Number(el.getAttribute("data-index")));
  }

  syncSubmit() {
    const button = this.shadowRoot.querySelector("[data-action=submit]");
    if (button) button.disabled = !this.canSubmit();
  }

  canSubmit() {
    const m = this._model;
    return Boolean(m && !m.busy && isCommentValid(m.comment));
  }

  template() {
    const m = this._model;
    if (!m || !m.open) return html``;
    const locale = this.locale;
    const options = m.options.map((o) => html`<option value="${o.id}" ${raw(o.id === m.criterionId ? "selected" : "")}>${o.label}</option>`);
    const c = m.current;
    const points = c.points === null || c.points === undefined ? "—" : `${number(c.points, locale)} / ${c.max === null || c.max === undefined ? "—" : number(c.max, locale)}`;
    const chips = m.refs.map(
      (r) =>
        html`<span class="rc" data-ref="${r.index}"><button type="button" data-action="jump" data-index="${r.index}" aria-label="${this.t("appeal.refJump", { n: r.n })}">${this.t(`msg.${r.kind}`)} · ${r.time}</button><button type="button" data-action="detach" data-index="${r.index}" aria-label="${this.t("appeal.refRemove", { n: r.n })}">${icon("close", 12)}</button></span>`
    );
    const refsBlock = chips.length ? html`<div class="chips" data-ref-chips>${chips}</div>` : html``;
    const error = m.error ? html`<p class="err" role="alert" data-appeal-error>${m.error}</p>` : html``;
    const blocked = !this.canSubmit();
    return html`<aside role="dialog" aria-modal="false" aria-labelledby="ad-h" tabindex="-1" data-appeal-drawer><div class="head"><h2 id="ad-h">${this.t("appeal.drawerTitle")}</h2><button type="button" class="btn btn-ghost btn-sm" data-action="close" data-focus-id="ad-close" aria-label="${this.t("action.close")}">${icon("close", 16)}</button></div><div class="body"><label class="f">${this.t("appeal.criterion")}<select class="field" data-field="criterion" data-focus-id="ad-criterion">${options}</select></label><div class="cur" data-appeal-current><div class="cur-top"><span class="hint">${this.t("appeal.current")}</span>${answerBadge(c.criterion, c.answer, locale)}<b class="tnum" style="margin-left:auto;font-size:var(--cqa-fs-13)">${points}</b></div><p>${c.rationale}</p></div><label class="f">${this.t("appeal.comment")} <small>${this.t("appeal.commentHint")}</small><textarea class="field" data-field="comment" data-autofocus data-focus-id="ad-comment" aria-required="true">${m.comment}</textarea></label><div class="refs"><span class="refs-h">${this.t("appeal.refs")}</span>${refsBlock}<span class="hint">${this.t("appeal.refsHint")}</span></div><span class="hint" data-appeal-window>${m.windowText}</span>${error}</div><div class="foot"><button type="button" class="btn" data-action="close" data-focus-id="ad-cancel">${this.t("action.cancel")}</button><button type="button" class="btn btn-primary" data-action="submit" data-focus-id="ad-submit" ${raw(blocked ? "disabled" : "")}>${m.busy ? this.t("appeal.sending") : this.t("appeal.submit")}</button></div></aside>`;
  }

  afterRender(region) {
    const open = Boolean(this._model && this._model.open);
    if (open && !this._wasOpen) {
      globalThis.document.addEventListener("keydown", this._key);
      const panel = region.querySelector("aside");
      if (panel) initialFocus(panel, region.querySelector("[data-action=close]"));
    } else if (!open && this._wasOpen) {
      globalThis.document.removeEventListener("keydown", this._key);
    }
    this._wasOpen = open;
  }
}
