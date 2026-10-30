import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { boxesAt, byAgent, BY_PERSON, DAY, snapshotsAt, threadsAt, type Actor, type BoxEvent, type FakeBox, type FakeSnap, type FakeThread, type RestoreNotice } from "./data";
import { clockOf, endOfMonth, money, projectedThisMonth } from "./words";

export interface SnapshotSettings {
  readonly perBox: number;
  readonly roomPercent: number;
  readonly keepDays: number;
  readonly agentsRestore: boolean;
  readonly pictures: boolean;
  readonly ceiling: number;
}

export const DEFAULT_SETTINGS: SnapshotSettings = { perBox: 5, roomPercent: 85, keepDays: 30, agentsRestore: true, pictures: true, ceiling: 5 };

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

interface Store {
  readonly now: number;
  readonly boxes: readonly FakeBox[];
  readonly snaps: readonly FakeSnap[];
  readonly threads: readonly FakeThread[];
  readonly events: readonly BoxEvent[];
  readonly notices: readonly RestoreNotice[];
  readonly settings: SnapshotSettings;
  readonly toast: Toast | null;
  readonly failNext: boolean;
  readonly undoOpen: string | null;
  setFailNext(on: boolean): void;
  setSettings(change: Partial<SnapshotSettings>): void;
  take(boxId: string, ask: TakeAsk, by: Actor): Outcome;
  whyNotTake(boxId: string, by: Actor, memory: boolean): string | null;
  restore(boxId: string, snapId: string, undo: boolean, by: Actor): Outcome;
  fork(snapId: string, into: "thread" | "machine", name: string): Outcome;
  keep(ids: readonly string[], until: number | null): void;
  rename(id: string, name: string): void;
  annotate(id: string, note: string): void;
  remove(ids: readonly string[], by: Actor): void;
  dismissNotice(boxId: string): void;
  askUndo(snapId: string | null): void;
  agentDemo(): void;
  fixToken(host: string): void;
  say(toast: Toast | string): void;
  monthCost(): number;
  reset(): void;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("No store");
  return store;
}

