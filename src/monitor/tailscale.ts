import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;

const CLI_CANDIDATES_BY_PLATFORM: Record<string, readonly string[]> = {
  darwin: ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
  linux: [
    "/mnt/c/Program Files/Tailscale/tailscale.exe",
    "/mnt/c/Program Files (x86)/Tailscale/tailscale.exe",
  ],
  win32: [
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
  ],
};

export interface TailscaleInfo {
  dnsName: string;
  ipv4: string | null;
  ipv6: string | null;
  tags: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsIn(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parseTailscaleStatus(source: string): TailscaleInfo | null {
  let status: unknown;
  try {
    status = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(status) || status.BackendState !== "Running") return null;
  const self = status.Self;
  if (!isRecord(self) || typeof self.DNSName !== "string") return null;
  const dnsName = self.DNSName.replace(/\.$/, "");
  if (dnsName === "") return null;
  const addresses = stringsIn(self.TailscaleIPs);
  return {
    dnsName,
    ipv4: addresses.find((address) => !address.includes(":")) ?? null,
    ipv6: addresses.find((address) => address.includes(":")) ?? null,
    tags: stringsIn(self.Tags).slice(0, 16),
  };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function cliCandidates(): Promise<string[]> {
  const installed = await Promise.all(
    (CLI_CANDIDATES_BY_PLATFORM[platform()] ?? []).map(async (path) =>
      (await isExecutable(path)) ? [path] : [],
    ),
  );
  return ["tailscale", ...installed.flat()];
}

async function readStatusOnce(signal: AbortSignal): Promise<TailscaleInfo | null> {
  for (const cli of await cliCandidates()) {
    try {
      const { stdout } = await execFileAsync(cli, ["status", "--json"], {
        timeout: 2500,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        windowsHide: true,
      });
      const status = parseTailscaleStatus(stdout);
      if (status !== null) return status;
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  return null;
}

export function createTailscaleReader(now: () => number = Date.now) {
  let cached: { value: TailscaleInfo | null; readAt: number } | null = null;
  let pending: Promise<TailscaleInfo | null> | null = null;

  return function readTailscale(signal: AbortSignal): Promise<TailscaleInfo | null> {
    if (cached !== null && now() - cached.readAt < CACHE_MS) {
      return Promise.resolve(cached.value);
    }
    pending ??= readStatusOnce(signal)
      .then((value) => {
        cached = { value, readAt: now() };
        return value;
      })
      .catch(() => cached?.value ?? null)
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
