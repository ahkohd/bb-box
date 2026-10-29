import type { BoxView } from "@/src/plugin/views.ts";
import type { Tone } from "@/src/app/common.tsx";
import type { StatusItem } from "@/src/app/status.ts";
import { controlWord } from "@/src/app/status.ts";
import type { Actor, FakeBox, FakeThread } from "./data";
import { busyFor } from "./history";

export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

export function shortSpan(ms: number): string {
  const words = span(ms);
  return words.split(" ").slice(0, 2).join(" ");
}

export function clock(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at);
}

export function dayAndClock(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  if (sameDay) return `today at ${clock(at)}`;
  const yesterday = new Date(now - 86_400_000).toDateString() === new Date(at).toDateString();
  if (yesterday) return `yesterday at ${clock(at)}`;
  return `${new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(at)} at ${clock(at)}`;
}

export const MY_VIEWERS: ReadonlySet<string> = new Set(["this-tab"]);

export function lastStop(box: FakeBox) {
  return box.stops?.at(-1) ?? null;
}

export function sizeWords(box: BoxView): string | null {
  if (box.sizeNow) return `${box.sizeNow.cores} cores · ${box.sizeNow.memoryGiB} GiB memory`;
  return null;
}

export interface Line {
  readonly tone: Tone;
  readonly items: readonly StatusItem[];
}

export function actorWords(actor: Actor, threads: readonly FakeThread[]): string | null {
  if (!actor) return null;
  switch (actor.kind) {
    case "you":
      return "by you";
    case "agent":
      return `by the agent in ${threads.find((thread) => thread.id === actor.threadId)?.title ?? "its thread"}`;
    case "command":
      return "by a bb box command";
    case "bb-box":
      return `by bb-box: ${actor.why}`;
    case "outside":
      return "outside bb-box";
  }
}

const OPERATION_WORDS: Readonly<Record<string, string>> = { stop: "Stop failed", start: "Start failed", resize: "Resize failed", release: "Release did not finish" };

export function attentionItems(box: FakeBox, now: number): StatusItem[] {
  const view = box.view;
  const items: StatusItem[] = [];
  if (box.operation) items.push({ text: OPERATION_WORDS[box.operation.action]!, tone: "danger" });
  if (box.backendGone) items.push({ text: "Its backend is not in settings", tone: "warn" });
  if (box.unreachable) items.push({ text: `${view.backendLabel.replace(/^.* on /, "")} does not answer`, tone: "warn" });
  const busy = busyItem(box, now);
  if (busy) items.push(busy);
  const control = controlWord(view, MY_VIEWERS);
  if (control?.tone === "fg") items.push(control);
  if (view.state === "ready" && view.enrol.state === "failed") items.push({ text: "Could not join BB", tone: "warn" });
  return items;
}

export function ago(at: number, now: number): string {
  return now - at < 45_000 ? "just now" : `${span(now - at)} ago`;
}

export function busyItem(box: FakeBox, now: number): StatusItem | null {
  if (box.view.state !== "ready" || box.unreachable || box.backendGone) return null;
  const busy = busyFor(box, now);
  return busy !== null && busy >= 5 * 60_000 ? { text: `Busy: CPU ${Math.round(box.load.cpu)}% for ${shortSpan(busy)}`, tone: "warn" } : null;
}

export function rowLine(box: FakeBox, now: number): Line {
  const view = box.view;
  const size = sizeWords(view);
  const sized: StatusItem[] = size ? [{ text: size }] : [];
  const attention = attentionItems(box, now);
  const tone = (fallback: Tone): Tone => (attention.some((item) => item.tone === "danger") ? "bad" : attention.some((item) => item.tone === "warn") ? "warn" : fallback);
  switch (view.state) {
    case "acquiring":
    case "starting":
      return { tone: tone("busy"), items: [{ text: "Starting" }, ...attention, { text: span(now - startSince(box)) }] };
    case "stopping":
      return { tone: tone("busy"), items: [{ text: "Stopping…" }, ...attention, ...sized] };
    case "releasing":
      return { tone: tone("busy"), items: [{ text: box.operation ? "Releasing" : "Releasing…" }, ...attention] };
    case "stopped": {
      const stop = lastStop(box);
      return { tone: tone("off"), items: [{ text: "Stopped" }, ...attention, ...(stop ? [{ text: `${shortSpan(now - stop.from)} ago` }] : []), ...sized] };
    }
    case "failed":
      return { tone: "bad", items: [{ text: "Failed", tone: "danger" }, ...attention, { text: `${shortSpan(now - view.createdAt)} ago` }] };
    case "gone":
      return { tone: "bad", items: [{ text: "Gone" }, { text: "deleted outside bb-box" }] };
    case "ready": {
      const join: StatusItem[] = view.enrol.state === "enrolling" ? [{ text: "Joining BB…" }] : [];
      const unknown = box.unreachable || box.backendGone;
      return { tone: tone("ok"), items: [{ text: unknown ? "Last seen ready" : "Ready" }, ...attention, ...join, { text: unknown ? `${shortSpan(now - (box.unreachable?.since ?? box.backendGone!.since))} ago` : `up ${shortSpan(now - upSince(box))}` }, ...sized] };
    }
  }
}

