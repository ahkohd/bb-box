import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BOX_COUNTS,
  DOCKER_MACHINES,
  NOW,
  TART_PROBLEM,
  driverOf,
  healthyChecks,
  initialDocument,
  kindOf,
  offersOf,
  type BackendConfig,
  type BackendLive,
  type Document,
  type Health,
} from "./data";

export type Scenario = "healthy" | "problem" | "first-run";
export type Elsewhere = "none" | "same" | "other";

export interface Problem {
  readonly path: string;
  readonly message: string;
}

export interface Conflict {
  readonly path: string;
  readonly label: string;
  readonly saved: string;
  readonly mine: string;
}

export type SaveResult =
  | { readonly ok: true; readonly revision: number; readonly rebased: boolean }
  | { readonly ok: false; readonly reason: "problems"; readonly problems: readonly Problem[] }
  | { readonly ok: false; readonly reason: "error"; readonly message: string }
  | { readonly ok: false; readonly reason: "conflict"; readonly conflicts: readonly Conflict[]; readonly revision: number };

export interface FirstRunSetup {
  readonly state: "offer" | "building" | "built";
  readonly step: number;
  readonly startedAt: number;
}

interface State {
  readonly scenario: Scenario;
  readonly doc: Document;
  readonly live: Readonly<Record<string, BackendLive>>;
  readonly failNextSave: boolean;
  readonly elsewhere: Elsewhere;
  readonly checkingAll: boolean;
  readonly firstRun: FirstRunSetup;
}

export const BUILD_STEPS = 9;

function liveFor(backend: BackendConfig, scenario: Scenario): BackendLive {
  const problem = scenario === "problem";
  const health: Health | null = !backend.enabled ? null : problem && backend.id === "tart" ? TART_PROBLEM : healthyChecks(backend);
  const offline = problem && backend.id === "docker:pc-1";
  const machine = backend.fields.host && String(backend.fields.host).startsWith("bb:") ? DOCKER_MACHINES.find((each) => `bb:${each.id}` === backend.fields.host) : undefined;
  return {
    boxes: BOX_COUNTS[backend.id] ?? 0,
    offers: !backend.enabled || (problem && backend.id === "tart") || offline ? [] : offersOf(backend),
    health: offline && health ? { ...health, summary: "pc-1 is offline in BB", checks: [{ id: "relay", name: "BB machine pc-1", status: "warn", detail: "Offline in BB since 08:12. Its boxes wait for it.", fix: "Start pc-1, or turn this backend off to stop new boxes going there." }] } : health,
    checking: false,
    bbMachine: machine ? { name: machine.name, connected: !offline, facts: `Docker ${machine.docker} · ${machine.facts}` } : undefined,
  };
}

function initial(scenario: Scenario): State {
  const doc = initialDocument(scenario === "first-run");
  return {
    scenario,
    doc,
    live: Object.fromEntries(doc.backends.map((backend) => [backend.id, liveFor(backend, scenario)])),
    failNextSave: false,
    elsewhere: "none",
    checkingAll: false,
    firstRun: { state: "offer", step: 0, startedAt: 0 },
  };
}

const REQUIRED: Record<string, readonly string[]> = {
  "proxmox-lxc": ["url", "token-id", "token-secret"],
  hetzner: ["token"],
  namespace: ["token"],
  "ssh-pool": ["machines", "known-hosts"],
};

function emptyValue(value: unknown): boolean {
  return value === undefined || value === "" || (typeof value === "object" && value !== null && "set" in value && !(value as { set: boolean }).set);
}

