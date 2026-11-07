const template = document.createElement("template");
template.innerHTML = `
<style>
:host { display: block; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c2430; }
.summary { background: #fff; border: 1px solid #dde2ea; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.total { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.total .value { font-size: 32px; font-weight: 700; }
.total .of { color: #55637a; }
.meta { margin-top: 6px; font-size: 12px; color: #55637a; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: #e6e9ef; color: #3a4658; }
.badge.warn { background: #fff0cc; color: #7a5200; }
.badge.bad { background: #fdecec; color: #8a1f1f; }
.badge.ok { background: #e1f3e8; color: #1d5a35; }
.badge.na { background: #e8ecf5; color: #3b4a73; }
.gross { margin-top: 10px; padding: 8px 12px; background: #fdecec; border: 1px solid #e5a3a3; color: #8a1f1f; border-radius: 6px; font-weight: 600; }
.note { margin-top: 10px; padding: 8px 12px; background: #fff6d6; border: 1px solid #ecd27a; color: #6b5200; border-radius: 6px; font-size: 13px; }
h3 { margin: 16px 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.4px; color: #55637a; }
.crit { background: #fff; border: 1px solid #dde2ea; border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; }
.crit.review { border-color: #e2b43a; }
.head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.head .title { font-weight: 600; flex: 1; min-width: 160px; overflow-wrap: anywhere; }
.head .cid { color: #8b96a8; font-size: 12px; }
.nums { margin-top: 6px; font-size: 13px; color: #3a4658; display: flex; gap: 14px; flex-wrap: wrap; }
.rationale { margin-top: 8px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.na { margin-top: 8px; padding: 6px 10px; background: #e8ecf5; border-radius: 6px; font-size: 13px; overflow-wrap: anywhere; }
.ev { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.ev-item { display: flex; gap: 8px; align-items: flex-start; }
button.chip { flex: none; border: 1px solid #1b5fb0; background: #eaf2fd; color: #1b5fb0; border-radius: 12px; padding: 2px 10px; font: inherit; font-size: 12px; cursor: pointer; }
button.chip:hover { background: #1b5fb0; color: #fff; }
button.chip.range { border-color: #d9822b; background: #fff1e0; color: #8a4a0a; }
button.chip.range:hover { background: #d9822b; color: #fff; }
.quote { flex: 1; min-width: 0; font-size: 13px; color: #3a4658; border-left: 3px solid #dde2ea; padding-left: 8px; overflow-wrap: anywhere; white-space: pre-wrap; }
.quote.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
button.more { flex: none; border: none; background: none; color: #1b5fb0; cursor: pointer; font: inherit; font-size: 12px; padding: 0; }
.state { padding: 24px; text-align: center; color: #55637a; background: #fff; border: 1px solid #dde2ea; border-radius: 8px; }
</style>
<div class="root"></div>
`;

