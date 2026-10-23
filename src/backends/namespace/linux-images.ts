import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { hashDockerSetup } from "../docker/setup-hash.ts";
import { setupDir } from "../setup-dir.ts";
import type { BackendStorage } from "../types.ts";
import type { InstanceShape, NamespaceApi } from "./api.ts";

export const LINUX_IMAGE_TARGETS = {
  linux: "linux",
  "linux-desktop-cpu": "desktop",
  "linux-desktop-wayland-cpu": "desktop-wayland",
} as const;
export type LinuxImageKind = keyof typeof LINUX_IMAGE_TARGETS;
export type LinuxImageTarget = (typeof LINUX_IMAGE_TARGETS)[LinuxImageKind];

export const IMAGE_BUILD_ROLE = "image-build";
export const LINUX_IMAGE_REBUILT_AFTER_MS = 7 * 24 * 3_600_000;
export const LINUX_IMAGE_KEPT_UNUSED_MS = 7 * 24 * 3_600_000;
const BUILD_SHAPE: InstanceShape = { os: "linux", arch: "amd64", cores: 8, memoryMiB: 16 * 1024 };
const BUILD_LIFE_MS = 60 * 60_000;
const BUILD_TIMEOUT_MS = 55 * 60_000;
const RECORD_PREFIX = "linux-image/";

export interface LinuxImageRecord {
  readonly target: LinuxImageTarget;
  readonly ref: string;
  readonly key: string;
  readonly builtAt: number;
  readonly usedAt: number | null;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LinuxImageDeps {
  readonly api: NamespaceApi;
  readonly storage: BackendStorage;
  readonly labels: Readonly<Record<string, string>>;
  readonly uniqueTag: (target: LinuxImageTarget) => string;
  readonly now: () => number;
  readonly publicKey: () => Promise<string>;
  readonly answers: (instance: string, signal: AbortSignal) => Promise<void>;
  readonly run: (instance: string, script: string, stdin: Buffer, timeoutMs: number, signal: AbortSignal) => Promise<CommandResult>;
  readonly bbUrl: () => string | null;
  readonly bbApp: (signal?: AbortSignal) => Promise<string | null>;
  readonly log: (line: string) => void;
  readonly fingerprint?: () => string;
  readonly setupArchive?: () => Promise<Buffer>;
  readonly buildScript?: (target: LinuxImageTarget, key: string, bbUrl: string | null) => string;
}

export function linuxImageFingerprint(setup = setupDir()): string {
  return hashDockerSetup(createHash("sha256"), setup).digest("hex").slice(0, 12);
}

export function linuxImageKey(fingerprint: string, appSha256: string | null): string {
  return `${fingerprint}-${appSha256 ? appSha256.slice(0, 12) : "noapp"}`;
}

export function setupArchive(setup = setupDir()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", "-", "-C", dirname(setup.replace(/\/+$/, "")), "setup/docker", "setup/proxmox-lxc"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar could not pack bb-box's setup scripts: ${stderr.trim() || `exit ${code}`}`))));
  });
}

export const WORKSPACE_FROM_METADATA = [
  'meta="$(dirname "${NSC_METADATA_FILE:-/run/nsc/metadata.json}")/metadata.json"',
  `workspace=$(grep -o '"tenant_id" *: *"[^"]*"' "$meta" 2>/dev/null | head -n 1 | sed 's/.*: *"//; s/"$//; s/^tenant_//')`,
].join("\n");

export function linuxImageBuildScript(target: LinuxImageTarget, key: string, bbUrl: string | null): string {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  return [
    "set -eu",
    "work=$(mktemp -d)",
    'tar -xzf - -C "$work"',
    WORKSPACE_FROM_METADATA,
    '[ -n "$workspace" ] || { echo "Namespace\'s metadata names no workspace, so the image has nowhere to go." >&2; exit 3; }',
    `ref="nscr.io/$workspace/bbbox/${target}:${key}"`,
    `bash "$work/setup/docker/build.sh" ${bbUrl ? `--bb-url ${quote(bbUrl)} ` : ""}--tag "$ref" ${target} >&2`,
    'docker push -q "$ref" >&2',
    'echo "$ref"',
  ].join("\n");
}

export class LinuxImages {
  readonly #deps: LinuxImageDeps;
  readonly #building = new Map<LinuxImageTarget, Promise<LinuxImageRecord>>();

  constructor(deps: LinuxImageDeps) {
    this.#deps = deps;
  }

