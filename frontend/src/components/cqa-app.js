import { api, ensureConfigured } from "../api.js";
import { CqaElement, html } from "../base-element.js";
import { EVENTS, emit } from "../events.js";
import { setLocale } from "../i18n/index.js";
import { ID_ATTRIBUTE, formatHash, parseHash, screenTag } from "../routes.js";
import { SHARED_CSS } from "../shared/styles.js";
import { emptyPanel } from "../shared/state-panel.js";
import "./cqa-header.js";
import "./cqa-modal.js";
import "./cqa-toast.js";

export class CqaApp extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "route"];
  }

  constructor() {
    super();
    this._built = false;
    this._route = null;
    this._screen = null;
    this._screenKey = null;
    this._openAppeals = null;
    this._countToken = 0;
    this._confirm = null;
    this._onHash = () => this.syncRoute(true);
    this._onNavigate = (event) => {
      if (event.composedPath()[0] === this || (event.detail && event.detail.source === "hash")) return;
      const { to, id = null } = event.detail || {};
      this.go(to, id);
    };
    this._onLocale = (event) => {
      const locale = event.detail.locale;
      setLocale(locale);
      this.locale = locale;
    };
    this._onRole = (event) => {
      this.role = event.detail.role;
    };
    this._onCount = () => this.refreshCounts();
    this._onToast = (event) => {
      const { message, tone, timeout, action } = event.detail || {};
      if (message) this.toast(message, { tone, timeout, action });
    };
    this._onConfirm = (event) => {
      if (event.detail) this.confirm(event.detail).then((value) => event.detail.resolve && event.detail.resolve(value));
    };
  }

  styles() {
    return `${SHARED_CSS}
      :host { display: block; container-type: normal !important; font-size: var(--cqa-fs-14); color: var(--cqa-ink); background: var(--cqa-surface-2); }
      .shell { container-type: inline-size; min-height: 100%; }
      main { max-width: 1440px; margin: 0 auto; padding: 24px 24px 48px; display: flex; flex-direction: column; gap: 16px; }
      main:focus { outline: none; }
      h1 { margin: 0; font-size: var(--cqa-fs-24); font-weight: 600; letter-spacing: -0.01em; }
      p { margin: 0; color: var(--cqa-ink-3); font-size: var(--cqa-fs-13); }
      .placeholder { display: flex; flex-direction: column; gap: 4px; }
      .btn[hidden] { display: none; }
      @container (max-width: 1100px) { main { padding: 16px 16px 32px; } }
    `;
  }

  template() {
    return html`
      <div class="shell">
        <cqa-header></cqa-header>
        <main id="main" tabindex="-1" data-outlet></main>
      </div>
      <cqa-toast></cqa-toast>
      <cqa-modal data-confirm>
        <button slot="footer" type="button" class="btn" data-confirm-cancel></button>
        <button slot="footer" type="button" class="btn btn-primary" data-confirm-ok></button>
        <button slot="footer" type="button" class="btn btn-primary" data-confirm-extra hidden>${this.t("action.confirm")}</button>
      </cqa-modal>
    `;
  }

  connectedCallback() {
    globalThis.addEventListener("hashchange", this._onHash);
    this.addEventListener(EVENTS.navigate, this._onNavigate);
    this.addEventListener(EVENTS.localeChange, this._onLocale);
    this.addEventListener(EVENTS.roleChange, this._onRole);
    this.addEventListener(EVENTS.appealSubmitted, this._onCount);
    this.addEventListener(EVENTS.decisionSaved, this._onCount);
    this.addEventListener(EVENTS.toast, this._onToast);
    this.addEventListener(EVENTS.confirm, this._onConfirm);
    super.connectedCallback();
  }

  disconnectedCallback() {
    globalThis.removeEventListener("hashchange", this._onHash);
    this.removeEventListener(EVENTS.navigate, this._onNavigate);
    this.removeEventListener(EVENTS.localeChange, this._onLocale);
    this.removeEventListener(EVENTS.roleChange, this._onRole);
    this.removeEventListener(EVENTS.appealSubmitted, this._onCount);
    this.removeEventListener(EVENTS.decisionSaved, this._onCount);
    this.removeEventListener(EVENTS.toast, this._onToast);
    this.removeEventListener(EVENTS.confirm, this._onConfirm);
    this._built = false;
    super.disconnectedCallback();
  }

  attributeChangedCallback(name, oldValue, value) {
    if (name === "route") {
      if (this._ready) this.syncRoute(false);
      return;
    }
    super.attributeChangedCallback(name, oldValue, value);
  }

  onReady() {
    const settings = ensureConfigured();
    if (!this.hasAttribute("role") && settings.role) this.role = settings.role;
    this.refreshCounts();
  }

  go(to, id = null) {
    const next = formatHash(to, id);
    if (globalThis.location.hash !== next) globalThis.location.hash = next;
    else this.syncRoute(true);
  }

  currentRoute() {
    const hash = globalThis.location ? globalThis.location.hash : "";
    if (hash && hash !== "#") return parseHash(hash);
    return parseHash(this.getAttribute("route") || "");
  }

  renderNow() {
    if (!this._built) {
      super.renderNow();
      this._built = true;
      this.bindConfirm();
    }
    const lang = this.locale;
    this.setAttribute("lang", lang);
    this.update();
  }

  update() {
    const root = this.shadowRoot;
    const route = this.currentRoute();
    const header = root.querySelector("cqa-header");
    header.setAttribute("locale", this.locale);
    header.setAttribute("role", this.role);
    header.setAttribute("route", route.known ? route.name : "");
    if (this._openAppeals !== null) header.setAttribute("open-appeals", String(this._openAppeals));
    else header.removeAttribute("open-appeals");
    for (const el of root.querySelectorAll("cqa-toast, cqa-modal")) el.setAttribute("locale", this.locale);
    const ok = root.querySelector("[data-confirm-ok]");
    const cancel = root.querySelector("[data-confirm-cancel]");
    if (!this._confirm) {
      ok.textContent = this.t("action.confirm");
      cancel.textContent = this.t("action.cancel");
    }
    this.renderRoute(route);
  }

  renderRoute(route) {
    const outlet = this.shadowRoot.querySelector("[data-outlet]");
    const key = route.path;
    const tag = route.known ? screenTag(route) : null;
    const defined = tag && globalThis.customElements && globalThis.customElements.get(tag);
    if (defined) {
      if (this._screenKey !== key || !this._screen || this._screen.localName !== tag) {
        const screen = globalThis.document.createElement(tag);
        const idAttr = ID_ATTRIBUTE[route.name];
        if (route.id !== null && idAttr) screen.setAttribute(idAttr, route.id);
        outlet.replaceChildren(screen);
        this._screen = screen;
      }
      this._screen.setAttribute("locale", this.locale);
      this._screen.setAttribute("role", this.role);
    } else {
      this._screen = null;
      outlet.innerHTML = String(this.placeholder(route));
      const action = outlet.querySelector("[data-action=empty-action]");
      if (action) action.addEventListener("click", () => this.go("overview"));
    }
    this._screenKey = key;
    this._route = route;
  }

  placeholder(route) {
    if (!route.known) {
      return emptyPanel(this.locale, {
        title: this.t("app.notFound"),
        hint: this.t("app.notFoundHint"),
        actionLabel: this.t("nav.overview")
      });
    }
    const title = this.t(`nav.${route.name}`);
    const detail = route.id !== null ? html`<p data-route-id>${route.id}</p>` : html``;
    return html`<section class="placeholder" data-placeholder="${route.path}"><h1 id="title">${title}</h1>${detail}<p>${this.t("app.placeholder")}</p></section>`;
  }

  syncRoute(userDriven) {
    const before = this._route ? this._route.path : null;
    const route = this.currentRoute();
    if (this._ready && this._built) {
      this.update();
      if (userDriven && route.path !== before) {
        this.shadowRoot.querySelector("main").focus({ preventScroll: true });
        emit(this, EVENTS.navigate, { to: route.name, id: route.id, source: "hash" });
        this.refreshCounts();
      }
    }
  }

  async refreshCounts() {
    const token = (this._countToken += 1);
    try {
      const summary = await api.appealSummary();
      if (token !== this._countToken) return;
      this._openAppeals = summary.open;
    } catch (error) {
      if (token !== this._countToken) return;
      this._openAppeals = null;
    }
    if (this._built) this.update();
  }

  toast(message, options = {}) {
    const toast = this.shadowRoot.querySelector("cqa-toast");
    return toast.show(message, options);
  }

  bindConfirm() {
    const modal = this.shadowRoot.querySelector("[data-confirm]");
    const finish = (value) => {
      const pending = this._confirm;
      if (!pending) return;
      this._confirm = null;
      pending.settle(value);
      modal.close(value ? "confirm" : "cancel");
    };
    this.shadowRoot.querySelector("[data-confirm-ok]").addEventListener("click", () => finish(true));
    this.shadowRoot.querySelector("[data-confirm-cancel]").addEventListener("click", () => finish(false));
    this.shadowRoot.querySelector("[data-confirm-extra]").addEventListener("click", () => finish("extra"));
    modal.addEventListener(EVENTS.close, (event) => {
      event.stopPropagation();
      finish(false);
    });
  }

  confirm({ heading = "", description = "", confirmLabel = null, cancelLabel = null, extraLabel = null } = {}) {
    const modal = this.shadowRoot.querySelector("[data-confirm]");
    if (this._confirm) this._confirm.settle(false);
    return new Promise((resolve) => {
      this._confirm = { settle: resolve };
      modal.setAttribute("heading", heading);
      if (description) modal.setAttribute("description", description);
      else modal.removeAttribute("description");
      const extra = this.shadowRoot.querySelector("[data-confirm-extra]");
      const okButton = this.shadowRoot.querySelector("[data-confirm-ok]");
      extra.hidden = !extraLabel;
      extra.textContent = extraLabel || this.t("action.confirm");
      okButton.classList.toggle("btn-primary", !extraLabel);
      okButton.textContent = confirmLabel || this.t("action.confirm");
      this.shadowRoot.querySelector("[data-confirm-cancel]").textContent = cancelLabel || this.t("action.cancel");
      modal.show();
    });
  }
}
