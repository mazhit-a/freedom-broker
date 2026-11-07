function base() {
  const cfg = window.CQA_CONFIG || {};
  const raw = cfg.apiBase || "../api/v1";
  return raw.replace(/\/+$/, "");
}

function url(path, params) {
  const target = new URL(base() + path, document.baseURI);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        target.searchParams.set(key, value);
      }
    }
  }
  return target.toString();
}

function messageFrom(body, status) {
  if (body && typeof body.detail === "string") return body.detail;
  if (body && Array.isArray(body.detail)) {
    return body.detail.map((item) => item.msg || JSON.stringify(item)).join("; ");
  }
  if (body && typeof body.error === "string") return body.error;
  return "Request failed with HTTP " + status;
}

async function request(path, options = {}, params) {
  let response;
  try {
    response = await fetch(url(path, params), options);
  } catch (err) {
    throw new Error("Backend is unreachable: " + (err && err.message ? err.message : err));
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
    throw new Error(messageFrom(body, response.status));
  }
  if (body && body.isSuccess === false) {
    throw new Error(body.error || "The data source reported a failure");
  }
  return body;
}

export const api = {
  getConversation(id) {
    return request("/conversations/" + encodeURIComponent(id));
  },
  listEvaluations(id) {
    return request("/conversations/" + encodeURIComponent(id) + "/evaluations");
  },
  evaluate(id, versionId) {
    return request("/conversations/" + encodeURIComponent(id) + "/evaluate", { method: "POST" }, { checklist_version_id: versionId });
  },
  getEvaluation(id) {
    return request("/evaluations/" + encodeURIComponent(id));
  },
  createAppeal(evaluationId, payload) {
    return request("/evaluations/" + encodeURIComponent(evaluationId) + "/appeals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  listAppeals(status) {
    return request("/appeals", {}, { status });
  },
  decideAppeal(appealId, payload) {
    return request("/appeals/" + encodeURIComponent(appealId) + "/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  getChecklistVersion(id) {
    return request("/checklist-versions/" + encodeURIComponent(id));
  },
  audioUrl(id, mode) {
    return url("/conversations/" + encodeURIComponent(id) + "/audio", mode ? { mode } : undefined);
  },
  listDatasets() {
    return request("/datasets");
  },
  listConversations(filters) {
    return request("/conversations", {}, filters);
  },
  getChecklist(id) {
    return request("/checklists/" + encodeURIComponent(id));
  },
  createChecklistVersion(checklistId, config) {
    return request("/checklists/" + encodeURIComponent(checklistId) + "/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });
  },
  setDefaultVersion(checklistId, versionId) {
    return request("/checklists/" + encodeURIComponent(checklistId) + "/default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: versionId })
    });
  },
  listChecklists() {
    return request("/checklists");
  },
  startBatch(payload) {
    return request("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  getBatch(id) {
    return request("/batches/" + id);
  },
  listBatches() {
    return request("/batches");
  },
  importByGroup(groupId) {
    return request("/datasets/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: groupId })
    });
  },
  importFile(file, groupId) {
    const form = new FormData();
    form.append("file", file);
    if (groupId) form.append("group_id", groupId);
    return request("/datasets/import-file", { method: "POST", body: form });
  }
};
