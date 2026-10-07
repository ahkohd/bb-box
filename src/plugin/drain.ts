// box_run's commands across a deploy (#405). When BB updates or reloads a
// plugin, it aborts the plugin's tool calls with the reason
// "plugin-disposed", then waits for the plugin's dispose hooks, and a call
// that ends after the abort still gives the agent its result. So a command
// does not stop on that abort: bb-box's first dispose hook takes no new
// commands, waits a while for those running, then stops the rest, which go
// on in their boxes as jobs. BB stops bb-box's worker on BB machines, and
// with it the relay to Docker there, before it aborts the calls, so a
// command in a Docker box on a BB machine fails at once.

import { BoxError } from "../core/boxes.ts";

/** BB's abort reason for a plugin's tool calls when it disposes the plugin. */
export const PLUGIN_DISPOSED = "plugin-disposed";
/** How long a deploy waits for commands still running. */
export const DRAIN_MS = 60_000;
/** How long stopped commands get to end once the wait is over. */
const STOP_MS = 5_000;

/** A command that close() stopped, as bb-box was restarting. */
export class Restarted extends Error {
  constructor() {
    super("bb-box restarted while the command ran.");
    this.name = "Restarted";
  }
}

/** A command box_run stopped waiting for, as BB ends a tool call at about five minutes (#486). */
export class Detached extends Error {
  constructor() {
    super("box_run stopped waiting for the command.");
    this.name = "Detached";
  }
}

export class Drain {
  readonly #running = new Map<Promise<unknown>, AbortController>();
  #closed = false;

  /** True once bb-box is stopping. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Runs `task` with a signal that follows `signal`, the tool call's, except
   * for BB's abort for a deploy. Throws at once while bb-box is stopping,
   * and Restarted when close() stopped the task. With `detachMs`, it stops
   * the task after that long as close() does, and throws Detached.
   */
  async run<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>, options: { detachMs?: number } = {}): Promise<T> {
    if (this.#closed) {
      throw new BoxError("restarting", "bb-box is restarting, as for an update, and takes no new commands until it is back, within a minute.");
    }
    const controller = new AbortController();
    const follow = () => {
      if (signal.reason !== PLUGIN_DISPOSED) controller.abort(signal.reason);
    };
    if (signal.aborted) follow();
    else signal.addEventListener("abort", follow, { once: true });
    const timer = options.detachMs === undefined ? undefined : setTimeout(() => controller.abort(new Detached()), options.detachMs);
    const done = task(controller.signal);
    this.#running.set(done, controller);
    try {
      return await done;
    } catch (error) {
      if (controller.signal.reason instanceof Restarted || controller.signal.reason instanceof Detached) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      this.#running.delete(done);
      signal.removeEventListener("abort", follow);
    }
  }

  /** Takes no new tasks, waits up to `ms` for those running, then stops the rest. */
  async close(ms: number): Promise<void> {
    this.#closed = true;
    if (!this.#running.size) return;
    const settled = Promise.allSettled([...this.#running.keys()]);
    if (await within(settled, ms)) return;
    for (const controller of this.#running.values()) controller.abort(new Restarted());
    await within(settled, STOP_MS);
  }
}

/** True when `task` settles within `ms`. */
async function within(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([task.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}
