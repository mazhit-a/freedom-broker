export const SECTIONS = Object.freeze(["overview", "conversations", "appeals", "checklists", "runs"]);

export const ID_ATTRIBUTE = Object.freeze({
  overview: null,
  conversations: "conversation-id",
  appeals: "appeal-id",
  checklists: "checklist-id",
  runs: "run-id"
});

export const SCREEN_TAG = Object.freeze({
  overview: "cqa-overview",
  conversations: "cqa-conversation-list",
  conversationCard: "cqa-conversation-card",
  appeals: "cqa-appeal-queue",
  checklists: "cqa-checklist-builder",
  runs: "cqa-eval-runs"
});

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch (error) {
    return part;
  }
}

export function parseHash(hash) {
  const text = String(hash ?? "").replace(/^#/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!text) return { name: "overview", id: null, known: true, path: "overview" };
  const parts = text.split("/").map(decode);
  const [name, id = null, ...rest] = parts;
  if (SECTIONS.includes(name) && rest.length === 0 && (id === null || (name !== "overview" && id !== ""))) {
    return { name, id, known: true, path: id === null ? name : `${name}/${id}` };
  }
  return { name: "unknown", id: null, known: false, path: text };
}

export function formatHash(name, id = null) {
  if (!SECTIONS.includes(name)) return "#/overview";
  return id === null || id === undefined || id === "" ? `#/${name}` : `#/${name}/${encodeURIComponent(id)}`;
}

export function screenTag(route) {
  if (route.name === "conversations" && route.id !== null) return SCREEN_TAG.conversationCard;
  return SCREEN_TAG[route.name] || null;
}
