import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { boxesAt, byAgent, BY_PERSON, snapshotsAt, threadsAt, DAY, type Actor, type BoxEvent, type FakeBox, type FakeSnap, type FakeThread, type NoticeKind, type RestoreNotice, type UndoWay } from "./data";
import { clockOf, money, monthlyRate, seconds, threadTitle, undoName } from "./words";

export interface SnapshotSettings {
  readonly perBox: number;
  readonly roomPercent: number;
  readonly keepDays: number;
  readonly agentsRestore: boolean;
  readonly agentsMemory: boolean;
  readonly pictures: boolean;
  readonly ceiling: number;
}

export const DEFAULT_SETTINGS: SnapshotSettings = { perBox: 5, roomPercent: 85, keepDays: 30, agentsRestore: true, agentsMemory: true, pictures: true, ceiling: 5 };
export const UNDOS_A_BOX = 2;
export const SWEEP_DELETES_AT = 7;

export interface Toast {
  readonly words: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

export type Outcome = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly why: string };

export interface TakeAsk {
  readonly name: string;
  readonly note: string;
  readonly memory: boolean;
}

export interface Loss {
  readonly words: string;
  readonly stopsAgent: boolean;
}

export interface RestorePlan {
  readonly refused: string | null;
  readonly undoWay: UndoWay;
  readonly undoAboutMs: number;
  readonly undoGB: number | null;
  readonly sizeBack: string | null;
  readonly swap: boolean;
  readonly leavesOnEarlierGuest: number;
}

export interface Skipped {
  readonly name: string;
  readonly why: string;
}

export interface PersonForm {
  readonly id: string;
  readonly threadId: string;
  readonly boxId: string;
  readonly snapId: string;
  readonly askedAt: number;
  readonly state: "waiting" | "waiting-idle" | "restoring" | "done" | "cancelled" | "refused";
  readonly words: string | null;
}

interface Store {
  readonly now: number;
  readonly boxes: readonly FakeBox[];
  readonly snaps: readonly FakeSnap[];
  readonly threads: readonly FakeThread[];
  readonly events: readonly BoxEvent[];
  readonly notices: readonly RestoreNotice[];
  readonly forms: readonly PersonForm[];
  readonly settings: SnapshotSettings;
  readonly toast: Toast | null;
  readonly failNext: boolean;
  readonly undoOpen: string | null;
  readonly deletedSpend: number;
  readonly pinned: ReadonlySet<string>;
  setFailNext(on: boolean): void;
  setSettings(change: Partial<SnapshotSettings>): void;
  counted(boxId: string): readonly FakeSnap[];
  undos(boxId: string): readonly FakeSnap[];
  losses(boxId: string, by: Actor): readonly Loss[];
  plan(boxId: string, snapId: string): RestorePlan;
  whyNotKeep(snapId: string): string | null;
  whyNotFork(snapId: string): string | null;
  whyNotDelete(snapId: string): string | null;
  take(boxId: string, ask: TakeAsk, by: Actor): Outcome;
  whyNotTake(boxId: string, by: Actor, memory: boolean): string | null;
  restore(boxId: string, snapId: string, options: { readonly undo: boolean; readonly anyway: boolean; readonly consentIn?: string; readonly formId?: string }, by: Actor): Outcome;
  fork(snapId: string, into: "thread" | "machine", name: string): Outcome;
  keep(ids: readonly string[], until: number | null): readonly Skipped[];
  rename(id: string, name: string): void;
  annotate(id: string, note: string): void;
  remove(ids: readonly string[], by: Actor): readonly Skipped[];
  dismissNotice(boxId: string): void;
  askUndo(snapId: string | null): void;
  agentDemo(): void;
  askPerson(): void;
  submitForm(id: string): void;
  cancelForm(id: string): void;
  restartMidRestore(): void;
  checkNow(boxId: string): void;
  fillStorage(host: string): void;
  fixToken(host: string): void;
  unlock(boxId: string): void;
  say(toast: Toast | string): void;
  rate(): number;
  reset(): void;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("No store");
  return store;
}

