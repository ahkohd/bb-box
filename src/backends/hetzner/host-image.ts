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
const KNOWN_SNAPSHOTS_KEY = "host-image-snapshots-known";

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
      run: (record: HostRecord, script: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ exitCode: number | null; stderr: string }>;
      buildImage: BuildImage;
      architecture?: Architecture;
      appSha256: string | null;
      log: (line: string) => void;
      sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    },
    signal: AbortSignal,
  ): Promise<HostImageBuild> {
    const fingerprint = this.#fingerprint();
    const record = await this.#builds.create(input.spec, signal);
    let snapshotting: number | null = null;
    try {
      const cli = input.cliOf(record);
      await this.#untilDockerAnswers(record, cli, input.sleep, signal);
      for (const { image, target } of input.images) {
        input.log(`building ${image} on ${record.serverName}`);
        await input.buildImage(record, cli, image, target, input.log, signal, input.architecture ?? "x86");
      }
      const prepared = await input.run(record, PREPARE_FOR_SNAPSHOT, { timeoutMs: 600_000, signal });
      if (prepared.exitCode !== 0) throw new Error(`${record.serverName} could not be made ready for its snapshot: ${prepared.stderr.trim().split("\n").pop() || `exit code ${prepared.exitCode}`}`);
      await input.sleep(5_000, signal);
      await this.#shutDown(record, input.sleep, signal);
      const started = await this.#api.startSnapshot(
        record.serverId!,
        {
          description: `bb-box host image ${record.hostId}`,
          labels: { ...this.#installLabels, [LABEL.role]: HOST_IMAGE_ROLE, [BUILD_LABEL]: record.hostId, [SETUP_LABEL]: fingerprint, [ARCH_LABEL]: input.architecture ?? "x86", ...(appLabel(input.appSha256) ? { [APP_LABEL]: appLabel(input.appSha256)! } : {}) },
        },
        signal,
      );
      snapshotting = started.imageId;
      this.#waitingOn.add(started.imageId);
      await this.#api.waitAction(started.actionId, signal, SNAPSHOT_WAIT_MS, SNAPSHOT_POLL_MS);
      const snapshot = await this.#api.image(started.imageId, signal);
      if (!snapshot) throw new Error(`Hetzner Cloud made snapshot ${started.imageId} of ${record.serverName}, then it was gone.`);
      snapshotting = null;
      await this.know(snapshot.id);
      input.log(`host image ${record.hostId} is snapshot ${snapshot.id}`);
      return { buildId: record.hostId, snapshot };
    } finally {
      if (snapshotting !== null) this.#waitingOn.delete(snapshotting);
      const stillMaking = snapshotting !== null && (await this.#api.image(snapshotting).catch(() => null))?.status === "creating";
      if (stillMaking) {
        await this.#storage?.set(leftKey(record.hostId), true);
        input.log(`Snapshot ${snapshotting} of ${record.serverName} is still being made, so bb-box keeps the build server until it is, and takes the snapshot as the host image once Hetzner Cloud has made it.`);
      } else {
        await this.#builds.delete(record.hostId).catch((error: unknown) => input.log(`the build server ${record.serverName} is left for the sweep: ${error instanceof Error ? error.message : String(error)}`));
      }
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
