export interface DaemonShare<Placing> {
  readonly daemon: string;
  lock: Promise<unknown>;
  readonly placing: Map<string, Placing>;
  readonly avoided: Map<string, number>;
  readonly backends: Map<string, number>;
}

const SHARES = new Map<string, DaemonShare<unknown>>();

export function daemonShare<Placing>(daemon: string): DaemonShare<Placing> {
  let share = SHARES.get(daemon);
  if (!share) {
    share = { daemon, lock: Promise.resolve(), placing: new Map(), avoided: new Map(), backends: new Map() };
    SHARES.set(daemon, share);
  }
  return share as DaemonShare<Placing>;
}

export function joinDaemon(share: DaemonShare<unknown>, backendId: string): void {
  share.backends.set(backendId, (share.backends.get(backendId) ?? 0) + 1);
}

export function leaveDaemon(share: DaemonShare<unknown>, backendId: string): void {
  const count = (share.backends.get(backendId) ?? 0) - 1;
  if (count > 0) share.backends.set(backendId, count);
  else share.backends.delete(backendId);
}

export function backendPlacingFirst(share: DaemonShare<unknown>): string | null {
  return [...share.backends.keys()].sort()[0] ?? null;
}

export function underDaemonLock<T>(share: DaemonShare<unknown>, work: () => Promise<T>): Promise<T> {
  const done = share.lock.then(work);
  share.lock = done.catch(() => undefined);
  return done;
}
