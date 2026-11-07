import "./index.js";
import { configure } from "./api.js";
import { EVENTS } from "./events.js";

const COMPONENTS = {
  "cqa-overview": ["dataset", "checklist-version"],
  "cqa-conversation-list": ["saved-view", "selectable"],
  "cqa-conversation-card": ["conversation-id"],
  "cqa-appeal-drawer": ["conversation-id", "criterion"],
  "cqa-appeal-queue": ["status", "appeal-id"],
  "cqa-checklist-builder": ["checklist-id", "version"],
  "cqa-eval-runs": ["group-id", "run-id"]
};

const query = new URLSearchParams(globalThis.location.search);
const tag = query.get("c") || "cqa-overview";
const config = globalThis.CQA_CONFIG || {};

configure({
  baseUrl: config.apiBase,
  recordId: query.get("record") || null,
  mock: query.has("mock") ? query.get("mock") === "1" : Boolean(config.mock),
  role: query.get("role") || null
});

const element = globalThis.document.createElement(tag);
for (const name of ["role", "locale", ...(COMPONENTS[tag] || [])]) {
  const value = query.get(name);
  if (value !== null) element.setAttribute(name, value);
}
const mount = globalThis.document.getElementById("mount");
const panel = Number(query.get("w"));
if (panel > 0) mount.style.width = `${panel}px`;
mount.append(element);

function relay(event) {
  const detail = event.detail || {};
  globalThis.parent.postMessage({ type: event.type, detail }, globalThis.location.origin);
}

for (const name of [EVENTS.navigate, EVENTS.appealSubmitted, EVENTS.decisionSaved]) globalThis.document.addEventListener(name, relay);

globalThis.document.addEventListener(EVENTS.toast, (event) => {
  const { message, tone, timeout, action } = event.detail || {};
  const toast = globalThis.document.getElementById("toast");
  if (message && toast && typeof toast.show === "function") toast.show(message, { tone, timeout, action });
});
