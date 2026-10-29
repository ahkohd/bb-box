import type { BoxView } from "@/src/plugin/views.ts";
import type { ThreadOnBox } from "@/src/plugin/contract.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface FakeThread {
  readonly id: string;
  readonly title: string;
  readonly running: boolean;
  readonly activeAt: number;
}

export interface FakeProcess {
  readonly pid: number;
  readonly name: string;
  readonly cpu: number;
  readonly memoryMiB: number;
}

export interface Load {
  readonly cpu: number;
  readonly memory: number;
  readonly diskUsedGiB: number;
  readonly diskGiB: number;
  readonly memoryGiB: number;
  readonly cores: number;
  readonly rxKiB: number;
  readonly txKiB: number;
  readonly busyFrom?: number;
}

export type Actor = { readonly kind: "you" } | { readonly kind: "agent"; readonly threadId: string } | { readonly kind: "command" } | { readonly kind: "bb-box"; readonly why: string } | { readonly kind: "outside" } | null;

export interface Stop {
  readonly from: number;
  readonly to: number | null;
  readonly by: Actor;
}

export interface Operation {
  readonly action: "stop" | "start" | "resize" | "release";
  readonly at: number;
  readonly error: string;
}

export interface SharedHost {
  readonly name: string;
  readonly otherSlots: number;
  readonly cores: number;
  readonly memoryGiB: number;
  readonly diskGiB: number;
  readonly diskUsedGiB: number;
  readonly cpu: number;
  readonly memory: number;
  readonly encoderUsed: number;
}

export interface FakeBox {
  readonly view: BoxView;
  readonly threadId: string;
  readonly owner: "thread" | "yours";
  readonly load: Load;
  readonly processes: readonly FakeProcess[];
  readonly onMachine: readonly string[];
  readonly stops?: readonly Stop[];
  readonly started?: { readonly askedAt: number; readonly by: Actor; readonly readyAt: number | null };
  readonly operation?: Operation | null;
  readonly backendGone?: { readonly since: number };
  readonly unreachable?: { readonly since: number; readonly error: string };
  readonly readingNote?: string;
  readonly shared?: SharedHost;
}

export const OPERATOR = "operator";

export function threadsAt(now: number): FakeThread[] {
  return [
    { id: "thr_login", title: "Fix the sign-in flow in Safari", running: true, activeAt: now - 20_000 },
    { id: "thr_checkout", title: "iOS checkout: QA the new payment sheet", running: true, activeAt: now - 4 * MINUTE },
    { id: "thr_rebuild", title: "Nightly image rebuild check", running: false, activeAt: now - 3 * HOUR },
    { id: "thr_bench", title: "Benchmark the search index build", running: true, activeAt: now - 40_000 },
    { id: "thr_docs", title: "Write the API guide's examples", running: false, activeAt: now - 26 * HOUR },
    { id: "thr_windows", title: "Windows installer smoke test", running: false, activeAt: now - 50 * MINUTE },
    { id: "thr_notes", title: "Meeting notes pipeline", running: true, activeAt: now - 2 * MINUTE },
    { id: "thr_mail", title: "Mailbox watch", running: false, activeAt: now - 5 * HOUR },
    { id: "thr_cache", title: "Cache warm-up experiment", running: false, activeAt: now - 25 * MINUTE },
    { id: "thr_old", title: "Old branch clean-up", running: false, activeAt: now - 4 * DAY },
  ];
}

function view(base: Partial<BoxView> & Pick<BoxView, "id" | "name" | "kind" | "kindLabel" | "backendLabel" | "createdAt">): BoxView {
  return {
    provider: "proxmox-lxc",
    nature: "virtual",
    form: "LXC",
    shared: false,
    role: "box",
    size: "4 cores, 8 GiB memory, 32 GiB disk",
    state: "ready",
    error: null,
    stopped: null,
    waitingOn: null,
    readyAt: base.createdAt + 4_000,
    os: "linux",
    arch: "x86_64",
    gpu: false,
    requires: [],
    extras: ["docker"],
    docker: true,
    desktop: false,
    display: null,
    device: null,
    control: null,
    computerUse: false,
    terminal: true,
    address: "10.20.0.31",
    facts: [],
    timings: { warm: 300, clone: 1_100, configure: 24, tags: 18, start: 1_300, network: 300, ssh: 200, total: 3_600, enrol: 2_400 },
    enrol: { state: "enrolled", hostId: `host_${base.name}`, error: null },
    enrols: true,
    canStopStart: true,
    sizeNow: { cores: 4, memoryGiB: 8, diskGiB: 32, words: "4 cores, 8 GiB memory, 32 GiB disk" },
    resizing: { cores: "live", memory: "live", disk: "live", shrinks: true },
    lastResize: null,
    ...base,
  } as BoxView;
}