export function problemsOf(doc: Document, part: string): Problem[] {
  const problems: Problem[] = [];
  if (part.startsWith("backends.")) {
    const id = part.slice("backends.".length);
    const backend = doc.backends.find((candidate) => candidate.id === id);
    if (!backend) return problems;
    const driver = driverOf(backend.type);
    if (backend.enabled) {
      for (const key of REQUIRED[backend.type] ?? []) {
        if (emptyValue(backend.fields[key])) {
          const field = driver.fields.find((candidate) => candidate.key === key)!;
          problems.push({ path: `${part}.${key}`, message: field.secret ? `Paste the ${field.label}.` : `Fill in the ${field.label}.` });
        }
      }
      if (backend.type === "tart" && !(backend.hosts ?? []).length) problems.push({ path: `${part}.hosts`, message: "Add a Mac: Tart needs one to make boxes on." });
    }
    for (const field of driver.fields) {
      const value = backend.fields[field.key];
      if (field.type === "number" && value !== undefined && value !== "" && !Number.isFinite(Number(value))) problems.push({ path: `${part}.${field.key}`, message: "Use a number." });
    }
    const url = backend.fields.url;
    if (typeof url === "string" && url && !/^https:\/\//.test(url)) problems.push({ path: `${part}.url`, message: "Use an https:// address, as the setup guide's token file gives it." });
  }
  if (part === "monitor") {
    const seconds = doc.monitor.refreshIntervalSeconds;
    if (!Number.isInteger(seconds) || seconds < 2 || seconds > 60) problems.push({ path: "monitor.refreshIntervalSeconds", message: "Use a whole number of seconds from 2 to 60." });
  }
  if (part === "general") {
    const count = doc.general.boxesPerThread;
    if (!Number.isInteger(count) || count < 0) problems.push({ path: "general.boxesPerThread", message: "Use a whole number of boxes, or 0 for no limit." });
  }
  if (part.startsWith("kinds.")) {
    const id = part.slice("kinds.".length);
    const kind = doc.kinds[id];
    if (kind) {
      for (const [name, size] of Object.entries(kind.presets)) {
        if (!Number.isInteger(size.cores) || size.cores < 1) problems.push({ path: `${part}.presets.${name}.cores`, message: "Use at least 1 core." });
        if (kindOf(id).os === "linux" && size.memoryMiB < 2048) problems.push({ path: `${part}.presets.${name}.memoryMiB`, message: "A Linux box needs at least 2 GiB." });
        if (size.cores > kind.largest.cores || size.memoryMiB > kind.largest.memoryMiB) problems.push({ path: `${part}.presets.${name}`, message: "It is larger than the largest custom size." });
      }
      if (!Number.isInteger(kind.spares) || kind.spares < 0 || kind.spares > 10) problems.push({ path: `${part}.spares`, message: "Use 0 to 10 spares." });
    }
  }
  return problems;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function changedElsewhere(doc: Document, draft: Document, part: string): { doc: Document; conflict: Conflict | null } {
  if (part.startsWith("backends.")) {
    const id = part.slice("backends.".length);
    const backend = doc.backends.find((candidate) => candidate.id === id);
    const mine = draft.backends.find((candidate) => candidate.id === id);
    if (backend && mine) {
      const driver = driverOf(backend.type);
      const field = driver.fields.find((candidate) => JSON.stringify(mine.fields[candidate.key] ?? "") !== JSON.stringify(backend.fields[candidate.key] ?? "")) ?? driver.fields[0]!;
      const before = backend.fields[field.key] ?? field.default ?? "";
      const theirs = field.type === "number" ? Number(before || 0) * 2 || 1 : `${String(before) || "value"}-2`;
      return { doc: { ...doc, backends: doc.backends.map((each) => (each.id === id ? { ...each, fields: { ...each.fields, [field.key]: theirs } } : each)) }, conflict: { path: `${part}.${field.key}`, label: field.label, saved: String(theirs), mine: String(mine.fields[field.key] ?? "") } };
    }
  }
  if (part === "monitor") return { doc: { ...doc, monitor: { ...doc.monitor, refreshIntervalSeconds: 10 } }, conflict: { path: "monitor.refreshIntervalSeconds", label: "Refresh interval", saved: "10", mine: String(doc.monitor.refreshIntervalSeconds) } };
  return { doc, conflict: null };
}

interface Store extends State {
  setScenario(scenario: Scenario): void;
  setFailNextSave(fail: boolean): void;
  setElsewhere(elsewhere: Elsewhere): void;
  save(part: string, change: (doc: Document) => Document, options?: { force?: boolean }): Promise<SaveResult>;
  check(id: string): Promise<void>;
  checkAll(): Promise<void>;
  checkDraft(backend: BackendConfig): Promise<Health>;
  useDocker(): void;
  useMachine(machineId: string): Promise<SaveResult>;
  addBackend(backend: BackendConfig): Promise<SaveResult>;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(() => initial("healthy"));
  const current = useRef(state);
  current.current = state;
  const update = useCallback((next: (state: State) => State) => {
    setState((before) => {
      const after = next(before);
      current.current = after;
      return after;
    });
  }, []);

  const save = useCallback(
    async (part: string, change: (doc: Document) => Document, options: { force?: boolean } = {}): Promise<SaveResult> => {
      await wait(650);
      const before = current.current;
      if (before.failNextSave) {
        update((state) => ({ ...state, failNextSave: false }));
        return { ok: false, reason: "error", message: "BB Box did not answer within 10 s. Nothing was saved; your changes are still here." };
      }
      let base = before.doc;
      let rebased = false;
      if (before.elsewhere === "other") {
        base = { ...base, revision: base.revision + 1 };
        rebased = true;
      }
      if (before.elsewhere === "same" && !options.force) {
        const { doc, conflict } = changedElsewhere(base, change(base), part);
        if (conflict) {
          const revision = base.revision + 1;
          update((state) => ({ ...state, elsewhere: "none", doc: { ...doc, revision } }));
          return { ok: false, reason: "conflict", conflicts: [conflict], revision };
        }
      }
      const draft = change(base);
      const problems = problemsOf(draft, part);
      if (problems.length) return { ok: false, reason: "problems", problems };
      const revision = base.revision + 1;
      update((state) => {
        const doc = { ...draft, revision };
        const live = { ...state.live };
        for (const backend of doc.backends) {
          const was = state.doc.backends.find((each) => each.id === backend.id);
          if (!was || was.enabled !== backend.enabled) live[backend.id] = liveFor(backend, state.scenario === "first-run" ? "healthy" : state.scenario);
        }
        for (const id of Object.keys(live)) if (!doc.backends.some((backend) => backend.id === id)) delete live[id];
        return { ...state, doc, live, elsewhere: state.elsewhere === "other" ? "none" : state.elsewhere };
      });
      return { ok: true, revision, rebased };
    },
    [update],
  );

  const check = useCallback(
    async (id: string) => {
      update((state) => ({ ...state, live: { ...state.live, [id]: { ...state.live[id]!, checking: true } } }));
      await wait(1400);
      update((state) => {
        const backend = state.doc.backends.find((each) => each.id === id);
        if (!backend) return state;
        const fresh = liveFor(backend, "healthy");
        return { ...state, live: { ...state.live, [id]: { ...fresh, health: fresh.health ? { ...fresh.health, checkedAt: Date.now() } : null, checking: false } } };
      });
    },
    [update],
  );

  const checkAll = useCallback(async () => {
    update((state) => ({ ...state, checkingAll: true, live: Object.fromEntries(Object.entries(state.live).map(([id, live]) => [id, { ...live, checking: true }])) }));
    await wait(1800);
    update((state) => ({
      ...state,
      checkingAll: false,
      live: Object.fromEntries(
        state.doc.backends.map((backend) => {
          const fresh = liveFor(backend, state.scenario === "problem" ? "problem" : "healthy");
          return [backend.id, { ...fresh, health: fresh.health ? { ...fresh.health, checkedAt: Date.now() } : null, checking: false }];
        }),
      ),
    }));
  }, [update]);

  const checkDraft = useCallback(async (backend: BackendConfig): Promise<Health> => {
    await wait(1300);
    const problems = problemsOf({ ...current.current.doc, backends: [{ ...backend, enabled: true }] }, `backends.${backend.id}`);
    if (problems.length) {
      return {
        summary: "The check needs the fields marked",
        checkedAt: Date.now(),
        checks: problems.map((problem, index) => ({ id: `field-${index}`, name: "Settings", status: "fail" as const, detail: problem.message })),
      };
    }
    return { ...healthyChecks(backend), checkedAt: Date.now() };
  }, []);

  const useDocker = useCallback(() => {
    update((state) => ({ ...state, firstRun: { state: "building", step: 1, startedAt: Date.now() } }));
    let step = 1;
    const tick = setInterval(() => {
      step += 1;
      if (step <= BUILD_STEPS) {
        update((state) => ({ ...state, firstRun: { ...state.firstRun, step } }));
        return;
      }
      clearInterval(tick);
      update((state) => {
        const backend: BackendConfig = { id: "docker", type: "docker", enabled: true, fields: { "desktop-image": "", "wayland-desktop-image": "" } };
        const doc = { ...state.doc, revision: state.doc.revision + 1, backends: [backend], general: { ...state.doc.general, nightlyImages: true } };
        return {
          ...state,
          doc,
          firstRun: { ...state.firstRun, state: "built" },
          live: { docker: { boxes: 0, offers: ["linux"], checking: false, health: { summary: "Docker 29.8 on bb-1", checkedAt: Date.now(), checks: [{ id: "daemon", name: "Docker", status: "ok", detail: "29.8.2 on bb-1, BB's server." }, { id: "images", name: "Images", status: "ok", detail: "bbbox/linux:1 built just now." }] } } },
        };
      });
    }, 650);
  }, [update]);

  const useMachine = useCallback(
    async (machineId: string) => {
      const machine = DOCKER_MACHINES.find((each) => each.id === machineId)!;
      const backend: BackendConfig = { id: `docker:${machine.name}`, type: "docker", enabled: true, fields: { host: `bb:${machine.id}` } };
      const result = await save(`backends.${backend.id}`, (doc) => ({ ...doc, backends: [...doc.backends, backend] }));
      if (result.ok) {
        update((state) => ({ ...state, live: { ...state.live, [backend.id]: { boxes: 0, offers: [], checking: true, health: null, bbMachine: { name: machine.name, connected: true, facts: `Docker ${machine.docker} · ${machine.facts}` } } } }));
        setTimeout(() => {
          update((state) => ({ ...state, live: { ...state.live, [backend.id]: { boxes: 0, offers: ["linux", "linux-desktop-cpu"], checking: false, bbMachine: { name: machine.name, connected: true, facts: `Docker ${machine.docker} · ${machine.facts}` }, health: { summary: `Docker ${machine.docker} on ${machine.name}`, checkedAt: Date.now(), checks: [{ id: "relay", name: `BB machine ${machine.name}`, status: "ok", detail: "Connected; Docker answers through BB." }, { id: "images", name: "Images", status: "ok", detail: "bbbox/linux:1 built just now." }] } } } }));
        }, 2600);
      }
      return result;
    },
    [save, update],
  );

  const addBackend = useCallback(
    async (backend: BackendConfig) => {
      const result = await save(`backends.${backend.id}`, (doc) => ({ ...doc, backends: [...doc.backends.filter((each) => each.id !== backend.id), backend] }));
      if (result.ok && backend.enabled) void check(backend.id);
      return result;
    },
    [save, check],
  );

  const store = useMemo<Store>(
    () => ({
      ...state,
      setScenario: (scenario) => setState(() => {
        const next = initial(scenario);
        current.current = next;
        return next;
      }),
      setFailNextSave: (failNextSave) => update((state) => ({ ...state, failNextSave })),
      setElsewhere: (elsewhere) => update((state) => ({ ...state, elsewhere })),
      save,
      check,
      checkAll,
      checkDraft,
      useDocker,
      useMachine,
      addBackend,
    }),
    [state, update, save, check, checkAll, checkDraft, useDocker, useMachine, addBackend],
  );
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("No store");
  return store;
}

export function relative(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour ago" : `${hours} hours ago`;
}

export { NOW };
