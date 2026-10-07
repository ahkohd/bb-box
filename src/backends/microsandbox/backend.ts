// The microsandbox backend (053): Linux boxes as libkrun microVMs, run by
// bb-box's msb on one Linux host with KVM: BB's server, one over ssh://, or
// a BB machine through bb-box's msb relay (cli.ts). Commands, file copies
// and the desktop's stream all go through `msb exec` (transport.ts), so
// bb-box needs no network path to a box, as for Docker (031).
//
// - msb: bb-box installs the release it pins, checked by SHA-256, in a
//   folder of its own on the host, the first time it needs it (release.ts).
// - Images: bb-box never pulls one. It imports each kind's image from
//   Docker on the host, where setup/docker/build.sh builds it, with
//   `docker save` and `msb load`, and again when Docker's image changes.
// - Acquire: the box's microVM is named bbbox-<box ID>, so it is claimed
//   before anything is made. It is made with its owner in its labels, at
//   its size, with /run a tmpfs, Docker's data on an ext4 disk of its own,
//   and the network profiles that reach BB's server. Neither `msb create`
//   nor `msb start` runs the image's command, setup/docker/start, so the
//   backend starts it through `msb exec` at each boot, and waits for the
//   /run/bb-box/ready it writes.
// - Capacity: the host's memory, less a reserve and the memory of the
//   running bb-box microVMs; its cores; and a most-boxes setting, counting
//   every install's. msb reserves no memory, so this is what the boxes may
//   take, not what they hold.
// - Every call that acts on a microVM inspects it first and acts only on one
//   whose labels name this install and the box (018).

import type { CheckId } from "../../core/checks.ts";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { MIN_DESKTOP, type Display } from "../../transports/types.ts";
import {
  type Arch,
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxOwner,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
  type DoctorCheck,
  type DoctorReport,
  type GuestOs,
  type Guest,
  type HeldGuest,
  type HostCapacity,
  type Limit,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { sizesCheck } from "../fit.ts";
import { CUA_DRIVER } from "../docker/backend.ts";
import { judgeImage, recordFromJson } from "../images.ts";
import { SELKIES_DISPLAY, selkiesDisplay } from "../selkies.ts";
import { MsbCli, MsbError, NOT_FOUND, type MsbCliOptions, type SandboxInfo } from "./cli.ts";
import { MSB_KINDS, type MsbConfig, type MsbKind } from "./config.ts";
import { MSB_VERSION, scriptValues } from "./release.ts";
import { BOX_USER, MsbTransport } from "./transport.ts";

/** A box is ready in under a second, a desktop in about one; an import of its image can come first. */
const READY_TIMEOUT_MS = 60_000;
const READY_FILE = "/run/bb-box/ready";
/** The image's command, which neither `msb create` nor `msb start` runs. */
const START = "/usr/local/sbin/bb-box-start";
/** On /run, a tmpfs: the image's command was started at this boot. */
const STARTED = "/run/bb-box-started";
/**
 * The guest reports free memory to msb in blocks of 2^order pages, 2 MiB
 * by default, and msb gives the host those blocks back. A busy guest's
 * free memory is in smaller pieces, so at 0 the host gets more of it.
 */
const REPORTING_ORDER = "/sys/module/page_reporting/parameters/page_reporting_order";
/**
 * Run as root in an idle box, one whose load is under half its cores, by
 * the upkeep: a guest keeps its page cache in its own RAM, which the host
 * cannot share or take back, and enrolment fills it. An idle box with more
 * than 256 MiB cached drops it and compacts its memory, so its free pages
 * go back to the host (053).
 */
export const RECLAIM = String.raw`read busy _ </proc/loadavg
awk -v busy="$busy" -v cores="$(nproc)" 'BEGIN { exit !(busy + 0 < cores / 2) }' || exit 0
cached=$(awk '/^Cached:/ { print $2 }' /proc/meminfo)
[ "$cached" -ge 262144 ] || exit 0
sync; echo 3 >/proc/sys/vm/drop_caches; echo 1 >/proc/sys/vm/compact_memory 2>/dev/null
echo "reclaimed_kib=$cached"`;
const VNC_PORT = 5900;
const VNC_PASSWORD_FILE = "/var/lib/bb-box/vnc-password";
const MiB_PER_GiB = 1024;
/** A Docker disk this old with no microVM of its name is a leftover, which the upkeep removes. */
const ORPHAN_DISK_S = 15 * 60;
/**
 * The builder microVM's image: Docker's own, with dockerd, pinned by its
 * multi-architecture index's digest, the only image bb-box pulls.
 */
export const BUILDER_IMAGE = "docker:29.1.3-dind@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5";
/** How long a build may take, and the disk it needs free first, so the host keeps 60 GiB. */
const BUILD_MS = 90 * 60_000;
const BUILD_FREE_GIB = 80;

/**
 * bb-box's setup/ folder: beside src/ in the repository; the plugin's
 * bundle, dist/server.js, has the plugin's files one up.
 */
function setupDir(): string {
  const here = fileURLToPath(new URL("../../../setup/", import.meta.url));
  return existsSync(join(here, "docker", "build.sh")) ? here : fileURLToPath(new URL("../setup/", import.meta.url));
}

/** `setup` as a gzipped tar of one folder, setup/, for a builder. */
function setupArchive(setup: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", "-", "-C", dirname(setup.replace(/\/+$/, "")), basename(setup.replace(/\/+$/, ""))], { stdio: ["ignore", "pipe", "pipe"] });
    const parts: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => parts.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(`tar of ${setup} failed: ${stderr.trim()}`))));
  });
}

/** The storage key of the host's architecture, so a restart offers its kinds before the host answers. */
const ARCH_KEY = "host-arch";
/** How long the host's facts from the status script serve capacity checks. */
const FACTS_MS = 60_000;

const MSB_COMMAND: CommandCapability = { transport: "msb", shell: "sh", admin: true, inDesktopSession: false, streaming: true };

/** The bb-box labels on a box's microVM, from its creation. */
export const LABELS = {
  backend: "bbbox.backend",
  install: "bbbox.install",
  box: "bbbox.box",
  thread: "bbbox.thread",
  name: "bbbox.name",
  kind: "bbbox.kind",
  created: "bbbox.created",
  /** On a builder microVM (#build): the install's ID. */
  builder: "bbbox.builder",
  /** On an image setup/docker/build.sh made: its record, as JSON (049). */
  imageRecord: "bbbox.image-record",
} as const;

