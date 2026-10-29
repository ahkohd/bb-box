/** Where the setup guides and scripts are read, as pages. */
export const REPOSITORY_URL = "https://github.com/moonstead/bb-box/blob/main";

/**
 * The name in a backend's ID, as a second backend of a type has ("microsandbox:mac-mini"), for a chip beside its label;
 * null when it has none, or its label already says it ("microsandbox on mac-mini").
 */
export function backendName(id: string, label: string): string | null {
  const named = id.includes(":") ? id.slice(id.indexOf(":") + 1) : null;
  return named && !label.toLowerCase().includes(named.toLowerCase()) ? named : null;
}
