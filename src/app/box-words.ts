import type { Actor, EndedBox, LastFailed, Observation } from "../core/box-log.ts";
import type { BoxView } from "../plugin/views.ts";
import type { Busy } from "../monitor/busy.ts";
import type { Tone } from "./common.tsx";
import { PRODUCT } from "./product.ts";
import { whenInSentence } from "./snapshot-words.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const JUST_NOW_MS = 45 * SECOND;

export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / SECOND));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

export function rowSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / SECOND));
  if (seconds < 60) return `${seconds} s`;
  if (ms < HOUR) return `${Math.floor(seconds / 60)} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`;
  return `${Math.floor(ms / DAY)} d`;
}

export function rowAgo(at: number, now: number): string {
  return now - at < JUST_NOW_MS ? "just now" : `${rowSpan(now - at)} ago`;
}

export function ago(at: number, now: number): string {
  return now - at < JUST_NOW_MS ? "just now" : `${span(now - at)} ago`;
}

export function clock(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function dayAndClock(at: number, now: number): string {
  const time = clock(at);
  if (sameDay(at, now)) return `Today ${time}`;
  if (sameDay(at, now - DAY)) return `Yesterday ${time}`;
  return `${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(at)} ${time}`;
}

export function stepTime(ms: number): string {
  if (ms < 100) return `${Math.round(ms)} ms`;
  if (ms >= MINUTE) return span(ms);
  return `${(ms / SECOND).toFixed(1)} s`;
}

export type ThreadTitles = Readonly<Record<string, string>>;

export function actorWords(actor: Actor | null | undefined, titles: ThreadTitles): string | null {
  if (!actor) return null;
  switch (actor.is) {
    case "person":
      return "by you";
    case "agent":
      return `by the agent in ${titles[actor.threadId] ?? "its thread"}`;
    case "command":
      return "by a bb box command";
    case "bb-box":
      return `by ${PRODUCT}: ${actor.why}`;
    case "outside":
      return `outside ${PRODUCT}`;
    case "unknown":
      return null;
  }
}

export function hostOf(backendLabel: string): string | null {
  const at = backendLabel.lastIndexOf(" on ");
  return at > 0 ? backendLabel.slice(at + " on ".length) : null;
}

export function driverOf(backendLabel: string): string {
  const at = backendLabel.lastIndexOf(" on ");
  return at > 0 ? backendLabel.slice(0, at) : backendLabel;
}

export function notInSettings(box: Pick<BoxView, "reach">): boolean {
  return box.reach?.is === "not-in-settings";
}

type ReachOf<Is> = Extract<NonNullable<BoxView["reach"]>, { is: Is }>;

export function backendSilent(box: Pick<BoxView, "reach">): ReachOf<"backend-silent"> | null {
  return box.reach?.is === "backend-silent" ? box.reach : null;
}

export function notAnswering(box: Pick<BoxView, "reach">): ReachOf<"not-answering"> | null {
  return box.reach?.is === "not-answering" ? box.reach : null;
}

export function unreachableWhy(box: Pick<BoxView, "reach">): string | null {
  if (notInSettings(box)) return "Its backend is not in settings";
  const silent = backendSilent(box);
  return silent ? `${silent.backend} does not answer` : null;
}

export function silentWhy(box: Pick<BoxView, "name" | "reach">): string | null {
  return unreachableWhy(box) ?? (notAnswering(box) ? `${box.name} does not answer` : null);
}

export interface ReleaseFailure {
  readonly at: number | null;
  readonly words: string;
}

export function releaseFailure(box: Pick<BoxView, "state" | "log" | "error">): ReleaseFailure | null {
  if (box.state !== "releasing") return null;
  const failed = box.log?.lastFailed;
  if (failed?.operation === "release") return { at: failed.at, words: failed.words ?? box.error ?? "" };
  return box.error ? { at: null, words: box.error } : null;
}

export function releaseUnfinished(box: Pick<BoxView, "state" | "log" | "error">): boolean {
  return releaseFailure(box) !== null;
}

function wholePercent(value: number | null): string {
  return value === null ? "" : ` ${Math.round(value)}%`;
}

export function busyWords(busy: Busy, measure: (ms: number) => string = span): string {
  const lasting = `for ${measure(busy.at - busy.since)}`;
  switch (busy.reason) {
    case "cpu":
    case "cpuPressure":
      return busy.slot ? `Busy:${wholePercent(busy.value)} of its share ${lasting}` : `Busy: CPU${wholePercent(busy.value)} ${lasting}`;
    case "memory":
    case "memoryPressure":
      return busy.slot ? `Busy: memory${wholePercent(busy.value)} of its share ${lasting}` : `Busy: memory${wholePercent(busy.value)} ${lasting}`;
    case "load":
      return `Busy: load${busy.value === null ? "" : ` ${busy.value.toFixed(1)}`}${busy.cores ? ` on ${busy.cores} ${busy.cores === 1 ? "core" : "cores"}` : ""} ${lasting}`;
    case "disk":
      return busy.value === null ? "Disk nearly full" : `Disk${wholePercent(busy.value)} full`;
    case "gpu":
      return `Busy: GPU${wholePercent(busy.value)} ${lasting}`;
  }
}

export function upSince(box: Pick<BoxView, "log" | "readyAt" | "createdAt">): number {
  return box.log?.lastStart?.readyAt ?? box.readyAt ?? box.createdAt;
}

export function startingAgain(box: Pick<BoxView, "log" | "state">): boolean {
  const start = box.log?.lastStart;
  return box.state === "starting" && !!start && !start.first && start.readyAt === null;
}

export function startingSince(box: Pick<BoxView, "log" | "state" | "createdAt">): number {
  return startingAgain(box) ? box.log!.lastStart!.askedAt : box.createdAt;
}

export interface Headline {
  readonly tone: Tone;
  readonly words: string;
  readonly detail: readonly string[];
}

function lastSeen(box: BoxView, at: number | null, now: number): string {
  return `last seen ${box.state}${at !== null ? ` ${ago(at, now)}` : ""}`;
}

export function headline(box: BoxView, now: number, titles: ThreadTitles): Headline {
  const release = releaseFailure(box);
  if (release) return { tone: "bad", words: "Release did not finish", detail: release.at !== null ? [ago(release.at, now)] : [] };
  if ((box.reach?.is === "not-in-settings" || box.reach?.is === "backend-silent") && box.state !== "releasing") return { tone: "warn", words: "Not checked", detail: [lastSeen(box, box.reach.lastAnswered, now)] };
  const silent = notAnswering(box);
  if (silent) return { tone: "warn", words: "Not answering", detail: [silent.lastAnswered !== null ? lastSeen(box, silent.lastAnswered, now) : `since ${clock(silent.since)}`] };
  switch (box.state) {
    case "acquiring":
    case "starting":
      return { tone: "busy", words: "Starting", detail: [`for ${span(now - startingSince(box))}`] };
    case "stopping":
      return { tone: "busy", words: "Stopping…", detail: [] };
    case "releasing":
      return { tone: "busy", words: "Releasing…", detail: [] };
    case "stopped": {
      const stop = box.log?.lastStop;
      if (!stop) return { tone: "off", words: "Stopped", detail: [] };
      const by = actorWords(stop.by, titles);
      return { tone: "off", words: "Stopped", detail: [[`${ago(stop.at, now)}, ${dayAndClock(stop.at, now)}`, by].filter(Boolean).join(", ")] };
    }
    case "failed": {
      const failedAt = box.log?.lastStart?.failedAt ?? null;
      return { tone: "bad", words: "Failed", detail: failedAt !== null ? [ago(failedAt, now)] : [] };
    }
    case "gone":
      return { tone: "bad", words: "Gone", detail: [`deleted outside ${PRODUCT}`] };
    case "ready":
      return { tone: "ok", words: "Ready", detail: [`up ${span(now - upSince(box))}`, ...(box.enrol.state === "failed" ? ["Could not join BB"] : [])] };
  }
}

const OPERATION_TITLES: Readonly<Record<LastFailed["operation"], string>> = { stop: "Stop failed", start: "Start failed", resize: "Resize failed", release: "Release did not finish" };

export function observedWords(observed: Observation | null, operation: LastFailed["operation"] = "stop"): string {
  if (!observed || observed.state === "unknown") return `${PRODUCT} could not confirm its state.`;
  const checked = `(checked ${clock(observed.at)})`;
  switch (observed.state) {
    case "running":
      return operation === "stop" ? `It is still running ${checked}.` : `It is running ${checked}.`;
    case "stopped":
      return operation === "start" ? `It is still stopped ${checked}.` : `It is stopped ${checked}.`;
    case "gone":
      return `Its guest is gone ${checked}.`;
  }
}

function partsWords(parts: readonly string[]): string {
  if (!parts.length) return "Its size did not change.";
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Its ${list} changed before it failed.`;
}

function asSentence(words: string): string {
  const trimmed = words.trim();
  return !trimmed || /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function stateMatches(observed: Observation | null, operation: LastFailed["operation"], state: BoxView["state"]): boolean {
  switch (observed?.state) {
    case "running":
      return state === "ready";
    case "stopped":
      return state === "stopped";
    case "gone":
      return state === "gone";
    default:
      return operation === "stop" ? state === "ready" : operation === "start" ? state === "stopped" : state === "ready" || state === "stopped";
  }
}

function overtaken(failed: LastFailed, box: Pick<BoxView, "log">): boolean {
  const stop = box.log?.lastStop?.at ?? 0;
  const start = box.log?.lastStart?.askedAt ?? 0;
  return stop > failed.at || start > failed.at;
}

export interface FailedNotice {
  readonly operation: LastFailed["operation"];
  readonly heading: string;
  readonly title: string;
  readonly words: string;
  readonly then: string;
}

export function failedNotice(box: BoxView, now: number): FailedNotice | null {
  const release = releaseFailure(box);
  if (release) {
    const host = hostOf(box.backendLabel);
    return {
      operation: "release",
      heading: OPERATION_TITLES.release,
      title: release.at !== null ? `${OPERATION_TITLES.release} ${ago(release.at, now)}` : OPERATION_TITLES.release,
      words: asSentence(release.words),
      then: `The box may still run${host ? ` on ${host}` : ""}; ${PRODUCT} keeps its record until a release is confirmed.`,
    };
  }
  const failed = box.log?.lastFailed;
  if (!failed || failed.operation === "release" || overtaken(failed, box) || !stateMatches(failed.observed, failed.operation, box.state)) return null;
  const then = failed.operation === "resize" ? partsWords(failed.parts) : observedWords(failed.observed, failed.operation);
  return { operation: failed.operation, heading: OPERATION_TITLES[failed.operation], title: `${OPERATION_TITLES[failed.operation]} ${ago(failed.at, now)}`, words: asSentence(failed.words ?? ""), then };
}

export interface ReachNotice {
  readonly title: string;
  readonly words: string;
  readonly next: string;
}

export function reachNotice(box: BoxView, now: number): ReachNotice | null {
  const silent = notAnswering(box);
  if (!silent) return null;
  const where = silent.host ? ` on ${silent.host}` : "";
  return {
    title: `${box.name} does not answer`,
    words: [
      asSentence(silent.error),
      `Since ${clock(silent.since)}, ${PRODUCT} cannot reach it${where}, so it cannot read it or run commands in it.`,
      `You can still stop, start or release it: those go through ${box.backendLabel}.`,
    ].join(" "),
    next: silent.checking ? `${PRODUCT} is checking it now.` : silent.nextCheckAt !== null ? `${PRODUCT} checks again in ${span(Math.max(0, silent.nextCheckAt - now))}.` : "",
  };
}

export function backendNotice(box: BoxView): ReachNotice | null {
  const silent = backendSilent(box);
  if (!silent) return null;
  return {
    title: `${silent.backend} does not answer`,
    words: `${asSentence(silent.error)} Since ${clock(silent.since)}, ${PRODUCT} cannot check, stop, start or resize ${box.name} through it, and the box may still be running.`,
    next: `${PRODUCT} asks it again every 3 minutes.`,
  };
}

export function settingsNotice(box: BoxView): string | null {
  if (box.reach?.is !== "not-in-settings") return null;
  const host = hostOf(box.backendLabel);
  return `${box.reach.backend} was removed from ${PRODUCT}'s settings, so ${PRODUCT} cannot check, stop or release ${box.name}, which may still be running${host ? ` on ${host}` : " there"}. Add the backend back to manage it, or forget it here.`;
}

export function endedWords(ended: EndedBox, now: number, titles: ThreadTitles): { readonly title: string; readonly words: string } {
  const by = actorWords(ended.by, titles);
  const when = `${ended.how === "released" ? "Released" : "Forgotten"} ${ago(ended.at, now)}, ${whenInSentence(ended.at, now)}${by ? `, ${by}` : ""}.`;
  if (ended.how === "released") return { title: `${ended.name} was released`, words: `${when} ${PRODUCT} remembers a released box for 24 hours.` };
  const host = ended.backend ? hostOf(ended.backend) ?? ended.backend : null;
  return { title: `${ended.name} was forgotten`, words: `${PRODUCT} removed its record. Its box was not deleted and may still run${host ? ` on ${host}` : ""}. ${when}` };
}

export const NOT_HERE_TITLE = "This box is not here";

export const NOT_HERE_WORDS = "It may have been released more than 24 hours ago, or the link is wrong.";

const STEP_NAMES: Readonly<Record<string, string>> = {
  warm: "Took a warm box",
  template: "Waited for the template",
  clone: "Clone",
  configure: "Configure",
  tags: "Tags",
  start: "Start",
  boot: "Boot",
  network: "Network",
  ssh: "SSH",
  enrol: "Join BB",
  spare: "Claimed a spare",
  spareResume: "Resumed it",
  spareReconnect: "BB machine back",
  spareSwitch: "Switched its device",
  relabel: "Named it",
  clock: "Set the clock",
  image: "Its image",
};

export function stepName(step: string): string {
  const bare = step.startsWith("start.") ? step.slice("start.".length) : step;
  return STEP_NAMES[bare] ?? bare.charAt(0).toUpperCase() + bare.slice(1);
}

const NOT_ACQUIRE_STEPS: ReadonlySet<string> = new Set(["total", "enrol", "spareReconnect"]);

export function acquireSteps(timings: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(timings).filter(([step, ms]) => ms >= 0 && !NOT_ACQUIRE_STEPS.has(step) && !step.includes("."));
}

export function startSteps(timings: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(timings).filter(([step]) => step.startsWith("start.") && step !== "start.total");
}

export function namedAfterReady(timings: Readonly<Record<string, number>>): number | null {
  const relabel = timings.relabel;
  if (relabel === undefined || timings.spare === undefined || timings.total === undefined) return null;
  const before = acquireSteps(timings).filter(([step]) => step !== "relabel").reduce((sum, [, ms]) => sum + ms, 0);
  return timings.total < before + relabel ? relabel : null;
}

export function joinedAfter(timings: Readonly<Record<string, number>>): number | null {
  return timings.enrol ?? timings.spareReconnect ?? null;
}
