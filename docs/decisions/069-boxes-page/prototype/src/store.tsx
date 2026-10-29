import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BoxView } from "@/src/plugin/views.ts";
import { boxesAt, threadsAt, type FakeBox, type FakeThread } from "./data";

export type Act = "stop" | "start" | "release" | "resize" | "refresh" | "take" | "handBack" | "forget";

interface Store {
  readonly now: number;
  readonly boxes: readonly FakeBox[];
  readonly threads: readonly FakeThread[];
  readonly released: ReadonlyMap<string, { name: string; at: number }>;
  readonly monitorOn: boolean;
  readonly busy: ReadonlySet<string>;
  readonly toast: string | null;
  readonly failNext: boolean;
  readonly historyOn: boolean;
  readonly offSince: number | null;
  setFailNext(on: boolean): void;
  setHistoryOn(on: boolean): void;
  setMonitorOn(on: boolean): void;
  act(method: Act, boxId: string): void;
  say(words: string): void;
  reset(): void;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("No store");
  return store;
}

function withView(box: FakeBox, change: Partial<BoxView>): FakeBox {
  return { ...box, view: { ...box.view, ...change } };
}

const SETTLE_MS: Readonly<Record<"stop" | "start" | "release", number>> = { stop: 1_600, start: 3_200, release: 1_400 };

