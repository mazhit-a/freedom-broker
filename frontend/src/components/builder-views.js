import { html, raw } from "../base-element.js";
import { date as formatDate, integer, number } from "../format.js";
import { stepPoints, formatPoints } from "../scale-steps.js";
import { icon } from "../shared/icons.js";
import { chip } from "../shared/chip.js";
import { formatHundredths, hasNa, isChanged, isNew, parseHundredths, sectionTitle, TYPES } from "./builder-model.js";
import { errorText } from "./builder-validate.js";

const flag = (on, name) => (on ? raw(name) : raw(""));

function decimals(value) {
  const text = String(Math.round(value * 10000) / 10000);
  const at = text.indexOf(".");
  return at < 0 ? 0 : text.length - at - 1;
}

export function sumTone(sum) {
  if (sum === 10000) return "ok";
  return sum > 10000 ? "bad" : "warn";
}

export function topBar(ctx) {
  const { t, draft, view } = ctx;
  const version = `v${draft.versionNumber}`;
  const sumText = formatHundredths(view.validation.sum, ctx.locale);
  const base = draft.baseNumber === null ? t("builder.noBase") : t("builder.basedOn", { version: `v${draft.baseNumber}`, count: integer(view.changedCount, ctx.locale) });
  const chipText = t(`builder.chip.${ctx.status}`, { version });
  const chipTone = ctx.status === "draft" ? "warn" : ctx.status === "saved" ? "brand" : "ok";
  const sum = view.validation.sum;
  const blocked = !view.validation.valid;
  let reason = "";
  if (ctx.readOnly) reason = t("builder.readOnly");
  else if (blocked) {
    const onlySum = view.validation.errors.every((e) => e.code === "sum");
    reason = onlySum ? t("builder.saveBlockedSum", { sum: sumText }) : t("builder.saveBlockedErrors", { count: integer(view.validation.errors.length, ctx.locale) });
  }
  const saveOff = blocked || ctx.readOnly || ctx.status !== "draft";
  const resetOff = ctx.readOnly || draft.baseNumber === null;
  const applyOff = ctx.readOnly || ctx.status !== "saved";
  const resetLabel = draft.baseNumber === null ? t("builder.reset", { version }) : t("builder.reset", { version: `v${draft.baseNumber}` });
  return html`
    <div class="bar-in">
      <h1 class="h1">${draft.config.name}</h1>
      <span data-chip="status">${chip({ tone: chipTone, text: chipText })}</span>
      <span class="tnum meta" data-meta>${base}</span>
      <div role="status" class="sum sum-${sumTone(sum)} tnum" data-sum data-tone="${sumTone(sum)}">${t("builder.sum", { sum: sumText })}</div>
      <div class="actions">
        <button type="button" class="btn" data-action="reset" data-focus-id="reset" ${flag(resetOff, "disabled")}>${resetLabel}</button>
        <button type="button" class="btn btn-primary" data-action="save" data-focus-id="save" aria-describedby="save-reason" ${flag(saveOff, "disabled")}>${t("builder.save", { version })}</button>
        <button type="button" class="btn btn-apply" data-action="apply" data-focus-id="apply" ${flag(applyOff, "disabled")}>${t("builder.apply")}</button>
      </div>
      <p class="reason" id="save-reason" data-save-reason>${reason}</p>
    </div>`;
}

export function alertBox(ctx) {
  const { t, view } = ctx;
  const errors = view.validation.errors;
  if (errors.length === 0) return html``;
  const items = errors.map((e) => html`<span data-error="${e.code}">${errorText(e.code === "sum" ? { ...e, sumText: formatHundredths(e.sum, ctx.locale) } : e, t)}</span>`);
  return html`<div role="alert" class="alert" data-alerts>${items}</div>`;
}

