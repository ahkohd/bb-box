// A source of the thread's access in every box that is a BB machine. BB's
// daemon gives GH_TOKEN, the git identity and the machine variables only to
// the processes it starts: its workers, which BB starts and stops as it
// pleases (a plugin reload stops them, and nothing starts them again), and
// threads and terminals. So bb-box keeps a BB terminal on the box running
// `sleep`, titled KEEPER_TITLE. Its process is below the daemon and carries
// the variables as they were when it started, for the env file's loader,
// which prefers the newest process with the most of them. A keeper older
// than KEEPER_MAX_AGE_MS is replaced, so a changed value arrives within that
// time even with no newer worker.

export const KEEPER_TITLE = "bb-box access";
export const KEEPER_COMMAND = "sleep 2147483647";
/** How long a keeper is used before a new one replaces it. */
export const KEEPER_MAX_AGE_MS = 10 * 60_000;
/** How long bb-box trusts what it last found, before asking BB again. */
const CHECK_MS = 30_000;
/** How long a new keeper may take to start before the command goes on without it. */
const START_WAIT_MS = 2_000;
const START_POLL_MS = 50;

interface Session {
  readonly id: string;
  readonly title: string;
  readonly status: "starting" | "running" | "exited" | "disconnected";
  readonly createdAt: number;
}

/** The parts of BB's terminal API a keeper uses. */
export interface KeeperTerminals {
  list(args: { scope: { kind: "host_path"; hostId: string } }): Promise<{ sessions: readonly Session[] }>;
  create(args: {
    cols: number;
    rows: number;
    scope: { kind: "host_path"; hostId: string; cwd: null };
    start: { mode: "command"; command: string };
    title: string;
  }): Promise<Session>;
  get(args: { terminalId: string }): Promise<Session>;
  close(args: { terminalId: string; mode: "force" }): Promise<unknown>;
}

export interface KeepersDeps {
  readonly terminals: () => KeeperTerminals;
  logError(operation: string, error: unknown): void;
  now?(): number;
}

const live = (session: Session) => session.status === "starting" || session.status === "running";

export class Keepers {
  readonly #deps: KeepersDeps;
  /** When bb-box last found each machine's keeper, or failed to. */
  readonly #checked = new Map<string, { at: number; createdAt: number | null }>();
  readonly #pending = new Map<string, Promise<void>>();

  constructor(deps: KeepersDeps) {
    this.#deps = deps;
  }

  /**
   * Makes sure machine `hostId` has a keeper that is not too old, waiting a
   * moment for a new one to start. Never rejects: a failure is logged, and
   * commands then take what BB's workers have.
   */
  ensure(hostId: string): Promise<void> {
    const now = this.#now();
    const checked = this.#checked.get(hostId);
    if (checked && now - checked.at < CHECK_MS && (checked.createdAt === null || now - checked.createdAt < KEEPER_MAX_AGE_MS)) {
      return Promise.resolve();
    }
    let pending = this.#pending.get(hostId);
    if (!pending) {
      pending = this.#ensure(hostId)
        .catch((error) => {
          this.#checked.set(hostId, { at: this.#now(), createdAt: null });
          this.#deps.logError("access keeper", error);
        })
        .finally(() => this.#pending.delete(hostId));
      this.#pending.set(hostId, pending);
    }
    return pending;
  }

  /** Forgets a machine that is gone. Its terminals went with it. */
  forget(hostId: string): void {
    this.#checked.delete(hostId);
  }

  async #ensure(hostId: string): Promise<void> {
    const terminals = this.#deps.terminals();
    const keepers = (await terminals.list({ scope: { kind: "host_path", hostId } })).sessions
      .filter((session) => session.title === KEEPER_TITLE && live(session))
      .sort((a, b) => b.createdAt - a.createdAt);
    const now = this.#now();
    let keeper: Session | undefined = keepers[0];
    let old = keepers.slice(1);
    if (keeper && now - keeper.createdAt >= KEEPER_MAX_AGE_MS) {
      old = keepers;
      keeper = undefined;
    }
    if (!keeper) {
      keeper = await terminals.create({
        cols: 80,
        rows: 24,
        scope: { kind: "host_path", hostId, cwd: null },
        start: { mode: "command", command: KEEPER_COMMAND },
        title: KEEPER_TITLE,
      });
      keeper = await this.#started(terminals, keeper);
    }
    this.#checked.set(hostId, { at: this.#now(), createdAt: keeper.createdAt });
    // The new one runs first, so commands always have one.
    for (const session of old) await terminals.close({ terminalId: session.id, mode: "force" }).catch((error) => this.#deps.logError("access keeper", error));
  }

  async #started(terminals: KeeperTerminals, session: Session): Promise<Session> {
    const deadline = this.#now() + START_WAIT_MS;
    while (session.status === "starting" && this.#now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
      session = await terminals.get({ terminalId: session.id });
    }
    return session;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}
