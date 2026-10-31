import { z } from "zod";
import { clampPercentage } from "./numbers.ts";

const MIB = 1024 * 1024;

export const NVIDIA_CARD_FIELDS = "index,pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit";
export const NVIDIA_CARD_ARGS: readonly string[] = [`--query-gpu=${NVIDIA_CARD_FIELDS}`, "--format=csv,noheader,nounits"];
export const NVIDIA_PROCESS_ARGS: readonly string[] = ["-q", "-d", "PIDS"];
export const NVIDIA_DEVICE = "/dev/nvidiactl";
export const NVIDIA_QUERY_SECONDS = 2;
export const NVIDIA_KILL_AFTER_SECONDS = 1;
const TIMED_OUT = 124;

export const OTHERS_ON_CARD_BYTES = 512 * MIB;
export const GPU_BUSY_PERCENT = 85;
export const MOST_CARDS = 16;
export const MOST_GPU_PROCESSES = 32;

const NAME_CHARACTERS = 128;

export interface NvidiaCard {
  readonly index: number;
  readonly bus: string;
  readonly name: string;
  readonly usagePercent: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryTotalBytes: number | null;
  readonly temperatureC: number | null;
  readonly powerWatts: number | null;
  readonly powerLimitWatts: number | null;
}

export interface NvidiaApp {
  readonly bus: string;
  readonly pid: number;
  readonly name: string;
  readonly memoryBytes: number | null;
}

const finite = z.number().finite();
const percentage = z.number().min(0).max(100);

export const gpuCardSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().max(NAME_CHARACTERS),
    usagePercent: percentage.nullable(),
    memoryUsedBytes: finite.nonnegative().nullable(),
    memoryTotalBytes: finite.nonnegative().nullable(),
    temperatureC: finite.nullable(),
    powerWatts: finite.nonnegative().nullable(),
    powerLimitWatts: finite.nonnegative().nullable(),
    shared: z.boolean(),
    ownMemoryBytes: finite.nonnegative().nullable(),
    ownProcesses: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const gpuProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    name: z.string().max(NAME_CHARACTERS),
    card: z.number().int().nonnegative(),
    memoryBytes: finite.nonnegative().nullable(),
  })
  .strict();

export const gpuReadingSchema = z
  .object({
    cards: z.array(gpuCardSchema).min(1).max(MOST_CARDS),
    processes: z.array(gpuProcessSchema).max(MOST_GPU_PROCESSES).nullable(),
  })
  .strict();

export type GpuCard = z.infer<typeof gpuCardSchema>;
export type GpuProcess = z.infer<typeof gpuProcessSchema>;
export type GpuReading = z.infer<typeof gpuReadingSchema>;

function fieldsOf(line: string): string[] {
  return line.split(",").map((field) => field.trim());
}

