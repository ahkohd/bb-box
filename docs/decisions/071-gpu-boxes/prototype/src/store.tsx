import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BACKENDS, CARDS, DEFAULT_KIND_GPU, DEFAULT_SETTINGS, HOST_DRIVER, NEW_NAMES, boxesAt, type BackendId, type FakeBox, type GpuPart, type GpuSettings, type KindId } from "./data";
import { backendOf, cardById, cardName, place, planGpu, waitingFor, type GpuWay, type World } from "./placement";

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
  readonly expect?: { readonly way: GpuWay; readonly toCard: string | null };
}

export type Outcome = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly why: string; readonly changed?: boolean };
export type Made = { readonly ok: true; readonly id: string; readonly box: FakeBox } | { readonly ok: false; readonly why: string };

interface StoreValue extends World {
  readonly now: number;
  readonly toast: Toast | null;
  readonly kindGpu: Readonly<Record<KindId, GpuPart>>;
  readonly formGpu: Readonly<Partial<Record<KindId, GpuPart>>>;
  create(ask: NewBox): Made;
  resize(id: string, ask: ResizeAsk): Outcome;
  release(id: string): void;
  power(id: string, on: boolean): void;
  updateUserspace(id: string): void;
  setSettings(backend: BackendId, settings: GpuSettings): void;
  setKindGpu(kind: KindId, gpu: GpuPart): void;
  rememberFormGpu(kind: KindId, gpu: GpuPart): void;
  reset(): void;
}

const Store = createContext<StoreValue | null>(null);

const START_STEPS = ["Cloning", "Writing its card claim", "Starting", "Checking nvidia-smi"] as const;
const RESTART_STEPS = ["Stopping", "Writing its card claim", "Starting", "Checking nvidia-smi"] as const;
const INSTALL_STEPS = [`Installing NVIDIA's userspace ${HOST_DRIVER}`, "Stopping", "Writing its card claim", "Starting", "Checking nvidia-smi"] as const;
const UPDATE_STEPS = ["Copying NVIDIA's installer", `Installing NVIDIA's userspace ${HOST_DRIVER}`, "Restarting", "Checking nvidia-smi"] as const;
const STEP_MS = 700;

