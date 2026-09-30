// Pools of ready machines that no box holds yet: a virtual backend's warm
// pool, or a real backend's configured machines. ReadyPool picks a free
// member that can serve a kind and makes sure one box holds a member at a
// time. Where membership lives is the backend's choice, through a PoolStore:
// Proxmox LXC keeps it in guest tags, and real backends use KvPoolStore. A
// store must not assume a guest's labels or tags can change after creation;
// Docker, for example, holds a warm container by renaming it.

import type { BackendStorage, PoolMember } from "./types.ts";

export interface PoolStore<Holder> {
  members(signal?: AbortSignal): Promise<readonly PoolMember[]>;
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
        if (member.state !== "free" || !member.kinds.includes(kind)) continue;
        await options.before?.(member);
        await this.#store.hold(member, holder, options.signal);
        return { ...member, state: "held" };
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
    return { free: members.filter((member) => member.state === "free").length, total: members.length };
  }
}

/** A machine a real backend lends, as its settings describe it. */
export interface PoolMachine {
  readonly ref: string;
  readonly host: string | null;
  readonly address: string | null;
  readonly kinds: readonly string[];
}

export type MachineState<Holder> = { readonly since: number; readonly generation: number } & (
  | { readonly state: "free" }
  | { readonly state: "held"; readonly holder: Holder }
  | { readonly state: "resetting" }
  | { readonly state: "out-of-service"; readonly reason: string }
);

/**
 * Membership of a fixed set of real machines, kept in backend storage. A
 * machine with no stored state is free, at generation 0. Release moves it
 * through resetting back to free with the next generation, or out of service
 * when the reset fails.
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

  async state(ref: string): Promise<MachineState<Holder>> {
    return (await this.#storage.get<MachineState<Holder>>(this.#key(ref))) ?? { state: "free", since: 0, generation: 0 };
  }

  async members(): Promise<PoolMember[]> {
    return Promise.all(
      this.#machines().map(async (machine) => {
        const state = await this.state(machine.ref);
        return {
          ref: machine.ref,
          host: machine.host,
          kinds: machine.kinds,
          state: state.state,
          reason: state.state === "out-of-service" ? state.reason : null,
          since: state.since,
          generation: state.generation,
        };
      }),
    );
  }

  async hold(member: PoolMember, holder: Holder): Promise<void> {
    await this.#set(member.ref, { state: "held", holder });
  }

  async resetting(ref: string): Promise<void> {
    await this.#set(ref, { state: "resetting" });
  }

  async outOfService(ref: string, reason: string): Promise<void> {
    await this.#set(ref, { state: "out-of-service", reason });
  }

  /** Returns a reset machine to the pool with the next generation, which it returns. */
  async free(ref: string): Promise<number> {
    const generation = (await this.state(ref)).generation + 1;
    await this.#storage.set(this.#key(ref), { state: "free", since: this.#now(), generation } satisfies MachineState<Holder>);
    return generation;
  }

  /** Puts back a machine the operator has fixed, keeping its generation. */
  async returnToService(ref: string): Promise<void> {
    const current = await this.state(ref);
    if (current.state !== "out-of-service") return;
    await this.#set(ref, { state: "free" });
  }

  async #set(
    ref: string,
    state: { state: "free" } | { state: "held"; holder: Holder } | { state: "resetting" } | { state: "out-of-service"; reason: string },
  ): Promise<void> {
    const { generation } = await this.state(ref);
    await this.#storage.set(this.#key(ref), { ...state, since: this.#now(), generation });
  }
}