function measured(text: string | undefined, most = Number.POSITIVE_INFINITY): number | null {
  if (text === undefined || text === "" || text.startsWith("[") || /^n\/?a$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= most ? value : null;
}

function mebibytes(text: string | undefined): number | null {
  const value = measured(text);
  return value === null ? null : value * MIB;
}

const BUS_ID = /^[0-9a-f]{4,8}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/i;

function busOf(text: string): string | null {
  const bus = text.trim().toLowerCase();
  return BUS_ID.test(bus) ? bus.replace(/^0+(?=[0-9a-f]{4}:)/, "") : null;
}

export function executableName(text: string): string {
  const executable = text.trim().split(/\s+/)[0] ?? "";
  return (executable.split(/[\\/]/).pop() ?? executable).slice(0, NAME_CHARACTERS);
}

export function parseNvidiaCards(source: string | undefined): NvidiaCard[] | null {
  const cards = (source ?? "").split("\n").flatMap((line): NvidiaCard[] => {
    const fields = fieldsOf(line);
    if (fields.length < 9) return [];
    const index = Number(fields[0]);
    const bus = busOf(fields[1]!);
    if (!Number.isSafeInteger(index) || index < 0 || bus === null) return [];
    const tail = fields.slice(-6);
    const name = fields.slice(2, fields.length - 6).join(", ");
    const usage = measured(tail[0], 100);
    return [{
      index,
      bus,
      name: name.slice(0, NAME_CHARACTERS),
      usagePercent: usage,
      memoryUsedBytes: mebibytes(tail[1]),
      memoryTotalBytes: mebibytes(tail[2]),
      temperatureC: measured(tail[3], 150),
      powerWatts: measured(tail[4], 10_000),
      powerLimitWatts: measured(tail[5], 10_000),
    }];
  });
  return cards.length ? cards.slice(0, MOST_CARDS) : null;
}

function knownName(name: string): boolean {
  return name !== "" && !name.startsWith("[") && !/^n\/?a$/i.test(name);
}

export const NVIDIA_FAILED = "[failed]";

function fieldValue(line: string, label: string): string | null {
  const match = new RegExp(`^\\s*${label}\\s*:\\s*(.*?)\\s*$`).exec(line);
  return match ? match[1]! : null;
}

export function parseNvidiaProcesses(source: string | undefined): NvidiaApp[] | null {
  if (source === undefined || source.split("\n").some((line) => line.trim() === NVIDIA_FAILED)) return null;
  const apps: NvidiaApp[] = [];
  let bus: string | null = null;
  let current: { bus: string; pid: number; name: string; memoryBytes: number | null } | null = null;
  const keep = () => {
    if (current && current.pid > 0 && knownName(current.name)) apps.push({ bus: current.bus, pid: current.pid, name: executableName(current.name), memoryBytes: current.memoryBytes });
    current = null;
  };
  for (const line of source.split("\n")) {
    const card = /^GPU\s+(\S+)\s*$/.exec(line.trim());
    if (card && !line.startsWith(" ")) {
      keep();
      bus = busOf(card[1]!);
      continue;
    }
    const pid = fieldValue(line, "Process ID");
    if (pid !== null) {
      keep();
      const value = Number(pid);
      current = bus !== null && Number.isSafeInteger(value) ? { bus, pid: value, name: "", memoryBytes: null } : null;
      continue;
    }
    if (!current) continue;
    const name = fieldValue(line, "Name");
    if (name !== null) current.name = name;
    const memory = fieldValue(line, "Used GPU Memory");
    if (memory !== null) current.memoryBytes = mebibytes(memory.replace(/\s*MiB$/i, ""));
  }
  keep();
  return apps;
}

export function cardShared(memoryUsedBytes: number | null, ownMemoryBytes: number | null, inContainer: boolean): boolean {
  if (!inContainer || memoryUsedBytes === null || ownMemoryBytes === null) return false;
  return memoryUsedBytes - ownMemoryBytes >= OTHERS_ON_CARD_BYTES;
}

export function gpuReadingOf(cards: readonly NvidiaCard[] | null, apps: readonly NvidiaApp[] | null, inContainer: boolean): GpuReading | null {
  if (!cards?.length) return null;
  const cardOf = new Map(cards.map((card) => [card.bus, card.index]));
  const placed = apps === null ? null : apps.flatMap((app) => {
    const card = cardOf.get(app.bus);
    return card === undefined ? [] : [{ pid: app.pid, name: app.name, card, memoryBytes: app.memoryBytes }];
  });
  return {
    cards: cards.map(({ bus: _bus, ...card }) => {
      const own = placed?.filter((app) => app.card === card.index) ?? null;
      const ownMemoryBytes = own === null ? null : own.reduce((sum, app) => sum + (app.memoryBytes ?? 0), 0);
      return {
        ...card,
        shared: cardShared(card.memoryUsedBytes, ownMemoryBytes, inContainer),
        ownMemoryBytes,
        ownProcesses: own === null ? null : own.length,
      };
    }),
    processes: placed === null ? null : [...placed].sort((left, right) => (right.memoryBytes ?? 0) - (left.memoryBytes ?? 0) || left.pid - right.pid).slice(0, MOST_GPU_PROCESSES),
  };
}

export function gpuMemoryPercent(card: Pick<GpuCard, "memoryUsedBytes" | "memoryTotalBytes">): number | null {
  const { memoryUsedBytes: used, memoryTotalBytes: total } = card;
  return used === null || !total ? null : clampPercentage((used / total) * 100);
}

export function countedGpuPercent(cards: readonly Pick<GpuCard, "usagePercent" | "shared">[] | null | undefined): number | null {
  let most: number | null = null;
  for (const card of cards ?? []) {
    if (card.usagePercent === null || card.shared) continue;
    most = most === null ? card.usagePercent : Math.max(most, card.usagePercent);
  }
  return most;
}

export function gpuPids(reading: GpuReading | null): ReadonlySet<number> {
  return new Set(reading?.processes?.map((process) => process.pid) ?? []);
}

export function nvidiaScript(section: (name: string, command: string) => string, device = NVIDIA_DEVICE): string {
  const bounded = `t=; command -v timeout >/dev/null 2>&1 && t="timeout -k ${NVIDIA_KILL_AFTER_SECONDS} ${NVIDIA_QUERY_SECONDS}"`;
  const cards = section("nvidia", `$t nvidia-smi ${NVIDIA_CARD_ARGS.join(" ")}`);
  const processes = section("nvidia-pids", `{ $t nvidia-smi ${NVIDIA_PROCESS_ARGS.join(" ")} || echo '${NVIDIA_FAILED}'; }`);
  return `if [ -e ${device} ] && command -v nvidia-smi >/dev/null 2>&1; then ${bounded}; ${cards}; [ $? -lt ${TIMED_OUT} ] && { ${processes}; }; fi`;
}

export function gpuReadingFromSections(sections: ReadonlyMap<string, string>, inContainer: boolean): GpuReading | null {
  if (!sections.has("nvidia")) return null;
  return gpuReadingOf(parseNvidiaCards(sections.get("nvidia")), sections.has("nvidia-pids") ? parseNvidiaProcesses(sections.get("nvidia-pids")) : null, inContainer);
}
