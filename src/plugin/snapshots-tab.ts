import { OPERATOR, describeError, type BoxRecord } from "../core/boxes.ts";
import { eligible, gbWords, heldByProvider, keepEndsWithin, KEEP_ENDS_WITHIN_DAYS, utcDay, type SnapshotRecord } from "../core/snapshot.ts";
import { billedWords, moneyWords } from "../core/snapshot-cost.ts";
import { freedWords, standingOfRecord, type KeepInput, type Snapshots } from "../core/snapshots.ts";
import { PERSON, rowOf, type SnapshotRowView } from "./snapshot-card.ts";
import { keepCostWords } from "./snapshot-words.ts";
import { PRODUCT } from "../brand.ts";


export interface TabBox {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly kindLabel: string | null;
  readonly system: string;
  readonly backend: string;
  readonly host: string | null;
  readonly threadId: string | null;
  readonly yours: boolean;
  readonly state: BoxRecord["state"] | null;
  readonly gone: { readonly at: number; readonly how: string } | null;
  readonly screen: boolean;
  readonly restores: boolean;
  readonly forks: boolean;
  readonly perBox: number;
  readonly restoring: boolean;
}

export interface TabRow extends SnapshotRowView {
  readonly restoreWhy: string | null;
}

export interface TabGroup {
  readonly box: TabBox;
  readonly rows: readonly TabRow[];
}

export interface TabLine {
  readonly count: number;
  readonly undos: number;
  readonly byAgents: number;
  readonly hosts: readonly { readonly host: string; readonly bytes: number; readonly unknown: number }[];
  readonly paid: readonly string[];
  readonly attention: readonly string[];
}

export interface SnapshotsTabView {
  readonly groups: readonly TabGroup[];
  readonly line: TabLine;
  readonly keepDays: number;
  readonly none: readonly string[];
}

const UNKNOWN_THREAD = "unknown";

function knownThread(threadId: string): string | null {
  return threadId === UNKNOWN_THREAD || !threadId ? null : threadId;
}

function restoreWhyOf(record: SnapshotRecord, box: BoxRecord | null, restores: boolean, unsettled: boolean): string | null {
  if (!box) return record.guest === "held-copy" ? "its box was released: fork it into a new box instead" : "its box is gone";
  if (box.restoring) return `${box.name} is being restored`;
  if (unsettled) return `${PRODUCT} could not confirm its last restore`;
  if (!restores) return "its backend restores none";
  if (record.guest === "earlier") return "it is on the earlier guest: fork only";
  if (record.guest === "held-copy") return "it is a held copy";
  if (record.state === "taking") return "it is still being taken";
  if (record.state === "deleting") return "it is being deleted";
  if (record.state !== "ready") return `it is ${record.state}`;
  if (box.state !== "ready" && box.state !== "stopped") return `${box.name} is ${box.state}`;
  return null;
}

export function snapshotsTab(snapshots: Snapshots, boxes: readonly BoxRecord[], now: number = Date.now()): SnapshotsTabView {
  const ledger = snapshots.ledger;
  const records = ledger.records();
  const living = new Map(boxes.map((box) => [box.id, box]));
  const unsettledRestores = new Set(ledger.unsettled().filter((operation) => operation.kind === "restore").map((operation) => operation.box));
  const byBox = new Map<string, SnapshotRecord[]>();
  for (const record of records) byBox.set(record.box.id, [...(byBox.get(record.box.id) ?? []), record]);
  const groups: TabGroup[] = [];
  for (const [boxId, held] of byBox) {
    const box = living.get(boxId) ?? null;
    const first = held[0]!;
    const backend = snapshots.backendOf(first.backend.id);
    const offer = snapshots.offerFor(backend, box?.kind ?? first.box.kind);
    const restores = !!offer && offer.restore !== "none";
    const tabBox: TabBox = {
      id: boxId,
      name: box?.name ?? first.box.name,
      kind: box?.kind ?? first.box.kind,
      kindLabel: box?.kindLabel ?? null,
      system: box?.capabilities.os ?? first.box.system,
      backend: box?.backendLabel ?? first.backend.label,
      host: box?.guest?.host ?? first.host,
      threadId: knownThread(box?.threadId ?? first.box.thread),
      yours: (box?.threadId ?? first.box.thread) === OPERATOR,
      state: box?.state ?? null,
      gone: box ? null : (held.find((record) => record.boxGone)?.boxGone ?? { at: first.stateAt, how: "unknown" }),
      screen: box ? box.capabilities.displays.length > 0 || !!box.device : held.some((record) => record.picture === "taken"),
      restores,
      forks: !!offer && offer.fork === "copy",
      perBox: snapshots.settings.perBox,
      restoring: !!box?.restoring,
    };
    const rows = [...held]
      .sort((a, b) => b.takenAt - a.takenAt)
      .map((record): TabRow => ({ ...rowOf(snapshots, record, now), restoreWhy: restoreWhyOf(record, box, restores, unsettledRestores.has(boxId)) }));
    groups.push({ box: tabBox, rows });
  }
  groups.sort((a, b) => (b.rows[0]?.takenAt ?? 0) - (a.rows[0]?.takenAt ?? 0) || a.box.name.localeCompare(b.box.name));
  return { groups, line: lineOf(snapshots, records, now), keepDays: snapshots.settings.keepDays, none: [] };
}

