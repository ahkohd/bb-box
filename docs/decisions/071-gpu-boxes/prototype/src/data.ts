export type GpuPart = "none" | "shared" | "whole";
export type BackendId = "proxmox-lxc" | "docker";
export type BoxState = "ready" | "stopped" | "restarting" | "starting";

export interface Backend {
  readonly id: BackendId;
  readonly label: string;
  readonly host: string;
  readonly form: "LXC" | "Docker";
  readonly canChangeDevices: boolean;
  readonly fencesWhole: boolean;
  readonly typicalReadyMs: number;
  readonly restartSeconds: number;
}

export interface Card {
  readonly id: string;
  readonly backend: BackendId;
  readonly index: number;
  readonly model: string;
  readonly memoryMiB: number;
  readonly outsideMiB: number;
}

export interface GpuProcess {
  readonly pid: number;
  readonly name: string;
  readonly mib: number;
}

export interface FakeBox {
  readonly id: string;
  readonly name: string;
  readonly backend: BackendId;
  readonly desktop: boolean;
  readonly cores: number;
  readonly memoryGiB: number;
  readonly diskGiB: number | null;
  readonly gpu: GpuPart;
  readonly card: string | null;
  readonly state: BoxState;
  readonly thread: string;
  readonly createdAt: number;
  readonly gpuPercent: number;
  readonly processes: readonly GpuProcess[];
  readonly step?: string;
}

export interface GpuSettings {
  readonly boxesPerCard: number;
  readonly wholeCards: boolean;
  readonly gpuMemoryMiB: number;
}

export const DESKTOP_GPU_MIB = 384;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const BACKENDS: readonly Backend[] = [
  { id: "proxmox-lxc", label: "Proxmox LXC", host: "pve-1", form: "LXC", canChangeDevices: true, fencesWhole: true, typicalReadyMs: 9_000, restartSeconds: 15 },
  { id: "docker", label: "Docker", host: "docker-1", form: "Docker", canChangeDevices: false, fencesWhole: false, typicalReadyMs: 4_000, restartSeconds: 6 },
];

export const CARDS: readonly Card[] = [
  { id: "GPU-3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00", backend: "proxmox-lxc", index: 0, model: "NVIDIA RTX 4090", memoryMiB: 24_564, outsideMiB: 0 },
  { id: "GPU-8c41d7b2-1a9e-4f63-b0c5-7e2d9a3b6c11", backend: "proxmox-lxc", index: 1, model: "NVIDIA RTX 4090", memoryMiB: 24_564, outsideMiB: 410 },
  { id: "GPU-1d2e3f4a-6b7c-48d9-a0b1-c2d3e4f5a622", backend: "docker", index: 0, model: "NVIDIA RTX 4000 Ada", memoryMiB: 20_475, outsideMiB: 0 },
];

export const DEFAULT_SETTINGS: Readonly<Record<BackendId, GpuSettings>> = {
  "proxmox-lxc": { boxesPerCard: 4, wholeCards: true, gpuMemoryMiB: 1024 },
  docker: { boxesPerCard: 4, wholeCards: true, gpuMemoryMiB: 1024 },
};

export const THREADS: Readonly<Record<string, string>> = {
  train: "Train the ranking model",
  ui: "Check the WebGL charts",
  eval: "Evaluate the new tokenizer",
  ingest: "Embed the support archive",
  batch: "Batch-transcribe the call recordings",
  infra: "Tidy the build cache",
  you: "Made by you",
};

export function boxesAt(now: number): FakeBox[] {
  const [card0, card1, docker0] = CARDS;
  return [
    {
      id: "bxquietelm7k2p",
      name: "quiet-elm",
      backend: "proxmox-lxc",
      desktop: false,
      cores: 16,
      memoryGiB: 64,
      diskGiB: 200,
      gpu: "whole",
      card: card0!.id,
      state: "ready",
      thread: "train",
      createdAt: now - 2 * DAY - 5 * HOUR,
      gpuPercent: 97,
      processes: [{ pid: 4121, name: "python3", mib: 21_120 }],
    },
    {
      id: "bxamberfox2q7k",
      name: "amber-fox",
      backend: "proxmox-lxc",
      desktop: true,
      cores: 4,
      memoryGiB: 8,
      diskGiB: 24,
      gpu: "shared",
      card: card1!.id,
      state: "ready",
      thread: "ui",
      createdAt: now - 3 * HOUR,
      gpuPercent: 6,
      processes: [
        { pid: 812, name: "Xorg", mib: 46 },
        { pid: 1907, name: "chrome", mib: 240 },
      ],
    },
    {
      id: "bxlonepine4m8s",
      name: "lone-pine",
      backend: "proxmox-lxc",
      desktop: false,
      cores: 8,
      memoryGiB: 32,
      diskGiB: 64,
      gpu: "shared",
      card: card1!.id,
      state: "ready",
      thread: "eval",
      createdAt: now - 9 * HOUR,
      gpuPercent: 31,
      processes: [{ pid: 3310, name: "python3", mib: 4_310 }],
    },
    {
      id: "bxswiftowl9d3t",
      name: "swift-owl",
      backend: "proxmox-lxc",
      desktop: false,
      cores: 8,
      memoryGiB: 16,
      diskGiB: 64,
      gpu: "shared",
      card: card1!.id,
      state: "stopped",
      thread: "ingest",
      createdAt: now - DAY - 2 * HOUR,
      gpuPercent: 0,
      processes: [],
    },
    {
      id: "bxcalmreef3h6n",
      name: "calm-reef",
      backend: "proxmox-lxc",
      desktop: false,
      cores: 4,
      memoryGiB: 16,
      diskGiB: 32,
      gpu: "none",
      card: null,
      state: "ready",
      thread: "batch",
      createdAt: now - 40 * 60_000,
      gpuPercent: 0,
      processes: [],
    },
    {
      id: "bxdockwren5v1c",
      name: "dock-wren",
      backend: "docker",
      desktop: false,
      cores: 8,
      memoryGiB: 16,
      diskGiB: null,
      gpu: "shared",
      card: docker0!.id,
      state: "ready",
      thread: "infra",
      createdAt: now - 6 * HOUR,
      gpuPercent: 12,
      processes: [{ pid: 221, name: "ollama", mib: 6_020 }],
    },
  ];
}

export const NEW_NAMES = ["tidy-glade", "brisk-lake", "rosy-reef", "grey-ridge", "silver-pine", "calm-harbor", "quick-wren", "bold-fern"];