const LINUX_DESKTOP_DISPLAY = { protocol: "rfb", resizable: true, clipboard: null, refresh: null, quality: 6, macKeys: null } as BoxView["display"];

export function boxesAt(now: number): FakeBox[] {
  return [...baseBoxes(now), ...extraBoxes(now)];
}

function baseBoxes(now: number): FakeBox[] {
  return [
    {
      threadId: "thr_login",
      owner: "thread",
      onMachine: ["thr_login"],
      load: { cpu: 31, memory: 58, diskUsedGiB: 13.4, diskGiB: 32, memoryGiB: 8, cores: 4, rxKiB: 820, txKiB: 96 },
      processes: [
        { pid: 2214, name: "chromium", cpu: 18.2, memoryMiB: 1_240 },
        { pid: 1890, name: "Xvnc", cpu: 6.1, memoryMiB: 210 },
        { pid: 2650, name: "node", cpu: 4.4, memoryMiB: 512 },
        { pid: 2219, name: "chromium-renderer", cpu: 2.0, memoryMiB: 690 },
        { pid: 1402, name: "bb-daemon", cpu: 0.6, memoryMiB: 96 },
        { pid: 1, name: "systemd", cpu: 0.1, memoryMiB: 14 },
      ],
      view: view({
        id: "bxamberfox2q7k",
        name: "amber-fox",
        kind: "linux-desktop",
        kindLabel: "Linux desktop",
        backendLabel: "Proxmox LXC on pve-1",
        createdAt: now - 2 * HOUR - 14 * MINUTE,
        desktop: true,
        display: LINUX_DESKTOP_DISPLAY,
        control: { owner: "agent", holder: null },
        computerUse: true,
        address: "10.20.0.31",
        facts: [{ label: "Display", value: "1920 × 1080, video" }],
      }),
    },
    {
      threadId: "thr_login",
      owner: "thread",
      onMachine: ["thr_login"],
      load: { cpu: 96, memory: 71, diskUsedGiB: 21.0, diskGiB: 32, memoryGiB: 16, cores: 8, rxKiB: 40, txKiB: 12, busyFrom: now - 9 * MINUTE },
      processes: [
        { pid: 4410, name: "cargo", cpu: 388.0, memoryMiB: 2_900 },
        { pid: 4471, name: "rustc", cpu: 297.5, memoryMiB: 3_400 },
        { pid: 4472, name: "rustc", cpu: 96.1, memoryMiB: 1_100 },
        { pid: 1402, name: "bb-daemon", cpu: 0.8, memoryMiB: 101 },
        { pid: 980, name: "dockerd", cpu: 0.3, memoryMiB: 88 },
        { pid: 1, name: "systemd", cpu: 0.1, memoryMiB: 14 },
      ],
      view: view({
        id: "bxbrisklake8m3",
        name: "brisk-lake",
        kind: "linux",
        kindLabel: "Linux",
        backendLabel: "Proxmox LXC on pve-1",
        createdAt: now - 47 * MINUTE,
        size: "8 cores, 16 GiB memory, 32 GiB disk",
        sizeNow: { cores: 8, memoryGiB: 16, diskGiB: 32, words: "8 cores, 16 GiB memory, 32 GiB disk" },
        address: "10.20.0.44",
        timings: { warm: 300, clone: 1_200, configure: 22, tags: 20, start: 1_400, network: 300, ssh: 200, total: 3_900, enrol: 3_100 },
      }),
    },
    {
      threadId: "thr_checkout",
      owner: "thread",
      onMachine: ["thr_checkout"],
      shared: { name: "mac-1", otherSlots: 2, cores: 12, memoryGiB: 32, diskGiB: 460, diskUsedGiB: 212, cpu: 58, memory: 71, encoderUsed: 40 },
      load: { cpu: 9, memory: 5, diskUsedGiB: 3.1, diskGiB: 460, memoryGiB: 32, cores: 12, rxKiB: 310, txKiB: 40 },
      processes: [
        { pid: 51022, name: "Simulator", cpu: 14.6, memoryMiB: 980 },
        { pid: 51110, name: "CheckoutApp", cpu: 5.2, memoryMiB: 340 },
        { pid: 51031, name: "SpringBoard", cpu: 1.8, memoryMiB: 210 },
        { pid: 50990, name: "device-server", cpu: 1.1, memoryMiB: 64 },
        { pid: 50970, name: "bb-daemon", cpu: 0.4, memoryMiB: 92 },
        { pid: 51040, name: "backboardd", cpu: 0.3, memoryMiB: 48 },
      ],
      view: view({
        id: "bxcalmharbor4w",
        name: "calm-harbor",
        kind: "ios",
        kindLabel: "iOS Simulator",
        backendLabel: "Shared iOS host on mac-1",
        provider: "ssh-pool",
        form: null,
        shared: true,
        nature: "real",
        os: "macos",
        arch: "arm64",
        createdAt: now - 38 * MINUTE,
        size: null,
        sizeNow: null,
        resizing: null,
        extras: [],
        docker: false,
        canStopStart: false,
        address: "10.20.1.5",
        device: { platform: "ios", model: "iPhone 17 Pro", simulatorHost: true },
        control: { owner: "agent", holder: null },
        computerUse: true,
        timings: { spare: 400, spareSwitch: 2_100, total: 2_600, spareReconnect: 1_200 },
        facts: [{ label: "Runtime", value: "iOS 26.1" }],
      }),
    },
    {
      threadId: "thr_rebuild",
      owner: "thread",
      onMachine: [],
      stops: [
        { from: now - 20 * HOUR, to: now - 14 * HOUR, by: { kind: "agent", threadId: "thr_rebuild" } },
        { from: now - 3 * HOUR - 5 * MINUTE, to: null, by: { kind: "you" } },
      ],
      started: { askedAt: now - 14 * HOUR, by: { kind: "agent", threadId: "thr_rebuild" }, readyAt: now - 14 * HOUR + 8_600 },
      load: { cpu: 7, memory: 38, diskUsedGiB: 18.2, diskGiB: 64, memoryGiB: 8, cores: 4, rxKiB: 60, txKiB: 14 },
      processes: [],
      view: view({
        id: "bxsilverpine6z",
        name: "silver-pine",
        kind: "linux-vm",
        kindLabel: "Linux VM",
        backendLabel: "Proxmox QEMU on pve-2",
        provider: "proxmox-qemu",
        form: "VM",
        state: "stopped",
        terminal: false,
        createdAt: now - 26 * HOUR,
        size: "4 cores, 8 GiB memory, 64 GiB disk",
        sizeNow: { cores: 4, memoryGiB: 8, diskGiB: 64, words: "4 cores, 8 GiB memory, 64 GiB disk" },
        address: null,
        enrol: { state: "enrolled", hostId: "host_silver-pine", error: null },
        timings: { warm: 0, clone: 4_800, configure: 30, start: 9_200, network: 600, ssh: 300, total: 15_300, enrol: 5_200, "start.boot": 8_100, "start.ssh": 400 },
        resizing: { cores: "restart", memory: "restart", disk: "live", shrinks: false },
      }),
    },
    {
      threadId: "thr_bench",
      owner: "thread",
      onMachine: [],
      load: { cpu: 0, memory: 0, diskUsedGiB: 0, diskGiB: 32, memoryGiB: 8, cores: 4, rxKiB: 0, txKiB: 0 },
      processes: [],
      view: view({
        id: "bxnorthwind3h",
        name: "north-wind",
        kind: "linux",
        kindLabel: "Linux",
        backendLabel: "Docker on build-1",
        provider: "docker",
        form: "Docker",
        state: "starting",
        terminal: false,
        createdAt: now - 6_000,
        readyAt: null,
        address: null,
        enrol: { state: "off", hostId: null, error: null },
        timings: { warm: 200, clone: 900 },
        waitingOn: "Waiting for the box to answer on SSH",
      }),
    },
    {
      threadId: "thr_windows",
      owner: "thread",
      onMachine: [],
      load: { cpu: 0, memory: 0, diskUsedGiB: 0, diskGiB: 64, memoryGiB: 8, cores: 4, rxKiB: 0, txKiB: 0 },
      processes: [],
      view: view({
        id: "bxoakridge7n2",
        name: "oak-ridge",
        kind: "windows-desktop",
        kindLabel: "Windows desktop",
        backendLabel: "Proxmox QEMU on pve-2",
        provider: "proxmox-qemu",
        form: "VM",
        os: "windows",
        state: "failed",
        terminal: false,
        desktop: true,
        createdAt: now - 52 * MINUTE,
        readyAt: null,
        address: null,
        error: "The clone did not answer within 300 s. Its console shows Windows asking to repair the disk.",
        enrol: { state: "off", hostId: null, error: null },
        timings: { warm: 0, clone: 22_000, start: 300_000 },
        size: "4 cores, 8 GiB memory, 64 GiB disk",
      }),
    },
    {
      threadId: OPERATOR,
      owner: "yours",
      onMachine: ["thr_notes", "thr_mail", "thr_docs"],
      load: { cpu: 12, memory: 44, diskUsedGiB: 30, diskGiB: 64, memoryGiB: 16, cores: 8, rxKiB: 140, txKiB: 60 },
      processes: [
        { pid: 3011, name: "node", cpu: 6.3, memoryMiB: 820 },
        { pid: 2950, name: "Xvnc", cpu: 2.2, memoryMiB: 180 },
        { pid: 3122, name: "python3", cpu: 1.9, memoryMiB: 410 },
        { pid: 1402, name: "bb-daemon", cpu: 0.9, memoryMiB: 120 },
        { pid: 980, name: "dockerd", cpu: 0.4, memoryMiB: 90 },
        { pid: 1, name: "systemd", cpu: 0.1, memoryMiB: 14 },
      ],
      view: view({
        id: "bxdevdesk9x1p",
        name: "workbench",
        kind: "linux-desktop",
        kindLabel: "Linux desktop",
        backendLabel: "Proxmox LXC on pve-1",
        role: "machine",
        createdAt: now - 9 * DAY,
        size: "8 cores, 16 GiB memory, 64 GiB disk",
        sizeNow: { cores: 8, memoryGiB: 16, diskGiB: 64, words: "8 cores, 16 GiB memory, 64 GiB disk" },
        desktop: true,
        display: LINUX_DESKTOP_DISPLAY,
        control: { owner: "agent", holder: null },
        address: "10.20.0.12",
      }),
    },
    {
      threadId: OPERATOR,
      owner: "yours",
      onMachine: [],
      readingNote: "bb-box reads a Windows box only when it is a BB machine, and this one's enrolment is off.",
      load: { cpu: 0, memory: 0, diskUsedGiB: 0, diskGiB: 80, memoryGiB: 8, cores: 4, rxKiB: 0, txKiB: 0 },
      processes: [],
      view: view({
        id: "bxtestwin5r8q",
        name: "test-windows",
        kind: "windows-desktop",
        kindLabel: "Windows desktop",
        backendLabel: "Proxmox QEMU on pve-2",
        provider: "proxmox-qemu",
        form: "VM",
        os: "windows",
        role: "machine",
        createdAt: now - 4 * DAY,
        desktop: true,
        terminal: false,
        display: LINUX_DESKTOP_DISPLAY,
        control: { owner: "agent", holder: null },
        address: "10.20.0.60",
        size: "4 cores, 8 GiB memory, 80 GiB disk",
        enrol: { state: "off", hostId: null, error: null },
        enrols: false,
      }),
    },
  ];
}