function lineOf(snapshots: Snapshots, records: readonly SnapshotRecord[], now: number): TabLine {
  const held = records.filter(heldByProvider);
  const undos = held.filter((record) => record.undoOf !== null && record.keptUntil === null).length;
  const hosts = new Map<string, { bytes: number; unknown: number }>();
  for (const record of held) {
    const host = record.host ?? record.backend.label;
    const entry = hosts.get(host) ?? { bytes: 0, unknown: 0 };
    if (record.size) entry.bytes += record.size.bytes;
    else entry.unknown++;
    hosts.set(host, entry);
  }
  const paid: string[] = [];
  const attention: string[] = [];
  for (const backendId of new Set(held.filter((record) => record.price).map((record) => record.backend.id))) {
    const rate = snapshots.paidOn(backendId);
    const label = held.find((record) => record.backend.id === backendId)!.backend.label;
    paid.push(`${label} ${billedWords(rate.held) ?? `${moneyWords(rate.held.monthly, rate.held.currency)} a month held`}`);
    if (rate.past) attention.push(`${label} is past its ceiling`);
  }
  const ending = held.filter((record) => keepEndsWithin(record, now, KEEP_ENDS_WITHIN_DAYS)).length;
  if (ending) attention.push(`${ending} ${ending === 1 ? "goes" : "go"} within ${KEEP_ENDS_WITHIN_DAYS} days`);
  const failed = records.filter((record) => record.state === "failed").length;
  if (failed) attention.push(`${failed} ${failed === 1 ? "take" : "takes"} failed`);
  for (const state of ["incomplete", "unavailable", "lost"] as const) {
    const count = records.filter((record) => record.state === state).length;
    if (count) attention.push(`${count} ${state}`);
  }
  const found = records.filter((record) => record.foundAt !== null).length;
  if (found) attention.push(`${found} found, not in ${PRODUCT}'s records`);
  return {
    count: held.length - undos,
    undos,
    byAgents: held.filter((record) => record.by.is === "agent").length,
    hosts: [...hosts].map(([host, entry]) => ({ host, ...entry })),
    paid,
    attention,
  };
}

export type BulkChange = "keep" | "delete";

export interface BulkItem {
  readonly id: string;
  readonly name: string;
  readonly box: string;
  readonly words: string;
}

export interface BulkCheck {
  readonly allowed: readonly BulkItem[];
  readonly skipped: readonly BulkItem[];
}

export interface BulkDone {
  readonly done: readonly BulkItem[];
  readonly refused: readonly BulkItem[];
}

function item(record: SnapshotRecord, words: string): BulkItem {
  return { id: record.id, name: record.name, box: record.box.name, words };
}

function deleteWords(record: SnapshotRecord): string {
  const kept = record.keptUntil !== null ? ` You kept it until ${new Date(record.keptUntil).toISOString().slice(0, 10)}.` : "";
  const undo = record.undoOf !== null ? " It is an undo." : "";
  return `${record.guest === "held-copy" ? `Deletes its held copy, guest ${record.livesOn.ref}${record.host ? ` on ${record.host}` : ""}.` : `${freedWords(record).replace(/^it /, "It ")}.`}${kept}${undo}`;
}

export async function bulkCheck(snapshots: Snapshots, ids: readonly string[], change: BulkChange, input: KeepInput = {}, now: number = Date.now()): Promise<BulkCheck> {
  const allowed: BulkItem[] = [];
  const skipped: BulkItem[] = [];
  for (const id of [...new Set(ids)]) {
    const record = snapshots.ledger.record(id);
    if (!record) {
      skipped.push({ id, name: id, box: "", words: `${PRODUCT} has no such snapshot now.` });
      continue;
    }
    if (change === "delete") {
      const verdict = eligible(record, "delete", { pin: snapshots.ledger.pins().get(id) ?? null, now });
      if (verdict.ok) allowed.push(item(record, deleteWords(record)));
      else skipped.push(item(record, verdict.why));
      continue;
    }
    try {
      const check = await snapshots.checkKeep(PERSON, standingOfRecord(record), record.id, input);
      const until = utcDay(check.keptUntil);
      const now = check.renews ? (check.shortens ? ` This shortens its keep, from ${utcDay(check.snapshot.keptUntil!)}.` : check.keptUntil === check.snapshot.keptUntil ? " It is kept until then already." : ` It is kept until ${utcDay(check.snapshot.keptUntil!)} now.`) : "";
      const unflushed = check.snapshot.unflushed ? " It may miss what its box wrote in the last seconds before it." : "";
      allowed.push(item(record, `Until ${until}.${now} ${keepCostWords(check)}${check.warning ? ` ${check.warning}` : ""}${unflushed}`));
    } catch (error) {
      skipped.push(item(record, describeError(error, "Checking it")));
    }
  }
  return { allowed, skipped };
}

export async function bulkApply(snapshots: Snapshots, ids: readonly string[], change: BulkChange, input: KeepInput = {}): Promise<BulkDone> {
  const done: BulkItem[] = [];
  const refused: BulkItem[] = [];
  for (const id of [...new Set(ids)]) {
    const record = snapshots.ledger.record(id);
    if (!record) {
      refused.push({ id, name: id, box: "", words: `${PRODUCT} has no such snapshot now.` });
      continue;
    }
    try {
      if (change === "delete") {
        await snapshots.delete(PERSON, standingOfRecord(record), record.id);
        done.push(item(record, "Deleted."));
      } else {
        const answer = await snapshots.keep(PERSON, standingOfRecord(record), record.id, input);
        done.push(item(record, `Kept until ${new Date(answer.check.keptUntil).toISOString().slice(0, 10)}.`));
      }
    } catch (error) {
      refused.push(item(record, describeError(error, change === "delete" ? "Deleting it" : "Keeping it")));
    }
  }
  return { done, refused };
}

export function hostBytesWords(line: TabLine): string {
  return line.hosts.map((host) => `${host.bytes ? gbWords(host.bytes) : "an unknown size"}${host.unknown && host.bytes ? " and more" : ""} on ${host.host}`).join(", ");
}
