import { ApiError, notImplemented } from "./errors.js";
import { createMock } from "./api.mock.js";
import {
  mapAppeal,
  mapAppealList,
  mapAppealSummary,
  mapChecklist,
  mapChecklists,
  mapConversation,
  mapDataset,
  mapEvaluation,
  mapEvaluationSummary,
  mapListResponse,
  mapOverview,
  mapRun,
  mapVersion,
  runNumber,
  wireAnswer,
  isDisplayStatus,
  coarseAppealStatus
} from "./mappers.js";

export { ApiError } from "./errors.js";

const WIRE_CHANNEL = { chat: "agent chat", call: "voice call" };
const SORT_WIRE = { total: "final_total", id: "conversation_id", language: "language", channel: "channel" };

const settings = {
  configured: false,
  baseUrl: null,
  recordId: null,
  mock: false,
  state: null,
  role: null,
  operatorId: null,
  locale: null
};

let mock = null;
const pkCache = new Map();
const versionCache = new Map();

function truthy(value) {
  return value === true || value === "1" || value === "true" || value === "yes";
}

function environment() {
  const out = {};
  const cfg = (globalThis.CQA_CONFIG) || {};
  if (cfg.apiBase) out.baseUrl = cfg.apiBase;
  if (cfg.mock !== undefined) out.mock = truthy(cfg.mock);
  if (cfg.state) out.state = cfg.state;
  if (cfg.role) out.role = cfg.role;
  if (cfg.locale) out.locale = cfg.locale;
  if (cfg.operatorId) out.operatorId = cfg.operatorId;
  const search = globalThis.location && globalThis.location.search ? globalThis.location.search : "";
  if (search) {
    const q = new URLSearchParams(search);
    if (q.has("mock")) out.mock = truthy(q.get("mock"));
    if (q.get("state")) out.state = q.get("state");
    if (q.get("role")) out.role = q.get("role");
    if (q.get("locale")) out.locale = q.get("locale");
    if (q.get("operator")) out.operatorId = q.get("operator");
  }
  return out;
}

export function configure(options = {}) {
  const merged = { ...environment(), ...options };
  settings.configured = true;
  settings.baseUrl = merged.baseUrl ?? merged.apiBase ?? null;
  settings.recordId = merged.recordId ?? null;
  settings.mock = Boolean(merged.mock);
  settings.state = merged.state || null;
  settings.role = merged.role || null;
  settings.operatorId = merged.operatorId || null;
  settings.locale = merged.locale || null;
  pkCache.clear();
  versionCache.clear();
  mock = settings.mock
    ? createMock({ state: settings.state, role: settings.role, operatorId: settings.operatorId, slowMs: options.slowMs })
    : null;
  return getSettings();
}

export function getSettings() {
  return {
    baseUrl: settings.baseUrl,
    recordId: settings.recordId,
    mock: settings.mock,
    state: settings.state,
    role: settings.role,
    operatorId: settings.operatorId,
    locale: settings.locale
  };
}

export function ensureConfigured() {
  if (!settings.configured) configure();
  return getSettings();
}

export function resetMock(options = {}) {
  if (!mock) throw new ApiError(0, "mock_disabled", "Mock mode is not enabled");
  mock.reset(options);
}

function ensure() {
  if (!settings.configured) configure();
}

function base() {
  const raw = settings.baseUrl || (globalThis.CQA_CONFIG && globalThis.CQA_CONFIG.apiBase) || "../api/v1";
  return raw.replace(/\/+$/, "");
}

function documentBase() {
  if (typeof document !== "undefined" && document.baseURI) return document.baseURI;
  if (globalThis.location && globalThis.location.href) return globalThis.location.href;
  return "http://localhost/";
}

function url(path, params) {
  const target = new URL(base() + path, documentBase());
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") target.searchParams.set(key, value);
    }
  }
  return target.toString();
}

function messageFrom(body, status) {
  if (body && typeof body.detail === "string") return body.detail;
  if (body && Array.isArray(body.detail)) return body.detail.map((item) => item.msg || JSON.stringify(item)).join("; ");
  if (body && typeof body.error === "string") return body.error;
  return "Request failed with HTTP " + status;
}

async function request(path, options = {}, params) {
  let response;
  try {
    response = await globalThis.fetch(url(path, params), options);
  } catch (err) {
    throw new ApiError(0, "network", "Backend is unreachable: " + (err && err.message ? err.message : err));
  }
  let body = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      body = null;
    }
  }
  if (!response.ok) {
    const code = body && typeof body.code === "string" ? body.code : "http_" + response.status;
    throw new ApiError(response.status, code, messageFrom(body, response.status));
  }
  if (body && body.isSuccess === false) throw new ApiError(502, "source_failure", body.error || "The data source reported a failure");
  return { body, headers: response.headers };
}

async function getJson(path, params) {
  return (await request(path, {}, params)).body;
}

