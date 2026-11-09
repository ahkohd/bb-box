import type { MachineSize, Holds, Price, SnapshotSize } from "../backends/types.ts";
import { SNAPSHOT_LIMITS } from "../core/document.ts";
import { keptUntilAfter, utcDay } from "../core/snapshot.ts";
import type { BoxSnapshotsView, RestorePreview, SnapshotRowView } from "../plugin/contract.ts";
import { PRODUCT } from "./product.ts";
import { THIS_BOX_THREAD } from "./thread-title.ts";

const DAY_MS = 24 * 60 * 60_000;
const SHARES_BLOCKS: ReadonlySet<string> = new Set(["lvmthin", "zfspool", "rbd", "btrfs"]);

function clock24(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function snapshotClock(at: number): string {
  return clock24(at);
}

export function snapshotDay(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(at);
}

export const KEEP_SOON_MS = 3 * DAY_MS;

export function keepDay(at: number): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(at);
}

export function keepWords(keptUntil: number, now: number): { readonly words: string; readonly soon: boolean } {
  const left = keptUntil - now;
  if (left >= KEEP_SOON_MS) return { words: `kept until ${keepDay(keptUntil)}`, soon: false };
  const days = Math.max(0, Math.ceil(left / DAY_MS));
  return { words: days <= 1 ? "goes within a day" : `goes in ${days} days`, soon: true };
}

export function utcDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function keepOpeningDate(keptUntil: number | null, keepDays: number, now: number): string {
  if (keptUntil === null || keptUntil <= now) return utcDay(keptUntilAfter(now, keepDays));
  const renewed = Math.min(keptUntilAfter(keptUntil, keepDays), keptUntilAfter(now, SNAPSHOT_LIMITS.keepDays.most));
  return utcDay(renewed < keptUntil ? keptUntil : renewed);
}

export function snapshotWhen(at: number, now: number): string {
  if (sameDay(at, now)) return `Today ${clock24(at)}`;
  if (sameDay(at, now - DAY_MS)) return `Yesterday ${clock24(at)}`;
  if (now - at < 6 * DAY_MS) return `${new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(at)} ${clock24(at)}`;
  return snapshotDay(at);
}

export function whenInSentence(at: number, now: number): string {
  if (sameDay(at, now)) return `today at ${clock24(at)}`;
  if (sameDay(at, now - DAY_MS)) return `yesterday at ${clock24(at)}`;
  if (now - at < 6 * DAY_MS) return `on ${new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(at)} at ${clock24(at)}`;
  return `on ${snapshotDay(at)} at ${clock24(at)}`;
}

export function screenAround(name: string, at: number, now: number): string {
  const clock = clock24(at);
  if (sameDay(at, now)) return `${name}'s screen around ${clock}`;
  if (sameDay(at, now - DAY_MS)) return `${name}'s screen yesterday around ${clock}`;
  if (now - at < 6 * DAY_MS) return `${name}'s screen on ${new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(at)} at ${clock}`;
  return `${name}'s screen on ${snapshotDay(at)} at ${clock}`;
}

export function aboutWords(ms: number): string {
  return ms < 10_000 ? `${Math.max(0.1, ms / 1000).toFixed(1)}\u00a0s` : `${Math.round(ms / 1000)}\u00a0s`;
}

export function gbWords(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb < 1) return `${Math.max(1, Math.round(gb * 1000))} MB`;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export function gibWords(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 10 ? `${Math.round(gib)} GiB` : `${Number(gib.toFixed(1))} GiB`;
}

export function snapshotSizeWords(size: SnapshotSize | null): string {
  if (!size) return "size unknown";
  return size.means === "own" ? gbWords(size.bytes) : `${gbWords(size.bytes)}, some shared`;
}

export function snapshotPriceWords(price: Price | null): string | null {
  if (!price) return null;
  if (!price.known) return "price unknown";
  const symbol = price.currency === "USD" ? "$" : "EUR ";
  return `${symbol}${price.amount} ${price.per === "GB-month" ? "a GB a month" : `a ${price.per}`}${price.included ? ` past the plan's ${price.included}` : ""}`;
}

export function holdsWords(holds: Holds, scope: "box" | "device" = "box"): string {
  if (scope === "device") return "device";
  return holds === "disk" ? "disk" : "disk and memory";
}

export function offerHoldsWords(view: Pick<BoxSnapshotsView, "offer">): string {
  const offer = view.offer;
  if (!offer) return "";
  if (offer.scope === "device") return "device";
  return offer.holds.map((holds) => holdsWords(holds)).join(", or ");
}

export function headWords(view: BoxSnapshotsView): string {
  const undos = view.undos ? `, and ${view.undos === 1 ? "1 undo" : `${view.undos} undos`}` : "";
  return [`${view.counted} of ${view.perBox}${undos}`, offerHoldsWords(view), view.host ? `on ${view.host}` : null].filter(Boolean).join(" · ");
}

