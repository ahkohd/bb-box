import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import type { BoxRecord } from "../core/boxes.ts";

export interface HeldMachine {
  readonly box: string;
  readonly name: string;
  readonly snapshot: string;
  readonly unconfirmed: boolean;
}

export interface TurnHoldDeps {
  boxes(): Promise<BoxRecord[]>;
  unconfirmed(operation: string): boolean;
  recheck(): void;
  logError(operation: string, error: unknown): void;
}

export const HOLD_REASON_CHARACTERS = 200;
export const HOLD_ASKS_AGAIN_MS = 15_000;

export function heldWords(held: Pick<HeldMachine, "name"> & { readonly unconfirmed?: boolean }): string {
  if (held.unconfirmed) {
    const words = `bb-box could not confirm its restore of box ${held.name}, the machine this thread runs on, so this message waits. bb box doctor says why.`;
    return words.length <= HOLD_REASON_CHARACTERS ? words : "bb-box could not confirm its restore of the machine this thread runs on, so this message waits. bb box doctor says why.";
  }
  const words = `bb-box is restoring box ${held.name}, the machine this thread runs on. This message waits until the box is ready again.`;
  return words.length <= HOLD_REASON_CHARACTERS ? words : "bb-box is restoring the machine this thread runs on. This message waits until it is ready again.";
}

export class TurnHold {
  readonly #deps: TurnHoldDeps;
  #marked = new Map<string, HeldMachine>();
  readonly #asked = new Map<string, HeldMachine>();
  #refreshing: Promise<void> = Promise.resolve();

  constructor(deps: TurnHoldDeps) {
    this.#deps = deps;
  }

  decide(context: Pick<MessageDispatchHookContext, "host">): MessageDispatchHookDecision {
    const hostId = context.host?.id ?? null;
    if (!hostId) return { action: "proceed" };
    const held = this.#asked.get(hostId) ?? this.#marked.get(hostId);
    return held ? { action: "wait", reason: heldWords(held), sendAt: Date.now() + HOLD_ASKS_AGAIN_MS } : { action: "proceed" };
  }

  holding(hostId: string): HeldMachine | null {
    return this.#asked.get(hostId) ?? this.#marked.get(hostId) ?? null;
  }

  ask(box: Pick<BoxRecord, "id" | "name" | "enrol">, snapshot: string): () => void {
    const hostId = box.enrol.hostId;
    if (!hostId) return () => {};
    const held: HeldMachine = { box: box.id, name: box.name, snapshot, unconfirmed: false };
    this.#asked.set(hostId, held);
    return () => {
      if (this.#asked.get(hostId) !== held) return;
      this.#asked.delete(hostId);
      if (!this.#marked.has(hostId)) this.#deps.recheck();
      void this.refresh();
    };
  }

  refresh(): Promise<void> {
    this.#refreshing = this.#refreshing.then(() => this.#read()).catch((error: unknown) => this.#deps.logError("read which boxes are being restored", error));
    return this.#refreshing;
  }

  async #read(): Promise<void> {
    const before = new Set([...this.#marked.keys(), ...this.#asked.keys()]);
    const marked = new Map<string, HeldMachine>();
    for (const box of await this.#deps.boxes()) {
      if (box.restoring && box.enrol.hostId) marked.set(box.enrol.hostId, { box: box.id, name: box.name, snapshot: box.restoring.name, unconfirmed: this.#deps.unconfirmed(box.restoring.operation) });
    }
    this.#marked = marked;
    const freed = [...before].some((hostId) => !marked.has(hostId) && !this.#asked.has(hostId));
    if (freed) this.#deps.recheck();
  }
}
