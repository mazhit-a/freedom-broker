import { CqaApp } from "./components/cqa-app.js";
import { CqaHeader } from "./components/cqa-header.js";
import { CqaNav } from "./components/cqa-nav.js";
import { CqaDrawer } from "./components/cqa-drawer.js";
import { CqaModal } from "./components/cqa-modal.js";
import { CqaToast } from "./components/cqa-toast.js";
import { CqaScaleStepEditor } from "./components/cqa-scale-step-editor.js";

export const ELEMENTS = {
  "cqa-nav": CqaNav,
  "cqa-header": CqaHeader,
  "cqa-drawer": CqaDrawer,
  "cqa-modal": CqaModal,
  "cqa-toast": CqaToast,
  "cqa-scale-step-editor": CqaScaleStepEditor,
  "cqa-app": CqaApp
};

export function registerAll() {
  if (!globalThis.customElements) return;
  for (const [name, ctor] of Object.entries(ELEMENTS)) {
    if (!customElements.get(name)) customElements.define(name, ctor);
  }
}
