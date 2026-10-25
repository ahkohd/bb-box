import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSignallablePid } from "../transports/spawns.ts";

export const TEMP_PREFIX = "bb-box-";
export const OWNER_FILE = ".bb-box-owner";
export const UNMARKED_KEPT_FOR_MS = 24 * 3_600_000;

export interface ProcessView {
  readonly pid: number;
  readonly uid: number;
  startToken(pid: number): string | null;
  livePaths(): readonly string[];
}

export function shortTempBase(): string {
  return tmpdir().length > 40 ? "/tmp" : tmpdir();
}

export function ownerMark(view: Pick<ProcessView, "pid" | "startToken"> = linuxProcessView()): string {
  return `${view.pid} ${view.startToken(view.pid) ?? "unknown"}\n`;
}

export async function makeTempFolder(prefix: string, base = tmpdir()): Promise<string> {
  const dir = await mkdtemp(join(base, prefix));
  await writeFile(join(dir, OWNER_FILE), ownerMark(), { mode: 0o600 });
  return dir;
}

export function makeTempFolderSync(prefix: string, base = tmpdir()): string {
  const dir = mkdtempSync(join(base, prefix));
  writeFileSync(join(dir, OWNER_FILE), ownerMark(), { mode: 0o600 });
  return dir;
}

export function linuxProcessView(procRoot = "/proc"): ProcessView {
  return {
    pid: process.pid,
    uid: process.getuid?.() ?? -1,
    startToken: (pid) => {
      if (!hasProc(procRoot)) return processAlive(pid) ? "alive" : null;
      try {
        const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
      } catch {
        return null;
      }
    },
    livePaths: () => {
      const paths: string[] = [];
      try {
        for (const line of readFileSync(join(procRoot, "net", "unix"), "utf8").split("\n").slice(1)) {
          const path = line.trim().split(/\s+/)[7];
          if (path?.startsWith("/")) paths.push(path);
        }
      } catch {}
      let pids: string[] = [];
      try {
        pids = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
      } catch {}
      for (const pid of pids) {
        let fds: string[] = [];
        try {
          fds = readdirSync(join(procRoot, pid, "fd"));
        } catch {
          continue;
        }
        for (const fd of fds) {
          try {
            paths.push(readlinkSync(join(procRoot, pid, "fd", fd)));
          } catch {}
        }
      }
      return paths;
    },
  };
}

function hasProc(procRoot: string): boolean {
  try {
    statSync(join(procRoot, "self"));
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  if (!isSignallablePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SweepResult {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
}

export function sweepStaleTempFolders(options: { bases?: readonly string[]; view?: ProcessView; now?: number } = {}): SweepResult {
  const view = options.view ?? linuxProcessView();
  const now = options.now ?? Date.now();
  const bases = [...new Set(options.bases ?? [tmpdir(), "/tmp"])];
  const removed: string[] = [];
  const kept: string[] = [];
  let live: readonly string[] | null = null;
  const inUse = (dir: string) => (live ??= view.livePaths()).some((path) => path === dir || path.startsWith(`${dir}/`));
  for (const base of bases) {
    let names: string[] = [];
    try {
      names = readdirSync(base).filter((name) => name.startsWith(TEMP_PREFIX));
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(base, name);
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory() || (view.uid >= 0 && stat.uid !== view.uid)) continue;
      const stale = isStale(dir, stat.mtimeMs, view, now, inUse);
      if (!stale) {
        kept.push(dir);
        continue;
      }
      try {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        kept.push(dir);
      }
    }
  }
  return { removed, kept };
}

function isStale(dir: string, mtimeMs: number, view: ProcessView, now: number, inUse: (dir: string) => boolean): boolean {
  let mark: string | null = null;
  try {
    mark = readFileSync(join(dir, OWNER_FILE), "utf8").trim();
  } catch {}
  if (mark) {
    const [pidText, token] = mark.split(" ");
    const pid = Number(pidText);
    if (pid === view.pid) return false;
    const current = Number.isInteger(pid) && pid > 0 ? view.startToken(pid) : null;
    return current === null || (token !== "unknown" && current !== token);
  }
  return now - mtimeMs > UNMARKED_KEPT_FOR_MS && !inUse(dir);
}
