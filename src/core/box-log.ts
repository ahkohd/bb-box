import type { SizePart } from "../backends/types.ts";

export type Actor =
  | { readonly is: "person" }
  | { readonly is: "agent"; readonly threadId: string }
  | { readonly is: "command" }
  | { readonly is: "bb-box"; readonly why: string }
  | { readonly is: "outside" }
  | { readonly is: "unknown" };

export const BY_PERSON: Actor = { is: "person" };
export const BY_COMMAND: Actor = { is: "command" };
export const BY_OUTSIDE: Actor = { is: "outside" };
export const UNKNOWN_ACTOR: Actor = { is: "unknown" };

export function byAgent(threadId: string): Actor {
  return { is: "agent", threadId };
}

export function byBbBox(why: string): Actor {
  return { is: "bb-box", why };
}

export const BOX_EVENT_KINDS = [
  "made",
  "ready",
  "start-asked",
  "started",
  "start-failed",
  "stop-asked",
  "stopped",
  "stop-failed",
  "stopped-unasked",
  "resize-asked",
  "resized",
  "resize-failed",
  "release-asked",
  "released",
  "release-failed",
  "forgotten",
  "snapshot-taken",
  "snapshot-failed",
  "snapshot-deleted",
  "snapshot-lost",
  "snapshot-unavailable",
  "snapshot-kept",
  "snapshot-unkept",
  "restore-asked",
  "restored",
  "restore-failed",
  "restored-outside",
  "restore-outside-failed",
  "restore-outside-running",
  "fork-asked",
  "forked",
  "fork-failed",
  "held-copy-made",
  "held-copy-started",
  "identity-reset",
  "enrolled-again",
] as const;

export type BoxEventKind = (typeof BOX_EVENT_KINDS)[number];

export type ObservedState = "running" | "stopped" | "gone" | "unknown";

export interface Observation {
  readonly state: ObservedState;
  readonly at: number;
  readonly from: string;
}

export interface BoxEvent {
  readonly seq?: number;
  readonly box: string;
  readonly thread: string;
  readonly name: string;
  readonly at: number;
  readonly kind: BoxEventKind;
  readonly by: Actor;
  readonly words?: string | null;
  readonly observed?: Observation | null;
  readonly parts?: readonly SizePart[] | null;
  readonly backend?: string | null;
  readonly state?: string | null;
}

export interface BoxLog {
  record(event: BoxEvent): void;
  latest(boxId: string, kinds: readonly BoxEventKind[]): BoxEvent | null;
}

export const EVENT_WORDS_BYTES = 1024;
export const KEPT_FOR_A_BOX_MS = 7 * 24 * 60 * 60_000;
export const KEPT_AFTER_THE_END_MS = 24 * 60 * 60_000;
export const OPEN_STOP_MS = 5 * 60_000;

export type FailedOperation = "stop" | "start" | "resize" | "release";

export interface LastStart {
  readonly askedAt: number;
  readonly readyAt: number | null;
  readonly failedAt: number | null;
  readonly by: Actor | null;
  readonly first: boolean;
}

export interface LastStop {
  readonly at: number;
  readonly by: Actor | null;
  readonly asked: boolean;
}

export interface LastFailed {
  readonly operation: FailedOperation;
  readonly at: number;
  readonly words: string | null;
  readonly observed: Observation | null;
  readonly parts: readonly SizePart[];
}

export interface BoxLogView {
  readonly lastStart: LastStart | null;
  readonly lastStop: LastStop | null;
  readonly lastFailed: LastFailed | null;
}

export interface EndedBox {
  readonly box: string;
  readonly thread: string;
  readonly name: string;
  readonly how: "released" | "forgotten";
  readonly at: number;
  readonly by: Actor | null;
  readonly backend: string | null;
  readonly state: string | null;
}

const OPERATIONS: Readonly<Record<FailedOperation, readonly BoxEventKind[]>> = {
  stop: ["stop-asked", "stopped", "stop-failed"],
  start: ["start-asked", "started", "start-failed"],
  resize: ["resize-asked", "resized", "resize-failed"],
  release: ["release-asked", "released", "release-failed"],
};

export function utf8Prefix(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= bytes) return text;
  return new TextDecoder().decode(encoded.subarray(0, bytes)).replace(/�$/u, "");
}

function known(by: Actor): Actor | null {
  return by.is === "unknown" ? null : by;
}

function later(event: BoxEvent, than: BoxEvent): boolean {
  return event.at !== than.at ? event.at > than.at : (event.seq ?? 0) >= (than.seq ?? 0);
}

function newest(events: readonly (BoxEvent | undefined)[]): BoxEvent | null {
  return events.reduce<BoxEvent | null>((best, event) => (event && (!best || later(event, best)) ? event : best), null);
}

function trusted(event: BoxEvent | undefined, gapAt: number | null): BoxEvent | undefined {
  return event && (gapAt === null || event.at > gapAt) ? event : undefined;
}

function lastStart(of: (kind: BoxEventKind) => BoxEvent | undefined): LastStart | null {
  const asked = of("start-asked");
  const made = of("made");
  if (asked && (!made || later(asked, made))) {
    const started = of("started");
    const failed = of("start-failed");
    return {
      askedAt: asked.at,
      readyAt: started && later(started, asked) ? started.at : null,
      failedAt: failed && later(failed, asked) ? failed.at : null,
      by: known(asked.by),
      first: false,
    };
  }
  if (!made) return null;
  const ready = of("ready");
  return { askedAt: made.at, readyAt: ready && later(ready, made) ? ready.at : null, failedAt: null, by: known(made.by), first: true };
}

function lastStop(of: (kind: BoxEventKind) => BoxEvent | undefined): LastStop | null {
  const stop = newest([of("stopped"), of("stopped-unasked")]);
  if (!stop) return null;
  return { at: stop.at, by: known(stop.by), asked: stop.kind === "stopped" };
}

function lastFailed(of: (kind: BoxEventKind) => BoxEvent | undefined): LastFailed | null {
  let found: LastFailed | null = null;
  for (const [operation, kinds] of Object.entries(OPERATIONS) as [FailedOperation, readonly BoxEventKind[]][]) {
    const latest = newest(kinds.map(of));
    if (!latest || latest.kind !== kinds[2] || (found && found.at > latest.at)) continue;
    found = { operation, at: latest.at, words: latest.words ?? null, observed: latest.observed ?? null, parts: latest.parts ?? [] };
  }
  return found;
}

export function summarize(latest: ReadonlyMap<BoxEventKind, BoxEvent>, gapAt: number | null): BoxLogView {
  const of = (kind: BoxEventKind) => trusted(latest.get(kind), gapAt);
  return { lastStart: lastStart(of), lastStop: lastStop(of), lastFailed: lastFailed(of) };
}

export function openStop(latest: ReadonlyMap<BoxEventKind, BoxEvent>, now: number): BoxEvent | null {
  const asked = latest.get("stop-asked");
  const failed = latest.get("stop-failed");
  if (!asked || !failed || !later(failed, asked) || now - failed.at > OPEN_STOP_MS) return null;
  const after = [latest.get("stopped"), latest.get("stopped-unasked"), latest.get("start-asked"), latest.get("started")];
  return after.some((event) => event && later(event, asked)) ? null : asked;
}
