import {
  DEMO_LOCALES,
  DEMO_ROLES,
  DEMO_WIDTHS,
  buildSteps,
  demoIds,
  demoText,
  frameUrl,
  stepIndexForHash
} from "./demo-steps.js";

const FRAME_PAGE = "index.html";
const config = globalThis.CQA_CONFIG || {};
const query = new URLSearchParams(globalThis.location.search);

function truthy(value) {
  return value === true || value === "1" || value === "true" || value === "yes";
}

const mock = query.has("mock") ? truthy(query.get("mock")) : truthy(config.mock);
const ids = demoIds(config, mock);
const steps = buildSteps(ids);

const state = {
  step: 0,
  role: steps[0].role,
  locale: DEMO_LOCALES.includes(query.get("locale")) ? query.get("locale") : "ru",
  width: DEMO_WIDTHS.includes(Number(query.get("width"))) ? Number(query.get("width")) : 0,
  scale: 1
};

const $ = (id) => globalThis.document.getElementById(id);
const frame = $("app");
const viewport = $("viewport");
let observed = null;

function text() {
  return demoText(state.locale);
}

function fill(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

function element(tag, attrs = {}, label = "") {
  const node = globalThis.document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (label) node.textContent = label;
  return node;
}

function segment(host, items, current, onPick) {
  host.replaceChildren(
    ...items.map(({ value, label }) => {
      const button = element("button", { type: "button", "aria-pressed": String(value === current), "data-value": String(value) }, label);
      button.addEventListener("click", () => onPick(value));
      return button;
    })
  );
}

function appOf() {
  try {
    const doc = frame.contentDocument;
    return doc ? doc.querySelector("cqa-app") : null;
  } catch (error) {
    return null;
  }
}

function currentHash() {
  try {
    return frame.contentWindow.location.hash;
  } catch (error) {
    return "";
  }
}

function load(hash) {
  frame.setAttribute("src", frameUrl({ page: FRAME_PAGE, role: mock ? null : state.role, locale: state.locale, mock, hash }));
}

function emitIn(app, name, detail) {
  const view = app.ownerDocument.defaultView;
  app.dispatchEvent(new view.CustomEvent(name, { detail, bubbles: true, composed: true }));
}

function pushRole() {
  const app = appOf();
  if (app && app.shadowRoot) emitIn(app, "cqa:role-change", { role: state.role });
}

function pushLocale() {
  const app = appOf();
  if (app && app.shadowRoot) emitIn(app, "cqa:locale-change", { locale: state.locale });
}

function applyHash(hash) {
  const app = appOf();
  if (!app) {
    load(hash);
    return;
  }
  try {
    if (frame.contentWindow.location.hash !== hash) frame.contentWindow.location.hash = hash;
  } catch (error) {
    load(hash);
  }
}

function fit() {
  const stage = $("stage");
  const available = Math.max(320, stage.clientWidth);
  const wanted = state.width === 0 ? available : state.width;
  const scale = Math.min(1, available / wanted);
  const height = Math.max(560, globalThis.innerHeight - 56);
  state.scale = scale;
  viewport.style.width = `${Math.round(wanted * scale)}px`;
  viewport.style.height = `${Math.round(height)}px`;
  frame.style.width = `${wanted}px`;
  frame.style.height = `${Math.round(height / scale)}px`;
  frame.style.transform = scale < 1 ? `scale(${scale})` : "none";
  const label = state.width === 0 ? text().widthAuto : `${state.width}`;
  $("stage-note").textContent = scale < 1 ? `${label} px, ${fill(text().scale, { n: Math.round(scale * 100) })}` : `${label === text().widthAuto ? Math.round(wanted) : label} px`;
}

function renderBar() {
  const tx = text();
  globalThis.document.documentElement.setAttribute("lang", state.locale);
  $("demo-title").textContent = tx.title;
  $("demo-subtitle").textContent = tx.subtitle;
  const mode = $("demo-mode");
  mode.textContent = mock ? tx.modeMock : tx.modeReal;
  mode.setAttribute("data-mode", mock ? "mock" : "real");
  $("lbl-role").textContent = tx.role;
  $("lbl-locale").textContent = tx.locale;
  $("lbl-width").textContent = tx.width;
  segment($("seg-role"), DEMO_ROLES.map((value) => ({ value, label: tx.roles[value] })), state.role, setRole);
  segment($("seg-locale"), DEMO_LOCALES.map((value) => ({ value, label: value === "kk" ? "KZ" : value.toUpperCase() })), state.locale, setLocale);
  segment(
    $("seg-width"),
    DEMO_WIDTHS.map((value) => ({ value, label: value === 0 ? tx.widthAuto : String(value) })),
    state.width,
    (value) => setWidth(Number(value))
  );
  $("guide-title").textContent = tx.guide;
  $("btn-prev").textContent = tx.prev;
  $("btn-next").textContent = tx.next;
  $("btn-reset").textContent = tx.reset;
  frame.setAttribute("title", tx.frameLabel);
  $("stage").setAttribute("aria-label", tx.frameLabel);
  $("skip").textContent = tx.frameLabel;
  $("btn-prev").disabled = state.step === 0;
  $("btn-next").disabled = state.step === steps.length - 1;
}

function renderSteps() {
  const tx = text();
  const list = $("steps");
  list.replaceChildren(
    ...steps.map((step, index) => {
      const copy = tx.steps[step.key];
      const item = element("li");
      const attrs = { type: "button", "data-step": step.key };
      if (index === state.step) attrs["aria-current"] = "step";
      const button = element("button", attrs);
      button.append(element("span", { class: "n" }, String(index + 1)), element("span", {}, copy.title));
      if (copy.time) button.append(element("span", { class: "time" }, copy.time));
      button.addEventListener("click", () => go(index));
      item.append(button);
      return item;
    })
  );
  const step = steps[state.step];
  const copy = tx.steps[step.key];
  const detail = $("detail");
  const pieces = [
    element("h3", {}, `${fill(tx.stepOf, { n: state.step + 1, m: steps.length })}: ${copy.title}`),
    element("p", {}, copy.body)
  ];
  const points = element("ul");
  for (const point of copy.points) points.append(element("li", {}, point));
  pieces.push(points);
  const meta = element("p", { class: "meta" });
  meta.append(`${tx.role}: ${tx.roles[step.role]}`);
  if (step.ref) {
    meta.append(" · ");
    meta.append(element("code", {}, step.ref));
  }
  meta.append(" · ");
  meta.append(element("code", {}, step.hash));
  pieces.push(meta);
  detail.replaceChildren(...pieces);
  $("live").textContent = `${fill(tx.stepOf, { n: state.step + 1, m: steps.length })}: ${copy.title}`;
}

function render() {
  renderBar();
  renderSteps();
  fit();
}

function go(index) {
  state.step = Math.max(0, Math.min(steps.length - 1, index));
  const step = steps[state.step];
  state.role = step.role;
  render();
  pushRole();
  applyHash(step.hash);
}

function setRole(role) {
  state.role = role;
  render();
  pushRole();
}

function setLocale(locale) {
  state.locale = locale;
  render();
  pushLocale();
}

function setWidth(width) {
  state.width = width;
  render();
}

function reset() {
  state.step = 0;
  state.role = steps[0].role;
  render();
  load(steps[0].hash);
}

function attach() {
  const app = appOf();
  if (!app || observed === app) return;
  observed = app;
  app.addEventListener("cqa:role-change", (event) => {
    const role = event.detail && event.detail.role;
    if (role && role !== state.role) {
      state.role = role;
      renderBar();
    }
  });
  app.addEventListener("cqa:locale-change", (event) => {
    const locale = event.detail && event.detail.locale;
    if (locale && locale !== state.locale) {
      state.locale = locale;
      render();
    }
  });
  try {
    frame.contentWindow.addEventListener("hashchange", () => {
      const hash = currentHash();
      if (steps[state.step].hash === hash) return;
      const index = stepIndexForHash(steps, hash);
      if (index >= 0) {
        state.step = index;
        renderSteps();
      }
    });
  } catch (error) {
    return;
  }
}

frame.addEventListener("load", () => {
  observed = null;
  attach();
  globalThis.setTimeout(attach, 300);
  pushLocale();
  pushRole();
});
$("btn-prev").addEventListener("click", () => go(state.step - 1));
$("btn-next").addEventListener("click", () => go(state.step + 1));
$("btn-reset").addEventListener("click", reset);
globalThis.addEventListener("resize", fit);
if (typeof globalThis.ResizeObserver === "function") new globalThis.ResizeObserver(fit).observe($("stage"));

const start = (() => {
  const wanted = query.get("step");
  const index = steps.findIndex((step) => step.key === wanted);
  return index >= 0 ? index : 0;
})();
state.step = start;
state.role = steps[start].role;
render();
load(steps[start].hash);
