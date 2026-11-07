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
.bar { height: 14px; background: #e6e9ef; border-radius: 7px; overflow: hidden; margin: 10px 0 6px; }
.bar .fill { height: 100%; width: 0; background: #274769; transition: width 0.2s; }
.progress-text { font-size: 13px; color: #55637a; }
.failed-list { margin: 8px 0 0; padding-left: 18px; font-size: 13px; color: #8a1f1f; }
.check { flex-direction: row; align-items: center; gap: 6px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; background: #e6e9ef; color: #33415a; }
.badge.completed { background: #e9f6ee; color: #1d5a35; }
.badge.needs_review { background: #fff4d6; color: #7a5a00; }
.badge.failed { background: #fdecec; color: #8a1f1f; }
.badge.appeal-open { background: #fff0cc; color: #7a5200; font-weight: 600; }
.badge.appeal-resolved { background: #e9f6ee; color: #1d5a35; }
.badge.flag { background: #fdecec; color: #8a1f1f; font-weight: 600; }
.provisional { color: #7a5a00; }
input[type="number"] { padding: 6px 8px; border: 1px solid #b8c2d1; border-radius: 6px; font: inherit; width: 90px; }
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
<section class="batch">
  <h2>Batch evaluation</h2>
  <div class="row">
    <label>Checklist version<select class="batch-version"></select></label>
    <label class="check"><input type="checkbox" class="batch-force"> Re-evaluate finished</label>
    <button type="button" class="batch-start">Evaluate dataset</button>
  </div>
  <div class="batch-message"></div>
  <div class="batch-progress" hidden>
    <div class="bar"><div class="fill"></div></div>
    <div class="progress-text"></div>
    <ul class="failed-list"></ul>
  </div>
</section>
<section class="listing">
  <h2>Conversations</h2>
  <div class="row filters">
    <label>Dataset<select class="dataset"></select></label>
    <label>Language<select class="language"></select></label>
    <label>Channel<select class="channel"></select></label>
    <label>Evaluation status
      <select class="status">
        <option value="">All</option>
        <option value="none">Not evaluated</option>
        <option value="completed">Completed</option>
        <option value="needs_review">Needs review</option>
        <option value="failed">Failed</option>
      </select>
    </label>
    <label>Appeal status
      <select class="appeal-status">
        <option value="">All</option>
        <option value="none">No appeals</option>
        <option value="open">Open</option>
        <option value="resolved">Resolved</option>
      </select>
    </label>
    <label>Gross violation
      <select class="gross">
        <option value="">All</option>
        <option value="true">Flagged</option>
        <option value="false">Not flagged</option>
      </select>
    </label>
    <label>Score from<input type="number" class="min-total" min="0" max="100" step="1"></label>
    <label>Score to<input type="number" class="max-total" min="0" max="100" step="1"></label>
    <label>Version<select class="version-filter"></select></label>
  </div>
  <div class="list-message"></div>
  <div class="table-holder"></div>
</section>
`;

const COLUMNS = [
  { key: "conversation_id", label: "Conversation" },
  { key: "channel", label: "Channel" },
  { key: "language", label: "Language" },
  { key: "checklist_version_label", label: "Checklist version", kind: "version" },
  { key: "total", label: "Total", kind: "total" },
  { key: "gross_violation", label: "Flag", kind: "flag" },
  { key: "eval_status", label: "Status", kind: "status" },
  { key: "appeal_status", label: "Appeal status", kind: "appeal" }
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
    for (const sel of [".status", ".appeal-status", ".gross", ".version-filter"]) {
      this.q(sel).addEventListener("change", () => this.loadList());
    }
    for (const sel of [".min-total", ".max-total"]) {
      this.q(sel).addEventListener("change", () => this.loadList());
    }
    this.q(".batch-start").addEventListener("click", () => this.startBatch());
    this.fillSelect(this.q(".language"), [], "");
    this.fillSelect(this.q(".channel"), [], "");
    this.init();
  }

  disconnectedCallback() {
    this.stopPolling();
  }

  async loadVersions() {
    let checklists = [];
    try {
      checklists = await api.listChecklists();
    } catch (err) {
      this.setMessage(".batch-message", "error", err.message);
      return;
    }
    const batchSelect = this.q(".batch-version");
    const filterSelect = this.q(".version-filter");
    const keepBatch = batchSelect.value;
    const keepFilter = filterSelect.value;
    batchSelect.innerHTML = "";
    filterSelect.innerHTML = "";
    const any = document.createElement("option");
    any.value = "";
    any.textContent = "Latest";
    filterSelect.appendChild(any);
    for (const checklist of checklists) {
      for (const version of checklist.versions || []) {
        const label = checklist.name + " v" + version.version + (version.is_default ? " (default)" : "");
        for (const select of [batchSelect, filterSelect]) {
          const option = document.createElement("option");
          option.value = version.id;
          option.textContent = label;
          if (select === batchSelect && version.is_default && !keepBatch) option.selected = true;
          select.appendChild(option);
        }
      }
    }
    if (keepBatch) batchSelect.value = keepBatch;
    if (keepFilter) filterSelect.value = keepFilter;
  }

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollingJob = null;
  }

  async startBatch() {
    const dataset = this.q(".dataset").value;
    if (!dataset) {
      this.setMessage(".batch-message", "error", "Import a dataset first.");
      return;
    }
    this.setMessage(".batch-message", "", "");
    this.q(".batch-start").disabled = true;
    try {
      const payload = { dataset, force: this.q(".batch-force").checked };
      const version = this.q(".batch-version").value;
      if (version) payload.checklist_version_id = Number(version);
      const job = await api.startBatch(payload);
      this.trackJob(job);
    } catch (err) {
      this.q(".batch-start").disabled = false;
      this.setMessage(".batch-message", "error", "Batch failed to start: " + err.message);
    }
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
        this.setMessage(".batch-message", "error", "Progress unavailable: " + err.message);
        this.q(".batch-start").disabled = false;
        return;
      }
      if (this.pollingJob !== id) return;
      this.renderJob(job);
      await this.loadList(true);
      if (job.status === "running" || job.status === "queued") {
        this.schedulePoll(id);
      } else {
        this.q(".batch-start").disabled = false;
        this.pollingJob = null;
      }
    }, 700);
  }

  renderJob(job) {
    this.q(".batch-progress").hidden = false;
    this.q(".batch-start").disabled = job.status === "running" || job.status === "queued";
    this.q(".fill").style.width = job.percent + "%";
    const done = job.status === "completed" || job.status === "failed";
    this.q(".progress-text").textContent =
      (done ? "Finished: " : "Running: ") + job.processed + " of " + job.to_run + " evaluated (" + job.percent + "%), skipped " +
      job.skipped + " already done, completed " + job.completed + ", needs review " + job.needs_review + ", failed " +
      job.failed + (done ? "" : ", in flight " + job.in_flight);
    const list = this.q(".failed-list");
    list.innerHTML = "";
    for (const failure of job.failures) {
      const li = document.createElement("li");
      li.textContent = (failure.conversation_id || "batch") + ": " + failure.error;
      list.appendChild(li);
    }
  }

  async resumeTracking() {
    let jobs;
    try {
      jobs = await api.listBatches();
    } catch (err) {
      return;
    }
    const active = jobs.find((j) => j.status === "running" || j.status === "queued");
    if (active) this.trackJob(active);
  }

  async init() {
    this.loadVersions();
    this.resumeTracking();
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
      channel: this.q(".channel").value,
      status: this.q(".status").value,
      appeal_status: this.q(".appeal-status").value,
      gross: this.q(".gross").value,
      min_total: this.q(".min-total").value,
      max_total: this.q(".max-total").value,
      checklist_version_id: this.q(".version-filter").value
    };
  }

  async loadList(quiet = false) {
    const filters = this.filters();
    const holder = this.q(".table-holder");
    this.q(".list-message").innerHTML = "";
    if (!filters.dataset) {
      holder.innerHTML = '<div class="state empty">No dataset imported yet. Import one above.</div>';
      return;
    }
    const seq = ++this.requestSeq;
    if (!quiet) holder.innerHTML = '<div class="state loading">Loading conversations...</div>';
    let rows;
    try {
      rows = await api.listConversations(filters);
    } catch (err) {
      if (seq === this.requestSeq) this.showListError(err.message);
      return;
    }
    if (seq !== this.requestSeq) return;
    if (!filters.language && !filters.channel && !filters.status && !filters.appeal_status && !filters.gross && !filters.min_total && !filters.max_total) {
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
        } else if (col.kind) {
          this.fillEvalCell(td, col.kind, row);
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

  fillEvalCell(td, kind, row) {
    const evaluated = row.evaluation_id != null;
    if (kind === "status") {
      const badge = document.createElement("span");
      badge.className = "badge" + (evaluated ? " " + row.eval_status : "");
      badge.textContent = evaluated ? row.eval_status : "not evaluated";
      td.appendChild(badge);
      return;
    }
    if (!evaluated) {
      td.className = "pending";
      td.textContent = "-";
      return;
    }
    if (kind === "appeal") {
      const badge = document.createElement("span");
      badge.className = "badge appeal-" + row.appeal_status;
      badge.textContent = row.appeal_status;
      td.appendChild(badge);
      return;
    }
    if (kind === "version") {
      td.textContent = row.checklist_version_label;
    } else if (kind === "total") {
      if (row.total == null) {
        td.textContent = "n/a";
      } else {
        td.textContent = Number(row.total).toFixed(2) + (row.provisional ? " (provisional)" : "");
        if (row.provisional) td.className = "provisional";
      }
    } else if (kind === "flag") {
      if (row.gross_violation) {
        const badge = document.createElement("span");
        badge.className = "badge flag";
        badge.textContent = "Gross violation";
        td.appendChild(badge);
      } else {
        td.textContent = "-";
      }
    }
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
