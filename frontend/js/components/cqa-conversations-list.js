import { api } from "../api.js";

const template = document.createElement("template");
template.innerHTML = `
<style>
:host { display: block; }
section { background: #fff; border: 1px solid #dde2ea; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
h2 { margin: 0 0 12px; font-size: 16px; }
.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #55637a; }
input[type="text"], select { padding: 6px 8px; border: 1px solid #b8c2d1; border-radius: 6px; font: inherit; min-width: 140px; }
button { padding: 7px 14px; border: 1px solid #274769; background: #274769; color: #fff; border-radius: 6px; cursor: pointer; font: inherit; }
button:disabled { opacity: 0.5; cursor: default; }
button.secondary { background: #fff; color: #274769; }
.error { margin-top: 12px; padding: 10px 12px; background: #fdecec; border: 1px solid #e5a3a3; color: #8a1f1f; border-radius: 6px; white-space: pre-wrap; }
.notice { margin-top: 12px; padding: 10px 12px; background: #e9f6ee; border: 1px solid #9fd3b2; color: #1d5a35; border-radius: 6px; }
.state { padding: 24px; text-align: center; color: #55637a; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e6e9ef; }
th { font-size: 12px; text-transform: uppercase; color: #55637a; background: #f8f9fb; }
th.pending { color: #8b96a8; font-style: italic; }
td.pending { color: #a3acba; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: #f1f5fa; }
.count { color: #55637a; font-size: 13px; margin-bottom: 8px; }
a { color: #1b5fb0; }
</style>
<section class="import">
  <h2>Import dataset</h2>
  <div class="row">
    <label>group_id<input type="text" class="group" placeholder="DEV"></label>
    <button type="button" class="import-api">Import</button>
    <label>or JSON file<input type="file" class="file" accept=".json,application/json"></label>
    <button type="button" class="import-file secondary">Upload file</button>
  </div>
  <div class="import-message"></div>
</section>
<section class="listing">
  <h2>Conversations</h2>
  <div class="row filters">
    <label>Dataset<select class="dataset"></select></label>
    <label>Language<select class="language"></select></label>
    <label>Channel<select class="channel"></select></label>
  </div>
  <div class="list-message"></div>
  <div class="table-holder"></div>
</section>
`;

const COLUMNS = [
  { key: "conversation_id", label: "Conversation" },
  { key: "channel", label: "Channel" },
  { key: "language", label: "Language" },
  { key: "checklist_version", label: "Checklist version", pending: true },
  { key: "total", label: "Total", pending: true },
  { key: "flag", label: "Flag", pending: true },
  { key: "appeal_status", label: "Appeal status", pending: true }
];

