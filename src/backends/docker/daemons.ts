export interface DaemonMember {
  readonly instances: number;
  readonly on: () => boolean;
  readonly daemon: () => string;
  readonly daemonNow: (signal?: AbortSignal) => Promise<string>;
}

export interface DaemonShare<Placing> {
  readonly daemon: string;
  lock: Promise<unknown>;
  readonly placing: Map<string, Placing>;
  readonly avoided: Map<string, number>;
  readonly backends: Map<string, DaemonMember>;
}

const SHARES = new Map<string, DaemonShare<unknown>>();

export interface DaemonFacts {
  readonly id: string;
  readonly name: string;
  readonly rootDir: string;
}

export function daemonKey(facts: DaemonFacts, fallback: string): string {
  return facts.id ? `daemon:${facts.id}|${facts.name}|${facts.rootDir}` : `host:${fallback}`;
}

export function engineKey(facts: DaemonFacts, fallback: string): string {
  return facts.id ? `engine:${facts.id}` : `host:${fallback}`;
}

export function daemonShare<Placing>(daemon: string): DaemonShare<Placing> {
  let share = SHARES.get(daemon);
  if (!share) {
    share = { daemon, lock: Promise.resolve(), placing: new Map(), avoided: new Map(), backends: new Map() };
    SHARES.set(daemon, share);
  }
  return share as DaemonShare<Placing>;
}

export function joinDaemon(share: DaemonShare<unknown>, backendId: string, member: Omit<DaemonMember, "instances">): void {
  share.backends.set(backendId, { instances: (share.backends.get(backendId)?.instances ?? 0) + 1, ...member });
}

export function leaveDaemon(share: DaemonShare<unknown>, backendId: string): void {
  const member = share.backends.get(backendId);
  if (!member) return;
  if (member.instances > 1) share.backends.set(backendId, { ...member, instances: member.instances - 1 });
  else share.backends.delete(backendId);
}

export function backendsOn(share: DaemonShare<unknown>, daemon: string): string[] {
  return [...share.backends].filter(([, member]) => member.on() && member.daemon() === daemon).map(([id]) => id).sort();
}

export function underDaemonLock<T>(share: DaemonShare<unknown>, work: () => Promise<T>): Promise<T> {
  const done = share.lock.then(work);
  share.lock = done.catch(() => undefined);
  return done;
}