async function sendJson(method, path, payload, params) {
  return (
    await request(path, { method, headers: { "Content-Type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) }, params)
  ).body;
}

function isPk(value) {
  return typeof value === "number" || /^\d+$/.test(String(value));
}

async function resolvePk(id, dataset) {
  if (isPk(id)) return Number(id);
  const key = String(dataset || "") + "|" + id;
  if (pkCache.has(key)) return pkCache.get(key);
  const raw = await getJson("/conversations/by-key/" + encodeURIComponent(id), { dataset });
  pkCache.set(key, raw.id);
  pkCache.set("|" + raw.conversation_id, raw.id);
  return raw.id;
}

async function loadVersion(id) {
  if (versionCache.has(id)) return versionCache.get(id);
  const raw = await getJson("/checklist-versions/" + encodeURIComponent(id));
  const vm = mapVersion(raw);
  versionCache.set(id, vm);
  return vm;
}

function operatorParam(filter) {
  return filter && filter.operator !== undefined ? filter.operator : settings.operatorId;
}

function wireChannel(value) {
  return value ? WIRE_CHANNEL[value] || value : undefined;
}

const real = {
  async listConversations(filter = {}) {
    const display = isDisplayStatus(filter.appealStatus);
    const paged = !display;
    const params = {
      dataset: filter.dataset,
      language: filter.language,
      channel: wireChannel(filter.channel),
      checklist_version_id: filter.versionId,
      appeal_status: display ? coarseAppealStatus(filter.appealStatus) : filter.appealStatus,
      gross: filter.gross === undefined || filter.gross === null ? undefined : String(Boolean(filter.gross)),
      q: filter.q,
      sort: filter.sort ? (filter.sort.startsWith("-") ? "-" : "") + (SORT_WIRE[filter.sort.replace(/^[-+]/, "")] || filter.sort.replace(/^[-+]/, "")) : undefined,
      limit: paged ? filter.limit : undefined,
      offset: paged && filter.offset ? filter.offset : undefined,
      envelope: "1",
      operator: operatorParam(filter)
    };
    const body = await getJson("/conversations", params);
    if (!display) return mapListResponse(body, { offset: filter.offset || 0, limit: filter.limit });
    const mapped = mapListResponse(body);
    const items = mapped.items.filter((i) => i.appealStatus === filter.appealStatus);
    const start = filter.offset || 0;
    return { items: filter.limit ? items.slice(start, start + filter.limit) : items.slice(start), total: items.length, evaluated: items.filter((i) => i.evaluated && !i.failed).length };
  },

  async getConversation(id, options = {}) {
    const raw = isPk(id)
      ? await getJson("/conversations/" + Number(id))
      : await getJson("/conversations/by-key/" + encodeURIComponent(id), { dataset: options.dataset });
    pkCache.set("|" + raw.conversation_id, raw.id);
    return mapConversation(raw);
  },

  async getEvaluation(conversationId, version, options = {}) {
    const pk = await resolvePk(conversationId, options.dataset);
    const raw = await getJson("/conversations/" + pk + "/evaluation", { checklist_version_id: version });
    return mapEvaluation(raw, await loadVersion(raw.checklist_version_id));
  },

  async getEvaluationById(evaluationId) {
    const raw = await getJson("/evaluations/" + encodeURIComponent(evaluationId));
    return mapEvaluation(raw, await loadVersion(raw.checklist_version_id));
  },

  async listEvaluations(conversationId, options = {}) {
    const pk = await resolvePk(conversationId, options.dataset);
    const list = await getJson("/conversations/" + pk + "/evaluations");
    return list.map(mapEvaluationSummary);
  },

  async evaluate(conversationId, versionId, options = {}) {
    const pk = await resolvePk(conversationId, options.dataset);
    const raw = await sendJson("POST", "/conversations/" + pk + "/evaluate", undefined, { checklist_version_id: versionId });
    return mapEvaluation(raw, await loadVersion(raw.checklist_version_id));
  },

  async submitAppeal(evaluationId, criterionId, body = {}) {
    const refs = (body.refs || []).map((r) => (typeof r === "object" ? r.index : r));
    const raw = await sendJson("POST", "/evaluations/" + encodeURIComponent(evaluationId) + "/appeals", {
      criterion_id: criterionId,
      comment: body.comment,
      role: "operator",
      message_refs: refs
    });
    return mapAppeal(raw);
  },

  async startReview(appealId) {
    const raw = await sendJson("POST", "/appeals/" + encodeURIComponent(appealId) + "/start-review", { role: "reviewer" });
    return mapAppeal(raw);
  },

  async decideAppeal(appealId, body = {}) {
    const raw = await sendJson("POST", "/appeals/" + encodeURIComponent(appealId) + "/decision", {
      decision: body.decision,
      new_answer: body.newAnswer === undefined || body.newAnswer === null ? null : wireAnswer(body.newAnswer),
      reason: body.reason,
      role: "reviewer"
    });
    return mapAppeal(raw);
  },

  async listAppeals(filter = {}) {
    const status = filter.status || "all";
    const body = await getJson("/appeals", { status, operator: operatorParam(filter) });
    return mapAppealList(body).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id - b.id);
  },

  async getAppeal(id) {
    const list = await real.listAppeals({ status: "all" });
    const found = list.find((a) => a.id === Number(id));
    if (!found) throw new ApiError(404, "appeal_not_found", "Appeal not found");
    return found;
  },

  async appealSummary() {
    return mapAppealSummary(await getJson("/appeals/summary"));
  },

  async getOverview(filter = {}) {
    const raw = await getJson("/stats/overview", {
      dataset: filter.dataset,
      checklist_version_id: filter.versionId,
      from: filter.from,
      to: filter.to,
      language: filter.language,
      channel: wireChannel(filter.channel),
      attention_limit: filter.attentionLimit
    });
    return mapOverview(raw);
  },

  async listChecklists() {
    return mapChecklists(await getJson("/checklists"));
  },

  async getChecklist(id) {
    return mapChecklist(await getJson("/checklists/" + encodeURIComponent(id)));
  },

  async getChecklistVersion(id) {
    versionCache.delete(Number(id));
    return loadVersion(Number(id));
  },

  async saveChecklistVersion(checklistId, config, options = {}) {
    const raw = await sendJson("POST", "/checklists/" + encodeURIComponent(checklistId) + "/versions", config, { status: options.status === "draft" ? "draft" : "saved" });
    versionCache.clear();
    return mapVersion(raw);
  },

  async updateDraft(versionId, config) {
    const raw = await sendJson("PUT", "/checklist-versions/" + encodeURIComponent(versionId), config);
    versionCache.delete(Number(versionId));
    return mapVersion(raw);
  },

  async finalizeVersion(versionId) {
    const raw = await sendJson("POST", "/checklist-versions/" + encodeURIComponent(versionId) + "/save");
    versionCache.delete(Number(versionId));
    return mapVersion(raw);
  },

  async setActiveVersion(checklistId, versionId) {
    const raw = await sendJson("PUT", "/checklists/" + encodeURIComponent(checklistId) + "/default", { version_id: versionId });
    versionCache.clear();
    return mapVersion(raw);
  },

  async listDatasets() {
    return (await getJson("/datasets")).map(mapDataset);
  },

  async importDataset(input = {}) {
    let result;
    if (input.file) {
      const form = new FormData();
      form.append("file", input.file);
      if (input.groupId) form.append("group_id", input.groupId);
      result = (await request("/datasets/import-file", { method: "POST", body: form })).body;
    } else {
      result = await sendJson("POST", "/datasets/import", { group_id: input.groupId });
    }
    const list = await getJson("/datasets");
    const found = list.find((d) => d.id === result.dataset_id);
    return { ...mapDataset(found || { id: result.dataset_id, group_id: result.group_id, source: result.source }), created: result.created ?? null, updated: result.updated ?? null };
  },

  async listModels() {
    throw notImplemented("BG-18", "model catalog");
  },

  async estimateRun() {
    throw notImplemented("BG-18", "run cost estimate");
  },

  async startRun(input = {}) {
    let dataset = input.groupId;
    if (input.file) dataset = (await real.importDataset({ file: input.file, groupId: input.groupId })).groupId;
    const pks = input.conversationIds ? await Promise.all(input.conversationIds.map((id) => resolvePk(id))) : undefined;
    const raw = await sendJson("POST", "/runs", {
      dataset: pks && pks.length ? undefined : dataset,
      checklist_version_id: input.versionId,
      force: Boolean(input.force),
      conversation_pks: pks
    });
    return mapRun(raw);
  },

  async getRun(id, paging = {}) {
    const raw = await getJson("/runs/" + runNumber(id), { offset: paging.offset, limit: paging.limit });
    return mapRun(raw);
  },

  async listRuns(paging = {}) {
    const list = await getJson("/runs", { offset: paging.offset, limit: paging.limit });
    return list.map(mapRun);
  },

  async retryRunItem() {
    throw notImplemented("BG-19", "run item retry");
  },

  async getWaveform() {
    throw notImplemented("BG-30", "waveform peaks");
  }
};

const METHODS = Object.keys(real);

export const api = {};

for (const name of METHODS) {
  api[name] = async (...args) => {
    ensure();
    if (mock) return mock.impl[name](...args);
    return real[name](...args);
  };
}

api.audioUrl = (id, mode) => {
  ensure();
  if (mock) return mock.audioUrl(id, mode);
  let pk = null;
  if (isPk(id)) pk = Number(id);
  else if (pkCache.has("|" + id)) pk = pkCache.get("|" + id);
  if (pk === null) throw new ApiError(400, "pk_required", "Load the conversation before requesting its audio");
  return url("/conversations/" + pk + "/audio", mode ? { mode } : undefined);
};

export const REAL_METHODS = METHODS.filter((name) => !["listModels", "estimateRun", "retryRunItem", "getWaveform"].includes(name)).concat(["audioUrl"]);
export const GAP_METHODS = { listModels: "BG-18", estimateRun: "BG-18", retryRunItem: "BG-19", getWaveform: "BG-30" };
export const ADAPTER_METHODS = METHODS.concat(["audioUrl"]);
