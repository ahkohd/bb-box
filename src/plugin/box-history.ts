import { OPERATOR, ownedByThread, type BoxRecord, type Boxes } from "../core/boxes.ts";
import type { MonitorConfig } from "../core/document.ts";
import { placementOf } from "../core/device-host.ts";
import type { ReachCheck } from "../core/reach.ts";
import type { DoctorCheck } from "../backends/types.ts";
import { BoxHistory, NO_TALLY, READING_TIMEOUT_MS, macKey, type HistoryBox, type Tally } from "../monitor/box-history.ts";
import { historyShape, historyWindow, type HistoryRange, type HistoryShape } from "../monitor/history-view.ts";
import { lightScript, parseLightOutput, type LightOs, type LightReading, type LightRequest } from "../monitor/light.ts";
import { busyOf, countedFrom, reachesBack, type Busy } from "../monitor/busy.ts";
import { POINTS_JOIN_MS } from "../monitor/busy-times.ts";
import { TransportError } from "../transports/types.ts";
import type { BoxLogStore } from "./box-log-store.ts";
import { MINUTES_KEPT_MS, type BoxHistoryStore } from "./box-history-store.ts";

const ROUTE_OUTPUT_BYTES = 512 * 1024;
const HOUR_MS = 60 * 60_000;
const BUSY_LOOK_MS = 70 * 60_000;

export interface BoxHistoryView extends HistoryShape {
  readonly kept: boolean;
  readonly monitor: boolean;
  readonly full: string | null;
  readonly slot: { readonly host: string } | null;
  readonly newest: number | null;
  readonly now: number;
}

export interface HistoryReport {
  readonly on: boolean;
  readonly boxes: number;
  readonly workers: number;
  readonly paused: readonly string[];
  readonly hours: readonly (Tally & { readonly hour: number })[];
  readonly newest: readonly { readonly box: string; readonly name: string; readonly at: number | null }[];
  readonly usedBytes: number | null;
  readonly full: string | null;
}

export interface BoxHistoryAppDeps {
  readonly store: BoxHistoryStore;
  readonly boxes: Boxes;
  readonly boxLog: BoxLogStore;
  readonly reach: ReachCheck;
  readonly config: () => MonitorConfig;
  readonly hostLight: (hostId: string, request: LightRequest, timeoutMs: number) => Promise<LightReading>;
  readonly connected: (hostId: string) => Promise<boolean | null>;
  readonly unreachableHost: (box: BoxRecord, hostId: string) => Promise<void>;
  readonly log: (message: string) => void;
  readonly now?: () => number;
}

function listed(box: BoxRecord): boolean {
  return ownedByThread(box.threadId) || box.threadId === OPERATOR;
}

function routeOs(box: BoxRecord): LightOs | null {
  if (box.capabilities.command === null) return null;
  return box.capabilities.os === "linux" ? "linux" : box.capabilities.os === "macos" ? "macos" : null;
}

function hostOf(box: BoxRecord): string | null {
  return box.enrol.state === "enrolled" ? box.enrol.hostId : null;
}

export function readableByHistory(box: BoxRecord): boolean {
  return listed(box) && box.state === "ready" && box.guest !== null && (hostOf(box) !== null || routeOs(box) !== null);
}

function slotOf(box: BoxRecord): HistoryBox["slot"] {
  const placement = placementOf(box);
  return placement.on === "slot" ? { host: placement.host, most: placement.most } : null;
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "none due";
}

export function historyStateWords(config: MonitorConfig, boxes: number, workers: number, hour: Tally | null): string {
  if (!config.enabled) return "Off, as the Monitor is off: bb-box reads no box in the background.";
  if (!config.boxHistory) return "Off: bb-box reads no box in the background, and what it kept stays until it ages out.";
  const read = `On: bb-box reads ${boxes} ${boxes === 1 ? "box" : "boxes"} once a minute, with up to ${workers} readings at once.`;
  if (!hour || hour.due + hour.unanswered === 0) return `${read} Nothing was due this hour or the last.`;
  return `${read} This hour and the last, ${hour.taken} of ${hour.due} readings due were taken within 10 s of their second (${percent(hour.taken, hour.due)}); ${hour.skipped} skipped, ${hour.failed} failed, and ${hour.unanswered} not tried as their box did not answer.`;
}

