import { CqaElement, html } from "../base-element.js";
import { EVENTS, emit } from "../events.js";
import { captureFocus, initialFocus, restoreFocus } from "../focus.js";
import { icon } from "../shared/icons.js";
import { SHARED_CSS } from "../shared/styles.js";

export class CqaDrawer extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "open", "heading"];
  }

  constructor() {
    super();
    this._wasOpen = false;
    this._opener = null;
    this._reason = "attribute";
    this._onKey = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        this.close("escape");
      }
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
    globalThis.document.removeEventListener("keydown", this._onKey);
    this._wasOpen = false;
    super.disconnectedCallback();
  }

  styles() {
    return `${SHARED_CSS}
      :host { container-type: normal !important; }
      :host(:not([open])) aside { display: none; }
      aside { position: fixed; top: 0; right: 0; bottom: 0; z-index: 800; width: min(440px, 100%); display: flex; flex-direction: column; background: var(--cqa-surface); border-left: 1px solid var(--cqa-line); box-shadow: var(--cqa-shadow); font-size: var(--cqa-fs-14); color: var(--cqa-ink); }
      aside:focus { outline: none; }
      .head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--cqa-line); }
      h2 { margin: 0; flex: 1; font-size: var(--cqa-fs-16); font-weight: 600; }
      .body { flex: 1; overflow: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
      .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--cqa-line); }
      .foot[hidden] { display: none; }
    `;
  }

  template() {
    return html`
      <aside role="dialog" aria-modal="false" aria-labelledby="drawer-title" tabindex="-1">
        <div class="head">
          <h2 id="drawer-title">${this.getAttribute("heading") || ""}</h2>
          <button type="button" class="btn btn-ghost btn-sm" data-action="close" data-focus-id="drawer-close" aria-label="${this.t("action.close")}">${icon("close", 16)}</button>
        </div>
        <div class="body"><slot></slot></div>
        <div class="foot"><slot name="footer"></slot></div>
      </aside>
    `;
  }

  afterRender(region) {
    region.querySelector("[data-action=close]").addEventListener("click", () => this.close("button"));
    region.querySelector(".foot").hidden = !this.querySelector(":scope > [slot=footer]");
    const open = this.open;
    if (open && !this._wasOpen) {
      globalThis.document.addEventListener("keydown", this._onKey);
      const panel = region.querySelector("aside");
      initialFocus(panel, region.querySelector("[data-action=close]"));
    } else if (!open && this._wasOpen) {
      globalThis.document.removeEventListener("keydown", this._onKey);
      const opener = this._opener;
      this._opener = null;
      restoreFocus(opener);
      emit(this, EVENTS.close, { reason: this._reason });
      this._reason = "attribute";
    }
    this._wasOpen = open;
  }
}
