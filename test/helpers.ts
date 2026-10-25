// Shared test fixtures. Addresses come from 192.0.2.0/24, which is reserved
// for documentation.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseLxcSettings, type LxcConfig } from "../src/backends/proxmox-lxc/config.ts";
import type { BackendContext, BackendStorage, KindSettings, WarmShortfall } from "../src/backends/types.ts";
import { defaultSize, kindSizes, presetSizes } from "../src/core/sizes.ts";
import { Ssh } from "../src/transports/ssh.ts";
import type { SshAccess } from "../src/transports/types.ts";
import type { RelayWebSocket } from "../src/host/relay.ts";
import type { RelaySocket } from "../src/relay/hub.ts";

export const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

export const VALID = {
  "proxmox-lxc-url": "https://pve.example.com:8006/",
  "proxmox-lxc-token-id": "bb-box@pve!plugin",
  "proxmox-lxc-token-secret": "s3cret",
  "proxmox-lxc-linux-templates": "9000",
  "proxmox-lxc-bridge": "vmbr1",
  "proxmox-lxc-subnet": "192.0.2.0/24",
  "proxmox-lxc-gateway": "192.0.2.1",
  "proxmox-lxc-addresses": "192.0.2.100-192.0.2.199",
  "proxmox-lxc-ssh-private-key": KEY,
};

export function lxcConfig(values: Record<string, unknown> = {}): LxcConfig {
  const result = parseLxcSettings({ ...VALID, ...values });
  assert.ok(result.enabled && result.ok, JSON.stringify(result));
  return result.config;
}

