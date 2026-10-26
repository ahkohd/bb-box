import type { DeviceAnswer, DeviceState } from "../core/device.ts";

export const ANSWER_MARGIN_MS = 5_000;

interface Waiting {
  readonly resolve: (answer: DeviceAnswer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly lost: (why: "ended" | "late") => string;
}

export function viewerRequestId(count: number): string {
  return `v${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}${count.toString(36)}`;
}

export class DeviceAnswers {
  readonly #waiting = new Map<string, Waiting>();

  wait(id: string, deadlineMs: number, lost: (why: "ended" | "late") => string, state: () => DeviceState | null): Promise<DeviceAnswer> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        resolve({ id, ok: false, error: { code: "outcome-unknown", words: lost("late") }, state: state() });
      }, deadlineMs + ANSWER_MARGIN_MS);
      this.#waiting.set(id, { resolve, timer, lost });
    });
  }

  answered(answer: DeviceAnswer): boolean {
    const waiting = this.#waiting.get(answer.id);
    if (!waiting) return false;
    if (!answer.ok && answer.error.code === "in-progress") return true;
    clearTimeout(waiting.timer);
    this.#waiting.delete(answer.id);
    waiting.resolve(answer);
    return true;
  }

  refused(id: string, answer: DeviceAnswer): void {
    const waiting = this.#waiting.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.#waiting.delete(id);
    waiting.resolve(answer);
  }

  ended(state: DeviceState | null): void {
    for (const [id, waiting] of this.#waiting) {
      clearTimeout(waiting.timer);
      waiting.resolve({ id, ok: false, error: { code: "outcome-unknown", words: waiting.lost("ended") }, state });
    }
    this.#waiting.clear();
  }

  get size(): number {
    return this.#waiting.size;
  }
}