class CqaConversationsList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.datasets = [];
    this.languages = new Set();
    this.channels = new Set();
    this.requestSeq = 0;
  }

  connectedCallback() {
    const root = this.shadowRoot;
    this.q = (selector) => root.querySelector(selector);
    this.q(".import-api").addEventListener("click", () => this.importByGroup());
    this.q(".import-file").addEventListener("click", () => this.importFile());
    this.q(".group").addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.importByGroup();
    });
    this.q(".dataset").addEventListener("change", () => this.datasetChanged());
    this.q(".language").addEventListener("change", () => this.loadList());
    this.q(".channel").addEventListener("change", () => this.loadList());
    this.fillSelect(this.q(".language"), [], "");
    this.fillSelect(this.q(".channel"), [], "");
    this.init();
  }

  async init() {
    try {
      await this.refreshDatasets(null);
    } catch (err) {
      this.showListError(err.message);
      return;
    }
    await this.loadList();
  }

  fillSelect(select, values, current, allLabel = "All") {
    select.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    select.appendChild(all);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    select.value = values.includes(current) ? current : "";
  }

  async refreshDatasets(preferred) {
    this.datasets = await api.listDatasets();
    const select = this.q(".dataset");
    const current = preferred || select.value;
    select.innerHTML = "";
    for (const dataset of this.datasets) {
      const option = document.createElement("option");
      option.value = dataset.group_id;
      option.textContent = dataset.group_id + " (" + dataset.conversations + ")";
      select.appendChild(option);
    }
    const known = this.datasets.map((d) => d.group_id);
    if (known.includes(current)) {
      select.value = current;
    } else if (known.length) {
      select.value = known[0];
    }
  }

  datasetChanged() {
    this.languages = new Set();
    this.channels = new Set();
    this.fillSelect(this.q(".language"), [], "");
    this.fillSelect(this.q(".channel"), [], "");
    this.loadList();
  }

  filters() {
    return {
      dataset: this.q(".dataset").value,
      language: this.q(".language").value,
      channel: this.q(".channel").value
    };
  }

  async loadList() {
    const filters = this.filters();
    const holder = this.q(".table-holder");
    this.q(".list-message").innerHTML = "";
    if (!filters.dataset) {
      holder.innerHTML = '<div class="state empty">No dataset imported yet. Import one above.</div>';
      return;
    }
    const seq = ++this.requestSeq;
    holder.innerHTML = '<div class="state loading">Loading conversations...</div>';
    let rows;
    try {
      rows = await api.listConversations(filters);
    } catch (err) {
      if (seq === this.requestSeq) this.showListError(err.message);
      return;
    }
    if (seq !== this.requestSeq) return;
    if (!filters.language && !filters.channel) {
      this.languages = new Set(rows.map((r) => r.language).filter(Boolean));
      this.channels = new Set(rows.map((r) => r.channel).filter(Boolean));
      this.fillSelect(this.q(".language"), [...this.languages].sort(), "");
      this.fillSelect(this.q(".channel"), [...this.channels].sort(), "");
    }
    this.renderTable(rows);
  }

  showListError(message) {
    this.q(".table-holder").innerHTML = "";
    this.setMessage(".list-message", "error", message);
  }

  setMessage(selector, kind, text) {
    const holder = this.q(selector);
    holder.innerHTML = "";
    if (!text) return;
    const box = document.createElement("div");
    box.className = kind;
    box.textContent = text;
    holder.appendChild(box);
  }

  renderTable(rows) {
    const holder = this.q(".table-holder");
    holder.innerHTML = "";
    const count = document.createElement("div");
    count.className = "count";
    count.textContent = rows.length + " conversations";
    holder.appendChild(count);
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "state empty";
      empty.textContent = "No conversations match the filters.";
      holder.appendChild(empty);
      return;
    }
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const col of COLUMNS) {
      const th = document.createElement("th");
      th.textContent = col.label;
      if (col.pending) th.className = "pending";
      head.appendChild(th);
    }
    const thead = document.createElement("thead");
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.dataset.id = row.id;
      for (const col of COLUMNS) {
        const td = document.createElement("td");
        if (col.pending) {
          td.className = "pending";
          td.textContent = "-";
        } else {
          td.textContent = row[col.key] == null ? "" : row[col.key];
        }
        tr.appendChild(td);
      }
      tr.addEventListener("click", () => {
        window.location.hash = "#/conversations/" + row.id;
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    holder.appendChild(table);
  }

  setBusy(busy) {
    this.q(".import-api").disabled = busy;
    this.q(".import-file").disabled = busy;
  }

  async runImport(call) {
    this.setBusy(true);
    this.setMessage(".import-message", "notice", "Importing...");
    try {
      const result = await call();
      this.setMessage(
        ".import-message",
        "notice",
        "Imported " + result.group_id + ": " + result.total_conversations + " conversations (" +
          result.created + " new, " + result.updated + " updated)."
      );
      await this.refreshDatasets(result.group_id);
      this.datasetChanged();
    } catch (err) {
      this.setMessage(".import-message", "error", "Import failed: " + err.message);
    } finally {
      this.setBusy(false);
    }
  }

  importByGroup() {
    const groupId = this.q(".group").value.trim() || "DEV";
    return this.runImport(() => api.importByGroup(groupId));
  }

  importFile() {
    const file = this.q(".file").files[0];
    if (!file) {
      this.setMessage(".import-message", "error", "Choose a JSON file first.");
      return Promise.resolve();
    }
    const groupId = this.q(".group").value.trim();
    return this.runImport(() => api.importFile(file, groupId));
  }
}

customElements.define("cqa-conversations-list", CqaConversationsList);
