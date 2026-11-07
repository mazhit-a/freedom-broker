import { api } from "../api.js";
import "./cqa-transcript.js";
import "./cqa-evaluation-panel.js";

const template = document.createElement("template");
template.innerHTML = `
<style>
:host { display: block; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c2430; }
a { color: #1b5fb0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 12px; }
.top h2 { margin: 0; font-size: 18px; overflow-wrap: anywhere; }
.tag { font-size: 12px; background: #e6e9ef; border-radius: 10px; padding: 2px 10px; color: #3a4658; }
.spacer { flex: 1; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
select { padding: 6px 8px; border: 1px solid #b8c2d1; border-radius: 6px; font: inherit; max-width: 260px; }
button.act { padding: 7px 14px; border: 1px solid #274769; background: #274769; color: #fff; border-radius: 6px; cursor: pointer; font: inherit; }
button.act:disabled { opacity: 0.5; cursor: default; }
.audio { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; background: #fff; border: 1px solid #dde2ea; border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; }
.audio audio { flex: 1; min-width: 260px; }
.audio .hint { flex-basis: 100%; font-size: 12px; color: #55637a; }
.error { margin-bottom: 12px; padding: 10px 12px; background: #fdecec; border: 1px solid #e5a3a3; color: #8a1f1f; border-radius: 6px; white-space: pre-wrap; }
.busy { margin-bottom: 12px; padding: 10px 12px; background: #eaf2fd; border: 1px solid #a9c8ee; color: #1b4a85; border-radius: 6px; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.col { min-width: 0; }
.col.left { max-height: calc(100vh - 150px); overflow-y: auto; padding-right: 4px; }
.col.right { max-height: calc(100vh - 150px); overflow-y: auto; padding-right: 4px; }
.state { padding: 32px; text-align: center; color: #55637a; background: #fff; border: 1px dashed #b8c2d1; border-radius: 8px; }
[hidden] { display: none; }
@media (max-width: 1000px) { .cols { grid-template-columns: minmax(0, 1fr); } .col.left, .col.right { max-height: none; } }
</style>
<div class="top">
  <a href="#/conversations" class="back">Back to the list</a>
  <h2 class="title"></h2>
  <span class="tags"></span>
  <span class="spacer"></span>
  <div class="controls">
    <label>Evaluation <select class="eval-select"></select></label>
    <label>Checklist version <select class="version-select"></select></label>
    <button type="button" class="act reeval">Evaluate</button>
  </div>
</div>
<div class="message"></div>
<div class="audio" hidden>
  <strong>Recording</strong>
  <audio controls preload="none"></audio>
  <a class="open" target="_blank" rel="noopener">Open recording</a>
  <span class="hint">Offsets are approximate: the recording may be paused during the call.</span>
</div>
<div class="body"></div>
`;

class CqaConversationCard extends HTMLElement {
  static get observedAttributes() {
    return ["conversation-id"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.conversation = null;
    this.evaluations = [];
    this.versions = [];
    this.configs = new Map();
    this.selectedEvaluation = null;
    this.loadToken = 0;
    const root = this.shadowRoot;
    root.querySelector(".eval-select").addEventListener("change", (e) => {
      this.selectedEvaluation = Number(e.target.value);
      this.showEvaluation();
    });
    root.querySelector(".reeval").addEventListener("click", () => this.reevaluate());
    root.addEventListener("cqa-evidence", (e) => this.onEvidence(e.detail));
    root.addEventListener("cqa-seek", (e) => this.seek(e.detail.seconds, e.detail.play));
  }

  connectedCallback() {
    this.load();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue && this.isConnected) this.load();
  }

  get conversationId() {
    return this.getAttribute("conversation-id");
  }

  setMessage(text, kind) {
    const box = this.shadowRoot.querySelector(".message");
    box.innerHTML = "";
    if (!text) return;
    const div = document.createElement("div");
    div.className = kind || "error";
    div.textContent = text;
    box.appendChild(div);
  }

  async load() {
    const id = this.conversationId;
    if (!id) return;
    const token = ++this.loadToken;
    const body = this.shadowRoot.querySelector(".body");
    body.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "state";
    loading.textContent = "Loading conversation...";
    body.appendChild(loading);
    this.setMessage("");
    try {
      const [conversation, evaluations, checklists] = await Promise.all([
        api.getConversation(id),
        api.listEvaluations(id),
        api.listChecklists()
      ]);
      if (token !== this.loadToken) return;
      this.conversation = conversation;
      this.evaluations = evaluations || [];
      this.versions = [];
      for (const checklist of checklists || []) {
        for (const v of checklist.versions || []) {
          this.versions.push({ id: v.id, label: checklist.name + " v" + v.version, isDefault: v.id === checklist.default_version_id });
        }
      }
      this.selectedEvaluation = this.evaluations.length ? this.evaluations[0].id : null;
      this.renderStatic();
      this.buildSelects();
      this.buildBody();
      await this.showEvaluation();
    } catch (err) {
      if (token !== this.loadToken) return;
      body.innerHTML = "";
      this.setMessage(err.message);
    }
  }

  renderStatic() {
    const root = this.shadowRoot;
    const c = this.conversation;
    root.querySelector(".title").textContent = c.conversation_id;
    const tags = root.querySelector(".tags");
    tags.innerHTML = "";
    for (const value of [c.channel, c.language, c.group_id]) {
      if (!value) continue;
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = value;
      tags.appendChild(span);
    }
    const audioBox = root.querySelector(".audio");
    const player = audioBox.querySelector("audio");
    if (c.audio_url) {
      audioBox.hidden = false;
      player.src = api.audioUrl(c.id);
      audioBox.querySelector(".open").href = api.audioUrl(c.id);
    } else {
      audioBox.hidden = true;
      player.removeAttribute("src");
    }
  }

