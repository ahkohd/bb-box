export function activeAfterClose(paths: readonly string[], active: string | null, closed: string): string | null {
  const rest = paths.filter((path) => path !== closed);
  if (active !== closed) return active;
  return rest.at(-1) ?? null;
}
