import { raw } from "../base-element.js";

const PATHS = {
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><path d="M4 22v-7"></path>',
  check: '<path d="M20 6 9 17l-5-5"></path>',
  alert: '<path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>',
  retry: '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path>',
  up: '<path d="m6 15 6-6 6 6"></path>',
  close: '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>',
  plus: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path>',
  down: '<path d="m6 9 6 6 6-6"></path>'
};

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

export function icon(name, size = 14) {
  const body = PATHS[name];
  if (!body) return raw("");
  const px = Number(size) || 14;
  return raw(
    `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  );
}
