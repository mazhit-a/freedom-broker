import { api } from "../api.js";
import { formStyles, buildDecisionForm } from "./cqa-appeal-form.js";

const template = document.createElement("template");
template.innerHTML = `
<style>
:host { display: block; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c2430; }
a { color: #1b5fb0; }
h2 { margin: 0 0 12px; font-size: 18px; }
.bar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
select { padding: 6px 8px; border: 1px solid #b8c2d1; border-radius: 6px; font: inherit; }
.notice { padding: 8px 12px; background: #eaf2fd; border: 1px solid #a9c8ee; color: #1b4a85; border-radius: 6px; margin-bottom: 12px; }
.error { padding: 10px 12px; background: #fdecec; border: 1px solid #e5a3a3; color: #8a1f1f; border-radius: 6px; margin-bottom: 12px; white-space: pre-wrap; }
.state { padding: 32px; text-align: center; color: #55637a; background: #fff; border: 1px dashed #b8c2d1; border-radius: 8px; }
.item { background: #fff; border: 1px solid #dde2ea; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.item .head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.item .head .t { font-weight: 600; overflow-wrap: anywhere; }
.badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: #e6e9ef; color: #3a4658; }
.badge.warn { background: #fff0cc; color: #7a5200; }
.badge.ok { background: #e1f3e8; color: #1d5a35; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin-top: 10px; }
.box { background: #f7f9fc; border: 1px solid #dde2ea; border-radius: 6px; padding: 8px 10px; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 13px; }
.k { font-size: 11px; text-transform: uppercase; color: #55637a; margin: 8px 0 4px; }
.frag { border: 1px solid #dde2ea; border-radius: 6px; max-height: 260px; overflow-y: auto; font-size: 13px; }
.line { padding: 4px 8px; border-bottom: 1px solid #eef0f4; overflow-wrap: anywhere; }
.line.hit { background: #fff3c4; }
.line.bot, .line.system { color: #7a8599; }
.line .who { font-weight: 600; margin-right: 6px; }
.decided { margin-top: 10px; padding: 8px 10px; background: #e1f3e8; border-radius: 6px; font-size: 13px; }
.hint { margin-top: 10px; font-size: 12px; color: #55637a; }
${formStyles}
@media (max-width: 1000px) { .cols { grid-template-columns: minmax(0, 1fr); } }
</style>
<h2>Reviewer queue</h2>
<div class="bar">
  <label>Show <select class="status"><option value="open">Open appeals</option><option value="resolved">Resolved</option><option value="all">All</option></select></label>
  <button type="button" class="btn alt refresh">Refresh</button>
</div>
<div class="msg"></div>
<div class="items"></div>
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(value) {
  if (value === null || value === undefined) return "-";
  return String(value).toLowerCase() === "na" ? "N/A" : String(value);
}

class CqaReviewerQueue extends HTMLElement {
  static get observedAttributes() {
    return ["role"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.items = [];
    this.seq = 0;
  }

  connectedCallback() {
    this.shadowRoot.querySelector(".status").addEventListener("change", () => this.load());
    this.shadowRoot.querySelector(".refresh").addEventListener("click", () => this.load());
    this.load();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue && this.isConnected) this.renderItems();
  }

  get role() {
    return this.getAttribute("role") || "QA";
  }

  setMessage(text, kind) {
    const box = this.shadowRoot.querySelector(".msg");
    box.innerHTML = "";
    if (text) box.appendChild(el("div", kind || "error", text));
  }

  async load() {
    const seq = ++this.seq;
    const holder = this.shadowRoot.querySelector(".items");
    holder.innerHTML = "";
    holder.appendChild(el("div", "state", "Loading appeals..."));
    try {
      const items = await api.listAppeals(this.shadowRoot.querySelector(".status").value);
      if (seq !== this.seq) return;
      this.items = items || [];
      this.setMessage("");
      this.renderItems();
    } catch (err) {
      if (seq !== this.seq) return;
      holder.innerHTML = "";
      this.setMessage(err.message);
    }
  }

  renderItems() {
    const holder = this.shadowRoot.querySelector(".items");
    holder.innerHTML = "";
    if (!this.items.length) {
      holder.appendChild(el("div", "state empty", "No appeals in this view."));
      return;
    }
    for (const item of this.items) holder.appendChild(this.renderItem(item));
  }

  renderItem(item) {
    const box = el("div", "item");
    box.dataset.appeal = item.id;
    const head = el("div", "head");
    head.appendChild(el("span", "t", item.conversation_id + " / " + item.criterion_id + " " + (item.criterion ? item.criterion.title : "")));
    head.appendChild(el("span", "badge", [item.channel, item.language].filter(Boolean).join(" ")));
    head.appendChild(el("span", "badge " + (item.status === "open" ? "warn" : "ok"), item.status));
    const link = el("a", "", "Open full card");
    link.href = "#/conversations/" + item.conversation_pk;
    head.appendChild(link);
    box.appendChild(head);

    const cols = el("div", "cols");
    const left = el("div");
    left.appendChild(el("div", "k", "Disputed result"));
    const o = item.original;
    left.appendChild(el("div", "box", "Answer " + show(o.answer) + ", points " + show(o.points) + ", effective " + show(o.effective_points)));
    if (o.rationale) {
      left.appendChild(el("div", "k", "Rationale"));
      left.appendChild(el("div", "box", o.rationale));
    }
    if (o.na_reason) {
      left.appendChild(el("div", "k", "N/A reason"));
      left.appendChild(el("div", "box", o.na_reason));
    }
    left.appendChild(el("div", "k", "Appellant comment"));
    left.appendChild(el("div", "box", item.comment || ""));
    if ((o.evidence || []).length) {
      left.appendChild(el("div", "k", "Evidence"));
      for (const e of o.evidence) left.appendChild(el("div", "box", "#" + e.message_index + ": " + e.quote));
    }
    cols.appendChild(left);

    const right = el("div");
    right.appendChild(el("div", "k", "Transcript fragment"));
    const hits = new Set((o.evidence || []).map((e) => e.message_index));
    if (o.checked_range) {
      for (let i = o.checked_range.from; i <= o.checked_range.to; i++) hits.add(i);
    }
    const frag = el("div", "frag");
    for (const m of item.fragment || []) {
      const line = el("div", "line " + (m.speaker || "") + (hits.has(m.message_index) ? " hit" : ""));
      line.appendChild(el("span", "who", "#" + m.message_index + " " + (m.speaker || "")));
      line.appendChild(document.createTextNode(m.text || ""));
      frag.appendChild(line);
    }
    right.appendChild(frag);
    cols.appendChild(right);
    box.appendChild(cols);

    if (item.status === "resolved") {
      const text = item.decision === "change" ? "Changed to " + show(item.new_answer) : "Confirmed original";
      box.appendChild(el("div", "decided", "Decision: " + text + ". Reason: " + item.reason));
    } else if (this.role === "Reviewer") {
      const form = buildDecisionForm({ appeal: item, def: item.criterion, role: "Reviewer" }, () => {
        this.setMessage("Decision saved for appeal #" + item.id + ".", "notice");
        this.load().then(() => this.setMessage("Decision saved for appeal #" + item.id + ".", "notice"));
      });
      box.appendChild(form);
    } else {
      box.appendChild(el("div", "hint", "Switch to the Reviewer role to confirm or change this result."));
    }
    return box;
  }
}

customElements.define("cqa-reviewer-queue", CqaReviewerQueue);
