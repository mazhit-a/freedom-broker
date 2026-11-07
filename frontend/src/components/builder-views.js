import { html, raw } from "../base-element.js";
import { date as formatDate, integer, number } from "../format.js";
import { stepPoints, formatPoints } from "../scale-steps.js";
import { icon } from "../shared/icons.js";
import { chip } from "../shared/chip.js";
import { canRemoveSection, formatHundredths, hasNa, isChanged, isNew, isSectionChanged, isSectionNew, parseHundredths, scoredCriteria, sectionHundredths, sectionInputFor, sectionTitle, sectionTitleDraft, sectionWeightText, TYPES } from "./builder-model.js";
import { errorText, warningText } from "./builder-validate.js";

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

function viewTone(status) {
  if (status === "active") return "ok";
  if (status === "saved") return "brand";
  return "na";
}

function appliedLine(ctx, v) {
  const { t, locale } = ctx;
  if (!v || !(v.appliedCount > 0)) return t("builder.side.notApplied");
  return t(v.isDefault ? "builder.side.appliedActive" : "builder.side.appliedPast", { count: v.appliedCount, n: integer(v.appliedCount, locale), date: dateText(v.firstAppliedAt, locale) });
}

function viewBar(ctx) {
  const { t, draft, view, viewed } = ctx;
  const version = `v${viewed.version}`;
  const sumText = formatHundredths(view.validation.sum, ctx.locale);
  const sum = view.validation.sum;
  const isActive = viewed.status === "active" || viewed.isDefault;
  const status = isActive ? "active" : viewed.status;
  const canAct = !ctx.roleReadOnly;
  const activate = canAct && !isActive
    ? html`<button type="button" class="btn btn-primary" data-action="activate" data-version="${viewed.id}" data-focus-id="view-activate" ${ctx.busy ? raw('aria-busy="true" disabled') : ""}>${t("builder.side.activate")}</button>`
    : html``;
  const marker = isActive ? html`<span data-active-marker>${chip({ tone: "ok", text: t("builder.status.active") })}</span>` : html``;
  const duplicate = canAct
    ? html`<button type="button" class="btn" data-action="duplicate" data-version="${viewed.id}" data-focus-id="view-duplicate" ${flag(ctx.busy, "disabled")}>${t("builder.view.duplicate")}</button>`
    : html``;
  const note = isActive ? t("builder.view.activeNote", { version }) : t("builder.view.inactiveNote", { version });
  return html`
    <div class="bar-in">
      <h1 class="h1">${draft.config.name}</h1>
      <span data-chip="status">${chip({ tone: viewTone(status), text: `${version} · ${t(`builder.status.${status}`)}` })}</span>
      <span class="tnum meta" data-meta>${appliedLine(ctx, viewed)}</span>
      <div role="status" class="sum sum-${sumTone(sum)} tnum" data-sum data-tone="${sumTone(sum)}">${t("builder.sum", { sum: sumText })}</div>
      <div class="actions">${marker}${duplicate}${activate}</div>
      <p class="banner" data-view-banner role="status"><b>${t("builder.view.title", { version, status: t(`builder.status.${status}`) })}</b> ${t("builder.view.locked")} ${note} <span class="tnum">${appliedLine(ctx, viewed)}.</span></p>
      <p class="reason" id="save-reason" data-save-reason>${ctx.roleReadOnly ? t("builder.readOnly") : ""}</p>
    </div>`;
}

