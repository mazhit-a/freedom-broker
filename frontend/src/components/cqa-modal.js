import { CqaElement, html, raw } from "../base-element.js";
import { EVENTS, emit } from "../events.js";
import { captureFocus, deepActiveElement, focusableWithin, initialFocus, restoreFocus } from "../focus.js";
import { icon } from "../shared/icons.js";
import { SHARED_CSS } from "../shared/styles.js";

export class CqaModal extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "open", "heading", "description"];
  }

  constructor() {
    super();
    this._wasOpen = false;
    this._opener = null;
    this._reason = "attribute";
    this._inerted = [];
    this._onKeyCapture = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close("escape");
      } else if (event.key === "Tab") {
        this.trap(event);
      }
    };
    this._onFocusIn = (event) => {
      const path = event.composedPath();
      if (!path.includes(this) && !path.some((el) => el.tagName === "CQA-TOAST")) this.focusFirst();
    };
  }

  get open() {
    return this.hasAttribute("open");
  }

  set open(value) {
    if (value) this.setAttribute("open", "");
    else this.removeAttribute("open");
  }

  show(opener = null) {
    if (this.open) return;
    this._opener = opener || captureFocus();
    this._pendingOpener = true;
    this.setAttribute("open", "");
  }

  close(reason = "api") {
    if (!this.open) return;
    this._reason = reason;
    this.removeAttribute("open");
  }

  attributeChangedCallback(name, oldValue, value) {
    if (name === "open" && value !== null && oldValue === null && !this._pendingOpener) this._opener = captureFocus();
    if (name === "open" && value !== null) this._pendingOpener = false;
    super.attributeChangedCallback(name, oldValue, value);
  }

  disconnectedCallback() {
    this.release();
    this._wasOpen = false;
    super.disconnectedCallback();
  }

  styles() {
    return `${SHARED_CSS}
      :host { container-type: normal !important; }
      :host(:not([open])) .scrim { display: none; }
      .scrim { position: fixed; inset: 0; z-index: 900; display: grid; place-items: center; padding: 16px; background: color-mix(in srgb, var(--cqa-ink) 36%, transparent); font-size: var(--cqa-fs-14); color: var(--cqa-ink); }
      .dialog { width: min(520px, 100%); max-height: 90vh; display: flex; flex-direction: column; background: var(--cqa-surface); border-radius: 12px; box-shadow: var(--cqa-shadow); }
      .dialog:focus { outline: none; }
      .head { display: flex; align-items: center; gap: 12px; padding: 16px 20px 0; }
      h2 { margin: 0; flex: 1; font-size: var(--cqa-fs-16); font-weight: 600; }
      .desc { margin: 0; padding: 8px 20px 0; color: var(--cqa-ink-2); font-size: var(--cqa-fs-13); }
      .body { overflow: auto; padding: 12px 20px; display: flex; flex-direction: column; gap: 12px; }
      .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 0 20px 16px; }
    `;
  }

  template() {
    const description = this.getAttribute("description");
    return html`
      <div class="scrim" data-scrim>
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title" ${raw(description ? 'aria-describedby="modal-desc"' : "")} tabindex="-1">
          <div class="head">
            <h2 id="modal-title">${this.getAttribute("heading") || ""}</h2>
            <button type="button" class="btn btn-ghost btn-sm" data-action="close" data-focus-id="modal-close" aria-label="${this.t("action.close")}">${icon("close", 16)}</button>
          </div>
          ${description ? html`<p class="desc" id="modal-desc">${description}</p>` : html``}
          <div class="body"><slot></slot></div>
          <div class="foot"><slot name="footer"></slot></div>
        </div>
      </div>
    `;
  }

  focusables() {
    const dialog = this.shadowRoot.querySelector(".dialog");
    return dialog ? focusableWithin(dialog) : [];
  }

  focusFirst() {
    const dialog = this.shadowRoot.querySelector(".dialog");
    if (dialog) initialFocus(dialog, this.shadowRoot.querySelector("[data-action=close]"));
  }

  trap(event) {
    const list = this.focusables();
    if (list.length === 0) {
      event.preventDefault();
      return;
    }
    const current = deepActiveElement();
    const index = list.indexOf(current);
    let next;
    if (event.shiftKey) next = index <= 0 ? list[list.length - 1] : list[index - 1];
    else next = index === -1 || index === list.length - 1 ? list[0] : list[index + 1];
    event.preventDefault();
    next.focus();
  }

  hold() {
    const root = this.getRootNode();
    const top = root.children ? [...root.children] : [];
    this._inerted = top.filter((el) => el !== this && el.tagName !== "STYLE" && el.tagName !== "CQA-TOAST" && !el.contains(this) && !el.hasAttribute("inert"));
    for (const el of this._inerted) el.setAttribute("inert", "");
    globalThis.document.addEventListener("keydown", this._onKeyCapture, true);
    globalThis.document.addEventListener("focusin", this._onFocusIn, true);
  }

  release() {
    for (const el of this._inerted) el.removeAttribute("inert");
    this._inerted = [];
    globalThis.document.removeEventListener("keydown", this._onKeyCapture, true);
    globalThis.document.removeEventListener("focusin", this._onFocusIn, true);
  }

  afterRender(region) {
    region.querySelector("[data-action=close]").addEventListener("click", () => this.close("button"));
    region.querySelector("[data-scrim]").addEventListener("mousedown", (event) => {
      if (event.target === event.currentTarget) this.close("backdrop");
    });
    const open = this.open;
    if (open && !this._wasOpen) {
      this.hold();
      this.focusFirst();
    } else if (!open && this._wasOpen) {
      this.release();
      const opener = this._opener;
      this._opener = null;
      restoreFocus(opener);
      emit(this, EVENTS.close, { reason: this._reason });
      this._reason = "attribute";
    }
    this._wasOpen = open;
  }
}