function sumTallies(rows: readonly Tally[]): Tally {
  return rows.reduce<Tally>(
    (sum, row) => ({
      due: sum.due + row.due,
      taken: sum.taken + row.taken,
      skipped: sum.skipped + row.skipped,
      failed: sum.failed + row.failed,
      unanswered: sum.unanswered + row.unanswered,
      readingMs: sum.readingMs + row.readingMs,
      slowestMs: Math.max(sum.slowestMs, row.slowestMs),
      workers: Math.max(sum.workers, row.workers),
    }),
    NO_TALLY,
  );
}

export type HistoryReadDeps = Pick<BoxHistoryAppDeps, "boxes" | "reach" | "hostLight" | "connected" | "unreachableHost">;

export function historyRead(deps: HistoryReadDeps) {
  const stillReady = async (box: BoxRecord): Promise<BoxRecord | null> => {
    const current = await deps.boxes.find(box.id).catch(() => null);
    return current?.state === "ready" && current.guest?.ref === box.guest?.ref ? current : null;
  };
  return async (historyBox: HistoryBox, request: LightRequest, signal: AbortSignal): Promise<LightReading> => {
    const box = await deps.boxes.find(historyBox.id);
    if (!box) throw new Error("That box is gone.");
    const hostId = hostOf(box);
    const os = routeOs(box);
    if (hostId && (await deps.connected(hostId)) === true) {
      try {
        const reading = await deps.hostLight(hostId, request, READING_TIMEOUT_MS);
        deps.reach.answered(box);
        return reading;
      } catch (error) {
        if (!os) {
          const current = await stillReady(box);
          if (current) await deps.unreachableHost(current, hostId).catch(() => undefined);
          throw error;
        }
      }
    }
    if (!os) {
      const current = hostId ? await stillReady(box) : null;
      if (current && hostId) await deps.unreachableHost(current, hostId).catch(() => undefined);
      throw new Error(`bb-box cannot read box ${box.name} now: its BB machine is not answering BB, and it runs no shell bb-box can read without it.`);
    }
    const { command } = await deps.boxes.transports(box);
    if (!command) throw new Error(`bb-box cannot run commands in box ${box.name}.`);
    try {
      const result = await command.run(lightScript(os, request), { timeoutMs: READING_TIMEOUT_MS, maxOutputBytes: ROUTE_OUTPUT_BYTES, signal });
      if (result.timedOut) throw new Error(`It did not answer within ${READING_TIMEOUT_MS / 1000} s.`);
      if (!result.stdout.includes("@@")) throw new Error(`It did not answer the reading (exit code ${result.exitCode ?? "none"}).`);
      deps.reach.answered(box);
      return parseLightOutput(os, result.stdout);
    } catch (error) {
      if (error instanceof TransportError && error.code === "unreachable") {
        const current = await stillReady(box);
        if (current) deps.reach.failed(current, error.message);
      }
      throw error;
    }
  };
}

export function retainedKeys(records: readonly BoxRecord[], ended: (boxId: string) => unknown): (key: string) => boolean {
  const ids = new Set(records.map((box) => box.id));
  const macs = new Set(records.flatMap((box) => {
    const slot = slotOf(box);
    return slot ? [macKey(slot.host)] : [];
  }));
  return (key) => (key.startsWith("mac:") ? macs.has(key) : ids.has(key) || ended(key) !== null);
}

function lastStartOf(boxLog: BoxLogStore, boxId: string): { readonly askedAt: number } | null {
  try {
    return boxLog.view(boxId).lastStart;
  } catch {
    return null;
  }
}

