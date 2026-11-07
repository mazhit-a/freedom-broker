import { CqaElement, html, raw } from "../base-element.js";
import { SHARED_CSS } from "../shared/styles.js";
import {
  SPEEDS,
  barHeights,
  clamp,
  finiteOr,
  nextPosition,
  percentOf,
  playerPhase,
  positionText,
  resolveDuration,
  speedLabel,
  valueText
} from "./audio-player-model.js";

export const AUDIO_EVENTS = Object.freeze({ time: "cqa:audio-time", state: "cqa:audio-state" });

const PLAY_ICON = raw('<svg class="i-play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><polygon points="7 4 20 12 7 20 7 4"></polygon></svg>');
const PAUSE_ICON = raw('<svg class="i-pause" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>');

const STYLES = `${SHARED_CSS}
:host { display: block; }
[hidden] { display: none !important; }
.player { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: var(--cqa-surface); }
.line { display: flex; align-items: center; gap: 12px; min-width: 0; }
.play { width: 40px; height: 40px; border-radius: 50%; border: 0; background: var(--cqa-brand-strong); color: var(--cqa-on-brand); display: grid; place-items: center; cursor: pointer; flex: none; }
.play:hover { background: var(--cqa-brand-deep); }
.play:disabled { opacity: .45; cursor: not-allowed; background: var(--cqa-brand-strong); }
.player[data-playing="true"] .i-play, .player[data-playing="false"] .i-pause { display: none; }
.track { position: relative; flex: 1; height: 44px; min-width: 0; }
.seek { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.seek:disabled { cursor: not-allowed; }
.frame { position: absolute; inset: 0; border-radius: 6px; pointer-events: none; }
.seek:focus-visible ~ .frame { outline: 2px solid var(--cqa-focus); outline-offset: 2px; }
.wave { position: absolute; inset: 0; display: flex; align-items: center; gap: 2px; pointer-events: none; }
.wave span { flex: 1; border-radius: 2px; background: var(--cqa-line-strong); min-width: 0; }
.wave-fill { clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0); }
.wave-fill span { background: var(--cqa-brand-deep); }
.rail { position: absolute; left: 0; right: 0; top: 50%; height: 8px; margin-top: -4px; border-radius: 4px; background: var(--cqa-line-strong); overflow: hidden; pointer-events: none; }
.rail i { display: block; height: 100%; width: var(--p, 0%); background: var(--cqa-brand-deep); }
.tick { position: absolute; top: 50%; height: 16px; margin-top: -8px; width: 1px; background: var(--cqa-ink-3); opacity: .55; pointer-events: none; }
.mark { position: absolute; top: 0; bottom: 0; width: 3px; margin-left: -1px; border-radius: 1px; background: var(--cqa-critical); pointer-events: none; }
.player[data-phase="unavailable"] .track, .player[data-phase="error"] .track { opacity: .55; }
.time { font-size: var(--cqa-fs-13); color: var(--cqa-ink-2); flex: none; min-width: 92px; text-align: right; }
.meta { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; font-size: var(--cqa-fs-12); color: var(--cqa-ink-3); }
.seg button:disabled { opacity: .5; cursor: not-allowed; }
.leg { display: inline-flex; align-items: center; gap: 4px; }
.leg i { width: 3px; height: 12px; background: var(--cqa-critical); border-radius: 1px; display: inline-block; }
.status { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.status.bad { color: var(--cqa-bad); }
.rec { margin-left: auto; }
@media (max-width: 520px) { .time { min-width: 0; } }
`;

export class CqaAudioPlayer extends CqaElement {
  static get observedAttributes() {
    return [...super.observedAttributes, "src"];
  }

  constructor() {
    super();
    this._audio = typeof Audio === "function" ? new Audio() : null;
    this._sources = [];
    this._sourceIndex = 0;
    this._failed = false;
    this._loaded = false;
    this._declared = null;
    this._markers = [];
    this._bounds = [];
    this._peaks = null;
    this._timings = true;
    this._recording = null;
    this._speed = 1;
    this._playing = false;
    this._pos = 0;
    this._mediaDuration = null;
    this._bars = [];
    this._wire();
    this.shadowRoot.addEventListener("click", (event) => this.onClick(event));
    this.shadowRoot.addEventListener("input", (event) => this.onInput(event));
    this.shadowRoot.addEventListener("keydown", (event) => this.onKey(event));
  }

  styles() {
    return STYLES;
  }

  get audio() {
    return this._audio;
  }

  get position() {
    return this._pos;
  }

  get playing() {
    return this._playing;
  }

  get duration() {
    return resolveDuration({ media: this._mediaDuration, declared: this._declared, lastStart: this._bounds.length ? Math.max(...this._bounds) : null });
  }

  get speed() {
    return this._speed;
  }

  get phase() {
    return playerPhase({ sources: this._sources, failed: this._failed, loaded: this._loaded });
  }

