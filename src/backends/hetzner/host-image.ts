import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setupDir } from "../setup-dir.ts";
import type { DockerCli } from "../docker/cli.ts";
import { hashDockerSetup } from "../docker/setup-hash.ts";
import type { Hetzner, HetznerImage, Labels } from "./api.ts";
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

  constructor(options: { api: Hetzner; builds: HetznerHosts; installLabels: Labels; fingerprint?: () => string }) {
    this.#api = options.api;
    this.#builds = options.builds;
    this.#installLabels = options.installLabels;
    this.#fingerprint = options.fingerprint ?? setupFingerprint;
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
      const snapshot = await this.#api.createSnapshot(
        record.serverId!,
        {
          description: `bb-box host image ${record.hostId}`,
          labels: { ...this.#installLabels, [LABEL.role]: HOST_IMAGE_ROLE, [BUILD_LABEL]: record.hostId, [SETUP_LABEL]: fingerprint, [ARCH_LABEL]: input.architecture ?? "x86", ...(appLabel(input.appSha256) ? { [APP_LABEL]: appLabel(input.appSha256)! } : {}) },
        },
        signal,
      );
      input.log(`host image ${record.hostId} is snapshot ${snapshot.id}`);
      return { buildId: record.hostId, snapshot };
    } finally {
      await this.#builds.delete(record.hostId).catch((error: unknown) => input.log(`the build server ${record.serverName} is left for the sweep: ${error instanceof Error ? error.message : String(error)}`));
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