  buildSelects() {
    const root = this.shadowRoot;
    const evalSelect = root.querySelector(".eval-select");
    evalSelect.innerHTML = "";
    if (!this.evaluations.length) {
      const o = document.createElement("option");
      o.textContent = "none yet";
      evalSelect.appendChild(o);
      evalSelect.disabled = true;
    } else {
      evalSelect.disabled = false;
      for (const ev of this.evaluations) {
        const o = document.createElement("option");
        o.value = String(ev.id);
        o.textContent = "#" + ev.id + " " + this.versionLabel(ev.checklist_version_id) + " " + (ev.total === null || ev.total === undefined ? "n/a" : ev.total) + " (" + ev.status + ")";
        evalSelect.appendChild(o);
      }
      evalSelect.value = String(this.selectedEvaluation);
    }
    const versionSelect = root.querySelector(".version-select");
    versionSelect.innerHTML = "";
    for (const v of this.versions) {
      const o = document.createElement("option");
      o.value = String(v.id);
      o.textContent = v.label + (v.isDefault ? " (default)" : "");
      versionSelect.appendChild(o);
    }
    const current = this.evaluations.find((e) => e.id === this.selectedEvaluation);
    const preferred = this.versions.find((v) => v.isDefault) || this.versions[0];
    if (current && this.versions.some((v) => v.id === current.checklist_version_id)) {
      versionSelect.value = String(current.checklist_version_id);
    } else if (preferred) {
      versionSelect.value = String(preferred.id);
    }
    root.querySelector(".reeval").textContent = this.evaluations.length ? "Re-evaluate" : "Evaluate";
    root.querySelector(".reeval").disabled = !this.versions.length;
  }

  buildBody() {
    const body = this.shadowRoot.querySelector(".body");
    body.innerHTML = "";
    const cols = document.createElement("div");
    cols.className = "cols";
    const left = document.createElement("div");
    left.className = "col left";
    const right = document.createElement("div");
    right.className = "col right";
    this.transcript = document.createElement("cqa-transcript");
    this.transcript.playable = Boolean(this.conversation.audio_url);
    this.transcript.messages = this.conversation.messages;
    left.appendChild(this.transcript);
    this.panel = document.createElement("cqa-evaluation-panel");
    right.appendChild(this.panel);
    cols.append(left, right);
    body.appendChild(cols);
  }

  versionLabel(versionId) {
    const v = this.versions.find((x) => x.id === versionId);
    return v ? v.label : "version " + versionId;
  }

  async showEvaluation() {
    const ev = this.evaluations.find((e) => e.id === this.selectedEvaluation);
    if (!this.panel) return;
    if (this.transcript) this.transcript.clearHighlight();
    if (!ev) {
      this.panel.data = { message: "This conversation has not been evaluated yet. Pick a checklist version and press Evaluate." };
      return;
    }
    let config = this.configs.get(ev.checklist_version_id);
    if (!config) {
      try {
        const version = await api.getChecklistVersion(ev.checklist_version_id);
        config = version.config;
        this.configs.set(ev.checklist_version_id, config);
      } catch (err) {
        config = { sections: [], criteria: [] };
        this.setMessage("Checklist definition could not be loaded: " + err.message);
      }
    }
    if (ev.id !== this.selectedEvaluation) return;
    this.panel.data = { evaluation: ev, config, versionLabel: this.versionLabel(ev.checklist_version_id) };
  }

  onEvidence(detail) {
    if (!this.transcript) return;
    this.transcript.highlight(detail.index, detail.range);
    if (this.conversation.audio_url) {
      const index = detail.range ? detail.range.from : detail.index;
      const message = this.conversation.messages.find((m) => m.message_index === index);
      if (message && message.offset_seconds !== null && message.offset_seconds !== undefined) {
        this.seek(message.offset_seconds, false);
      }
    }
  }

  seek(seconds, play) {
    const player = this.shadowRoot.querySelector(".audio audio");
    if (!player.getAttribute("src")) return;
    try {
      player.currentTime = seconds;
    } catch (err) {
      this.setMessage("Could not seek the recording: " + err.message);
      return;
    }
    if (play) {
      const result = player.play();
      if (result && result.catch) result.catch((err) => this.setMessage("Could not play the recording: " + err.message));
    }
  }

  async reevaluate() {
    const select = this.shadowRoot.querySelector(".version-select");
    const versionId = Number(select.value);
    if (!versionId) return;
    const button = this.shadowRoot.querySelector(".reeval");
    button.disabled = true;
    this.setMessage("Evaluating with " + this.versionLabel(versionId) + "...", "busy");
    try {
      const created = await api.evaluate(this.conversation.id, versionId);
      this.evaluations = (await api.listEvaluations(this.conversation.id)) || [];
      this.selectedEvaluation = created && created.id ? created.id : this.evaluations[0] && this.evaluations[0].id;
      this.setMessage("");
      this.buildSelects();
      await this.showEvaluation();
    } catch (err) {
      this.setMessage("Evaluation failed: " + err.message);
    } finally {
      button.disabled = !this.versions.length;
    }
  }
}

customElements.define("cqa-conversation-card", CqaConversationCard);
