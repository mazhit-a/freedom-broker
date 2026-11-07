import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { duration } from "../format.js";

function stamp(value) {
  if (value === null || value === undefined || value === "") return "";
  return typeof value === "number" ? duration(value) : String(value);
}

export function evidenceChip({ index, role = "operator", time = null, endTime = null, expected = false }, locale) {
  const label = expected ? t("msg.expectedHere", {}, locale) : t(`msg.${role}`, {}, locale);
  let when = stamp(time);
  const end = stamp(endTime);
  if (when && end) when = `${when}–${end}`;
  const text = when ? `${label} · ${when}` : label;
  const cls = expected ? "ev ev-expected" : "ev";
  return html`<button type="button" class="${raw(cls)}" data-action="jump" data-msg="${index}">${text}</button>`;
}