function displayProcesses(desktop: boolean, card: string | null) {
  return desktop && card ? [{ pid: 640, name: "Xorg", mib: 46 }] : [];
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [now] = useState(() => Date.now());
  const [boxes, setBoxes] = useState<FakeBox[]>(() => boxesAt(now));
  const [settings, setAll] = useState<Readonly<Record<BackendId, GpuSettings>>>(DEFAULT_SETTINGS);
  const [kindGpu, setKinds] = useState<Readonly<Record<KindId, GpuPart>>>(DEFAULT_KIND_GPU);
  const [formGpu, setFormGpu] = useState<Readonly<Partial<Record<KindId, GpuPart>>>>({});
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

  const commit = useCallback((next: FakeBox[]) => {
    world.current = { ...world.current, boxes: next };
    setBoxes(next);
  }, []);

  const patch = useCallback(
    (id: string, change: Partial<FakeBox>) => commit(world.current.boxes.map((box) => (box.id === id ? { ...box, ...change } : box))),
    [commit],
  );

  const yieldCard = useCallback(
    (cardId: string, except: string) => {
      const card = cardById(world.current, cardId);
      if (!card) return;
      const yielding = new Set(waitingFor(world.current, card, except).map((box) => box.id));
      if (yielding.size) commit(world.current.boxes.map((box) => (yielding.has(box.id) ? { ...box, card: null } : box)));
    },
    [commit],
  );

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
      if (ask.gpu !== "none" && !placed.card) return { ok: false, why: placed.person ?? "No card can take it." };
      const name = NEW_NAMES[named.current++ % NEW_NAMES.length]!;
      const id = `bx${name.replace("-", "")}${named.current}`;
      const card = placed.card?.id ?? null;
      const box: FakeBox = {
        id,
        name,
        backend: ask.backend,
        desktop: ask.desktop,
        cores: ask.cores,
        memoryGiB: ask.memoryGiB,
        diskGiB: ask.backend === "docker" ? null : ask.desktop ? 24 : 16,
        gpu: ask.gpu,
        card,
        userspace: HOST_DRIVER,
        state: "starting",
        step: START_STEPS[0],
        thread: ask.thread ?? "you",
        createdAt: Date.now(),
        gpuPercent: 0,
        processes: [],
      };
      commit([...world.current.boxes, box]);
      if (ask.gpu === "whole" && card) yieldCard(card, id);
      walk(id, ask.gpu === "none" ? START_STEPS.filter((step) => !/card|nvidia/.test(step)) : START_STEPS, "starting", { processes: displayProcesses(ask.desktop, card) }, `${name} is ready${placed.card ? ` on ${cardName(placed.card)}` : ""}.`);
      return { ok: true, id, box };
    },
    [commit, walk, yieldCard],
  );

  const resize = useCallback(
    (id: string, ask: ResizeAsk): Outcome => {
      const box = world.current.boxes.find((each) => each.id === id);
      if (!box) return { ok: false, why: "No such box." };
      const plan = planGpu(world.current, box, ask.gpu);
      if (ask.expect && (plan.way !== ask.expect.way || (plan.toCard?.id ?? null) !== ask.expect.toCard)) {
        return { ok: false, changed: true, why: "The cards changed since this was shown, so nothing changed. The plan below is the new one: look at it again before you resize." };
      }
      if (plan.way === "no") return { ok: false, why: plan.person ?? "It cannot change." };
      const size = { cores: ask.cores, memoryGiB: ask.memoryGiB };
      if (plan.way === "stopped") {
        const card = ask.gpu === "none" ? null : plan.toCard?.id ?? (ask.gpu === "shared" ? box.card : null);
        patch(id, { ...size, gpu: ask.gpu, card });
        if (ask.gpu === "whole" && card) yieldCard(card, id);
        setToast({ words: `${box.name} stays stopped. ${ask.gpu === "none" ? "It has no GPU from its next start." : ask.gpu === "whole" ? `${plan.toCard ? capitalCard(plan.toCard.index) : "Its card"} is its own from now.` : "It goes on a card with room when it next starts."}` });
        return { ok: true, id };
      }
      if (plan.way === "restart") {
        const card = plan.toCard?.id ?? null;
        patch(id, { ...size, gpu: ask.gpu, card, state: "restarting", step: plan.installs ? INSTALL_STEPS[0] : RESTART_STEPS[0], processes: [], gpuPercent: 0 });
        if (ask.gpu === "whole" && card) yieldCard(card, id);
        const steps = plan.installs ? INSTALL_STEPS : RESTART_STEPS;
        walk(id, steps.filter((step) => ask.gpu !== "none" || !/nvidia-smi|claim/.test(step)), "restarting", { processes: displayProcesses(box.desktop, card), userspace: plan.installs ?? box.userspace }, `${box.name} is back${plan.toCard ? ` on ${cardName(plan.toCard)}` : " with no GPU"}.`);
        return { ok: true, id };
      }
      patch(id, { ...size, gpu: ask.gpu });
      if (ask.gpu === "whole" && box.card) yieldCard(box.card, id);
      setToast({ words: plan.way === "live" ? `${box.name} has ${ask.gpu === "whole" ? `${cardName(plan.fromCard!)} to itself` : `a shared GPU on ${cardName(plan.fromCard!)}`} now. Nothing in it stopped.` : `Resized ${box.name}.` });
      return { ok: true, id };
    },
    [patch, walk, yieldCard],
  );

  const release = useCallback(
    (id: string) => {
      const box = world.current.boxes.find((each) => each.id === id);
      commit(world.current.boxes.filter((each) => each.id !== id));
      if (box) setToast({ words: `Released ${box.name}.` });
    },
    [commit],
  );

  const power = useCallback(
    (id: string, on: boolean) => {
      const box = world.current.boxes.find((each) => each.id === id);
      if (!box) return;
      if (!on) {
        patch(id, { state: "stopped", processes: [], gpuPercent: 0, notice: undefined });
        return;
      }
      let card = box.card;
      if (box.gpu === "shared" && backendOf(box.backend).stoppedSharedYields) {
        const placed = place(world.current, box.backend, "shared", box.desktop, { except: box.id, prefer: box.card });
        if (!placed.card) {
          patch(id, { notice: `${box.name} did not start: ${placed.person ?? "no card has room."}` });
          return;
        }
        card = placed.card.id;
      }
      patch(id, { card, notice: undefined, state: "starting", step: box.gpu === "none" ? "Starting" : "Placing on its card" });
      const steps = box.gpu === "none" ? ["Starting"] : ["Placing on its card", "Starting", "Checking nvidia-smi"];
      walk(id, steps, "starting", { processes: box.userspace === HOST_DRIVER ? displayProcesses(box.desktop, card) : [] }, `${box.name} is ready${card && box.gpu !== "none" ? ` on ${cardName(cardById(world.current, card)!)}` : ""}.`);
    },
    [patch, walk],
  );

  const updateUserspace = useCallback(
    (id: string) => {
      const box = world.current.boxes.find((each) => each.id === id);
      if (!box) return;
      patch(id, { state: "restarting", step: UPDATE_STEPS[0], processes: [], gpuPercent: 0 });
      walk(id, UPDATE_STEPS, "restarting", { userspace: HOST_DRIVER, processes: displayProcesses(box.desktop, box.card) }, `${box.name} has NVIDIA's userspace ${HOST_DRIVER}, and nvidia-smi works in it.`);
    },
    [patch, walk],
  );

  const setSettings = useCallback((backend: BackendId, next: GpuSettings) => setAll((all) => ({ ...all, [backend]: next })), []);
  const setKindGpu = useCallback((kind: KindId, gpu: GpuPart) => setKinds((all) => ({ ...all, [kind]: gpu })), []);
  const rememberFormGpu = useCallback((kind: KindId, gpu: GpuPart) => setFormGpu((all) => ({ ...all, [kind]: gpu })), []);

  const reset = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current = [];
    named.current = 0;
    commit(boxesAt(now));
    setAll(DEFAULT_SETTINGS);
    setKinds(DEFAULT_KIND_GPU);
    setFormGpu({});
    setToast(null);
  }, [commit, now]);

  const value = useMemo<StoreValue>(
    () => ({ boxes, cards: CARDS, settings, now, toast, kindGpu, formGpu, create, resize, release, power, updateUserspace, setSettings, setKindGpu, rememberFormGpu, reset }),
    [boxes, settings, now, toast, kindGpu, formGpu, create, resize, release, power, updateUserspace, setSettings, setKindGpu, rememberFormGpu, reset],
  );
  return <Store.Provider value={value}>{children}</Store.Provider>;
}

function capitalCard(index: number): string {
  return `Card ${index}`;
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