  record(target: LinuxImageTarget): Promise<LinuxImageRecord | undefined> {
    return this.#deps.storage.get<LinuxImageRecord>(`${RECORD_PREFIX}${target}`);
  }

  building(target: LinuxImageTarget): boolean {
    return this.#building.has(target);
  }

  async key(signal?: AbortSignal): Promise<string> {
    return linuxImageKey((this.#deps.fingerprint ?? linuxImageFingerprint)(), await this.#deps.bbApp(signal));
  }

  async whyBuild(target: LinuxImageTarget, signal?: AbortSignal): Promise<string | null> {
    const record = await this.record(target);
    if (!record) return "there is none yet";
    const key = await this.key(signal);
    if (record.key !== key) return record.key.split("-")[0] !== key.split("-")[0] ? "bb-box's image scripts changed" : "BB's app changed";
    if (this.#deps.now() - record.builtAt >= LINUX_IMAGE_REBUILT_AFTER_MS) return "it is a week old";
    return null;
  }

  async forBox(target: LinuxImageTarget, signal: AbortSignal): Promise<LinuxImageRecord> {
    const current = await this.record(target);
    const why = await this.whyBuild(target, signal);
    const usable = current && (why === null || why === "it is a week old" || why === "BB's app changed") ? current : await this.build(target, why ?? "it was asked for", signal);
    const used = { ...usable, usedAt: this.#deps.now() };
    await this.#deps.storage.set(`${RECORD_PREFIX}${target}`, used);
    return used;
  }

  async due(signal?: AbortSignal): Promise<{ readonly target: LinuxImageTarget; readonly why: string }[]> {
    const due: { target: LinuxImageTarget; why: string }[] = [];
    for (const target of Object.values(LINUX_IMAGE_TARGETS)) {
      const record = await this.record(target);
      if (!record || record.usedAt === null || this.#deps.now() - record.usedAt > LINUX_IMAGE_KEPT_UNUSED_MS || this.#building.has(target)) continue;
      const why = await this.whyBuild(target, signal);
      if (why) due.push({ target, why });
    }
    return due;
  }

  build(target: LinuxImageTarget, why: string, signal: AbortSignal): Promise<LinuxImageRecord> {
    let building = this.#building.get(target);
    if (!building) {
      building = this.#build(target, why, signal).finally(() => this.#building.delete(target));
      this.#building.set(target, building);
    }
    return building;
  }

  async #build(target: LinuxImageTarget, why: string, signal: AbortSignal): Promise<LinuxImageRecord> {
    const deps = this.#deps;
    const key = await this.key(signal);
    const started = deps.now();
    deps.log(`Namespace: building the ${target} image in a Linux instance, as ${why}.`);
    const made = await deps.api.create(
      {
        shape: BUILD_SHAPE,
        labels: { ...deps.labels, "bbbox-role": IMAGE_BUILD_ROLE, "bbbox-target": target },
        deadline: deps.now() + BUILD_LIFE_MS,
        purpose: `bb-box ${target} image build`,
        uniqueTag: deps.uniqueTag(target),
        sshPublicKeys: [await deps.publicKey()],
      },
      signal,
    );
    try {
      const ready = await deps.api.wait(made.id, signal);
      if (ready.status !== "running") throw new Error(`Namespace's build instance ${made.id} is ${ready.status}, not running.`);
      await deps.answers(made.id, signal);
      const archive = await (deps.setupArchive ?? setupArchive)();
      const script = (deps.buildScript ?? linuxImageBuildScript)(target, key, deps.bbUrl());
      const built = await deps.run(made.id, script, archive, BUILD_TIMEOUT_MS, signal);
      const ref = built.stdout.trim().split("\n").at(-1)?.trim() ?? "";
      if (built.exitCode !== 0 || !ref.startsWith("nscr.io/")) {
        throw new Error(`The ${target} image did not build in Namespace's instance ${made.id}: ${built.stderr.trim().split("\n").slice(-5).join(" / ") || `exit ${built.exitCode}`}`);
      }
      const record: LinuxImageRecord = { target, ref, key, builtAt: deps.now(), usedAt: (await this.record(target))?.usedAt ?? null };
      await deps.storage.set(`${RECORD_PREFIX}${target}`, record);
      deps.log(`Namespace: built and pushed the ${target} image, ${ref}, in ${Math.round((deps.now() - started) / 1000)} s.`);
      return record;
    } finally {
      await deps.api.destroy(made.id, "bb-box: the image build ended").catch((error) => deps.log(`Namespace: could not destroy build instance ${made.id}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}
