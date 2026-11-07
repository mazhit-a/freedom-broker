import { CqaElement, html, raw } from "../base-element.js";
import { EVENTS, emit } from "../events.js";
import { integer, number } from "../format.js";
import { STEP_ERRORS, formatPoints, parseStepValue, stepPoints, topStep, validateSteps } from "../scale-steps.js";
import { icon } from "../shared/icons.js";
import { SHARED_CSS } from "../shared/styles.js";

const DEFAULT_STEPS = [
  { value: "0", description: "" },
  { value: "10", description: "" }
];

function normalize(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return DEFAULT_STEPS.map((s) => ({ ...s }));
  return steps.map((s) => ({
    value: String(s.value ?? s.step ?? ""),
    description: String(s.description ?? s.label ?? "")
  }));
}

export class CqaScaleStepEditor extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "weight"];
  }

  constructor() {
    super();
    this._steps = normalize(null);
  }

  get steps() {
    return this._steps.map((s) => ({ value: s.value, description: s.description }));
  }

  set steps(list) {
    this._steps = normalize(list);
    if (this._ready) this.scheduleRender();
  }

  get weight() {
    const value = Number(String(this.getAttribute("weight") ?? "").replace(",", "."));
    return Number.isFinite(value) ? value : 0;
  }

  set weight(value) {
    this.setAttribute("weight", String(value));
  }

  get errors() {
    return validateSteps(this._steps);
  }

  get valid() {
    return this.errors.length === 0;
  }

  styles() {
    return `${SHARED_CSS}
      :host { display: block; font-size: var(--cqa-fs-13); color: var(--cqa-ink); }
      .editor { display: flex; flex-direction: column; gap: 10px; }
      .top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .top .label { font-size: var(--cqa-fs-12); color: var(--cqa-ink-2); }
      .grid { display: grid; grid-template-columns: 72px minmax(0, 1fr) 72px 30px; gap: 6px; align-items: center; }
      .grid .field { height: 30px; width: 100%; min-width: 0; }
      .grid .num { text-align: right; font-variant-numeric: tabular-nums; }
      .errors { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; color: var(--cqa-bad); font-size: var(--cqa-fs-12); }
      .errors:empty { display: none; }
      .field[aria-invalid="true"] { border-color: var(--cqa-bad); }
      .actions { display: flex; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      @container (max-width: 420px) {
        .grid { grid-template-columns: 56px minmax(0, 1fr) 56px 30px; }
      }
    `;
  }

  ruleChip() {
    const top = topStep(this._steps);
    if (top === null || top <= 0) return html``;
    const tone = this.valid ? "c-ok" : "c-warn";
    return html`<span class="chip ${raw(tone)}" data-rule>${this.t("scale.rule", { top: integer(top, this.locale), weight: number(this.weight, this.locale, Number.isInteger(this.weight) ? 0 : 2) })}</span>`;
  }

  errorItems() {
    return this.errors.map((code) => html`<li>${this.t(STEP_ERRORS[code])}</li>`);
  }

  template() {
    const points = stepPoints(this._steps, this.weight);
    const rows = this._steps.map((step, i) => {
      const n = i + 1;
      return html`
        <input class="field tnum num" type="text" inputmode="decimal" data-field="value" data-index="${i}" data-focus-id="value-${i}" value="${step.value}" aria-label="${this.t("scale.value", { n })}">
        <input class="field" type="text" data-field="description" data-index="${i}" data-focus-id="description-${i}" value="${step.description}" aria-label="${this.t("scale.description", { n })}">
        <span class="num tnum"><span class="sr">${this.t("scale.points", { n })}: </span><span data-points="${i}">${formatPoints(points[i], this.locale)}</span></span>
        <button type="button" class="btn btn-ghost btn-sm" data-action="remove" data-index="${i}" data-focus-id="remove-${i}" aria-label="${this.t("scale.remove", { n })}">${icon("close", 14)}</button>`;
    });
    return html`
      <div class="editor">
        <div class="top"><span class="label">${this.t("scale.steps")}</span><span data-rule-slot>${this.ruleChip()}</span></div>
        <div class="grid">${rows}</div>
        <ul class="errors" data-errors aria-live="polite">${this.errorItems()}</ul>
        <div class="actions"><button type="button" class="btn btn-sm" data-action="add" data-focus-id="add">${icon("plus", 12)}${this.t("scale.add")}</button></div>
      </div>
    `;
  }

  refresh() {
    const root = this.shadowRoot;
    const points = stepPoints(this._steps, this.weight);
    root.querySelectorAll("[data-points]").forEach((cell) => {
      cell.textContent = formatPoints(points[Number(cell.getAttribute("data-points"))], this.locale);
    });
    root.querySelector("[data-rule-slot]").innerHTML = String(this.ruleChip());
    root.querySelector("[data-errors]").innerHTML = String(this.errorItems());
    this.markInvalid();
  }

  markInvalid() {
    const errors = this.errors;
    this.shadowRoot.querySelectorAll("[data-field=value]").forEach((input, i) => {
      const bad = parseStepValue(input.value) === null || (i === 0 && errors.includes("zero"));
      if (bad) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    });
  }

  announce() {
    const errors = this.errors;
    emit(this, EVENTS.stepsChange, { steps: this.steps, valid: errors.length === 0, errors });
  }

  bind(region) {
    region.addEventListener("input", (event) => {
      const input = event.target.closest("[data-field]");
      if (!input) return;
      const step = this._steps[Number(input.getAttribute("data-index"))];
      step[input.getAttribute("data-field")] = input.value;
      this.refresh();
      this.announce();
    });
    region.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.getAttribute("data-action");
      let focusKey;
      if (action === "add") {
        const last = topStep(this._steps);
        this._steps.push({ value: last === null ? "" : String(last + 1), description: "" });
        focusKey = `value-${this._steps.length - 1}`;
      } else if (action === "remove") {
        const index = Number(button.getAttribute("data-index"));
        this._steps.splice(index, 1);
        focusKey = this._steps.length ? `value-${Math.min(index, this._steps.length - 1)}` : "add";
      } else {
        return;
      }
      this.renderNow();
      const target = this.shadowRoot.querySelector(`[data-focus-id="${focusKey}"]`);
      if (target) target.focus();
      this.announce();
    });
  }

  afterRender(region) {
    if (!this._bound) {
      this._bound = true;
      this.bind(region);
    }
    this.markInvalid();
  }
}