  attributeChangedCallback(name, oldValue, value) {
    if (name === "src") {
      if (oldValue !== value) this.setSources(value ? [value] : []);
      return;
    }
    super.attributeChangedCallback(name, oldValue, value);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    queueMicrotask(() => {
      if (!this.isConnected && this._audio && !this._audio.paused) this._audio.pause();
    });
  }

  configure({ sources, recording, duration, markers, bounds, peaks, timings } = {}) {
    if (duration !== undefined) this._declared = finiteOr(duration);
    if (markers !== undefined) this._markers = markers.slice();
    if (bounds !== undefined) this._bounds = bounds.slice();
    if (peaks !== undefined) {
      this._peaks = peaks;
      this._bars = barHeights(peaks);
    }
    if (timings !== undefined) this._timings = Boolean(timings);
    if (recording !== undefined) this._recording = recording;
    if (sources !== undefined && JSON.stringify(sources) !== JSON.stringify(this._sources)) this.setSources(sources);
    else this.scheduleRender();
  }

  setSources(list) {
    this._sources = list.filter(Boolean);
    this._sourceIndex = 0;
    this._failed = false;
    this._loaded = false;
    this._mediaDuration = null;
    this._playing = false;
    if (this._audio) {
      this._audio.pause();
      if (this._sources.length) {
        this._audio.preload = "metadata";
        this._audio.src = this._sources[0];
        this._audio.playbackRate = this._speed;
        this._audio.load();
      } else {
        this._audio.removeAttribute("src");
        this._audio.load();
      }
    }
    this._pos = 0;
    this.scheduleRender();
  }

  _wire() {
    const a = this._audio;
    if (!a) return;
    const loaded = () => {
      const d = finiteOr(a.duration);
      this._mediaDuration = d !== null && d > 0 ? d : null;
      this._loaded = true;
      a.playbackRate = this._speed;
      this.scheduleRender();
    };
    a.addEventListener("loadedmetadata", loaded);
    a.addEventListener("durationchange", () => {
      const d = finiteOr(a.duration);
      if (d !== null && d > 0 && d !== this._mediaDuration) {
        this._mediaDuration = d;
        this.scheduleRender();
      }
    });
    a.addEventListener("timeupdate", () => {
      this._pos = a.currentTime;
      this.paint();
      this.emitTime();
    });
    a.addEventListener("seeked", () => {
      this._pos = a.currentTime;
      this.paint();
      this.emitTime();
    });
    a.addEventListener("play", () => this.setPlaying(true));
    a.addEventListener("pause", () => this.setPlaying(false));
    a.addEventListener("ended", () => this.setPlaying(false));
    a.addEventListener("error", () => {
      if (!this._sources.length) return;
      if (this._sourceIndex + 1 < this._sources.length) {
        this._sourceIndex += 1;
        a.src = this._sources[this._sourceIndex];
        a.load();
        return;
      }
      this._failed = true;
      this._playing = false;
      this.scheduleRender();
      this.emitState();
    });
  }

  setPlaying(value) {
    if (this._playing === value) return;
    this._playing = value;
    this.paint();
    this.emitState();
  }

  emitTime() {
    this.dispatchEvent(new CustomEvent(AUDIO_EVENTS.time, { detail: { position: this._pos, playing: this._playing, duration: this.duration } }));
  }

  emitState() {
    this.dispatchEvent(new CustomEvent(AUDIO_EVENTS.state, { detail: { phase: this.phase, playing: this._playing } }));
  }

  get usable() {
    const phase = this.phase;
    return phase === "ready" || phase === "loading";
  }

  seekTo(seconds, { play = false } = {}) {
    if (!this.usable || !this._audio) return false;
    const total = this.duration;
    const target = total > 0 ? clamp(seconds, total) : Math.max(0, finiteOr(seconds, 0));
    try {
      this._audio.currentTime = target;
    } catch (error) {
      return false;
    }
    this._pos = target;
    this.paint();
    this.emitTime();
    if (play) this.play();
    return true;
  }

  async play() {
    if (!this.usable || !this._audio) return false;
    if (this.duration > 0 && this._pos >= this.duration) this.seekTo(0);
    try {
      await this._audio.play();
      return true;
    } catch (error) {
      this.setPlaying(false);
      return false;
    }
  }

  pause() {
    if (this._audio) this._audio.pause();
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return;
    this._speed = speed;
    if (this._audio) {
      this._audio.defaultPlaybackRate = speed;
      this._audio.playbackRate = speed;
    }
    this.paint();
  }

  onClick(event) {
    const el = event.target && event.target.closest ? event.target.closest("[data-action]") : null;
    if (!el || el.disabled) return;
    const action = el.getAttribute("data-action");
    if (action === "toggle") this.toggle();
    else if (action === "speed") this.setSpeed(Number(el.getAttribute("data-speed")));
    else if (action === "retry") {
      const sources = this._sources.slice();
      this.setSources(sources);
    }
  }

