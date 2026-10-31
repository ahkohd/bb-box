import type { Backend, Snapshotting } from "../backends/types.ts";
import { OPERATOR, forkedFromWords, type BoxRecord } from "../core/boxes.ts";
import { countsAgainstLimit, dayWords, gbWords, goneWords, holdsWords, priceWords, sizeWords, snapshotLine, snapshottingWords, stateWords, unflushedWords, utcDay, type SnapshotRecord } from "../core/snapshot.ts";
import { describeSize } from "../core/sizes.ts";
import { freedWords, type DeleteAnswer, type ForkAnswer, type ForkCheck, type KeepAnswer, type KeepCheck, type RestoreAnswer, type RestoreCheck, type Snapshots, type TakeAnswer } from "../core/snapshots.ts";
import type { BackendSnapshotsView } from "./configuration.ts";

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export function takenText(answer: TakeAnswer, boxName: string, perBox: number): string {
  const snapshot = answer.snapshot;
  if (!snapshot) return `Snapshot ${answer.operation.snapshots[0] ?? ""} of box ${boxName} was asked for with that request already, and is no longer in bb-box's records.`;
  if (answer.repeated) return `Snapshot "${snapshot.name}" (${snapshot.id}) of box ${boxName} was asked for with that request already. It is ${stateWords(snapshot)}.`;
  const took = snapshot.tookMs !== null ? ` in ${seconds(snapshot.tookMs)}` : "";
  const leaves = snapshot.excludes ? ` It leaves out ${snapshot.excludes}.` : "";
  return [
    `Took snapshot "${snapshot.name}" (${snapshot.id}) of box ${boxName}${took}: it holds its ${holdsWords(snapshot)}.${leaves}`,
    `Size: ${sizeWords(snapshot.size)}. Price: ${priceWords(snapshot.price)}.`,
    ...(snapshot.unflushed ? [`${unflushedWords(snapshot.unflushed)}.`] : []),
    `Box ${boxName} holds ${answer.counted} of ${perBox} snapshots.`,
  ].join("\n");
}

export function deletedText(answer: DeleteAnswer, boxName: string): string {
  const snapshot = answer.snapshot;
  if (!snapshot) return answer.operation?.state === "done" ? `Snapshot ${answer.operation.snapshots[0] ?? ""} of box ${boxName} was deleted already, with that request.` : `The delete asked for with that request ended ${answer.operation?.state ?? "already"}.`;
  if (answer.repeated) return `Snapshot "${snapshot.name}" (${snapshot.id}) of box ${boxName} was asked to be deleted with that request already. It is ${stateWords(snapshot)}.`;
  return `Deleted snapshot "${snapshot.name}" (${snapshot.id}) of box ${boxName}: ${snapshot.guest === "held-copy" ? `its held copy, guest ${snapshot.livesOn.ref}, is deleted` : freedWords(snapshot)}.`;
}

export function restoredText(answer: RestoreAnswer, boxName: string): string {
  const snapshot = answer.snapshot;
  const operation = answer.operation;
  const named = snapshot ? `"${snapshot.name}" (${snapshot.id})` : (operation.snapshots[0] ?? "");
  if (answer.repeated) {
    const how = operation.state === "done" ? "It is done" : operation.state === "failed" ? `It failed: ${operation.error ?? "no reason given"}` : operation.state === "unknown" ? `bb-box could not confirm how it ended: ${operation.error ?? "no reason given"}` : "It is still running";
    return `The restore of box ${boxName} to ${named} was asked for with that request already. ${how}`;
  }
  const processes = snapshot?.holds === "disk-and-memory" ? `It came back running, as it was then, with the credentials its apps held then; what ran since ended.` : "Every process in it ended.";
  const lines = [`Restored box ${boxName} to ${named}${snapshot ? `, taken ${dayWords(snapshot.takenAt)}` : ""}. Everything on its disk since then went. ${processes}`];
  if (answer.newGuest) lines.push("It runs on a new guest made from that snapshot, with the box's own identity, and its old guest is deleted.");
  if (typeof answer.earlier === "number") lines.push(`It runs on a new guest made from that held copy, with the box's own identity. ${answer.earlier === 1 ? "1 snapshot stays" : `${answer.earlier} snapshots stay`} on its earlier guest, which bb-box never starts: fork only.`);
  lines.push(answer.undo ? `Its undo is "${answer.undo.name}" (${answer.undo.id})${answer.undo.guest === "held-copy" ? `, a held copy of the stopped box, guest ${answer.undo.livesOn.ref}` : ""}: restore that to undo this.` : "No undo was taken.");
  if (answer.anyway.length) lines.push(`Restored anyway, though ${answer.anyway.join(", and ")}.`);
  if (answer.unflushed) lines.push(`bb-box could not flush the box's writes before stopping it (${answer.unflushed.replace(/\.$/, "")}), so its undo may miss what was written in the last seconds before the restore.`);
  if (answer.from && answer.to && describeSize(answer.from) !== describeSize(answer.to)) lines.push(`Its size went back from ${describeSize(answer.from)} to ${describeSize(answer.to)}, as it was then.`);
  if (answer.replaced.length) lines.push(`A box keeps two undos, so bb-box deleted the oldest: ${answer.replaced.map((name) => `"${name}"`).join(", ")}.`);
  if (operation.error) lines.push(operation.error.charAt(0).toUpperCase() + operation.error.slice(1).replace(/([^.])$/, "$1."));
  lines.push(`What it did to the world since stays done. Box ${boxName} is ${answer.box?.state ?? "restored"}.`);
  return lines.join("\n");
}

