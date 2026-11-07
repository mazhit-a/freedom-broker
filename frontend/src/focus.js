const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

export function deepActiveElement(root = globalThis.document) {
  let el = root ? root.activeElement : null;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el || null;
}

function isFocusable(el) {
  if (el.disabled || el.hidden) return false;
  if (el.getAttribute("tabindex") === "-1") return false;
  if (el.closest("[inert]")) return false;
  if (el.type === "hidden") return false;
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function visit(el, out) {
  if (el.matches(FOCUSABLE) && isFocusable(el)) out.push(el);
  if (el.shadowRoot) walk(el.shadowRoot, out);
  else walk(el, out);
}

function walk(node, out) {
  for (const el of node.children) {
    if (el.tagName === "SLOT") {
      for (const assigned of el.assignedElements({ flatten: true })) visit(assigned, out);
    } else if (el.tagName !== "STYLE") {
      visit(el, out);
    }
  }
}

export function focusableWithin(root) {
  const out = [];
  walk(root, out);
  return out;
}

export function captureFocus() {
  const el = deepActiveElement();
  if (!el || el === globalThis.document.body) return null;
  return { el, root: el.getRootNode(), key: el.getAttribute ? el.getAttribute("data-focus-id") : null };
}

export function restoreFocus(record) {
  if (!record) return false;
  let target = record.el;
  if (!target.isConnected && record.key && record.root && record.root.querySelector) {
    const host = record.root.host;
    if (!host || host.isConnected) target = record.root.querySelector(`[data-focus-id="${record.key}"]`);
  }
  if (target && target.isConnected && typeof target.focus === "function") {
    target.focus();
    return true;
  }
  return false;
}

export function initialFocus(container, fallback) {
  const all = focusableWithin(container);
  const marked = all.find((el) => el.hasAttribute("data-autofocus"));
  const target = marked || all.find((el) => el !== fallback) || fallback;
  if (target) target.focus();
  return target || null;
}
