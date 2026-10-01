// A source of the thread's access in every box that is a BB machine. BB's
// daemon gives GH_TOKEN, the git identity and the machine variables only to
// the processes it starts, and its workers come and go. So before a command,
// bb-box calls its host entry's "access" on the box's machine
// (src/host/access.ts), which keeps a process holding the current values
// below the daemon, for the env file's loader. bb-box calls it again after
// CHECK_MS, which brings any changed value, and at once after a reload, since
// the worker and its process go with the plugin.
//
// Before, bb-box kept a BB terminal titled RETIRED_TITLE for this (#217).
// Each machine's are closed once, after the first call there that works.

/** The title of the BB terminal that held the access before the host entry. */
export const RETIRED_TITLE = "bb-box access";
/** How long bb-box trusts its last call, before calling again. */
const CHECK_MS = 30_000;
/** How long a call may take before the command goes on without it. */
export const CALL_TIMEOUT_MS = 10_000;

/** The parts of BB's terminal API used to close the terminals bb-box no longer keeps. */
export interface RetiredTerminals {
  list(args: { scope: { kind: "host_path"; hostId: string } }): Promise<{ sessions: readonly { id: string; title: string; status: string }[] }>;
  close(args: { terminalId: string; mode: "force" }): Promise<unknown>;
}

export interface HoldersDeps {
  /** Calls the host entry's "access" on machine `hostId`. */
  access(hostId: string, names: readonly string[]): Promise<unknown>;
  readonly terminals: () => RetiredTerminals;
  logError(operation: string, error: unknown): void;
  now?(): number;
}

export class Holders {
  readonly #deps: HoldersDeps;
  /** When bb-box last called each machine, and with which names. */
  readonly #called = new Map<string, { at: number; names: string }>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #retired = new Set<string>();

  constructor(deps: HoldersDeps) {
    this.#deps = deps;
  }

  /**
   * Makes sure machine `hostId` holds the current values of `names`. Never
   * rejects: a failure is logged, and commands then take what BB's workers
   * have.
   */
  ensure(hostId: string, names: readonly string[]): Promise<void> {
    const key = [...names].sort().join(" ");
    const called = this.#called.get(hostId);
    if (called && called.names === key && this.#now() - called.at < CHECK_MS) return Promise.resolve();
    let pending = this.#pending.get(hostId);
    if (!pending) {
      pending = this.#call(hostId, names, key).finally(() => this.#pending.delete(hostId));
      this.#pending.set(hostId, pending);
    }
    return pending;
  }

  /** Forgets a machine whose worker ended, or that is gone, so the next command calls it. */
  forget(hostId: string): void {
    this.#called.delete(hostId);
  }

  async #call(hostId: string, names: readonly string[], key: string): Promise<void> {
    let held = false;
    try {
      await this.#deps.access(hostId, names);
      held = true;
    } catch (error) {
      this.#deps.logError("access holder", error);
    }
    // A failure is tried again after the same wait, not before every command.
    this.#called.set(hostId, { at: this.#now(), names: key });
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