export interface MsbBackendOptions extends MsbCliOptions {
  /** bb-box's setup/ folder, which a builder microVM builds images from; the plugin's own by default. */
  readonly setup?: string;
  /** The longest an acquire may take, instead of the kind's. */
  readonly readyTimeoutMs?: number;
}

/** What the status script says of the host. */
export interface HostFacts {
  readonly installed: string | null;
  readonly os: string;
  readonly arch: string;
  readonly kernel: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  /** ok, missing or denied. */
  readonly kvm: string;
  readonly lxc: boolean;
  readonly reflink: boolean;
  readonly freeGiB: number;
  readonly usedGiB: number;
  /** Docker's version on the host, or null without Docker. */
  readonly docker: string | null;
  /** Whether the host has mkfs.ext4, with which bb-box makes each box's Docker disk. */
  readonly mkfs: boolean;
  readonly dir: string;
}

export function parseFacts(stdout: string): HostFacts {
  const values = scriptValues(stdout);
  const kib = (key: string) => Number(values[key]) || 0;
  return {
    installed: values.installed || null,
    os: values.os ?? "",
    arch: values.arch ?? "",
    kernel: values.kernel ?? "",
    cpus: Number(values.cpus) || 0,
    memoryMiB: Math.floor(kib("memory_kib") / 1024),
    kvm: values.kvm ?? "missing",
    lxc: values.lxc === "1",
    reflink: values.reflink === "1",
    freeGiB: Math.round((kib("free_kib") / 1024 ** 2) * 10) / 10,
    usedGiB: Math.round((kib("used_kib") / 1024 ** 2) * 10) / 10,
    docker: values.docker || null,
    mkfs: values.mkfs === "1",
    dir: values.dir ?? "",
  };
}

/** A microVM bb-box is making, counted against the host until msb lists it. */
interface Placing {
  readonly name: string;
  readonly memoryMiB: number;
}

interface HostState {
  readonly facts: HostFacts;
  /** Every bb-box microVM on the host, of every install, with its cores and memory. */
  readonly boxes: readonly { readonly name: string; readonly status: string; readonly cpus: number; readonly memoryMiB: number }[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMiB(value: number): string {
  return value >= MiB_PER_GiB ? `${Math.round((value / MiB_PER_GiB) * 10) / 10} GiB` : `${value} MiB`;
}

/** The microVM of a box. Box IDs are letters and digits; anything else becomes "-". */
export function sandboxName(boxId: string): string {
  return `bbbox-${boxId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

/** A box's name as a hostname, so the shell prompt and BB's machine name agree with it. */
export function hostnameOf(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return cleaned || "box";
}

function powerOf(status: string): PowerState {
  const word = status.toLowerCase();
  if (word === "running") return "running";
  if (word === "stopped" || word === "crashed" || word === "created" || word === "exited") return "stopped";
  return "unknown";
}

function sizeOf(sandbox: SandboxInfo): BoxSize | null {
  if (!sandbox.cpus || !sandbox.memoryMiB) return null;
  return { cores: sandbox.cpus, memoryMiB: sandbox.memoryMiB, diskGiB: sandbox.diskGiB };
}

function dataOf(sandbox: SandboxInfo): Record<string, string> {
  const box = sandbox.labels[LABELS.box];
  return box ? { box } : {};
}

function ownerOf(labels: Readonly<Record<string, string>>): BoxOwner | null {
  const boxId = labels[LABELS.box];
  const threadId = labels[LABELS.thread];
  if (!boxId || !threadId) return null;
  const created = Number(labels[LABELS.created]);
  return {
    boxId,
    threadId,
    name: labels[LABELS.name] || null,
    kind: labels[LABELS.kind] || null,
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
  };
}

/** The architecture of a host, as `uname -m` says it. */
export function archOf(machine: string): Arch | null {
  if (machine === "x86_64" || machine === "amd64") return "x86_64";
  if (machine === "arm64" || machine === "aarch64") return "arm64";
  return null;
}

/**
 * The kinds a config offers on a host of `arch`: those with an image, of
 * that architecture (040). A box has Docker when the setting is on (041).
 */
export function msbKinds(config: MsbConfig, arch: Arch = "x86_64"): BoxKind[] {
  const docker = config.docker ? ["docker"] : [];
  const kinds: Record<MsbKind, BoxKind> = {
    linux: {
      id: "linux",
      label: "Linux",
      description: "A Linux microVM for builds, backend services and the agent's own work.",
      requires: [],
      capabilities: { os: "linux", arch: "x86_64", gpu: false, features: docker, command: MSB_COMMAND, displays: [], computerUse: null, enrol: true },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-desktop-cpu": {
      id: "linux-desktop-cpu",
      label: "Linux desktop",
      description:
        "A Linux desktop drawn by the CPU, for computer use and browsers when no GPU is needed or free. Graphics are slower; WebGL and Vulkan still work.",
      requires: [],
      capabilities: {
        os: "linux",
        arch: "x86_64",
        gpu: false,
        features: docker,
        command: MSB_COMMAND,
        // Xtigervnc takes a viewer's SetDesktopSize, as in a Docker box.
        displays: [{ id: "desktop", protocol: "rfb", resizable: true }, SELKIES_DISPLAY],
        computerUse: CUA_DRIVER,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-arm64": {
      id: "linux-arm64",
      label: "Linux on arm64",
      description: "A Linux microVM on arm64, on a Mac with Apple silicon or another arm64 host. amd64 container images and x86_64 binaries do not run there.",
      requires: [],
      capabilities: { os: "linux", arch: "arm64", gpu: false, features: docker, command: MSB_COMMAND, displays: [], computerUse: null, enrol: true },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "linux-arm64-desktop-cpu": {
      id: "linux-arm64-desktop-cpu",
      label: "Linux desktop on arm64",
      description:
        "A Linux desktop microVM on arm64, drawn by the CPU, on a Mac with Apple silicon or another arm64 host, for computer use and browsers. amd64 container images and x86_64 binaries do not run there.",
      requires: [],
      capabilities: {
        os: "linux",
        arch: "arm64",
        gpu: false,
        features: docker,
        command: MSB_COMMAND,
        displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
        computerUse: CUA_DRIVER,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
  };
  return MSB_KINDS.filter((kind) => config.images[kind] && kinds[kind].capabilities.arch === arch).map((kind) => kinds[kind]);
}

/** The host for people: a BB machine's name, an ssh:// host, or BB's server. */
function hostWords(config: MsbConfig, context: BackendContext): string {
  if (config.machine) return context.machines?.name(config.machine) ?? `BB machine ${config.machine}`;
  if (config.host) return config.host.slice(6).replace(/^[^@]*@/, "");
  return "BB's server";
}

export class MsbBackend implements Backend {
  readonly id: string;
  readonly nature = "virtual" as const;
  readonly #config: MsbConfig;
  readonly #context: BackendContext;
  readonly #options: MsbBackendOptions;
  readonly #cli: MsbCli;
  /** The host's architecture, from its facts, kept in storage for the next start; null until known. */
  #arch: Arch | null = null;
  /** A build of an image in a builder microVM (#build), while one runs. */
  #building: { readonly image: string; readonly since: number; readonly work: Promise<void> } | null = null;
  /** The host's facts, as the status script last gave them, and when. */
  #facts: { at: number; facts: HostFacts } | null = null;
  /** msb installed at the pinned release, once checked or done this run. */
  #installed: Promise<void> | null = null;
  /** Imports under way, by image, so two acquires wait for one. */
  readonly #importing = new Map<string, Promise<void>>();
  readonly #placing = new Map<string, Placing>();
  #placement: Promise<unknown> = Promise.resolve();

  constructor(config: MsbConfig, context: BackendContext, options: MsbBackendOptions = {}) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#cli = new MsbCli(config.host, config.machine, context.machines, options);
    void context.storage.get<Arch>(ARCH_KEY).then((kept) => {
      if (kept && !this.#arch) this.#arch = kept;
    }, () => {});
  }

  /**
   * The host's architecture: as its facts last said, else as kept from the
   * last run, else a Mac's when BB says the machine is one, else this
   * process's for BB's server, else x86_64.
   */
  get #hostArch(): Arch {
    if (this.#arch) return this.#arch;
    if (this.#config.machine && this.#context.machines?.platform?.(this.#config.machine) === "macos") return "arm64";
    if (!this.#config.host) return process.arch === "arm64" ? "arm64" : "x86_64";
    return "x86_64";
  }

  get label(): string {
    return this.#config.host ? `microsandbox on ${this.#host}` : "microsandbox";
  }

  get hosts(): readonly string[] {
    return this.#config.host ? [this.#host] : [];
  }

  /** A BB machine's OS as BB has it; else the host's, from its facts; Linux until known. */
  get hostOs(): GuestOs | null {
    if (this.#config.machine) return this.#context.machines?.platform?.(this.#config.machine) ?? null;
    return this.#facts?.facts.os === "Darwin" ? "macos" : "linux";
  }

  get #host(): string {
    return hostWords(this.#config, this.#context);
  }

  kinds(): BoxKind[] {
    return msbKinds(this.#config, this.#hostArch);
  }

  #kind(id: string): BoxKind {
    const kind = this.kinds().find((candidate) => candidate.id === id);
    if (!kind) throw new BackendError("unsupported", `${this.label} does not offer ${id} boxes.`);
    return kind;
  }

  // The host's side: msb, its facts and its images.

  /** The host's facts, from the status script, at most FACTS_MS old unless `fresh`. */
  async #hostFacts(signal?: AbortSignal, fresh = false): Promise<HostFacts> {
    if (!fresh && this.#facts && Date.now() - this.#facts.at < FACTS_MS) return this.#facts.facts;
    const result = await this.#cli.script("status", [], signal);
    if (result.exitCode !== 0) throw this.#cli.error(`The status script on ${this.#host}`, result);
    const facts = parseFacts(result.stdout);
    this.#facts = { at: Date.now(), facts };
    const arch = archOf(facts.arch);
    if (arch && arch !== this.#arch) {
      this.#arch = arch;
      await this.#context.storage.set(ARCH_KEY, arch).catch(() => {});
    }
    return facts;
  }

  /** Installs the pinned msb on the host when it lacks it, once per run of bb-box. */
  #install(signal?: AbortSignal): Promise<void> {
    this.#installed ??= (async () => {
      const facts = await this.#hostFacts(signal);
      if (facts.installed === MSB_VERSION) return;
      const result = await this.#cli.script("install", [], signal);
      if (result.exitCode !== 0) throw this.#cli.error(`Installing msb ${MSB_VERSION} on ${this.#host}`, result);
      this.#facts = null;
    })();
    this.#installed.catch(() => (this.#installed = null));
    return this.#installed;
  }

