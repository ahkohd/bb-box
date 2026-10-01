// A source of the thread's access in every box that is a BB machine. BB's
// daemon gives GH_TOKEN, the git identity and the machine variables only to
// the processes it starts, and its workers come and go. So before a box's
// first command, bb-box calls its host entry's "access" on the box's machine
// (src/host/access.ts), which keeps a process holding the current values
// below the daemon, for the env file's loader. bb-box calls it again after
// CHECK_MS, which brings any changed value, or after RETRY_MS while a call
// brings no GH_TOKEN, in the background: commands take the values held
// meanwhile. A command waits for the call only when nothing holds its names
// yet: on a new machine, for other names, or after a reload, since the
// worker and its process go with the plugin.
//
// Before, bb-box kept a BB terminal titled RETIRED_TITLE for this (#217).
// Each machine's are closed once, after the first call there that works.

/** The title of the BB terminal that held the access before the host entry. */
export const RETIRED_TITLE = "bb-box access";
/** How long bb-box trusts its last call, before calling again. */
const CHECK_MS = 30_000;
/**
 * How soon a call that failed is made again. A new box's first commands run
 * as BB shows its machine connected, and a call a moment too early fails;
 * BB's own workers carry the variables meanwhile.
 */
const RETRY_MS = 2_000;
/** BB's answer for a machine whose daemon has not connected yet, or is away. */
const NOT_CONNECTED = /not connected/i;
/** How long a call may take before the command goes on without it. */
export const CALL_TIMEOUT_MS = 10_000;

/** The parts of BB's terminal API used to close the terminals bb-box no longer keeps. */
export interface RetiredTerminals {
  list(args: { scope: { kind: "host_path"; hostId: string } }): Promise<{ sessions: readonly { id: string; title: string; status: string }[] }>;
  close(args: { terminalId: string; mode: "force" }): Promise<unknown>;
}

/** Names the holder asks again for soon when its call did not bring them: git needs GH_TOKEN. */
const AWAITED = ["GH_TOKEN"];

export interface HoldersDeps {
  /** Calls the host entry's "access" on machine `hostId`. It says which names the call did not bring. */
  access(hostId: string, names: readonly string[]): Promise<{ readonly missing?: readonly string[] } | void>;
  readonly terminals: () => RetiredTerminals;
  logError(operation: string, error: unknown): void;
  /** A line for the plugin's log that is not an error. */
  log?(message: string): void;
  now?(): number;
}

export class Holders {
  readonly #deps: HoldersDeps;
  /** Until when bb-box trusts its last call on each machine, and with which names. */
  readonly #called = new Map<string, { until: number; names: string }>();
  /** The names a process holds on each machine, from a call that worked until its worker ends. */
  readonly #held = new Map<string, string>();
  readonly #pending = new Map<string, { names: string; done: Promise<void> }>();
  readonly #retired = new Set<string>();
  /** Machines bb-box said were not connected yet, until a call there works. */
  readonly #unconnected = new Set<string>();

  constructor(deps: HoldersDeps) {
    this.#deps = deps;
  }

  /**
   * Makes sure machine `hostId` holds values of `names`, at most CHECK_MS
   * and a call old. Never rejects: a failure is logged, and commands then
   * take what BB's workers have.
   */
  ensure(hostId: string, names: readonly string[]): Promise<void> {
    const key = [...names].sort().join(" ");
    const called = this.#called.get(hostId);
    if (called && called.names === key && this.#now() < called.until) return Promise.resolve();
    const pending = this.#pending.get(hostId);
    // One call at a time on a machine: one for other names is waited for, then this one made.
    if (pending && pending.names !== key) return pending.done.then(() => this.ensure(hostId, names));
    let done = pending?.done;
    if (!done) {
      done = this.#call(hostId, names, key).finally(() => this.#pending.delete(hostId));
      this.#pending.set(hostId, { names: key, done });
    }
    return this.#held.get(hostId) === key ? Promise.resolve() : done;
  }

  /** Forgets a machine whose worker ended, or that is gone, so the next command calls it. */
  forget(hostId: string): void {
    this.#called.delete(hostId);
    this.#held.delete(hostId);
  }

  async #call(hostId: string, names: readonly string[], key: string): Promise<void> {
    let held = false;
    let complete = true;
    try {
      const answer = await this.#deps.access(hostId, names);
      held = true;
      this.#held.set(hostId, key);
      // BB gave the machine some variables but not yet GH_TOKEN, as on a new machine: ask again soon.
      complete = !AWAITED.some((name) => names.includes(name) && answer?.missing?.includes(name));
      this.#unconnected.delete(hostId);
    } catch (error) {
      if (!(error instanceof Error && NOT_CONNECTED.test(error.message))) this.#deps.logError("access holder", error);
      else if (!this.#unconnected.has(hostId)) {
        this.#unconnected.add(hostId);
        this.#deps.log?.(`BB's machine ${hostId} was not connected yet for bb-box's access holder, which commands call again until it is.`);
      }
    }
    // A failure is tried again soon, not before every command.
    this.#called.set(hostId, { until: this.#now() + (held && complete ? CHECK_MS : RETRY_MS), names: key });
    // Only once the host entry holds them, so a box never loses its last source.
    if (held && !this.#retired.has(hostId)) {
      this.#retired.add(hostId);
      void this.#retire(hostId);
    }
  }

  async #retire(hostId: string): Promise<void> {
    try {
      const terminals = this.#deps.terminals();
      const { sessions } = await terminals.list({ scope: { kind: "host_path", hostId } });
      for (const session of sessions) {
        if (session.title !== RETIRED_TITLE || session.status === "exited") continue;
        await terminals.close({ terminalId: session.id, mode: "force" });
      }
    } catch (error) {
      this.#deps.logError("access holder", error);
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}
