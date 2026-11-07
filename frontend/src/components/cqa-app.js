import { CqaElement, html, raw } from "../base-element.js";
import { LOCALES, setLocale } from "../i18n/index.js";
import { ROLES } from "../roles.js";

const NAV = ["overview", "conversations", "appeals", "checklists", "runs"];

export class CqaApp extends CqaElement {
  styles() {
    return `
      :host { display: block; min-height: 100vh; font-size: var(--cqa-fs-14); }
      header { display: flex; flex-wrap: wrap; align-items: center; gap: var(--cqa-space-4); padding: var(--cqa-space-3) var(--cqa-space-6); background: var(--cqa-surface); border-bottom: 1px solid var(--cqa-line); }
      .brand { font-size: var(--cqa-fs-16); font-weight: 600; color: var(--cqa-brand-deep); }
      nav { display: flex; gap: var(--cqa-space-2); flex: 1; }
      nav a { display: inline-flex; align-items: center; height: var(--cqa-control-h); padding: 0 var(--cqa-space-3); border-radius: var(--cqa-radius-control); color: var(--cqa-ink-2); text-decoration: none; }
      nav a[aria-current="page"] { background: var(--cqa-brand-tint); color: var(--cqa-brand-deep); font-weight: 600; }
      select { height: var(--cqa-control-h); padding: 0 var(--cqa-space-2); border: 1px solid var(--cqa-line-strong); border-radius: var(--cqa-radius-control); background: var(--cqa-surface); color: var(--cqa-ink); font: inherit; }
      main { padding: var(--cqa-space-6); }
      h1 { margin: 0 0 var(--cqa-space-1); font-size: var(--cqa-fs-24); font-weight: 600; letter-spacing: -0.01em; }
      p { margin: 0; color: var(--cqa-ink-3); font-size: var(--cqa-fs-13); }
    `;
  }

  template() {
    const current = this.getAttribute("route") || "overview";
    const navItems = NAV.map(
      (key) => html`<a href="#/${raw(key)}" ${raw(key === current ? 'aria-current="page"' : "")}>${this.t(`nav.${key}`)}</a>`
    );
    const roles = ROLES.map(
      (key) => html`<option value="${key}" ${raw(key === this.role ? "selected" : "")}>${this.t(`role.${key}`)}</option>`
    );
    const locales = LOCALES.map(
      (key) => html`<option value="${key}" ${raw(key === this.locale ? "selected" : "")}>${key.toUpperCase()}</option>`
    );
    return html`
      <header>
        <span class="brand">CQA</span>
        <nav aria-label="${this.t("nav.label")}">${navItems}</nav>
        <select data-role aria-label="${this.t("header.role")}">${roles}</select>
        <select data-locale aria-label="${this.t("header.locale")}">${locales}</select>
      </header>
      <main>
        <h1 id="title">${this.t("app.title")}</h1>
        <p>${this.t("app.subtitle")}</p>
      </main>
    `;
  }

  afterRender(region) {
    region.querySelector("[data-role]").addEventListener("change", (event) => {
      this.role = event.target.value;
    });
    region.querySelector("[data-locale]").addEventListener("change", (event) => {
      setLocale(event.target.value, { persist: true });
      this.locale = event.target.value;
    });
  }
}
