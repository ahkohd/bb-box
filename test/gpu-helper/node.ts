import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { heldCopyDescription } from "../../src/backends/proxmox/copies.ts";
import { boxTags, describe } from "../../src/backends/proxmox/owner.ts";
import type { BoxIdentity } from "../../src/backends/types.ts";
import { tempDir } from "../helpers.ts";

export const HELPER = new URL("../../setup/proxmox-lxc/host/bb-box-gpu", import.meta.url).pathname;
const FAKE_PVE = new URL(".", import.meta.url).pathname;
const HOLD_LOCK = new URL("./hold-config-lock.pl", import.meta.url).pathname;

export const INSTALL = "4kq7";
export const POOL = "bbbox";
export const REPORT_VMID = 9190;

export interface FakeCard {
  readonly uuid: string;
  readonly bus: string;
  readonly index: number;
  readonly minor: number;
  readonly card: string | null;
  readonly render: string | null;
  readonly freeMiB: number;
  readonly totalMiB: number;
}

export const CARD_A: FakeCard = { uuid: "3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00", bus: "00000000:21:00.0", index: 0, minor: 1, card: "card2", render: "renderD129", freeMiB: 97_000, totalMiB: 97_887 };
export const CARD_B: FakeCard = { uuid: "8c41d7b2-1a9e-4f63-b0c5-7e2d9a3b6c11", bus: "00000000:D1:00.0", index: 1, minor: 0, card: "card1", render: "renderD128", freeMiB: 90_000, totalMiB: 97_887 };

export function pciOf(card: FakeCard): string {
  return card.bus.slice(4).toLowerCase();
}

export function marker(part: "none" | "shared" | "whole", card: FakeCard | null, generation: number): string {
  return part === "none" ? `gpu.none.g${generation}` : `gpu.${part}.${card!.uuid}.g${generation}`;
}

export function cardLines(card: FakeCard, set: "server" | "desktop"): string[] {
  const server = [`/dev/nvidia${card.minor}`, "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools"];
  const desktop = [...server, "/dev/nvidia-modeset", `/dev/dri/${card.render}`, `/dev/dri/${card.card}`];
  return (set === "server" ? server : desktop).map((path) => `${path},mode=0666`);
}

export interface GuestSpec {
  readonly box?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly install?: string;
  readonly description?: string;
  readonly hostname?: string;
  readonly tags?: readonly string[];
  readonly marker?: string | readonly string[];
  readonly lines?: readonly string[];
  readonly keys?: Readonly<Record<string, string>>;
  readonly lxc?: readonly (readonly [string, string])[];
  readonly pending?: Readonly<Record<string, string>>;
  readonly snapshots?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly running?: boolean;
  readonly pool?: string | null;
  readonly unprivileged?: boolean;
  readonly template?: boolean;
  readonly lock?: string;
}

export interface ParsedConfig {
  readonly description: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly lxc: readonly string[];
  readonly sections: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

function identity(box: string, name: string, kind: string): BoxIdentity {
  return { boxId: box, threadId: "thr_test", name, kind, createdAt: Date.UTC(2026, 9, 31), size: { cores: 2, memoryMiB: 2048, diskGiB: 16, gpu: "none" } };
}

export function boxLabels(box: string, name: string, kind = "linux", install = INSTALL): { description: string; tags: string[] } {
  const who = identity(box, name, kind);
  return { description: describe(who, install), tags: boxTags(who, install, 9001) };
}

export function heldCopyLabels(box: string, install = INSTALL): { description: string; tags: string[] } {
  return { description: heldCopyDescription(install, { box, snapshot: "snap-1", takenAt: Date.UTC(2026, 9, 30), kept: null, kind: "linux" }), tags: ["bb-box", `install.${install}`, "held-copy", `box.${box}`] };
}

function encode(text: string): string {
  return text.replace(/[^\x20-\x39\x3b-\x7e]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function sectionText(keys: Readonly<Record<string, string>>, description?: string, lxc: readonly (readonly [string, string])[] = []): string {
  const lines = description ? description.replace(/\n+$/, "").split("\n").map((line) => `#${encode(line)}`) : [];
  for (const key of Object.keys(keys).sort()) lines.push(`${key}: ${keys[key]}`);
  for (const [key, value] of lxc) lines.push(`${key}: ${value}`);
  return lines.map((line) => `${line}\n`).join("");
}

export function parseConfig(text: string): ParsedConfig {
  let description = "";
  const keys: Record<string, string> = {};
  const lxc: string[] = [];
  const sections: Record<string, Record<string, string>> = {};
  let section: Record<string, string> | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = sections[header[1]!] = {};
      continue;
    }
    if (line.startsWith("#")) {
      if (!section) description += `${decodeURIComponent(line.slice(1))}\n`;
      continue;
    }
    const match = /^([^:]+):\s*(.*)$/.exec(line)!;
    if (match[1]!.startsWith("lxc.") && !section) lxc.push(`${match[1]}: ${match[2]}`);
    else (section ?? keys)[match[1]!] = match[2]!;
  }
  return { description, keys, lxc, sections };
}

export function gpuLines(keys: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(keys).filter(([key, value]) => /^dev\d+$/.test(key) && /^(?:path=)?\/dev\/(?:nvidia|dri\/)/.test(value)));
}

