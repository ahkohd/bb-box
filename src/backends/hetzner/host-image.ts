import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setupDir } from "../setup-dir.ts";
import type { DockerCli } from "../docker/cli.ts";
import { hashDockerSetup } from "../docker/setup-hash.ts";
import type { Hetzner, HetznerImage, Labels } from "./api.ts";
import type { BackendStorage } from "../types.ts";
import { hostSetupScript } from "./cloud-init.ts";
import { LABEL, type HetznerHosts, type HostRecord, type HostSpec } from "./hosts.ts";
import { timedSpawn } from "../../transports/spawns.ts";

export const HOST_IMAGE_ROLE = "host-image";
export const BUILD_LABEL = "bbbox-build";
export const SETUP_LABEL = "bbbox-setup";
export const APP_LABEL = "bbbox-app";
export const ARCH_LABEL = "bbbox-arch";

export type Architecture = "x86" | "arm";

export function isArchitecture(snapshotArch: string | undefined, architecture: Architecture): boolean {
  return (snapshotArch ?? "x86") === architecture;
}
export const KEPT_HOST_IMAGES = 2;
export const BUILD_ABANDONED_AFTER_MS = 3 * 3_600_000;
export const HOST_IMAGE_REBUILT_AFTER_MS = 7 * 24 * 3_600_000;
const DOCKER_ANSWERS_WITHIN_MS = 15 * 60_000;
const DOCKER_POLL_MS = 5_000;
const SHUTDOWN_WITHIN_MS = 3 * 60_000;
export const SNAPSHOT_WAIT_MS = 60 * 60_000;
export const SNAPSHOT_GIVEN_UP_AFTER_MS = 2 * 3_600_000;
export const SNAPSHOT_POLL_MS = 15_000;
const BUILD_POLL_MS = 10_000;
const BUILD_WITHIN_MS = 3 * 3_600_000;
const BUILD_UNANSWERED_POLLS = 30;
const STOPPING = /stale API handle|reloaded or disabled/i;

export class BuildGaveWayToBoxes extends Error {}

export interface RoomFromBuilds {
  readonly stopped: readonly HostRecord[];
  readonly snapshotting: readonly HostRecord[];
}

export function bbBoxIsStopping(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || STOPPING.test(error instanceof Error ? error.message : String(error));
}
const BUILD_DIR = "/var/lib/bb-box-build";

type BuildPhase = "building" | "prepared" | "snapshotting";

export interface SavedBuild {
  readonly architecture: Architecture;
  readonly fingerprint: string;
  readonly appSha256: string | null;
  readonly phase: BuildPhase;
  readonly imageId: number | null;
}

export interface BuildPlan {
  readonly images: readonly { readonly image: string; readonly target: string }[];
  readonly architecture: Architecture;
  readonly bbUrl: string | null;
}

export interface BuildProgress {
  readonly exitCode: number | null;
  readonly log: string;
  readonly nextByte: number;
}

export interface RemoteBuild {
  start(record: HostRecord, plan: BuildPlan, signal: AbortSignal): Promise<void>;
  progress(record: HostRecord, fromByte: number, signal: AbortSignal): Promise<BuildProgress>;
}

export function startBuildScript(plan: BuildPlan, setupTarBase64: string): string {
  const steps = plan.images.map(({ image, target }) => {
    const args = [...(plan.bbUrl ? ["--bb-url", shellWord(plan.bbUrl)] : []), ...(plan.architecture === "arm" ? ["--arch", "arm64"] : []), "--tag", shellWord(image), shellWord(target)].join(" ");
    return `echo "building ${image}"; bash "$d/setup/docker/build.sh" ${args} || { echo $? > "$d/exit"; exit 1; }`;
  });
  return [
    "set -eu",
    `d=${BUILD_DIR}`,
    'mkdir -p "$d"',
    '[ ! -e "$d/started" ] || exit 0',
    `base64 -d > "$d/setup.tgz" <<'BB_BOX_SETUP'`,
    setupTarBase64.replace(/(.{76})/g, "$1\n"),
    "BB_BOX_SETUP",
    'rm -rf "$d/setup" && mkdir -p "$d/unpacked" && tar -xzf "$d/setup.tgz" -C "$d/unpacked" && mv "$d/unpacked/setup" "$d/setup"',
    `cat > "$d/run.sh" <<'BB_BOX_RUN'`,
    "#!/bin/bash",
    `d=${BUILD_DIR}`,
    ...steps,
    'echo 0 > "$d/exit"',
    "BB_BOX_RUN",
    ': > "$d/log"',
    'touch "$d/started"',
    'setsid nohup bash "$d/run.sh" >> "$d/log" 2>&1 < /dev/null &',
  ].join("\n") + "\n";
}

