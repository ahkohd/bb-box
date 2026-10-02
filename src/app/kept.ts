// Connections the panel keeps across tab switches (037). BB remounts a panel
// tab when a person switches tabs, and the SDK has no way to keep a tab
// mounted, so the desktop's noVNC client and canvas and the terminal's xterm
// and socket live here, in the app bundle, keyed by box and viewer or
// session. A tab claims its session on mount, puts the session's element in
// its own, and gives it back on unmount, where it rests hidden for ten
// minutes before it is closed. A session that ends while hidden is dropped
// at once. One box can show in two places at once (the Boxes page and a
// thread's panel, or two threads' panels); the second place gets a session
// of its own rather than taking the first's.

export interface Kept {
  /** The element the session draws in; a tab puts it inside its own. */
  readonly element: HTMLElement;
  /** No tab shows it now. A session that ends while hidden calls `onEnded`. */
  hidden: boolean;
  onEnded?: () => void;
  dispose(): void;
}

interface Entry {
  readonly kept: Kept;
  inUse: boolean;
  expiry?: ReturnType<typeof setTimeout>;
  handBack?: ReturnType<typeof setTimeout>;
}

/** How long a hidden session is kept before it is closed. */
export const HIDDEN_MS = 10 * 60_000;
/** How long a hidden tab may hold a desktop's control: the same as a closed viewer gets (008). */
export const HAND_BACK_MS = 60_000;

const entries = new Map<string, Entry>();

function drop(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  clearTimeout(entry.expiry);
  clearTimeout(entry.handBack);
  entry.kept.dispose();
}

/**
 * The session kept under `key`, made with `make` when there is none, or a
 * private one when the kept one is on screen elsewhere. `kept` says which:
 * a kept session is given back with `releaseKept`; a private one is the
 * caller's to dispose.
 */
export function claimKept<K extends Kept>(key: string, make: () => K): { readonly session: K; readonly kept: boolean } {
  const entry = entries.get(key);
  if (entry && !entry.inUse) {
    entry.inUse = true;
    clearTimeout(entry.expiry);
    clearTimeout(entry.handBack);
    entry.expiry = undefined;
    entry.handBack = undefined;
    entry.kept.hidden = false;
    return { session: entry.kept as K, kept: true };
  }
  if (entry) return { session: make(), kept: false };
  const session = make();
  session.hidden = false;
  session.onEnded = () => {
    const current = entries.get(key);
    if (current?.kept === session && !current.inUse) drop(key);
  };
  entries.set(key, { kept: session, inUse: true });
  return { session, kept: true };
}

/** The tab went; the session rests hidden, and `handBack` runs after a minute unless a tab claims it first. */
export function releaseKept(key: string, options: { handBack?: () => Promise<void> } = {}): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.inUse = false;
  entry.kept.hidden = true;
  entry.expiry = setTimeout(() => drop(key), HIDDEN_MS);
  if (options.handBack) {
    const handBack = options.handBack;
    entry.handBack = setTimeout(() => void handBack().catch(() => {}), HAND_BACK_MS);
  }
}

/** Closes the session kept under `key` now: the box stopped or went, or the person asked for a new one. */
export function dropKept(key: string): void {
  drop(key);
}

/** The session kept under `key`, when no tab shows it: a tab can take it before its box's state loads. */
export function keptFree<K extends Kept>(key: string): K | undefined {
  const entry = entries.get(key);
  return entry && !entry.inUse ? (entry.kept as K) : undefined;
}

/** The session kept under `key`, for tests. */
export function keptUnder(key: string): Kept | undefined {
  return entries.get(key)?.kept;
}

/** Closes every kept session, for tests. */
export function dropAllKept(): void {
  for (const key of [...entries.keys()]) drop(key);
}
