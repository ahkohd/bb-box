import { absolutePath, childPath } from "../../core/box-fs.ts";
import type { GuestOs } from "../../transports/types.ts";

export function sourcePath(path: string, version: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const sep = slash >= 0 ? path[slash] ?? "/" : "/";
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return `${dir}${sep}${version}${sep}${base}`;
}

export function absoluteFrom(os: GuestOs, root: string, relative: string): string | null {
  let current = absolutePath(os, root);
  if (current === null) return null;
  if (relative === "") return current;
  for (const part of relative.split("/")) {
    if (part === "") continue;
    const next = childPath(os, current, part);
    if (next === null) return null;
    current = next;
  }
  return current;
}
