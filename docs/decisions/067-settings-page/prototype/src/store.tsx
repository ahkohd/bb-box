import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BOX_COUNTS,
  DOCKER_MACHINES,
  STANDARD_IMAGES,
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
  type StandardImage,
} from "./data";
import { readPath, same, type Path } from "./paths";

export type Scenario = "healthy" | "problem" | "first-run";
export type NextSave = "ok" | "refused" | "lost" | "dropped";
export type ServerDocker = "ready" | "missing" | "permission" | "disk";

export interface Problem {
  readonly path: Path;
  readonly message: string;
}

export type ApplyResult =
  | { readonly ok: true; readonly revision: number; readonly operation: string }
  | { readonly ok: false; readonly reason: "revision"; readonly revision: number }
  | { readonly ok: false; readonly reason: "problems"; readonly problems: readonly Problem[] }
  | { readonly ok: false; readonly reason: "error"; readonly message: string };

export class LostReply extends Error {}

export interface FirstRunSetup {
  readonly state: "offer" | "building" | "built" | "failed";
  readonly step: number;
}

interface State {
  readonly scenario: Scenario;
  readonly doc: Document;
  readonly live: Readonly<Record<string, BackendLive>>;
  readonly nextSave: NextSave;
  readonly macBack: boolean;
  readonly serverDocker: ServerDocker;
  readonly checkingAll: boolean;
  readonly firstRun: FirstRunSetup;
  readonly monitorChanged: boolean;
  readonly receipts: Readonly<Record<string, number>>;
  readonly raceNext: number;
  readonly setupDone: boolean;
}

export const BUILD_STEPS = 9;
export const STALE_MS = 60 * 60_000;

function liveFor(backend: BackendConfig, scenario: Scenario, revision: number, macBack = false): BackendLive {
  const problem = scenario === "problem";
  const tartDown = problem && backend.id === "tart" && !macBack;
  const offline = problem && backend.id === "docker:pc-1";
  const healthy = healthyChecks(backend);
  const health: Health | null = !backend.enabled ? (backend.id === "namespace" ? { ...healthyChecks(backend), checkedAt: Date.now() - 30 * 3_600_000 } : null) : tartDown ? TART_PROBLEM : healthy;
  const machine = String(backend.fields.host ?? "").startsWith("bb:") ? DOCKER_MACHINES.find((each) => `bb:${each.id}` === backend.fields.host) : undefined;
  return {
    boxes: BOX_COUNTS[backend.id] ?? 0,
    offers: !backend.enabled || tartDown || offline ? [] : offersOf(backend),
    health: offline && health ? { ...health, summary: "pc-1 is offline in BB", checks: [{ id: "relay", name: "BB machine pc-1", status: "warn", detail: "Offline in BB since 08:12. Its boxes wait for it.", fix: "Start pc-1, or turn this backend off so new boxes go elsewhere." }] } : health ? { ...health, checkedRevision: revision } : null,
    checking: false,
    changedRevision: revision,
    warmShort: problem && backend.id === "proxmox-qemu" ? [{ kind: "windows-desktop", ready: 0, wanted: 1, reason: "pve-1 has 3 GiB free and keeps 4 GiB free, so no Windows desktop fits." }] : undefined,
    bbMachine: machine ? { name: machine.name, connected: !offline, facts: `Docker ${machine.docker} · ${machine.facts}` } : undefined,
  };
}

export function imagesFor(scenario: Scenario): readonly StandardImage[] {
  if (scenario === "problem") return STANDARD_IMAGES;
  return STANDARD_IMAGES.map((image) => (image.lastState === "failed" ? { ...image, last: "Waits for tonight's run", lastState: null } : image));
}