export function startSince(box: FakeBox): number {
  return box.started && box.started.readyAt === null ? box.started.askedAt : box.view.createdAt;
}

export function upSince(box: FakeBox): number {
  return box.started?.readyAt ?? box.view.readyAt ?? box.view.createdAt;
}

export function headline(box: FakeBox, now: number, threads: readonly FakeThread[]): { tone: Tone; words: string; detail: string | null } {
  const view = box.view;
  switch (view.state) {
    case "acquiring":
    case "starting":
      return { tone: "busy", words: "Starting", detail: `for ${span(now - startSince(box))}` };
    case "stopping":
      return { tone: "busy", words: "Stopping…", detail: null };
    case "releasing":
      return { tone: box.operation ? "bad" : "busy", words: box.operation ? "Release did not finish" : "Releasing…", detail: box.operation ? ago(box.operation.at, now) : null };
    case "stopped": {
      const stop = lastStop(box);
      const by = stop ? actorWords(stop.by, threads) : null;
      return { tone: "off", words: "Stopped", detail: stop ? `${span(now - stop.from)} ago, ${dayAndClock(stop.from, now)}${by ? `, ${by}` : ""}` : null };
    }
    case "failed":
      return { tone: "bad", words: "Failed", detail: `${span(now - view.createdAt)} ago` };
    case "gone":
      return { tone: "bad", words: "Gone", detail: "deleted outside bb-box" };
    case "ready":
      if (box.unreachable) return { tone: "warn", words: "Not answering", detail: `last seen ready ${span(now - box.unreachable.since)} ago` };
      if (box.backendGone) return { tone: "warn", words: "Not checked", detail: `last seen ready ${span(now - box.backendGone.since)} ago` };
      return { tone: busyItem(box, now) ? "warn" : "ok", words: "Ready", detail: `up ${span(now - upSince(box))}` };
  }
}

export const STEP_NAMES: Readonly<Record<string, string>> = {
  warm: "Took a warm box",
  "start.boot": "Boot",
  "start.ssh": "SSH",
  clone: "Clone",
  configure: "Configure",
  tags: "Tags",
  start: "Start",
  network: "Network",
  ssh: "SSH",
  enrol: "Join BB",
  spare: "Claimed a spare",
  spareSwitch: "Switch its device",
  spareReconnect: "BB machine back",
  template: "Template",
};

export function formOf(view: BoxView): string {
  if (view.shared) return "Shared slot";
  switch (view.form) {
    case "LXC":
      return "LXC container";
    case "Docker":
      return "Docker container";
    case "VM":
      return "VM";
    case "microVM":
      return "microVM";
    case "Physical":
      return "Physical machine";
    default:
      return "Box";
  }
}

export function systemWords(view: BoxView): string {
  const os = view.os === "macos" ? "macOS" : view.os === "windows" ? "Windows" : "Linux";
  return `${os} ${view.arch}${view.docker ? ", with Docker" : ""}`;
}

export function enrolWords(view: BoxView): string {
  switch (view.enrol.state) {
    case "enrolled":
      return "Joined";
    case "enrolling":
      return "Joining…";
    case "failed":
      return "Could not join";
    default:
      return view.enrols ? "Not yet" : "Off for this kind";
  }
}

export function controlWords(view: BoxView): string | null {
  if (!view.control) return null;
  if (view.control.owner === "agent") return "The agent";
  if (view.control.owner === "none") return "Changing hands";
  return view.control.holder && MY_VIEWERS.has(view.control.holder) ? "You, in this tab" : "Another viewer";
}

export function bytes(gib: number): string {
  return gib >= 10 ? `${Math.round(gib)} GiB` : `${gib.toFixed(1)} GiB`;
}

export function rate(kib: number): string {
  if (kib >= 1024) return `${(kib / 1024).toFixed(1)} MB/s`;
  return `${Math.round(kib)} KB/s`;
}
