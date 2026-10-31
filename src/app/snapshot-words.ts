import type { BoxSize, Holds, Price, SnapshotSize } from "../backends/types.ts";
import type { BoxSnapshotsView, RestorePreview, SnapshotRowView } from "../plugin/contract.ts";

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
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

export function agoWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE_MS));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
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
  return `${symbol}${price.amount} ${price.per === "GB-month" ? "a GB a month" : `a ${price.per}`}`;
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
  return `${holds}${leaves} They go when ${boxName} is released.`;
}

export function attentionWords(row: SnapshotRowView, boxName: string): string | null {
  switch (row.state) {
    case "failed":
      return `Failed${row.error ? `: ${row.error.replace(/\.$/, "")}` : ""}`;
    case "incomplete":
      return `Incomplete${row.error ? `: ${row.error.replace(/\.$/, "")}` : ""}. Delete it to finish the clean-up`;
    case "unavailable":
      return `Unavailable: bb-box cannot reach ${row.host ?? "its host"}`;
    case "lost":
      return `Lost: ${row.host ?? "its host"} no longer has it`;
    default:
      return row.guest === "earlier" ? `On ${boxName}'s earlier guest: fork only` : null;
  }
}

export function restoreWhyNot(row: SnapshotRowView, view: BoxSnapshotsView, boxName: string, boxState: string): string | null {
  if (view.restoring) return `${boxName} is being restored`;
  if (view.unconfirmed) return "bb-box could not confirm its last restore";
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
  if (view.unconfirmed) return "bb-box could not confirm its last restore";
  return row.forkWhy;
}

export function freesWords(row: SnapshotRowView, boxName: string): string {
  if (row.state === "failed" || row.state === "lost") return "It holds nothing to free.";
  const where = row.host ? ` on ${row.host}` : "";
  if (row.size?.means === "own") return `Frees ${gbWords(row.size.bytes)}${where}.`;
  if (row.storage && SHARES_BLOCKS.has(row.storage.type)) return `Frees what it no longer shares with ${boxName}.`;
  return "Its backend does not say how much it frees.";
}

export function sizeBackWords(boxName: string, from: BoxSize | null, to: BoxSize | null): string | null {
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
  return preview.threads.map((thread) => ({ key: `thread:${thread.id}`, words: `${thread.title} is ${thread.running ? "working" : "idle"} on ${boxName}: its worktree, uncommitted files and session there would go.` }));
}

export function otherLosses(preview: RestorePreview): Loss[] {
  const losses: Loss[] = [];
  if (preview.control) losses.push({ key: "control", words: "A person has control of its desktop." });
  if (preview.terminals === null) losses.push({ key: "terminals", words: "bb-box could not tell whether a BB terminal is open on it." });
  else if (preview.terminals > 0) losses.push({ key: "terminals", words: preview.terminals === 1 ? "A terminal is open on it." : `${preview.terminals} terminals are open on it.` });
  return losses;
}

export function undoLabel(preview: RestorePreview): string {
  const undo = preview.check?.undo;
  if (undo?.kind === "held-copy") return `Copy it once stopped, so you can undo this: about ${aboutWords(undo.aboutMs)}${undo.bytes ? ` and ${gbWords(undo.bytes)}` : ""}.`;
  return `Take a snapshot of it, once stopped, so you can undo this.${undo ? ` About ${aboutWords(undo.aboutMs)}.` : ""}`;
}

export function requestId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