export function footerWords(view: BoxSnapshotsView, boxName: string): string {
  const offer = view.offer;
  if (!offer) return view.noneWhy ?? "";
  const leaves = offer.excludes ? ` They leave out ${offer.excludes}.` : "";
  if (offer.scope === "device") return `Snapshots hold the device: its disk and memory, the apps open on it. A restore puts back the device only, not the rest of ${boxName}.${leaves} They go when ${boxName} is released.`;
  const holds = offer.holds.length === 2 ? "Snapshots hold the disk, or the disk and memory when asked." : offer.holds[0] === "disk" ? "Snapshots hold the disk." : `Snapshots hold the disk and memory: ${boxName} pauses for each.`;
  return `${holds}${leaves} They go when ${boxName} is released${offer.keeps ? ", unless kept" : ""}.`;
}

export function attentionWords(row: SnapshotRowView, boxName: string): string | null {
  switch (row.state) {
    case "failed":
      return `Failed${row.error ? `: ${row.error.replace(/\.$/, "")}` : ""}`;
    case "incomplete":
      return `Incomplete${row.error ? `: ${row.error.replace(/\.$/, "")}` : ""}. Delete it to finish the clean-up`;
    case "unavailable":
      return `Unavailable: ${PRODUCT} cannot reach ${row.host ?? "its host"}`;
    case "lost":
      return `Lost: ${row.host ?? "its host"} no longer has it`;
    default:
      return row.guest === "earlier" ? `On ${boxName}'s earlier guest: fork only` : null;
  }
}

export function restoreWhyNot(row: SnapshotRowView, view: BoxSnapshotsView, boxName: string, boxState: string): string | null {
  if (view.restoring) return `${boxName} is being restored`;
  if (view.unconfirmed) return `${PRODUCT} could not confirm its last restore`;
  if (view.offer?.restore === "none") return "its backend restores none";
  if (row.guest === "earlier") return "it is on the earlier guest: fork only";
  if (row.state === "taking") return "it is still being taken";
  if (row.state === "deleting") return "it is being deleted";
  if (row.state !== "ready") return `it is ${row.state}`;
  if (boxState !== "ready" && boxState !== "stopped") return `${boxName} is ${boxState}`;
  return null;
}

export function forkWhyNot(row: SnapshotRowView, view: BoxSnapshotsView, boxName: string): string | null {
  if (view.restoring) return `${boxName} is being restored`;
  if (view.unconfirmed) return `${PRODUCT} could not confirm its last restore`;
  return row.forkWhy;
}

export function freesWords(row: SnapshotRowView, boxName: string): string {
  if (row.state === "failed" || row.state === "lost") return "It holds nothing to free.";
  const where = row.host ? ` on ${row.host}` : "";
  if (row.size?.means === "own") return `Frees ${gbWords(row.size.bytes)}${where}.`;
  if (row.storage && SHARES_BLOCKS.has(row.storage.type)) return `Frees what it no longer shares with ${boxName}.`;
  return "Its backend does not say how much it frees.";
}

export function sizeBackWords(boxName: string, from: MachineSize | null, to: MachineSize | null): string | null {
  if (!from || !to) return null;
  const same = from.cores === to.cores && from.memoryMiB === to.memoryMiB && (to.diskGiB === null || from.diskGiB === to.diskGiB);
  if (same) return null;
  const memory = `${Number((to.memoryMiB / 1024).toFixed(1))} GiB memory`;
  const disk = to.diskGiB !== null && to.diskGiB !== from.diskGiB ? `, and a ${to.diskGiB} GiB disk` : "";
  return `${boxName} goes back to ${to.cores} ${to.cores === 1 ? "core" : "cores"} and ${memory}${disk}, as it was then.`;
}

export interface Loss {
  readonly key: string;
  readonly words: string;
}

export function threadLosses(preview: RestorePreview, boxName: string): Loss[] {
  return preview.threads.map((thread) => ({ key: `thread:${thread.id}`, words: `${thread.title ? `"${thread.title}"` : THIS_BOX_THREAD} is ${thread.running ? "working" : "idle"} on ${boxName}: its worktree, uncommitted files and session there would go.` }));
}

export function otherLosses(preview: RestorePreview): Loss[] {
  const losses: Loss[] = [];
  if (preview.control) losses.push({ key: "control", words: "A person has control of its desktop." });
  if (preview.terminals === null) losses.push({ key: "terminals", words: `${PRODUCT} could not tell whether a BB terminal is open on it.` });
  else if (preview.terminals > 0) losses.push({ key: "terminals", words: preview.terminals === 1 ? "A terminal is open on it." : `${preview.terminals} terminals are open on it.` });
  return losses;
}

export function undoLabel(preview: RestorePreview): string {
  const undo = preview.check?.undo;
  if (undo?.kind === "held-copy") return `Copy it once stopped, so you can undo this: about ${aboutWords(undo.aboutMs)}${undo.bytes ? ` and ${gbWords(undo.bytes)}` : ""}.`;
  const price = undo?.price ? snapshotPriceWords(undo.price) : null;
  const once = preview.check?.capture === "suspend" ? "once suspended, with its memory" : "once stopped";
  return `Take a snapshot of it, ${once}, so you can undo this.${undo ? ` About ${aboutWords(undo.aboutMs)}.` : ""}${price ? ` It costs ${price} until it is deleted.` : ""}`;
}

export function requestId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