export const FORK_HOLDS = "It gets its own BB machine, address and keys, and never acts as its source. Everything else on its disk comes with it: project secrets, signed-in browsers and keychains. It starts fresh: no apps are running.";

export function forkMayMissWords(snapshot: Pick<SnapshotRecord, "unflushed">): string | null {
  return snapshot.unflushed ? `The snapshot may miss what the box wrote in its last seconds before it: ${unflushedWords(snapshot.unflushed).replace(/, so it may miss .*$/, "")}, so the fork may lack them too.` : null;
}

export function keepCostWords(check: KeepCheck): string {
  const on = `${check.host ? `${check.host}'s ` : ""}${check.storage ?? "its storage"}`;
  const until = utcDay(check.keptUntil);
  if (check.gone) return `Its box was released, so it lives on as a held copy, guest ${check.snapshot.livesOn.ref}, a template that cannot start${check.host ? ` on ${check.host}` : ""}, which bb-box deletes after ${until}.`;
  if (check.way === "as-is") return `If ${check.snapshot.box.name} is released, it stays where it is until ${until}${check.price ? `, at ${priceWords(check.price)}` : ""}.`;
  const space = check.usedBytes !== null ? `about ${gbWords(check.usedBytes)}${check.bytes !== null && check.bytes > check.usedBytes ? `, at most ${gbWords(check.bytes)},` : ""}` : check.bytes !== null ? `up to ${gbWords(check.bytes)}` : "the space its disk uses";
  const time = check.aboutMs !== null ? `up to about ${seconds(check.aboutMs)}` : "a while";
  return `If ${check.snapshot.box.name} is released, bb-box first copies this snapshot in full into a template that cannot start: ${time}, and ${space} on ${on} until ${until}${check.price ? `, at ${priceWords(check.price)}` : ", at no charge"}.`;
}

export function keepCheckText(check: KeepCheck): string {
  const snapshot = check.snapshot;
  const until = utcDay(check.keptUntil);
  const now = snapshot.keptUntil !== null ? `It is kept until ${utcDay(snapshot.keptUntil)} now. ` : "";
  return [
    `${now}Keeping "${snapshot.name}" (${snapshot.id}) of box ${snapshot.box.name} until ${until} makes it yours: no agent can delete it, it outlives its box's release, and a fork of it after then is one of your machines. bb-box deletes it after ${until}.`,
    ...(check.shortens ? [`This shortens its keep, from ${utcDay(snapshot.keptUntil!)} to ${until}.`] : []),
    keepCostWords(check),
    ...(check.warning ? [check.warning] : []),
    ...(snapshot.unflushed ? ["It may miss what the box wrote in its last seconds before it, as bb-box could not flush them first."] : []),
    "Nothing changed.",
  ].join("\n");
}

export function keptText(answer: KeepAnswer): string {
  const snapshot = answer.snapshot;
  const until = utcDay(answer.check.keptUntil);
  if (answer.repeated) return `"${snapshot.name}" (${snapshot.id}) of box ${snapshot.box.name} was kept until ${until} already.`;
  return [`Kept "${snapshot.name}" (${snapshot.id}) of box ${snapshot.box.name} until ${until}.`, keepCostWords(answer.check), ...(answer.check.warning ? [answer.check.warning] : [])].join(" ");
}

