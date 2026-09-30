// A smoke test of a real backend, without BB: it acquires a box, runs a
// command in it, releases it, and prints how long each step took. For a
// desktop kind it also opens the desktop the way the viewer's relay does,
// answering its VNC password, shows the box's display facts, and asks the
// computer-use driver for the desktop's windows as the computer tools do.
//
//   node scripts/smoke.ts <settings.json> [--kind <kind>] [--command <script>] [--doctor] [--json]
//
// The settings file is one JSON object with bb-box's settings, under the
// same keys as in BB. A value can come from a file instead, with a path
// relative to the settings file:
//
//   {"file": "ssh/id_ed25519"}                           the whole file
//   {"file": "proxmox-token.env", "key": "PROXMOX_NODE"} one NAME=value line
//
// scripts/smoke.example.json reads the setup guide's token file and SSH key
// this way. Keep your own settings file out of the repository.
//
// The box belongs to thread thr_smoke, which is not a BB thread. Smoke runs
// are their own install, with the ID "smoke" (018): a bb-box install on the
// same backend leaves their boxes alone, and each run first releases the
// boxes an earlier run left.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Backends } from "../src/backends/index.ts";
import type { BackendDriver, BackendStorage } from "../src/backends/types.ts";
import { Boxes, describeError, type BoxRecord } from "../src/core/boxes.ts";
import { driverCommand } from "../src/core/in-box.ts";
import { McpSession } from "../src/core/mcp.ts";
import { desktopSize, displayOpener } from "../src/core/relay.ts";
import { doctorText } from "../src/plugin/views.ts";

export const SMOKE_THREAD = "thr_smoke";
export const SMOKE_INSTALL = "smoke";

export interface SmokeOptions {
  readonly kind: string;
  readonly command: string;
  /** Run each active backend's doctor first, and stop if a check fails. */
  readonly doctor?: boolean;
  readonly drivers?: readonly BackendDriver<any>[];
  /** Aborting skips the command and releases the box. */
  readonly signal?: AbortSignal;
  log(line: string): void;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly box: { readonly name: string; readonly kind: string; readonly backend: string; readonly address: string | null } | null;
  readonly output: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string } | null;
  /** The desktop's size, for a desktop kind whose desktop answered. */
  readonly desktop: { readonly width: number; readonly height: number } | null;
  /** How many windows the computer-use driver listed, for a kind with computer use whose driver answered. */
  readonly computerUse: { readonly windows: number } | null;
  /** The box's facts, such as its GPU and display mode. */
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  /** Milliseconds: the backend's acquire steps, then acquire, run and release as the caller saw them. */
  readonly timings: Record<string, number>;
  readonly problems: string[];
}

