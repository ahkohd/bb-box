// Who controls each desktop box's input: the agent (the default), a person
// in one viewer, or nobody while control changes hands. It lives in memory,
// and each person's control is also kept in plugin storage, so after a
// restart of the plugin their viewer keeps it if it connects again (045).
// It is read again as the first viewer connects after the restart, for what
// changed in the last instance after this one started (#318).
// The relay asks mayInput for every input message it passes.

import type { Size } from "./relay.ts";
import type { Screen } from "./rfb.ts";

export type Owner = "agent" | "human" | "none";

export interface ControlView {
  readonly owner: Owner;
  /** The viewer that holds control, while a person holds it. */
  readonly holder: string | null;
  /** The viewer the agent took control back from (038), until a person takes it again. */
  readonly takenFrom?: string;
}

/** A person's control of a box's desktop, kept in plugin storage for the plugin's next start (045). */
export interface KeptControl {
  readonly boxId: string;
  readonly holder: string;
  /** The desktop's size while the agent had control. */
  readonly size: Size | null;
  /** The screen of the holder's last resize. */
  readonly resized: Screen | null;
}

/** One viewer's connection to a box's desktop. */
export interface ViewerConnection {
  readonly viewer: string;
  /** Releases the keys and buttons the viewer holds down in the box. */
  release(): Promise<void>;
}

export interface ControlDeps {
  /** Control of the box changed, so its panel should show it. */
  changed(boxId: string): void;
  /** Sets the box's desktop back to the size it had, over a connection of its own. */
  restore(boxId: string, size: Size, screen: Screen): Promise<void>;
  /** Stops the agent's input before a person takes control. It fails the take by throwing. */
  pause?(boxId: string): Promise<void>;
  /** Stores each person's control, after every change, for the plugin's next start (045). It fails by throwing. */
  keep?(kept: readonly KeptControl[]): Promise<void>;
  /** Reads each person's control as last stored, by this instance or the last one (#318). */
  read?(): Promise<readonly KeptControl[]>;
  /** bb-box is stopping while a person has control of the box, so the log can say whether it stays theirs or goes back to the agent. */
  stopping?(boxId: string, kept: boolean): Promise<void>;
  logError(operation: string, error: unknown): void;
  /** How long a holder's viewer may be gone before control goes back to the agent. */
  readonly staleMs?: number;
  /** How long a holder's viewer has to connect again after the box ended its connection. */
  readonly reconnectMs?: number;
}

export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

interface BoxControl {
  owner: Owner;
  holder: string | null;
  readonly connections: Set<ViewerConnection>;
  stale: ReturnType<typeof setTimeout> | null;
  /** The desktop's size while the agent has control. */
  size: Size | null;
  /** The screen of the holder's last resize, until the size is restored. */
  resized: Screen | null;
  /** Takes and hand-backs run one at a time. */
  queue: Promise<unknown>;
  takenFrom: string | null;
}

export const STALE_MS = 60_000;
/** The viewer tries again after 1 s, then 2 s more, so two tries fit. */
export const RECONNECT_MS = 5_000;
const AGENT: ControlView = { owner: "agent", holder: null };

export class Control {
  readonly #deps: ControlDeps;
  readonly #boxes = new Map<string, BoxControl>();
  #disposed = false;
  /** The latest store of each person's control, and whether it worked. */
  #stored: Promise<boolean> = Promise.resolve(true);
  /** Whether a viewer has connected since this instance started, which read each person's control again (#318). */
  #reread = false;

  constructor(deps: ControlDeps) {
    this.#deps = deps;
  }