function num(value) {
  if (value === null || value === undefined) return "-";
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class CqaEvaluationPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.state = null;
  }

  set data(value) {
    this.state = value;
    this.render();
  }

  emit(detail) {
    this.dispatchEvent(new CustomEvent("cqa-evidence", { bubbles: true, composed: true, detail }));
  }

  summary(evaluation, versionLabel) {
    const box = el("div", "summary");
    const total = el("div", "total");
    const value = el("span", "value", evaluation.total === null || evaluation.total === undefined ? "n/a" : num(evaluation.total));
    total.appendChild(value);
    total.appendChild(el("span", "of", "/ 100"));
    if (evaluation.provisional) total.appendChild(el("span", "badge warn", "provisional"));
    if (evaluation.total_status && evaluation.total_status !== "final") {
      total.appendChild(el("span", "badge", evaluation.total_status));
    }
    total.appendChild(el("span", "badge " + (evaluation.status === "completed" ? "ok" : "warn"), "status: " + evaluation.status));
    box.appendChild(total);
    const meta = el("div", "meta");
    meta.appendChild(el("span", "", "Checklist " + versionLabel));
    meta.appendChild(el("span", "", "Model " + (evaluation.model || "-")));
    meta.appendChild(el("span", "", "Prompt " + (evaluation.prompt_version || "-")));
    meta.appendChild(el("span", "", "Evaluated " + (evaluation.created_at || "-")));
    box.appendChild(meta);
    if (evaluation.gross_violation) {
      box.appendChild(el("div", "gross", "Gross violation flagged"));
    }
    if (evaluation.provisional) {
      box.appendChild(el("div", "note", "The total is provisional: some criteria need review before it is final."));
    }
    return box;
  }

  quoteRow(item) {
    const row = el("div", "ev-item");
    const chip = el("button", "chip", "#" + item.message_index);
    chip.type = "button";
    chip.title = "Show message " + item.message_index;
    chip.addEventListener("click", () => this.emit({ index: item.message_index, kind: "evidence" }));
    row.appendChild(chip);
    const quote = item.quote || "";
    const text = el("div", "quote", quote);
    row.appendChild(text);
    if (quote.length > 90) {
      text.classList.add("clamp");
      const more = el("button", "more", "more");
      more.type = "button";
      more.addEventListener("click", () => {
        const open = text.classList.toggle("clamp");
        more.textContent = open ? "more" : "less";
      });
      row.appendChild(more);
    }
    return row;
  }

  criterion(result, def) {
    const box = el("div", "crit" + (result.needs_review ? " review" : ""));
    box.dataset.criterion = result.criterion_id;
    const head = el("div", "head");
    head.appendChild(el("span", "cid", result.criterion_id));
    head.appendChild(el("span", "title", def ? def.title : result.criterion_id));
    const answer = result.answer === null || result.answer === undefined ? "-" : String(result.answer);
    const isNa = answer.toLowerCase() === "n/a" || answer.toLowerCase() === "na";
    const tone = isNa ? "na" : answer.toLowerCase() === "yes" ? "ok" : answer.toLowerCase() === "no" ? "bad" : "";
    head.appendChild(el("span", "badge " + tone, answer));
    if (result.needs_review) head.appendChild(el("span", "badge warn", "needs review"));
    box.appendChild(head);

    const nums = el("div", "nums");
    nums.appendChild(el("span", "", "Points " + num(result.points)));
    nums.appendChild(el("span", "", "Weight " + (def ? num(def.weight) : "-")));
    nums.appendChild(el("span", "", "Effective " + num(result.effective_points)));
    box.appendChild(nums);

    if (result.rationale) box.appendChild(el("div", "rationale", result.rationale));
    if (isNa && result.na_reason) box.appendChild(el("div", "na", "N/A reason: " + result.na_reason));

    const evidence = el("div", "ev");
    const range = result.checked_range;
    if (range && Number.isInteger(range.from) && Number.isInteger(range.to)) {
      const row = el("div", "ev-item");
      const chip = el("button", "chip range", "Checked #" + range.from + " - #" + range.to);
      chip.type = "button";
      chip.title = "Highlight the checked range";
      chip.addEventListener("click", () => this.emit({ index: null, range, kind: "range" }));
      row.appendChild(chip);
      row.appendChild(el("div", "quote", "Expected action was not found in this range"));
      evidence.appendChild(row);
    }
    for (const item of result.evidence || []) evidence.appendChild(this.quoteRow(item));
    if (evidence.childNodes.length) box.appendChild(evidence);
    return box;
  }

  render() {
    const root = this.shadowRoot.querySelector(".root");
    root.innerHTML = "";
    const state = this.state;
    if (!state) return;
    if (state.message) {
      root.appendChild(el("div", "state", state.message));
      return;
    }
    const { evaluation, config, versionLabel } = state;
    root.appendChild(this.summary(evaluation, versionLabel));
    const defs = new Map(((config && config.criteria) || []).map((c) => [c.id, c]));
    const sections = ((config && config.sections) || []).slice();
    const known = new Set(sections.map((s) => s.id));
    const grouped = new Map(sections.map((s) => [s.id, []]));
    const loose = [];
    for (const result of evaluation.criteria || []) {
      const def = defs.get(result.criterion_id);
      if (def && known.has(def.section)) grouped.get(def.section).push(result);
      else loose.push(result);
    }
    for (const section of sections) {
      const items = grouped.get(section.id);
      if (!items.length) continue;
      root.appendChild(el("h3", "", section.title));
      for (const r of items) root.appendChild(this.criterion(r, defs.get(r.criterion_id)));
    }
    if (loose.length) {
      root.appendChild(el("h3", "", "Other"));
      for (const r of loose) root.appendChild(this.criterion(r, defs.get(r.criterion_id)));
    }
  }
}

customElements.define("cqa-evaluation-panel", CqaEvaluationPanel);