  /** Storage key of the Docker image ID an msb image was imported from. */
  #importedKey(image: string): string {
    return `imported/${image}`;
  }

  /**
   * Imports `image` from Docker on the host when msb lacks it, or when
   * Docker's image is not the one imported (`refresh`), one import of an
   * image at a time.
   */
  #import(image: string, kind: MsbKind, refresh: boolean, signal?: AbortSignal): Promise<void> {
    const running = this.#importing.get(image);
    if (running) return running;
    const work = (async () => {
      await this.#install(signal);
      const present = (await this.#cli.imageLabels(image, signal)) !== null;
      if (present && !refresh) return;
      const ids = scriptValues((await this.#cli.script("images", [image], signal)).stdout);
      const docker = ids[`docker:${image}`] || null;
      const imported = await this.#context.storage.get<string>(this.#importedKey(image));
      if (present && (!docker || docker === imported)) return;
      if (!docker) {
        // No Docker on the host to import it from, as on a Mac: bb-box builds it there, in a microVM of its own.
        const building = this.#startBuild(image, kind);
        throw new BackendError(
          "no_capacity",
          `${this.#host} has no image ${image} yet. bb-box is building it there in a microVM, which takes about 10 minutes from when it started, ${Math.round((Date.now() - building.since) / 60_000)} min ago.`,
        );
      }
      const result = await this.#cli.script("import", [image], signal);
      if (result.exitCode !== 0) throw this.#cli.error(`Importing ${image} from Docker on ${this.#host}`, result);
      await this.#context.storage.set(this.#importedKey(image), scriptValues(result.stdout).imported || docker);
    })().finally(() => this.#importing.delete(image));
    this.#importing.set(image, work);
    return work;
  }

  /** Starts a build of `image` in a builder microVM, unless one runs; the one running, or this one. */
  #startBuild(image: string, kind: MsbKind): { readonly image: string; readonly since: number } {
    if (this.#building) return this.#building;
    const since = Date.now();
    const work = this.#build(image, kind)
      .catch((error) => this.#context.logError(`build ${image}`, error))
      .finally(() => {
        if (this.#building?.since === since) this.#building = null;
      });
    this.#building = { image, since, work };
    return this.#building;
  }

  /**
   * Builds `image` on the host, which has no Docker to import it from, as a
   * Mac: in a builder microVM from Docker's own image, pinned by digest, with
   * Docker inside on a disk of its own, from a copy of bb-box's setup/, with
   * setup/docker/build.sh for the host's architecture. Then moves it into msb
   * (`transfer`) and removes the builder. About 10 minutes on a Mac for both
   * images; it needs BUILD_FREE_GIB free.
   */
  async #build(image: string, kind: MsbKind): Promise<void> {
    const signal = AbortSignal.timeout(BUILD_MS);
    const facts = await this.#hostFacts(signal, true);
    if (facts.freeGiB < BUILD_FREE_GIB) {
      throw new Error(`${this.#host} has ${facts.freeGiB} GiB free, and bb-box builds an image there only with ${BUILD_FREE_GIB} GiB free, so the host keeps 60 GiB.`);
    }
    const name = `bb-box-builder-${randomBytes(4).toString("hex")}`;
    const exec = (script: string, options: { stdin?: string; timeoutMs?: number } = {}) =>
      this.#cli.ok(["exec", "--stream", name, "--", "/bin/sh", "-c", script], { timeoutMs: options.timeoutMs ?? 10 * 60_000, signal, stdin: options.stdin });
    try {
      await this.#cli.ok(
        [
          "create", BUILDER_IMAGE,
          "--name", name,
          "--quiet",
          "--label", `${LABELS.backend}=microsandbox`,
          "--label", `${LABELS.builder}=${this.#context.installId}`,
          "--cpus", String(Math.max(2, Math.min(8, facts.cpus))),
          "--memory", "8192M",
          "--root-disk", "64G",
          "--tmpfs", "/run",
          "--net", this.#config.network,
          "--mount-owned", "/var/lib/docker:kind=disk,size=96G",
        ],
        { timeoutMs: 10 * 60_000, signal },
      );
      await exec(
        // BusyBox's setsid has no -f; what nohup starts with its output redirected outlives msb exec.
        "apk add --no-cache bash coreutils curl jq >/dev/null && { nohup dockerd >/var/log/dockerd.log 2>&1 </dev/null & } && " +
          "i=0; until docker info >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 600 ] || { tail -5 /var/log/dockerd.log >&2; exit 3; }; sleep 0.1; done",
      );
      await exec("mkdir -p /build && base64 -d | tar -xz -C /build", { stdin: (await setupArchive(this.#options.setup ?? setupDir())).toString("base64") });
      const target = kind.includes("desktop") ? "desktop" : "linux";
      await exec(`cd /build && bash setup/docker/build.sh --arch ${archOf(facts.arch) ?? "x86_64"} --tag ${image} ${target} >/build/build.log 2>&1 || { tail -20 /build/build.log >&2; exit 1; }`, { timeoutMs: BUILD_MS });
      const moved = await this.#cli.script("transfer", [name, image], signal);
      if (moved.exitCode !== 0) throw this.#cli.error(`Moving ${image} from the builder into msb on ${this.#host}`, moved);
      await this.#context.storage.set(this.#importedKey(image), `built:${Date.now()}`);
    } finally {
      await this.#cli.run(["remove", "--force", "--quiet", name], { timeoutMs: 120_000 }).catch(() => undefined);
    }
  }

  /** Removes builder microVMs of this install that no build is using, as after a restart in the middle of one. */
  async #sweepBuilders(signal?: AbortSignal): Promise<void> {
    if (this.#building) return;
    for (const builder of await this.#cli.list({ [LABELS.builder]: this.#context.installId }, signal)) {
      await this.#cli.run(["remove", "--force", "--quiet", builder.name], { timeoutMs: 120_000, signal });
    }
  }

  /** Installs msb and imports each kind's image anew when Docker's has changed. */
  async maintain(signal?: AbortSignal): Promise<void> {
    if (this.#config.machine && (await this.#context.machines?.connected(this.#config.machine)) !== true) return;
    await this.#install(signal);
    // The images of the kinds this host offers, by its architecture.
    const seen = new Set<string>();
    for (const kind of this.kinds()) {
      const image = this.#config.images[kind.id as MsbKind];
      if (!image || seen.has(image)) continue;
      seen.add(image);
      await this.#import(image, kind.id as MsbKind, true, signal).catch((error) => {
        if (!(error instanceof BackendError)) this.#context.logError(`import ${image}`, error);
      });
    }
    await this.#sweepBuilders(signal).catch((error) => this.#context.logError("remove leftover builders", error));
    await this.#sweepDisks(signal).catch((error) => this.#context.logError("remove leftover Docker disks", error));
    await this.#reclaim(signal).catch((error) => this.#context.logError("reclaim idle boxes' memory", error));
  }

  /** Has each running, idle box of this install give its page cache back to the host (RECLAIM). Returns the KiB dropped. */
  async #reclaim(signal?: AbortSignal): Promise<number> {
    // A Mac's msb keeps what a guest has used, so dropping it gives nothing back there (053).
    if ((await this.#hostFacts(signal)).os === "Darwin") return 0;
    const running = (await this.#cli.list({ [LABELS.backend]: "microsandbox", [LABELS.install]: this.#context.installId }, signal)).filter((box) => powerOf(box.status) === "running");
    let dropped = 0;
    for (let at = 0; at < running.length; at += 4) {
      const results = await Promise.all(
        running.slice(at, at + 4).map((box) => this.#cli.run(["exec", box.name, "--", "/bin/sh", "-c", RECLAIM], { timeoutMs: 60_000, signal }).catch(() => null)),
      );
      for (const result of results) dropped += Number(scriptValues(result?.stdout ?? "").reclaimed_kib) || 0;
    }
    return dropped;
  }

  /**
   * Removes the Docker disks that no microVM has, of any install, left by an
   * acquire that stopped part way: only those older than ORPHAN_DISK_S, so
   * an acquire making its box now keeps its own.
   */
  async #sweepDisks(signal?: AbortSignal): Promise<void> {
    const disks = scriptValues((await this.#cli.script("disks", [], signal)).stdout);
    const old = Object.entries(disks).filter(([, age]) => Number(age) > ORPHAN_DISK_S).map(([name]) => name);
    if (!old.length) return;
    const boxes = new Set((await this.#cli.list({}, signal)).map((sandbox) => sandbox.name));
    const gone = old.filter((name) => !boxes.has(name));
    for (let at = 0; at < gone.length; at += 4) await this.#cli.script("undisk", gone.slice(at, at + 4), signal);
  }

  /**
   * The box's Docker disk: one bb-box makes, ext4 left for the kernel to
   * initialise, which takes milliseconds, where msb's own disk for a box
   * formats it whole, about 1 s of each create with 20 at once. Without
   * mkfs.ext4 on the host, msb's own.
   */
  async #dockerDisk(name: string, signal?: AbortSignal): Promise<string[]> {
    const disk = `/var/lib/docker:kind=disk,size=${this.#config.dockerDiskGiB}G`;
    if (!(await this.#hostFacts(signal)).mkfs) return ["--mount-owned", disk];
    const result = await this.#cli.script("disk", [name, String(this.#config.dockerDiskGiB)], signal);
    const file = scriptValues(result.stdout).disk;
    if (result.exitCode !== 0 || !file) throw this.#cli.error(`Making ${name}'s Docker disk on ${this.#host}`, result);
    return ["--mount-disk", `${file}:/var/lib/docker`];
  }

  // Capacity and placement.

  async #state(signal?: AbortSignal): Promise<HostState> {
    await this.#install(signal);
    const [facts, all] = await Promise.all([this.#hostFacts(signal), this.#cli.status(signal)]);
    return { facts, boxes: all.filter((box) => box.name.startsWith("bbbox-")) };
  }

  async capacity(kind: string, size: BoxSize, pending: readonly { readonly kind: string; readonly size: BoxSize }[], signal?: AbortSignal): Promise<Capacity> {
    this.#kind(kind);
    const machine = this.#config.machine;
    if (machine && (await this.#context.machines?.connected(machine)) !== true) {
      return { ok: false, message: `${this.#host} is offline in BB.`, warm: null, hosts: [{ host: this.#host, ok: false, limits: [] }] };
    }
    let state: HostState;
    try {
      state = await this.#state(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, message: `${this.#host} did not answer: ${message(error)}`, warm: null, hosts: [{ host: this.#host, ok: false, limits: [] }] };
    }
    const placed = [...this.#placing.values()];
    const unplaced = {
      count: Math.max(0, pending.length - placed.length),
      memoryMiB: Math.max(0, pending.reduce((sum, other) => sum + other.size.memoryMiB, 0) - placed.reduce((sum, other) => sum + other.memoryMiB, 0)),
    };
    const room = this.#room(state, size, unplaced);
    return { ok: room.why === null, message: room.why === null ? null : this.#full(kind, room.why), warm: null, hosts: [room.capacity] };
  }

  #room(state: HostState, size: BoxSize, unplaced = { count: 0, memoryMiB: 0 }): { capacity: HostCapacity; why: string | null } {
    const { facts, boxes } = state;
    const host = this.#host;
    const listed = new Set(boxes.map((box) => box.name));
    const running = boxes.filter((box) => powerOf(box.status) === "running");
    const holding = new Set(running.map((box) => box.name));
    const placing = [...this.#placing.values()];
    const guests = boxes.length + placing.filter((other) => !listed.has(other.name)).length + unplaced.count;
    const memoryUsed =
      running.reduce((sum, box) => sum + box.memoryMiB, 0) + placing.filter((other) => !holding.has(other.name)).reduce((sum, other) => sum + other.memoryMiB, 0) + unplaced.memoryMiB;
    const memoryFree = facts.memoryMiB - memoryUsed;
    const reserve = this.#config.reserveMemoryMiB;
    const limits: Limit[] = [
      { resource: "guests", used: guests, total: this.#config.boxes, reserve: 0, unit: "count" },
      { resource: "memory", used: memoryUsed, total: facts.memoryMiB, reserve, unit: "MiB" },
    ];
    let why: string | null = null;
    if (facts.cpus && size.cores > facts.cpus) {
      why = `${host} has ${facts.cpus} cores, fewer than the ${size.cores} asked for. Ask for at most ${facts.cpus} cores`;
    } else if (guests >= this.#config.boxes) {
      why = `${host} has ${guests} of the ${this.#config.boxes} bb-box microVMs it may have, counting stopped boxes and other installs' boxes. Release a box, or raise the most boxes in bb-box's settings`;
    } else if (memoryFree - size.memoryMiB < reserve) {
      const box = `a box with ${formatMiB(size.memoryMiB)}`;
      why =
        size.memoryMiB > memoryFree
          ? `${host} has ${formatMiB(Math.max(0, memoryFree))} of memory free, less than ${box} needs. Ask for less memory or release a box`
          : `${host} has ${formatMiB(memoryFree)} of memory free and keeps ${formatMiB(reserve)} free, so ${box} does not fit. ` +
            (memoryFree > reserve ? "Ask for less memory, release a box, or lower the memory kept free in bb-box's settings" : "Release a box, or lower the memory kept free in bb-box's settings");
    } else if (size.diskGiB !== null && size.diskGiB > facts.freeGiB) {
      why = `${host} has ${facts.freeGiB} GiB free, less than the ${size.diskGiB} GiB disk asked for. Ask for a smaller disk`;
    }
    return { capacity: { host, ok: why === null, limits }, why };
  }

  #full(kind: string, why: string): string {
    return `${this.label} cannot take this ${kind} box: ${why}.`;
  }

  #place(box: BoxIdentity, signal: AbortSignal): Promise<void> {
    const placed = this.#placement.then(async () => {
      const room = this.#room(await this.#state(signal), box.size);
      if (room.why !== null) throw new BackendError("no_capacity", this.#full(box.kind, room.why));
      this.#placing.set(box.boxId, { name: sandboxName(box.boxId), memoryMiB: box.size.memoryMiB });
    });
    this.#placement = placed.catch(() => undefined);
    return placed;
  }

  // A box's life.

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#kind(box.kind);
    const image = this.#config.images[box.kind as MsbKind]!;
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? kind.readyTimeoutMs);
    const name = sandboxName(box.boxId);
    const step = async <T>(stepName: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        hooks.timing(stepName, Math.round(performance.now() - started));
      }
    };
    if (previous?.ref === name) this.#placing.set(box.boxId, { name, memoryMiB: box.size.memoryMiB });
    else await step("place", () => this.#place(box, signal));
    const guest = (size: BoxSize | null = null): Guest => ({ ref: name, host: this.#host, address: null, size, data: { box: box.boxId } });
    try {
      await hooks.claim(guest());
      await step("image", () => this.#import(image, box.kind as MsbKind, false, signal));
      await step("create", () => this.#create(box, image, signal));
      await hooks.starting();
      await step("ready", () => this.#ready(name, deadline, signal));
      const made = await this.#cli.inspect(name, signal);
      if (!made) throw new Error(`The microVM ${name} went from ${this.#host} as it started.`);
      const ready = guest(sizeOf(made));
      await hooks.claim(ready);
      return ready;
    } catch (error) {
      await this.#remove(name, box.boxId).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      // The box's own disk, which bb-box may have made before msb made the box.
      await this.#cli.script("undisk", [name]).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      throw error;
    } finally {
      this.#placing.delete(box.boxId);
    }
  }

  /**
   * Makes and boots the box's microVM, labelled with its owner. When one of
   * that name is there already, it goes on with it if it is this box's, as
   * after a restart, and fails if not. A record a failed create left, which
   * msb lists nowhere, is replaced (053).
   */
  async #create(box: BoxIdentity, image: string, signal: AbortSignal): Promise<void> {
    const name = sandboxName(box.boxId);
    const labels: Record<string, string> = {
      [LABELS.backend]: "microsandbox",
      [LABELS.install]: this.#context.installId,
      [LABELS.box]: box.boxId,
      [LABELS.thread]: box.threadId,
      [LABELS.name]: box.name,
      [LABELS.kind]: box.kind,
      [LABELS.created]: String(box.createdAt),
    };
    // Docker's data on an ext4 disk of the box's own, as overlayfs cannot sit on msb's root (053).
    const docker = this.#config.docker ? [...(await this.#dockerDisk(name, signal)), "--env", "BBBOX_DOCKERD=1"] : [];
    const args = (replace: boolean) => [
      "create", image,
      "--name", name,
      "--pull", "never",
      "--quiet",
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--hostname", hostnameOf(box.name),
      "--cpus", String(box.size.cores),
      "--memory", `${box.size.memoryMiB}M`,
      "--root-disk", `${box.size.diskGiB ?? this.#config.diskGiB}G`,
      "--tmpfs", "/run",
      "--net", this.#config.network,
      ...docker,
      ...(replace ? ["--replace"] : []),
    ];
    const result = await this.#cli.run(args(false), { timeoutMs: 120_000, signal });
    if (result.exitCode === 0) return this.#launch(name, signal);
    if (/already exists/i.test(result.stderr)) {
      const found = await this.#cli.inspect(name, signal);
      if (found) {
        if (!this.#ours(found, box.boxId)) throw new Error(`The microVM ${name} on ${this.#host} belongs to another box, so bb-box left it alone.`);
        if (powerOf(found.status) !== "running") return this.#boot(name, signal);
        return this.#launch(name, signal);
      }
      const again = await this.#cli.run(args(true), { timeoutMs: 120_000, signal });
      if (again.exitCode === 0) return this.#launch(name, signal);
      throw this.#cli.error("msb create", again);
    }
    throw this.#cli.error("msb create", result);
  }

  /** Starts a stopped microVM, then its image's command. */
  async #boot(name: string, signal?: AbortSignal): Promise<void> {
    await this.#cli.ok(["start", "--quiet", name], { timeoutMs: 120_000, signal });
    await this.#launch(name, signal);
  }

  /** Starts the image's command as root, detached, once per boot: neither `msb create` nor `msb start` runs it (053). */
  async #launch(name: string, signal?: AbortSignal): Promise<void> {
    const script = `echo 0 >${REPORTING_ORDER} 2>/dev/null; [ -e ${STARTED} ] || { : >${STARTED}; setsid -f ${START} >/run/bb-box-start.log 2>&1 </dev/null; }`;
    await this.#cli.ok(["exec", name, "--", "/bin/sh", "-c", script], { timeoutMs: 30_000, signal });
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    await this.#remove(guest.ref, this.#boxOf(guest), signal);
    hooks.timing("delete", Math.round(performance.now() - started));
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    let found: SandboxInfo | null;
    try {
      found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return "unknown";
    }
    return found ? powerOf(found.status) : null;
  }

  async start(guest: Guest, signal?: AbortSignal, timing?: (step: string, ms: number) => void): Promise<void> {
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    if (!found) throw this.#gone(guest);
    let at = performance.now();
    const mark = (step: string) => {
      const now = performance.now();
      timing?.(step, Math.round(now - at));
      at = now;
    };
    if (powerOf(found.status) !== "running") await this.#boot(guest.ref, signal);
    else await this.#launch(guest.ref, signal);
    mark("boot");
    await this.#ready(guest.ref, deadline, signal);
    mark("ready");
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    if (!found) throw this.#gone(guest);
    if (powerOf(found.status) !== "running") return;
    const graceful = await this.#cli.run(["stop", "--quiet", "--timeout", "10", guest.ref], { timeoutMs: 60_000, signal });
    if (graceful.exitCode !== 0) await this.#cli.ok(["stop", "--quiet", "--force", guest.ref], { timeoutMs: 60_000, signal });
  }

  /** A box's new owner and name, as when a spare becomes yours (036), on its labels. The hostname inside stays. */
  async relabel(guest: Guest, box: BoxIdentity, _from: string, signal?: AbortSignal): Promise<void> {
    const found = await this.#owned(guest.ref, this.#boxOf(guest), signal);
    if (!found) return;
    await this.#cli.ok(["modify", guest.ref, "--label", `${LABELS.thread}=${box.threadId}`, "--label", `${LABELS.name}=${box.name}`], { timeoutMs: 30_000, signal });
  }

  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const listed = await this.#cli.list({ [LABELS.backend]: "microsandbox", [LABELS.install]: this.#context.installId }, signal);
    const found = await Promise.all(listed.map((entry) => this.#cli.inspect(entry.name, signal)));
    return found
      .filter((sandbox): sandbox is SandboxInfo => sandbox !== null && sandbox.labels[LABELS.install] === this.#context.installId)
      .map((sandbox) => ({
        ref: sandbox.name,
        host: this.#host,
        address: null,
        size: sizeOf(sandbox),
        data: dataOf(sandbox),
        owner: ownerOf(sandbox.labels),
        power: powerOf(sandbox.status),
      }));
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    await this.#cli.prepare();
    const command = new MsbTransport(this.#cli, guest.ref);
    const capabilities = this.kinds().find((candidate) => candidate.id === kind)?.capabilities;
    const displays = (capabilities?.displays ?? []).map(
      (display): Display =>
        display.protocol === "selkies"
          ? selkiesDisplay((port, signal) => command.route(port, signal))
          : {
              ...display,
              label: "Desktop",
              open: async (signal) => {
                const password = await this.#vncPassword(command, signal);
                return { route: await command.route(VNC_PORT, signal), auth: password ? { type: "vnc-password", password } : { type: "none" } };
              },
              minSize: MIN_DESKTOP,
            },
    );
    // No SSH server is reached in a box, so only BB's server reaches it, through msb exec.
    return { command, displays, access: null };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [`This install's ID is ${this.#context.installId}. Its microVMs carry the label ${LABELS.install}=${this.#context.installId}.`];
    const push = (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix: string | null = null) => checks.push({ id, name, status, detail, fix });
    const skip = (id: CheckId, name: string) => push(id, name, "skipped", "Skipped until the checks above pass.");
    const hostName = `Host ${this.#host}`;

    let facts: HostFacts | null = null;
    try {
      await this.#cli.prepare(signal);
      facts = await this.#hostFacts(signal, true);
    } catch (error) {
      if (signal?.aborted) throw error;
      const fix = this.#config.machine
        ? `Check that ${this.#host} is connected in BB.`
        : this.#config.host
          ? `Check that the user BB runs as logs in to ${this.#host} over SSH without a prompt.`
          : "Check that sh runs for the user BB runs as.";
      push("microsandbox.host", hostName, "fail", message(error), fix);
    }
    if (facts) {
      const about = `${facts.os} ${facts.arch}, kernel ${facts.kernel}, ${facts.cpus} cores, ${formatMiB(facts.memoryMiB)}, ${facts.freeGiB} GiB free`;
      const arch = archOf(facts.arch);
      if (facts.os !== "Linux" && facts.os !== "Darwin") push("microsandbox.host", hostName, "fail", `${about}. bb-box runs msb on Linux hosts and Macs.`, "Use a Linux host with KVM, or a Mac with Apple silicon.");
      else if (!arch || (facts.os === "Darwin" && arch !== "arm64")) push("microsandbox.host", hostName, "fail", `${about}. msb runs on x86_64 and arm64 Linux hosts, and Macs with Apple silicon.`, "Use another host.");
      else push("microsandbox.host", hostName, "ok", `${about}. It offers the ${arch} kinds.`);

      if (facts.installed === MSB_VERSION) push("microsandbox.msb", "msb", "ok", `msb ${MSB_VERSION}, as bb-box pins it, in ${facts.dir}.`);
      else
        push(
          "microsandbox.msb",
          "msb",
          "warn",
          facts.installed ? `msb ${facts.installed} is in ${facts.dir}; this bb-box pins ${MSB_VERSION}.` : `msb is not installed in ${facts.dir} yet.`,
          `bb-box installs msb ${MSB_VERSION} there, checked by its SHA-256, with the next box or within a few minutes. It needs curl and tar on the host.`,
        );

      const kvmFix = `Let the user BB runs as on ${this.#host} use /dev/kvm: add it to the kvm group, then restart its services (sudo systemctl restart user@$(id -u).service) so BB's daemon has the group.`;
      if (facts.os === "Darwin") {
        if (facts.kvm === "ok") push("microsandbox.kvm", "Hypervisor", "ok", "The Mac's Hypervisor framework is there.");
        else push("microsandbox.kvm", "Hypervisor", "fail", `${this.#host} says the Hypervisor framework is not supported (kern.hv_support), so no box starts.`, "Use a Mac with Apple silicon, not a VM.");
      } else if (facts.kvm === "ok") push("microsandbox.kvm", "KVM", "ok", "/dev/kvm is there, and BB's user may use it.");
      else if (facts.kvm === "denied") push("microsandbox.kvm", "KVM", "fail", "/dev/kvm is there, but BB's user may not use it, so no box starts.", kvmFix);
      else push("microsandbox.kvm", "KVM", "fail", `${this.#host} has no /dev/kvm, so no box starts.`, "Use a Linux host with KVM: the machine itself, or a VM with nested virtualisation on.");

      if (this.#config.docker && !facts.mkfs) {
        push(
          "microsandbox.disks",
          "Docker disks",
          "warn",
          `${this.#host} has no mkfs.ext4, so msb formats each box's Docker disk whole, which makes boxes slower to start: about 1 s more each with 20 at once.`,
          "Install e2fsprogs on the host.",
        );
      }
      if (facts.lxc) {
        push(
          "microsandbox.lxc",
          "LXC",
          "warn",
          `${this.#host} is an LXC container. Its seccomp filter refuses FICLONE, so msb's snapshots and flat roots fail there (053). Boxes work.`,
          "Run msb on a VM or the machine itself, for spares from snapshots or forks later.",
        );
      }
      notes.push(
        `msb's state and images take ${facts.usedGiB} GiB in ${facts.dir}/home on ${this.#host}. ${facts.reflink ? "Its disk copies share blocks (reflinks)." : "Its file system has no reflinks, so msb copies a box's disk to fork or snapshot it."}`,
      );

      const docker = facts.docker;
      const [linuxPins, desktopPins, app] = await Promise.all([
        this.#context.images?.pins("linux") ?? null,
        this.#context.images?.pins("linux-desktop") ?? null,
        this.#context.images?.bbApp(signal) ?? null,
      ]).catch(() => [null, null, null] as const);
      const images = [...new Set(this.kinds().map((kind) => this.#config.images[kind.id as MsbKind]).filter((image): image is string => !!image))];
      const ids = images.length ? scriptValues((await this.#cli.script("images", images, signal).catch(() => ({ stdout: "" }))).stdout) : {};
      for (const image of images) {
        const serves = this.kinds().map((kind) => kind.id).filter((kind) => this.#config.images[kind as MsbKind] === image);
        const id = `image.${image}` as const;
        const name = `Image ${image}`;
        const labels = facts.installed ? await this.#cli.imageLabels(image, signal).catch(() => null) : null;
        const inDocker = ids[`docker:${image}`] || null;
        if (!labels) {
          if (inDocker) push(id, name, "warn", `msb on ${this.#host} has no ${image} yet. Docker there has it.`, `bb-box imports it from Docker with the first ${serves.join(" or ")} box, or within a few minutes.`);
          else if (this.#building?.image === image)
            push(id, name, "warn", `bb-box is building ${image} on ${this.#host} in a microVM, since ${Math.round((Date.now() - this.#building.since) / 60_000)} min ago.`, "Wait for it: about 10 minutes from the start.");
          else
            push(
              id,
              name,
              "warn",
              `${this.#host} has no image ${image}, in msb${docker ? " or in Docker" : ""}.`,
              `bb-box builds it there in a microVM of its own, about 10 minutes, with the first ${serves.join(" or ")} box or within a few minutes. It needs ${BUILD_FREE_GIB} GiB free. Or build it with Docker there with setup/docker/build.sh, and bb-box imports it.`,
            );
          continue;
        }
        const imported = await this.#context.storage.get<string>(this.#importedKey(image));
        const judged = judgeImage(recordFromJson(labels[LABELS.imageRecord]), { os: "linux", pins: serves.some((kind) => !kind.includes("desktop")) ? linuxPins : desktopPins, bbApp: app }, "Build it again on the host with setup/docker/build.sh, and bb-box imports it.");
        const behind = inDocker && imported && inDocker !== imported ? " Docker has a newer build, which bb-box imports within a few minutes." : "";
        push(id, name, judged.status, `For ${serves.join(", ")} boxes. ${judged.detail}${behind}`, judged.fix);
      }

      let state: HostState | null = null;
      try {
        state = facts.installed ? { facts, boxes: (await this.#cli.status(signal)).filter((box) => box.name.startsWith("bbbox-")) } : { facts, boxes: [] };
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      if (state) {
        const room = this.#room(state, this.#context.kind(this.kinds()[0]?.id ?? "linux").defaultSize);
        push(
          "microsandbox.capacity",
          `Room on ${this.#host}`,
          room.why === null ? "ok" : "warn",
          room.why ?? room.capacity.limits.map((limit) => `${limit.resource} ${limit.unit === "MiB" ? `${formatMiB(limit.used)} of ${formatMiB(limit.total ?? 0)}` : `${limit.used} of ${limit.total}`}`).join(", "),
          room.why === null ? null : "Release a box, or change the most boxes or the memory kept free in bb-box's settings.",
        );
      }
      const sizes = sizesCheck({
        id: "microsandbox.sizes",
        name: "Box sizes",
        host: this.#host,
        has: `${facts.cpus} cores and ${formatMiB(facts.memoryMiB)} memory`,
        keepsMiB: this.#config.reserveMemoryMiB,
        kinds: this.kinds().map((kind) => ({ kind: kind.id, settings: this.#context.kind(kind.id), largest: { cores: facts!.cpus || Infinity, memoryMiB: facts!.memoryMiB - this.#config.reserveMemoryMiB, diskGiB: null } })),
      });
      if (sizes) checks.push(sizes);
    } else {
      skip("microsandbox.msb", "msb");
      skip("microsandbox.kvm", "KVM");
      for (const image of new Set(this.kinds().map((kind) => this.#config.images[kind.id as MsbKind]).filter((image): image is string => !!image))) skip(`image.${image}`, `Image ${image}`);
    }

    const ok = checks.every((check) => check.status !== "fail");
    const first = checks.find((check) => check.status === "fail");
    return { ok, summary: ok ? `msb ${MSB_VERSION} on ${this.#host}` : `${first!.name}: ${first!.detail}`, checks, notes };
  }

  // Helpers.

  #boxOf(guest: Guest): string | null {
    return typeof guest.data?.box === "string" ? guest.data.box : null;
  }

  #gone(guest: Guest): BackendError {
    return new BackendError("gone", `The microVM ${guest.ref} no longer exists on ${guest.host ?? this.#host}.`);
  }

  #ours(sandbox: SandboxInfo, boxId: string | null): boolean {
    const labels = sandbox.labels;
    if (labels[LABELS.backend] !== "microsandbox" || labels[LABELS.install] !== this.#context.installId) return false;
    const box = labels[LABELS.box];
    return !!box && (boxId !== null ? box === boxId : sandboxName(box) === sandbox.name);
  }

  /** The microVM `ref` when its labels name this install and the box, or null. */
  async #owned(ref: string, boxId: string | null, signal?: AbortSignal): Promise<SandboxInfo | null> {
    const found = await this.#cli.inspect(ref, signal);
    return found && this.#ours(found, boxId) ? found : null;
  }

  /** Removes the box's microVM and its disks, if it is this install's and the box's. */
  async #remove(ref: string, boxId: string | null, signal?: AbortSignal): Promise<void> {
    const found = await this.#owned(ref, boxId, signal);
    if (!found) return;
    const result = await this.#cli.run(["remove", "--force", "--quiet", ref], { timeoutMs: 120_000, signal });
    if (result.exitCode !== 0 && !NOT_FOUND.test(result.stderr)) throw this.#cli.error("msb remove", result);
    const undisk = await this.#cli.script("undisk", [ref], signal);
    if (undisk.exitCode !== 0) throw this.#cli.error(`Removing ${ref}'s Docker disk`, undisk);
  }

  /** Waits for the image's command to say the box is up, in one `msb exec`. */
  async #ready(name: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const script = `i=0; while [ ! -e ${READY_FILE} ]; do i=$((i+1)); [ "$i" -le ${seconds * 10} ] || exit 3; sleep 0.1; done`;
    const result = await this.#cli.run(["exec", "--stream", "-u", BOX_USER, name, "--", "/bin/sh", "-c", script], { timeoutMs: (seconds + 30) * 1000, signal });
    if (result.exitCode === 0) return;
    if (signal?.aborted) throw signal.reason;
    const found = await this.#cli.inspect(name, signal).catch(() => null);
    if (found && powerOf(found.status) !== "running") throw new Error(`The microVM ${name} stopped as it started (${found.status}).`);
    if (result.exitCode !== 3) throw new MsbError(`msb exec could not wait for ${name}: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    throw new Error(`The microVM ${name} was not ready within ${seconds} s.`);
  }

  async #vncPassword(command: MsbTransport, signal?: AbortSignal): Promise<string | null> {
    const result = await command.run(`cat ${VNC_PASSWORD_FILE} 2>/dev/null || :`, { timeoutMs: 15_000, signal, maxOutputBytes: 1024 });
    if (result.exitCode !== 0) throw new Error(`Cannot read the desktop's VNC password through msb exec: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    return result.stdout.trim() || null;
  }
}
