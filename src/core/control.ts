// Who controls each desktop box's input: the agent (the default), a person
// in one viewer, or nobody while control changes hands. It lives in memory
// only, so a restart of the plugin gives control back to the agent (008).
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
  logError(operation: string, error: unknown): void;
  /** How long a holder's viewer may be gone before control goes back to the agent. */
  readonly staleMs?: number;
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

const STALE_MS = 60_000;
const AGENT: ControlView = { owner: "agent", holder: null };

export class Control {
  readonly #deps: ControlDeps;
  readonly #boxes = new Map<string, BoxControl>();
  #disposed = false;

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
  }

  /**
   * A connection ended. When the holder has none left, control goes back to
   * the agent: at once if the box ended it, or after staleMs if the viewer
   * went away and does not come back.
   */
  detach(boxId: string, connection: ViewerConnection, by: "viewer" | "box"): void {
    const state = this.#boxes.get(boxId);
    if (!state?.connections.delete(connection)) return;
    if (this.#disposed || state.owner !== "human" || state.holder !== connection.viewer || this.connected(boxId, connection.viewer)) return;
    if (by === "box") {
      void this.handBack(boxId).catch((error) => this.#deps.logError("hand back", error));
      return;
    }
    if (state.stale) clearTimeout(state.stale);
    state.stale = setTimeout(() => {
      state.stale = null;
      void this.handBack(boxId).catch((error) => this.#deps.logError("hand back", error));
    }, this.#deps.staleMs ?? STALE_MS);
    state.stale.unref?.();
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
   * The plugin is going away, as on a reload, and its next start gives
   * control to the agent (008). Each person's control goes back now, while
   * bb-box can still reach the box, so a desktop the holder resized gets its
   * size back (#139). Nothing is scheduled after.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const state of this.#boxes.values()) {
      if (state.stale) clearTimeout(state.stale);
      state.stale = null;
    }
    await Promise.all([...this.#boxes.keys()].map((boxId) => this.handBack(boxId).catch((error) => this.#deps.logError("hand back", error))));
  }
}
