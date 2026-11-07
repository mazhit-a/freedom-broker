import { registerInter } from "./fonts.js";
import { setLocale } from "./i18n/index.js";
import { registerAll } from "./register.js";
import { CqaApp } from "./components/cqa-app.js";
import { CqaHeader } from "./components/cqa-header.js";
import { CqaNav } from "./components/cqa-nav.js";
import { CqaDrawer } from "./components/cqa-drawer.js";
import { CqaModal } from "./components/cqa-modal.js";
import { CqaToast } from "./components/cqa-toast.js";
import { CqaScaleStepEditor } from "./components/cqa-scale-step-editor.js";

registerInter();

const config = globalThis.window?.CQA_CONFIG || {};
const query = new URLSearchParams(globalThis.location?.search || "");
setLocale(query.get("locale") || config.locale || "ru");

registerAll();

export { CqaApp, CqaHeader, CqaNav, CqaDrawer, CqaModal, CqaToast, CqaScaleStepEditor };
export { CqaElement, html, raw, escapeHtml } from "./base-element.js";
export { EVENTS, emit, navigate } from "./events.js";
export { ROLES, can, normalizeRole } from "./roles.js";
export { t, getLocale, setLocale } from "./i18n/index.js";
export { format } from "./format.js";
