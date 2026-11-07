import { api } from "../api.js";

const TYPES = [
  ["yes_no", "Yes / No"],
  ["scale", "Scale"],
  ["flag", "Flag"]
];

const template = document.createElement("template");
template.innerHTML = `
<style>
:host { display: block; color: #1c2430; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h2 { margin: 0 0 12px; font-size: 18px; }
h3 { margin: 0 0 8px; font-size: 15px; }
.panel { background: #fff; border: 1px solid #d9dee6; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #4a5565; }
label.inline { flex-direction: row; align-items: center; gap: 6px; }
input, select, textarea { font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid #b9c2cf; border-radius: 6px; background: #fff; color: inherit; box-sizing: border-box; }
textarea { width: 100%; min-height: 56px; resize: vertical; }
button { font: inherit; font-size: 13px; padding: 6px 12px; border: 1px solid #12263f; background: #12263f; color: #fff; border-radius: 6px; cursor: pointer; }
button.secondary { background: #fff; color: #12263f; }
button.danger { background: #fff; color: #a32020; border-color: #a32020; }
button.small { padding: 3px 8px; font-size: 12px; }
button:disabled { opacity: 0.5; cursor: default; }
.weight { display: flex; align-items: center; gap: 12px; margin: 12px 0; font-size: 14px; }
.weight .sum { font-weight: 700; }
.warning { background: #fff4d6; border: 1px solid #e3b341; color: #6b4b00; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.error { background: #fde8e8; border: 1px solid #d14343; color: #7a1414; padding: 8px 12px; border-radius: 6px; font-size: 13px; margin: 8px 0; white-space: pre-wrap; }
.ok { background: #e6f4ea; border: 1px solid #4c9a62; color: #17492a; padding: 8px 12px; border-radius: 6px; font-size: 13px; margin: 8px 0; }
.muted { color: #6b7686; font-size: 13px; }
.criterion { border: 1px solid #d9dee6; border-radius: 8px; padding: 12px; margin-bottom: 12px; background: #fbfcfd; }
.criterion-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.criterion-head .title { font-weight: 600; flex: 1; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 8px; }
.steps { margin-top: 8px; border-top: 1px dashed #c4ccd8; padding-top: 8px; }
.step { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.step input.value { width: 70px; }
.step input.descriptor { flex: 1; }
.sections .row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.sections input.sid { width: 140px; }
.sections input.stitle { flex: 1; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e8ee; }
.rerun-list { max-height: 260px; overflow: auto; border: 1px solid #e5e8ee; border-radius: 6px; margin: 8px 0; }
.bar { height: 10px; background: #e5e8ee; border-radius: 5px; overflow: hidden; margin: 8px 0 4px; }
.bar .fill { height: 100%; width: 0; background: #2f6fbf; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
a { color: #1f5fa8; }
</style>
<h2>Checklist editor</h2>
<div class="panel">
  <div class="toolbar">
    <label>Version<select class="version-picker"></select></label>
    <button type="button" class="set-default secondary">Set this version as default</button>
    <span class="version-info muted"></span>
  </div>
  <div class="top-message"></div>
</div>
<div class="panel">
  <div class="toolbar">
    <label style="flex:1;min-width:240px">Checklist name<input class="name" type="text"></label>
  </div>
  <div class="sections"></div>
  <div class="weight"><span>Sum of weights:</span><span class="sum"></span><span class="weight-warning"></span></div>
  <div class="criteria"></div>
  <div class="actions">
    <button type="button" class="add-criterion secondary">Add criterion</button>
    <label class="inline"><input type="checkbox" class="make-default" checked> Make the new version the default</label>
    <button type="button" class="save">Save as new version</button>
  </div>
  <div class="save-message"></div>
</div>
<div class="panel rerun">
  <h3>Re-run with the selected version</h3>
  <div class="toolbar">
    <label>Dataset<select class="rerun-dataset"></select></label>
    <label class="inline"><input type="checkbox" class="rerun-force"> Re-evaluate finished</label>
    <button type="button" class="rerun-selected">Re-run selected</button>
    <button type="button" class="rerun-all secondary">Re-run all</button>
  </div>
  <div class="rerun-message"></div>
  <div class="bar" hidden><div class="fill"></div></div>
  <div class="rerun-progress muted"></div>
  <div class="rerun-list"></div>
</div>
`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node[key] = value;
  }
  for (const child of children) node.appendChild(child);
  return node;
}

class CqaChecklistEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.checklist = null;
    this.version = null;
    this.draft = null;
    this.dirty = false;
    this.pollTimer = null;
    this.pollingJob = null;
    this.conversations = [];
    this.selected = new Set();
  }

  q(selector) {
    return this.shadowRoot.querySelector(selector);
  }

  connectedCallback() {
    this.q(".version-picker").addEventListener("change", () => this.pickVersion(Number(this.q(".version-picker").value)));
    this.q(".set-default").addEventListener("click", () => this.makeDefault());
    this.q(".name").addEventListener("input", () => {
      this.draft.name = this.q(".name").value;
      this.markDirty();
    });
    this.q(".add-criterion").addEventListener("click", () => this.addCriterion());
    this.q(".save").addEventListener("click", () => this.save());
    this.q(".rerun-dataset").addEventListener("change", () => this.loadRerunList());
    this.q(".rerun-selected").addEventListener("click", () => this.rerun(true));
    this.q(".rerun-all").addEventListener("click", () => this.rerun(false));
    this.init();
  }

  disconnectedCallback() {
    this.stopPolling();
  }

  setMessage(selector, kind, text) {
    const holder = this.q(selector);
    holder.innerHTML = "";
    if (!text) return;
    holder.appendChild(el("div", { class: kind, text }));
  }

  async init() {
    try {
      const checklists = await api.listChecklists();
      if (!checklists.length) {
        this.setMessage(".top-message", "error", "No checklist exists on the server.");
        return;
      }
      this.checklist = checklists[0];
      const target = this.checklist.default_version_id || this.checklist.versions[this.checklist.versions.length - 1].id;
      await this.loadVersion(target);
      this.refreshDatasets();
    } catch (err) {
      this.setMessage(".top-message", "error", err.message);
    }
  }

  async refreshChecklist() {
    this.checklist = await api.getChecklist(this.checklist.id);
  }

  async loadVersion(versionId) {
    const version = await api.getChecklistVersion(versionId);
    this.version = version;
    this.draft = clone(version.config);
    for (const criterion of this.draft.criteria) {
      criterion.description = criterion.description || "";
      criterion.section = criterion.section || "";
      criterion.na_condition = criterion.na_condition || "";
      criterion.scale_steps = criterion.scale_steps || [];
    }
    this.dirty = false;
    this.renderVersionPicker();
    this.renderAll();
    this.setMessage(".save-message", "", "");
    this.loadRerunList();
  }

  renderVersionPicker() {
    const select = this.q(".version-picker");
    select.innerHTML = "";
    for (const version of this.checklist.versions) {
      const label = "v" + version.version + (version.is_default ? " (default)" : "") + " - " + version.criteria_count + " criteria, weights " + version.weight_sum;
      select.appendChild(el("option", { value: version.id, text: label }));
    }
    select.value = this.version.id;
    const isDefault = this.checklist.default_version_id === this.version.id;
    this.q(".set-default").disabled = isDefault;
    this.q(".version-info").textContent = "Editing a copy of v" + this.version.version + ". Saved versions are immutable; saving creates a new version.";
  }

  async pickVersion(id) {
    if (this.dirty && !window.confirm("Discard unsaved changes?")) {
      this.q(".version-picker").value = this.version.id;
      return;
    }
    try {
      await this.loadVersion(id);
    } catch (err) {
      this.setMessage(".top-message", "error", err.message);
    }
  }

  async makeDefault() {
    try {
      await api.setDefaultVersion(this.checklist.id, this.version.id);
      await this.refreshChecklist();
      this.renderVersionPicker();
      this.setMessage(".top-message", "ok", "v" + this.version.version + " is now the default version.");
    } catch (err) {
      this.setMessage(".top-message", "error", err.message);
    }
  }

  markDirty() {
    this.dirty = true;
    this.updateWeight();
  }

  weightSum() {
    const total = this.draft.criteria.reduce((sum, c) => sum + (c.type === "flag" ? 0 : Number(c.weight) || 0), 0);
    return Math.round(total * 1e6) / 1e6;
  }

  updateWeight() {
    const total = this.weightSum();
    this.q(".sum").textContent = String(total);
    const holder = this.q(".weight-warning");
    holder.innerHTML = "";
    if (Math.abs(total - 100) > 1e-9) {
      holder.appendChild(el("span", { class: "warning", text: "Weights sum to " + total + ", not 100. You can still save." }));
    }
  }

  renderAll() {
    this.q(".name").value = this.draft.name;
    this.renderSections();
    this.renderCriteria();
    this.updateWeight();
  }

  renderSections() {
    const holder = this.q(".sections");
    holder.innerHTML = "";
    holder.appendChild(el("h3", { text: "Sections" }));
    this.draft.sections.forEach((section, index) => {
      const id = el("input", { class: "sid", type: "text", value: section.id, placeholder: "id" });
      const title = el("input", { class: "stitle", type: "text", value: section.title, placeholder: "title" });
      id.addEventListener("input", () => {
        const old = section.id;
        section.id = id.value;
        for (const c of this.draft.criteria) if (c.section === old) c.section = section.id;
        this.dirty = true;
      });
      id.addEventListener("change", () => this.renderCriteria());
      title.addEventListener("input", () => {
        section.title = title.value;
        this.dirty = true;
      });
      title.addEventListener("change", () => this.renderCriteria());
      const remove = el("button", { type: "button", class: "danger small", text: "Remove" });
      remove.addEventListener("click", () => {
        const gone = this.draft.sections.splice(index, 1)[0];
        for (const c of this.draft.criteria) if (c.section === gone.id) c.section = "";
        this.dirty = true;
        this.renderSections();
        this.renderCriteria();
      });
      holder.appendChild(el("div", { class: "row" }, [id, title, remove]));
    });
    const add = el("button", { type: "button", class: "secondary small", text: "Add section" });
    add.addEventListener("click", () => {
      let n = this.draft.sections.length + 1;
      while (this.draft.sections.some((s) => s.id === "section" + n)) n += 1;
      this.draft.sections.push({ id: "section" + n, title: "New section" });
      this.dirty = true;
      this.renderSections();
      this.renderCriteria();
    });
    holder.appendChild(add);
  }

  nextCriterionId() {
    let n = this.draft.criteria.length + 1;
    const ids = new Set(this.draft.criteria.map((c) => c.id));
    while (ids.has(String(n).padStart(2, "0"))) n += 1;
    return String(n).padStart(2, "0");
  }

  addCriterion() {
    this.draft.criteria.push({
      id: this.nextCriterionId(),
      title: "New criterion",
      description: "",
      section: this.draft.sections.length ? this.draft.sections[0].id : "",
      weight: 0,
      type: "yes_no",
      na_allowed: false,
      na_condition: "",
      scale_steps: []
    });
    this.dirty = true;
    this.renderCriteria();
    this.updateWeight();
  }

  moveCriterion(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= this.draft.criteria.length) return;
    const [item] = this.draft.criteria.splice(index, 1);
    this.draft.criteria.splice(target, 0, item);
    this.dirty = true;
    this.renderCriteria();
  }

  removeCriterion(index) {
    this.draft.criteria.splice(index, 1);
    this.dirty = true;
    this.renderCriteria();
    this.updateWeight();
  }

  field(label, input) {
    return el("label", {}, [document.createTextNode(label), input]);
  }

  bindText(input, criterion, key, rerender) {
    input.addEventListener("input", () => {
      criterion[key] = input.value;
      this.markDirty();
      if (key === "title") {
        const heading = input.closest(".criterion").querySelector(".title");
        heading.textContent = (criterion.id || "") + " - " + criterion.title;
      }
    });
    if (rerender) input.addEventListener("change", () => this.renderCriteria());
    return input;
  }

  renderCriteria() {
    const holder = this.q(".criteria");
    holder.innerHTML = "";
    this.draft.criteria.forEach((criterion, index) => {
      const card = el("div", { class: "criterion" });
      card.dataset.index = index;
      const up = el("button", { type: "button", class: "secondary small up", text: "Up" });
      const down = el("button", { type: "button", class: "secondary small down", text: "Down" });
      const remove = el("button", { type: "button", class: "danger small remove", text: "Remove" });
      up.disabled = index === 0;
      down.disabled = index === this.draft.criteria.length - 1;
      up.addEventListener("click", () => this.moveCriterion(index, -1));
      down.addEventListener("click", () => this.moveCriterion(index, 1));
      remove.addEventListener("click", () => this.removeCriterion(index));
      card.appendChild(el("div", { class: "criterion-head" }, [
        el("span", { class: "title", text: criterion.id + " - " + criterion.title }), up, down, remove
      ]));

      const id = this.bindText(el("input", { class: "f-id", type: "text", value: criterion.id }), criterion, "id");
      const title = this.bindText(el("input", { class: "f-title", type: "text", value: criterion.title }), criterion, "title");
      const weight = el("input", { class: "f-weight", type: "number", step: "any", min: "0", value: criterion.weight });
      weight.addEventListener("input", () => {
        criterion.weight = weight.value === "" ? 0 : Number(weight.value);
        this.markDirty();
      });
      const type = el("select", { class: "f-type" });
      for (const [value, label] of TYPES) type.appendChild(el("option", { value, text: label }));
      type.value = criterion.type;
      type.addEventListener("change", () => {
        criterion.type = type.value;
        if (criterion.type === "flag") {
          criterion.weight = 0;
          criterion.na_allowed = false;
        }
        if (criterion.type === "scale" && criterion.scale_steps.length === 0) {
          criterion.scale_steps = [{ value: 0, descriptor: "" }, { value: 1, descriptor: "" }];
        }
        this.dirty = true;
        this.renderCriteria();
        this.updateWeight();
      });
      const section = el("select", { class: "f-section" });
      section.appendChild(el("option", { value: "", text: "(none)" }));
      for (const s of this.draft.sections) section.appendChild(el("option", { value: s.id, text: s.title || s.id }));
      section.value = criterion.section;
      section.addEventListener("change", () => {
        criterion.section = section.value;
        this.dirty = true;
      });
      card.appendChild(el("div", { class: "grid" }, [
        this.field("ID", id), this.field("Title", title), this.field("Section", section),
        this.field("Weight", weight), this.field("Type", type)
      ]));

      const description = el("textarea", { class: "f-description", value: criterion.description });
      this.bindText(description, criterion, "description");
      card.appendChild(this.field("Description (evaluator guidance)", description));

      const naBox = el("input", { class: "f-na", type: "checkbox", checked: !!criterion.na_allowed });
      naBox.addEventListener("change", () => {
        criterion.na_allowed = naBox.checked;
        this.dirty = true;
      });
      const naCondition = el("textarea", { class: "f-na-condition", value: criterion.na_condition });
      this.bindText(naCondition, criterion, "na_condition");
      card.appendChild(el("label", { class: "inline" }, [naBox, document.createTextNode("N/A allowed")]));
      card.appendChild(this.field("N/A condition", naCondition));

      if (criterion.type === "scale") card.appendChild(this.renderSteps(criterion));
      holder.appendChild(card);
    });
    if (!this.draft.criteria.length) holder.appendChild(el("div", { class: "muted", text: "No criteria. Add one." }));
  }

  renderSteps(criterion) {
    const box = el("div", { class: "steps" }, [el("h3", { text: "Scale steps" })]);
    criterion.scale_steps.forEach((step, index) => {
      const value = el("input", { class: "value step-value", type: "number", min: "0", step: "any", value: step.value });
      value.addEventListener("input", () => {
        step.value = value.value === "" ? 0 : Number(value.value);
        this.dirty = true;
      });
      const descriptor = el("input", { class: "descriptor step-descriptor", type: "text", value: step.descriptor, placeholder: "descriptor" });
      descriptor.addEventListener("input", () => {
        step.descriptor = descriptor.value;
        this.dirty = true;
      });
      const remove = el("button", { type: "button", class: "danger small step-remove", text: "Remove" });
      remove.addEventListener("click", () => {
        criterion.scale_steps.splice(index, 1);
        this.dirty = true;
        this.renderCriteria();
      });
      box.appendChild(el("div", { class: "step" }, [value, descriptor, remove]));
    });
    const add = el("button", { type: "button", class: "secondary small step-add", text: "Add step" });
    add.addEventListener("click", () => {
      const top = criterion.scale_steps.reduce((m, s) => Math.max(m, Number(s.value) || 0), -1);
      criterion.scale_steps.push({ value: top + 1, descriptor: "" });
      this.dirty = true;
      this.renderCriteria();
    });
    box.appendChild(add);
    return box;
  }

  buildPayload() {
    const sections = this.draft.sections.map((s) => ({ id: s.id, title: s.title }));
    const criteria = this.draft.criteria.map((c) => {
      const out = {
        id: c.id,
        title: c.title,
        description: c.description || "",
        section: c.section || null,
        weight: Number(c.weight) || 0,
        type: c.type,
        na_allowed: !!c.na_allowed,
        na_condition: c.na_condition && c.na_condition.trim() ? c.na_condition : null
      };
      if (c.type === "scale") out.scale_steps = c.scale_steps.map((s) => ({ value: s.value, descriptor: s.descriptor }));
      return out;
    });
    return { name: this.draft.name, sections, criteria };
  }

  async save() {
    this.q(".save").disabled = true;
    this.setMessage(".save-message", "", "");
    try {
      const created = await api.createChecklistVersion(this.checklist.id, this.buildPayload());
      if (this.q(".make-default").checked) await api.setDefaultVersion(this.checklist.id, created.id);
      await this.refreshChecklist();
      await this.loadVersion(created.id);
      let text = "Saved as version " + created.version + ".";
      if (created.warnings && created.warnings.length) text += " Warning: " + created.warnings.join("; ") + ".";
      this.setMessage(".save-message", created.warnings && created.warnings.length ? "warning" : "ok", text);
    } catch (err) {
      this.setMessage(".save-message", "error", "Not saved: " + err.message);
    } finally {
      this.q(".save").disabled = false;
    }
  }

  async refreshDatasets() {
    const select = this.q(".rerun-dataset");
    try {
      const datasets = await api.listDatasets();
      select.innerHTML = "";
      for (const d of datasets) {
        select.appendChild(el("option", { value: d.group_id, text: d.group_id + " (" + d.conversations + ")" }));
      }
      await this.loadRerunList();
    } catch (err) {
      this.setMessage(".rerun-message", "error", err.message);
    }
  }

  async loadRerunList() {
    const dataset = this.q(".rerun-dataset").value;
    const holder = this.q(".rerun-list");
    if (!dataset || !this.version) {
      holder.innerHTML = "";
      holder.appendChild(el("div", { class: "muted", text: "No dataset imported." }));
      return;
    }
    try {
      this.conversations = await api.listConversations({ dataset, checklist_version_id: this.version.id });
    } catch (err) {
      this.setMessage(".rerun-message", "error", err.message);
      return;
    }
    const known = new Set(this.conversations.map((c) => c.id));
    this.selected = new Set([...this.selected].filter((id) => known.has(id)));
    this.renderRerunList();
  }

  renderRerunList() {
    const holder = this.q(".rerun-list");
    holder.innerHTML = "";
    if (!this.conversations.length) {
      holder.appendChild(el("div", { class: "muted", text: "No conversations in this dataset." }));
      return;
    }
    const table = el("table");
    const head = el("tr");
    const all = el("input", { type: "checkbox", class: "select-all" });
    all.checked = this.selected.size === this.conversations.length;
    all.addEventListener("change", () => {
      this.selected = all.checked ? new Set(this.conversations.map((c) => c.id)) : new Set();
      this.renderRerunList();
    });
    head.appendChild(el("th", {}, [all]));
    for (const label of ["Conversation", "Channel", "Version", "Status", "Total"]) head.appendChild(el("th", { text: label }));
    table.appendChild(head);
    for (const c of this.conversations) {
      const box = el("input", { type: "checkbox", class: "row-select", checked: this.selected.has(c.id) });
      box.dataset.pk = c.id;
      box.addEventListener("change", () => {
        if (box.checked) this.selected.add(c.id);
        else this.selected.delete(c.id);
        all.checked = this.selected.size === this.conversations.length;
      });
      const link = el("a", { href: "#/conversations/" + c.id, text: c.conversation_id });
      const total = c.total === null || c.total === undefined ? "-" : String(Math.round(c.total * 100) / 100) + (c.provisional ? " (provisional)" : "");
      table.appendChild(el("tr", {}, [
        el("td", {}, [box]),
        el("td", {}, [link]),
        el("td", { text: c.channel || "" }),
        el("td", { text: c.checklist_version_label || "not evaluated" }),
        el("td", { text: c.eval_status || "-" }),
        el("td", { class: "row-total", text: total })
      ]));
    }
    holder.appendChild(table);
  }

  async rerun(onlySelected) {
    const dataset = this.q(".rerun-dataset").value;
    if (!dataset) {
      this.setMessage(".rerun-message", "error", "Import a dataset first.");
      return;
    }
    if (this.dirty) {
      this.setMessage(".rerun-message", "warning", "There are unsaved edits. The re-run uses the saved version v" + this.version.version + ", not the draft. Save as a new version first.");
    } else {
      this.setMessage(".rerun-message", "", "");
    }
    const payload = { dataset, checklist_version_id: this.version.id, force: this.q(".rerun-force").checked };
    if (onlySelected) {
      if (!this.selected.size) {
        this.setMessage(".rerun-message", "error", "Select at least one conversation.");
        return;
      }
      payload.conversation_pks = [...this.selected];
    }
    this.q(".rerun-selected").disabled = true;
    this.q(".rerun-all").disabled = true;
    try {
      const job = await api.startBatch(payload);
      this.trackJob(job);
    } catch (err) {
      this.q(".rerun-selected").disabled = false;
      this.q(".rerun-all").disabled = false;
      this.setMessage(".rerun-message", "error", "Re-run failed to start: " + err.message);
    }
  }

  stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollingJob = null;
  }

  trackJob(job) {
    this.stopPolling();
    this.pollingJob = job.id;
    this.renderJob(job);
    this.schedulePoll(job.id);
  }

  schedulePoll(id) {
    this.pollTimer = setTimeout(async () => {
      if (this.pollingJob !== id) return;
      let job;
      try {
        job = await api.getBatch(id);
      } catch (err) {
        this.setMessage(".rerun-message", "error", "Progress unavailable: " + err.message);
        this.finishJob();
        return;
      }
      if (this.pollingJob !== id) return;
      this.renderJob(job);
      await this.loadRerunList();
      if (job.status === "running" || job.status === "queued") {
        this.schedulePoll(id);
      } else {
        this.finishJob();
      }
    }, 600);
  }

  finishJob() {
    this.q(".rerun-selected").disabled = false;
    this.q(".rerun-all").disabled = false;
    this.pollingJob = null;
  }

  renderJob(job) {
    this.q(".bar").hidden = false;
    this.q(".fill").style.width = job.percent + "%";
    const done = job.status === "completed" || job.status === "failed";
    let text = (done ? "Finished: " : "Running: ") + job.processed + " of " + job.to_run + " evaluated (" + job.percent + "%), skipped " +
      job.skipped + ", completed " + job.completed + ", needs review " + job.needs_review + ", failed " + job.failed;
    if (job.failures.length) text += ". Failures: " + job.failures.map((f) => (f.conversation_id || "batch") + ": " + f.error).join("; ");
    this.q(".rerun-progress").textContent = text;
  }
}

customElements.define("cqa-checklist-editor", CqaChecklistEditor);