const FORK_NAMES = ["keen-otter", "bold-finch", "tidy-glade", "warm-cedar", "swift-lark", "quiet-heron"];

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36).slice(-6)}${counter.toString(36).padStart(4, "0")}`.slice(0, 14);
}

function liveSnaps(snaps: readonly FakeSnap[], boxId: string): FakeSnap[] {
  return snaps.filter((snap) => snap.boxId === boxId && snap.state !== "failed" && snap.state !== "deleting");
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const born = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [boxes, setBoxes] = useState<FakeBox[]>(() => boxesAt(born.current));
  const [snaps, setSnaps] = useState<FakeSnap[]>(() => snapshotsAt(born.current));
  const [threads] = useState<FakeThread[]>(() => threadsAt());
  const [events, setEvents] = useState<BoxEvent[]>([]);
  const [notices, setNotices] = useState<RestoreNotice[]>([]);
  const [settings, setSettingsState] = useState<SnapshotSettings>(DEFAULT_SETTINGS);
  const [toast, setToast] = useState<Toast | null>(null);
  const [failNext, setFailNext] = useState(false);
  const [undoOpen, setUndoOpen] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const boxesRef = useRef(boxes);
  const snapsRef = useRef(snaps);
  const settingsRef = useRef(settings);
  const failRef = useRef(failNext);
  boxesRef.current = boxes;
  snapsRef.current = snaps;
  settingsRef.current = settings;
  failRef.current = failNext;

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

  const updateSnap = useCallback((id: string, change: Partial<FakeSnap>) => {
    setSnaps((current) => current.map((snap) => (snap.id === id ? { ...snap, ...change } : snap)));
  }, []);

  const updateBox = useCallback((id: string, change: Partial<FakeBox>) => {
    setBoxes((current) => current.map((box) => (box.id === id ? { ...box, ...change } : box)));
  }, []);

  const monthCost = useCallback(() => projectedThisMonth(snapsRef.current, boxesRef.current, Date.now()), []);

  const whyNotTake = useCallback((boxId: string, by: Actor, memory: boolean): string | null => {
    const box = boxesRef.current.find((each) => each.id === boxId);
    if (!box) return "That box is gone.";
    if (!box.snapshotting) return box.noSnapshotsWhy ?? `${box.name} has no snapshots.`;
    if (box.cannotTakeWhy) return box.cannotTakeWhy;
    if (box.state !== "ready" && box.state !== "stopped") return `${box.name} is ${box.state === "restoring" ? "being restored" : "starting"}.`;
    const limit = settingsRef.current.perBox;
    const held = liveSnaps(snapsRef.current, boxId);
    if (held.length >= limit) {
      const replaceable = held.filter((snap) => snap.by.is === "agent" && snap.keptUntil === null);
      if (by.is !== "agent" || !replaceable.length) return `${box.name} has ${limit} of ${limit} snapshots. Delete one first, or raise the limit in Settings.`;
    }
    if (box.storageFull >= settingsRef.current.roomPercent) return `${box.host}'s snapshot storage is ${box.storageFull}% full, over the ${settingsRef.current.roomPercent}% set in Settings.`;
    if (memory && box.storageFull + 6 >= settingsRef.current.roomPercent) return `A memory snapshot needs up to ${box.memoryGiB} GiB more on ${box.host}, which would pass ${settingsRef.current.roomPercent}% full.`;
    const price = box.snapshotting.price;
    if (price) {
      const adds = ((endOfMonth(Date.now()) - Date.now()) / DAY) * price.amount;
      const total = projectedThisMonth(snapsRef.current, boxesRef.current, Date.now());
      if (total + adds > settingsRef.current.ceiling) return `It would bring this month's snapshots on ${box.backend} to about ${money(total + adds)}, past your ceiling of ${money(settingsRef.current.ceiling)} a month.`;
    }
    return null;
  }, []);

  const makeRoom = useCallback((boxId: string, by: Actor) => {
    const held = liveSnaps(snapsRef.current, boxId);
    if (held.length < settingsRef.current.perBox || by.is !== "agent") return;
    const oldest = held.filter((snap) => snap.by.is === "agent" && snap.keptUntil === null).sort((a, b) => a.takenAt - b.takenAt)[0];
    if (!oldest) return;
    setSnaps((current) => current.filter((snap) => snap.id !== oldest.id));
    snapsRef.current = snapsRef.current.filter((snap) => snap.id !== oldest.id);
    log(boxId, `Deleted "${oldest.name}": the limit of ${settingsRef.current.perBox} a box`, { is: "bb-box", why: "the per-box limit" });
  }, [log]);

  const startTake = useCallback((box: FakeBox, ask: TakeAsk, by: Actor, undoOf: FakeSnap["undoOf"]): FakeSnap => {
    const id = newId("sn");
    const at = Date.now();
    const memory = ask.memory || (box.snapshotting?.holds.length === 1 && box.snapshotting.holds[0] === "disk-and-memory");
    const taking: FakeSnap = {
      id,
      boxId: box.id,
      name: ask.name.trim() || `Today ${clockOf(at)}`,
      note: ask.note.trim() || null,
      takenAt: at,
      tookMs: null,
      by,
      holds: memory ? "disk-and-memory" : "disk",
      sizeGB: null,
      price: box.snapshotting?.price ?? null,
      keptUntil: null,
      undoOf,
      picture: settingsRef.current.pictures && box.screen !== "none" ? 40 + Math.floor(Math.random() * 60) : null,
      state: "taking",
      error: null,
    };
    setSnaps((current) => [...current, taking]);
    snapsRef.current = [...snapsRef.current, taking];
    return taking;
  }, []);

  const finishTake = useCallback((box: FakeBox, taking: FakeSnap, by: Actor, ms: number) => {
    const fails = failRef.current && !taking.undoOf;
    later(ms, () => {
      if (fails) {
        setFailNext(false);
        updateSnap(taking.id, { state: "failed", error: `Proxmox: VM ${box.name} is locked (backup).` });
        log(box.id, `Snapshot "${taking.name}" failed: the box is locked by a backup`, by);
        return;
      }
      const size = box.snapshotting?.sizeKnown ? Math.round((0.15 + Math.random() * 0.9 + (taking.holds === "disk-and-memory" ? box.memoryGiB * 0.85 : 0)) * 10) / 10 : null;
      updateSnap(taking.id, { state: "ready", tookMs: ms + Math.round(Math.random() * 120), sizeGB: size });
      log(box.id, `Took snapshot "${taking.name}" (${taking.holds === "disk" ? "disk" : "disk and memory"})`, by);
    });
  }, [later, log, updateSnap]);

  const take = useCallback((boxId: string, ask: TakeAsk, by: Actor): Outcome => {
    const why = whyNotTake(boxId, by, ask.memory);
    if (why) return { ok: false, why };
    const box = boxesRef.current.find((each) => each.id === boxId)!;
    makeRoom(boxId, by);
    const taking = startTake(box, ask, by, null);
    const cap = box.snapshotting!;
    const ms = taking.holds === "disk-and-memory" ? Math.min(cap.memoryTakesAboutMs ?? cap.takesAboutMs, 4_000) : Math.min(cap.takesAboutMs, 1_400);
    finishTake(box, taking, by, ms);
    return { ok: true, id: taking.id };
  }, [whyNotTake, makeRoom, startTake, finishTake]);

  const restore = useCallback((boxId: string, snapId: string, undo: boolean, by: Actor): Outcome => {
    const box = boxesRef.current.find((each) => each.id === boxId);
    const target = snapsRef.current.find((snap) => snap.id === snapId);
    if (!box || !target) return { ok: false, why: "That snapshot is gone." };
    if (box.state !== "ready" && box.state !== "stopped") return { ok: false, why: `${box.name} is busy: ${box.state}.` };
    if (by.is === "agent" && !settingsRef.current.agentsRestore) return { ok: false, why: "Agents may not restore boxes: Settings turned it off." };
    let undoSnap: FakeSnap | null = null;
    if (undo) {
      const why = whyNotTake(boxId, by.is === "agent" ? by : BY_PERSON, false);
      if (why) return { ok: false, why: `No undo could be taken: ${why}` };
      makeRoom(boxId, by);
      undoSnap = startTake(box, { name: `before restoring to ${clockOf(target.takenAt)}`, note: "", memory: false }, by, { at: Date.now(), to: target.name });
      later(700, () => {
        updateSnap(undoSnap!.id, { state: "ready", tookMs: 680, sizeGB: box.snapshotting?.sizeKnown ? 0.6 : null, holds: "disk" });
        log(box.id, `Took the undo, "${undoSnap!.name}"`, by);
      });
    }
    const fails = failRef.current;
    log(box.id, `Restore to "${target.name}" asked${undoSnap ? `, undo "${undoSnap.name}"` : ", no undo"}`, by);
    const steps: readonly [number, string][] = [
      [undo ? 0 : -1, "Taking the undo"],
      [800, "Stopping"],
      [1_500, `Restoring to "${target.name}"`],
      [2_600, target.holds === "disk-and-memory" ? "Resuming" : "Starting"],
      [3_400, "Joining BB again"],
    ];
    for (const [at, step] of steps) if (at >= 0) later(at, () => updateBox(boxId, { state: "restoring", step }));
    if (fails) {
      later(2_200, () => {
        setFailNext(false);
        updateBox(boxId, { state: "ready", step: null });
        log(box.id, `Restore failed: Proxmox could not roll back: the snapshot's volume is busy. bb-box then found ${box.name} running, as before.`, by);
        say(`Restoring ${box.name} failed. It is running, as before. ${undoSnap ? `The undo, "${undoSnap.name}", is kept.` : ""}`);
      });
      return { ok: true, id: undoSnap?.id ?? "" };
    }
    later(4_000, () => {
      updateBox(boxId, { state: "ready", step: null });
      const notice: RestoreNotice = { boxId, at: Date.now(), to: target.name, toAt: target.takenAt, by, undoId: undoSnap?.id ?? null };
      setNotices((current) => [notice, ...current.filter((each) => each.boxId !== boxId)]);
      log(box.id, `Restored to "${target.name}"`, by);
      if (by.is === "person") say({ words: `Restored ${box.name} to "${target.name}".`, ...(undoSnap ? { action: { label: "Undo", run: () => setUndoOpen(undoSnap!.id) } } : {}) });
    });
    return { ok: true, id: undoSnap?.id ?? "" };
  }, [whyNotTake, makeRoom, startTake, later, updateSnap, updateBox, log, say]);

  const fork = useCallback((snapId: string, into: "thread" | "machine", name: string): Outcome => {
    const source = snapsRef.current.find((snap) => snap.id === snapId);
    const box = source && boxesRef.current.find((each) => each.id === source.boxId);
    if (!source || !box) return { ok: false, why: "That snapshot is gone." };
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
      state: "starting",
      step: "Copying the snapshot",
      createdAt: Date.now(),
      releasedAt: null,
      forkedFrom: { box: box.name, snapshot: source.name, takenAt: source.takenAt },
      cannotTakeWhy: null,
    };
    setBoxes((current) => [...current, fresh]);
    log(box.id, `Forked "${source.name}" into ${name}`, BY_PERSON);
    log(id, `Made from ${box.name}'s snapshot "${source.name}"`, BY_PERSON);
    later(1_600, () => updateBox(id, { step: "Starting, with a new identity" }));
    later(2_800, () => updateBox(id, { step: "Checking its source's credentials are gone" }));
    later(3_600, () => updateBox(id, { step: "Joining BB as a new machine" }));
    later(4_400, () => updateBox(id, { state: "ready", step: null }));
    return { ok: true, id };
  }, [later, log, updateBox]);

  const keep = useCallback((ids: readonly string[], until: number | null) => {
    setSnaps((current) => current.map((snap) => (ids.includes(snap.id) ? { ...snap, keptUntil: until } : snap)));
    for (const id of ids) {
      const snap = snapsRef.current.find((each) => each.id === id);
      if (snap) log(snap.boxId, until ? `Kept "${snap.name}" until ${new Date(until).toDateString()}` : `Stopped keeping "${snap.name}"`, BY_PERSON);
    }
  }, [log]);

  const rename = useCallback((id: string, name: string) => updateSnap(id, { name }), [updateSnap]);
  const annotate = useCallback((id: string, note: string) => updateSnap(id, { note: note.trim() || null }), [updateSnap]);

  const remove = useCallback((ids: readonly string[], by: Actor) => {
    setSnaps((current) => current.map((snap) => (ids.includes(snap.id) ? { ...snap, state: snap.state === "failed" ? snap.state : "deleting" } : snap)));
    later(800, () => {
      for (const id of ids) {
        const snap = snapsRef.current.find((each) => each.id === id);
        if (snap) log(snap.boxId, `Deleted "${snap.name}"`, by);
      }
      setSnaps((current) => current.filter((snap) => !ids.includes(snap.id)));
    });
  }, [later, log]);

  const agentDemo = useCallback(() => {
    const agent = byAgent("thr_login");
    const outcome = take("bxamberfox2q7k", { name: "before upgrading Chromium", note: "", memory: false }, agent);
    if (!outcome.ok) return say(`The agent's take was refused: ${outcome.why}`);
    say("The agent in Fix the sign-in flow took a snapshot of amber-fox, and restores it in 3 s.");
    later(3_000, () => {
      const result = restore("bxamberfox2q7k", outcome.id, true, agent);
      if (!result.ok) say(`The agent's restore was refused: ${result.why}`);
    });
  }, [take, restore, later, say]);

  const reset = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    born.current = Date.now();
    setBoxes(boxesAt(born.current));
    setSnaps(snapshotsAt(born.current));
    setEvents([]);
    setNotices([]);
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
      settings,
      toast,
      failNext,
      undoOpen,
      setFailNext,
      setSettings: (change) => setSettingsState((current) => ({ ...current, ...change })),
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
      fixToken: (host) => setBoxes((current) => current.map((box) => (box.host === host ? { ...box, cannotTakeWhy: null } : box))),
      say,
      monthCost,
      reset,
    }),
    [now, boxes, snaps, threads, events, notices, settings, toast, failNext, undoOpen, take, whyNotTake, restore, fork, keep, rename, annotate, remove, agentDemo, say, monthCost, reset],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function forkName(taken: readonly string[]): string {
  return FORK_NAMES.find((name) => !taken.includes(name)) ?? `fork-${taken.length}`;
}
