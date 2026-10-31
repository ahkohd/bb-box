import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { scopedStorage } from "../src/backends/index.ts";
import type { Backend, Price } from "../src/backends/types.ts";
import { BY_COMMAND, type BoxEventKind } from "../src/core/box-log.ts";
import { BoxError, Boxes, type BoxRecord } from "../src/core/boxes.ts";
import type { GeneralConfig } from "../src/core/config.ts";
import { checkDocument, emptyDocument, snapshotConfig, type SnapshotSettings } from "../src/core/document.ts";
import { LOST_AFTER_MISSING_MS, snapshotLine, type Caller, type SnapshotOperation, type Standing } from "../src/core/snapshot.ts";
import { Snapshots, type HoldStep, type RestoreGuard } from "../src/core/snapshots.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { quote } from "../src/transports/process.ts";
import { SNAPSHOT_TABLES, migrateFile, moveFromMain, openBoxFiles, unopenedFiles, type DatabaseSource } from "../src/plugin/attached-files.ts";
import { BOX_LOG_MIGRATIONS, BoxLogStore } from "../src/plugin/box-log-store.ts";
import { SNAPSHOT_MIGRATIONS, SnapshotStore } from "../src/plugin/snapshot-store.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FakeSnapshots as Provider, type Held } from "./fake-snapshots.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";

export const THREAD = "thr_one";
export const COMMAND: Caller = { is: "command" };
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

export function world(options: { readonly identityTool?: string; readonly markersOn?: boolean } = {}) {
  const root = tempDir("snapshots");
  const kv = new MemoryStorage();
  const backendStorage = scopedStorage(kv, "backend/fake/");
  let handle: Database.Database | null = null;
  const source = { database: () => (handle?.open ? handle : (handle = new Database(join(root, "data.db")))) as never };
  let files = openBoxFiles(source, { log: BOX_LOG_MIGRATIONS, history: [], snapshots: SNAPSHOT_MIGRATIONS });
  let clock = Date.UTC(2026, 9, 30, 10, 42);
  const now = () => clock;
  const provider = new Provider();
  const holds: { step: HoldStep | null } = { step: null };
  const state = {
    root,
    kv,
    provider,
    holds,
    active: true,
    threadState: "live" as "live" | "ended",
    settings: {} as SnapshotSettings,
    price: null as Price | null,
    guard: { threads: [], threadsUnread: null, control: false, terminals: 0 } as RestoreGuard,
    undoByCopy: false,
    backend: new FakeBackend({ root, storage: backendStorage, ...(options.identityTool ? { identityTool: options.identityTool } : {}) }),
    log: new BoxLogStore({ file: files.log, now }),
    store: new SnapshotStore({ file: files.snapshots, now }),
    boxes: null as unknown as Boxes,
    snapshots: null as unknown as Snapshots,
    errors: [] as string[],
    logs: [] as string[],
    boxLogs: [] as string[],
    tick(ms: number) {
      clock += ms;
    },
    get now() {
      return clock;
    },
    kinds(boxId: string): BoxEventKind[] {
      return state.log.events(boxId).map((event) => event.kind);
    },
    async restart() {
      state.snapshots.dispose();
      await state.boxes.dispose();
      files = openBoxFiles(source, { log: BOX_LOG_MIGRATIONS, history: [], snapshots: SNAPSHOT_MIGRATIONS });
      state.log = new BoxLogStore({ file: files.log, now });
      state.store = new SnapshotStore({ file: files.snapshots, now });
      state.backend = new FakeBackend({ root, storage: backendStorage });
      build();
    },
    source,
    forgetBox(box: BoxRecord) {
      return Promise.all([kv.delete(`box/${box.threadId}/${box.id}`), kv.delete(`index/${box.id}`)]);
    },
    forgetRecords() {
      handle!.prepare("DELETE FROM boxsnapshots.snapshots").run();
      handle!.prepare("DELETE FROM boxsnapshots.snapshot_operations").run();
    },
  };
  const backends = {
    get: (id: string): Backend | null => (state.active && id === state.backend.id ? state.backend : null),
    active: (): Backend[] => (state.active ? [state.backend] : []),
    on: (): Backend[] => (state.active ? [state.backend] : []),
    kinds: () => (state.active ? state.backend.kinds().map((kind) => ({ kind, backend: state.backend as Backend })) : []),
  };
  const general: GeneralConfig = { perThreadLimit: null, enrol: false, sizes: {}, spares: {}, identityResetBackends: options.markersOn === false ? [] : ["fake"] } as unknown as GeneralConfig;
  const build = () => {
    provider.attach(state.backend, now, root);
    provider.ledger = state.store;
    const boxes: Boxes = new Boxes({
      kv,
      backends,
      general: async () => general,
      notify: () => {},
      thread: async () => ({ state: state.threadState, said: state.threadState }),
      logError: (operation, error) => state.errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
      events: state.log,
      log: (message) => state.boxLogs.push(message),
      ended: (box, how) => state.snapshots.boxEnded(box, how),
      keepsGuest: (backendId, guestRef) => state.snapshots.holdsGuest(backendId, guestRef),
      now,
    });
    state.boxes = boxes;
    state.snapshots = new Snapshots({
      ledger: state.store,
      boxes,
      backends,
      events: state.log,
      notify: () => {},
      logError: (operation, error) => state.errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
      log: (message) => state.logs.push(message),
      hold: async (_operation, step, signal) => {
        if (holds.step !== step) return;
        holds.step = null;
        await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
      settings: () => snapshotConfig({ general: { snapshots: state.settings } }),
      priced: (_backend, offer) => (state.price ? { ...offer, price: state.price } : offer),
      guard: async () => state.guard,
      undoByCopy: () => state.undoByCopy,
      now,
      timeZone: "UTC",
    });
  };
  build();
  return state;
}

export type World = ReturnType<typeof world>;

export async function readyBox(state: World): Promise<BoxRecord> {
  const box = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", who: BY_COMMAND });
  const settled = await state.boxes.settled(box);
  assert.equal(settled?.state, "ready");
  return settled!;
}

export function standing(box: BoxRecord): Standing {
  return { box: { id: box.id, threadId: box.threadId }, runsOn: false };
}

export async function rejection(work: Promise<unknown>): Promise<BoxError> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof BoxError, `expected a BoxError, got ${String(error)}`);
  return error;
}

