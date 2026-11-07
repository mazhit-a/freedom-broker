import { CqaElement, html } from "../base-element.js";
import { navigate } from "../events.js";
import { icon } from "../shared/icons.js";
import { SHARED_CSS } from "../shared/styles.js";

const DEFAULT_TIMEOUT = 3800;
const MAX_VISIBLE = 4;

export class CqaToast extends CqaElement {
  constructor() {
    super();
    this._items = [];
  }

  styles() {
    return `${SHARED_CSS}
      :host { container-type: normal !important; }
      .stack { position: fixed; right: 16px; bottom: 16px; z-index: 1000; width: min(420px, calc(100% - 32px)); display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
      .toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 10px; background: var(--cqa-ink); color: var(--cqa-surface); font-size: var(--cqa-fs-13); box-shadow: var(--cqa-shadow); }
      .toast.bad { background: var(--cqa-bad); }
      .toast .msg-text { flex: 1; overflow-wrap: anywhere; }
      .toast button { border: 0; background: transparent; color: inherit; font: 600 var(--cqa-fs-13) var(--cqa-font); text-decoration: underline; cursor: pointer; padding: 4px; border-radius: 4px; }
      .toast button.dismiss { text-decoration: none; display: inline-flex; opacity: .8; }
      .toast button:focus-visible { outline-color: var(--cqa-surface); }
    `;
  }

  template() {
    return html`<div class="stack" role="status" aria-live="polite" aria-label="${this.t("toast.region")}" data-stack></div>`;
  }

  afterRender(region) {
    const stack = region.querySelector("[data-stack]");
    for (const item of this._items) {
      item.node.querySelector(".dismiss").setAttribute("aria-label", this.t("action.close"));
      stack.append(item.node);
    }
  }

  show(message, { tone = "ok", timeout = DEFAULT_TIMEOUT, action = null } = {}) {
    const stack = this.shadowRoot.querySelector("[data-stack]");
    const node = globalThis.document.createElement("div");
    node.className = `toast ${tone === "bad" ? "bad" : ""}`.trim();
    const glyph = globalThis.document.createElement("span");
    glyph.innerHTML = String(icon(tone === "bad" ? "alert" : "check", 16));
    const text = globalThis.document.createElement("span");
    text.className = "msg-text";
    text.textContent = String(message);
    node.append(glyph, text);
    if (action && action.label) {
      const link = globalThis.document.createElement("button");
      link.type = "button";
      link.textContent = action.label;
      link.addEventListener("click", () => {
        navigate(this, action.to, action.id ?? null);
        this.dismiss(item);
      });
      node.append(link);
    }
    const close = globalThis.document.createElement("button");
    close.type = "button";
    close.className = "dismiss";
    close.setAttribute("aria-label", this.t("action.close"));
    close.innerHTML = String(icon("close", 14));
    close.addEventListener("click", () => this.dismiss(item));
    node.append(close);
    const item = { node, timer: null };
    this._items.push(item);
    while (this._items.length > MAX_VISIBLE) this.dismiss(this._items[0]);
    if (stack) stack.append(node);
    if (timeout > 0) item.timer = setTimeout(() => this.dismiss(item), timeout);
    return item;
  }

  dismiss(item) {
    const index = this._items.indexOf(item);
    if (index === -1) return;
    clearTimeout(item.timer);
    this._items.splice(index, 1);
    item.node.remove();
  }

  clear() {
    for (const item of [...this._items]) this.dismiss(item);
  }

  get count() {
    return this._items.length;
  }
}