class MemoryStorage implements BackendStorage {
  readonly #values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.#values.get(key)) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }
  async list(prefix = ""): Promise<string[]> {
    return [...this.#values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

/** Reads a settings file, replacing each {"file"} value with what it points at. */
export function readSettings(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must hold one JSON object of settings.`);
  const base = dirname(resolve(path));
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    values[name] = isFileRef(value) ? fromFile(resolve(base, value.file), value.key) : value;
  }
  return values;
}

function isFileRef(value: unknown): value is { file: string; key?: string } {
  return !!value && typeof value === "object" && typeof (value as { file?: unknown }).file === "string";
}

function fromFile(path: string, key: string | undefined): string {
  const text = readFileSync(path, "utf8");
  if (key === undefined) return text;
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] === key) return match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  throw new Error(`${path} has no ${key}= line.`);
}

export async function smoke(values: Readonly<Record<string, unknown>>, options: SmokeOptions): Promise<SmokeResult> {
  const { log } = options;
  const storage = new MemoryStorage();
  const problems: string[] = [];
  const logError = (operation: string, error: unknown) => log(`  (${operation}: ${describeError(error, operation)})`);
  const backends = new Backends({ storage, installId: SMOKE_INSTALL, logError, drivers: options.drivers });
  const timings: Record<string, number> = {};
  let box: BoxRecord | null = null;
  let output: SmokeResult["output"] = null;
  let desktop: SmokeResult["desktop"] = null;
  let computerUse: SmokeResult["computerUse"] = null;
  const boxes = new Boxes({
    kv: storage,
    backends,
    general: async () => ({ perThreadLimit: null, enrol: false }),
    notify: () => {},
    thread: async () => "live",
    logError,
  });
  const result = (): SmokeResult => ({
    ok: problems.length === 0,
    box: box && { name: box.name, kind: box.kind, backend: box.backendLabel, address: box.guest?.address ?? null },
    output,
    desktop,
    computerUse,
    facts: box?.guest?.facts ?? [],
    timings,
    problems,
  });

  try {
    await backends.configure(values);
    for (const status of backends.statuses()) {
      if (status.state === "misconfigured") problems.push(`${status.label}: ${status.problems.join(" ")}`);
    }
    if (problems.length) return result();
    if (!backends.active().length) {
      problems.push("No backend is on. Turn one on in the settings file, for example proxmox-lxc-enabled.");
      return result();
    }

    if (options.doctor) {
      const sections = [];
      for (const backend of backends.active()) sections.push({ title: backend.label, report: await backend.doctor(options.signal) });
      const view = { ok: sections.every((section) => section.report.ok), sections };
      log(doctorText(view));
      log("");
      if (!view.ok) {
        problems.push("The doctor found problems. Fix them, then run the smoke test again.");
        return result();
      }
    }

    for (const backend of backends.active()) {
      for (const guest of await backend.held(options.signal)) {
        log(`Releasing a box an earlier smoke run left in ${backend.label}...`);
        await backend.release(guest, { resetting: async () => {}, timing: () => {} }, options.signal);
      }
    }

    log(`Acquiring a ${options.kind} box...`);
    let started = performance.now();
    try {
      box = await boxes.acquire({ threadId: SMOKE_THREAD, projectId: null, kind: options.kind });
      box = (await boxes.settled(box)) ?? box;
    } catch (error) {
      problems.push(describeError(error, "Acquiring the box"));
      return result();
    }
    Object.assign(timings, box.timings);
    timings.acquire = performance.now() - started;
    if (box.state !== "ready") {
      problems.push(`Box ${box.name} is ${box.state}: ${box.error ?? "no reason given"}`);
    } else {
      log(`Box ${box.name} from ${box.backendLabel} is ready${box.guest?.address ? ` at ${box.guest.address}` : ""}.`);
      for (const fact of box.guest?.facts ?? []) log(`  ${fact.label}: ${fact.value}`);
      if (options.signal?.aborted) {
        problems.push("Interrupted before the command ran.");
      } else {
        log(`$ ${options.command}`);
        started = performance.now();
        try {
          const { result: run } = await boxes.run(SMOKE_THREAD, box.id, options.command, { timeoutMs: 120_000, signal: options.signal });
          timings.run = performance.now() - started;
          output = { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
          if (run.stdout) log(run.stdout.trimEnd());
          if (run.stderr) log(run.stderr.trimEnd());
          if (run.timedOut) problems.push("The command timed out after 120 s.");
          else if (run.exitCode !== 0) problems.push(`The command exited with ${run.exitCode}.`);
        } catch (error) {
          problems.push(describeError(error, "Running the command"));
        }
      }
      if (box.capabilities.displays.length && !options.signal?.aborted) {
        log("Opening the desktop as the viewer's relay does...");
        started = performance.now();
        try {
          const [display] = (await boxes.transports(box)).displays;
          if (!display) throw new Error("The box's backend gave no desktop.");
          desktop = await desktopSize(displayOpener(display));
          timings.desktop = performance.now() - started;
          log(`The desktop answered: ${desktop.width} by ${desktop.height}.`);
        } catch (error) {
          problems.push(describeError(error, "Opening the desktop"));
        }
      }
      const driver = box.capabilities.computerUse;
      if (driver && !options.signal?.aborted) {
        log("Asking the computer-use driver for the desktop's windows...");
        started = performance.now();
        let session: McpSession | null = null;
        try {
          const { command } = await boxes.transports(box);
          if (!command?.spawn) throw new Error("The box's command transport cannot start the computer-use driver.");
          const channel = await command.spawn(driverCommand(box.capabilities.os, driver.socket), AbortSignal.timeout(15_000));
          session = await McpSession.open(channel, { client: { name: "bb-box-smoke", version: "1" }, timeoutMs: 15_000 });
          const listed = await session.call("list_windows", {}, { timeoutMs: 30_000 });
          const windows = listed.structuredContent?.windows;
          if (listed.isError || !Array.isArray(windows)) throw new Error(`The driver did not list the windows: ${listed.content.map((part) => part.text ?? "").join(" ")}`);
          computerUse = { windows: windows.length };
          timings["computer use"] = performance.now() - started;
          log(`The computer-use driver answered: ${windows.length} ${windows.length === 1 ? "window" : "windows"}.`);
        } catch (error) {
          problems.push(describeError(error, "Reaching the computer-use driver"));
        } finally {
          await session?.close();
        }
      }
    }

    log(`Releasing box ${box.name}...`);
    started = performance.now();
    try {
      const left = await boxes.release(SMOKE_THREAD, box.id);
      timings.release = performance.now() - started;
      if (left) problems.push(`Box ${box.name} was not released: ${left.error ?? "the backend has not finished"}. Delete it by hand.`);
    } catch (error) {
      problems.push(describeError(error, "Releasing the box"));
    }
    return result();
  } finally {
    await boxes.idle();
    await boxes.dispose();
    await backends.dispose();
  }
}

/** The timings as a two-column table, in the order they happened. */
export function timingTable(timings: Readonly<Record<string, number>>): string {
  const rows = Object.entries(timings).map(([step, ms]) => [step === "total" ? "ready (backend)" : step, `${(ms / 1000).toFixed(2)} s`] as const);
  const width = Math.max(4, ...rows.map(([step]) => step.length));
  return [`${"Step".padEnd(width)}  Time`, ...rows.map(([step, time]) => `${step.padEnd(width)}  ${time}`)].join("\n");
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        kind: { type: "string", default: "linux-headless" },
        command: { type: "string", default: "uname -a" },
        doctor: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const [path] = parsed.positionals;
  if (!path || parsed.positionals.length > 1) {
    process.stderr.write("Usage: node scripts/smoke.ts <settings.json> [--kind <kind>] [--command <script>] [--doctor] [--json]\n");
    return 2;
  }
  let values: Record<string, unknown>;
  try {
    values = readSettings(path);
  } catch (error) {
    process.stderr.write(`Could not read the settings: ${(error as Error).message}\n`);
    return 2;
  }

  const interrupt = new AbortController();
  process.once("SIGINT", () => {
    process.stderr.write("\nInterrupted: releasing the box first. Press Ctrl-C again to quit at once.\n");
    interrupt.abort();
  });
  const { json } = parsed.values;
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const result = await smoke(values, {
    kind: parsed.values.kind,
    command: parsed.values.command,
    doctor: parsed.values.doctor,
    signal: interrupt.signal,
    log: json ? log : (line) => process.stdout.write(`${line}\n`),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (Object.keys(result.timings).length) process.stdout.write(`\n${timingTable(result.timings)}\n`);
    for (const problem of result.problems) process.stderr.write(`\n${problem}\n`);
    if (result.ok) process.stdout.write("\nThe smoke test passed.\n");
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
