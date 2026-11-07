const template = document.createElement("template");
template.innerHTML = `
<style>
:host { display: block; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c2430; }
.list { display: flex; flex-direction: column; gap: 6px; }
.msg { display: grid; grid-template-columns: 34px 84px 1fr auto; gap: 8px; align-items: start; padding: 8px 10px; border-radius: 8px; border-left: 4px solid #b8c2d1; background: #fff; overflow-wrap: anywhere; }
.msg .idx { font-size: 11px; color: #8b96a8; padding-top: 2px; }
.msg .who { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; color: #55637a; padding-top: 1px; }
.msg .time { display: block; font-weight: 400; font-size: 11px; color: #8b96a8; text-transform: none; }
.msg .text { font-size: 14px; line-height: 1.45; white-space: pre-wrap; min-width: 0; }
.msg.client { border-left-color: #1b5fb0; background: #f0f6ff; }
.msg.operator { border-left-color: #1d8a4f; background: #effaf3; }
.msg.bot, .msg.system { border-left-color: #c9d0db; background: #f4f5f7; color: #6b7686; }
.msg.bot .text, .msg.system .text { font-style: italic; }
.msg.system .who, .msg.bot .who { color: #8b96a8; }
.msg.hl { outline: 3px solid #f2b632; background: #fff6d6; }
.msg.range { outline: 2px dashed #d9822b; background: #fff1e0; }
button.play { border: 1px solid #274769; background: #fff; color: #274769; border-radius: 6px; padding: 3px 8px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
button.play:hover { background: #274769; color: #fff; }
.empty { padding: 24px; text-align: center; color: #55637a; background: #fff; border-radius: 8px; }
</style>
<div class="list"></div>
`;

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

class CqaTranscript extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this.items = [];
    this.audio = false;
  }

  set messages(value) {
    this.items = Array.isArray(value) ? value : [];
    this.render();
  }

  set playable(value) {
    this.audio = Boolean(value);
    this.render();
  }

  timeLabel(message) {
    const raw = message.timestamp_raw;
    if (raw && /^\d{1,2}:\d{2}/.test(raw) && !raw.includes("T")) return raw;
    if (message.offset_seconds !== null && message.offset_seconds !== undefined) return clock(message.offset_seconds);
    return raw || "";
  }

  render() {
    const list = this.shadowRoot.querySelector(".list");
    list.innerHTML = "";
    if (!this.items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No messages in this conversation.";
      list.appendChild(empty);
      return;
    }
    for (const message of this.items) {
      const row = document.createElement("div");
      const speaker = (message.speaker || "").toLowerCase();
      row.className = "msg " + (["client", "operator", "bot", "system"].includes(speaker) ? speaker : "other");
      row.id = "m-" + message.message_index;
      row.dataset.index = String(message.message_index);

      const idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = "#" + message.message_index;

      const who = document.createElement("span");
      who.className = "who";
      who.textContent = message.speaker || "?";
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = this.timeLabel(message);
      who.appendChild(time);

      const text = document.createElement("span");
      text.className = "text";
      text.textContent = message.text || "";

      row.append(idx, who, text);
      const seconds = message.offset_seconds;
      if (this.audio && seconds !== null && seconds !== undefined) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "play";
        button.textContent = "Play from here";
        button.addEventListener("click", () => {
          this.dispatchEvent(new CustomEvent("cqa-seek", {
            bubbles: true,
            composed: true,
            detail: { index: message.message_index, seconds, play: true }
          }));
        });
        row.appendChild(button);
      } else {
        row.appendChild(document.createElement("span"));
      }
      list.appendChild(row);
    }
  }

  clearHighlight() {
    for (const el of this.shadowRoot.querySelectorAll(".hl, .range")) el.classList.remove("hl", "range");
  }

  highlight(index, range) {
    this.clearHighlight();
    let target = null;
    if (range && Number.isInteger(range.from) && Number.isInteger(range.to)) {
      for (let i = range.from; i <= range.to; i += 1) {
        const el = this.shadowRoot.getElementById("m-" + i);
        if (el) {
          el.classList.add("range");
          if (!target) target = el;
        }
      }
    }
    if (Number.isInteger(index)) {
      const el = this.shadowRoot.getElementById("m-" + index);
      if (el) {
        el.classList.add("hl");
        target = el;
      }
    }
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
    return Boolean(target);
  }
}

customElements.define("cqa-transcript", CqaTranscript);