function rowHtml(ctx, c, index, siblings) {
  const { t, view, readOnly } = ctx;
  const num = view.validation.numOf.get(c.key);
  const selected = ctx.selectedKey === c.key;
  const changed = isChanged(ctx.draft, c);
  const created = isNew(ctx.draft, c);
  const isFlag = c.type === "flag";
  const onlyOne = ctx.draft.criteria.length <= 1;
  const bad = view.validation.badWeight.has(c.key);
  return html`
    <div class="crow ${raw(selected ? "sel" : "")}" data-row="${c.key}">
      <span class="tnum dim">${num}</span>
      <button type="button" class="pick" data-action="pick" data-key="${c.key}" data-focus-id="pick-${c.key}" aria-pressed="${selected ? "true" : "false"}">
        <span class="nm">${c.name.trim() ? c.name : t("builder.noName")} ${changed ? chip({ tone: "warn", text: t("builder.changed") }) : ""} ${created ? chip({ tone: "brand", text: t("builder.new") }) : ""}</span>
        <span class="ds">${c.description}</span>
      </button>
      <span class="tl">${t(`builder.type.${c.type === "flag" ? "flagShort" : c.type}`)}</span>
      ${isFlag
        ? html`<span class="noPts">${t("builder.noPoints")}</span>`
        : html`<input class="field tnum wf" type="text" inputmode="decimal" data-field="row-weight" data-key="${c.key}" data-focus-id="rw-${c.key}" value="${c.weight}" aria-label="${t("builder.weightOf", { num })}" ${bad ? raw('aria-invalid="true"') : ""} ${flag(readOnly, "disabled")}>`}
      <span class="mv">
        <button type="button" class="btn btn-sm btn-ghost ib" data-action="up" data-key="${c.key}" data-focus-id="up-${c.key}" aria-label="${t("builder.moveUp", { num })}" ${flag(readOnly || index === 0, "disabled")}>${icon("up", 14)}</button>
        <button type="button" class="btn btn-sm btn-ghost ib" data-action="down" data-key="${c.key}" data-focus-id="down-${c.key}" aria-label="${t("builder.moveDown", { num })}" ${flag(readOnly || index === siblings - 1, "disabled")}>${icon("down", 14)}</button>
      </span>
      <button type="button" class="btn btn-sm btn-ghost ib" data-action="remove" data-key="${c.key}" data-focus-id="rm-${c.key}" aria-label="${t("builder.removeCriterion", { num })}" ${onlyOne ? raw(`title="${t("builder.removeLast")}"`) : ""} ${flag(readOnly || onlyOne, "disabled")}>${icon("close", 14)}</button>
    </div>`;
}

export function structure(ctx) {
  const { t, draft, readOnly } = ctx;
  const sections = draft.sections.map((s) => {
    const list = draft.criteria.filter((c) => c.section === s.id);
    const weight = list.reduce((sum, c) => sum + (c.type === "flag" ? 0 : parseHundredths(c.weight) || 0), 0);
    const canAdd = !readOnly && !list.some((c) => c.type === "flag");
    const title = sectionTitle(s, ctx.locale);
    const add = canAdd
      ? html`<button type="button" class="btn btn-sm btn-ghost addc" data-action="add" data-section="${s.id}" data-focus-id="add-${s.id}" aria-label="${t("builder.addCriterionIn", { section: title })}">${icon("plus", 14)}${t("builder.addCriterion")}</button>`
      : html``;
    return html`
      <div class="sech">
        <h2 class="sech-t">${title}</h2>
        <span class="tnum dim12" data-section-weight="${s.id}">${t("builder.sectionWeight", { weight: formatHundredths(weight, ctx.locale) })}</span>
        ${add}
      </div>
      ${list.map((c, i) => rowHtml(ctx, c, i, list.length))}`;
  });
  return html`
    <div class="crow chead"><span>${t("builder.col.num")}</span><span>${t("builder.col.criterion")}</span><span>${t("builder.col.type")}</span><span class="r">${t("builder.col.weight")}</span><span></span><span class="sr">${t("builder.col.remove")}</span></div>
    ${sections}`;
}

function readOnlySteps(ctx, c) {
  const { t } = ctx;
  const points = stepPoints(c.steps, parseHundredths(c.weight) === null ? 0 : parseHundredths(c.weight) / 100);
  const rows = c.steps.map(
    (s, i) => html`<li><span class="tnum r">${s.value}</span><span>${s.description}</span><span class="tnum r">${formatPoints(points[i], ctx.locale)}</span></li>`
  );
  return html`
    <div class="col gap-2">
      <span class="lbl-t">${t("builder.ed.stepsReadOnly")}</span>
      <ol class="rosteps" aria-label="${t("builder.ed.stepsReadOnly")}">${rows}</ol>
    </div>`;
}

