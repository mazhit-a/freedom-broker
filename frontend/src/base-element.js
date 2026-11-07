import { getLocale, normalizeLocale, subscribe, t } from "./i18n/index.js";
import { DEFAULT_ROLE, normalizeRole } from "./roles.js";

const HostBase = globalThis.HTMLElement || class {};
const TOKENS_URL = new URL("../styles/tokens.css", import.meta.url).href;

let tokensPromise = null;

export function loadTokens() {
  if (!tokensPromise) {
    tokensPromise = fetch(TOKENS_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`tokens.css ${response.status}`);
        return response.text();
      })
      .then((css) => {
        if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype)) {
          return { css, sheet: null };
        }
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        return { css, sheet };
      })
      .catch(() => ({ css: "", sheet: null }));
  }
  return tokensPromise;
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const text = value && value.__raw !== undefined ? value.__raw : escapeHtml(value);
    out += text + strings[i + 1];
  }
  return { __raw: out, toString: () => out };
}

export function raw(text) {
  return { __raw: String(text), toString: () => String(text) };
}

export function escapeHtml(value) {
  if (value === null || value === undefined || value === false) return "";
  if (Array.isArray(value)) return value.map((v) => (v && v.__raw !== undefined ? v.__raw : escapeHtml(v))).join("");
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class CqaElement extends HostBase {
  static get observedAttributes() {
    return ["locale", "role"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._ready = false;
    this._scheduled = false;
    this._unsubscribe = null;
    this._tokensLink = null;
  }

  get locale() {
    const attr = this.getAttribute("locale");
    return attr ? normalizeLocale(attr) : getLocale();
  }

  set locale(value) {
    this.setAttribute("locale", normalizeLocale(value));
  }

  get role() {
    return normalizeRole(this.getAttribute("role") || DEFAULT_ROLE);
  }

  set role(value) {
    this.setAttribute("role", normalizeRole(value));
  }

  t(key, params) {
    return t(key, params, this.locale);
  }

  styles() {
    return "";
  }

  template() {
    return "";
  }

  connectedCallback() {
    this._unsubscribe = subscribe(() => {
      if (!this.hasAttribute("locale")) this.scheduleRender();
    });
    loadTokens().then(({ css, sheet }) => {
      if (!this.isConnected) return;
      if (sheet) {
        this.shadowRoot.adoptedStyleSheets = [sheet];
      } else if (css) {
        const style = document.createElement("style");
        style.textContent = css;
        this.shadowRoot.prepend(style);
      }
      this._ready = true;
      this.renderNow();
      this.onReady();
    });
  }

  disconnectedCallback() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
  }

  attributeChangedCallback() {
    if (this._ready) this.scheduleRender();
  }

  onReady() {}

  scheduleRender() {
    if (this._scheduled) return;
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      if (this.isConnected) this.renderNow();
    });
  }

  renderNow() {
    const lang = this.locale;
    this.setAttribute("lang", lang);
    let region = this.shadowRoot.querySelector("[data-root]");
    if (!region) {
      region = document.createElement("div");
      region.setAttribute("data-root", "");
      this.shadowRoot.append(region);
      const style = document.createElement("style");
      style.textContent = this.styles();
      this.shadowRoot.prepend(style);
    }
    region.innerHTML = String(this.template());
    this.afterRender(region);
  }

  afterRender() {}
}