export function fileIn(state: World, box: BoxRecord, path: string): string {
  return join(state.root, "fake", box.guest!.ref, path);
}

export function writeIn(state: World, box: BoxRecord, path: string, text: string): void {
  const file = fileIn(state, box, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function readIn(state: World, box: BoxRecord, path: string): string | null {
  const file = fileIn(state, box, path);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export async function untilHeld(state: World, held: Promise<unknown>): Promise<void> {
  let ended = false;
  void held.then(() => (ended = true));
  const deadline = Date.now() + 10_000;
  while (state.holds.step !== null) {
    if (ended) throw new Error(`the restore ended before its hold at ${state.holds.step}: ${String(await held)}`);
    if (Date.now() > deadline) throw new Error(`the restore never reached its hold at ${state.holds.step}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function untilStep(state: World, step: string): Promise<SnapshotOperation> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = state.store.unsettled().find((operation) => operation.kind === "restore" && operation.step === step);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`the restore never reached ${step}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const IDENTITY_SCRIPT = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/bb-box-identity.sh", import.meta.url));

export function identityGuest(options: { readonly booted?: boolean; readonly on?: boolean } = {}): { readonly root: string; readonly tool: string } {
  const dir = tempDir("identity-guest");
  const root = join(dir, "root");
  mkdirSync(join(root, "sys/class/net/eth0"), { recursive: true });
  writeFileSync(join(root, "sys/class/net/eth0/address"), "bc:24:11:aa:f1:b6\n");
  writeFileSync(join(root, "sys/class/net/eth0/type"), "1\n");
  const tool = join(dir, "bb-box-identity");
  writeFileSync(tool, `#!/bin/sh\nBBBOX_IDENTITY_ROOT=${quote(root)} BBBOX_IDENTITY_NIC_WAIT_SECONDS=0 exec bash ${quote(IDENTITY_SCRIPT)} "$@"\n`, { mode: 0o755 });
  if (options.on !== false) assert.equal(spawnSync(tool, ["enable", "--no-unit"]).status, 0, "the image's build turned the reset on");
  if (options.booted !== false) assert.equal(spawnSync(tool, ["boot"]).status, 0, "the boot check ran, as its unit runs it at the box's first boot");
  return { root, tool };
}

export function withIdentitySource(state: World, source: "eth" | "device" | "value"): void {
  (state.backend as unknown as Record<string, unknown>).identitySource = () => source;
}

export function armedWorld(): World {
  const guest = identityGuest();
  const state = world({ identityTool: guest.tool });
  withIdentitySource(state, "eth");
  return state;
}