export function forkCheckText(check: ForkCheck): string {
  const snapshot = check.snapshot;
  const where = check.asMachine ? "one of your machines" : `a box of thread ${check.threadId}`;
  const space = check.bytes !== null ? ` and ${gbWords(check.bytes)} on ${check.host ? `${check.host}'s ` : ""}${check.storage}` : "";
  return [
    `Forking "${snapshot.name}" (${snapshot.id}) of box ${check.box?.name ?? snapshot.box.name}${snapshot.boxGone ? `, ${goneWords(snapshot.boxGone)},` : ""} taken ${dayWords(snapshot.takenAt)}, would make ${where}, with ${describeSize(check.size)}, as the snapshot holds.`,
    `bb-box copies the snapshot in full, which takes up to about ${seconds(check.aboutMs)}${space}, then starts the copy, checks that it reset its identity, and only then hands it over.`,
    FORK_HOLDS,
    ...(forkMayMissWords(snapshot) ? [forkMayMissWords(snapshot)!] : []),
    "Nothing changed.",
  ].join("\n");
}

export function forkedText(answer: ForkAnswer, box: BoxRecord | null): string {
  const operation = answer.operation;
  const named = answer.snapshot ? `"${answer.snapshot.name}" (${answer.snapshot.id})` : (operation.snapshots[0] ?? "");
  if (!box) return `The fork of ${named} ${answer.repeated ? "asked for with that request already " : ""}has no box in bb-box's records: ${operation.error ?? "it is gone"}.`;
  const again = answer.repeated ? " It was asked for with that request already." : "";
  if (box.state === "failed") return `Fork ${box.name} of ${named} failed: ${box.error ?? "no reason given"}${again}`;
  if (box.state !== "ready") return `Fork ${box.name} of ${named} is ${box.state}.${again}`;
  const where = box.threadId === OPERATOR ? "one of your machines" : `a box of thread ${box.threadId}`;
  const total = typeof box.timings.total === "number" ? ` in ${seconds(box.timings.total)}` : "";
  return [`Forked ${named} into box ${box.name} (${box.id}), ${where}, ready${total}.${again}`, box.fork ? forkedFromWords(box.fork) : "", FORK_HOLDS, answer.snapshot ? (forkMayMissWords(answer.snapshot) ?? "") : ""].filter(Boolean).join("\n");
}

export function restoreCheckText(check: RestoreCheck): string {
  const snapshot = check.snapshot;
  const name = check.box.name;
  const lines = [`Restoring box ${name} to "${snapshot.name}" (${snapshot.id}), taken ${dayWords(snapshot.takenAt)}, would:`];
  lines.push(check.fromSnapshot ? "- stop it, which ends every process in it;" : `- stop it at once, without a clean shutdown;`);
  if (check.undo?.kind === "held-copy") {
    const bytes = check.undo.bytes ? `, up to ${gbWords(check.undo.bytes)} on ${check.storage}` : "";
    lines.push(`- copy it in full, stopped, as its undo "${check.undo.name}": a held copy that cannot start, about ${seconds(check.undo.aboutMs)}${bytes};`);
  } else if (check.undo) {
    lines.push(`- take its undo "${check.undo.name}", a snapshot of it stopped, about ${seconds(check.undo.aboutMs)}${check.undo.price ? `, at ${priceWords(check.undo.price)}` : ""};`);
  } else lines.push("- take no undo, so this cannot be undone;");
  if (check.fromSnapshot) {
    lines.push(`- make it a new guest from that snapshot, with the box's own identity, start it, and delete its old guest${check.costWords ? `. ${check.costWords.replace(/\.$/, "")}` : ""};`);
  } else if (check.swap) {
    const old = check.leavesOnEarlierGuest
      ? `${check.leavesOnEarlierGuest === 1 ? "1 snapshot stays" : `${check.leavesOnEarlierGuest} snapshots stay`} on its old guest, which becomes its earlier guest: fork only`
      : `its old guest holds no snapshot, so bb-box deletes it${check.undo ? "" : ", and with no undo, nothing then holds the box as it is now"}`;
    lines.push(`- make it a new guest from that held copy, with the box's own identity, and start it; ${old};`);
  } else lines.push("- roll its disk back, and start it;");
  if (check.replaces) lines.push(`- once it is done, delete its oldest undo, "${check.replaces}", as a box keeps two;`);
  lines.push("- write its access file first, then its labels, and start its BB machine again.");
  lines.push(`Everything on its disk since then goes. ${snapshot.holds === "disk-and-memory" ? "It comes back running, as it was then, with the credentials its apps held then." : "Every process in it ends."} What it did to the world since stays done.`);
  if (check.from && check.to && describeSize(check.from) !== describeSize(check.to)) lines.push(`It goes back to ${describeSize(check.to)}, as it was then; it has ${describeSize(check.from)} now.`);
  if (snapshot.excludes) lines.push(`It leaves out ${snapshot.excludes}.`);
  if (check.anyway.length) lines.push(`It would also end what is on it now: ${check.anyway.join("; ")}. Restore anyway with --force.`);
  lines.push("Nothing changed. Run it again with --replace instead of --check to restore.");
  return lines.join("\n");
}

