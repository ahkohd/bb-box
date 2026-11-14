import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GUARD_FOLDER_PREFIX, SYSTEM_PATH, isTestMade, privilegedToolsOn } from "./host-stubs.mjs";

export const GUARD_RECORD_VARIABLE = "BBBOX_TEST_GUARD_RECORD";
const GUARD_EXIT_CODE = 97;

const SPAWNERS = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"] as const;

type Spawner = (...args: unknown[]) => unknown;
type Environment = Record<string, string | undefined>;

export interface HostGuard {
  readonly bin: string;
  readonly record: string;
  reached(): string[];
  dispose(): void;
}

function guardStub(unattributed: string): string {
  return [
    "#!/bin/sh",
    `record=\${${GUARD_RECORD_VARIABLE}:-'${unattributed}'}`,
    'printf \'%s\\n\' "$(basename "$0")${*:+ $*}" >> "$record"',
    `printf 'BB Box test guard: a test ran the test machine'"'"'s own %s. Run it through a fake'"'"'s host stubs, in test/host-stubs.mjs.\\n' "$(basename "$0")\${*:+ $*}" >&2`,
    `exit ${GUARD_EXIT_CODE}`,
  ].join("\n");
}

function guardFolderName(stub: string, tools: readonly string[]): string {
  return `${GUARD_FOLDER_PREFIX}${process.getuid?.() ?? "user"}-${createHash("sha256").update(stub).update(tools.join(" ")).digest("hex").slice(0, 12)}`;
}

function testMachineTools(): string[] {
  const machinePath = (process.env.PATH || SYSTEM_PATH).split(delimiter).filter((dir) => dir !== "" && !isTestMade(dir));
  return privilegedToolsOn([...machinePath, SYSTEM_PATH].join(delimiter));
}

function ownedByThisUser(dir: string): boolean {
  const stat = statSync(dir);
  return (process.getuid === undefined || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0;
}

function sharedGuardFolder(): string {
  const tools = testMachineTools();
  const dir = join(tmpdir(), guardFolderName(guardStub(""), tools));
  const stub = guardStub(join(dir, "unattributed.log"));
  if (!existsSync(dir)) {
    const making = `${dir}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    for (const folder of [making, join(making, "bin"), join(making, "records")]) {
      mkdirSync(folder, { recursive: true });
      chmodSync(folder, 0o755);
    }
    for (const name of tools) writeFileSync(join(making, "bin", name), stub, { mode: 0o755 });
    try {
      renameSync(making, dir);
    } catch {
      rmSync(making, { recursive: true, force: true });
    }
  }
  if (!ownedByThisUser(dir)) throw new Error(`BB Box's test guard folder ${dir} belongs to another user or others can write to it. Remove it and run the tests again.`);
  return dir;
}

export function guardedPath(path: string | undefined, bin: string): string {
  const dirs = (path || SYSTEM_PATH).split(delimiter);
  if (dirs.includes(bin)) return dirs.join(delimiter);
  const firstHostDir = dirs.findIndex((dir) => dir !== "" && !isTestMade(dir));
  const at = firstHostDir === -1 ? dirs.length : firstHostDir;
  return [...dirs.slice(0, at), bin, ...dirs.slice(at)].join(delimiter);
}

function pathKey(env: Environment): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

function guardedEnvironment(env: Environment, guard: HostGuard): Environment {
  const key = pathKey(env);
  return { ...env, [key]: guardedPath(env[key], guard.bin), [GUARD_RECORD_VARIABLE]: env[GUARD_RECORD_VARIABLE] ?? guard.record };
}

function hasOwnEnvironment(arg: unknown): arg is { env: Environment } {
  return typeof arg === "object" && arg !== null && !Array.isArray(arg) && typeof (arg as { env?: unknown }).env === "object" && (arg as { env?: unknown }).env !== null;
}

function withGuardedEnvironment(args: unknown[], guard: HostGuard): unknown[] {
  return args.map((arg) => (hasOwnEnvironment(arg) ? { ...arg, env: guardedEnvironment(arg.env, guard) } : arg));
}

function guardedSpawner(original: Spawner, guard: HostGuard): Spawner {
  const guarded: Spawner = (...args) => original(...withGuardedEnvironment(args, guard));
  for (const key of Object.getOwnPropertySymbols(original)) {
    const custom = (original as unknown as Record<symbol, unknown>)[key];
    if (typeof custom === "function") Object.defineProperty(guarded, key, { value: (...args: unknown[]) => (custom as Spawner)(...withGuardedEnvironment(args, guard)) });
  }
  return guarded;
}

function guardEveryChild(guard: HostGuard): void {
  const spawners = childProcess as unknown as Record<string, Spawner>;
  for (const name of SPAWNERS) spawners[name] = guardedSpawner(spawners[name]!, guard);
  syncBuiltinESMExports();
}

function linesOf(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

let installed: HostGuard | null = null;

export function installHostGuard(): HostGuard {
  installed ??= guardThisProcess();
  return installed;
}

export function reachedTestMachineMessage(reached: readonly string[]): string {
  return `This test file ran the test machine's own privileged tools, which BB Box's test guard stopped: ${reached.join("; ")}. Run them through a fake's host stubs, in test/host-stubs.mjs.`;
}

function guardThisProcess(): HostGuard {
  const dir = sharedGuardFolder();
  const record = join(dir, "records", `${process.pid}.log`);
  const unattributed = join(dir, "unattributed.log");
  const unattributedBefore = linesOf(unattributed).length;
  writeFileSync(record, "");
  const guard: HostGuard = {
    bin: join(dir, "bin"),
    record,
    reached: () => [...linesOf(record), ...linesOf(unattributed).slice(unattributedBefore)],
    dispose: () => rmSync(record, { force: true }),
  };
  process.env.PATH = guardedPath(process.env.PATH, guard.bin);
  process.env[GUARD_RECORD_VARIABLE] = record;
  guardEveryChild(guard);
  return guard;
}