export function otherKeys(keys: Readonly<Record<string, string>>): Record<string, string> {
  const gpu = gpuLines(keys);
  return Object.fromEntries(Object.entries(keys).filter(([key]) => !(key in gpu)));
}

export interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class FakeNode {
  readonly root = tempDir("gpu-helper");
  readonly node = "pve";
  readonly pools = new Map<number, string>();
  #cards: FakeCard[] = [];
  #boot = "boot-1";

  #helper: string;

  constructor(options: { readonly cards?: readonly FakeCard[]; readonly writes?: "on" | "off" | null; readonly pools?: readonly string[]; readonly pveContainer?: string; readonly ledger?: boolean; readonly helperVersion?: string } = {}) {
    for (const dir of ["etc/pve/nodes/pve/lxc", "etc/pve/nodes/pve/qemu-server", "etc/bb-box", "var/lib", "run/fake-pve/running", "bin", "sys/module/nvidia", "proc/sys/kernel/random", "dev/dri/by-path"]) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
    this.#helper = options.helperVersion === undefined ? HELPER : helperAs(options.helperVersion, join(this.root, "bb-box-gpu-as-released"));
    for (const node of ["nvidiactl", "nvidia-uvm", "nvidia-uvm-tools", "nvidia-modeset", "dri/card0"]) writeFileSync(join(this.root, "dev", node), "");
    writeFileSync(join(this.root, "sys/module/nvidia/version"), "580.142\n");
    writeFileSync(join(this.root, "pve-container-version"), `${options.pveContainer ?? "6.1.14"}\n`);
    writeFileSync(join(this.root, "bin/dpkg-query"), `#!/bin/sh\ncat "${join(this.root, "pve-container-version")}"\n`, { mode: 0o755 });
    writeFileSync(
      join(this.root, "bin/nvidia-smi"),
      [
        "#!/bin/sh",
        `root="${this.root}"`,
        'date +%s%N >"$root/smi.started"',
        'echo $$ >"$root/smi.pid"',
        'echo $$ >>"$root/smi.starts"',
        'if [ -f "$root/smi-fails" ]; then echo "NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver." >&2; exit 9; fi',
        "loop=0",
        'for argument; do [ "$argument" = -l ] && loop=1; done',
        'stall() { trap "" TERM; exec sleep 3600; }',
        '[ "$(cat "$root/smi-mode" 2>/dev/null)" = silent ] && stall',
        'while :; do',
        '  cat "$root/smi" || exit 0',
        '  [ "$(cat "$root/smi-mode" 2>/dev/null)" = stall ] && stall',
        '  [ -f "$root/smi-stderr" ] && cat "$root/smi-stderr" >&2',
        '  [ -f "$root/smi-killed" ] && kill -KILL $$',
        '  [ "$loop" = 1 ] || exit "$(cat "$root/smi-exit" 2>/dev/null || echo 0)"',
        "  sleep 0.2",
        "done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    this.setBoot("boot-1");
    this.setCards(options.cards ?? [CARD_A, CARD_B]);
    if (options.writes !== null) this.setHelperConfig(options.pools ?? [POOL], options.writes ?? "off");
    writeFileSync(join(this.root, "etc/pve/nodes/pve/qemu-server", `${REPORT_VMID}.conf`), "memory: 16\nname: bb-box-gpu-memory\nonboot: 0\nprotection: 1\n");
    writeFileSync(join(this.root, "etc/pve/nodes/pve/qemu-server", "100.conf"), "memory: 2048\nname: something-else\n");
    symlinkSync("nodes/pve/qemu-server", join(this.root, "etc/pve/qemu-server"));
    symlinkSync("nodes/pve/lxc", join(this.root, "etc/pve/lxc"));
    this.#writePools();
    if (options.ledger !== false) this.write("var/lib/bb-box-gpu/ledger", `${JSON.stringify({ protocol: 1, guests: {}, answers: [] })}\n`);
  }

  setHelperConfig(pools: readonly string[], writes: "on" | "off", mode = 0o600): void {
    const file = join(this.root, "etc/bb-box/gpu.conf");
    writeFileSync(file, `pools ${pools.join(" ")}\nwrites ${writes}\n`);
    chmodSync(file, mode);
  }

  setBoot(id: string): void {
    this.#boot = id;
    writeFileSync(join(this.root, "proc/sys/kernel/random/boot_id"), `${id}\n`);
  }

  get boot(): string {
    return this.#boot;
  }

  setCards(cards: readonly FakeCard[]): void {
    for (const card of this.#cards) {
      rmSync(join(this.root, "proc/driver/nvidia/gpus", pciOf(card)), { recursive: true, force: true });
      for (const type of ["card", "render"]) rmSync(join(this.root, "dev/dri/by-path", `pci-${pciOf(card)}-${type}`), { force: true });
      rmSync(join(this.root, "dev", `nvidia${card.minor}`), { force: true });
      for (const node of [card.card, card.render]) if (node) rmSync(join(this.root, "dev/dri", node), { force: true });
    }
    this.#cards = [...cards];
    for (const card of cards) {
      const proc = join(this.root, "proc/driver/nvidia/gpus", pciOf(card));
      mkdirSync(proc, { recursive: true });
      writeFileSync(join(proc, "information"), `Model: \t\t NVIDIA RTX PRO 6000\nIRQ:   \t\t 220\nGPU UUID: \t GPU-${card.uuid}\nDevice Minor: \t ${card.minor}\nBus Location: \t ${pciOf(card)}\n`);
      writeFileSync(join(this.root, "dev", `nvidia${card.minor}`), "");
      if (card.card) {
        writeFileSync(join(this.root, "dev/dri", card.card), "");
        symlinkSync(`../${card.card}`, join(this.root, "dev/dri/by-path", `pci-${pciOf(card)}-card`));
      }
      if (card.render) {
        writeFileSync(join(this.root, "dev/dri", card.render), "");
        symlinkSync(`../${card.render}`, join(this.root, "dev/dri/by-path", `pci-${pciOf(card)}-render`));
      }
    }
    writeFileSync(join(this.root, "smi"), cards.map((card) => `GPU-${card.uuid}, ${card.bus}, ${card.index}, ${card.freeMiB}, ${card.totalMiB}\n`).join(""));
  }

  setMemory(cards: readonly FakeCard[]): void {
    writeFileSync(join(this.root, "smi.next"), cards.map((card) => `GPU-${card.uuid}, ${card.bus}, ${card.index}, ${card.freeMiB}, ${card.totalMiB}\n`).join(""));
    renameSync(join(this.root, "smi.next"), join(this.root, "smi"));
  }

  smiReading(rows: readonly string[], ending: { readonly exit?: number; readonly stderr?: string } = {}): void {
    writeFileSync(join(this.root, "smi"), rows.map((row) => `${row}\n`).join(""));
    for (const [file, value] of [["smi-exit", ending.exit ? String(ending.exit) : undefined], ["smi-stderr", ending.stderr]] as const) {
      if (value === undefined) rmSync(join(this.root, file), { force: true });
      else writeFileSync(join(this.root, file), `${value}\n`);
    }
  }

  smiRow(card: FakeCard): string {
    return `GPU-${card.uuid}, ${card.bus}, ${card.index}, ${card.freeMiB}, ${card.totalMiB}`;
  }

  smiKilled(killed: boolean): void {
    const file = join(this.root, "smi-killed");
    if (killed) writeFileSync(file, "");
    else rmSync(file, { force: true });
  }

  smiMode(mode: "normal" | "stall" | "silent"): void {
    writeFileSync(join(this.root, "smi-mode"), mode);
  }

  smiStartedAt(): number {
    return Number(readFileSync(join(this.root, "smi.started"), "utf8")) / 1e6;
  }

  smiStarts(): number {
    const file = join(this.root, "smi.starts");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  }

  smiFails(fails: boolean): void {
    const file = join(this.root, "smi-fails");
    if (fails) writeFileSync(file, "");
    else rmSync(file, { force: true });
  }

  #writePools(): void {
    const byPool = new Map<string, number[]>();
    for (const [vmid, pool] of this.pools) byPool.set(pool, [...(byPool.get(pool) ?? []), vmid]);
    if (!byPool.has(POOL)) byPool.set(POOL, []);
    const lines = ["user:root@pam:1:0:::root@localhost:::", ...[...byPool].map(([pool, vmids]) => `pool:${pool}:BB Box boxes:${vmids.sort((a, b) => a - b).join(",")}::`)];
    writeFileSync(join(this.root, "etc/pve/user.cfg"), `${lines.join("\n")}\n`);
  }

  configPath(vmid: number): string {
    return join(this.root, "etc/pve/nodes/pve/lxc", `${vmid}.conf`);
  }

  guest(vmid: number, spec: GuestSpec = {}): void {
    writeFileSync(this.configPath(vmid), this.#configText(vmid, spec));
    this.setRunning(vmid, spec.running ?? false);
    if (spec.pool === null) this.pools.delete(vmid);
    else this.pools.set(vmid, spec.pool ?? POOL);
    this.#writePools();
  }

  replacementOnUnlock(vmid: number, spec: GuestSpec): void {
    writeFileSync(`${this.configPath(vmid)}.next`, this.#configText(vmid, spec));
  }

  ask(vmid: number, request: string | null): void {
    const text = this.text(vmid);
    const tags = (/^tags: (.*)$/m.exec(text)?.[1] ?? "").split(";").filter((tag) => tag && !tag.startsWith("bb-power."));
    const all = [...tags, ...(request ? [request] : [])].join(";");
    writeFileSync(this.configPath(vmid), /^tags: .*$/m.test(text) ? text.replace(/^tags: .*$/m, `tags: ${all}`) : text.replace(/^(unprivileged: .*)$/m, `$1\ntags: ${all}`));
  }

  #configText(vmid: number, spec: GuestSpec): string {
    const labels = spec.box ? boxLabels(spec.box, spec.name ?? `box-${vmid}`, spec.kind, spec.install) : null;
    const markers = spec.marker === undefined ? [] : typeof spec.marker === "string" ? [spec.marker] : [...spec.marker];
    const tags = [...(spec.tags ?? labels?.tags ?? []), ...markers];
    const keys: Record<string, string> = {
      arch: "amd64",
      cores: "2",
      hostname: spec.hostname ?? spec.name ?? `box-${vmid}`,
      memory: "2048",
      net0: "name=eth0,bridge=vmbr200,hwaddr=BC:24:11:00:00:01,ip=dhcp,type=veth",
      ostype: "ubuntu",
      rootfs: `local-lvm:vm-${vmid}-disk-0,size=16G`,
      ...(spec.unprivileged === false ? {} : { unprivileged: "1" }),
      ...(spec.template ? { template: "1" } : {}),
      ...(spec.lock ? { lock: spec.lock } : {}),
      ...(tags.length ? { tags: tags.join(";") } : {}),
      ...spec.keys,
    };
    (spec.lines ?? []).forEach((line, index) => (keys[`dev${index}`] = line));
    let text = sectionText(keys, spec.description ?? labels?.description, spec.lxc);
    if (spec.pending) text += `\n[pve:pending]\n${sectionText(spec.pending)}`;
    for (const [name, snapshot] of Object.entries(spec.snapshots ?? {})) text += `\n[${name}]\n${sectionText(snapshot)}`;
    return text;
  }

  remove(vmid: number): void {
    rmSync(this.configPath(vmid), { force: true });
    this.setRunning(vmid, false);
    this.pools.delete(vmid);
    this.#writePools();
  }

  isRunning(vmid: number): boolean {
    return existsSync(join(this.root, "run/fake-pve/running", String(vmid)));
  }

  exists(vmid: number): boolean {
    return existsSync(this.configPath(vmid));
  }

  powerLog(): string[] {
    const log = join(this.root, "run/fake-pve/power.log");
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  }

  setRunning(vmid: number, running: boolean): void {
    const file = join(this.root, "run/fake-pve/running", String(vmid));
    if (running) writeFileSync(file, "");
    else rmSync(file, { force: true });
  }

  mark(vmid: number, ...markers: string[]): void {
    const text = this.text(vmid);
    const tags = (/^tags: (.*)$/m.exec(text)?.[1] ?? "").split(";").filter((tag) => tag && !tag.toLowerCase().startsWith("gpu."));
    const all = [...tags, ...markers].join(";");
    const next = /^tags: .*$/m.test(text) ? text.replace(/^tags: .*$/m, `tags: ${all}`) : text.replace(/^(unprivileged: .*)$/m, `$1\ntags: ${all}`);
    writeFileSync(this.configPath(vmid), next);
  }

  text(vmid: number): string {
    return readFileSync(this.configPath(vmid), "utf8");
  }

  config(vmid: number): ParsedConfig {
    return parseConfig(this.text(vmid));
  }

  lines(vmid: number): string[] {
    return Object.entries(gpuLines(this.config(vmid).keys))
      .sort(([a], [b]) => Number(a.slice(3)) - Number(b.slice(3)))
      .map(([, value]) => value);
  }

  writes(): string[] {
    const log = join(this.root, "run/fake-pve/writes.log");
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  }

  locks(): string[] {
    const log = join(this.root, "run/fake-pve/locks.log");
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  }

  guestLocks(): string[] {
    return this.locks().filter((lock) => lock.startsWith("lxc "));
  }

  guestWrites(): string[] {
    return this.writes().filter((write) => write.startsWith("lxc "));
  }

  report(): string {
    return parseConfig(readFileSync(join(this.root, "etc/pve/nodes/pve/qemu-server", `${REPORT_VMID}.conf`), "utf8")).description.replace(/\n$/, "");
  }

  reportLines(): string[] {
    return this.report().split("\n").slice(2).map((line) => line.trim());
  }

  ledgerPath(): string {
    return join(this.root, "var/lib/bb-box-gpu/ledger");
  }

  ledger(): { protocol: number; guests: Record<string, { box?: string | null; answered?: number; claim?: { generation: number; part: string; card: string | null; answer: string }; strip?: { why: string }; proposed_strip?: { why: string } }>; unsettled?: Record<string, { generation: number }>; answers: { vmid: number; generation: number; answer: string; reason?: string }[] } {
    return JSON.parse(readFileSync(this.ledgerPath(), "utf8"));
  }

  #env(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
    return { PATH: `${join(this.root, "bin")}:/usr/bin:/bin`, PERL5LIB: FAKE_PVE, BBBOX_GPU_ROOT: this.root, ...extra };
  }

  runHelperAs(version: string): void {
    this.#helper = helperAs(version, join(this.root, "bb-box-gpu-as-released"));
  }

  run(args: readonly string[] = ["--once"], env: Readonly<Record<string, string>> = {}): Run {
    const result: SpawnSyncReturns<string> = spawnSync("perl", [this.#helper, ...args], { encoding: "utf8", env: this.#env(env), timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  start(args: readonly string[] = [], env: Readonly<Record<string, string>> = {}): ChildProcess & { output: () => string } {
    const child = spawn("perl", [this.#helper, ...args], { env: this.#env(env), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    return Object.assign(child, { output: () => output });
  }

  holdLock(vmid: number, seconds: number, then?: "start" | "replace"): ChildProcess & { locked: Promise<void> } {
    const child = spawn("perl", [HOLD_LOCK, String(vmid), String(seconds), then ?? ""], { env: this.#env(), stdio: ["ignore", "pipe", "inherit"] });
    const locked = new Promise<void>((resolve) => child.stdout!.on("data", () => resolve()));
    return Object.assign(child, { locked });
  }

  file(path: string): string {
    return join(this.root, path);
  }

  write(path: string, text: string): void {
    mkdirSync(dirname(join(this.root, path)), { recursive: true });
    writeFileSync(join(this.root, path), text);
  }
}

export function helperVersion(): string {
  return /^use constant VERSION => '([^']+)';$/m.exec(readFileSync(HELPER, "utf8"))![1]!;
}

function helperAs(version: string, path: string): string {
  writeFileSync(path, readFileSync(HELPER, "utf8").replace(/^use constant VERSION => '[^']+';$/m, `use constant VERSION => '${version}';`));
  return path;
}

export function helperConstant(name: string): number {
  const value = new RegExp(`^use constant ${name} => (\\d+);$`, "m").exec(readFileSync(HELPER, "utf8"))?.[1];
  if (value === undefined) throw new Error(`bb-box-gpu has no constant ${name}`);
  return Number(value);
}

export function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", (code) => resolve(code))));
}
