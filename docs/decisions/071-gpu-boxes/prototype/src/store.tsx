import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BACKENDS, CARDS, DEFAULT_SETTINGS, NEW_NAMES, boxesAt, type BackendId, type FakeBox, type GpuPart, type GpuSettings } from "./data";
import { backendOf, place, planGpu, type World } from "./placement";

export interface Toast {
  readonly words: string;
}

export interface NewBox {
  readonly backend: BackendId;
  readonly desktop: boolean;
  readonly cores: number;
  readonly memoryGiB: number;
  readonly gpu: GpuPart;
  readonly thread?: string;
}

export interface ResizeAsk {
  readonly cores: number;
  readonly memoryGiB: number;
  readonly gpu: GpuPart;
}

export type Outcome = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly why: string };
export type Made = { readonly ok: true; readonly id: string; readonly box: FakeBox } | { readonly ok: false; readonly why: string };

interface StoreValue extends World {
  readonly now: number;
  readonly toast: Toast | null;
  create(ask: NewBox): Made;
  resize(id: string, ask: ResizeAsk): Outcome;
  release(id: string): void;
  power(id: string, on: boolean): void;
  setSettings(backend: BackendId, settings: GpuSettings): void;
  reset(): void;
}

const Store = createContext<StoreValue | null>(null);

const START_STEPS = ["Cloning", "Placing on its card", "Starting", "Checking nvidia-smi"] as const;
const RESTART_STEPS = ["Stopping", "Setting its card's devices", "Starting", "Checking nvidia-smi"] as const;
const STEP_MS = 700;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [now] = useState(() => Date.now());
  const [boxes, setBoxes] = useState<FakeBox[]>(() => boxesAt(now));
  const [settings, setAll] = useState<Readonly<Record<BackendId, GpuSettings>>>(DEFAULT_SETTINGS);
  const [toast, setToast] = useState<Toast | null>(null);
  const timers = useRef<number[]>([]);
  const named = useRef(0);
  const world = useRef<World>({ boxes, cards: CARDS, settings });
  world.current = { boxes, cards: CARDS, settings };

  useEffect(() => () => timers.current.forEach((timer) => clearTimeout(timer)), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const patch = useCallback((id: string, change: Partial<FakeBox>) => setBoxes((all) => all.map((box) => (box.id === id ? { ...box, ...change } : box))), []);

  const walk = useCallback(
    (id: string, steps: readonly string[], state: FakeBox["state"], done: Partial<FakeBox>, words: string) => {
      steps.forEach((step, index) => {
        timers.current.push(window.setTimeout(() => patch(id, { state, step }), index * STEP_MS));
      });
      timers.current.push(
        window.setTimeout(() => {
          patch(id, { ...done, state: "ready", step: undefined });
          setToast({ words });
        }, steps.length * STEP_MS),
      );
    },
    [patch],
  );

  const create = useCallback(
    (ask: NewBox): Made => {
      const placed = place(world.current, ask.backend, ask.gpu, ask.desktop);
      if (ask.gpu !== "none" && !placed.card) return { ok: false, why: placed.why ?? "No card can take it." };
      const name = NEW_NAMES[named.current++ % NEW_NAMES.length]!;
      const id = `bx${name.replace("-", "")}${named.current}`;
      const box: FakeBox = {
        id,
        name,
        backend: ask.backend,
        desktop: ask.desktop,
        cores: ask.cores,
        memoryGiB: ask.memoryGiB,
        diskGiB: ask.backend === "docker" ? null : ask.desktop ? 24 : 16,
        gpu: ask.gpu,
        card: placed.card?.id ?? null,
        state: "starting",
        step: START_STEPS[0],
        thread: ask.thread ?? "you",
        createdAt: Date.now(),
        gpuPercent: 0,
        processes: ask.desktop && placed.card ? [{ pid: 640, name: "Xorg", mib: 46 }] : [],
      };
      setBoxes((all) => [...all, box]);
      walk(id, ask.gpu === "none" ? START_STEPS.filter((step) => !/card|nvidia/.test(step)) : START_STEPS, "starting", {}, `${name} is ready${placed.card ? ` on card ${placed.card.index}` : ""}.`);
      return { ok: true, id, box };
    },
    [walk],
  );

  const resize = useCallback(
    (id: string, ask: ResizeAsk): Outcome => {
      const box = world.current.boxes.find((each) => each.id === id);
      if (!box) return { ok: false, why: "No such box." };
      const plan = planGpu(world.current, box, ask.gpu);
      if (plan.way === "no") return { ok: false, why: plan.why ?? "It cannot change." };
      const size = { cores: ask.cores, memoryGiB: ask.memoryGiB };
      if (plan.way === "restart") {
        const card = plan.toCard?.id ?? null;
        const processes = ask.gpu === "none" ? [] : box.desktop ? [{ pid: 640, name: "Xorg", mib: 46 }] : [];
        walk(id, RESTART_STEPS.filter((step) => ask.gpu !== "none" || !/nvidia/.test(step)), "restarting", { ...size, gpu: ask.gpu, card, processes, gpuPercent: 0 }, `${box.name} is back${plan.toCard ? ` on card ${plan.toCard.index}` : " with no GPU"}.`);
        return { ok: true, id };
      }
      patch(id, { ...size, gpu: ask.gpu });
      setToast({ words: plan.way === "live" ? `${box.name} has ${ask.gpu === "whole" ? `card ${plan.fromCard!.index} to itself` : `a shared GPU on card ${plan.fromCard!.index}`} now. Nothing in it stopped.` : `Resized ${box.name}.` });
      return { ok: true, id };
    },
    [patch, walk],
  );

  const release = useCallback((id: string) => {
    const box = world.current.boxes.find((each) => each.id === id);
    setBoxes((all) => all.filter((each) => each.id !== id));
    if (box) setToast({ words: `Released ${box.name}.` });
  }, []);

  const power = useCallback(
    (id: string, on: boolean) => {
      const box = world.current.boxes.find((each) => each.id === id);
      if (!box) return;
      if (!on) {
        patch(id, { state: "stopped", processes: [], gpuPercent: 0 });
        return;
      }
      walk(id, ["Starting", ...(box.gpu === "none" ? [] : ["Checking nvidia-smi"])], "starting", { processes: box.desktop && box.card ? [{ pid: 640, name: "Xorg", mib: 46 }] : [] }, `${box.name} is ready.`);
    },
    [patch, walk],
  );

  const setSettings = useCallback((backend: BackendId, next: GpuSettings) => setAll((all) => ({ ...all, [backend]: next })), []);

  const reset = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current = [];
    named.current = 0;
    setBoxes(boxesAt(now));
    setAll(DEFAULT_SETTINGS);
    setToast(null);
  }, [now]);

  const value = useMemo<StoreValue>(() => ({ boxes, cards: CARDS, settings, now, toast, create, resize, release, power, setSettings, reset }), [boxes, settings, now, toast, create, resize, release, power, setSettings, reset]);
  return <Store.Provider value={value}>{children}</Store.Provider>;
}

export function useStore(): StoreValue {
  const store = useContext(Store);
  if (!store) throw new Error("useStore outside StoreProvider");
  return store;
}

export function offeredBackends(): readonly BackendId[] {
  return BACKENDS.map((backend) => backend.id);
}

export function hostOf(id: BackendId): string {
  return backendOf(id).host;
}
