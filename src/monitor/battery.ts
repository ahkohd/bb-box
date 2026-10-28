import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const POWER_SUPPLY_DIR = "/sys/class/power_supply";
const UINT64_RANGE = 2n ** 64n;
const STILL_ESTIMATING_MINUTES = 65535;

export type BatteryState = "charging" | "discharging" | "full" | "plugged-in";

export interface BatteryInfo {
  percent: number;
  state: BatteryState;
  minutesRemaining: number | null;
  healthPercent: number | null;
  cycleCount: number | null;
  watts: number | null;
  temperatureC: number | null;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function ioregFields(source: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of source.matchAll(/^\s*"([A-Za-z]+)" = (\S+)\s*$/gm)) {
    fields.set(match[1], match[2]);
  }
  return fields;
}

function signedFromUnsigned64(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const value = BigInt(text);
  return Number(value >= UINT64_RANGE / 2n ? value - UINT64_RANGE : value);
}

function positiveNumber(text: string | undefined): number | null {
  const value = Number(text);
  return text !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

export function parseMacBattery(source: string): BatteryInfo | null {
  const fields = ioregFields(source);
  if (fields.get("BatteryInstalled") === "No") return null;
  const currentCapacity = Number(fields.get("CurrentCapacity"));
  if (!fields.has("CurrentCapacity") || !Number.isFinite(currentCapacity)) return null;
  const maxCapacity = positiveNumber(fields.get("MaxCapacity"));
  const percent = maxCapacity ? (currentCapacity / maxCapacity) * 100 : currentCapacity;
  const charging = fields.get("IsCharging") === "Yes";
  const pluggedIn = fields.get("ExternalConnected") === "Yes";
  const full = fields.get("FullyCharged") === "Yes";
  const state: BatteryState = charging ? "charging" : full && pluggedIn ? "full" : pluggedIn ? "plugged-in" : "discharging";
  const minutes = Number(charging ? fields.get("AvgTimeToFull") : fields.get("TimeRemaining") ?? fields.get("AvgTimeToEmpty"));
  const fullCapacity = positiveNumber(fields.get("NominalChargeCapacity"));
  const designCapacity = positiveNumber(fields.get("DesignCapacity"));
  const milliamps = signedFromUnsigned64(fields.get("InstantAmperage") ?? fields.get("Amperage"));
  const millivolts = positiveNumber(fields.get("Voltage"));
  const hundredthsCelsius = positiveNumber(fields.get("Temperature"));
  const cycles = Number(fields.get("CycleCount"));
  return {
    percent: clampPercent(percent),
    state,
    minutesRemaining:
      (state === "charging" || state === "discharging") && Number.isFinite(minutes) && minutes > 0 && minutes < STILL_ESTIMATING_MINUTES
        ? minutes
        : null,
    healthPercent: fullCapacity && designCapacity ? roundTo(clampPercent((fullCapacity / designCapacity) * 100), 1) : null,
    cycleCount: Number.isFinite(cycles) && fields.has("CycleCount") ? cycles : null,
    watts: milliamps !== null && millivolts ? roundTo(Math.abs(milliamps * millivolts) / 1e6, 1) : null,
    temperatureC: hundredthsCelsius ? roundTo(hundredthsCelsius / 100, 1) : null,
  };
}

const LINUX_STATES: Record<string, BatteryState> = {
  Charging: "charging",
  Discharging: "discharging",
  Full: "full",
  "Not charging": "plugged-in",
};

export function parseLinuxBattery(files: Record<string, string | undefined>): BatteryInfo | null {
  const read = (name: string) => {
    const value = Number(files[name]?.trim());
    return files[name] !== undefined && Number.isFinite(value) ? value : null;
  };
  if (files.type?.trim() !== "Battery" || files.scope?.trim() === "Device") return null;
  const magnitude = (name: string) => {
    const value = read(name);
    return value === null ? null : Math.abs(value);
  };
  const energyNow = read("energy_now") ?? read("charge_now");
  const energyFull = read("energy_full") ?? read("charge_full");
  const energyDesign = read("energy_full_design") ?? read("charge_full_design");
  const percent = read("capacity") ?? (energyNow !== null && energyFull ? (energyNow / energyFull) * 100 : null);
  if (percent === null) return null;
  const state = LINUX_STATES[files.status?.trim() ?? ""] ?? "discharging";
  const microamps = magnitude("current_now");
  const microwatts = magnitude("power_now") ?? (() => {
    const microvolts = read("voltage_now");
    return microamps !== null && microvolts !== null ? (microamps * microvolts) / 1e6 : null;
  })();
  const flowNow = read("energy_now") !== null ? microwatts : microamps;
  const hours =
    flowNow && flowNow > 0 && energyNow !== null
      ? state === "discharging"
        ? energyNow / flowNow
        : state === "charging" && energyFull !== null
          ? (energyFull - energyNow) / flowNow
          : null
      : null;
  const cycles = read("cycle_count");
  return {
    percent: clampPercent(percent),
    state,
    minutesRemaining: hours !== null && hours > 0 && hours < 100 ? Math.round(hours * 60) : null,
    healthPercent: energyFull && energyDesign ? roundTo(clampPercent((energyFull / energyDesign) * 100), 1) : null,
    cycleCount: cycles !== null && cycles > 0 ? cycles : null,
    watts: microwatts !== null && microwatts > 0 ? roundTo(microwatts / 1e6, 1) : null,
    temperatureC: null,
  };
}

const LINUX_FILES = [
  "type", "scope", "capacity", "status", "power_now", "current_now", "voltage_now",
  "energy_now", "energy_full", "energy_full_design",
  "charge_now", "charge_full", "charge_full_design", "cycle_count",
];

async function readLinuxBattery(): Promise<BatteryInfo | null> {
  let supplies: string[];
  try {
    supplies = await readdir(POWER_SUPPLY_DIR);
  } catch {
    return null;
  }
  for (const supply of supplies) {
    const files: Record<string, string | undefined> = {};
    await Promise.all(LINUX_FILES.map(async (name) => {
      files[name] = await readFile(join(POWER_SUPPLY_DIR, supply, name), "utf8").catch(() => undefined);
    }));
    const battery = parseLinuxBattery(files);
    if (battery) return battery;
  }
  return null;
}

const MAC_NO_BATTERY_CACHE_MS = 10 * 60_000;
const MAC_BATTERY_STALE_MS = 2 * 60_000;
let macBatteryReading: { battery: BatteryInfo | null; readAt: number } | null = null;

async function readMacBattery(signal: AbortSignal): Promise<BatteryInfo | null> {
  const age = macBatteryReading ? Date.now() - macBatteryReading.readAt : Infinity;
  if (macBatteryReading?.battery === null && age < MAC_NO_BATTERY_CACHE_MS) return null;
  try {
    const { stdout } = await execFileAsync("ioreg", ["-rn", "AppleSmartBattery"], { timeout: 1500, maxBuffer: 1024 * 1024, signal });
    const battery = parseMacBattery(stdout);
    macBatteryReading = { battery, readAt: Date.now() };
    return battery;
  } catch {
    return macBatteryReading && age < MAC_BATTERY_STALE_MS ? macBatteryReading.battery : null;
  }
}

export function readBattery(signal: AbortSignal): Promise<BatteryInfo | null> {
  if (platform() === "darwin") return readMacBattery(signal);
  if (platform() === "linux") return readLinuxBattery();
  return Promise.resolve(null);
}
