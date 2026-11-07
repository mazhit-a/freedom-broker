import { registerInter } from "./fonts.js";
import { setLocale, storedLocale } from "./i18n/index.js";
import { CqaApp } from "./components/cqa-app.js";

registerInter();

const config = globalThis.window?.CQA_CONFIG || {};
const query = new URLSearchParams(globalThis.location?.search || "");
setLocale(query.get("locale") || config.locale || storedLocale() || "ru");

if (globalThis.customElements && !customElements.get("cqa-app")) {
  customElements.define("cqa-app", CqaApp);
}

export { CqaApp };
export { CqaElement, html, raw, escapeHtml } from "./base-element.js";
export { EVENTS, emit, navigate } from "./events.js";
export { ROLES, can, normalizeRole } from "./roles.js";
export { t, getLocale, setLocale } from "./i18n/index.js";
export { format } from "./format.js";
