// How long a deploy keeps bb-box's tools away (#916): agents got
// "Unsupported tool" for 30 to 120 s at each one. BB runs the old version's
// dispose hooks, loads the new version, and takes its tools once its setup
// returns, or loads the new version first, as BB's test host does. bb-box logs
// how long it took to stop, and to start, by phase, and which came first, by
// the times each version started and stopped, kept in bb-box's storage.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PRODUCT } from "../brand.ts";


export const STOPPED_AT_KEY = "reload/stopped-at";
export const STARTED_AT_KEY = "reload/started-at";

type Kv = BbPluginApi["storage"]["kv"];

export class ReloadTimes {
  readonly #log: (message: string) => void;
  readonly #kv: Kv;
  readonly #now: () => number;
  readonly #began: number;
  readonly #phases: [string, number][] = [];
  #last: number;
  #stopping: number | null = null;

  constructor(log: (message: string) => void, kv: Kv, now: () => number = Date.now) {
    this.#log = log;
    this.#kv = kv;
    this.#now = now;
    this.#began = this.#last = now();
  }

  /** Setup finished `phase`, since the phase before. */
  phase(phase: string): void {
    const now = this.#now();
    this.#phases.push([phase, now - this.#last]);
    this.#last = now;
  }

  /** Setup is done: logs the start, and the time since the last version stopped, when it stopped first. */
  async started(): Promise<void> {
    const total = this.#now() - this.#began;
    const [stoppedAt, lastStartedAt] = await Promise.all([this.#read(STOPPED_AT_KEY), this.#read(STARTED_AT_KEY)]);
    await this.#kv.set(STARTED_AT_KEY, this.#began).catch(() => undefined);
    const stoppedFirst = stoppedAt !== null && stoppedAt <= this.#began && (lastStartedAt === null || stoppedAt >= lastStartedAt);
    const gap = stoppedFirst ? `; BB began it ${seconds(this.#began - stoppedAt)} after the last version stopped` : "";
    this.#log(`${PRODUCT} started in ${seconds(total)}: ${this.#phases.map(([phase, ms]) => `${phase} ${seconds(ms)}`).join(", ")}${gap}.`);
  }

  /** The first dispose hook runs. */
  stopping(): void {
    this.#stopping = this.#now();
  }

  /** The last dispose hook runs: logs the stop, and whether the next version had started first, and keeps when it ended. */
  async stopped(): Promise<void> {
    const now = this.#now();
    const startedAt = await this.#read(STARTED_AT_KEY);
    const before = startedAt !== null && startedAt > this.#began ? `, ${seconds((this.#stopping ?? now) - startedAt)} after BB began the next version` : "";
    if (this.#stopping !== null) this.#log(`${PRODUCT} stopped in ${seconds(now - this.#stopping)}${before}.`);
    await this.#kv.set(STOPPED_AT_KEY, now).catch(() => undefined);
  }

  async #read(key: string): Promise<number | null> {
    const value = await this.#kv.get<number>(key).catch(() => null);
    return typeof value === "number" ? value : null;
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}
