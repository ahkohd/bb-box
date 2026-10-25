import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { abortable } from "../../core/abortable.ts";
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
const BUILD_POLL_MS = 10_000;
const BUILD_UNANSWERED_POLLS = 30;
const LEFT_BUILD_GRACE_MS = 2 * 60_000;
const RECORD_PREFIX = "linux-image/";
const BUILD_PREFIX = "linux-image-build/";
const STOPPING = /stale API handle|reloaded or disabled/i;

interface SavedBuild {
  readonly instance: string;
  readonly key: string;
  readonly startedAt: number;
  readonly phase: "starting" | "building";
  readonly tailnet: boolean;
}

interface BuildProgress {
  readonly exitCode: number | null;
  readonly ref: string;
  readonly log: string;
  readonly nextByte: number;
}

export interface LinuxImageRecord {
  readonly target: LinuxImageTarget;
  readonly ref: string;
  readonly key: string;
  readonly builtAt: number;
  readonly usedAt: number | null;
  readonly buildMs?: number;
}

const TARGET_WORDS: Record<LinuxImageTarget, string> = {
  linux: "Linux",
  desktop: "Linux desktop",
  "desktop-wayland": "Linux desktop on Wayland",
};

const USUAL_BUILD_MINUTES: Record<LinuxImageTarget, number> = {
  linux: 4,
  desktop: 7,
  "desktop-wayland": 9,
};

