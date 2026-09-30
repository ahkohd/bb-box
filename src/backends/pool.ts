// Pools of ready machines that no box holds yet: a virtual backend's warm
// pool, or a real backend's configured machines. ReadyPool picks a free
// member that can serve a kind and makes sure one box holds a member at a
// time. Where membership lives is the backend's choice, through a PoolStore:
// Proxmox LXC keeps it in guest tags, and real backends use KvPoolStore.

import type { BackendStorage } from "./types.ts";

export interface PoolMember {
  readonly ref: string;
  readonly address: string | null;
  /** The kinds this member can serve. */
  readonly kinds: readonly string[];
  /** False while the member is held, being prepared or reset, or out of service. */
  readonly free: boolean;
}

export interface PoolStore<Holder> {
  members(signal?: AbortSignal): Promise<PoolMember[]>;
  /** Marks a free member as held. It is no longer free once this resolves. */
  hold(member: PoolMember, holder: Holder, signal?: AbortSignal): Promise<void>;
}

export class ReadyPool<Holder> {
  readonly #store: PoolStore<Holder>;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: PoolStore<Holder>) {
    this.#store = store;
  }

  /**
   * Holds a free member for `kind`, or returns null when none is free.
   * `before` runs first, so the caller can record the member before it changes.
   * Claims are serialised, so two boxes never get the same member.
   */
  claim(
    kind: string,
    holder: Holder,
    options: { before?(member: PoolMember): Promise<void>; signal?: AbortSignal } = {},
  ): Promise<PoolMember | null> {
    return this.exclusive(async () => {
      for (const member of await this.#store.members(options.signal)) {
        if (!member.free || !member.kinds.includes(kind)) continue;
        await options.before?.(member);
        await this.#store.hold(member, holder, options.signal);
        return { ...member, free: false };
      }
      return null;
    });
  }

  /** Runs `task` with no claim in progress, for example to take members out of the pool. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Free and total members that can serve `kind`. */
  async count(kind: string, signal?: AbortSignal): Promise<{ free: number; total: number }> {
    const members = (await this.#store.members(signal)).filter((member) => member.kinds.includes(kind));
    return { free: members.filter((member) => member.free).length, total: members.length };
  }
}

/** A machine a real backend lends, as its settings describe it. */
export interface PoolMachine {
  readonly ref: string;
  readonly address: string | null;
  readonly kinds: readonly string[];
}

export type MachineState<Holder> =
  | { readonly state: "held"; readonly holder: Holder; readonly since: number }
  | { readonly state: "resetting"; readonly since: number }
  | { readonly state: "out-of-service"; readonly reason: string; readonly since: number };

/**
 * Membership of a fixed set of real machines, kept in backend storage. A
 * machine with no stored state is free. Release moves it through resetting
 * back to free, or out of service when the reset fails.
 */
export class KvPoolStore<Holder> implements PoolStore<Holder> {
  readonly #storage: BackendStorage;
  readonly #machines: () => readonly PoolMachine[];
  readonly #now: () => number;

  constructor(storage: BackendStorage, machines: () => readonly PoolMachine[], now: () => number = Date.now) {
    this.#storage = storage;
    this.#machines = machines;
    this.#now = now;
  }

  #key(ref: string): string {
    return `machine/${ref}`;
  }

  state(ref: string): Promise<MachineState<Holder> | undefined> {
    return this.#storage.get<MachineState<Holder>>(this.#key(ref));
  }

  async members(): Promise<PoolMember[]> {
    return Promise.all(
      this.#machines().map(async (machine) => ({ ...machine, free: !(await this.state(machine.ref)) })),
    );
  }

  async hold(member: PoolMember, holder: Holder): Promise<void> {
    await this.#storage.set(this.#key(member.ref), { state: "held", holder, since: this.#now() });
  }

  async resetting(ref: string): Promise<void> {
    await this.#storage.set(this.#key(ref), { state: "resetting", since: this.#now() });
  }

  async outOfService(ref: string, reason: string): Promise<void> {
    await this.#storage.set(this.#key(ref), { state: "out-of-service", reason, since: this.#now() });
  }

  /** Returns a machine to the pool. */
  async free(ref: string): Promise<void> {
    await this.#storage.delete(this.#key(ref));
  }
}