export function StoreProvider({ children }: { children: ReactNode }) {
  const born = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [boxes, setBoxes] = useState<FakeBox[]>(() => boxesAt(born.current));
  const [threads] = useState<FakeThread[]>(() => threadsAt(born.current));
  const [released, setReleased] = useState<Map<string, { name: string; at: number }>>(new Map());
  const [monitorOffAt, setMonitorOffAt] = useState<number | null>(null);
  const monitorOn = monitorOffAt === null;
  const setMonitorOn = useCallback((on: boolean) => setMonitorOffAt(on ? null : Date.now()), []);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [failNext, setFailNext] = useState(false);
  const [historyOffAt, setHistoryOffAt] = useState<number | null>(null);
  const historyOn = historyOffAt === null;
  const setHistoryOn = useCallback((on: boolean) => setHistoryOffAt(on ? null : Date.now()), []);
  const offs = [monitorOffAt, historyOffAt].filter((at): at is number => at !== null);
  const offSince = offs.length ? Math.min(...offs) : null;
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(tick);
  }, []);

  const update = useCallback((id: string, change: (box: FakeBox) => FakeBox) => {
    setBoxes((current) => current.map((box) => (box.view.id === id ? change(box) : box)));
  }, []);

  const later = useCallback((ms: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, ms));
  }, []);

  const startNorthWind = useCallback(() => {
    const id = "bxnorthwind3h";
    later(2_500, () => update(id, (box) => withView(box, { timings: { ...box.view.timings, configure: 30, start: 1_500 }, waitingOn: "Waiting for the box to answer on SSH" })));
    later(5_500, () => update(id, (box) => withView(box, { state: "ready", readyAt: Date.now(), terminal: true, address: "172.18.0.9", waitingOn: null, timings: { ...box.view.timings, network: 400, ssh: 900, total: 5_100 }, enrol: { state: "enrolling", hostId: null, error: null } })));
    later(8_000, () => update(id, (box) => withView(box, { enrol: { state: "enrolled", hostId: "host_north-wind", error: null }, timings: { ...box.view.timings, enrol: 2_600 } })));
  }, [later, update]);

  useEffect(() => {
    startNorthWind();
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, [startNorthWind]);

  const say = useCallback((words: string) => {
    setToast(words);
    later(3_200, () => setToast((current) => (current === words ? null : current)));
  }, [later]);

  const settle = useCallback((id: string) => setBusy((current) => {
    const next = new Set(current);
    next.delete(id);
    return next;
  }), []);

  const fail = useCallback((id: string, action: "stop" | "start" | "resize" | "release", error: string, revert: Partial<BoxView>) => {
    update(id, (each) => ({ ...withView(each, revert), operation: { action, at: Date.now(), error } }));
    setFailNext(false);
    settle(id);
  }, [update, settle]);

  const act = useCallback((method: Act, id: string) => {
    const box = boxes.find((each) => each.view.id === id);
    if (!box) return;
    if (method === "take") return update(id, (each) => withView(each, { control: { owner: "human", holder: "this-tab" } }));
    if (method === "handBack") return update(id, (each) => withView(each, { control: { owner: "agent", holder: null } }));
    if (method === "refresh") return say(box.unreachable ? `${box.view.backendLabel.replace(/^.* on /, "")} still does not answer.` : box.backendGone ? `${box.view.name}'s backend is not in settings, so bb-box cannot check it.` : `Checked ${box.view.name}: it answers.`);
    if (method === "forget") {
      setBoxes((current) => current.filter((each) => each.view.id !== id));
      setReleased((current) => new Map(current).set(id, { name: box.view.name, at: Date.now() }));
      return say(`Forgot ${box.view.name}. Its guest, if it still runs, was not touched.`);
    }
    if (method === "resize") {
      if (failNext) return fail(id, "resize", "pve-1 has 2 cores free, and 4 more were asked for.", {});
      return say("Resize opens decision 061's dialog, as today.");
    }
    setBusy((current) => new Set(current).add(id));
    update(id, (each) => ({ ...each, operation: null }));
    if (method === "stop") {
      update(id, (each) => withView(each, { state: "stopping" }));
      if (failNext) return later(SETTLE_MS.stop, () => fail(id, "stop", "Proxmox did not stop the container within 60 s.", { state: "ready" }));
      later(SETTLE_MS.stop, () => {
        const at = Date.now();
        update(id, (each) => ({ ...withView(each, { state: "stopped", terminal: false }), stops: [...(each.stops ?? []), { from: at, to: null, by: { kind: "you" } }] }));
        settle(id);
      });
    }
    if (method === "start") {
      const askedAt = Date.now();
      update(id, (each) => ({ ...withView(each, { state: "starting", stopped: null }), started: { askedAt, by: { kind: "you" }, readyAt: null }, stops: (each.stops ?? []).map((stop) => (stop.to === null ? { ...stop, to: askedAt } : stop)) }));
      if (failNext) {
        return later(SETTLE_MS.start, () => {
          fail(id, "start", "The VM did not answer on SSH within 120 s after it booted.", { state: "stopped" });
          update(id, (each) => ({ ...each, stops: (each.stops ?? []).map((stop, index, all) => (index === all.length - 1 ? { ...stop, to: null } : stop)) }));
        });
      }
      later(SETTLE_MS.start / 2, () => update(id, (each) => withView(each, { timings: { ...each.view.timings, "start.boot": 1_400 } })));
      later(SETTLE_MS.start, () => {
        const at = Date.now();
        update(id, (each) => ({
          ...withView(each, { state: "ready", terminal: true, address: each.view.address ?? "10.20.0.77", timings: { ...each.view.timings, "start.boot": 1_400, "start.ssh": 500 } }),
          started: { askedAt, by: { kind: "you" }, readyAt: at },
          load: { ...each.load, cpu: each.load.cpu || 9, memory: each.load.memory || 36 },
          processes: each.processes.length ? each.processes : [
            { pid: 1402, name: "bb-daemon", cpu: 1.2, memoryMiB: 98 },
            { pid: 980, name: "dockerd", cpu: 0.6, memoryMiB: 84 },
            { pid: 612, name: "sshd", cpu: 0.1, memoryMiB: 9 },
            { pid: 1, name: "systemd", cpu: 0.1, memoryMiB: 14 },
          ],
        }));
        settle(id);
      });
    }
    if (method === "release") {
      update(id, (each) => withView(each, { state: "releasing" }));
      if (failNext) return later(SETTLE_MS.release, () => fail(id, "release", "Proxmox refused to delete the container: it is locked by a backup.", { state: "releasing" }));
      later(SETTLE_MS.release, () => {
        setBoxes((current) => current.filter((each) => each.view.id !== id));
        setReleased((current) => new Map(current).set(id, { name: box.view.name, at: Date.now() }));
        settle(id);
      });
    }
  }, [boxes, later, say, settle, update, failNext, fail]);

  const reset = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    born.current = Date.now();
    setBoxes(boxesAt(born.current));
    setReleased(new Map());
    setBusy(new Set());
    startNorthWind();
  }, [startNorthWind]);

  const value = useMemo<Store>(
    () => ({ now, boxes, threads, released, monitorOn, busy, toast, failNext, historyOn, offSince, setFailNext, setHistoryOn, setMonitorOn, act, say, reset }),
    [now, boxes, threads, released, monitorOn, busy, toast, failNext, historyOn, offSince, setHistoryOn, setMonitorOn, act, say, reset],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