const temporary: string[] = [];
process.once("exit", () => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

export function disposedOnceTheFileEnds(): <T extends { dispose(): Promise<void> }>(thing: T) => T {
  const made: { dispose(): Promise<void> }[] = [];
  process.once("beforeExit", () => void Promise.all(made.map((thing) => thing.dispose())));
  return (thing) => (made.push(thing), thing);
}

/** A fresh directory, removed when the test process exits. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bb-box-${prefix}-`));
  temporary.push(dir);
  return dir;
}

/**
 * Perl, as the macOS timeout wrapper uses, since a shell cannot change its
 * process group. LEAD starts a group and keeps it until its input closes, as
 * it does when the test process ends, then kills the group. JOIN runs a
 * command line in a group, once its leader has started it.
 */
const LEAD = `setpgrp(0, 0) or die "setpgrp: $!\\n"; <STDIN>; kill "KILL", -$$`;
const JOIN =
  `my $group = shift; for (1 .. 100) { last if setpgrp(0, $group); select undef, undef, undef, 0.01 } ` +
  `getpgrp == $group or die "setpgid: $!\\n"; exec @ARGV or exit 127`;

/** The group's leader, held so that its input stays open. */
let leader: ChildProcess | undefined;

/**
 * The process group that fakes run commands in, or null without Perl. It
 * ends with the test process, however it ends, so what a command starts ends
 * then too, though stopping the command, as at a timeout, kills only the
 * fake, as it kills `ssh` for a real box (#310). Once it starts, $FAKE_GROUP
 * holds the command line that joins it, as JSON, for the fake ssh and the
 * fake docker, which run in processes of their own (#320).
 */
export function fakeGroup(): number | null {
  if (!leader) {
    leader = spawn("perl", ["-e", LEAD], { stdio: ["pipe", "ignore", "inherit"] });
    leader.once("error", () => {});
    // The test process need not wait for it.
    leader.unref();
    (leader.stdin as Socket).unref();
    if (leader.pid !== undefined) process.env.FAKE_GROUP = JSON.stringify(inGroup(leader.pid, []));
  }
  return leader.pid ?? null;
}

/** `argv` run in process group `group`. */
export function inGroup(group: number, argv: readonly string[]): [string, ...string[]] {
  return ["perl", "-e", JOIN, String(group), ...argv];
}

export const FAKE_SSH_BINARY = new URL("./fake-ssh.mjs", import.meta.url).pathname;
/** The Mac helper's VM commands, as a Tart backend runs them in a macOS VM, for fake VMs. */
export const FAKE_MAC_HELPER = `${process.execPath} ${new URL("./fake-machine.mjs", import.meta.url).pathname}`;

/** SSH access to a fresh box at `host`, as user box. */
export function at(host: string): SshAccess {
  return { host, port: 22, user: "box", hostKeys: [] };
}

/** Points the fake ssh at a fresh directory. Tests in one file run one at a time, so the environment variable is safe. */
/** A fake ssh client. `share` gives commands to one box a shared connection. */
export function fakeSsh(options: { share?: boolean; lostWaitMs?: number } = {}) {
  const dir = tempDir("fake-ssh");
  process.env.FAKE_SSH_DIR = dir;
  fakeGroup();
  mkdirSync(join(dir, "down"));
  mkdirSync(join(dir, "up-after"));
  mkdirSync(join(dir, "shared"));
  mkdirSync(join(dir, "hold-share"));
  mkdirSync(join(dir, "windows"));
  mkdirSync(join(dir, "powershell"));
  writeFileSync(join(dir, "log"), "");
  const ssh = new Ssh({ keyPath: "/nonexistent/key", binary: FAKE_SSH_BINARY, shareDir: options.share ? join(dir, "shared") : null, lostWaitMs: options.lostWaitMs ?? 0 });
  return {
    dir,
    ssh,
    home: (host: string) => join(dir, "home", host),
    down: (host: string) => writeFileSync(join(dir, "down", host), ""),
    upAfter: (host: string, dials: number) => writeFileSync(join(dir, "up-after", host), String(dials)),
    /** Makes `host` a Windows box, whose shell is PowerShell. */
    windows: (host: string) => writeFileSync(join(dir, "windows", host), ""),
    /** Runs each script for Windows box `host` through `sh`, a sh script that gets it as $1, in place of `sh -c`. */
    powershell: (host: string, sh: string) => writeFileSync(join(dir, "powershell", host), sh),
    /** Keeps a shared connection to `host` from opening until the returned function is called. */
    holdShare: (host: string) => {
      writeFileSync(join(dir, "hold-share", host), "");
      return () => rmSync(join(dir, "hold-share", host));
    },
    log: () =>
      readFileSync(join(dir, "log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { target: string; command: string; args: string[]; control?: string }),
  };
}

export class MemoryStorage implements BackendStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

/** Warm counts by kind from the Proxmox LXC settings before 029: each flavour's goes to its first kind. */
export function lxcWarm(values: Readonly<Record<string, unknown>>): Record<string, number> {
  const kinds = { linux: "linux", desktop: "linux-desktop", "desktop-cpu": "linux-desktop-cpu" };
  return Object.fromEntries(Object.entries(kinds).map(([flavour, kind]) => [kind, Number(values[`proxmox-lxc-${flavour}-warm`] ?? 0)]));
}

/** A kind as bb-box ships it, switched on. */
export function shippedKind(id: string): KindSettings {
  const sizes = kindSizes(id);
  return { enabled: true, defaultSize: defaultSize(sizes), presets: presetSizes(sizes) };
}

export function testContext(
  storage: BackendStorage = new MemoryStorage(),
  installId = "test",
  options: { id?: string; warm?: Readonly<Record<string, number>> } = {},
): BackendContext & { errors: string[]; logs: string[]; short: (readonly WarmShortfall[])[] } {
  const errors: string[] = [];
  const logs: string[] = [];
  const short: (readonly WarmShortfall[])[] = [];
  return {
    id: options.id ?? "test",
    storage,
    installId,
    warm: (kind) => options.warm?.[kind] ?? 0,
    hostOn: () => true,
    kind: shippedKind,
    warmShortfalls: (pools) => void short.push(pools),
    errors,
    logs,
    short,
    logError: (operation, error) => errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
    log: (message) => void logs.push(message),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A stand-in for BB's daemon in a box: a process running a program at
 * `parent`, whose workers each have only the given variables. Workers start
 * in order, so the last is the newest. With `startOn`, they start `seconds`
 * after that file appears, as BB's do a moment after its daemon connects,
 * and this returns without waiting for them. With `parent`, the program is
 * there, so a box can be told of it before the daemon runs. With `agent`,
 * the newest worker starts a process with those variables, as BB's provider
 * workers start a thread's agent. `start` has it start a process of its
 * own with the given variables, as BB's daemon starts a terminal. Stop it
 * when the test ends.
 */
export async function fakeDaemon(
  workers: readonly Readonly<Record<string, string>>[],
  options: { startOn?: { file: string; seconds: number }; parent?: string; agent?: Readonly<Record<string, string>> } = {},
) {
  const parent = options.parent ?? join(tempDir("daemon"), "daemon-bundle");
  const dir = dirname(parent);
  const assignments = (variables: Readonly<Record<string, string>>) =>
    Object.entries(variables)
      .map(([name, value]) => quote(`${name}=${value}`))
      .join(" ");
  const lines = workers.map((variables, i) =>
    options.agent && i === workers.length - 1
      ? `env -i ${assignments(variables)} sh -c ${quote(`env -i ${assignments(options.agent)} sleep 300 & exec sleep 300`)} &`
      : `env -i ${assignments(variables)} sleep 300 &`,
  );
  const { startOn } = options;
  const wait = startOn ? `while [ ! -e ${quote(startOn.file)} ]; do sleep 0.05; done\nsleep ${startOn.seconds}\n` : "";
  const started = `: > ${quote(join(dir, "started"))}\n`;
  const requests = join(dir, "start");
  mkdirSync(requests, { recursive: true });
  // Starts what `start` asks for, as its own child, and keeps running.
  const serve = `while :; do for f in ${quote(requests)}/*.sh; do [ -e "$f" ] || continue; mv "$f" "$f.started"; sh "$f.started" & done; sleep 0.05; done\n`;
  writeFileSync(parent, startOn ? `${started}${wait}${lines.join("\n")}\n${serve}` : `${lines.join("\n")}\n${started}${serve}`);
  const daemon = spawn("sh", [parent], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
  const pid = daemon.pid!;
  const running = () => {
    try {
      // Not the `sleep` before them, with `startOn`.
      return execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(pid)], { encoding: "utf8" })
        .split("\n")
        .filter((line) => /\bsleep 300$/.test(line.trim()));
    } catch {
      // ps exits 1 when it finds none.
      return [];
    }
  };
  for (let i = 0; !existsSync(join(dir, "started")) || (!startOn && running().length < workers.length); i++) {
    if (i > 400) throw new Error("the fake daemon did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    parent,
    /**
     * Has the daemon start a process with `variables`, and returns whether it
     * has started it yet, each time it is asked.
     */
    start: (variables: Readonly<Record<string, string>>) => {
      const file = join(requests, `${randomUUID()}.sh`);
      writeFileSync(file, `exec env -i ${assignments(variables)} sleep 301\n`);
      return () => existsSync(`${file}.started`);
    },
    /** The workers' process IDs, oldest first. */
    workers: () => running().map((line) => Number(line.trim().split(/\s+/)[0])).sort((a, b) => a - b),
    stop: () => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    },
  };
}

/** A route of bb-box's that a worker's WebSocket connects to, as a RelayHub's or FileRelay's. */
export interface Routed {
  route(url: URL): { onOpen(socket: RelaySocket): void; onMessage(socket: RelaySocket, data: string | Uint8Array): void; onClose(): void };
}

/** A WebSocket from the worker to the hub's route, delivered a turn later each way, or opening `openAfterMs` after it upgrades. */
export function joined(hub: () => Routed, options: { openAfterMs?: number } = {}) {
  const urls: string[] = [];
  const connectTo = (url: string): RelayWebSocket => {
    urls.push(url);
    const listeners = { open: [] as (() => void)[], close: [] as (() => void)[], error: [] as (() => void)[], message: [] as ((event: { data: unknown }) => void)[] };
    const handlers = hub().route(new URL(url.replace(/^ws/, "http")));
    let closed = false;
    const server: RelaySocket = {
      send: (data) => {
        const copy = Uint8Array.from(data);
        setImmediate(() => listeners.message.forEach((listener) => listener({ data: copy.buffer })));
      },
      close: () => {
        if (closed) return;
        closed = true;
        setImmediate(() => listeners.close.forEach((listener) => listener()));
      },
    };
    const socket: RelayWebSocket = {
      binaryType: "blob",
      send: (data) => {
        const copy = Uint8Array.from(data);
        setImmediate(() => handlers.onMessage(server, copy));
      },
      close: () => {
        if (closed) return;
        closed = true;
        setImmediate(() => handlers.onClose());
      },
      addEventListener: (type: string, listener: never) => (listeners as Record<string, unknown[]>)[type]!.push(listener),
    };
    if (options.openAfterMs === undefined) setImmediate(() => handlers.onOpen(server));
    else setTimeout(() => handlers.onOpen(server), options.openAfterMs);
    return socket;
  };
  return { urls, connectTo };
}

/**
 * ffmpeg that records until SIGTERM, reports two still stretches, the second
 * running to the end, and writes "mp4data" for a clip; ffprobe that gives
 * 10 s for the capture, 4.2 s for the clip and 1280x720. Each ffmpeg call's
 * arguments go to ~/ffmpeg-args.
 */
export function fakeFfmpeg(options: { wfRecorder?: boolean; darwin?: boolean; ffmpeg8?: boolean } = {}): string {
  const bin = tempDir("fake-ffmpeg");
  writeFileSync(
    join(bin, "ffmpeg"),
    `#!/bin/sh
for a; do out=$a; done
echo "$*" >> "$HOME/ffmpeg-args"
case "$*" in
  *list_devices*) printf '[AVFoundation indev @ 0x1] [0] Capture screen 0\n' >&2 ;;
  *x11grab* | *"-f avfoundation"*) trap 'echo capture > "$out"; exit 0' TERM; while :; do sleep 0.05; done ;;
  *"print(tw)"*) ${options.ffmpeg8 ? `printf '[Eval @ 0x5a1] 120.000000\\n    Last message repeated 1 times\\n' >&2` : `printf '120.000000\\n' >&2`} ;;
  *"-f null"*) printf '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 1\\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 6\\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 8\\n' >&2 ;;
  *) printf mp4data > "$out" ;;
esac
`,
  );
  writeFileSync(
    join(bin, "ffprobe"),
    `#!/bin/sh
case "$*" in
  *width,height*) echo 1280x720 ;;
  *capture.mkv*) echo 10.000000 ;;
  *) echo 4.200000 ;;
esac
`,
  );
  chmodSync(join(bin, "ffmpeg"), 0o755);
  chmodSync(join(bin, "ffprobe"), 0o755);
  if (options.darwin) {
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n");
    chmodSync(join(bin, "uname"), 0o755);
  }
  if (options.wfRecorder !== false) {
    // wf-recorder records to its -f file until SIGTERM, which timeout passes on.
    writeFileSync(
      join(bin, "wf-recorder"),
      `#!/bin/sh
echo "wf-recorder $*" >> "$HOME/ffmpeg-args"
while [ $# -gt 0 ]; do [ "$1" = -f ] && out=$2; shift; done
trap 'echo capture > "$out"; exit 0' TERM
while :; do sleep 0.05; done
`,
    );
    chmodSync(join(bin, "wf-recorder"), 0o755);
  }
  return bin;
}
