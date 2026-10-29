export const LIVE_CHECKS_VARIABLE = "BB_BOX_LIVE_CHECKS";
export const DROPPED_REPLY_MESSAGE = "BB Box saved this and dropped its reply, as a live check asked.";

export function liveChecksOn(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return environment[LIVE_CHECKS_VARIABLE] === "1";
}

export class ReplyDrops {
  #armed = 0;

  get armed(): number {
    return this.#armed;
  }

  arm(count: number): void {
    this.#armed = Math.max(0, Math.floor(count));
  }

  take(): boolean {
    if (this.#armed === 0) return false;
    this.#armed -= 1;
    return true;
  }
}