  onInput(event) {
    const t = event.target;
    if (t && t.matches && t.matches("[data-seek]")) this.seekTo(Number(t.value));
  }

  onKey(event) {
    const t = event.target;
    if (!t || !t.matches || !t.matches("[data-seek]")) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      this.toggle();
      return;
    }
    const next = nextPosition(this._pos, event.key, this.duration);
    if (next === null) return;
    event.preventDefault();
    this.seekTo(next);
  }

  template() {
    const locale = this.locale;
    const phase = this.phase;
    const total = this.duration;
    const disabled = phase === "unavailable" || phase === "error" ? "disabled" : "";
    const max = Math.max(1, Math.ceil(total));
    const bars = this._bars.length ? this._bars : null;
    const barSpans = bars ? bars.map((h) => html`<span style="height:${h}px"></span>`) : [];
    const track = bars
      ? html`<div class="wave" aria-hidden="true" data-wave>${barSpans}</div><div class="wave wave-fill" aria-hidden="true" data-fill>${barSpans}</div>`
      : html`<div class="rail" aria-hidden="true"><i></i></div>${this._bounds.map((s) => html`<span class="tick" aria-hidden="true" style="left:${percentOf(s, total).toFixed(2)}%"></span>`)}`;
    const marks = this._markers.map((s) => html`<span class="mark" aria-hidden="true" data-mark style="left:${percentOf(s, total).toFixed(2)}%"></span>`);
    const speeds = SPEEDS.map(
      (s) => html`<button type="button" data-action="speed" data-speed="${s}" data-focus-id="speed-${s}" aria-pressed="${this._speed === s ? "true" : "false"}" ${raw(disabled)}>${speedLabel(s, locale)}</button>`
    );
    const legend = this._markers.length ? html`<span class="leg"><i aria-hidden="true"></i>${this.t("audio.grossLegend")}</span>` : html``;
    let status;
    if (phase === "unavailable") status = html`<span class="status" role="status" data-status="unavailable">${this.t("audio.unavailableText")}</span>`;
    else if (phase === "error") {
      status = html`<span class="status bad" role="alert" data-status="error">${this.t("audio.error")}</span><button type="button" class="btn btn-sm" data-action="retry" data-focus-id="audio-retry">${this.t("action.retry")}</button>`;
    } else if (phase === "loading") status = html`<span class="status" role="status" aria-busy="true" data-status="loading">${this.t("audio.loading")}</span>`;
    else status = html`<span class="status" data-status="ready">${this._timings ? this.t("audio.hint") : this.t("audio.noTimings")}</span>`;
    const waveNote = !bars && phase !== "unavailable" ? html`<span data-wave-note>${this.t("audio.noWaveform")}</span>` : html``;
    const rec = this._recording
      ? html`<a class="btn btn-sm rec" href="${this._recording}" target="_blank" rel="noopener" data-focus-id="audio-open">${this.t("audio.openRecording")}</a>`
      : html`<button type="button" class="btn btn-sm rec" disabled title="${this.t("audio.recordingUnavailable")}">${this.t("audio.openRecording")}</button>`;
    return html`<div class="player" role="region" aria-label="${this.t("audio.region")}" data-player data-phase="${phase}" data-playing="${this._playing ? "true" : "false"}"><div class="line"><button type="button" class="play" data-action="toggle" data-focus-id="play" data-play ${raw(disabled)}>${PLAY_ICON}${PAUSE_ICON}</button><div class="track" data-track><input class="seek" type="range" min="0" max="${max}" step="1" value="0" data-seek data-focus-id="seek" aria-label="${this.t("audio.position")}" ${raw(disabled)}>${track}${marks}<span class="frame" aria-hidden="true"></span></div><span class="time tnum" data-time></span></div><div class="meta"><div class="seg" role="group" aria-label="${this.t("audio.speedGroup")}">${speeds}</div>${legend}${waveNote}${status}${rec}</div></div>`;
  }

  afterRender(region) {
    this._root = region.querySelector("[data-player]");
    this.paint();
  }

  paint() {
    const root = this._root;
    if (!root || !root.isConnected) return;
    const total = this.duration;
    const pos = clamp(this._pos, total || this._pos);
    root.style.setProperty("--p", `${percentOf(pos, total).toFixed(3)}%`);
    root.setAttribute("data-playing", this._playing ? "true" : "false");
    const seek = root.querySelector("[data-seek]");
    if (seek) {
      seek.value = String(Math.floor(pos));
      seek.setAttribute("aria-valuetext", valueText(pos, total, this.locale));
    }
    const time = root.querySelector("[data-time]");
    if (time) time.textContent = positionText(pos, total);
    const play = root.querySelector("[data-play]");
    if (play) play.setAttribute("aria-label", this.t(this._playing ? "audio.pause" : "audio.play"));
    for (const b of root.querySelectorAll("[data-speed]")) {
      b.setAttribute("aria-pressed", Number(b.getAttribute("data-speed")) === this._speed ? "true" : "false");
    }
  }
}