function initial(scenario: Scenario): State {
  const doc = initialDocument(scenario === "first-run");
  return {
    scenario,
    doc,
    live: Object.fromEntries(doc.backends.map((backend) => [backend.id, liveFor(backend, scenario, doc.revision)])),
    nextSave: "ok",
    macBack: false,
    serverDocker: "ready",
    checkingAll: false,
    firstRun: { state: "offer", step: 0 },
    monitorChanged: false,
    receipts: {},
    raceNext: 0,
    setupDone: scenario !== "first-run",
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

const MAC_LIMITS: Record<string, { least: number; most: number; words: string }> = {
  "ios-hosts-most": { least: 1, most: 24, words: "the slots of a shared iOS host on it" },
  "ios-hosts-cores": { least: 2, most: 64, words: "the cores of a shared iOS host on it" },
  "ios-hosts-memory-gib": { least: 8, most: 512, words: "the memory of a shared iOS host on it, in GiB," },
};

export function problemsOf(doc: Document, parts: ReadonlySet<string>): Problem[] {
  const problems: Problem[] = [];
  const add = (path: Path, message: string) => problems.push({ path, message });
  for (const backend of doc.backends) {
    if (!parts.has(`backends/${backend.id}`)) continue;
    const driver = driverOf(backend.type);
    const at = (key: string) => `backends/${backend.id}/fields/${key}`;
    if (backend.enabled) {
      for (const key of REQUIRED[backend.type] ?? []) {
        if (emptyValue(backend.fields[key])) {
          const field = driver.fields.find((candidate) => candidate.key === key)!;
          add(at(key), field.secret ? `Paste the ${field.label}. It cannot be on without it.` : `Fill in the ${field.label}. It cannot be on without it.`);
        }
      }
      if (backend.type === "tart" && !(backend.hosts ?? []).length) add(`backends/${backend.id}/hosts`, "Add a Mac: Tart makes boxes on your Macs.");
    }
    for (const field of driver.fields) {
      const value = backend.fields[field.key];
      if (field.type === "number" && value !== undefined && value !== "" && !Number.isFinite(Number(value))) add(at(field.key), `${field.label} is a number.`);
    }
    const url = backend.fields.url;
    if (typeof url === "string" && url && !/^https:\/\//.test(url)) add(at("url"), "Use an https:// address, as the setup guide's token file gives it.");
    for (const host of backend.hosts ?? []) {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(host.name)) add(`backends/${backend.id}/hosts/${host.name}/name`, "Name the Mac with lower-case letters, digits and hyphens.");
      for (const [key, limit] of Object.entries(MAC_LIMITS)) {
        const value = host.fields[key];
        if (value === undefined || value === "") continue;
        const whole = Number(value);
        if (!Number.isInteger(whole) || whole < limit.least || whole > limit.most) add(`backends/${backend.id}/hosts/${host.name}/fields/${key}`, `Mac ${host.name}: ${limit.words} must be a whole number from ${limit.least} to ${limit.most}, or empty for bb-box's estimate.`);
      }
      if (!host.fields.address) add(`backends/${backend.id}/hosts/${host.name}/fields/address`, `Mac ${host.name || "new"}: give its address.`);
    }
    for (const [kind, count] of Object.entries(backend.warm ?? {})) {
      if (!Number.isInteger(count) || count < 0 || count > 20) add(`backends/${backend.id}/warm/${kind}`, "Keep 0 to 20 warm boxes.");
    }
  }
  if (parts.has("monitor")) {
    const seconds = doc.monitor.refreshIntervalSeconds;
    if (!Number.isInteger(seconds) || seconds < 2 || seconds > 60) add("monitor/refreshIntervalSeconds", "Use a whole number of seconds from 2 to 60.");
  }
  if (parts.has("general")) {
    const count = doc.general.boxesPerThread;
    if (!Number.isInteger(count) || count < 0) add("general/boxesPerThread", "Use a whole number of boxes, or 0 for no limit.");
    if (doc.general.tailnet.mode === "oauth" && (!doc.general.tailnet.clientId.set || !doc.general.tailnet.clientSecret.set)) add("general/tailnet/clientSecret", "Paste the OAuth client's ID and secret to join machines to the tailnet.");
    if (doc.kinds[doc.general.defaultKind]?.enabled === false) add("general/defaultKind", "The default kind is off. Choose a kind that is on.");
  }
  for (const [id, kind] of Object.entries(doc.kinds)) {
    if (!parts.has(`kinds/${id}`)) continue;
    for (const [name, size] of Object.entries(kind.presets)) {
      if (!Number.isInteger(size.cores) || size.cores < 1) add(`kinds/${id}/presets/${name}/cores`, "Use at least 1 core.");
      if (kindOf(id).os === "linux" && !(size.memoryMiB >= 2048)) add(`kinds/${id}/presets/${name}/memoryMiB`, "A Linux box needs at least 2 GiB.");
      if (size.cores > kind.largest.cores) add(`kinds/${id}/presets/${name}/cores`, `More cores than the largest custom size, ${kind.largest.cores}.`);
      if (size.memoryMiB > kind.largest.memoryMiB) add(`kinds/${id}/presets/${name}/memoryMiB`, `More memory than the largest custom size, ${kind.largest.memoryMiB / 1024} GiB.`);
    }
    if (!Number.isInteger(kind.spares) || kind.spares < 0 || kind.spares > 10) add(`kinds/${id}/spares`, "Keep 0 to 10 spares.");
    if (!kind.enabled && doc.general.defaultKind === id) add(`kinds/${id}/enabled`, "This is the default kind, so it stays on. Choose another default first.");
  }
  return problems;
}

function partsChanged(before: Document, after: Document): Set<string> {
  const parts = new Set<string>();
  const ids = new Set([...before.backends.map((each) => each.id), ...after.backends.map((each) => each.id)]);
  for (const id of ids) if (!same(before.backends.find((each) => each.id === id), after.backends.find((each) => each.id === id))) parts.add(`backends/${id}`);
  for (const id of Object.keys(after.kinds)) if (!same(before.kinds[id], after.kinds[id])) parts.add(`kinds/${id}`);
  if (!same(before.general, after.general)) parts.add("general");
  if (!same(before.monitor, after.monitor)) parts.add("monitor");
  return parts;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamped(doc: Document, secrets: Readonly<Record<Path, string | null>>, revision: number): Document {
  let next = doc;
  for (const [path, value] of Object.entries(secrets)) {
    const state = { set: value !== null, version: `r${revision}` };
    const [root, id, section, key] = path.split("/");
    if (root === "backends") next = { ...next, backends: next.backends.map((each) => (each.id === id && section === "fields" ? { ...each, fields: { ...each.fields, [key!]: state } } : each)) };
    if (root === "general" && id === "tailnet") next = { ...next, general: { ...next.general, tailnet: { ...next.general.tailnet, [section!]: state } } };
    if (root === "files") {
      const filePath = decodeURIComponent(path.slice("files/".length));
      next = { ...next, general: { ...next.general, files: next.general.files.map((file) => (file.path === filePath ? { ...file, content: state } : file)) } };
    }
  }
  return next;
}

interface Store extends State {
  setScenario(scenario: Scenario): void;
  setNextSave(next: NextSave): void;
  setServerDocker(docker: ServerDocker): void;
  bringMacBack(): void;
  agentApply(): void;
  apply(draft: Document, revision: number, secrets?: Readonly<Record<Path, string | null>>, operation?: string): Promise<ApplyResult>;
  receipt(operation: string): number | null;
  setRaceNext(count: number): void;
  fetch(): Document;
  check(id: string): Promise<void>;
  checkAll(): Promise<void>;
  checkDraft(backend: BackendConfig): Promise<Health>;
  useDocker(): void;
  useMachine(machineId: string): Promise<ApplyResult>;
}

const StoreContext = createContext<Store | null>(null);

const KEPT = "bbbox-prototype-state";

function keptState(): State | null {
  try {
    const raw = sessionStorage.getItem(KEPT);
    return raw ? (JSON.parse(raw) as State) : null;
  } catch {
    return null;
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(() => keptState() ?? initial("healthy"));
  const current = useRef(state);
  current.current = state;
  const update = useCallback((next: (state: State) => State) => {
    setState((before) => {
      const after = next(before);
      current.current = after;
      try {
        sessionStorage.setItem(KEPT, JSON.stringify({ ...after, checkingAll: false }));
      } catch {
        return after;
      }
      return after;
    });
  }, []);

  const runCheck = useCallback(
    async (id: string, ms = 1400) => {
      update((state) => (state.live[id] ? { ...state, live: { ...state.live, [id]: { ...state.live[id]!, checking: true } } } : state));
      await wait(ms);
      update((state) => {
        const backend = state.doc.backends.find((each) => each.id === id);
        const was = state.live[id];
        if (!backend || !was) return state;
        const fresh = liveFor(backend, state.scenario === "problem" ? "problem" : "healthy", state.doc.revision, state.macBack);
        const health = fresh.health ? { ...fresh.health, checkedAt: Date.now(), checkedRevision: was.changedRevision } : null;
        return { ...state, live: { ...state.live, [id]: { ...was, offers: fresh.offers, health, checking: false } } };
      });
    },
    [update],
  );

  const apply = useCallback(
    async (draft: Document, revision: number, secrets: Readonly<Record<Path, string | null>> = {}, operation = `op-${Math.random().toString(36).slice(2)}`): Promise<ApplyResult> => {
      await wait(700);
      const before = current.current;
      const done = before.receipts[operation];
      if (done !== undefined) return { ok: true, revision: done, operation };
      if (before.raceNext > 0) {
        update((state) => ({ ...state, raceNext: state.raceNext - 1, doc: { ...state.doc, revision: state.doc.revision + 1 } }));
        return { ok: false, reason: "revision", revision: before.doc.revision + 1 };
      }
      if (before.nextSave === "dropped") {
        update((state) => ({ ...state, nextSave: "ok" }));
        await wait(1200);
        throw new LostReply("No reply");
      }
      if (before.nextSave === "refused") {
        update((state) => ({ ...state, nextSave: "ok" }));
        return { ok: false, reason: "error", message: "BB Box refused the save: its configuration file is busy." };
      }
      if (revision !== before.doc.revision) return { ok: false, reason: "revision", revision: before.doc.revision };
      const next = revision + 1;
      const candidate = stamped(draft, secrets, next);
      const parts = partsChanged(before.doc, candidate);
      for (const path of Object.keys(secrets)) parts.add(path.startsWith("backends/") ? path.split("/").slice(0, 2).join("/") : "general");
      const problems = problemsOf(candidate, parts);
      if (problems.length) return { ok: false, reason: "problems", problems };
      const stored = { ...candidate, revision: next };
      const turnedOn: string[] = [];
      update((state) => {
        const live = { ...state.live };
        for (const backend of stored.backends) {
          const was = state.doc.backends.find((each) => each.id === backend.id);
          if (!was) {
            live[backend.id] = { ...liveFor(backend, "healthy", next), health: null };
            if (backend.enabled) turnedOn.push(backend.id);
            continue;
          }
          if (!same(was, backend)) {
            const old = live[backend.id] ?? liveFor(backend, state.scenario, next, state.macBack);
            const configChanged = !same(was.fields, backend.fields) || !same(was.hosts, backend.hosts);
            live[backend.id] = { ...old, changedRevision: configChanged ? next : old.changedRevision, offers: backend.enabled ? (old.offers.length ? old.offers : offersOf(backend)) : [] };
            if (!was.enabled && backend.enabled) turnedOn.push(backend.id);
          }
        }
        for (const id of Object.keys(live)) if (!stored.backends.some((backend) => backend.id === id)) delete live[id];
        const offering = stored.backends.some((backend) => backend.enabled && !problemsOf({ ...stored, backends: [backend] }, new Set([`backends/${backend.id}`])).length);
        return { ...state, doc: stored, live, receipts: { ...state.receipts, [operation]: next }, setupDone: state.setupDone || offering, nextSave: state.nextSave === "lost" ? "ok" : state.nextSave, monitorChanged: state.monitorChanged || before.doc.monitor.enabled !== stored.monitor.enabled };
      });
      for (const id of turnedOn) void runCheck(id);
      if (before.nextSave === "lost") {
        await wait(1200);
        throw new LostReply("No reply");
      }
      return { ok: true, revision: next, operation };
    },
    [update, runCheck],
  );

  const agentApply = useCallback(() => {
    update((state) => {
      const revision = state.doc.revision + 1;
      const backends = state.doc.backends.map((backend) =>
        backend.id === "proxmox-lxc"
          ? { ...backend, fields: { ...backend.fields, "reserve-memory-mib": 8192, "token-secret": { set: true, version: `r${revision}` } } }
          : backend.id === "tart"
            ? { ...backend, hosts: (backend.hosts ?? []).map((host) => (host.name === "mac-1" ? { ...host, fields: { ...host.fields, "ios-hosts-cores": 12 } } : host)) }
            : backend,
      );
      const files = state.doc.general.files.map((file) => ({ ...file, content: { set: true, version: `r${revision}` } }));
      const doc: Document = { ...state.doc, revision, backends, general: { ...state.doc.general, boxesPerThread: 4, files }, monitor: { ...state.doc.monitor, refreshIntervalSeconds: 10 }, kinds: { ...state.doc.kinds, linux: { ...state.doc.kinds.linux!, spares: 2 } } };
      const live = { ...state.live };
      if (live["proxmox-lxc"]) live["proxmox-lxc"] = { ...live["proxmox-lxc"], changedRevision: revision };
      return { ...state, doc, live };
    });
  }, [update]);

  const checkAll = useCallback(async () => {
    update((state) => ({ ...state, checkingAll: true }));
    await Promise.all(current.current.doc.backends.filter((backend) => backend.enabled).map((backend) => runCheck(backend.id, 1800)));
    update((state) => ({ ...state, checkingAll: false }));
  }, [update, runCheck]);

  const checkDraft = useCallback(async (backend: BackendConfig): Promise<Health> => {
    await wait(1300);
    const problems = problemsOf({ ...current.current.doc, backends: [{ ...backend, enabled: true }] }, new Set([`backends/${backend.id}`]));
    if (problems.length) {
      return { summary: "The checks need the fields marked", checkedAt: Date.now(), checks: problems.map((problem, index) => ({ id: `field-${index}`, name: "Settings", status: "fail" as const, detail: problem.message })) };
    }
    return { ...healthyChecks(backend), checkedAt: Date.now() };
  }, []);

  const useDocker = useCallback(() => {
    update((state) => ({ ...state, firstRun: { state: "building", step: 1 } }));
    let step = 1;
    const tick = setInterval(() => {
      step += 1;
      if (step <= BUILD_STEPS) {
        update((state) => ({ ...state, firstRun: { ...state.firstRun, step } }));
        return;
      }
      clearInterval(tick);
      update((state) => {
        const revision = state.doc.revision + 1;
        const backend: BackendConfig = { id: "docker", type: "docker", enabled: true, fields: { "desktop-image": "", "wayland-desktop-image": "" } };
        const doc = { ...state.doc, revision, backends: [...state.doc.backends, backend], general: { ...state.doc.general, nightlyImages: true } };
        return {
          ...state,
          doc,
          firstRun: { state: "built", step: BUILD_STEPS },
          setupDone: true,
          live: { ...state.live, docker: { boxes: 0, offers: ["linux"], checking: false, changedRevision: revision, health: { summary: "Docker 29.8 on bb-1", checkedAt: Date.now(), checkedRevision: revision, checks: [{ id: "daemon", name: "Docker", status: "ok", detail: "29.8.2 on bb-1, BB's server." }, { id: "images", name: "Images", status: "ok", detail: "bbbox/linux:1 built just now." }] } } },
        };
      });
    }, 600);
  }, [update]);

  const useMachine = useCallback(
    async (machineId: string): Promise<ApplyResult> => {
      const machine = DOCKER_MACHINES.find((each) => each.id === machineId)!;
      const backend: BackendConfig = { id: `docker:${machine.name}`, type: "docker", enabled: true, fields: { host: `bb:${machine.id}` } };
      const doc = current.current.doc;
      const result = await apply({ ...doc, backends: [...doc.backends, backend] }, doc.revision);
      if (result.ok) {
        update((state) => ({ ...state, live: { ...state.live, [backend.id]: { boxes: 0, offers: [], checking: false, changedRevision: result.revision, health: null, building: "Building its Linux image · step 2 of 9", bbMachine: { name: machine.name, connected: true, facts: `Docker ${machine.docker} · ${machine.facts}` } } } }));
        setTimeout(() => {
          update((state) => (state.live[backend.id] ? { ...state, live: { ...state.live, [backend.id]: { ...state.live[backend.id]!, building: undefined, offers: ["linux", "linux-desktop-cpu"], health: { summary: `Docker ${machine.docker} on ${machine.name}`, checkedAt: Date.now(), checkedRevision: result.revision, checks: [{ id: "relay", name: `BB machine ${machine.name}`, status: "ok", detail: "Connected; Docker answers through BB." }, { id: "images", name: "Images", status: "ok", detail: "bbbox/linux:1 built just now." }] } } } } : state));
        }, 4000);
      }
      return result;
    },
    [apply, update],
  );

  const store = useMemo<Store>(
    () => ({
      ...state,
      setScenario: (scenario) =>
        setState(() => {
          const next = initial(scenario);
          current.current = next;
          sessionStorage.setItem(KEPT, JSON.stringify(next));
          return next;
        }),
      setNextSave: (nextSave) => update((state) => ({ ...state, nextSave })),
      setServerDocker: (serverDocker) => update((state) => ({ ...state, serverDocker, firstRun: { state: "offer", step: 0 } })),
      bringMacBack: () => update((state) => ({ ...state, macBack: true })),
      agentApply,
      apply,
      receipt: (operation) => current.current.receipts[operation] ?? null,
      setRaceNext: (raceNext) => update((state) => ({ ...state, raceNext })),
      fetch: () => current.current.doc,
      check: (id) => runCheck(id),
      checkAll,
      checkDraft,
      useDocker,
      useMachine,
    }),
    [state, update, agentApply, apply, runCheck, checkAll, checkDraft, useDocker, useMachine],
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
  if (hours < 48) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export { readPath };
