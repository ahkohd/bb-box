import { DAY, MINUTE, type Actor, type FakeSnap, type FakeThread, type Holds, type Price } from "./data";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function when(at: number, now: number): string {
  if (sameDay(at, now)) return `Today ${clock(at)}`;
  if (sameDay(at, now - DAY)) return `Yesterday ${clock(at)}`;
  if (now - at < 6 * DAY) return `${WEEKDAYS[new Date(at).getDay()]} ${clock(at)}`;
  return day(at);
}

export function whenInSentence(at: number, now: number): string {
  return when(at, now).replace(/^Today/, "today at").replace(/^Yesterday/, "yesterday at");
}

export function clockOf(at: number): string {
  return clock(at);
}

export function day(at: number): string {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

export function daysLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / DAY));
}

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export function holdsWords(holds: Holds): string {
  return holds === "disk" ? "disk" : "disk and memory";
}

export function sizeWords(gb: number | null): string | null {
  if (gb === null) return null;
  return gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb.toFixed(1)} GB`;
}

export function priceWords(price: Price | null): string | null {
  if (!price) return null;
  return `$${price.amount.toFixed(3)} a ${price.per}`;
}

export function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function threadTitle(threads: readonly FakeThread[], id: string): string {
  return threads.find((thread) => thread.id === id)?.title ?? "a thread";
}

export function byWords(by: Actor, threads: readonly FakeThread[], withThread: boolean): string {
  switch (by.is) {
    case "person":
      return "by you";
    case "agent":
      return withThread ? `by the agent in ${threadTitle(threads, by.threadId)}` : "by the agent";
    case "command":
      return "by a bb box command";
    case "bb-box":
      return `by bb-box: ${by.why}`;
    case "form":
      return `on a yes given in ${threadTitle(threads, by.threadId)}`;
  }
}

export interface Life {
  readonly words: string;
  readonly warn: boolean;
}

export function lifeOf(snap: FakeSnap, now: number): Life {
  if (snap.keptUntil === null) return { words: "goes with the box", warn: false };
  const left = daysLeft(snap.keptUntil, now);
  if (left <= 3) return { words: left <= 1 ? "goes tomorrow" : `goes in ${left} days`, warn: true };
  return { words: `kept until ${day(snap.keptUntil)}`, warn: false };
}

export function monthlyRate(snaps: readonly FakeSnap[]): number {
  return snaps.filter((snap) => snap.price && snap.state !== "failed" && snap.state !== "deleting").reduce((total, snap) => total + snap.price!.amount * 30, 0);
}

export function spentThisMonth(snaps: readonly FakeSnap[], deletedSpend: number, now: number): number {
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();
  return snaps.reduce((total, snap) => (snap.price && snap.state !== "failed" ? total + (Math.max(0, now - Math.max(monthStart, snap.takenAt)) / DAY) * snap.price.amount : total), deletedSpend);
}

export function undoName(at: number, taken: readonly string[]): string {
  const base = `before the restore at ${clock(at)}`;
  if (!taken.includes(base)) return base;
  let count = 2;
  while (taken.includes(`${base} (${count})`)) count += 1;
  return `${base} (${count})`;
}

export function plural(count: number, word: string, words = `${word}s`): string {
  return `${count} ${count === 1 ? word : words}`;
}
