// Files for every box (#455): a short list in the general settings, each a
// path under the box user's home and its content, such as pi's
// .pi/agent/models.json, which BB does not carry to a machine. bb-box writes
// each into every Linux and macOS box as it joins BB, and into running boxes
// when the list changes. A content can hold an API key, so it is a secret:
// write-only, kept with the backends' secrets, and never in a log, an error,
// a box record or a tool's output. Only the paths are in the document.

import type { SecretState, Secrets } from "./document.ts";

/** Where the files' contents are kept among the secrets, beside each backend's: no backend ID starts with "@". */
export const GENERAL_SECRETS = "@general";
export const MAX_BOX_FILES = 20;
export const MAX_BOX_FILE_BYTES = 1024 * 1024;

/** A file in the general settings: its path, and as stored or exported, whether its content is set. */
export interface BoxFileSetting {
  readonly path: string;
  /** Stored documents leave it out. In a draft, a string sets it, null clears it, and { set: true } keeps it. */
  readonly content?: SecretState | string | null;
}

/** A file with its content, to write. */
export interface BoxFile {
  readonly path: string;
  readonly content: string;
}

/** The key of a file's content among the general secrets. */
export function contentKey(path: string): string {
  return `file:${path}`;
}

const SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/;

/** Why a path is not one of a file under the box user's home, or null when it is. */
export function pathProblem(path: string): string | null {
  if (!path) return "Give the file's path under the box user's home, such as .pi/agent/models.json.";
  if (path.length > 200) return "A file's path is at most 200 characters.";
  if (path.startsWith("/") || path.startsWith("~")) return `"${path}" is not under the box user's home: give it from there, such as .pi/agent/models.json.`;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || !SEGMENT.test(segment.replace(/^\./, "a")))) {
    return `"${path}" is not a plain path: use letters, digits, ".", "_", "-", "+" and "@", folders separated by "/", and no "." or ".." folder.`;
  }
  return null;
}

/** The files whose content is set, in the settings' order. */
export function boxFiles(settings: readonly BoxFileSetting[] | undefined, secrets: Secrets): BoxFile[] {
  const stored = secrets[GENERAL_SECRETS] ?? {};
  return (settings ?? []).flatMap((file) => {
    const content = stored[contentKey(file.path)];
    return content === undefined ? [] : [{ path: file.path, content }];
  });
}