export function editor(ctx) {
  const { t, draft, view, readOnly } = ctx;
  const c = draft.criteria.find((x) => x.key === ctx.selectedKey);
  if (!c) return html``;
  const num = view.validation.numOf.get(c.key);
  const section = draft.sections.find((s) => s.id === c.section);
  const isFlag = c.type === "flag";
  const off = flag(readOnly, "disabled");
  const nameBad = view.validation.badName.has(c.key);
  const weightBad = view.validation.badWeight.has(c.key);
  const options = TYPES.map((type) => html`<option value="${type}" ${flag(c.type === type, "selected")}>${t(`builder.type.${type}`)}</option>`);
  const na = hasNa(c.type)
    ? html`<label class="lbl">${t("builder.ed.na")}<textarea class="field" style="min-height:56px" data-field="e-na" data-focus-id="e-na" ${off}>${c.naCondition}</textarea></label>`
    : html``;
  let scale = html``;
  if (c.type === "scale") {
    scale = readOnly
      ? readOnlySteps(ctx, c)
      : html`<cqa-scale-step-editor data-scale-editor></cqa-scale-step-editor>`;
  }
  return html`
    <div class="ed-h"><h2 class="h2">${t("builder.ed.title", { num })}</h2><span class="dim12">${section ? sectionTitle(section, ctx.locale) : ""}</span></div>
    <label class="lbl">${t("builder.ed.name")}<input class="field" data-field="e-name" data-focus-id="e-name" value="${c.name}" ${nameBad ? raw('aria-invalid="true"') : ""} ${off}></label>
    <label class="lbl">${t("builder.ed.description")}<textarea class="field" data-field="e-desc" data-focus-id="e-desc" ${off}>${c.description}</textarea></label>
    <div class="two">
      <label class="lbl">${t("builder.ed.type")}<select class="field" data-field="e-type" data-focus-id="e-type" ${off}>${options}</select></label>
      <label class="lbl">${t("builder.ed.weight")}<input class="field tnum" type="text" inputmode="decimal" data-field="e-weight" data-focus-id="e-weight" value="${c.weight}" ${weightBad ? raw('aria-invalid="true"') : ""} ${flag(readOnly || isFlag, "disabled")}></label>
    </div>
    ${isFlag ? html`<span class="dim12">${t("builder.noPoints")}</span>` : html``}
    ${na}
    ${scale}`;
}

function answerText(ctx, row) {
  const { t } = ctx;
  if (row.type === "scale") return t("builder.pv.scaleAnswer", { value: integer(row.answer, ctx.locale), top: integer(row.top, ctx.locale) });
  if (row.na) return t("answer.na");
  return t(row.answer === "yes" ? "answer.yes" : "answer.no");
}

export function preview(ctx) {
  const { t, view } = ctx;
  const p = view.preview;
  const head = html`<div class="pv-h"><h2 class="h3">${t("builder.pv.title")}</h2><span class="dim12">${t("builder.pv.sub")}</span></div>`;
  if (!p.ok) {
    return html`${head}<p class="pv-note" data-preview-state="invalid">${t("builder.pv.invalid")}</p>`;
  }
  const dash = "—";
  const cell = (value) => (value === null || value === undefined ? dash : number(value, ctx.locale));
  const rows = p.rows.map((r) => {
    const hundredths = parseHundredths(r.weightText);
    const selected = ctx.selectedKey === r.key;
    const cls = `lrow${r.na ? " na" : ""}${selected ? " sel" : ""}`;
    const points = r.effectivePoints;
    return html`<div role="row" class="${raw(cls)}" data-preview-row="${r.key}">
      <span role="cell" class="clip"><span class="tnum dim">${r.num}</span> ${r.name}</span>
      <span role="cell">${answerText(ctx, r)}</span>
      <span role="cell" class="${raw(r.na ? "strike" : "")}">${hundredths === null ? r.weightText : formatHundredths(hundredths, ctx.locale)}</span>
      <span role="cell">${r.na ? dash : cell(r.effectiveWeight)}</span>
      <span role="cell" class="bold">${r.na ? dash : cell(points)}</span>
    </div>`;
  });
  const appliedH = Math.round(p.applicableWeight * 100);
  const total = p.calculated ? number(p.total, ctx.locale) : t("state.notCalculated");
  let note;
  if (!p.calculated) note = t("builder.pv.noteNone");
  else {
    const k = number(p.factor, ctx.locale, decimals(p.factor));
    note = t(p.anyNa ? "builder.pv.noteNa" : "builder.pv.noteNoNa", { applied: formatHundredths(appliedH, ctx.locale), k });
  }
  return html`
    ${head}
    <div role="table" aria-label="${t("builder.pv.table")}">
      <div role="row" class="lrow lhead"><span role="columnheader">${t("builder.pv.criterion")}</span><span role="columnheader">${t("builder.pv.answer")}</span><span role="columnheader">${t("builder.pv.weight")}</span><span role="columnheader">${t("builder.pv.effective")}</span><span role="columnheader">${t("builder.pv.points")}</span></div>
      ${rows}
      <div role="row" class="lrow ltotal"><span role="cell" class="bold">${t("builder.pv.total")}</span><span role="cell"></span><span role="cell" class="tnum" data-applied>${p.calculated ? formatHundredths(appliedH, ctx.locale) : dash}</span><span role="cell">${p.calculated ? number(100, ctx.locale) : dash}</span><span role="cell" class="totnum" data-total>${total}</span></div>
    </div>
    <p class="pv-note tnum" data-preview-note>${note}</p>`;
}

