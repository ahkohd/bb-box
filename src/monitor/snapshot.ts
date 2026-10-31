import { z } from "zod";
import { MOST_CARDS, gpuReadingSchema } from "./nvidia.ts";

const percentageSchema = z.number().min(0).max(100);
const metricPointSchema = z.object({
  timestamp: z.number(),
  cpuPercent: percentageSchema.nullable(),
  memoryPercent: percentageSchema,
  networkRxBytesPerSecond: z.number().nullable(),
  networkTxBytesPerSecond: z.number().nullable(),
  gpuPercent: percentageSchema.nullable().optional(),
  gpus: z.array(z.object({ card: z.number().int().nonnegative(), usage: percentageSchema.nullable(), memory: percentageSchema.nullable() })).max(MOST_CARDS).optional(),
  ownCpuCores: z.number().nonnegative().nullable().optional(),
  ownMemoryBytes: z.number().nonnegative().nullable().optional(),
});
const issueSchema = z.object({
  severity: z.enum(["warning", "critical"]),
  label: z.string(),
  message: z.string(),
});
const processSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().max(128),
  cpuPercent: z.number().nonnegative(),
  memoryPercent: z.number().nonnegative(),
  rssBytes: z.number().nonnegative(),
});
const loadSchema = z.tuple([z.number(), z.number(), z.number()]);
const stallSchema = z.tuple([percentageSchema, percentageSchema, percentageSchema]);
export const REFRESH_MS = { least: 2000, most: 60_000 } as const;

export const snapshotSchema = z.object({
  timestamp: z.string(),
  refreshIntervalMs: z.number().int().min(REFRESH_MS.least).max(REFRESH_MS.most),
  host: z.object({
    hostname: z.string(),
    platform: z.string(),
    release: z.string(),
    arch: z.string(),
    uptimeSeconds: z.number(),
    container: z.boolean().optional(),
  }),
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().positive(),
    speedMHz: z.number().nonnegative(),
    usagePercent: percentageSchema.nullable(),
    perCoreUsagePercent: z.array(percentageSchema.nullable()),
    loadAverage: loadSchema.nullable(),
    stallPercent: stallSchema.nullable().optional(),
  }),
  memory: z.object({
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    availableBytes: z.number(),
    cachedBytes: z.number(),
    buffersBytes: z.number(),
    swapTotalBytes: z.number(),
    swapUsedBytes: z.number(),
    usagePercent: percentageSchema,
    stallPercent: stallSchema.nullable().optional(),
  }),
  disk: z.object({
    mount: z.string(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    usagePercent: percentageSchema,
  }).nullable(),
  network: z.object({
    interface: z.string(),
    rxBytesPerSecond: z.number().nullable(),
    txBytesPerSecond: z.number().nullable(),
    rxTotalBytes: z.number(),
    txTotalBytes: z.number(),
  }).nullable(),
  battery: z.object({
    percent: percentageSchema,
    state: z.enum(["charging", "discharging", "full", "plugged-in"]),
    minutesRemaining: z.number().nonnegative().nullable(),
    healthPercent: percentageSchema.nullable(),
    cycleCount: z.number().int().nonnegative().nullable(),
    watts: z.number().nonnegative().nullable(),
    temperatureC: z.number().nullable(),
  }).nullable().optional(),
  sensors: z.object({
    cpuTempC: z.number().nullable(),
    gpuTempC: z.number().nullable(),
    cpuWatts: z.number().nonnegative().nullable(),
    gpuWatts: z.number().nonnegative().nullable(),
    gpuPercent: percentageSchema.nullable(),
  }).nullable().optional(),
  gpus: gpuReadingSchema.nullable().optional(),
  tailscale: z.object({
    dnsName: z.string().max(255),
    ipv4: z.string().max(64).nullable(),
    ipv6: z.string().max(64).nullable(),
    tags: z.array(z.string().max(128)).max(16),
  }).nullable().optional(),
  processes: z.object({
    available: z.boolean(),
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    top: z.array(processSchema).max(6),
  }),
  runtime: z.object({
    pid: z.number().int().positive(),
    nodeVersion: z.string(),
    processUptimeSeconds: z.number(),
    rssBytes: z.number(),
    heapUsedBytes: z.number(),
    heapTotalBytes: z.number(),
    externalBytes: z.number(),
  }).nullable(),
  own: z.object({
    cpuCores: z.number().nonnegative().nullable(),
    memoryBytes: z.number().nonnegative(),
    processes: z.number().int().nonnegative(),
  }).nullable().optional(),
  slot: z.object({
    host: z.string().max(255),
    encoder: z.object({ usedPercent: percentageSchema, words: z.string().max(512) }).nullable(),
    share: z.object({
      slots: z.number().int().positive(),
      cores: z.number().positive(),
      memoryBytes: z.number().nonnegative(),
    }).nullable().optional(),
  }).nullable().optional(),
  health: z.object({
    status: z.enum(["healthy", "warning", "critical"]),
    issues: z.array(issueSchema),
  }),
  history: z.array(metricPointSchema).max(72),
});

export type MonitorSnapshot = z.infer<typeof snapshotSchema>;
export type MetricPoint = z.infer<typeof metricPointSchema>;
export type Processes = MonitorSnapshot["processes"];
export type Health = MonitorSnapshot["health"];
export type OwnReading = NonNullable<MonitorSnapshot["own"]>;
export type { GpuCard, GpuProcess, GpuReading } from "./nvidia.ts";
export type SlotReading = NonNullable<MonitorSnapshot["slot"]>;

export const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
  isServer: z.boolean(),
  isBox: z.boolean(),
  boxId: z.string().nullable(),
});

export type Machine = z.infer<typeof machineSchema>;

const noticeSchema = z.object({
  sequence: z.number(),
  type: z.enum(["incident", "recovery"]),
  metric: z.enum(["cpu", "memory"]),
  timestamp: z.number(),
  value: z.number(),
  peak: z.number(),
  durationSeconds: z.number(),
  threshold: z.number(),
});

export const monitorStatusSchema = z.object({
  enabled: z.boolean(),
  notifications: z.boolean(),
  cursor: z.number(),
  active: z.array(noticeSchema).max(2),
  recent: z.array(noticeSchema).max(32),
});

export type MonitorStatus = z.infer<typeof monitorStatusSchema>;