export function boxHeading(box: Pick<SnapshotRecord["box"], "id" | "name" | "thread">, backend: string, gone: SnapshotRecord["boxGone"]): string {
  const ended = gone ? ` · ${gone.how === "unknown" ? "gone" : gone.how} ${dayWords(gone.at).slice(0, 10)}` : "";
  return `${box.name} (${box.id}) · ${backend} · thread ${box.thread}${ended}`;
}

export function listText(records: readonly SnapshotRecord[], perBox: number): string {
  const byBox = new Map<string, SnapshotRecord[]>();
  for (const record of records) byBox.set(record.box.id, [...(byBox.get(record.box.id) ?? []), record]);
  const blocks: string[] = [];
  for (const group of byBox.values()) {
    const first = group[0]!;
    const counted = group.filter(countsAgainstLimit).length;
    blocks.push([boxHeading(first.box, first.backend.label, first.boxGone), ...group.map((record) => `  ${snapshotLine(record)}`), `  ${counted} of ${perBox} for this box.`].join("\n"));
  }
  return blocks.join("\n");
}

function briefLine(record: SnapshotRecord): string {
  return `"${record.name}" (${record.id}, ${dayWords(record.takenAt)}, ${holdsWords(record)}, ${record.state})`;
}

export function snapshotStatusLine(box: BoxRecord, offer: Snapshotting | null, seen: { readonly records: readonly SnapshotRecord[]; readonly hidden: number }, perBox: number): string | null {
  if (!offer && !seen.records.length) return null;
  const counted = seen.records.filter(countsAgainstLimit).length;
  const hidden = seen.hidden ? `, and ${seen.hidden === 1 ? "one" : seen.hidden} you cannot see` : "";
  if (!seen.records.length) return `Snapshots: none${hidden}. ${box.backendLabel} takes them of ${snapshottingWords(offer!.holds, offer!.whileRunning)}.`;
  return `Snapshots: ${counted} of ${perBox}: ${seen.records.map(briefLine).join("; ")}${hidden}.`;
}

export function offerSnapshotWords(offer: Snapshotting): string {
  return snapshottingWords(offer.holds, offer.whileRunning);
}

function eachWords(price: NonNullable<Snapshotting["price"]>): string {
  return price.included ? `${priceWords({ ...price, included: 0 })} each past the plan's ${price.included}` : `${priceWords(price)} each`;
}

export function backendSnapshotsView(backend: Backend, kinds: readonly string[], snapshots: Pick<Snapshots, "offerFor" | "paidOn">): BackendSnapshotsView {
  const byWords = new Map<string, string[]>();
  let price: Snapshotting["price"] = null;
  for (const kind of kinds) {
    const offer = snapshots.offerFor(backend, kind);
    if (!offer) continue;
    price ??= offer.price;
    const words = `${offerSnapshotWords(offer)} · ${offer.price ? eachWords(offer.price) : "no charge"}`;
    byWords.set(words, [...(byWords.get(words) ?? []), kind]);
  }
  const paid = snapshots.paidOn(backend.id);
  return {
    offers: [...byWords].map(([words, offered]) => ({ kinds: offered, words })),
    price,
    paid:
      price || paid.held.count
        ? {
            currency: paid.held.currency ?? price?.currency ?? "USD",
            count: paid.held.count,
            unknown: paid.held.unknown,
            monthly: paid.held.monthly,
            spent: paid.spent,
            ceiling: paid.ceiling,
            past: paid.past,
            included: paid.held.billed && !paid.held.estimate ? { included: paid.held.billed.included, used: paid.held.billed.used } : null,
            billing: backend.snapshotBill ? (paid.held.estimate ? "estimate" : "billed") : null,
          }
        : null,
  };
}
