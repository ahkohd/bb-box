import { inSlot } from "../core/device-host.ts";
import { createHash } from "node:crypto";
import type { GpuPart, MachineSize, Holds, Price, SnapshotScope, SnapshotSize, WhileRunning } from "../backends/types.ts";
import type { Actor } from "../core/box-log.ts";
import { BoxError, OPERATOR, type BoxRecord } from "../core/boxes.ts";
import { countsAgainstLimit, eligible, forksOn, isKept, notForkedForScope, notKeptForScope, type Caller, type PictureState, type SnapshotRecord, type SnapshotState, type Standing } from "../core/snapshot.ts";
import { restoreStepWords, unflushedOf, type ForkCheck, type KeepInput, type RestoreCheck, type RestoreGuard, type Snapshots, type TakeCheck } from "../core/snapshots.ts";
import { keepCostWords } from "./snapshot-words.ts";
import { describeSize } from "../core/sizes.ts";
import type { Backend, Snapshotting } from "../backends/types.ts";
import { withinWait } from "../core/snapshot-picture.ts";
import { snapshotGpuWordsFor } from "../core/gpu.ts";
import { PRODUCT } from "../brand.ts";

export const PERSON: Caller = { is: "person" };

const TAKE_CHECK_KEPT_MS = 30_000;
const TAKE_CHECK_WAIT_MS = 2_000;
const RESTORED_NOTICE_MS = 24 * 60 * 60_000;
const CLI_UNDO_HINT = / Or restore without an undo, with --no-undo\.$/;

export function personStanding(box: Pick<BoxRecord, "id" | "threadId">): Standing {
  return { box: { id: box.id, threadId: box.threadId }, runsOn: false };
}

export interface SnapshotRowView {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly state: SnapshotState;
  readonly error: string | null;
  readonly takenAt: number;
  readonly by: Actor;
  readonly scope: SnapshotScope;
  readonly holds: Holds;
  readonly size: SnapshotSize | null;
  readonly storage: { readonly name: string; readonly type: string } | null;
  readonly host: string | null;
  readonly price: Price | null;
  readonly keptUntil: number | null;
  readonly guest: SnapshotRecord["guest"];
  readonly undoOf: { readonly at: number; readonly to: string | null } | null;
  readonly picture: PictureState | null;
  readonly busyWhy: string | null;
  readonly forkWhy: string | null;
  readonly keepWhy: string | null;
  readonly boxGone: { readonly at: number; readonly how: string } | null;
  readonly unflushed: string | null;
  readonly pausedMs: number | null;
  readonly after: readonly string[];
  readonly gpu?: string | null;
}

export interface RestoredView {
  readonly operation: string;
  readonly at: number;
  readonly to: string | null;
  readonly toTakenAt: number | null;
  readonly by: Actor;
  readonly undo: { readonly id: string; readonly name: string; readonly ready: boolean } | null;
  readonly unflushed: string | null;
}

export interface FailedRestoreView {
  readonly operation: string;
  readonly at: number;
  readonly to: string | null;
  readonly error: string;
}

