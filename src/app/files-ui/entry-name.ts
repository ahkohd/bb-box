export function entryName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "." || trimmed === ".." || /[/\\\0]/.test(trimmed)) return null;
  return trimmed;
}

export function createdPath(parent: string, name: string): string | null {
  const safe = entryName(name);
  if (safe === null) return null;
  return parent === "" ? safe : `${parent}/${safe}`;
}

export function renamedPath(path: string, name: string): string | null {
  const safe = entryName(name);
  if (safe === null) return null;
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  return parent === "" ? safe : `${parent}/${safe}`;
}

export function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  const prefix = `${from}/`;
  if (path.startsWith(prefix)) return `${to}/${path.slice(prefix.length)}`;
  return null;
}
