import { CqaElement, html, raw } from "../base-element.js";
import { navigate } from "../events.js";
import { integer } from "../format.js";
import { SECTIONS, formatHash } from "../routes.js";
import { SHARED_CSS } from "../shared/styles.js";

export class CqaNav extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "route", "open-appeals"];
  }

  styles() {
    return `${SHARED_CSS}
      :host { display: block; container-type: normal !important; }
      nav { display: flex; flex-wrap: wrap; }
      a.nav { padding: 0 12px; height: 56px; display: flex; align-items: center; gap: 6px; font-size: var(--cqa-fs-14); font-weight: 500; color: var(--cqa-ink-2); text-decoration: none; border-bottom: 2px solid transparent; }
      a.nav:hover { color: var(--cqa-ink); }
      a.nav[aria-current="page"] { color: var(--cqa-ink); border-bottom-color: var(--cqa-brand); }
      a.nav:focus-visible { outline-offset: -2px; border-radius: var(--cqa-radius-control); }
      .count { height: 18px; padding: 0 6px; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    `;
  }

  openAppeals() {
    const value = this.getAttribute("open-appeals");
    if (value === null || value === "") return null;
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? count : null;
  }

  template() {
    const current = this.getAttribute("route") || "";
    const open = this.openAppeals();
    const items = SECTIONS.map((key) => {
      const badge =
        key === "appeals" && open !== null
          ? html`<span class="chip c-warn tnum count" data-count>${integer(open, this.locale)}</span><span class="sr">${this.t("nav.openSuffix")}</span>`
          : html``;
      return html`<a class="nav" href="${formatHash(key)}" data-route="${key}" data-focus-id="nav-${key}" ${raw(key === current ? 'aria-current="page"' : "")}>${this.t(`nav.${key}`)}${badge}</a>`;
    });
    return html`<nav aria-label="${this.t("nav.label")}">${items}</nav>`;
  }

  afterRender(region) {
    for (const link of region.querySelectorAll("a[data-route]")) {
      link.addEventListener("click", (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(this, link.getAttribute("data-route"));
      });
    }
  }
}