export interface BoxSnapshotsView {
  readonly offer: { readonly holds: readonly Holds[]; readonly scope: SnapshotScope; readonly whileRunning: WhileRunning; readonly restore: "in-place" | "new-guest" | "none"; readonly fork: "copy" | "none"; readonly keeps: boolean; readonly excludes: string | null; readonly price: Price | null } | null;
  readonly keepDays: number;
  readonly noneWhy: string | null;
  readonly perBox: number;
  readonly counted: number;
  readonly undos: number;
  readonly host: string | null;
  readonly takeWhy: string | null;
  readonly screen: boolean;
  readonly pictures: boolean;
  readonly records: readonly SnapshotRowView[];
  readonly restoring: { readonly to: string; readonly step: string | null } | null;
  readonly unconfirmed: { readonly to: string; readonly words: string } | null;
  readonly restored: RestoredView | null;
  readonly failed: FailedRestoreView | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TakeChecks {
  readonly #snapshots: Snapshots;
  readonly #kept = new Map<string, { readonly at: number; readonly key: string; readonly why: string | null }>();
  readonly #now: () => number;

  constructor(snapshots: Snapshots, now: () => number = Date.now) {
    this.#snapshots = snapshots;
    this.#now = now;
  }

  async why(box: BoxRecord): Promise<string | null> {
    const records = this.#snapshots.ledger.records({ box: box.id });
    const key = [box.state, box.restoring?.operation ?? "", this.#snapshots.settings.perBox, ...records.map((record) => `${record.id}:${record.state}`)].join("|");
    const kept = this.#kept.get(box.id);
    if (kept && kept.key === key && this.#now() - kept.at < TAKE_CHECK_KEPT_MS) return kept.why;
    let why: string | null;
    try {
      await withinWait(() => this.#snapshots.checkTake(PERSON, box, personStanding(box)), TAKE_CHECK_WAIT_MS);
      why = null;
    } catch (error) {
      if (!(error instanceof BoxError)) return kept?.why ?? null;
      why = error.message;
    }
    this.#kept.set(box.id, { at: this.#now(), key, why });
    return why;
  }

  forget(boxId: string): void {
    this.#kept.delete(boxId);
  }
}

export function forkWhyOf(record: SnapshotRecord, offer: Snapshotting | null): string | null {
  if (offer?.forkWhy) return offer.forkWhy;
  if (!offer || offer.fork !== "copy") return "its backend forks none";
  if (record.state === "taking") return "it is still being taken";
  if (record.state === "deleting") return "it is being deleted";
  if (record.state !== "ready") return `it is ${record.state}`;
  const notForked = notForkedForScope(record.scope, record.box.name);
  if (notForked) return notForked;
  if (!forksOn(record.box.system)) return `${PRODUCT} forks Linux and macOS boxes only`;
  if (record.forkSafe === null) return `${record.box.name} had no working identity reset when it was taken`;
  if (record.forkSafe < (offer.forkSafeFrom ?? 1)) return `${record.box.name} had an identity reset older than version ${offer.forkSafeFrom} when it was taken`;
  return null;
}

export function keepWhyOf(record: SnapshotRecord, offer: Snapshotting | null, pinned: string | null): string | null {
  if (offer?.keepsPastRelease === "no" && offer.keepWhy) return offer.keepWhy;
  if (offer?.forkWhy) return `${PRODUCT} keeps only what it can fork after a release, and ${offer.forkWhy}`;
  if (!offer || offer.keepsPastRelease === "no") return offer?.keepWhy ?? "its backend keeps nothing past a release";
  if (record.state !== "ready") return `it is ${record.state === "taking" ? "still being taken" : record.state === "deleting" ? "being deleted" : record.state}`;
  if (pinned) return pinned;
  const notKept = notKeptForScope(record.scope, record.box.name);
  if (notKept) return notKept;
  if (record.boxGone && record.guest !== "held-copy" && !(offer.keepsPastRelease === "as-is" && record.keptUntil !== null)) return `its box is gone, and ${PRODUCT} keeps it until you delete it`;
  if (!forksOn(record.box.system)) return `${PRODUCT} keeps only what it can fork after a release, and forks Linux and macOS boxes only`;
  if (record.forkSafe === null) return `taken before ${record.box.name}'s image had the identity reset: it could not be forked after a release`;
  if (record.forkSafe < (offer.forkSafeFrom ?? 1)) return `taken under version ${record.forkSafe} of ${record.box.name}'s identity reset, older than the version ${offer.forkSafeFrom} a fork needs`;
  return null;
}

export function rowOf(snapshots: Snapshots, record: SnapshotRecord, now: number): SnapshotRowView {
  const ledger = snapshots.ledger;
  const pin = ledger.pins().get(record.id) ?? null;
  const verdict = eligible(record, "delete", { pin, now });
  const undoOperation = record.undoOf ? ledger.operation(record.undoOf) : null;
  const undoTarget = undoOperation?.snapshots[0] ? ledger.record(undoOperation.snapshots[0]) : null;
  return {
    id: record.id,
    name: record.name,
    note: record.note,
    state: record.state,
    error: record.error,
    takenAt: record.takenAt,
    by: record.by,
    scope: record.scope,
    holds: record.holds,
    size: record.size,
    storage: record.storage,
    host: record.host,
    price: record.price,
    keptUntil: record.keptUntil,
    guest: record.guest,
    undoOf: undoOperation ? { at: undoOperation.startedAt, to: undoTarget?.name ?? null } : null,
    picture: record.picture,
    busyWhy: verdict.ok ? null : verdict.why,
    forkWhy: forkWhyOf(record, snapshots.offerFor(snapshots.backendOf(record.backend.id), record.box.kind)),
    keepWhy: keepWhyOf(record, snapshots.offerFor(snapshots.backendOf(record.backend.id), record.box.kind), pin ? (eligible(record, "keep", { pin, now }) as { why?: string }).why ?? null : null),
    boxGone: record.boxGone,
    unflushed: record.unflushed ?? null,
    pausedMs: record.pausedMs ?? null,
    gpu: snapshotGpuWordsFor(record.box.system, record.gpu),
    after: record.dependsOn.flatMap((id) => {
      const parent = ledger.record(id);
      return parent ? [parent.name] : [];
    }),
  };
}

function restoredOf(snapshots: Snapshots, box: BoxRecord, now: number): Pick<BoxSnapshotsView, "restoring" | "unconfirmed" | "restored" | "failed"> {
  const none = { restoring: null, unconfirmed: null, restored: null, failed: null };
  const last = snapshots.lastRestore(box.id);
  if (!last) return none;
  const { operation, running } = last;
  const target = operation.snapshots[0] ? snapshots.ledger.record(operation.snapshots[0]) : null;
  const to = target?.name ?? box.restoring?.name ?? "a snapshot since deleted";
  if (operation.state === "running" && running) return { ...none, restoring: { to, step: restoreStepWords(operation.step) } };
  if (operation.state === "running" || operation.state === "unknown") {
    const step = restoreStepWords(operation.step);
    return { ...none, unconfirmed: { to, words: `${operation.error ?? (step ? `It was at ${step} when ${PRODUCT} restarted.` : "It was cut short.")}` } };
  }
  if (now - (operation.endedAt ?? operation.startedAt) > RESTORED_NOTICE_MS) return none;
  if (operation.state === "failed") return { ...none, failed: { operation: operation.id, at: operation.endedAt ?? operation.startedAt, to: target?.name ?? null, error: operation.error ?? `${PRODUCT} gave no reason.` } };
  const undo = operation.undo ? snapshots.ledger.record(operation.undo) : null;
  return {
    ...none,
    restored: {
      operation: operation.id,
      at: operation.startedAt,
      to: target?.name ?? null,
      toTakenAt: target?.takenAt ?? null,
      by: operation.by,
      undo: undo ? { id: undo.id, name: undo.name, ready: undo.state === "ready" } : null,
      unflushed: undo ? unflushedOf(operation) : null,
    },
  };
}

function noneOnBackendWhy(backend: Backend, box: BoxRecord): string {
  const machineWhy = box.guest ? (backend.noSnapshotsWhy?.(box.guest, box.kind) ?? null) : null;
  return machineWhy ? `${box.name} has no snapshots: ${machineWhy.replace(/\.$/, "")}.` : `Boxes on ${box.backendLabel} have no snapshots.`;
}

export function boxSnapshotsView(snapshots: Snapshots, box: BoxRecord, takeWhy: string | null, now: number = Date.now()): BoxSnapshotsView {
  const backend = snapshots.backendOf(box.backend);
  const offer = backend ? snapshots.offerFor(backend, box.kind) : null;
  const records = snapshots.visible(PERSON, personStanding(box)).sort((a, b) => b.takenAt - a.takenAt);
  return {
    offer: offer ? { holds: offer.holds, scope: offer.scope, whileRunning: offer.whileRunning, restore: offer.restore, fork: offer.fork, keeps: offer.keepsPastRelease !== "no", excludes: offer.excludes, price: offer.price } : null,
    keepDays: snapshots.settings.keepDays,
    noneWhy: offer ? null : backend ? noneOnBackendWhy(backend, box) : `The ${box.backendLabel} backend is not in ${PRODUCT}'s settings, so it takes no snapshots of ${box.name}.`,
    perBox: snapshots.settings.perBox,
    counted: records.filter(countsAgainstLimit).length,
    undos: records.filter((record) => record.undoOf !== null && !isKept(record) && record.state !== "failed").length,
    host: box.guest?.host ?? null,
    takeWhy,
    screen: box.capabilities.displays.length > 0 || !!box.device,
    pictures: snapshots.settings.pictures,
    records: records.map((record) => rowOf(snapshots, record, now)),
    ...restoredOf(snapshots, box, now),
  };
}

export interface RestorePreview {
  readonly refusal: string | null;
  readonly threads: readonly { readonly id: string; readonly title: string; readonly running: boolean }[];
  readonly threadsUnread: string | null;
  readonly control: boolean;
  readonly terminals: number | null;
  readonly check: Omit<RestoreCheck, "box" | "snapshot"> | null;
  readonly snapshot: SnapshotRowView | null;
  readonly token: string;
  readonly undoUnflushed: string | null;
  readonly inSlot: boolean;
}

function tokenOf(box: BoxRecord, preview: Omit<RestorePreview, "token" | "undoUnflushed">): string {
  const check = preview.check;
  const shown = {
    target: preview.snapshot?.id ?? null,
    guest: box.guest?.ref ?? null,
    refusal: preview.refusal,
    threads: preview.threads.map((thread) => thread.id).sort(),
    control: preview.control,
    terminals: preview.terminals,
    losses: check ? [...check.anyway].sort() : null,
    undo: check?.undo?.kind ?? null,
    undoRefused: check?.undoRefused !== null && check?.undoRefused !== undefined,
    to: check?.to ?? null,
    swap: check?.swap ?? null,
    fromSnapshot: check?.fromSnapshot ?? null,
    leaves: check?.leavesOnEarlierGuest ?? null,
    gpuStay: check?.gpuStay ?? null,
    userspaceNote: check?.userspaceNote ?? null,
  };
  return createHash("sha256").update(JSON.stringify(shown)).digest("hex").slice(0, 32);
}

export async function restorePreview(snapshots: Snapshots, box: BoxRecord, ref: string, now: number = Date.now()): Promise<RestorePreview> {
  const standing = personStanding(box);
  const record = snapshots.find(PERSON, standing, ref);
  const guard: RestoreGuard = await snapshots.guardOf(box);
  const seen = { threads: guard.threads ?? [], threadsUnread: guard.threadsUnread, control: guard.control, terminals: guard.terminals, snapshot: rowOf(snapshots, record, now), inSlot: inSlot(box) };
  const undoOperation = record.undoOf ? snapshots.ledger.operation(record.undoOf) : null;
  const undoUnflushed = undoOperation ? unflushedOf(undoOperation) : null;
  let preview: Omit<RestorePreview, "token" | "undoUnflushed">;
  try {
    const { box: _box, snapshot: _snapshot, ...check } = await snapshots.checkRestore(PERSON, box, standing, record.id, { force: true }, { undoRefusal: true });
    preview = { ...seen, refusal: null, check: { ...check, undoRefused: check.undoRefused?.replace(CLI_UNDO_HINT, "") ?? null } };
  } catch (error) {
    preview = { ...seen, refusal: message(error), check: null };
  }
  return { ...preview, token: tokenOf(box, preview), undoUnflushed };
}

export interface ForkPreview {
  readonly refusal: string | null;
  readonly check: {
    readonly snapshot: string;
    readonly takenAt: number;
    readonly threadId: string;
    readonly asMachine: boolean;
    readonly canBeMachine: boolean;
    readonly size: string;
    readonly aboutMs: number;
    readonly bytes: number | null;
    readonly host: string | null;
    readonly storage: string;
    readonly unflushed: string | null;
    readonly gpu: GpuPart;
    readonly offersGpu: boolean;
  } | null;
}

export interface ForkStarted {
  readonly error: string | null;
  readonly box: { readonly id: string; readonly name: string } | null;
}

export async function forkPreview(snapshots: Snapshots, box: BoxRecord | null, standing: Standing, ref: string, asMachine: boolean, gpu?: GpuPart): Promise<ForkPreview> {
  try {
    const check: ForkCheck = await snapshots.checkFork(PERSON, { id: standing.box!.id }, standing, ref, { asMachine, ...(gpu ? { gpu } : {}) });
    return {
      refusal: null,
      check: {
        snapshot: check.snapshot.name,
        takenAt: check.snapshot.takenAt,
        threadId: check.threadId,
        asMachine: check.asMachine,
        canBeMachine: !!box && box.threadId !== OPERATOR && box.capabilities.enrol && !isKept(check.snapshot),
        size: describeSize(check.size),
        aboutMs: check.aboutMs,
        bytes: check.bytes,
        host: check.host,
        storage: check.storage,
        unflushed: check.snapshot.unflushed ?? null,
        gpu: check.gpu,
        offersGpu: check.offersGpu,
      },
    };
  } catch (error) {
    return { refusal: message(error), check: null };
  }
}

export interface KeepPreview {
  readonly refusal: string | null;
  readonly check: {
    readonly keptUntil: number;
    readonly current: number | null;
    readonly renews: boolean;
    readonly shortens: boolean;
    readonly gone: boolean;
    readonly cost: string;
    readonly warning: string | null;
    readonly unflushed: string | null;
    readonly defaultDays: number;
  } | null;
}

export async function keepPreview(snapshots: Snapshots, standing: Standing, ref: string, input: KeepInput): Promise<KeepPreview> {
  try {
    const check = await snapshots.checkKeep(PERSON, standing, ref, input);
    return {
      refusal: null,
      check: {
        keptUntil: check.keptUntil,
        current: check.snapshot.keptUntil,
        renews: check.renews,
        shortens: check.shortens,
        gone: check.gone,
        cost: keepCostWords(check),
        warning: check.warning,
        unflushed: check.snapshot.unflushed ?? null,
        defaultDays: snapshots.settings.keepDays,
      },
    };
  } catch (error) {
    return { refusal: message(error), check: null };
  }
}

export interface SnapshotChange {
  readonly error: string | null;
  readonly pending: boolean;
  readonly preview?: RestorePreview;
  readonly unflushed?: string;
}

export async function answered(work: Promise<unknown>, waitMs: number, past?: Promise<unknown>): Promise<SnapshotChange> {
  let settled: SnapshotChange | null = null;
  const done = work.then(
    () => (settled = { error: null, pending: false }),
    (error: unknown) => (settled = { error: message(error), pending: false, ...(error instanceof BoxError && error.code === "unflushed" ? { unflushed: error.message } : {}) }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([done, ...(past ? [past] : []), new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
  return settled ?? { error: null, pending: true };
}

export function restoreStopped(): { readonly stopped: Promise<void>; readonly whenStopped: () => void } {
  let whenStopped = () => {};
  const stopped = new Promise<void>((resolve) => (whenStopped = resolve));
  return { stopped, whenStopped };
}

export type { MachineSize, TakeCheck };
