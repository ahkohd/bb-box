import type { Snapshotting } from "../backends/types.ts";
import type { BoxRecord } from "../core/boxes.ts";
import { SNAPSHOTS_PER_BOX, countsAgainstLimit, dayWords, holdsWords, priceWords, sizeWords, snapshotLine, snapshottingWords, stateWords, type SnapshotRecord } from "../core/snapshot.ts";
import { freedWords, type DeleteAnswer, type TakeAnswer } from "../core/snapshots.ts";

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export function takenText(answer: TakeAnswer, boxName: string): string {
  const snapshot = answer.snapshot;
  if (!snapshot) return `Snapshot ${answer.operation.snapshots[0] ?? ""} of box ${boxName} was asked for with that request already, and is no longer in bb-box's records.`;
  if (answer.repeated) return `Snapshot "${snapshot.name}" (${snapshot.id}) of box ${boxName} was asked for with that request already. It is ${stateWords(snapshot)}.`;
  const took = snapshot.tookMs !== null ? ` in ${seconds(snapshot.tookMs)}` : "";
  const leaves = snapshot.excludes ? ` It leaves out ${snapshot.excludes}.` : "";
  return [
    `Took snapshot "${snapshot.name}" (${snapshot.id}) of box ${boxName}${took}: it holds its ${holdsWords(snapshot)}.${leaves}`,
    `Size: ${sizeWords(snapshot.size)}. Price: ${priceWords(snapshot.price)}.`,
    `Box ${boxName} holds ${answer.counted} of ${SNAPSHOTS_PER_BOX} snapshots.`,
  ].join("\n");
}

export function deletedText(answer: DeleteAnswer, boxName: string): string {
  const snapshot = answer.snapshot;
  if (!snapshot) return answer.operation?.state === "done" ? `Snapshot ${answer.operation.snapshots[0] ?? ""} of box ${boxName} was deleted already, with that request.` : `The delete asked for with that request ended ${answer.operation?.state ?? "already"}.`;
  if (answer.repeated) return `Snapshot "${snapshot.name}" (${snapshot.id}) of box ${boxName} was asked to be deleted with that request already. It is ${stateWords(snapshot)}.`;
  return `Deleted snapshot "${snapshot.name}" (${snapshot.id}) of box ${boxName}: ${freedWords(snapshot)}.`;
}

export function boxHeading(box: Pick<SnapshotRecord["box"], "id" | "name" | "thread">, backend: string, gone: SnapshotRecord["boxGone"]): string {
  const ended = gone ? ` · ${gone.how === "unknown" ? "gone" : gone.how} ${dayWords(gone.at).slice(0, 10)}` : "";
  return `${box.name} (${box.id}) · ${backend} · thread ${box.thread}${ended}`;
}

export function listText(records: readonly SnapshotRecord[]): string {
  const byBox = new Map<string, SnapshotRecord[]>();
  for (const record of records) byBox.set(record.box.id, [...(byBox.get(record.box.id) ?? []), record]);
  const blocks: string[] = [];
  for (const group of byBox.values()) {
    const first = group[0]!;
    const counted = group.filter(countsAgainstLimit).length;
    blocks.push([boxHeading(first.box, first.backend.label, first.boxGone), ...group.map((record) => `  ${snapshotLine(record)}`), `  ${counted} of ${SNAPSHOTS_PER_BOX} for this box.`].join("\n"));
  }
  return blocks.join("\n");
}

function briefLine(record: SnapshotRecord): string {
  return `"${record.name}" (${record.id}, ${dayWords(record.takenAt)}, ${holdsWords(record)}, ${record.state})`;
}

export function snapshotStatusLine(box: BoxRecord, offer: Snapshotting | null, seen: { readonly records: readonly SnapshotRecord[]; readonly hidden: number }): string | null {
  if (!offer && !seen.records.length) return null;
  const counted = seen.records.filter(countsAgainstLimit).length;
  const hidden = seen.hidden ? `, and ${seen.hidden === 1 ? "one" : seen.hidden} you cannot see` : "";
  if (!seen.records.length) return `Snapshots: none${hidden}. ${box.backendLabel} takes them of ${snapshottingWords(offer!.holds, offer!.whileRunning)}.`;
  return `Snapshots: ${counted} of ${SNAPSHOTS_PER_BOX}: ${seen.records.map(briefLine).join("; ")}${hidden}.`;
}

export function offerSnapshotWords(offer: Snapshotting): string {
  return snapshottingWords(offer.holds, offer.whileRunning);
}