export function topBar(ctx) {
  if (ctx.viewing && ctx.viewed) return viewBar(ctx);
  const { t, draft, view } = ctx;
  const version = `v${draft.versionNumber}`;
  const sumText = formatHundredths(view.validation.sum, ctx.locale);
  const base = draft.baseNumber === null ? t("builder.noBase") : t("builder.basedOn", { version: `v${draft.baseNumber}`, count: integer(view.changedCount, ctx.locale) });
  const chipText = t(`builder.chip.${ctx.status}`, { version });
  const chipTone = ctx.status === "draft" ? "warn" : ctx.status === "saved" ? "brand" : "ok";
  const sum = view.validation.sum;
  const blocked = !view.validation.valid;
  let reason = "";
  if (ctx.roleReadOnly) reason = t("builder.readOnly");
  else if (ctx.locked) reason = t("builder.lockedReason", { version });
  else if (ctx.busy) reason = t("builder.busy");
  else if (blocked) {
    const onlySum = view.validation.errors.every((e) => e.code === "sum");
    reason = onlySum ? t("builder.saveBlockedSum", { sum: sumText }) : t("builder.saveBlockedErrors", { count: integer(view.validation.errors.length, ctx.locale) });
  }
  const saveOff = blocked || ctx.readOnly || ctx.busy || ctx.status !== "draft";
  const resetOff = ctx.readOnly || ctx.busy || draft.baseNumber === null;
  const applyOff = ctx.readOnly || ctx.busy || ctx.status !== "saved";
  const discardOff = ctx.readOnly || ctx.busy || !ctx.dirty;
  const draftOff = ctx.readOnly || ctx.busy || ctx.status !== "draft" || !(ctx.dirty || draft.isNew) || !view.validation.draftValid;
  const showDelete = !ctx.roleReadOnly && ctx.status === "draft" && draft.versionId !== null;
  const applyNote = ctx.status === "draft" && !ctx.roleReadOnly ? t("builder.applyDraftReason") : "";
  const resetLabel = draft.baseNumber === null ? t("builder.reset", { version }) : t("builder.reset", { version: `v${draft.baseNumber}` });
  const nameBad = view.validation.errors.find((e) => e.code === "listNameEmpty" || e.code === "listNameDup");
  const title = draft.isNew && !ctx.roleReadOnly
    ? html`<label class="newname"><span class="sr">${t("builder.new.nameLabel")}</span><input class="field h1-input" type="text" data-field="new-name" data-focus-id="new-name" value="${draft.config.name}" maxlength="120" aria-label="${t("builder.new.nameLabel")}" aria-describedby="name-error" ${nameBad ? raw('aria-invalid="true"') : ""}></label>`
    : html`<h1 class="h1">${draft.config.name}</h1>`;
  const nameError = nameBad ? html`<p class="reason bad" id="name-error" data-name-error role="alert">${errorText(nameBad, t)}</p>` : html``;
  return html`
    <div class="bar-in">
      ${title}
      <span data-chip="status">${chip({ tone: chipTone, text: chipText })}</span>
      <span class="tnum meta" data-meta>${base}</span>
      <div role="status" class="sum sum-${sumTone(sum)} tnum" data-sum data-tone="${sumTone(sum)}">${t("builder.sum", { sum: sumText })}</div>
      <div class="actions">
        <button type="button" class="btn" data-action="discard" data-focus-id="discard" ${flag(discardOff, "disabled")}>${t("builder.discard")}</button>
        ${showDelete ? html`<button type="button" class="btn btn-danger" data-action="delete-draft" data-focus-id="delete-draft" ${flag(ctx.busy, "disabled")}>${t("builder.deleteDraft")}</button>` : html``}
        <button type="button" class="btn" data-action="reset" data-focus-id="reset" ${flag(resetOff, "disabled")}>${resetLabel}</button>
        <button type="button" class="btn" data-action="save-draft" data-focus-id="save-draft" ${ctx.busyName === "draft" ? raw('aria-busy="true"') : ""} ${flag(draftOff, "disabled")}>${t("builder.saveDraft")}</button>
        <button type="button" class="btn btn-primary" data-action="save" data-focus-id="save" aria-describedby="save-reason" ${ctx.busy ? raw('aria-busy="true"') : ""} ${flag(saveOff, "disabled")}>${t("builder.save", { version })}</button>
        <button type="button" class="btn btn-apply" data-action="apply" data-focus-id="apply" aria-describedby="apply-reason" ${flag(applyOff, "disabled")}>${t("builder.apply")}</button>
      </div>
      ${nameError}
      <p class="reason" id="save-reason" data-save-reason>${reason}</p>
      <p class="reason note" id="apply-reason" data-apply-reason>${applyNote}</p>
    </div>`;
}