export function buildWaitWords(target: LinuxImageTarget, lastBuildMs: number | null): string {
  const minutes = lastBuildMs ? Math.max(1, Math.round(lastBuildMs / 60_000)) : USUAL_BUILD_MINUTES[target];
  return `Building Namespace's ${TARGET_WORDS[target]} image first, which takes about ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Later boxes of this kind use it and start in under a minute.`;
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
  readonly joinTailnet?: (instance: string, name: string, signal: AbortSignal) => Promise<(() => Promise<void>) | null>;
  readonly log: (line: string) => void;
  readonly fingerprint?: () => string;
  readonly setupArchive?: () => Promise<Buffer>;
  readonly buildScript?: (target: LinuxImageTarget, key: string, bbUrl: string | null) => string;
  readonly leaveTailnet?: (instance: string, name: string) => Promise<void>;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

function buildDir(target: LinuxImageTarget): string {
  return `"$HOME/.bb-box-build/${target}"`;
}

export function startDetachedBuildScript(target: LinuxImageTarget, inner: string): string {
  return [
    "set -eu",
    `d=${buildDir(target)}`,
    'mkdir -p "$d"',
    '[ ! -e "$d/started" ] || { cat >/dev/null; exit 0; }',
    'cat > "$d/setup.tgz"',
    `cat > "$d/run.sh" <<'BB_BOX_RUN'`,
    inner,
    "BB_BOX_RUN",
    ': > "$d/log"',
    'touch "$d/started"',
    `setsid nohup bash -c 'bash "$1/run.sh" < "$1/setup.tgz" > "$1/out" 2>> "$1/log"; echo $? > "$1/exit"' _ "$d" < /dev/null > /dev/null 2>&1 &`,
  ].join("\n") + "\n";
}

export function buildProgressScript(target: LinuxImageTarget, fromByte: number): string {
  return [
    `d=${buildDir(target)}`,
    'echo "exit=$(cat "$d/exit" 2>/dev/null || true)"',
    'echo "ref=$(tail -n 1 "$d/out" 2>/dev/null || true)"',
    `tail -c +${Math.max(0, Math.floor(fromByte)) + 1} "$d/log" 2>/dev/null | head -c 262144`,
  ].join("\n") + "\n";
}

export function readBuildProgress(stdout: string, fromByte: number): BuildProgress {
  const [exitLine = "", refLine = "", ...rest] = stdout.split("\n");
  const log = rest.join("\n");
  const code = /^exit=(\d+)/.exec(exitLine.trim());
  return { exitCode: code ? Number(code[1]) : null, ref: refLine.replace(/^ref=/, "").trim(), log, nextByte: fromByte + Buffer.byteLength(log) };
}

interface Building {
  readonly done: Promise<LinuxImageRecord>;
  readonly stop: AbortController;
  boxesWaiting: number;
  keptForUpkeep: boolean;
}

export class LinuxImages {
  readonly #deps: LinuxImageDeps;
  readonly #building = new Map<LinuxImageTarget, Building>();
  readonly #disposing = new AbortController();

  constructor(deps: LinuxImageDeps) {
    this.#deps = deps;
  }

  record(target: LinuxImageTarget): Promise<LinuxImageRecord | undefined> {
    return this.#deps.storage.get<LinuxImageRecord>(`${RECORD_PREFIX}${target}`);
  }

  building(target: LinuxImageTarget): boolean {
    return this.#building.has(target);
  }

  dispose(): void {
    this.#disposing.abort(new Error("bb-box stopped, as for a reload"));
  }

  #saved(target: LinuxImageTarget): Promise<SavedBuild | undefined> {
    return this.#deps.storage.get<SavedBuild>(`${BUILD_PREFIX}${target}`);
  }

  async #save(target: LinuxImageTarget, saved: SavedBuild): Promise<void> {
    await this.#deps.storage.set(`${BUILD_PREFIX}${target}`, saved);
  }

  async carryOnLeftBuilds(): Promise<void> {
    for (const target of Object.values(LINUX_IMAGE_TARGETS)) {
      if (this.#building.has(target) || !(await this.#saved(target))) continue;
      void this.build(target, "an earlier run of bb-box left its build").catch(() => undefined);
    }
  }

  async destroyBuildsNoOneFollows(signal?: AbortSignal): Promise<void> {
    const deps = this.#deps;
    const followed = new Set<string>();
    for (const target of Object.values(LINUX_IMAGE_TARGETS)) {
      const saved = await this.#saved(target);
      if (saved) followed.add(saved.instance);
    }
    for (const instance of await deps.api.list({ ...deps.labels, "bbbox-role": IMAGE_BUILD_ROLE }, signal)) {
      if (instance.status !== "running" || followed.has(instance.id)) continue;
      if (instance.createdAt !== null && deps.now() - instance.createdAt < LEFT_BUILD_GRACE_MS) continue;
      await deps.api.destroy(instance.id, "bb-box: no image build follows it", signal).catch(() => undefined);
      deps.log(`Namespace: destroyed build instance ${instance.id}, which no image build of bb-box's follows.`);
    }
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

  async forBox(target: LinuxImageTarget, signal: AbortSignal, waiting?: (words: string | null) => Promise<void>): Promise<LinuxImageRecord> {
    const current = await this.record(target);
    const why = await this.whyBuild(target, signal);
    const usable = current && (why === null || why === "it is a week old" || why === "BB's app changed") ? current : await this.#buildForBox(target, why ?? "it was asked for", current?.buildMs ?? null, signal, waiting);
    const used = { ...usable, usedAt: this.#deps.now() };
    await this.#deps.storage.set(`${RECORD_PREFIX}${target}`, used);
    return used;
  }

  async #buildForBox(target: LinuxImageTarget, why: string, lastBuildMs: number | null, signal: AbortSignal, waiting?: (words: string | null) => Promise<void>): Promise<LinuxImageRecord> {
    await waiting?.(buildWaitWords(target, lastBuildMs));
    try {
      return await this.build(target, why, signal);
    } finally {
      await waiting?.(null);
    }
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

  build(target: LinuxImageTarget, why: string, boxSignal?: AbortSignal): Promise<LinuxImageRecord> {
    let building = this.#building.get(target);
    if (!building) {
      const stop = new AbortController();
      const done = this.#build(target, why, stop.signal).finally(() => this.#building.delete(target));
      done.catch(() => undefined);
      building = { done, stop, boxesWaiting: 0, keptForUpkeep: false };
      this.#building.set(target, building);
    }
    if (!boxSignal) {
      building.keptForUpkeep = true;
      return building.done;
    }
    return this.#waitAsBox(building, boxSignal);
  }

  async #waitAsBox(building: Building, boxSignal: AbortSignal): Promise<LinuxImageRecord> {
    building.boxesWaiting++;
    try {
      return await abortable(building.done, boxSignal);
    } finally {
      building.boxesWaiting--;
      const noOneWaits = building.boxesWaiting === 0 && !building.keptForUpkeep;
      if (boxSignal.aborted && noOneWaits) building.stop.abort(boxSignal.reason);
    }
  }

  async #build(target: LinuxImageTarget, why: string, stop: AbortSignal): Promise<LinuxImageRecord> {
    const deps = this.#deps;
    const signal = AbortSignal.any([stop, this.#disposing.signal]);
    const key = await this.key(signal);
    let saved = await this.#saved(target);
    if (saved && saved.key !== key) {
      await this.#end(target, saved, null);
      saved = undefined;
    }
    if (saved) {
      const left = await deps.api.describe(saved.instance, signal).catch(() => null);
      if (left?.status === "running") {
        deps.log(`Namespace: bb-box carries on with the ${target} image build in instance ${saved.instance}, from its ${saved.phase} step, which an earlier run of bb-box left.`);
      } else {
        await this.#end(target, saved, null);
        saved = undefined;
      }
    }
    if (!saved) {
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
      saved = { instance: made.id, key, startedAt: deps.now(), phase: "starting", tailnet: false };
      await this.#save(target, saved);
    }
    let build: SavedBuild = saved;
    let leave: (() => Promise<void>) | null = null;
    let ending: "done" | "ended" | "left" = "ended";
    try {
      if (build.phase === "starting") {
        const ready = await deps.api.wait(build.instance, signal);
        if (ready.status !== "running") throw new Error(`Namespace's build instance ${build.instance} is ${ready.status}, not running.`);
        await deps.answers(build.instance, signal);
        leave = (await deps.joinTailnet?.(build.instance, `build-${target}`, signal)) ?? null;
        if (leave) await this.#save(target, (build = { ...build, tailnet: true }));
        const archive = await (deps.setupArchive ?? setupArchive)();
        const inner = (deps.buildScript ?? linuxImageBuildScript)(target, key, deps.bbUrl());
        const started = await deps.run(build.instance, startDetachedBuildScript(target, inner), archive, 120_000, signal);
        if (started.exitCode !== 0) throw new Error(`The ${target} image build did not start in Namespace's instance ${build.instance}: ${started.stderr.trim().split("\n").slice(-3).join(" / ") || `exit ${started.exitCode}`}`);
        await this.#save(target, (build = { ...build, phase: "building" }));
      }
      const ref = await this.#follow(target, build, signal);
      const record: LinuxImageRecord = { target, ref, key, builtAt: deps.now(), usedAt: (await this.record(target))?.usedAt ?? null, buildMs: deps.now() - build.startedAt };
      await deps.storage.set(`${RECORD_PREFIX}${target}`, record);
      ending = "done";
      deps.log(`Namespace: built and pushed the ${target} image, ${ref}, in ${Math.round((deps.now() - build.startedAt) / 1000)} s.`);
      return record;
    } catch (error) {
      if (this.#disposing.signal.aborted || STOPPING.test(error instanceof Error ? error.message : String(error))) ending = "left";
      throw error;
    } finally {
      if (ending === "left") deps.log(`Namespace: bb-box stopped while it built the ${target} image in instance ${build.instance}, at its ${build.phase} step: it leaves the instance building, and the next run of bb-box carries on with it.`);
      else await this.#end(target, build, leave);
    }
  }

  async #follow(target: LinuxImageTarget, build: SavedBuild, signal: AbortSignal): Promise<string> {
    const deps = this.#deps;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let fromByte = 0;
    let tail: string[] = [];
    let unanswered = 0;
    while (deps.now() - build.startedAt <= BUILD_TIMEOUT_MS) {
      signal.throwIfAborted();
      const ran = await deps.run(build.instance, buildProgressScript(target, fromByte), Buffer.alloc(0), 60_000, signal).catch((error: unknown) => {
        if (signal.aborted || STOPPING.test(error instanceof Error ? error.message : String(error))) throw error;
        return null;
      });
      if (ran && ran.exitCode === 0) {
        unanswered = 0;
        const progress = readBuildProgress(ran.stdout, fromByte);
        fromByte = progress.nextByte;
        tail = [...tail, ...progress.log.split(/\r?\n|\r/).filter((line) => line.trim())].slice(-5);
        if (progress.exitCode === 0 && progress.ref.startsWith("nscr.io/")) return progress.ref;
        if (progress.exitCode !== null) throw new Error(`The ${target} image did not build in Namespace's instance ${build.instance}: ${tail.join(" / ") || `exit ${progress.exitCode}`}`);
      } else if (++unanswered >= BUILD_UNANSWERED_POLLS) {
        throw new Error(`Namespace's build instance ${build.instance} did not answer for ${Math.round((BUILD_UNANSWERED_POLLS * BUILD_POLL_MS) / 60_000)} minutes while it built the ${target} image.`);
      }
      await sleep(BUILD_POLL_MS, signal);
    }
    throw new Error(`The ${target} image did not build in Namespace's instance ${build.instance} within ${BUILD_TIMEOUT_MS / 60_000} minutes.`);
  }

  async #end(target: LinuxImageTarget, build: SavedBuild, leave: (() => Promise<void>) | null): Promise<void> {
    const deps = this.#deps;
    const leaving = leave ?? (build.tailnet && deps.leaveTailnet ? () => deps.leaveTailnet!(build.instance, `build-${target}`) : null);
    await leaving?.().catch((error) => deps.log(`Namespace: build instance ${build.instance} did not leave the tailnet: ${error instanceof Error ? error.message : String(error)}`));
    await deps.api.destroy(build.instance, "bb-box: the image build ended").catch((error) => deps.log(`Namespace: could not destroy build instance ${build.instance}: ${error instanceof Error ? error.message : String(error)}`));
    await deps.storage.delete(`${BUILD_PREFIX}${target}`).catch(() => undefined);
  }
}
