import { html } from "../base-element.js";
import { api } from "../api.js";
import { navigate } from "../events.js";
import { integer } from "../format.js";
import { t } from "../i18n/index.js";
import { sourceList } from "./audio-player-model.js";
import { AUDIO_EVENTS } from "./cqa-audio-player.js";
import { criteriaSection } from "./card-view.js";
import { activeMessageIndex, appealSummary, compactRows, grossIndices, grossMarkers, headerParts, timeline } from "./call-model.js";
import { callChannelChip, callMetaTemplate, compactTable, detailBar, grossAlert, playFromHere, playerSlot } from "./call-view.js";

export function isCall(conversation) {
  return Boolean(conversation) && conversation.channel === "call";
}

function safeUrl(id, mode) {
  try {
    return api.audioUrl(id, mode) || null;
  } catch (error) {
    return null;
  }
}

export class CallChannel {
  constructor(host) {
    this.host = host;
    this.conversation = null;
    this.evaluation = null;
    this.view = null;
    this.detail = false;
    this.live = false;
    this.active = null;
    this.points = [];
    this.starts = new Map();
    this.player = document.createElement("cqa-audio-player");
    this.player.addEventListener(AUDIO_EVENTS.time, (event) => this.onTime(event.detail));
    this.player.addEventListener(AUDIO_EVENTS.state, (event) => this.onState(event.detail));
    this.configKey = "";
    this.peaksFor = null;
  }

  dispose() {
    if (this.observer) this.observer.disconnect();
    try {
      this.player.pause();
    } catch (error) {
      return;
    }
  }

  get locale() {
    return this.host.locale;
  }

  update(conversation, evaluation, view) {
    this.conversation = conversation;
    this.evaluation = evaluation;
    this.view = view;
    this.points = timeline(conversation.messages);
    this.starts = new Map(this.points.map((p) => [p.index, p.start]));
    const id = conversation.id;
    const url = safeUrl(id);
    const proxy = url ? safeUrl(id, "proxy") : null;
    const markers = grossMarkers(view, this.points).map((m) => m.start);
    const bounds = this.points.map((p) => p.start);
    const key = JSON.stringify([id, url, proxy, markers, bounds, conversation.durationSeconds, this.points.length > 0]);
    if (key !== this.configKey) {
      this.configKey = key;
      const config = {
        recording: url,
        duration: conversation.durationSeconds,
        markers,
        bounds,
        timings: this.points.length > 0
      };
      if (!this.player.hasAttribute("src")) config.sources = sourceList(url, proxy);
      this.player.configure(config);
    }
    if (this.peaksFor !== id) {
      this.peaksFor = id;
      this.loadPeaks(id);
    }
  }

  async loadPeaks(id) {
    try {
      const wave = await api.getWaveform(id);
      if (this.peaksFor !== id || !wave || !Array.isArray(wave.peaks)) return;
      this.player.configure({ peaks: wave.peaks, duration: this.conversation && this.conversation.durationSeconds ? this.conversation.durationSeconds : wave.durationSeconds });
    } catch (error) {
      return;
    }
  }

  channelChip() {
    return callChannelChip(this.locale);
  }

  metaTemplate() {
    const parts = headerParts(this.conversation, this.locale);
    return callMetaTemplate(parts, this.locale);
  }

  banner() {
    return playerSlot();
  }

  extra(message) {
    const start = this.starts.get(message.index);
    if (start === undefined) return null;
    return playFromHere(message, start, this.locale);
  }

  hidesGross() {
    return Boolean(this.view && this.view.gross && this.view.gross.state === "found");
  }

  lead() {
    if (!this.hidesGross()) return html``;
    return grossAlert(this.view, this.locale);
  }

  criteria(view, ctx) {
    const locale = this.locale;
    if (this.detail) return html`${detailBar({ locale })}${criteriaSection(view, ctx)}`;
    const rows = compactRows(view);
    return compactTable(view, this.evaluation, rows, { locale, toggleLabel: t("call.detailOpen", {}, locale), appealStatus: appealSummary(view) });
  }

  afterRender(region) {
    const slot = region.querySelector("[data-player-slot]");
    if (!slot) return;
    const locale = this.locale;
    if (this.player.getAttribute("locale") !== locale) this.player.setAttribute("locale", locale);
    slot.append(this.player);
    const head = region.querySelector("[data-transcript] .t-head");
    const transcript = region.querySelector("[data-transcript]");
    if (head && transcript) this.trackHead(head, transcript);
    this.decorate(region);
    this.paintActive(region);
  }

  trackHead(head, transcript) {
    const apply = () => transcript.style.setProperty("--thead-h", `${head.getBoundingClientRect().height}px`);
    apply();
    if (this.observer) this.observer.disconnect();
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(apply);
      this.observer.observe(head);
    }
  }

  decorate(region) {
    const gross = new Set(grossIndices(this.view));
    const locale = this.locale;
    for (const li of region.querySelectorAll("li[data-index]")) {
      const index = Number(li.getAttribute("data-index"));
      const bubble = li.querySelector("[data-bubble]");
      const head = li.querySelector(".msg-head");
      const ts = li.querySelector(".ts");
      const message = this.view.messages.find((m) => m.index === index);
      if (ts && message && this.starts.has(index)) {
        ts.setAttribute("aria-label", t("call.seekTo", { time: message.time, n: integer(message.n, locale) }, locale));
        ts.setAttribute("data-call-ts", "");
      }
      if (!head) continue;
      const live = document.createElement("span");
      live.className = "chip c-brand";
      live.setAttribute("data-call-live", "");
      live.hidden = true;
      live.textContent = t("call.live", {}, locale);
      head.append(live);
      if (gross.has(index)) {
        const flag = document.createElement("span");
        flag.className = "chip c-crit";
        flag.setAttribute("data-call-gross-chip", "");
        flag.textContent = t("call.gross", {}, locale);
        head.append(flag);
        bubble.classList.add("msg-gross");
      }
    }
  }

  paintActive(region = this.host.shadowRoot) {
    for (const li of region.querySelectorAll("li[data-index]")) {
      const index = Number(li.getAttribute("data-index"));
      const bubble = li.querySelector("[data-bubble]");
      const on = this.active === index && !bubble.classList.contains("msg-system");
      bubble.classList.toggle("is-live", on);
      const chip = li.querySelector("[data-call-live]");
      if (chip) chip.hidden = !on;
    }
  }

  onTime(detail) {
    if (detail.position > 0 || detail.playing) this.live = true;
    const next = this.live ? activeMessageIndex(this.points, detail.position) : null;
    if (next !== this.active) {
      this.active = next;
      this.paintActive();
    }
  }

  onState(detail) {
    if (detail.playing) this.live = true;
  }

  seekMessage(index, { play = false } = {}) {
    const start = this.starts.get(index);
    if (start === undefined) return false;
    this.live = true;
    return this.player.seekTo(start, { play });
  }

  handleClick(action, el, event) {
    if (action === "pick-msg" || action === "jump") {
      this.seekMessage(Number(el.getAttribute("data-msg")));
      return false;
    }
    if (action === "call-play") {
      this.seekMessage(Number(el.getAttribute("data-msg")), { play: true });
      return true;
    }
    if (action === "call-gross") {
      const index = Number(el.getAttribute("data-msg"));
      this.seekMessage(index);
      this.host.scrollToMessage(index);
      return true;
    }
    if (action === "call-detail") {
      this.detail = !this.detail;
      this.host.renderNow();
      return true;
    }
    if (action === "call-appeals") {
      event.preventDefault();
      navigate(this.host, "appeals");
      return true;
    }
    return false;
  }
}