const FORK_NAMES = ["keen-otter", "bold-finch", "warm-cedar", "swift-lark", "quiet-heron", "lucky-reef"];

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36).slice(-6)}${counter.toString(36).padStart(4, "0")}`.slice(0, 14);
}

function alive(snap: FakeSnap): boolean {
  return snap.state !== "failed" && snap.state !== "deleting";
}

function isUndoSlot(snap: FakeSnap): boolean {
  return snap.undoOf !== null && snap.keptUntil === null;
}

export function heldCopySeconds(usedGB: number): number {
  return Math.max(4, Math.round((usedGB / 4) * 9));
}

function onBoxPage(boxId: string): boolean {
  return location.hash.includes(boxId);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const born = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [boxes, setBoxes] = useState<FakeBox[]>(() => boxesAt(born.current));
  const [snaps, setSnaps] = useState<FakeSnap[]>(() => snapshotsAt(born.current));
  const [threads, setThreads] = useState<FakeThread[]>(() => threadsAt());
  const [events, setEvents] = useState<BoxEvent[]>([]);
  const [notices, setNotices] = useState<RestoreNotice[]>([]);
  const [forms, setForms] = useState<PersonForm[]>([]);
  const [settings, setSettingsState] = useState<SnapshotSettings>(DEFAULT_SETTINGS);
  const [toast, setToast] = useState<Toast | null>(null);
  const [failNext, setFailNext] = useState(false);
  const [undoOpen, setUndoOpen] = useState<string | null>(null);
  const [deletedSpend, setDeletedSpend] = useState(0);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef<number[]>([]);
  const boxesRef = useRef(boxes);
  const snapsRef = useRef(snaps);
  const threadsRef = useRef(threads);
  const settingsRef = useRef(settings);
  const failRef = useRef(failNext);
  const pinnedRef = useRef(pinned);
  const cancelled = useRef(new Set<string>());
  boxesRef.current = boxes;
  snapsRef.current = snaps;
  threadsRef.current = threads;
  settingsRef.current = settings;
  failRef.current = failNext;
  pinnedRef.current = pinned;

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, []);

  const later = useCallback((ms: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, ms));
  }, []);

  const say = useCallback((next: Toast | string) => {
    const shown = typeof next === "string" ? { words: next } : next;
    setToast(shown);
    later(shown.action ? 8_000 : 3_600, () => setToast((current) => (current === shown ? null : current)));
  }, [later]);

  const log = useCallback((boxId: string, words: string, by: Actor) => {
    setEvents((current) => [{ boxId, at: Date.now(), words, by }, ...current]);
  }, []);

  const pin = useCallback((ids: readonly string[], on: boolean) => {
    const next = new Set(pinnedRef.current);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  const setSnapsNow = useCallback((next: (current: FakeSnap[]) => FakeSnap[]) => {
    snapsRef.current = next(snapsRef.current);
    setSnaps(snapsRef.current);
  }, []);

  const updateSnap = useCallback((id: string, change: Partial<FakeSnap>) => setSnapsNow((current) => current.map((snap) => (snap.id === id ? { ...snap, ...change } : snap))), [setSnapsNow]);

  const updateBox = useCallback((id: string, change: Partial<FakeBox>) => {
    boxesRef.current = boxesRef.current.map((box) => (box.id === id ? { ...box, ...change } : box));
    setBoxes(boxesRef.current);
  }, []);

  const notice = useCallback((kind: NoticeKind, boxId: string, to: FakeSnap | null, by: Actor, undoId: string | null, consentIn: string | null) => {
    const shown: RestoreNotice = { kind, boxId, at: Date.now(), to: to?.name ?? "", toAt: to?.takenAt ?? 0, by, consentIn, undoId };
    setNotices((current) => [shown, ...current.filter((each) => each.boxId !== boxId)]);
  }, []);

  const counted = useCallback((boxId: string) => snapsRef.current.filter((snap) => snap.boxId === boxId && alive(snap) && !isUndoSlot(snap)), []);
  const undos = useCallback((boxId: string) => snapsRef.current.filter((snap) => snap.boxId === boxId && alive(snap) && isUndoSlot(snap)), []);
  const rate = useCallback(() => monthlyRate(snapsRef.current), []);

  const losses = useCallback((boxId: string, by: Actor): Loss[] => {
    const box = boxesRef.current.find((each) => each.id === boxId);
    if (!box) return [];
    const ownBox = by.is === "agent" && box.threadId === by.threadId;
    const found: Loss[] = box.workspaces.map((threadId) => {
      const thread = threadsRef.current.find((each) => each.id === threadId);
      const title = thread?.title ?? "A thread";
      const stopsAgent = !(ownBox && by.is === "agent" && threadId === by.threadId);
      return { words: thread?.running ? `${title} is working on ${box.name}: its worktree, uncommitted files and session there go.` : `${title} is idle on ${box.name}: its worktree, uncommitted files and session there go.`, stopsAgent };
    });
    if (box.personControl) found.push({ words: "You have control of its desktop.", stopsAgent: true });
    if (box.terminalOpen) found.push({ words: "A terminal is open on it.", stopsAgent: true });
    return found;
  }, []);

  const plan = useCallback((boxId: string, snapId: string): RestorePlan => {
    const box = boxesRef.current.find((each) => each.id === boxId)!;
    const target = snapsRef.current.find((snap) => snap.id === snapId);
    const cap = box.snapshotting;
    const undoWay: UndoWay = box.storage?.newestOnly ? "held-copy" : cap?.holds.length === 1 && cap.holds[0] === "disk-and-memory" && cap.scope === "box" ? "suspend-copy" : "snapshot";
    const undoAboutMs = undoWay === "held-copy" ? heldCopySeconds(box.usedGB) * 1000 : undoWay === "suspend-copy" ? 20_000 : cap?.takesAboutMs ?? 1_000;
    const undoGB = undoWay === "held-copy" ? box.usedGB : null;
    const swap = target?.undoWay === "held-copy";
    const native = (snap: FakeSnap) => snap.boxId === boxId && alive(snap) && snap.undoWay !== "held-copy" && !snap.onEarlierGuest;
    const leavesOnEarlierGuest = swap ? snapsRef.current.filter(native).length : 0;
    let refused: string | null = null;
    if (box.locked) refused = `Proxmox left ${box.name} locked (${box.locked}). bb-box's token cannot unlock it: run \`pct unlock ${box.vmid}\` on ${box.host}.`;
    else if (target?.onEarlierGuest) refused = `"${target.name}" is on ${box.name}'s earlier guest: it can be forked or kept, not restored.`;
    else if (target && box.storage?.newestOnly && !swap) {
      const newer = snapsRef.current.filter((snap) => native(snap) && snap.takenAt > target.takenAt).length;
      if (newer) refused = `${box.host} uses ZFS, which restores only the newest snapshot. Fork this one, or delete the ${newer === 1 ? "newer one" : `${newer} newer ones`} yourself first.`;
    }
    const then = target?.sizeThen;
    const sizeBack = then && (then.cores !== box.cores || then.memoryGiB !== box.memoryGiB) ? `${box.name} goes back to ${then.cores} cores and ${then.memoryGiB} GiB memory, as it was then.` : null;
    return { refused, undoWay, undoAboutMs, undoGB, sizeBack, swap, leavesOnEarlierGuest };
  }, []);

  const whyNotFork = useCallback((snapId: string): string | null => {
    const snap = snapsRef.current.find((each) => each.id === snapId);
    const box = snap && boxesRef.current.find((each) => each.id === snap.boxId);
    if (!snap || !box) return "That snapshot is gone.";
    if (box.snapshotting?.fork === "none") return box.snapshotting.scope === "device" ? "A device snapshot restores the device only; it does not fork." : `${box.backend}'s ${box.kindLabel} boxes do not fork yet.`;
    if (!snap.forkSafe) return `Taken before ${box.name}'s image had the identity reset: a fork could act as ${box.name}.`;
    return null;
  }, []);

  const whyNotKeep = useCallback((snapId: string): string | null => {
    const snap = snapsRef.current.find((each) => each.id === snapId);
    const box = snap && boxesRef.current.find((each) => each.id === snap.boxId);
    if (!snap || !box) return "That snapshot is gone.";
    if (box.snapshotting?.keeps === "no") return box.snapshotting.keepsWhyNot ?? "This backend cannot keep a snapshot past the release.";
    const fork = whyNotFork(snapId);
    if (fork) return `It could not be used after a release. ${fork}`;
    if (snap.price && rate() > settingsRef.current.ceiling) return `Snapshots held on ${box.backend} come to ${money(rate())} a month, past your ceiling of ${money(settingsRef.current.ceiling)}. Raise it or delete some first.`;
    return null;
  }, [whyNotFork, rate]);

  const whyNotDelete = useCallback((snapId: string): string | null => {
    const snap = snapsRef.current.find((each) => each.id === snapId);
    if (!snap) return "That snapshot is gone.";
    if (pinnedRef.current.has(snapId)) return "a restore is using it";
    if (snap.state === "taking" || snap.state === "deleting") return snap.state === "taking" ? "it is being taken" : "it is being deleted";
    return null;
  }, []);

  const whyNotTake = useCallback((boxId: string, by: Actor, memory: boolean): string | null => {
    const box = boxesRef.current.find((each) => each.id === boxId);
    if (!box) return "That box is gone.";
    if (!box.snapshotting) return box.noSnapshotsWhy ?? `${box.name} has no snapshots.`;
    if (box.cannotTakeWhy) return box.cannotTakeWhy;
    if (box.locked) return `Proxmox left ${box.name} locked (${box.locked}). Run \`pct unlock ${box.vmid}\` on ${box.host}.`;
    if (box.state !== "ready" && box.state !== "stopped") return `${box.name} is ${box.state === "restoring" ? "being restored" : box.state === "unconfirmed" ? "waiting for bb-box to confirm a restore" : "starting"}.`;
    const limit = settingsRef.current.perBox;
    const held = counted(boxId);
    if (held.length >= limit) {
      const replaceable = held.filter((snap) => by.is === "agent" && snap.by.is === "agent" && snap.by.threadId === by.threadId && snap.keptUntil === null && !pinnedRef.current.has(snap.id));
      if (!replaceable.length) return `${box.name} has ${limit} of ${limit} snapshots. Delete one first, or raise the limit in Settings.`;
    }
    const full = box.storage?.full ?? 0;
    if (full >= settingsRef.current.roomPercent) return `${box.host}'s ${box.storage?.name} is ${full}% full, past the ${settingsRef.current.roomPercent}% set in Settings.`;
    if (memory && full + 6 >= settingsRef.current.roomPercent) return `A memory snapshot needs up to ${box.memoryGiB} GiB more on ${box.host}, which would pass ${settingsRef.current.roomPercent}% full.`;
    const price = box.snapshotting.price;
    if (price) {
      const next = rate() + price.amount * 30;
      if (next > settingsRef.current.ceiling) return `It would bring snapshots held on ${box.backend} to about ${money(next)} a month, past your ceiling of ${money(settingsRef.current.ceiling)}.`;
    }
    return null;
  }, [counted, rate]);

  const evictAfter = useCallback((boxId: string, by: Actor, protect: readonly string[]) => {
    if (by.is !== "agent") return;
    const held = counted(boxId);
    if (held.length <= settingsRef.current.perBox) return;
    const oldest = held.filter((snap) => snap.by.is === "agent" && snap.by.threadId === by.threadId && snap.keptUntil === null && !protect.includes(snap.id) && !pinnedRef.current.has(snap.id)).sort((a, b) => a.takenAt - b.takenAt)[0];
    if (!oldest) return;
    setSnapsNow((current) => current.filter((snap) => snap.id !== oldest.id));
    log(boxId, `Deleted "${oldest.name}": the limit of ${settingsRef.current.perBox} a box`, { is: "bb-box", why: "the per-box limit" });
  }, [counted, setSnapsNow, log]);

  const pruneUndos = useCallback((boxId: string, keepId: string) => {
    const spare = undos(boxId).filter((snap) => snap.id !== keepId && !pinnedRef.current.has(snap.id)).sort((a, b) => a.takenAt - b.takenAt);
    const over = undos(boxId).length - UNDOS_A_BOX;
    if (over <= 0) return;
    const going = spare.slice(0, over);
    if (!going.length) return;
    setSnapsNow((current) => current.filter((snap) => !going.some((each) => each.id === snap.id)));
    for (const each of going) log(boxId, `Deleted the oldest undo, "${each.name}": ${UNDOS_A_BOX} a box`, { is: "bb-box", why: "undos a box" });
  }, [undos, setSnapsNow, log]);

  const startTake = useCallback((box: FakeBox, ask: TakeAsk, by: Actor, undoOf: FakeSnap["undoOf"], undoWay: UndoWay | null): FakeSnap => {
    const at = Date.now();
    const memoryOnly = box.snapshotting?.holds.length === 1 && box.snapshotting.holds[0] === "disk-and-memory";
    const taking: FakeSnap = {
      id: newId("sn"),
      boxId: box.id,
      name: ask.name.trim() || `Today ${clockOf(at)}`,
      note: ask.note.trim() || null,
      takenAt: at,
      tookMs: null,
      by,
      holds: undoWay === "held-copy" ? "disk" : (ask.memory && !undoOf) || memoryOnly ? "disk-and-memory" : "disk",
      sizeGB: null,
      price: box.snapshotting?.price ?? null,
      keptUntil: null,
      undoOf,
      undoWay,
      heldCopyGB: undoWay === "held-copy" ? box.usedGB : null,
      sizeThen: { cores: box.cores, memoryGiB: box.memoryGiB },
      forkSafe: box.forkReset,
      onEarlierGuest: false,
      picture: settingsRef.current.pictures && box.screen !== "none" ? 40 + Math.floor(Math.random() * 60) : null,
      state: "taking",
      error: null,
    };
    setSnapsNow((current) => [...current, taking]);
    return taking;
  }, [setSnapsNow]);

  const takeMs = (box: FakeBox, memory: boolean) => {
    const cap = box.snapshotting!;
    if (memory && cap.memorySecondsPerGiB) return Math.min(box.memoryGiB * cap.memorySecondsPerGiB * 1000, 4_000);
    return Math.min(cap.takesAboutMs, 1_400);
  };

  const take = useCallback((boxId: string, ask: TakeAsk, by: Actor): Outcome => {
    const why = whyNotTake(boxId, by, ask.memory);
    if (why) return { ok: false, why };
    const box = boxesRef.current.find((each) => each.id === boxId)!;
    const taking = startTake(box, ask, by, null, null);
    const ms = takeMs(box, taking.holds === "disk-and-memory");
    const fails = failRef.current;
    later(ms, () => {
      if (fails) {
        setFailNext(false);
        updateSnap(taking.id, { state: "failed", error: `Proxmox: VM ${box.vmid} is locked (backup).` });
        log(box.id, `Snapshot "${taking.name}" failed: the box is locked by a backup`, by);
        return;
      }
      const size = box.snapshotting?.sizeKnown ? Math.round((0.15 + Math.random() * 0.9 + (taking.holds === "disk-and-memory" ? box.memoryGiB * 0.3 : 0)) * 10) / 10 : null;
      updateSnap(taking.id, { state: "ready", tookMs: ms + Math.round(Math.random() * 120), sizeGB: size });
      log(box.id, `Took snapshot "${taking.name}" (${box.snapshotting?.scope === "device" ? "device" : taking.holds === "disk" ? "disk" : "disk and memory"})`, by);
      evictAfter(boxId, by, [taking.id]);
    });
    return { ok: true, id: taking.id };
  }, [whyNotTake, startTake, later, updateSnap, log, evictAfter]);

  const updateForm = useCallback((id: string, change: Partial<PersonForm>) => setForms((current) => current.map((form) => (form.id === id ? { ...form, ...change } : form))), []);

  const restore = useCallback((boxId: string, snapId: string, options: { readonly undo: boolean; readonly anyway: boolean; readonly consentIn?: string; readonly formId?: string }, by: Actor): Outcome => {
    const box = boxesRef.current.find((each) => each.id === boxId);
    const target = snapsRef.current.find((snap) => snap.id === snapId);
    if (!box || !target) return { ok: false, why: "That snapshot is gone." };
    if (box.state !== "ready" && box.state !== "stopped") return { ok: false, why: `${box.name} is busy: ${box.state}.` };
    if (snapsRef.current.some((snap) => snap.boxId === boxId && snap.state === "taking")) return { ok: false, why: `A snapshot of ${box.name} is being taken. Try again when it is done.` };
    const planned = plan(boxId, snapId);
    if (planned.refused) return { ok: false, why: planned.refused };
    const undo = by.is === "agent" ? true : options.undo;
    if (by.is === "agent") {
      if (!settingsRef.current.agentsRestore) return { ok: false, why: "Agents may not restore boxes by themselves: Settings turned it off. Ask through the form." };
      if (target.holds === "disk-and-memory" && box.snapshotting?.scope === "box" && !settingsRef.current.agentsMemory) return { ok: false, why: "Agents may not restore memory snapshots: Settings turned it off." };
      const blocking = losses(boxId, by).filter((loss) => loss.stopsAgent);
      if (blocking.length) return { ok: false, why: `Refused, as the restore would lose: ${blocking.map((loss) => loss.words).join(" ")}` };
    } else if (!options.anyway && losses(boxId, by).length) {
      return { ok: false, why: "Confirm what goes first." };
    }
    const op = newId("op");
    const at = Date.now();
    pin([target.id], true);
    const step = (ms: number, words: string, then?: () => void) =>
      later(ms, () => {
        if (cancelled.current.has(op)) return;
        updateBox(boxId, { state: "restoring", step: words });
        then?.();
      });
    log(box.id, `Restore to "${target.name}" asked${undo ? "" : ", no undo"}${options.consentIn ? `, on a yes given in ${options.consentIn}` : ""}`, by);
    updateBox(boxId, { state: "restoring", step: "Stopping" });
    let undoSnap: FakeSnap | null = null;
    const undoMs = undo ? Math.min(planned.undoAboutMs, planned.undoWay === "held-copy" ? 2_500 : 900) : 0;
    if (undo) {
      later(400, () => {
        if (cancelled.current.has(op)) return;
        const names = snapsRef.current.filter((snap) => snap.boxId === boxId).map((snap) => snap.name);
        const current = boxesRef.current.find((each) => each.id === boxId)!;
        updateBox(boxId, { step: planned.undoWay === "held-copy" ? `Copying ${box.name}, stopped, for the undo` : "Taking the undo, of the stopped box" });
        undoSnap = startTake(current, { name: undoName(at, names), note: "", memory: false }, by, { at, to: target.name }, planned.undoWay);
        const taken = undoSnap;
        pin([taken.id], true);
        later(undoMs, () => {
          updateSnap(taken.id, { state: "ready", tookMs: undoMs, sizeGB: box.snapshotting?.sizeKnown ? (planned.undoGB ?? 0.6) : null });
          log(box.id, `Took the undo, "${taken.name}"${planned.undoWay === "held-copy" ? ", a held copy made a template" : ""}`, by);
          pruneUndos(boxId, taken.id);
        });
      });
    }
    const base = 400 + undoMs;
    step(base + 200, planned.swap ? "Making a new guest from the copy, with the box's identity" : `Rolling back to "${target.name}"`, () => {
      if (!failRef.current) return;
      cancelled.current.add(op);
      setFailNext(false);
      pin([target.id, ...(undoSnap ? [undoSnap.id] : [])], false);
      updateBox(boxId, { state: "stopped", step: null, locked: "rollback" });
      log(box.id, `Restore failed: Proxmox's rollback task stopped and left the container locked. bb-box then found ${box.name} stopped, and cannot start it until the lock is cleared. The undo is kept.`, by);
      if (options.formId) updateForm(options.formId, { state: "refused", words: "The restore failed: Proxmox left the box locked. Nothing more was changed; the undo is kept." });
      if (!onBoxPage(boxId)) say(`Restoring ${box.name} failed, and Proxmox left it locked.`);
    });
    step(base + 1_200, box.snapshotting?.scope === "device" ? "Loading the device's snapshot" : target.holds === "disk-and-memory" ? "Resuming" : "Starting");
    step(base + 1_900, "Writing current access over SSH, first");
    step(base + 2_600, "Joining BB again, as the same machine");
    later(base + 3_300, () => {
      if (cancelled.current.has(op)) return;
      const then = target.sizeThen;
      if (planned.swap) {
        setSnapsNow((current) => current.map((snap) => (snap.boxId === boxId && alive(snap) && snap.id !== target.id && snap.id !== undoSnap?.id && snap.undoWay !== "held-copy" ? { ...snap, onEarlierGuest: true } : snap)));
        log(box.id, `Its guest was swapped for a new one made from "${target.name}", with the box's identity; ${planned.leavesOnEarlierGuest} snapshots stay on its earlier guest, fork only`, by);
      }
      pin([target.id, ...(undoSnap ? [undoSnap.id] : [])], false);
      updateBox(boxId, { state: "ready", step: null, ...(then ? { cores: then.cores, memoryGiB: then.memoryGiB } : {}) });
      notice("restored", boxId, target, by, undoSnap?.id ?? null, options.consentIn ?? null);
      log(box.id, `Restored to "${target.name}"${planned.sizeBack ? `; ${then!.cores} cores and ${then!.memoryGiB} GiB memory, as then` : ""}`, by);
      if (options.formId) updateForm(options.formId, { state: "done", words: `Restored ${box.name} on a yes given in the thread. The undo, "${undoSnap?.name ?? "none"}", is kept.` });
      if (by.is === "person" && !onBoxPage(boxId)) say({ words: `Restored ${box.name} to "${target.name}".`, ...(undoSnap ? { action: { label: "Undo", run: () => setUndoOpen(undoSnap!.id) } } : {}) });
    });
    return { ok: true, id: op };
  }, [plan, losses, pin, startTake, later, updateBox, updateSnap, log, pruneUndos, setSnapsNow, notice, updateForm, say]);

  const fork = useCallback((snapId: string, into: "thread" | "machine", name: string): Outcome => {
    const source = snapsRef.current.find((snap) => snap.id === snapId);
    const box = source && boxesRef.current.find((each) => each.id === source.boxId);
    if (!source || !box) return { ok: false, why: "That snapshot is gone." };
    const why = whyNotFork(snapId);
    if (why) return { ok: false, why };
    if (failRef.current) {
      setFailNext(false);
      return { ok: false, why: `${box.host} has 6 GiB of memory free, and the fork needs ${box.memoryGiB} GiB.` };
    }
    const id = newId("bx");
    const fresh: FakeBox = {
      ...box,
      id,
      name,
      threadId: into === "thread" ? box.threadId : null,
      workspaces: [],
      personControl: false,
      terminalOpen: false,
      state: "starting",
      step: "Copying the snapshot",
      createdAt: Date.now(),
      releasedAt: null,
      forkedFrom: { box: box.name, snapshot: source.name, takenAt: source.takenAt },
      cannotTakeWhy: null,
      locked: null,
      ...(source.sizeThen ? { cores: source.sizeThen.cores, memoryGiB: source.sizeThen.memoryGiB } : {}),
    };
    boxesRef.current = [...boxesRef.current, fresh];
    setBoxes(boxesRef.current);
    pin([snapId], true);
    log(box.id, `Forked "${source.name}" into ${name}`, BY_PERSON);
    log(id, `Made from ${box.name}'s snapshot "${source.name}"`, BY_PERSON);
    later(1_600, () => {
      pin([snapId], false);
      updateBox(id, { step: "First boot: new MAC addresses, so the identity reset runs before the network" });
    });
    later(2_800, () => updateBox(id, { step: "Checking its source's credentials are gone" }));
    later(3_600, () => updateBox(id, { step: "Joining BB as a new machine" }));
    later(4_400, () => updateBox(id, { state: "ready", step: null }));
    return { ok: true, id };
  }, [whyNotFork, later, log, updateBox, pin]);

  const keep = useCallback((ids: readonly string[], until: number | null): Skipped[] => {
    const skipped: Skipped[] = [];
    const allowed: string[] = [];
    for (const id of ids) {
      const snap = snapsRef.current.find((each) => each.id === id);
      if (!snap) continue;
      const why = until === null ? null : whyNotKeep(id);
      if (why) skipped.push({ name: snap.name, why });
      else allowed.push(id);
    }
    setSnapsNow((current) => current.map((snap) => (allowed.includes(snap.id) ? { ...snap, keptUntil: until } : snap)));
    for (const id of allowed) {
      const snap = snapsRef.current.find((each) => each.id === id);
      if (snap) log(snap.boxId, until ? `Kept "${snap.name}" until ${new Date(until).toDateString()}` : `Stopped keeping "${snap.name}"`, BY_PERSON);
    }
    return skipped;
  }, [whyNotKeep, log, setSnapsNow]);

  const rename = useCallback((id: string, name: string) => updateSnap(id, { name }), [updateSnap]);
  const annotate = useCallback((id: string, note: string) => updateSnap(id, { note: note.trim() || null }), [updateSnap]);

  const remove = useCallback((ids: readonly string[], by: Actor): Skipped[] => {
    const skipped: Skipped[] = [];
    const going: string[] = [];
    for (const id of ids) {
      const snap = snapsRef.current.find((each) => each.id === id);
      if (!snap) continue;
      const why = whyNotDelete(id);
      if (why) skipped.push({ name: snap.name, why });
      else going.push(id);
    }
    const nowAt = Date.now();
    const monthStart = new Date(new Date(nowAt).getFullYear(), new Date(nowAt).getMonth(), 1).getTime();
    const spent = snapsRef.current.filter((snap) => going.includes(snap.id) && snap.price).reduce((total, snap) => total + ((nowAt - Math.max(monthStart, snap.takenAt)) / DAY) * snap.price!.amount, 0);
    setDeletedSpend((current) => current + spent);
    setSnapsNow((current) => current.map((snap) => (going.includes(snap.id) ? { ...snap, state: snap.state === "failed" ? snap.state : "deleting" } : snap)));
    later(800, () => {
      for (const id of going) {
        const snap = snapsRef.current.find((each) => each.id === id);
        if (snap) log(snap.boxId, `Deleted "${snap.name}"`, by);
      }
      setSnapsNow((current) => current.filter((snap) => !going.includes(snap.id)));
    });
    return skipped;
  }, [whyNotDelete, later, log, setSnapsNow]);

  const agentDemo = useCallback(() => {
    const agent = byAgent("thr_android");
    const outcome = take("bxrosyreef4k1", { name: "before clearing app data", note: "", memory: false }, agent);
    if (!outcome.ok) return say(`The agent's take was refused: ${outcome.why}`);
    later(2_500, () => {
      const result = restore("bxrosyreef4k1", outcome.id, { undo: true, anyway: false }, agent);
      if (!result.ok) say(`The agent's restore was refused: ${result.why}`);
    });
  }, [take, restore, later, say]);

  const askPerson = useCallback(() => {
    const id = newId("fm");
    setForms((current) => [...current.filter((form) => form.state !== "waiting"), { id, threadId: "thr_cleanup", boxId: "bxworkpc5n2hq", snapId: "snwor01upgrad", askedAt: Date.now(), state: "waiting", words: null }]);
  }, []);

  const submitForm = useCallback((id: string) => {
    const form = forms.find((each) => each.id === id);
    if (!form) return;
    const title = threadTitle(threadsRef.current, form.threadId);
    updateForm(id, { state: "waiting-idle", words: `A yes was given in the thread. Holding new turns on the box, and waiting for ${title} to finish its turn` });
    later(2_000, () => {
      setThreads((current) => current.map((thread) => (thread.id === form.threadId ? { ...thread, running: false } : thread)));
      threadsRef.current = threadsRef.current.map((thread) => (thread.id === form.threadId ? { ...thread, running: false } : thread));
      const outcome = restore(form.boxId, form.snapId, { undo: true, anyway: true, consentIn: title, formId: id }, BY_PERSON);
      if (!outcome.ok) return updateForm(id, { state: "refused", words: outcome.why });
      updateForm(id, { state: "restoring", words: "Restoring as bb-box's own operation; the undo is taken once the box has stopped" });
    });
  }, [forms, updateForm, later, restore]);

  const cancelForm = useCallback((id: string) => updateForm(id, { state: "cancelled", words: "Cancelled. Nothing changed." }), [updateForm]);

  const restartMidRestore = useCallback(() => {
    const boxId = "bxamberfox2q7k";
    const target = snapsRef.current.find((snap) => snap.id === "snamb02migrat");
    if (!target) return say("amber-fox's snapshot is gone: Start over first.");
    const outcome = restore(boxId, target.id, { undo: true, anyway: true }, BY_PERSON);
    if (!outcome.ok) return say(outcome.why);
    later(1_700, () => {
      cancelled.current.add(outcome.id);
      updateBox(boxId, { state: "unconfirmed", step: null });
      notice("unconfirmed", boxId, target, BY_PERSON, null, null);
      log(boxId, `bb-box restarted while restoring to "${target.name}": it was rolling back. Its record of the restore is kept, and the target stays pinned.`, { is: "bb-box", why: "a restart" });
    });
  }, [restore, later, updateBox, notice, log, say]);

  const checkNow = useCallback((boxId: string) => {
    updateBox(boxId, { step: "Reading Proxmox's task and the guest" });
    later(1_200, () => {
      const shown = notices.find((each) => each.boxId === boxId);
      const target = snapsRef.current.find((snap) => snap.name === shown?.to && snap.boxId === boxId) ?? null;
      if (target) pin([target.id], false);
      updateBox(boxId, { state: "ready", step: null });
      notice("finished-after-restart", boxId, target, BY_PERSON, undos(boxId).at(-1)?.id ?? null, null);
      log(boxId, "Proxmox's rollback task had ended OK; bb-box started the box, wrote current access and finished the restore", { is: "bb-box", why: "finishing a restore cut short" });
    });
  }, [updateBox, later, notices, notice, undos, log, pin]);

  const fillStorage = useCallback((host: string) => {
    boxesRef.current = boxesRef.current.map((box) => (box.host === host && box.storage ? { ...box, storage: { ...box.storage, full: 93 } } : box));
    setBoxes(boxesRef.current);
    const onHost = new Set(boxesRef.current.filter((box) => box.host === host).map((box) => box.id));
    const victims = snapsRef.current
      .filter((snap) => onHost.has(snap.boxId) && alive(snap) && snap.by.is === "agent" && snap.keptUntil === null && !snap.undoOf && !pinnedRef.current.has(snap.id))
      .sort((a, b) => a.takenAt - b.takenAt)
      .slice(0, 2);
    later(1_200, () => {
      setSnapsNow((current) => current.filter((snap) => !victims.some((victim) => victim.id === snap.id)));
      for (const victim of victims) log(victim.boxId, `Deleted "${victim.name}"`, { is: "bb-box", why: `${host}'s storage was 93% full` });
      boxesRef.current = boxesRef.current.map((box) => (box.host === host && box.storage ? { ...box, storage: { ...box.storage, full: 88 } } : box));
      setBoxes(boxesRef.current);
      say(`${host}'s storage passed ${settingsRef.current.roomPercent + SWEEP_DELETES_AT}%: bb-box deleted ${victims.length} agents' snapshots nobody kept. New snapshots there are refused until it is under ${settingsRef.current.roomPercent}%.`);
    });
  }, [later, setSnapsNow, log, say]);

  const reset = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    cancelled.current.clear();
    born.current = Date.now();
    setBoxes(boxesAt(born.current));
    setSnaps(snapshotsAt(born.current));
    setThreads(threadsAt());
    setEvents([]);
    setNotices([]);
    setForms([]);
    setDeletedSpend(0);
    pinnedRef.current = new Set();
    setPinned(pinnedRef.current);
    setSettingsState(DEFAULT_SETTINGS);
  }, []);

  const value = useMemo<Store>(
    () => ({
      now,
      boxes,
      snaps,
      threads,
      events,
      notices,
      forms,
      settings,
      toast,
      failNext,
      undoOpen,
      deletedSpend,
      pinned,
      setFailNext,
      setSettings: (change) => setSettingsState((current) => ({ ...current, ...change })),
      counted,
      undos,
      losses,
      plan,
      whyNotKeep,
      whyNotFork,
      whyNotDelete,
      take,
      whyNotTake,
      restore,
      fork,
      keep,
      rename,
      annotate,
      remove,
      dismissNotice: (boxId) => setNotices((current) => current.filter((each) => each.boxId !== boxId)),
      askUndo: setUndoOpen,
      agentDemo,
      askPerson,
      submitForm,
      cancelForm,
      restartMidRestore,
      checkNow,
      fillStorage,
      fixToken: (host) => {
        boxesRef.current = boxesRef.current.map((box) => (box.host === host ? { ...box, cannotTakeWhy: null } : box));
        setBoxes(boxesRef.current);
      },
      unlock: (boxId) => updateBox(boxId, { locked: null, state: "ready" }),
      say,
      rate,
      reset,
    }),
    [now, boxes, snaps, threads, events, notices, forms, settings, toast, failNext, undoOpen, deletedSpend, pinned, counted, undos, losses, plan, whyNotKeep, whyNotFork, whyNotDelete, take, whyNotTake, restore, fork, keep, rename, annotate, remove, agentDemo, askPerson, submitForm, cancelForm, restartMidRestore, checkNow, fillStorage, updateBox, say, rate, reset],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function forkName(taken: readonly string[]): string {
  return FORK_NAMES.find((name) => !taken.includes(name)) ?? `fork-${taken.length}`;
}

export function undoWords(way: UndoWay, box: FakeBox, ms: number): string {
  if (way === "held-copy") return `Copy ${box.name} once stopped, so you can undo this: about ${seconds(ms)} and ${box.usedGB} GB on ${box.host}, as a template that cannot start. ZFS cannot keep a snapshot newer than the one it restores.`;
  if (way === "suspend-copy") return `Take a copy of ${box.name} first, memory included, so you can undo this: about ${seconds(ms)}, as it suspends and resumes.`;
  if (box.snapshotting?.scope === "device") return `Take a device snapshot first, so you can undo this. About ${seconds(ms)}.`;
  return `Take a snapshot of it, once stopped, so you can undo this. About ${seconds(ms)}.`;
}
