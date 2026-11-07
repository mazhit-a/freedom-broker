import { CqaElement, html, raw } from "../base-element.js";
import { EVENTS, emit, navigate } from "../events.js";
import { LOCALES } from "../i18n/index.js";
import { ROLES } from "../roles.js";
import { SHARED_CSS } from "../shared/styles.js";
import "./cqa-nav.js";

export class CqaHeader extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "route", "open-appeals"];
  }

  attributeChangedCallback(name, oldValue, value) {
    if (name === "route" || name === "open-appeals") {
      const nav = this.shadowRoot.querySelector("cqa-nav");
      if (nav) {
        if (value === null) nav.removeAttribute(name);
        else nav.setAttribute(name, value);
      }
      return;
    }
    super.attributeChangedCallback(name, oldValue, value);
  }

  styles() {
    return `${SHARED_CSS}
      :host { display: block; background: var(--cqa-surface); border-bottom: 1px solid var(--cqa-line); }
      header { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; padding: 0 24px; }
      .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--cqa-ink); border-radius: var(--cqa-radius-control); }
      .logo { width: 28px; height: 28px; border-radius: 8px; background: var(--cqa-brand-deep); color: var(--cqa-on-brand); display: grid; place-items: center; font-size: 11px; font-weight: 700; }
      .names { display: flex; flex-direction: column; line-height: 1.15; }
      .names b { font-size: 15px; font-weight: 600; }
      .names span { font-size: 11px; color: var(--cqa-ink-3); }
      .tools { margin-left: auto; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 0; }
      .role { display: flex; align-items: center; gap: 8px; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
      .role .field { height: 30px; }
      @container (max-width: 1100px) {
        header { gap: 8px 16px; padding: 0 16px; }
        .names span { display: none; }
        .tools { margin-left: 0; padding: 0 0 10px; width: 100%; }
      }
    `;
  }

  template() {
    const roles = ROLES.map(
      (key) => html`<option value="${key}" ${raw(key === this.role ? "selected" : "")}>${this.t(`role.${key}`)}</option>`
    );
    const locales = LOCALES.map(
      (key) => html`<button type="button" data-locale="${key}" data-focus-id="locale-${key}" aria-pressed="${key === this.locale ? "true" : "false"}">${key === "kk" ? "KZ" : key.toUpperCase()}</button>`
    );
    const actor = this.role === "operator" ? html`<span class="chip c-na" data-actor>${this.t("actor.operator")}</span>` : html``;
    return html`
      <header>
        <a class="brand" href="#/overview" data-focus-id="brand">
          <span class="logo" aria-hidden="true">FB</span>
          <span class="names"><b>CQA</b><span>${this.t("header.tagline")}</span></span>
        </a>
        <cqa-nav locale="${this.locale}" role="${this.role}" route="${this.getAttribute("route") || ""}" open-appeals="${this.getAttribute("open-appeals") || ""}"></cqa-nav>
        <div class="tools">
          <label class="role">${this.t("header.role")}
            <select class="field" data-role data-focus-id="role">${roles}</select>
          </label>
          ${actor}
          <div class="seg" role="group" aria-label="${this.t("header.locale")}">${locales}</div>
        </div>
      </header>
    `;
  }

  afterRender(region) {
    region.querySelector(".brand").addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(this, "overview");
    });
    region.querySelector("[data-role]").addEventListener("change", (event) => {
      const role = event.target.value;
      this.role = role;
      emit(this, EVENTS.roleChange, { role });
    });
    for (const button of region.querySelectorAll("[data-locale]")) {
      button.addEventListener("click", () => {
        const locale = button.getAttribute("data-locale");
        this.locale = locale;
        emit(this, EVENTS.localeChange, { locale });
      });
    }
  }
}