  #box(boxId: string): BoxControl {
    let state = this.#boxes.get(boxId);
    if (!state) {
      state = { owner: "agent", holder: null, connections: new Set(), stale: null, size: null, resized: null, queue: Promise.resolve(), takenFrom: null };
      this.#boxes.set(boxId, state);
    }
    return state;
  }

  view(boxId: string): ControlView {
    const state = this.#boxes.get(boxId);
    if (!state) return AGENT;
    return state.takenFrom ? { owner: state.owner, holder: state.holder, takenFrom: state.takenFrom } : { owner: state.owner, holder: state.holder };
  }

  mayInput(boxId: string, viewer: string): boolean {
    const state = this.#boxes.get(boxId);
    return state?.owner === "human" && state.holder === viewer;
  }

  /** Whether a viewer has a connection open to the box's desktop. */
  connected(boxId: string, viewer: string): boolean {
    return [...(this.#boxes.get(boxId)?.connections ?? [])].some((connection) => connection.viewer === viewer);
  }

  attach(boxId: string, connection: ViewerConnection): void {
    const state = this.#box(boxId);
    state.connections.add(connection);
    if (state.holder === connection.viewer && state.stale) {
      clearTimeout(state.stale);
      state.stale = null;
    }
    if (this.#deps.read && !this.#reread) {
      this.#reread = true;
      void this.#readAgain().catch((error) => this.#deps.logError("read kept control", error));
    }
  }

  /**
   * Each person's control as last stored, read again as the first viewer
   * connects after a restart (#318). The last instance stores until it
   * stops, after this one started, so a person may have taken control there
   * or handed it back. Viewers connect again once it has stopped, so its
   * last store is read, for every box at once: this instance's next store
   * holds every box.
   */
  async #readAgain(): Promise<void> {
    const kept = await this.#deps.read!();
    if (this.#disposed) return;
    const boxIds = new Set([...this.#boxes.keys(), ...kept.map((each) => each.boxId)]);
    await Promise.all(
      [...boxIds].map((boxId) => {
        const state = this.#box(boxId);
        return this.#serial(state, async () => this.#settle(boxId, state, kept.find((each) => each.boxId === boxId)));
      }),
    );
  }

  /** A box's control as read again. A hand-back in the last instance set the desktop's size back. */
  #settle(boxId: string, state: BoxControl, kept: KeptControl | undefined): void {
    if (kept) {
      state.size = kept.size;
      state.resized = kept.resized;
      if (state.owner === "human" && state.holder === kept.holder) return;
      this.#set(boxId, state, "human", kept.holder);
      if (!this.connected(boxId, kept.holder)) this.#wait(boxId, state, this.#deps.staleMs ?? STALE_MS);
      else if (state.stale) {
        clearTimeout(state.stale);
        state.stale = null;
      }
    } else if (state.owner === "human") {
      if (state.stale) clearTimeout(state.stale);
      state.stale = null;
      state.resized = null;
      this.#set(boxId, state, "agent", null);
    }
  }

  /**
   * A connection ended. When the holder has none left, control goes back to
   * the agent unless the viewer connects again: within reconnectMs if the box
   * ended it, as the viewer tries again by itself, or staleMs if the viewer
   * went away.
   */
  detach(boxId: string, connection: ViewerConnection, by: "viewer" | "box"): void {
    const state = this.#boxes.get(boxId);
    if (!state?.connections.delete(connection)) return;
    if (this.#disposed || state.owner !== "human" || state.holder !== connection.viewer || this.connected(boxId, connection.viewer)) return;
    this.#wait(boxId, state, by === "box" ? (this.#deps.reconnectMs ?? RECONNECT_MS) : (this.#deps.staleMs ?? STALE_MS));
  }

  /** Control goes back to the agent after `ms`, unless the holder's viewer connects again first. */
  #wait(boxId: string, state: BoxControl, ms: number): void {
    if (state.stale) clearTimeout(state.stale);
    state.stale = setTimeout(() => {
      state.stale = null;
      void this.handBack(boxId).catch((error) => this.#deps.logError("hand back", error));
    }, ms);
    state.stale.unref?.();
  }

  /**
   * Control people had as the plugin's last instance stopped (045). Each
   * holder's viewer has staleMs to connect again, as a viewer that went away
   * has: BB starts this instance before it stops the last one, which closes
   * the viewer's connection. If it does not, control goes back to the agent,
   * and the desktop gets back the size it had while the agent had control.
   */
  resume(kept: readonly KeptControl[]): void {
    // A viewer connected since this start, which read it again.
    if (this.#disposed || this.#reread) return;
    for (const { boxId, holder, size, resized } of kept) {
      const state = this.#box(boxId);
      // A person took control since this start.
      if (state.owner !== "agent") continue;
      state.size = size;
      state.resized = resized;
      this.#set(boxId, state, "human", holder);
      if (!this.connected(boxId, holder)) this.#wait(boxId, state, this.#deps.staleMs ?? STALE_MS);
    }
    // What was left out, such as a box that went while bb-box was away, is not kept again.
    this.#store();
  }

  /**
   * Stores each person's control, latest last. It is stored on every change,
   * not as the plugin stops, because BB starts the next instance first. A
   * stopped instance stores nothing, so it never overwrites the next one's.
   */
  #store(): void {
    const keep = this.#deps.keep;
    if (!keep || this.#disposed) return;
    const kept: KeptControl[] = [];
    for (const [boxId, state] of this.#boxes) {
      if (state.owner === "human" && state.holder) kept.push({ boxId, holder: state.holder, size: state.size, resized: state.resized });
    }
    this.#stored = this.#stored.then(() =>
      keep(kept).then(
        () => true,
        (error) => {
          this.#deps.logError("keep control", error);
          return false;
        },
      ),
    );
  }

  /** The desktop's size as a viewer joined. Kept while the agent has control, as the size to restore. */
  seen(boxId: string, size: Size): void {
    const state = this.#box(boxId);
    if (state.owner === "agent" && !state.resized) state.size = size;
  }

  /** A resize the relay passed from the holder. */
  resized(boxId: string, viewer: string, screen: Screen | null): void {
    const state = this.#boxes.get(boxId);
    if (!state || state.holder !== viewer || !screen) return;
    state.resized = screen;
    this.#store();
  }

  #serial<T>(state: BoxControl, task: () => Promise<T>): Promise<T> {
    const run = state.queue.then(task, task);
    state.queue = run.catch(() => undefined);
    return run;
  }

  #set(boxId: string, state: BoxControl, owner: Owner, holder: string | null, takenFrom: string | null = null): void {
    if (state.owner === owner && state.holder === holder && state.takenFrom === takenFrom) return;
    state.owner = owner;
    state.holder = holder;
    state.takenFrom = takenFrom;
    this.#deps.changed(boxId);
    this.#store();
  }

  async #release(state: BoxControl, viewer: string): Promise<void> {
    for (const connection of state.connections) {
      if (connection.viewer !== viewer) continue;
      await connection.release().catch((error) => this.#deps.logError("release held input", error));
    }
  }

  /** Gives control to a person in `viewer`, which must be connected to the box's desktop. */
  take(boxId: string, viewer: string): Promise<ControlView> {
    const state = this.#box(boxId);
    return this.#serial(state, async () => {
      if (state.owner === "human" && state.holder === viewer) return this.view(boxId);
      if (!this.connected(boxId, viewer)) {
        throw new ControlError("This viewer is not connected to the box's desktop, so it cannot take control. Wait for the desktop to show, then try again.");
      }
      // Another viewer of yours had it: its input stops, then what it holds
      // down is let go, so no key goes down after its release.
      const previous = state.owner === "human" ? state.holder : null;
      this.#set(boxId, state, "none", null);
      if (previous) await this.#release(state, previous);
      try {
        await this.#deps.pause?.(boxId);
      } catch (error) {
        this.#set(boxId, state, "agent", null);
        throw new ControlError(`Taking control failed, so the agent keeps it: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!this.connected(boxId, viewer)) {
        this.#set(boxId, state, "agent", null);
        throw new ControlError("The viewer disconnected while taking control, so the agent keeps it.");
      }
      if (state.stale) {
        clearTimeout(state.stale);
        state.stale = null;
      }
      this.#set(boxId, state, "human", viewer);
      return this.view(boxId);
    });
  }

  /**
   * Gives control back to the agent: releases what the holder holds down,
   * then sets the desktop back to its size if the holder resized it.
   */
  handBack(boxId: string): Promise<ControlView> {
    return this.#giveBack(boxId, "person").then(() => AGENT);
  }

  /**
   * The agent takes control back from a person (038): a hand-back, after
   * which the holder's viewer says the agent took it. False when the agent
   * had control already.
   */
  takeBack(boxId: string): Promise<boolean> {
    return this.#giveBack(boxId, "agent");
  }

  #giveBack(boxId: string, by: "person" | "agent"): Promise<boolean> {
    const state = this.#boxes.get(boxId);
    if (!state) return Promise.resolve(false);
    return this.#serial(state, async () => {
      if (state.owner === "agent") return false;
      const holder = state.holder;
      if (state.stale) {
        clearTimeout(state.stale);
        state.stale = null;
      }
      this.#set(boxId, state, "none", null);
      if (holder) await this.#release(state, holder);
      const screen = state.resized;
      state.resized = null;
      if (screen && state.size) {
        await this.#deps.restore(boxId, state.size, screen).catch((error) => this.#deps.logError("restore the desktop's size", error));
      }
      this.#set(boxId, state, "agent", null, by === "agent" ? holder : null);
      return true;
    });
  }

  /** The box stopped, started again or went: the agent has control, and nothing is kept. */
  forget(boxId: string): void {
    const state = this.#boxes.get(boxId);
    if (!state) return;
    if (state.stale) clearTimeout(state.stale);
    state.stale = null;
    state.resized = null;
    state.size = null;
    this.#set(boxId, state, "agent", null);
    if (!state.connections.size) this.#boxes.delete(boxId);
  }

  /**
   * The plugin is going away, as on a reload. When each person's control is
   * stored, it stays theirs for the next instance (045): what the holder
   * holds down is let go, and the desktop keeps its size for the viewer to
   * come back to. Otherwise control goes back now, while bb-box can still
   * reach the box, so a desktop the holder resized gets its size back
   * (#139). Nothing is scheduled or stored after.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const state of this.#boxes.values()) {
      if (state.stale) clearTimeout(state.stale);
      state.stale = null;
    }
    const kept = this.#deps.keep !== undefined && (await this.#stored);
    await Promise.all(
      [...this.#boxes].map(async ([boxId, state]) => {
        const holder = state.owner === "human" ? state.holder : null;
        if (holder) await this.#deps.stopping?.(boxId, kept).catch((error) => this.#deps.logError("log a hand back", error));
        if (holder && kept) await this.#release(state, holder);
        else await this.handBack(boxId).catch((error) => this.#deps.logError("hand back", error));
      }),
    );
  }
}
