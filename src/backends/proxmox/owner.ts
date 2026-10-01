// Who owns a Proxmox guest, as bb-box records it on the guest itself: tags,
// and the description, which the clone sets first. Both name the install as
// well as the box (018), so the sweep finds every guest even if bb-box's
// storage is lost, and an install acts only on its own guests. Shared by the
// Proxmox backends.

import type { BoxIdentity, BoxOwner } from "../types.ts";
import { parseTags } from "./api.ts";

export const TAG = "bb-box";
export const INSTALL = "install.";
export const BUILD = "build.";

/** The tag that says which template a guest is a clone of. */
export function templateTag(template: number): string {
  return `template.${template}`;
}

export function templateFromTags(tags: readonly string[]): number | null {
  const vmid = Number(tags.find((tag) => /^template\.\d+$/.test(tag))?.slice(9));
  return Number.isInteger(vmid) && vmid > 0 ? vmid : null;
}

/** The build ID build.sh tags a template with, which its warm guests copy: null without one. */
export function buildFromTags(tags: readonly string[]): string | null {
  return tags.find((tag) => tag.startsWith(BUILD))?.slice(BUILD.length) || null;
}

const tagPattern = /^[a-z0-9_][a-z0-9_+.-]*$/i;

export function installTag(installId: string): string {
  return `${INSTALL}${installId}`;
}

export function installFromTags(tags: readonly string[]): string | null {
  return tags.find((tag) => tag.startsWith(INSTALL))?.slice(INSTALL.length) || null;
}

export function installFromDescription(text: unknown): string | null {
  if (typeof text !== "string" || !text.startsWith("bb-box ")) return null;
  return /^install (\S+)$/m.exec(text)?.[1] ?? null;
}

export function boxTags(box: BoxIdentity, installId: string, template: number | null): string[] {
  const tags = [TAG, installTag(installId), `box.${box.boxId}`, `kind.${box.kind}`, `created.${Math.floor(box.createdAt / 1000)}`];
  if (tagPattern.test(`thread.${box.threadId}`)) tags.splice(2, 0, `thread.${box.threadId}`);
  if (template !== null) tags.push(templateTag(template));
  return tags;
}

/** Written by the clone, before the tags, so an interrupted acquire still names its install and box. */
export function describe(box: BoxIdentity, installId: string): string {
  return [
    `bb-box ${box.name}`,
    `install ${installId}`,
    `box ${box.boxId}`,
    `thread ${box.threadId}`,
    `kind ${box.kind}`,
    `created ${new Date(box.createdAt).toISOString()}`,
  ].join("\n");
}

export function ownerFromTags(tags: readonly string[], name: string | null = null): BoxOwner | null {
  const value = (prefix: string) => tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
  const threadId = value("thread.");
  const boxId = value("box.");
  if (!tags.includes(TAG) || !threadId || !boxId) return null;
  const created = Number(value("created."));
  return {
    boxId,
    threadId,
    name,
    kind: value("kind.") ?? null,
    createdAt: Number.isFinite(created) && created > 0 ? created * 1000 : null,
  };
}

export function ownerFromDescription(text: unknown): BoxOwner | null {
  if (typeof text !== "string" || !text.startsWith("bb-box ")) return null;
  const field = (name: string) => new RegExp(`^${name} (\\S+)$`, "m").exec(text)?.[1];
  const threadId = field("thread");
  const boxId = field("box");
  if (!threadId || !boxId) return null;
  const created = Date.parse(field("created") ?? "");
  return {
    boxId,
    threadId,
    name: field("bb-box") ?? null,
    kind: field("kind") ?? null,
    createdAt: Number.isFinite(created) ? created : null,
  };
}

/** The install and the box a guest's config names, from its tags or, before those are written, its description. */
export function namesOf(config: Record<string, unknown>): { install: string | null; box: string | null } {
  const tags = parseTags(config.tags);
  return {
    install: installFromTags(tags) ?? installFromDescription(config.description),
    box: (ownerFromTags(tags) ?? ownerFromDescription(config.description))?.boxId ?? null,
  };
}

/** Whether a guest's config is a template's. */
export function isTemplate(config: Record<string, unknown>): boolean {
  return config.template === 1 || config.template === "1";
}
