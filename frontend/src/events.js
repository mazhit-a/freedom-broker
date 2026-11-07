export const EVENTS = Object.freeze({
  navigate: "cqa:navigate",
  appealSubmitted: "cqa:appeal-submitted",
  decisionSaved: "cqa:decision-saved"
});

export function emit(target, name, detail = {}) {
  const event = new CustomEvent(name, { detail, bubbles: true, composed: true });
  target.dispatchEvent(event);
  return event;
}

export function navigate(target, to, id = null) {
  return emit(target, EVENTS.navigate, { to, id });
}