function dateText(value, locale) {
  return value ? formatDate(value, locale) : "";
}

function versionRow(ctx, checklist, v, active) {
  const { t, locale } = ctx;
  const n = integer(v.appliedCount || 0, locale);
  const when = dateText(v.firstAppliedAt, locale);
  let tone = "na";
  let label = t("builder.status.archived");
  if (v.status === "draft") {
    tone = "warn";
    label = t("builder.status.draft");
  } else if (v.isDefault) {
    tone = "ok";
    label = t("builder.status.active");
  } else if (v.status === "saved") {
    tone = "brand";
    label = t("builder.status.saved");
  }
  let line = t("builder.side.notApplied");
  if (v.appliedCount > 0) line = t(v.isDefault ? "builder.side.appliedActive" : "builder.side.appliedPast", { count: v.appliedCount, n, date: when });
  const lock = v.locked && v.appliedCount > 0
    ? html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${t("builder.side.locked")}" class="lockic"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>`
    : html``;
  const duplicate = v.isDefault
    ? html`<button type="button" class="btn btn-sm dup" data-action="duplicate" data-version="${v.id}" data-seam="duplicate" disabled>${t("builder.side.duplicate")}</button>`
    : html``;
  const note = v.isDefault ? html`<span class="dim12">${t("builder.side.immutable")}</span>` : html``;
  return html`
    <div class="vrow" data-version-row="${v.id}">
      <div class="vline"><b class="tnum">v${v.version}</b>${chip({ tone, text: label })}${lock}</div>
      <span class="tnum sub2">${line}</span>
      ${note}
      ${duplicate}
    </div>`;
}

export function sidebar(ctx) {
  const { t, lists, current, draft } = ctx;
  const blocks = lists.map((cl) => {
    const isCurrent = cl.id === current.id;
    const title = isCurrent
      ? html`<span class="side-t" data-checklist-title="${cl.id}">${cl.name}</span>`
      : html`<button type="button" class="side-t side-link" data-action="open-checklist" data-id="${cl.id}" data-focus-id="open-${cl.id}" aria-label="${t("builder.side.open", { name: cl.name })}">${cl.name}</button>`;
    let rows = html``;
    if (isCurrent) {
      const editing = draft.versionId === null || cl.versions.some((v) => v.id === draft.versionId && v.status === "draft");
      const shown = cl.versions.filter((v) => v.id !== draft.versionId);
      const first = editing
        ? html`
          <div class="vrow vedit" data-editing>
            <div class="vline"><b class="tnum">v${draft.versionNumber}</b>${chip({ tone: ctx.status === "draft" ? "warn" : ctx.status === "saved" ? "brand" : "ok", text: t(`builder.status.${ctx.status}`) })}</div>
            <span class="sub2">${t("builder.side.editing", { date: dateText(draft.createdAt, ctx.locale) })}</span>
          </div>`
        : html``;
      const history = [...shown].sort((a, b) => b.version - a.version).map((v) => versionRow(ctx, cl, v));
      rows = html`${first}${history}`;
    } else {
      rows = [...cl.versions].sort((a, b) => b.version - a.version).map((v) => versionRow(ctx, cl, v));
    }
    return html`<div class="side-block">${title}${rows}</div>`;
  });
  return html`
    ${blocks}
    <button type="button" class="btn btn-sm btn-ghost newc" data-action="new-checklist" data-seam="new-checklist" disabled>${icon("plus", 14)}${t("builder.side.newChecklist")}</button>`;
}
