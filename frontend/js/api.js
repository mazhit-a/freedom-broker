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
  listDatasets() {
    return request("/datasets");
  },
  listConversations(filters) {
    return request("/conversations", {}, filters);
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
