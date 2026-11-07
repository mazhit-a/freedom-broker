import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { duration } from "../format.js";

function stamp(value) {
  if (value === null || value === undefined || value === "") return "";
  return typeof value === "number" ? duration(value) : String(value);
}

export function transcriptMessage({ index, kind = "client", text = "", time = null, evidence = false, expected = false }, locale) {
  const when = stamp(time);
  const id = `msg-${index}`;
  if (kind === "system") {
    const line = [when, text, t("msg.system", {}, locale)].filter(Boolean).join(" · ");
    return html`<div class="msg-system-wrap" id="${id}"><span class="msg-system">${line}</span></div>`;
  }
  let cls = `msg msg-${kind}`;
  if (evidence) cls += " msg-evidence";
  if (expected) cls += " msg-expected";
  const who = expected ? t("msg.expectedHere", {}, locale) : t(`msg.${kind}`, {}, locale);
  const metas = [`#${index + 1}`];
  if (when) metas.push(when);
  if (kind === "bot") metas.push(t("msg.notScored", {}, locale));
  if (evidence && !expected) metas.push(t("msg.evidence", {}, locale));
  return html`<div class="${raw(cls)}" id="${id}" data-index="${index}"><div class="msg-head"><span class="msg-who">${who}</span><span class="msg-meta">· ${metas.join(" · ")}</span></div><div class="msg-text">${text}</div></div>`;
}
