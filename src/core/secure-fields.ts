import type { DeviceElement } from "./device.ts";

export const HIDDEN_VALUE = "(hidden)";

const SECURE_ROLE = /password|secure/i;
const MASK_ONLY = /^[\u2022\u25CF\u2219\u00B7\u2027\u2217*]+$/;
const QUOTED = /"((?:[^"\\]|\\.)*)"/g;
const VALUE_SLOT = /( = |value=)"(?:[^"\\]|\\.)+"/g;
const UNREFERENCED_LINE = /^(\s*- )([^"\n=[]+?)( = ")/;

export function isSecureRole(role: string): boolean {
  return SECURE_ROLE.test(role);
}

export function isMaskedText(text: string): boolean {
  return MASK_ONLY.test(text.trim());
}

export function secureLabel(role: string, label: string): string {
  return isSecureRole(role) && isMaskedText(label) ? HIDDEN_VALUE : label;
}

function withMaskedTextHidden(text: string): string {
  return text.replace(QUOTED, (whole, inner: string) => (isMaskedText(inner) ? `"${HIDDEN_VALUE}"` : whole));
}

export function secureElementLine(text: string): string {
  return withMaskedTextHidden(text.replace(VALUE_SLOT, `$1"${HIDDEN_VALUE}"`));
}

export function secureUnreferencedLine(text: string): string {
  const role = UNREFERENCED_LINE.exec(text)?.[2];
  return role !== undefined && isSecureRole(role) ? withMaskedTextHidden(text) : text;
}

export function withSecureValuesHidden(element: DeviceElement): DeviceElement {
  const own = isSecureRole(element.role) && element.value !== null ? { ...element, value: HIDDEN_VALUE } : element;
  return own.children.length ? { ...own, children: own.children.map(withSecureValuesHidden) } : own;
}
