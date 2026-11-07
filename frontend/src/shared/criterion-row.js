import { html, raw } from "../base-element.js";
import { t } from "../i18n/index.js";
import { integer, number } from "../format.js";
import { answerChip, grossChip, pointsChip } from "./chip.js";
import { evidenceChip } from "./evidence-chip.js";
import { icon } from "./icons.js";

export function criterionRow(c, locale) {
  const scaled = c.max !== null && c.max !== undefined && c.earned !== null && c.earned !== undefined && c.scale;
  let answer = html``;
  if (c.gross) answer = grossChip(locale);
  else if (scaled) answer = pointsChip(c.earned, c.max, locale);
  else if (c.answer) answer = answerChip(c.answer, locale);

  let points = html``;
  if (c.gross) {
    points = html`<span class="crit-points muted">${t("criterion.flag", {}, locale)}</span>`;
  } else if (c.points !== null && c.points !== undefined) {
    points = html`<span class="crit-points"><b>${number(c.points, locale)}</b> <span class="muted">/ ${number(c.maxPoints, locale)}</span></span>`;
  }

  let weight = html``;
  if (c.weight !== null && c.weight !== undefined && !c.gross) {
    const effective = c.effectiveWeight === null || c.effectiveWeight === undefined ? c.weight : c.effectiveWeight;
    weight = html`<span class="crit-weight">${t("criterion.weight", { weight: integer(c.weight, locale), effective: number(effective, locale) }, locale)}</span>`;
  }

  const chips = (c.evidence || []).map((e) => evidenceChip(e, locale));
  const appeal = c.appealable
    ? html`<button type="button" class="btn btn-sm" data-action="appeal" data-criterion="${c.id}">${icon("flag")}${t("criterion.appeal", {}, locale)}</button>`
    : html``;
  const cls = c.selected ? "crit selected" : "crit";
  const body = c.explanation ? html`<div class="crit-body">${c.explanation}</div>` : html``;

  return html`<div class="${raw(cls)}" id="crit-${c.id}" role="group" aria-labelledby="crit-${c.id}-t"><div class="crit-head"><span class="crit-no">${c.number}</span><b class="crit-title" id="crit-${c.id}-t">${c.title}</b>${answer}${points}${appeal}</div>${body}<div class="crit-foot">${weight}${chips}</div></div>`;
}

export function scaleStepList(steps, locale, { label = null } = {}) {
  const rows = steps.map(
    (s, i) => html`<li><span class="step-n" aria-label="${t("criterion.scaleStep", { step: integer(i + 1, locale) }, locale)}">${integer(s.step, locale)}</span><span>${s.description}</span><span class="step-p">${number(s.points, locale)}</span></li>`
  );
  return html`<ol class="steps" aria-label="${label || t("criterion.scale", {}, locale)}">${rows}</ol>`;
}