export function createBoxHistory(deps: BoxHistoryAppDeps) {
  const now = deps.now ?? Date.now;
  let records = new Map<string, BoxRecord>();

  const read = historyRead(deps);

  const reader = new BoxHistory({
    async boxes() {
      const all = await deps.boxes.all();
      records = new Map(all.map((box) => [box.id, box]));
      return all.filter(readableByHistory).map((box) => {
        const lastStart = deps.boxLog.view(box.id).lastStart;
        return { id: box.id, name: box.name, os: routeOs(box), slot: slotOf(box), lastStartAt: lastStart ? lastStart.askedAt : null };
      });
    },
    read,
    reach: {
      notAnswering: (boxId) => deps.reach.notAnswering(boxId),
      lastAnswered: (boxId) => deps.reach.reach({ id: boxId }).lastAnswered,
      async check(boxId) {
        const box = await deps.boxes.find(boxId).catch(() => null);
        if (!box || box.state !== "ready") return false;
        return (await deps.reach.checkNow(box)).is === "answers";
      },
    },
    store: deps.store,
    switches: () => {
      const config = deps.config();
      return { monitor: config.enabled, history: config.boxHistory };
    },
    retained: async () => {
      const all = await deps.boxes.all();
      records = new Map(all.map((box) => [box.id, box]));
      return retainedKeys(all, (boxId) => deps.boxLog.ended(boxId));
    },
    log: deps.log,
    now,
  });

  const lastHour = () => {
    const at = now();
    return sumTallies(deps.store.tallies(Math.floor(at / HOUR_MS) * HOUR_MS - HOUR_MS, at + 1));
  };

  return {
    reader,
    store: deps.store,
    start: (signal: AbortSignal) => reader.start(signal),
    configure: () => reader.configure(),
    view(box: BoxRecord, range: HistoryRange): BoxHistoryView {
      const at = now();
      const config = deps.config();
      const window = historyWindow(range, at);
      const slot = slotOf(box);
      const span = { from: window.from - 5 * 60_000, to: window.to };
      const minutes = range === "7d" ? [] : deps.store.minutes(box.id, span.from, span.to);
      const hours = range === "7d" ? deps.store.hours(box.id, window.from, window.to) : [];
      const host = slot ? { minutes: range === "7d" ? [] : deps.store.minutes(macKey(slot.host), span.from, span.to), hours: range === "7d" ? deps.store.hours(macKey(slot.host), window.from, window.to) : [] } : null;
      let events: { kind: string; at: number }[] = [];
      try {
        events = deps.boxLog.events(box.id).map((event) => ({ kind: event.kind, at: event.at }));
      } catch {
        events = [];
      }
      const keptSince = deps.store.keptSince();
      const quiet = [...(keptSince !== null && keptSince > window.from ? [{ from: 0, to: keptSince }] : []), ...deps.store.quiet(window.from, window.to)];
      const shape = historyShape({ range, now: at, createdAt: box.createdAt, state: box.state, minutes, hours, host, events, quiet });
      return { ...shape, kept: config.boxHistory, monitor: config.enabled, full: deps.store.fullWords(), slot: slot ? { host: slot.host } : null, newest: deps.store.newest(box.id), now: at };
    },
    busy(box: BoxRecord): Busy | null {
      const config = deps.config();
      if (!config.enabled || !config.boxHistory || box.state !== "ready") return null;
      const at = now();
      const newest = deps.store.newest(box.id);
      if (newest !== null && newest > at + POINTS_JOIN_MS) return null;
      const quiet = deps.store.quiet(at - MINUTES_KEPT_MS, at);
      if (quiet.some((each) => each.to === null)) return null;
      const lastStart = lastStartOf(deps.boxLog, box.id);
      const from = countedFrom(lastStart?.askedAt ?? box.readyAt ?? box.createdAt, quiet.map((each) => each.to!));
      const slot = slotOf(box) !== null;
      const recent = deps.store.minutes(box.id, Math.max(at - BUSY_LOOK_MS, from - POINTS_JOIN_MS), at);
      const busy = busyOf(recent, at, slot, from);
      if (!busy || !reachesBack(busy, recent) || busy.since <= from + POINTS_JOIN_MS) return busy;
      return busyOf(deps.store.minutes(box.id, Math.max(at - MINUTES_KEPT_MS, from - POINTS_JOIN_MS), at), at, slot, from);
    },
    stateWords(): string {
      const status = reader.status();
      return historyStateWords(deps.config(), status.boxes, status.workers, lastHour());
    },
    checks(): DoctorCheck[] {
      return deps.store.checks(this.stateWords());
    },
    report(hours: number): HistoryReport {
      const at = now();
      const status = reader.status();
      return {
        on: status.on,
        boxes: status.boxes,
        workers: status.workers,
        paused: status.paused,
        hours: deps.store.tallies(at - hours * HOUR_MS, at + 1),
        newest: [...records.values()].filter(readableByHistory).map((box) => ({ box: box.id, name: box.name, at: deps.store.newest(box.id) })),
        usedBytes: deps.store.usedBytes(),
        full: deps.store.fullWords(),
      };
    },
  };
}

export type BoxHistoryApp = ReturnType<typeof createBoxHistory>;
