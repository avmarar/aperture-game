import { CODE_CHARS } from "./text.js";

const CODE_RE = new RegExp(`^[${CODE_CHARS}]{4}$`);

export function isRoomCode(value) {
  return CODE_RE.test((value || "").toUpperCase());
}

export function parseRoomCode(pathname = window.location.pathname) {
  const parts = pathname.split("/").filter(Boolean);
  let raw = "";
  if (parts.length === 1) raw = parts[0];
  else if (parts.length === 2 && parts[0].toLowerCase() === "join") raw = parts[1];
  const code = raw.toUpperCase();
  return isRoomCode(code) ? code : "";
}

export function joinPath(code) {
  return `/join/${code}`;
}

export function joinUrl(code) {
  return `${window.location.origin}${joinPath(code)}`;
}

export function goHome() {
  window.history.pushState({}, "", "/");
}

export function goJoin(code) {
  window.history.replaceState({}, "", joinPath(code));
}