export function extraBoxes(now: number): FakeBox[] {
  return [
    {
      threadId: "thr_cache",
      owner: "thread",
      onMachine: [],
      unreachable: { since: now - 12 * MINUTE, error: "pve-3 does not answer: connection timed out after 10 s" },
      load: { cpu: 14, memory: 40, diskUsedGiB: 9, diskGiB: 32, memoryGiB: 8, cores: 4, rxKiB: 90, txKiB: 20 },
      processes: [],
      view: view({
        id: "bxfernhollow5d",
        name: "fern-hollow",
        kind: "linux",
        kindLabel: "Linux",
        backendLabel: "Proxmox LXC on pve-3",
        createdAt: now - 5 * HOUR,
        address: "10.20.3.17",
        terminal: false,
      }),
    },
    {
      threadId: "thr_old",
      owner: "thread",
      onMachine: [],
      backendGone: { since: now - 2 * DAY },
      load: { cpu: 6, memory: 30, diskUsedGiB: 11, diskGiB: 32, memoryGiB: 8, cores: 4, rxKiB: 10, txKiB: 4 },
      processes: [],
      view: view({
        id: "bxmaplerow8k2",
        name: "maple-row",
        kind: "linux",
        kindLabel: "Linux",
        backendLabel: "Proxmox LXC on pve-old",
        createdAt: now - 6 * DAY,
        address: "10.20.9.4",
        terminal: false,
        canStopStart: false,
        resizing: null,
      }),
    },
  ];
}

export function machineThreads(box: FakeBox, threads: readonly FakeThread[]): ThreadOnBox[] {
  return box.onMachine.flatMap((id) => {
    const thread = threads.find((each) => each.id === id);
    return thread ? [{ id: thread.id, title: thread.title, running: thread.running, activeAt: thread.activeAt }] : [];
  });
}
