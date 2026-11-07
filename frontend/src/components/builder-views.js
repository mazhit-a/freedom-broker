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
  const resetLabel = draft.baseNumber === null ? t("builder.reset", { version }) : t("builder.reset", { version: `v${draft.baseNumber}` });
  return html`
    <div class="bar-in">
      <h1 class="h1">${draft.config.name}</h1>
      <span data-chip="status">${chip({ tone: chipTone, text: chipText })}</span>
      <span class="tnum meta" data-meta>${base}</span>
      <div role="status" class="sum sum-${sumTone(sum)} tnum" data-sum data-tone="${sumTone(sum)}">${t("builder.sum", { sum: sumText })}</div>
      <div class="actions">
        <button type="button" class="btn" data-action="discard" data-focus-id="discard" ${flag(discardOff, "disabled")}>${t("builder.discard")}</button>
        <button type="button" class="btn" data-action="reset" data-focus-id="reset" ${flag(resetOff, "disabled")}>${resetLabel}</button>
        <button type="button" class="btn btn-primary" data-action="save" data-focus-id="save" aria-describedby="save-reason" ${ctx.busy ? raw('aria-busy="true"') : ""} ${flag(saveOff, "disabled")}>${t("builder.save", { version })}</button>
        <button type="button" class="btn btn-apply" data-action="apply" data-focus-id="apply" ${flag(applyOff, "disabled")}>${t("builder.apply")}</button>
      </div>
      <p class="reason" id="save-reason" data-save-reason>${reason}</p>
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
  if (readOnly) {
    return html`
      <div class="sech" data-section-id="${s.id}">
        <h2 class="sech-t">${title}</h2>${chips}
        <span class="tnum dim12" data-section-weight="${s.id}">${t("builder.sectionWeight", { weight: formatHundredths(derived, ctx.locale) })}</span>
        ${add}
      </div>`;
  }
  const nameBad = validation.badSection.has(s.id);
  const weightBad = validation.badSectionWeight.has(s.id);
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
  return html`
    <div class="sech sech-edit" data-section-id="${s.id}">
      <h2 class="sech-t"><input class="field sname" type="text" data-field="sec-name" data-section="${s.id}" data-focus-id="sn-${s.id}" value="${sectionTitleDraft(s, ctx.locale)}" aria-label="${t("builder.sec.nameLabel", { num: index + 1 })}" aria-describedby="sec-note-${s.id}" ${nameBad ? raw('aria-invalid="true"') : ""}></h2>${chips}
      <label class="sw dim12">${t("builder.sec.weightLabel")}<input class="field tnum swf" type="text" inputmode="decimal" data-field="sec-weight" data-section="${s.id}" data-section-weight="${s.id}" data-focus-id="sw-${s.id}" value="${weightText}" aria-label="${t("builder.sec.weightAria", { name: title })}" aria-describedby="sec-note-${s.id}" ${weightBad ? raw('aria-invalid="true"') : ""} ${flag(noScored, "disabled")}></label>
      <span class="mv">
        <button type="button" class="btn btn-sm btn-ghost ib" data-action="section-up" data-section="${s.id}" data-focus-id="sup-${s.id}" aria-label="${t("builder.sec.moveUp", { name: title })}" ${flag(index === 0, "disabled")}>${icon("up", 14)}</button>
        <button type="button" class="btn btn-sm btn-ghost ib" data-action="section-down" data-section="${s.id}" data-focus-id="sdown-${s.id}" aria-label="${t("builder.sec.moveDown", { name: title })}" ${flag(index === count - 1, "disabled")}>${icon("down", 14)}</button>
      </span>
      <button type="button" class="btn btn-sm btn-ghost ib" data-action="remove-section" data-section="${s.id}" data-focus-id="rms-${s.id}" aria-label="${t("builder.sec.delete", { name: title })}" ${deleteHint ? raw(`title="${deleteHint}"`) : ""} ${flag(!canDelete, "disabled")}>${icon("close", 14)}</button>
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
  const duplicate = v.isDefault || options.editing
    ? html`<button type="button" class="btn btn-sm dup" data-action="duplicate" data-version="${v.id}" data-focus-id="dup-${v.id}" ${flag(off, "disabled")}>${t("builder.side.duplicate")}</button>`
    : html``;
  const activate = v.status === "saved" && !v.isDefault
    ? html`<button type="button" class="btn btn-sm dup" data-action="activate" data-version="${v.id}" data-focus-id="act-${v.id}" aria-label="${t("builder.side.activateLabel", { version: `v${v.version}` })}" ${flag(off, "disabled")}>${t("builder.side.activate")}</button>`
    : html``;
  const note = v.isDefault ? html`<span class="dim12">${t("builder.side.immutable")}</span>` : html``;
  const cls = options.editing ? "vrow vedit" : "vrow";
  return html`
    <div class="${cls}" data-version-row="${v.id}" ${options.editing ? raw("data-editing") : raw("")}>
      <div class="vline"><b class="tnum">v${v.version}</b>${chip({ tone, text: label })}${lock}</div>
      <span class="tnum sub2">${line}</span>
      ${note}
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

export function sidebar(ctx) {
  const { t, lists, current, draft } = ctx;
  const blocks = lists.map((cl) => {
    const isCurrent = cl.id === current.id;
    const title = isCurrent
      ? html`<span class="side-t" data-checklist-title="${cl.id}">${cl.name}</span>`
      : html`<button type="button" class="side-t side-link" data-action="open-checklist" data-id="${cl.id}" data-focus-id="open-${cl.id}" aria-label="${t("builder.side.open", { name: cl.name })}">${cl.name}</button>`;
    let rows = html``;
    if (isCurrent) {
      const own = cl.versions.find((v) => v.id === draft.versionId);
      const base = own || { id: draft.versionId, version: draft.versionNumber, status: "draft", isDefault: false, appliedCount: 0, firstAppliedAt: null, locked: false };
      const first = ctx.status === "draft"
        ? html`
          <div class="vrow vedit" data-editing data-version-row="${draft.versionId ?? "new"}">
            <div class="vline"><b class="tnum">v${draft.versionNumber}</b>${chip({ tone: "warn", text: t("builder.status.draft") })}</div>
            <span class="sub2">${t("builder.side.editing", { date: dateText(draft.createdAt, ctx.locale) })}</span>
          </div>`
        : versionRow(ctx, { ...base, locked: ctx.status === "applied" || base.locked }, { editing: true, status: ctx.status });
      const shown = cl.versions.filter((v) => v.id !== draft.versionId);
      const history = [...shown].sort((a, b) => b.version - a.version).map((v) => versionRow(ctx, v));
      rows = html`${first}${history}`;
    } else {
      rows = [...cl.versions].sort((a, b) => b.version - a.version).map((v) => versionRow(ctx, v));
    }
    return html`<div class="side-block">${title}${channelsBlock(ctx, cl, isCurrent)}${rows}</div>`;
  });
  return html`
    ${blocks}
    <button type="button" class="btn btn-sm btn-ghost newc" data-action="new-checklist" data-seam="new-checklist" disabled>${icon("plus", 14)}${t("builder.side.newChecklist")}</button>`;
}
