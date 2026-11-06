import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { scopedStorage } from "../src/backends/index.ts";
import type { Backend, BackendStorage, Price } from "../src/backends/types.ts";
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

export function world(options: { readonly identityTool?: string; readonly identityRoot?: string; readonly markersOn?: boolean; readonly forkWaitMs?: number; readonly wholeCards?: boolean; readonly backend?: (storage: BackendStorage) => Backend } = {}) {
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
    machineRestores: false,
    unenrolled: [] as string[],
    marksChanged: 0,
    screen: null as ((box: BoxRecord, signal: AbortSignal) => Promise<Uint8Array | null>) | null,
    backend: (options.backend?.(backendStorage) as FakeBackend | undefined) ?? new FakeBackend({ root, storage: backendStorage, ...(options.identityTool ? { identityTool: options.identityTool } : {}), ...(options.identityRoot ? { identityRoot: options.identityRoot } : {}) }),
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
      state.backend = (options.backend?.(backendStorage) as FakeBackend | undefined) ?? new FakeBackend({ root, storage: backendStorage });
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
  const general: GeneralConfig = { perThreadLimit: null, enrol: false, sizes: {}, spares: {}, identityResetBackends: options.markersOn === false ? [] : ["fake"], wholeCards: options.wholeCards ?? true } as unknown as GeneralConfig;
  const build = () => {
    if (!options.backend) provider.attach(state.backend, now, root);
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
      forked: (box) => state.snapshots.forkEnded(box),
      keepsGuest: (backendId, guestRef, ended) => state.snapshots.holdsGuest(backendId, guestRef, ended),
      holdKeptOn: (backendId, guestRef, boxId) => state.snapshots.holdKeptOn(backendId, guestRef, BY_COMMAND, boxId),
      leftoverReleased: (backendId, guestRef, boxId, why) => state.snapshots.leftoverReleased(backendId, guestRef, boxId, why),
      beforeRelease: (box, who) => state.snapshots.holdKept(box, who),
      unenrol: async (box) => void state.unenrolled.push(box.id),
      ...(options.forkWaitMs !== undefined ? { forkWaitMs: options.forkWaitMs } : {}),
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
      screen: (box, signal) => (state.screen ? state.screen(box, signal) : Promise.resolve(null)),
      undoByCopy: () => state.undoByCopy,
      machineRestores: () => state.machineRestores,
      marksChanged: () => {
        state.marksChanged++;
      },
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
  const deadline = Date.now() + 60_000;
  while (state.holds.step !== null) {
    if (ended) throw new Error(`the restore ended before its hold at ${state.holds.step}: ${String(await held)}`);
    if (Date.now() > deadline) throw new Error(`the restore never reached its hold at ${state.holds.step}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function untilStep(state: World, step: string): Promise<SnapshotOperation> {
  const deadline = Date.now() + 60_000;
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
  writeFileSync(join(root, "ip-link.json"), JSON.stringify([{ ifindex: 2, link_index: 900, ifname: "eth0", link_type: "ether", address: "bc:24:11:aa:f1:b6", link_netnsid: 0, linkinfo: { info_kind: "veth" } }]));
  mkdirSync(join(root, "etc/ssh"), { recursive: true });
  writeFileSync(join(root, "etc/machine-id"), "0123456789abcdef0123456789abcdef\n");
  writeFileSync(join(root, "etc/ssh/ssh_host_ed25519_key.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIguest guest\n");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/ip"), `#!/bin/sh\nexec cat ${quote(join(root, "ip-link.json"))}\n`, { mode: 0o755 });
  const tool = join(dir, "bb-box-identity");
  writeFileSync(tool, `#!/bin/sh\nPATH=${quote(join(dir, "bin"))}:$PATH BBBOX_IDENTITY_ROOT=${quote(root)} BBBOX_IDENTITY_NIC_WAIT_SECONDS=0 exec bash ${quote(IDENTITY_SCRIPT)} "$@"\n`, { mode: 0o755 });
  if (options.on !== false) assert.equal(spawnSync(tool, ["enable", "--no-unit"]).status, 0, "the image's build turned the reset on");
  if (options.booted !== false) assert.equal(spawnSync(tool, ["boot"]).status, 0, "the boot check ran, as its unit runs it at the box's first boot");
  return { root, tool };
}

export function withIdentitySource(state: World, source: "eth" | "device" | "value"): void {
  (state.backend as unknown as Record<string, unknown>).identitySource = () => source;
}

export function armedWorld(): World {
  const guest = identityGuest();
  const state = world({ identityTool: guest.tool, identityRoot: guest.root });
  withIdentitySource(state, "eth");
  return state;
}

export function flushing(state: World, flush: () => Promise<{ exitCode: number; stdout: string; stderr: string }>): void {
  const transports = state.backend.transports.bind(state.backend);
  state.backend.transports = async (guest, kind) => {
    const found = await transports(guest, kind);
    const command = found.command!;
    return {
      ...found,
      command: Object.assign(Object.create(Object.getPrototypeOf(command)), command, {
        run: async (script: string, options?: Parameters<typeof command.run>[1]) => {
          if (script !== "sync") return command.run(script, options);
          state.provider.order.push("flush");
          return flush();
        },
      }),
    };
  };
}