export function progressScript(fromByte: number): string {
  return [
    `d=${BUILD_DIR}`,
    'echo "exit=$(cat "$d/exit" 2>/dev/null || true)"',
    `tail -c +${Math.max(0, Math.floor(fromByte)) + 1} "$d/log" 2>/dev/null | head -c 262144`,
  ].join("\n") + "\n";
}

export function readProgress(stdout: string, fromByte: number): BuildProgress {
  const at = stdout.indexOf("\n");
  const header = at < 0 ? stdout : stdout.slice(0, at);
  const log = at < 0 ? "" : stdout.slice(at + 1);
  const code = /^exit=(\d+)/.exec(header.trim());
  return { exitCode: code ? Number(code[1]) : null, log, nextByte: fromByte + Buffer.byteLength(log) };
}

export function scriptRemoteBuild(
  run: (record: HostRecord, script: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ exitCode: number | null; stdout?: string; stderr: string }>,
  setupArchive: () => Promise<Buffer>,
): RemoteBuild {
  return {
    start: async (record, plan, signal) => {
      const started = await run(record, startBuildScript(plan, (await setupArchive()).toString("base64")), { timeoutMs: 120_000, signal });
      if (started.exitCode !== 0) throw new Error(`The image build did not start on ${record.serverName}: ${started.stderr.trim().split("\n").pop() || `exit code ${started.exitCode}`}`);
    },
    progress: async (record, fromByte, signal) => {
      const read = await run(record, progressScript(fromByte), { timeoutMs: 60_000, signal });
      if (read.exitCode !== 0) throw new Error(read.stderr.trim() || `exit code ${read.exitCode}`);
      return readProgress(read.stdout ?? "", fromByte);
    },
  };
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
const KNOWN_SNAPSHOTS_KEY = "host-image-snapshots-known";

export function localRemoteBuild(buildImage: BuildImage, cliOf: (record: HostRecord) => DockerCli): RemoteBuild {
  const outcomes = new Map<string, Promise<{ exitCode: number; log: string }>>();
  return {
    start: async (record, plan, signal) => {
      if (outcomes.has(record.hostId)) return;
      outcomes.set(
        record.hostId,
        (async () => {
          for (const { image, target } of plan.images) await buildImage(record, cliOf(record), image, target, () => {}, signal, plan.architecture);
          return { exitCode: 0, log: "" };
        })().catch((error: unknown) => ({ exitCode: 1, log: `${error instanceof Error ? error.message : String(error)}\n` })),
      );
    },
    progress: async (record, fromByte) => {
      const outcome = (await outcomes.get(record.hostId)) ?? { exitCode: 1, log: "the build was never started\n" };
      const log = fromByte === 0 ? outcome.log : "";
      return { exitCode: outcome.exitCode, log, nextByte: fromByte + Buffer.byteLength(log) };
    },
  };
}

export type BuildImage = (host: HostRecord, cli: DockerCli, image: string, target: string, log: (line: string) => void, signal: AbortSignal, architecture: Architecture) => Promise<void>;

export function setupFingerprint(setup = setupDir()): string {
  return hashDockerSetup(createHash("sha256"), setup).update(hostSetupScript({ serverName: "host", joinsTailnet: true })).digest("hex").slice(0, 16);
}

export function appLabel(appSha256: string | null): string | null {
  return appSha256 ? appSha256.slice(0, 16) : null;
}

export function runBuildScript(cli: DockerCli, image: string, target: string, bbUrl: string | null, log: (line: string) => void, signal: AbortSignal, setup = setupDir(), architecture: Architecture = "x86"): Promise<number | null> {
  return new Promise((resolve) => {
    const child = timedSpawn(() => spawn("bash", [join(setup, "docker", "build.sh"), ...(bbUrl ? ["--bb-url", bbUrl] : []), ...(architecture === "arm" ? ["--arch", "arm64"] : []), "--tag", image, target], { env: { ...process.env, DOCKER_HOST: cli.host ?? "" }, stdio: ["ignore", "pipe", "pipe"], signal }), "Hetzner Cloud host image build");
    let rest = "";
    const read = (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf8")).split(/\r?\n|\r/);
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) log(line);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
}

export const PREPARE_FOR_SNAPSHOT = [
  "set -eu",
  "docker image prune -f >/dev/null 2>&1 || true",
  "docker builder prune -af >/dev/null 2>&1 || true",
  "cloud-init clean --logs --machine-id",
  "rm -f /etc/ssh/ssh_host_*",
  "rm -f /root/.ssh/authorized_keys",
  "nohup sh -c 'sleep 2; tailscale logout; systemctl stop tailscaled; rm -rf /var/lib/tailscale/tailscaled.state; sync' >/dev/null 2>&1 &",
].join("\n");

export interface HostImageBuild {
  readonly buildId: string;
  readonly snapshot: HetznerImage;
}

export class HostImages {
  readonly #api: Hetzner;
  readonly #builds: HetznerHosts;
  readonly #installLabels: Labels;
  readonly #fingerprint: () => string;
  readonly #storage: BackendStorage | null;
  readonly #now: () => number;
  readonly #told = new Set<string>();
  readonly #waitingOn = new Set<number>();
  readonly #carryingOn = new Set<string>();
  readonly #givingWay = new Map<string, AbortController>();

  constructor(options: { api: Hetzner; builds: HetznerHosts; installLabels: Labels; fingerprint?: () => string; storage?: BackendStorage; now?: () => number }) {
    this.#api = options.api;
    this.#builds = options.builds;
    this.#installLabels = options.installLabels;
    this.#fingerprint = options.fingerprint ?? setupFingerprint;
    this.#storage = options.storage ?? null;
    this.#now = options.now ?? Date.now;
  }

  async #labelled(signal?: AbortSignal): Promise<HetznerImage[]> {
    return this.#api.snapshots({ ...this.#installLabels, [LABEL.role]: HOST_IMAGE_ROLE }, signal);
  }

  async beingMade(signal?: AbortSignal, architecture: Architecture = "x86"): Promise<HetznerImage | null> {
    const making = (await this.#labelled(signal)).filter(
      (each) => each.status === "creating" && each.labels[SETUP_LABEL] === this.#fingerprint() && isArchitecture(each.labels[ARCH_LABEL], architecture) && this.#now() - each.createdAtMs <= SNAPSHOT_GIVEN_UP_AFTER_MS,
    );
    return making.sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
  }

  async know(snapshotId: number): Promise<void> {
    if (!this.#storage) return;
    const known = (await this.#storage.get<number[]>(KNOWN_SNAPSHOTS_KEY)) ?? [];
    if (!known.includes(snapshotId)) await this.#storage.set(KNOWN_SNAPSHOTS_KEY, [...known, snapshotId]);
  }

  async reconcile(log: (line: string) => void, signal?: AbortSignal): Promise<void> {
    const all = await this.#labelled(signal);
    const known = (this.#storage ? await this.#storage.get<number[]>(KNOWN_SNAPSHOTS_KEY) : null) ?? null;
    const tell = (snapshot: HetznerImage, what: string) => {
      const key = `${snapshot.id} ${snapshot.status}`;
      if (this.#told.has(key)) return;
      this.#told.add(key);
      const size = snapshot.compressedSizeGB === null ? "no size yet" : `${snapshot.compressedSizeGB.toFixed(1)} GB`;
      log(`Host image snapshot ${snapshot.id} of build ${snapshot.labels[BUILD_LABEL] ?? "unknown"} (${snapshot.labels[ARCH_LABEL] ?? "x86"}) is ${snapshot.status}, ${size}: bb-box ${what}.`);
    };
    for (const snapshot of all) {
      if (this.#waitingOn.has(snapshot.id)) continue;
      const architecture: Architecture = snapshot.labels[ARCH_LABEL] === "arm" ? "arm" : "x86";
      if (snapshot.status === "available") {
        if (known === null || known.includes(snapshot.id)) continue;
        const newest = await this.newest(signal, architecture);
        tell(snapshot, newest?.id === snapshot.id && snapshot.labels[SETUP_LABEL] === this.#fingerprint() ? "adopts it as the host image, the newest build for its current scripts" : "keeps it with the others, and prunes it when it is no longer among the newest");
        continue;
      }
      if (snapshot.status === "creating" && this.#now() - snapshot.createdAtMs <= SNAPSHOT_GIVEN_UP_AFTER_MS) {
        tell(snapshot, "waits for Hetzner Cloud to finish it, and keeps its build server until then");
        continue;
      }
      tell(snapshot, snapshot.status === "creating" ? "deletes it, as it has been creating for over 2 hours" : "deletes it, as Hetzner Cloud did not make it");
      await this.#api.deleteImage(snapshot.id, signal);
    }
    if (this.#storage) await this.#storage.set(KNOWN_SNAPSHOTS_KEY, (await this.#labelled(signal)).filter((each) => each.status === "available").map((each) => each.id));
    const making = new Set((await this.#labelled(signal)).filter((each) => each.status === "creating").map((each) => each.labels[BUILD_LABEL]));
    for (const record of await this.#builds.records()) {
      if (this.#builds.isMakingInThisProcess(record.hostId) || making.has(record.hostId)) continue;
      if (!(await this.#leftForItsSnapshot(record.hostId))) continue;
      log(`The build server ${record.serverName} waited for its snapshot, which is no longer being made: bb-box deletes it.`);
      await this.#builds.delete(record.hostId, signal);
      await this.#storage?.delete(leftKey(record.hostId));
    }
  }

  async #leftForItsSnapshot(hostId: string): Promise<boolean> {
    return (await this.#storage?.get<boolean>(leftKey(hostId))) === true;
  }

  get builds(): HetznerHosts {
    return this.#builds;
  }

  fingerprint(): string {
    return this.#fingerprint();
  }

  async snapshots(signal?: AbortSignal, architecture: Architecture = "x86"): Promise<HetznerImage[]> {
    const all = await this.#api.snapshots({ ...this.#installLabels, [LABEL.role]: HOST_IMAGE_ROLE }, signal);
    return all.filter((each) => each.status === "available" && isArchitecture(each.labels[ARCH_LABEL], architecture)).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  async newest(signal?: AbortSignal, architecture: Architecture = "x86"): Promise<HetznerImage | null> {
    return (await this.snapshots(signal, architecture))[0] ?? null;
  }

  whyBuild(newest: HetznerImage | null, nowMs: number, appSha256: string | null = null): string | null {
    if (!newest) return "there is no host image yet";
    if (newest.labels[SETUP_LABEL] !== this.#fingerprint()) return "bb-box's image scripts changed since the host image was built";
    const app = appLabel(appSha256);
    if (app && newest.labels[APP_LABEL] !== app) return "BB's server gives another build of its app than the host image has";
    if (nowMs - newest.createdAtMs > HOST_IMAGE_REBUILT_AFTER_MS) return "the host image is more than a week old";
    return null;
  }

  async build(
    input: {
      spec: HostSpec;
      images: readonly { readonly image: string; readonly target: string }[];
      cliOf: (record: HostRecord) => DockerCli;
      run: (record: HostRecord, script: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ exitCode: number | null; stdout?: string; stderr: string }>;
      remote: RemoteBuild;
      bbUrl: string | null;
      architecture?: Architecture;
      appSha256: string | null;
      log: (line: string) => void;
      sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    },
    given: AbortSignal,
  ): Promise<HostImageBuild> {
    const architecture = input.architecture ?? "x86";
    const resumed = await this.resumable(architecture);
    const record = resumed?.record ?? (await this.#builds.create(input.spec, given));
    const givingWay = new AbortController();
    this.#givingWay.set(record.hostId, givingWay);
    const signal = AbortSignal.any([given, givingWay.signal]);
    let saved: SavedBuild = resumed?.saved ?? { architecture, fingerprint: this.#fingerprint(), appSha256: input.appSha256, phase: "building", imageId: null };
    const save = async (next: SavedBuild) => {
      saved = next;
      await this.#storage?.set(savedKey(record.hostId), next);
    };
    if (resumed) input.log(`bb-box carries on with the ${architecture} host image build on ${record.serverName}, from its ${saved.phase} step, which an earlier run of bb-box left.`);
    this.#carryingOn.add(record.hostId);
    let ending: "done" | "failed" | "left" | "gave way" = "failed";
    let snapshotting: number | null = saved.imageId;
    try {
      await save(saved);
      if (saved.phase === "building") {
        if (!resumed) await this.#untilDockerAnswers(record, input.cliOf(record), input.sleep, signal);
        await input.remote.start(record, { images: input.images, architecture, bbUrl: input.bbUrl }, signal);
        await this.#follow(record, input.remote, input.log, input.sleep, signal);
        const prepared = await input.run(record, PREPARE_FOR_SNAPSHOT, { timeoutMs: 600_000, signal });
        if (prepared.exitCode !== 0) throw new Error(`${record.serverName} could not be made ready for its snapshot: ${prepared.stderr.trim().split("\n").pop() || `exit code ${prepared.exitCode}`}`);
        await save({ ...saved, phase: "prepared" });
      }
      let actionId: number | null = null;
      if (saved.phase === "prepared") {
        await input.sleep(5_000, signal);
        await this.#shutDown(record, input.sleep, signal);
        const started = await this.#api.startSnapshot(
          record.serverId!,
          {
            description: `bb-box host image ${record.hostId}`,
            labels: { ...this.#installLabels, [LABEL.role]: HOST_IMAGE_ROLE, [BUILD_LABEL]: record.hostId, [SETUP_LABEL]: saved.fingerprint, [ARCH_LABEL]: architecture, ...(appLabel(saved.appSha256) ? { [APP_LABEL]: appLabel(saved.appSha256)! } : {}) },
          },
          signal,
        );
        actionId = started.actionId;
        await save({ ...saved, phase: "snapshotting", imageId: started.imageId });
      }
      snapshotting = saved.imageId;
      this.#waitingOn.add(snapshotting!);
      if (actionId !== null) await this.#api.waitAction(actionId, signal, SNAPSHOT_WAIT_MS, SNAPSHOT_POLL_MS);
      else await this.#untilMade(snapshotting!, input.sleep, signal);
      const snapshot = await this.#api.image(snapshotting!, signal);
      if (!snapshot || snapshot.status !== "available") throw new Error(`Hetzner Cloud did not make snapshot ${snapshotting} of ${record.serverName}${snapshot ? `: it is ${snapshot.status}` : ""}.`);
      ending = "done";
      await this.know(snapshot.id);
      input.log(`host image ${record.hostId} is snapshot ${snapshot.id}`);
      return { buildId: record.hostId, snapshot };
    } catch (error) {
      if (givingWay.signal.aborted && !given.aborted) {
        ending = "gave way";
        throw new BuildGaveWayToBoxes(`bb-box stopped the ${architecture} host image build on ${record.serverName}, at its ${saved.phase} step, and deleted the server, so a box gets its room. It builds again once boxes have not waited for room for 30 minutes.`);
      }
      if (bbBoxIsStopping(error, signal)) ending = "left";
      throw error;
    } finally {
      this.#carryingOn.delete(record.hostId);
      this.#givingWay.delete(record.hostId);
      if (snapshotting !== null) this.#waitingOn.delete(snapshotting);
      if (ending === "gave way") {
        await this.#storage?.delete(savedKey(record.hostId)).catch(() => undefined);
      } else if (ending === "left") {
        input.log(`bb-box stopped while it built the ${architecture} host image on ${record.serverName}, at its ${saved.phase} step: it leaves the build server running, and the next run of bb-box carries on with it.`);
      } else {
        const stillMaking = ending === "failed" && snapshotting !== null && (await this.#api.image(snapshotting).catch(() => null))?.status === "creating";
        await this.#storage?.delete(savedKey(record.hostId)).catch(() => undefined);
        if (stillMaking) {
          await this.#storage?.set(leftKey(record.hostId), true);
          input.log(`Snapshot ${snapshotting} of ${record.serverName} is still being made, so bb-box keeps the build server until it is, and takes the snapshot as the host image once Hetzner Cloud has made it.`);
        } else {
          await this.#builds.delete(record.hostId).catch((error: unknown) => input.log(`the build server ${record.serverName} is left for the sweep: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    }
  }

  async giveRoomToBoxes(signal?: AbortSignal): Promise<RoomFromBuilds> {
    const stopped: HostRecord[] = [];
    const snapshotting: HostRecord[] = [];
    for (const record of await this.#builds.records()) {
      if (record.state !== "ready") continue;
      const phase = (await this.#storage?.get<SavedBuild>(savedKey(record.hostId)))?.phase ?? "building";
      if (phase !== "building" || (await this.#storage?.get<boolean>(leftKey(record.hostId)))) {
        snapshotting.push(record);
        continue;
      }
      this.#givingWay.get(record.hostId)?.abort();
      await this.#builds.delete(record.hostId, signal);
      await this.#storage?.delete(savedKey(record.hostId));
      stopped.push(record);
    }
    return { stopped, snapshotting };
  }

  async isBuilding(hostId: string): Promise<boolean> {
    return (await this.#builds.records()).some((record) => record.hostId === hostId);
  }

  async resumable(architecture: Architecture): Promise<{ record: HostRecord; saved: SavedBuild } | null> {
    if (!this.#storage) return null;
    for (const record of await this.#builds.records()) {
      if (record.state !== "ready" || this.#builds.isMakingInThisProcess(record.hostId) || this.#carryingOn.has(record.hostId)) continue;
      const saved = await this.#storage.get<SavedBuild>(savedKey(record.hostId));
      if (saved && saved.architecture === architecture && saved.fingerprint === this.#fingerprint()) return { record, saved };
    }
    return null;
  }

  async #follow(record: HostRecord, remote: RemoteBuild, log: (line: string) => void, sleep: (ms: number, signal?: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
    let fromByte = 0;
    let tail: string[] = [];
    let unanswered = 0;
    for (let waited = 0; waited <= BUILD_WITHIN_MS; waited += BUILD_POLL_MS) {
      signal.throwIfAborted();
      const progress = await remote.progress(record, fromByte, signal).catch((error: unknown) => {
        if (bbBoxIsStopping(error, signal)) throw error;
        return null;
      });
      if (progress) {
        unanswered = 0;
        fromByte = progress.nextByte;
        for (const line of progress.log.split(/\r?\n|\r/)) {
          if (!line.trim()) continue;
          log(line);
          tail = [...tail, line].slice(-5);
        }
        if (progress.exitCode === 0) return;
        if (progress.exitCode !== null) throw new Error(`The image build on ${record.serverName} exited with ${progress.exitCode}: ${tail.join(" ") || "no output"}`);
      } else if (++unanswered >= BUILD_UNANSWERED_POLLS) {
        throw new Error(`The build server ${record.serverName} did not answer for ${Math.round((BUILD_UNANSWERED_POLLS * BUILD_POLL_MS) / 60_000)} minutes while it built the images.`);
      }
      await sleep(BUILD_POLL_MS, signal);
    }
    throw new Error(`The image build on ${record.serverName} did not finish within ${BUILD_WITHIN_MS / 3_600_000} hours.`);
  }

  async #untilMade(imageId: number, sleep: (ms: number, signal?: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
    for (let waited = 0; waited < SNAPSHOT_WAIT_MS; waited += SNAPSHOT_POLL_MS) {
      const made = await this.#api.image(imageId, signal);
      if (!made || made.status !== "creating") return;
      await sleep(SNAPSHOT_POLL_MS, signal);
    }
  }

  async prune(keep = KEPT_HOST_IMAGES, signal?: AbortSignal, architecture: Architecture = "x86"): Promise<number[]> {
    const deleted: number[] = [];
    for (const old of (await this.snapshots(signal, architecture)).slice(keep)) {
      await this.#api.deleteImage(old.id, signal);
      deleted.push(old.id);
    }
    return deleted;
  }

  async #untilDockerAnswers(record: HostRecord, cli: DockerCli, sleep: (ms: number, signal?: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
    let last = "";
    for (let waited = 0; waited <= DOCKER_ANSWERS_WITHIN_MS; waited += DOCKER_POLL_MS) {
      const info = await cli.run(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000, signal }).catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
      if (info.exitCode === 0) return;
      last = info.stderr.trim().split("\n").pop() ?? "";
      await sleep(DOCKER_POLL_MS, signal);
    }
    throw new Error(`The build server ${record.serverName} ran, but its Docker did not answer within ${DOCKER_ANSWERS_WITHIN_MS / 60_000} minutes: ${last}`);
  }

  async #shutDown(record: HostRecord, sleep: (ms: number, signal?: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
    await this.#api.shutDown(record.serverId!, signal);
    for (let waited = 0; waited < SHUTDOWN_WITHIN_MS; waited += 5_000) {
      if ((await this.#api.server(record.serverId!, signal))?.status === "off") return;
      await sleep(5_000, signal);
    }
    await this.#api.powerOff(record.serverId!, signal);
  }
}

function leftKey(hostId: string): string {
  return `host-image-build-left:${hostId}`;
}

function savedKey(hostId: string): string {
  return `host-image-build:${hostId}`;
}
