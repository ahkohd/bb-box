import type { Busy } from "../monitor/busy.ts";
import { BUSY_FRESH_MS } from "../monitor/busy-times.ts";
import type { BoxView } from "../plugin/views.ts";
import type { Tone } from "./common.tsx";
import { backendNotice, backendSilent, busyWords, failedNotice, notAnswering, reachNotice, releaseFailure, rowAgo, rowSpan, settingsNotice, startingSince, upSince } from "./box-words.ts";
import { joinAdvice, joinWords } from "./first-run.tsx";
import { joiningWords, tryWords } from "../core/join-tries.ts";
import { holdsNoCardWhileStopped, HOLDS_NO_CARD } from "../plugin/gpu-page.ts";
import { controlWord, displayWord } from "./status.ts";
import { PRODUCT } from "./product.ts";

export interface RowItem {
  readonly text: string;
  readonly tone?: "fg" | "warn" | "danger";
  readonly reason?: string;
}

export interface RowLine {
  readonly tone: Tone;
  readonly items: readonly RowItem[];
}

export interface RowNote {
  readonly text: string;
  readonly failed: boolean;
}

export interface RowFacts {
  readonly now: number;
  readonly busy?: Busy | null;
  readonly viewers?: ReadonlySet<string>;
  readonly resizeNote?: RowNote | null;
}

export interface ShownBusy extends Busy {
  readonly until: number;
}

export function busyUntil(busy: Busy | null | undefined, receivedAt: number): ShownBusy | null {
  return busy ? { ...busy, until: receivedAt + Math.max(0, busy.at + BUSY_FRESH_MS - busy.readAt) } : null;
}

export function busyNow(busy: Busy | null | undefined, now: number): Busy | null {
  const until = (busy as Partial<ShownBusy> | null | undefined)?.until;
  return busy && until !== undefined && now < until ? busy : null;
}

export function rowSize(box: Pick<BoxView, "size">): RowItem[] {
  return (box.size ?? "")
    .split(", ")
    .filter((part) => part !== "" && !part.endsWith(" disk"))
    .map((text) => ({ text }));
}

function sentences(...parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => !!part && part.trim() !== "").join(" ");
}

function failureItems(box: BoxView, now: number): RowItem[] {
  const failed = failedNotice(box, now);
  if (failed) return [{ text: failed.heading, tone: "danger", reason: sentences(failed.words, failed.then) }];
  if (box.error && box.state !== "failed") return [{ text: "Error", tone: "danger", reason: box.error }];
  return [];
}

function reachItem(box: BoxView, now: number): { readonly item: RowItem; readonly lastAnswered: number | null } | null {
  if (box.reach?.is === "not-in-settings") return { item: { text: "Its backend is not in settings", tone: "warn", reason: settingsNotice(box) ?? undefined }, lastAnswered: box.reach.lastAnswered };
  const silentBackend = backendSilent(box);
  if (silentBackend) {
    const notice = backendNotice(box);
    return { item: { text: `${silentBackend.backend} does not answer`, tone: "warn", reason: notice ? sentences(notice.words, notice.next) : undefined }, lastAnswered: silentBackend.lastAnswered };
  }
  const silent = notAnswering(box);
  if (silent) {
    const notice = reachNotice(box, now);
    return { item: { text: `${silent.host ?? box.name} does not answer`, tone: "warn", reason: notice ? sentences(notice.words, notice.next) : undefined }, lastAnswered: silent.lastAnswered };
  }
  return null;
}

function reachLine(box: BoxView, now: number): RowLine | null {
  if (box.state === "releasing") return null;
  const reach = reachItem(box, now);
  if (!reach) return null;
  const lastSeen: RowItem[] = reach.lastAnswered !== null ? [{ text: rowAgo(reach.lastAnswered, now) }] : [];
  return { tone: "warn", items: [{ text: `Last seen ${box.state}` }, ...failureItems(box, now), reach.item, ...lastSeen] };
}

function attention(box: BoxView, facts: RowFacts): RowItem[] {
  const items: RowItem[] = [...failureItems(box, facts.now)];
  const busy = busyNow(facts.busy, facts.now);
  if (busy && box.state === "ready") items.push({ text: busyWords(busy, rowSpan), tone: "warn" });
  const control = controlWord(box, facts.viewers ?? new Set());
  if (control) items.push(control);
  if (box.state === "ready" && box.enrol.state === "failed") items.push({ text: "Could not join BB", tone: "warn", reason: joinWords(box.enrol.error, joinAdvice(box)) });
  const display = displayWord(box);
  if (display) items.push(display);
  if (box.stopped) items.push({ text: "Unexpected stop", tone: "warn", reason: box.stopped });
  const note = facts.resizeNote;
  if (note) items.push(note.failed ? { text: "Resize failed", tone: "danger", reason: note.text } : { text: "Resized", reason: note.text });
  return items;
}

function joiningItem(box: BoxView, now: number): RowItem {
  const tries = box.joinTries;
  if (!tries) return { text: "Joining BB…" };
  const text = `Joining BB, ${tryWords(tries.failed)}`;
  if (tries.failed === 0) return { text };
  const words = joiningWords(tries, now);
  return { text, tone: "warn", reason: `${words.charAt(0).toUpperCase()}${words.slice(1)}.` };
}

export function rowLine(box: BoxView, facts: RowFacts): RowLine {
  const { now } = facts;
  const release = releaseFailure(box);
  if (release) return { tone: "bad", items: [{ text: "Release did not finish", tone: "danger", reason: release.words || undefined }, ...(release.at !== null ? [{ text: rowAgo(release.at, now) }] : [])] };
  const reach = reachLine(box, now);
  if (reach) return reach;
  const size = rowSize(box);
  switch (box.state) {
    case "acquiring":
    case "starting":
      return { tone: "busy", items: [{ text: "Starting" }, { text: rowSpan(now - startingSince(box)) }] };
    case "stopping":
      return { tone: "busy", items: [{ text: "Stopping…" }, ...attention(box, facts)] };
    case "releasing":
      return { tone: "busy", items: [{ text: "Releasing…" }] };
    case "gone":
      return { tone: "bad", items: [{ text: "Gone" }, { text: `deleted outside ${PRODUCT}` }] };
    case "failed": {
      const failedAt = box.log?.lastStart?.failedAt ?? null;
      return { tone: "bad", items: [{ text: "Failed", tone: "danger", reason: box.error ?? undefined }, ...(failedAt !== null ? [{ text: rowAgo(failedAt, now) }] : [])] };
    }
    case "stopped": {
      const stop = box.log?.lastStop;
      const parked = holdsNoCardWhileStopped(box) ? [{ text: HOLDS_NO_CARD }] : [];
      return { tone: "off", items: [{ text: "Stopped" }, ...parked, ...attention(box, facts), ...(stop ? [{ text: rowAgo(stop.at, now) }] : []), ...size] };
    }
    case "ready": {
      const joining: RowItem[] = box.enrol.state === "enrolling" ? [joiningItem(box, now)] : [];
      return { tone: "ok", items: [{ text: "Ready" }, ...attention(box, facts), ...joining, { text: `up ${rowSpan(now - upSince(box))}` }, ...size] };
    }
  }
}

export function rowWords(line: RowLine): string {
  return line.items.map((item) => item.text).join(" · ");
}

export function rowReasons(line: RowLine): string[] {
  return line.items.flatMap((item) => (item.reason ? [`${item.text}: ${item.reason}`] : []));
}