export function alertBox(ctx) {
  const { t, view } = ctx;
  const errors = view.validation.errors;
  const warnings = view.validation.warnings;
  if (errors.length === 0 && !ctx.saveError && warnings.length === 0) return html``;
  const server = ctx.saveError ? html`<span data-error="server">${ctx.saveError}</span>` : html``;
  const items = errors.map((e) => html`<span data-error="${e.code}">${errorText(e.code === "sum" ? { ...e, sumText: formatHundredths(e.sum, ctx.locale) } : e, t)}</span>`);
  const box = errors.length || ctx.saveError ? html`<div role="alert" class="alert" data-alerts>${server}${items}</div>` : html``;
  const notes = warnings.map((w) => html`<span data-warning="${w.code}">${warningText(w, t)}</span>`);
  const warn = warnings.length ? html`<div class="notice" data-warnings role="note" aria-label="${t("builder.warn.label")}">${notes}</div>` : html``;
  return html`${box}${warn}`;
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

function sectionHead(ctx, s, index, count, list) {
  const { t, draft, readOnly, view } = ctx;
  const validation = view.validation;
  const title = sectionTitle(s, ctx.locale);
  const derived = sectionHundredths(draft, s.id);
  const scored = scoredCriteria(draft, s.id).length;
  const canAdd = !readOnly && !list.some((c) => c.type === "flag");
  const created = isSectionNew(draft, s);
  const changed = !created && isSectionChanged(draft, s);
  const chips = html`${changed ? chip({ tone: "warn", text: t("builder.changed") }) : ""}${created ? chip({ tone: "brand", text: t("builder.new") }) : ""}`;
  const add = canAdd
    ? html`<button type="button" class="btn btn-sm btn-ghost addc" data-action="add" data-section="${s.id}" data-focus-id="add-${s.id}" aria-label="${t("builder.addCriterionIn", { section: title })}">${icon("plus", 14)}${t("builder.addCriterion")}</button>`
    : html``;
  const nameBad = validation.badSection.has(s.id);
  const weightBad = validation.badSectionWeight.has(s.id);
  const invalid = nameBad || weightBad;
  const editing = !readOnly && (invalid || (ctx.openSections && ctx.openSections.has(s.id)));
  const pencil = readOnly
    ? html``
    : html`<button type="button" class="btn btn-sm btn-ghost ib editb" data-action="toggle-section" data-section="${s.id}" data-focus-id="edit-${s.id}" aria-expanded="${editing ? "true" : "false"}" ${editing && invalid ? raw('aria-disabled="true"') : ""} aria-label="${t("builder.sec.edit", { name: title })}" title="${t("builder.sec.edit", { name: title })}">${icon("edit", 14)}</button>`;
  if (!editing) {
    const emptyNote = list.length === 0 ? html`<div class="sec-notes" id="sec-note-${s.id}"><span class="sec-warn" data-sec-hint="empty">${t("builder.sec.empty")}</span></div>` : html``;
    return html`
      <div class="sech" data-section-id="${s.id}">
        <h2 class="sech-t">${title}</h2>${chips}
        <span class="tnum dim12" data-section-weight="${s.id}">${t("builder.sectionWeight", { weight: formatHundredths(derived, ctx.locale) })}</span>
        ${pencil}
        ${add}
        ${emptyNote}
      </div>`;
  }
  const entry = sectionInputFor(draft, s.id);
  const weightText = entry ? entry.text : sectionWeightText(derived, ctx.locale);
  const noScored = scored === 0;
  const canDelete = canRemoveSection(draft, s.id);
  const deleteHint = canDelete ? "" : t("builder.sec.deleteLast");
  const notes = [];
  if (nameBad) notes.push(html`<span class="sec-bad" data-sec-error="name">${validation.badSection.get(s.id) === "secNameEmpty" ? t("builder.sec.nameEmpty") : t("builder.sec.nameDup")}</span>`);
  if (weightBad) notes.push(html`<span class="sec-bad" data-sec-error="weight">${t("builder.sec.weightInvalid")}</span>`);
  if (noScored) notes.push(html`<span class="sec-hint" data-sec-hint="weight">${t("builder.sec.weightDisabled")}</span>`);
  if (list.length === 0) notes.push(html`<span class="sec-warn" data-sec-hint="empty">${t("builder.sec.empty")}</span>`);
  if (!canDelete) notes.push(html`<span class="sec-hint" data-sec-hint="delete">${deleteHint}</span>`);
  if (invalid) notes.push(html`<span class="sec-hint" data-sec-hint="keep-open">${t("builder.sec.keepOpen")}</span>`);
  const done = html`<button type="button" class="btn btn-sm doneb" data-action="done-section" data-section="${s.id}" data-focus-id="done-${s.id}" ${invalid ? raw('aria-disabled="true"') : ""}>${t("builder.sec.done")}</button>`;
  return html`
    <div class="sech sech-edit" data-section-id="${s.id}">
      <h2 class="sech-t"><input class="field sname" type="text" data-field="sec-name" data-section="${s.id}" data-focus-id="sn-${s.id}" value="${sectionTitleDraft(s, ctx.locale)}" aria-label="${t("builder.sec.nameLabel", { num: index + 1 })}" aria-describedby="sec-note-${s.id}" ${nameBad ? raw('aria-invalid="true"') : ""}></h2>${chips}
      ${pencil}
      <label class="sw dim12">${t("builder.sec.weightLabel")}<input class="field tnum swf" type="text" inputmode="decimal" data-field="sec-weight" data-section="${s.id}" data-section-weight="${s.id}" data-focus-id="sw-${s.id}" value="${weightText}" aria-label="${t("builder.sec.weightAria", { name: title })}" aria-describedby="sec-note-${s.id}" ${weightBad ? raw('aria-invalid="true"') : ""} ${flag(noScored, "disabled")}></label>
      <span class="mv">
        <button type="button" class="btn btn-sm btn-ghost ib" data-action="section-up" data-section="${s.id}" data-focus-id="sup-${s.id}" aria-label="${t("builder.sec.moveUp", { name: title })}" ${flag(index === 0, "disabled")}>${icon("up", 14)}</button>
        <button type="button" class="btn btn-sm btn-ghost ib" data-action="section-down" data-section="${s.id}" data-focus-id="sdown-${s.id}" aria-label="${t("builder.sec.moveDown", { name: title })}" ${flag(index === count - 1, "disabled")}>${icon("down", 14)}</button>
      </span>
      <button type="button" class="btn btn-sm btn-ghost ib" data-action="remove-section" data-section="${s.id}" data-focus-id="rms-${s.id}" aria-label="${t("builder.sec.delete", { name: title })}" ${deleteHint ? raw(`title="${deleteHint}"`) : ""} ${flag(!canDelete, "disabled")}>${icon("close", 14)}</button>
      ${done}
      ${add}
      <div class="sec-notes" id="sec-note-${s.id}">${notes}</div>
    </div>`;
}

export function structure(ctx) {
  const { t, draft, readOnly } = ctx;
  const count = draft.sections.length;
  const sections = draft.sections.map((s, index) => {
    const list = draft.criteria.filter((c) => c.section === s.id);
    return html`
      ${sectionHead(ctx, s, index, count, list)}
      ${list.map((c, i) => rowHtml(ctx, c, i, list.length))}`;
  });
  const addSection = readOnly
    ? html``
    : html`<div class="secadd"><button type="button" class="btn btn-sm" data-action="add-section" data-focus-id="add-section">${icon("plus", 14)}${t("builder.sec.add")}</button></div>`;
  return html`
    <div class="crow chead"><span>${t("builder.col.num")}</span><span>${t("builder.col.criterion")}</span><span>${t("builder.col.type")}</span><span class="r">${t("builder.col.weight")}</span><span></span><span class="sr">${t("builder.col.remove")}</span></div>
    ${sections}
    ${addSection}`;
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
    <div class="ed-h"><h2 class="h2">${t("builder.ed.title", { num })}</h2><span class="dim12" data-ed-section>${section ? sectionTitleDraft(section, ctx.locale) : ""}</span></div>
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
    return html`${head}<p class="pv-note" data-preview-state="invalid">${t(p.reason === "empty" ? "builder.pv.empty" : "builder.pv.invalid")}</p>`;
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

function versionRow(ctx, v, options = {}) {
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
  if (options.status === "applied" && !v.isDefault) {
    tone = "ok";
    label = t("builder.status.applied");
  }
  let line = t("builder.side.notApplied");
  if (v.appliedCount > 0) line = t(v.isDefault ? "builder.side.appliedActive" : "builder.side.appliedPast", { count: v.appliedCount, n, date: when });
  else if (options.editing && v.status === "saved") line = t("builder.side.savedNotApplied");
  const lock = v.locked && v.appliedCount > 0
    ? html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${t("builder.side.locked")}" class="lockic"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>`
    : html``;
  const off = ctx.roleReadOnly || ctx.busy;
  const duplicate = !options.foreign && (v.isDefault || options.editing)
    ? html`<button type="button" class="btn btn-sm dup" data-action="duplicate" data-version="${v.id}" data-focus-id="dup-${v.id}" ${flag(off, "disabled")}>${t("builder.side.duplicate")}</button>`
    : html``;
  const canActivate = !options.foreign && (v.status === "saved" || v.status === "archived") && !v.isDefault && !ctx.roleReadOnly;
  const activate = canActivate
    ? html`<button type="button" class="btn btn-sm dup" data-action="activate" data-version="${v.id}" data-focus-id="act-${v.id}" aria-label="${t("builder.side.activateLabel", { version: `v${v.version}` })}" ${flag(ctx.busy, "disabled")}>${t("builder.side.activate")}</button>`
    : html``;
  const note = v.isDefault ? html`<span class="dim12">${t("builder.side.immutable")}</span>` : html``;
  const draftNote = v.status === "draft" && !ctx.roleReadOnly && !options.foreign ? html`<span class="dim12" data-draft-note>${t("builder.side.draftNote")}</span>` : html``;
  const viewedId = ctx.viewing && ctx.viewed ? ctx.viewed.id : null;
  const current = Boolean(options.editing) || v.id === viewedId;
  const cls = `vrow${options.editing ? " vedit" : ""}${!options.editing && current ? " vcur" : ""}`;
  return html`
    <div class="${cls}" data-version-row="${v.id}" ${options.editing ? raw("data-editing") : raw("")}>
      <button type="button" class="vopen" data-action="open-version" data-version="${v.id}" data-focus-id="ver-${v.id}" ${current ? raw('aria-current="true"') : raw("")}>
        <span class="vline"><b class="tnum">v${v.version}</b>${chip({ tone, text: label })}${lock}</span>
        <span class="tnum sub2">${line}</span>
      </button>
      ${note}
      ${draftNote}
      ${duplicate}${activate}
    </div>`;
}

const CHANNELS = [
  ["chat", "chat"],
  ["call", "call"]
];

export function channelKind(value) {
  return /call|voice|звон/i.test(String(value)) ? "call" : "chat";
}

function channelsBlock(ctx, cl, current) {
  const { t } = ctx;
  const bound = new Set((cl.channels || []).map(channelKind));
  if (!current) {
    const names = CHANNELS.filter(([k]) => bound.has(k)).map(([k]) => t(`builder.channel.${k}`));
    return html`<span class="dim12" data-channels-text="${cl.id}">${names.length ? names.join(" · ") : t("builder.side.channelsNone")}</span>`;
  }
  const off = ctx.roleReadOnly || ctx.busy;
  const boxes = CHANNELS.map(
    ([k]) => html`<label class="chan"><input type="checkbox" data-field="channel" data-channel="${k}" data-focus-id="chan-${k}" ${flag(bound.has(k), "checked")} ${flag(off, "disabled")}>${t(`builder.channel.${k}`)}</label>`
  );
  return html`
    <fieldset class="chans" data-channels>
      <legend class="dim12">${t("builder.side.channels")}</legend>
      ${boxes}
      <span class="dim12">${t("builder.side.channelsHint")}</span>
    </fieldset>`;
}

function newChecklistBlock(ctx) {
  const { t, draft } = ctx;
  const name = String(draft.config.name ?? "").trim() || t("builder.new.defaultName");
  const picked = new Set(ctx.newChannels || ["chat"]);
  const off = ctx.roleReadOnly || ctx.busy;
  const boxes = CHANNELS.map(
    ([k]) => html`<label class="chan"><input type="checkbox" data-field="new-channel" data-channel="${k}" data-focus-id="newchan-${k}" ${flag(picked.has(k), "checked")} ${flag(off, "disabled")}>${t(`builder.channel.${k}`)}</label>`
  );
  return html`
    <div class="side-block" data-new-block>
      <span class="side-t" data-checklist-title="new">${name} ${chip({ tone: "brand", text: t("builder.new.badge") })}</span>
      <fieldset class="chans" data-channels>
        <legend class="dim12">${t("builder.new.channelLabel")}</legend>
        ${boxes}
        <span class="dim12">${t("builder.side.channelsHint")}</span>
      </fieldset>
      <div class="vrow vedit" data-editing data-version-row="new">
        <button type="button" class="vopen" data-action="open-version" data-version="new" data-focus-id="ver-new" aria-current="true">
          <span class="vline"><b class="tnum">v${draft.versionNumber}</b>${chip({ tone: "warn", text: t("builder.status.draft") })}</span>
          <span class="sub2">${t("builder.new.unsaved")}</span>
        </button>
      </div>
    </div>`;
}

export function sidebar(ctx) {
  const { t, lists, current, draft } = ctx;
  const blocks = lists.map((cl) => {
    const isCurrent = Boolean(current) && cl.id === current.id;
    const title = isCurrent
      ? html`<span class="side-t" data-checklist-title="${cl.id}">${cl.name}</span>`
      : html`<button type="button" class="side-t side-link" data-action="open-checklist" data-id="${cl.id}" data-focus-id="open-${cl.id}" aria-label="${t("builder.side.open", { name: cl.name })}">${cl.name}</button>`;
    let rows = html``;
    if (isCurrent && !ctx.viewing) {
      const own = cl.versions.find((v) => v.id === draft.versionId);
      const base = own || { id: draft.versionId, version: draft.versionNumber, status: "draft", isDefault: false, appliedCount: 0, firstAppliedAt: null, locked: false };
      const first = ctx.status === "draft"
        ? html`
          <div class="vrow vedit" data-editing data-version-row="${draft.versionId ?? "new"}">
            <button type="button" class="vopen" data-action="open-version" data-version="${draft.versionId ?? "new"}" data-focus-id="ver-${draft.versionId ?? "new"}" aria-current="true">
              <span class="vline"><b class="tnum">v${draft.versionNumber}</b>${chip({ tone: "warn", text: t("builder.status.draft") })}</span>
              <span class="sub2">${t("builder.side.editing", { date: dateText(draft.createdAt, ctx.locale) })}</span>
            </button>
          </div>`
        : versionRow(ctx, { ...base, locked: ctx.status === "applied" || base.locked }, { editing: true, status: ctx.status });
      const shown = cl.versions.filter((v) => v.id !== draft.versionId);
      const history = [...shown].sort((a, b) => b.version - a.version).map((v) => versionRow(ctx, v));
      rows = html`${first}${history}`;
    } else {
      rows = [...cl.versions].sort((a, b) => b.version - a.version).map((v) => versionRow(ctx, v, { foreign: !isCurrent }));
    }
    return html`<div class="side-block">${title}${channelsBlock(ctx, cl, isCurrent)}${rows}</div>`;
  });
  const created = draft && draft.isNew ? newChecklistBlock(ctx) : html``;
  const add = ctx.roleReadOnly
    ? html`<button type="button" class="btn btn-sm btn-ghost newc" data-action="new-checklist" data-focus-id="new-checklist" disabled title="${t("builder.readOnly")}">${icon("plus", 14)}${t("builder.side.newChecklist")}</button>`
    : html`<button type="button" class="btn btn-sm btn-ghost newc" data-action="new-checklist" data-focus-id="new-checklist" ${flag(ctx.busy, "disabled")}>${icon("plus", 14)}${t("builder.side.newChecklist")}</button>`;
  return html`
    ${blocks}
    ${created}
    ${add}`;
}
