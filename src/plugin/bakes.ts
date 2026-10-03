/**
 * Projects' images baked when used (049): a box of an image with no current
 * build on its backend runs the script at start. Once two such boxes started
 * on a backend within 14 days, or at once for an image that says always,
 * bb-box builds the image there in the background, and the next box starts
 * from the build. A build is current while the image's script and check,
 * and the standard build it was made on, are as they were; a changed script
 * is built again at once. Builds no box started from for 30 days go, and so
 * do those of images removed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { recordFromJson, type ImageRecord } from "../backends/images.ts";
import type { Backend, BackendStorage, DoctorCheck, ImageBuild } from "../backends/types.ts";
import type { BoxRecord } from "../core/boxes.ts";
import type { ImageConfig } from "../core/document.ts";
import { quote } from "../transports/process.ts";

const DAY_MS = 24 * 60 * 60_000;
/** Boxes started within these days that make an image baked on a backend (049). */
const USE_DAYS = 14;
const USES = 2;
/** A build no box started from for these days goes (049). */
const UNUSED_DAYS = 30;
/** A bake that failed is not tried again for this long, unless its script or standard build changes. */
const RETRY_MS = DAY_MS;
/** How long a list of a backend's builds is good for at acquire. */
const LIST_MS = 60_000;
/** As a box's run at start (049): the script, then the check. */
const SCRIPT_MS = 30 * 60_000;
const CHECK_MS = 10 * 60_000;
const BAKE = "images/bake/";
const USAGE = "images/usage/";
/** Builds a box still used when they were replaced or went: the nightly upkeep tries again. */
const RETIRED = "images/bake-retired";
/** Where the build's files go in the box, as a refresh puts them. */
const BUILD_DIR = "/var/tmp/bb-box-build";
/** A GPU desktop's build would hold one GPU's devices, so its image runs at start. */
const UNBAKED_KINDS = new Set(["linux-desktop"]);

/** A baked build of an image for a kind on a backend. */
export interface Bake {
  readonly ref: string;
  readonly build: string | null;
  /** The SHA-256 of the script and check it was made with. */
  readonly script: string;
  /** The standard build it was made on. */
  readonly base: string | null;
  readonly at: number;
  /** When a box last started from it, or when it was made. */
  readonly used: number;
}

/** A bake's last failure, which the doctor shows. */
export interface BakeFailure {
  readonly at: number;
  readonly reason: string;
  /** The bake's last lines. */
  readonly output: readonly string[];
  readonly script: string;
  readonly base: string | null;
}

/** What a bake or the nightly upkeep did to an image's build, as a line of the nightly run. */
export interface BakeLine {
  readonly name: string;
  readonly outcome: "baked" | "failed" | "removed" | "not started";
  readonly detail: string;
}

export interface ImageBakesDeps {
  /** The backends that are on. */
  backends(): readonly Backend[];
  /** The projects' images, as the configuration has them now. */
  images(): Readonly<Record<string, ImageConfig>>;
  readonly storage: BackendStorage;
  /** The plugin's setup/ directory, whose guest scripts finalize a build. */
  readonly setup: string;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

/** The SHA-256 of an image's script and check: a build made with others is out of date. */
export function scriptHash(image: ImageConfig): string {
  return createHash("sha256").update(image.script).update("\0").update(image.check ?? "").digest("hex");
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const key = (prefix: string, name: string, backend: string, kind: string) => `${prefix}${name}/${backend}/${kind}`;
const label = (name: string, backend: string, kind: string) => `${name} for ${kind} on ${backend}`;
/** An entry's image, backend and kind. */
const parts = (entry: string) => {
  const [name = "", backend = "", kind = ""] = entry.slice(BAKE.length).split("/");
  return { name, backend, kind };
};

export class ImageBakes {
  readonly #deps: ImageBakesDeps;
  readonly #lists = new Map<string, { at: number; builds: Promise<readonly ImageBuild[]> }>();
  readonly #baking = new Map<string, Promise<BakeLine>>();
  /** Bakes, and the nightly run's removal of what runs left, one at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #stop = new AbortController();

  constructor(deps: ImageBakesDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #say(line: string): void {
    this.#deps.log?.(`images: ${line}`);
  }

  /** Runs `work` once no bake is going on, and starts none until it ends. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** A backend's builds, listed at most once a minute as acquires ask. */
  #builds(backend: Backend, fresh = false): Promise<readonly ImageBuild[]> {
    const cached = this.#lists.get(backend.id);
    if (cached && !fresh && this.#now() - cached.at < LIST_MS) return cached.builds;
    const builds = (backend.images?.list() ?? Promise.resolve({ builds: [] as ImageBuild[] })).then(
      (listed) => listed.builds,
      () => [] as ImageBuild[],
    );
    this.#lists.set(backend.id, { at: this.#now(), builds });
    return builds;
  }

  #standard(builds: readonly ImageBuild[], kind: string): ImageBuild | null {
    return builds.find((build) => build.current && build.image === "standard" && build.kind === kind) ?? null;
  }

  #backend(id: string): Backend | null {
    return this.#deps.backends().find((candidate) => candidate.id === id) ?? null;
  }

  /** Whether bb-box bakes an image for a kind on a backend at all. */
  #bakes(image: ImageConfig, backend: Backend, kind: string): boolean {
    return (
      image.bake !== "never" &&
      image.kinds.includes(kind) &&
      !UNBAKED_KINDS.has(kind) &&
      !!backend.images?.startsFrom &&
      backend.kinds().some((offered) => offered.id === kind)
    );
  }

  /** The current baked build of an image for a kind on a backend, for an acquire, or null. */
  async current(name: string, backendId: string, kind: string): Promise<{ readonly ref: string; readonly build: string | null } | null> {
    const image = this.#deps.images()[name];
    const backend = this.#backend(backendId);
    if (!image || !backend?.images?.startsFrom) return null;
    const bake = await this.#deps.storage.get<Bake>(key(BAKE, name, backendId, kind));
    if (!bake || bake.script !== scriptHash(image)) return null;
    const builds = await this.#builds(backend);
    if (this.#standard(builds, kind)?.build !== bake.base || !builds.some((build) => build.ref === bake.ref)) return null;
    return { ref: bake.ref, build: bake.build };
  }

  /**
   * A box of an image is ready: one that started from a build marks it
   * used; one whose script ran at start counts towards baking the image on
   * its backend, and has it baked there once it is due.
   */
  ready(box: BoxRecord): void {
    void this.#ready(box).catch((error: unknown) => this.#say(`could not count ${box.name}'s image: ${message(error)}`));
  }

  async #ready(box: BoxRecord): Promise<void> {
    const { image: used, backend: backendId, kind } = box;
    if (!used) return;
    const at = key(BAKE, used.name, backendId, kind);
    if (used.state === "baked") {
      const bake = await this.#deps.storage.get<Bake>(at);
      if (bake && bake.ref === used.from) await this.#deps.storage.set(at, { ...bake, used: this.#now() } satisfies Bake);
      return;
    }
    if (used.state !== "done") return;
    const image = this.#deps.images()[used.name];
    const backend = this.#backend(backendId);
    if (!image || !backend || !this.#bakes(image, backend, kind)) return;
    const since = this.#now() - USE_DAYS * DAY_MS;
    const usage = [...((await this.#deps.storage.get<number[]>(key(USAGE, used.name, backendId, kind))) ?? []).filter((time) => time >= since), this.#now()];
    await this.#deps.storage.set(key(USAGE, used.name, backendId, kind), usage);
    if (image.bake !== "always" && usage.length < USES) return;
    // A failed bake waits a day, unless the script or the standard build changed.
    const failed = await this.#deps.storage.get<BakeFailure>(`${at}/failed`);
    const standard = this.#standard(await this.#builds(backend), kind);
    if (failed && this.#now() - failed.at < RETRY_MS && failed.script === scriptHash(image) && failed.base === (standard?.build ?? null)) return;
    void this.bake(used.name, backend, kind);
  }

  /** Bakes an image for a kind on a backend after the bakes before it, unless one is going on for it already. */
  bake(name: string, backend: Backend, kind: string): Promise<BakeLine> {
    const at = key(BAKE, name, backend.id, kind);
    const going = this.#baking.get(at);
    if (going) return going;
    const run = this.exclusive(() =>
      this.#bake(name, backend, kind).catch((error: unknown): BakeLine => {
        this.#say(`baking ${label(name, backend.id, kind)} failed: ${message(error)}`);
        return { name: label(name, backend.id, kind), outcome: "failed", detail: message(error) };
      }),
    ).finally(() => this.#baking.delete(at));
    this.#baking.set(at, run);
    return run;
  }

  /**
   * Builds an image on the kind's standard build (049): in a box of it, the
   * script as root, the check as the box user, finalizing as a standard
   * image's build does, the record, a capture, and a trial box that passes
   * the check. The build then replaces the image's last one there.
   */
  async #bake(name: string, backend: Backend, kind: string): Promise<BakeLine> {
    const images = backend.images!;
    const image = this.#deps.images()[name];
    const what = label(name, backend.id, kind);
    if (!image || !this.#bakes(image, backend, kind)) return { name: what, outcome: "not started", detail: "it is no longer baked there" };
    if (await this.current(name, backend.id, kind)) return { name: what, outcome: "not started", detail: "its build is current" };
    const at = key(BAKE, name, backend.id, kind);
    const hash = scriptHash(image);
    const standard = this.#standard(await this.#builds(backend, true), kind);
    if (!standard) throw new Error(`${backend.id} has no standard ${kind} build to bake it on.`);
    const last = await this.#deps.storage.get<Bake>(at);
    this.#say(`baking ${what}, on ${standard.build ?? standard.ref}`);
    const started = this.#now();
    const signal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(SCRIPT_MS + 2 * CHECK_MS + 30 * 60_000)]);
    const made: string[] = [];
    const output: string[] = [];
    const text = new TextEncoder();
    try {
      const tar = spawnSync("tar", ["-C", this.#deps.setup, "-czf", "-", "proxmox-lxc/template"], { maxBuffer: 64 * 1024 * 1024 });
      if (tar.status !== 0) throw new Error(`tar could not pack the setup files: ${tar.stderr.toString().trim()}`);
      const box = await images.box(standard, `bake of ${name}`, signal);
      made.push(box.ref);
      await box.command.writeFile("bb-box-setup.tgz", tar.stdout, { signal });
      await box.command.writeFile(".bb-box-image/setup.sh", text.encode(image.script), { mode: "0700", signal });
      if (image.check) await box.command.writeFile(".bb-box-image/check.sh", text.encode(image.check), { mode: "0700", signal });
      const time = new Date(started).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      const buildId = `build.${time}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;
      const ran = await box.command.run(bakeScript(name, kind, backend.id, buildId, !!image.check), { timeoutMs: SCRIPT_MS + CHECK_MS, signal, maxOutputBytes: 512 * 1024 });
      output.push(...ran.stdout.trimEnd().split("\n").slice(-20));
      if (ran.exitCode !== 0) throw new Error(`${ran.timedOut ? "It ran out of time" : `It exited with ${ran.exitCode}`}: ${output.at(-1) ?? ""}`);

      // The standard build's record, as a project's image on it (049).
      const read = await box.command.run("cat /usr/share/bb-box/image.json", { timeoutMs: 15_000, signal, maxOutputBytes: 64 * 1024 });
      const finalized = recordFromJson(read.stdout.trim());
      if (!finalized) throw new Error("Finalizing wrote no image record.");
      const record: ImageRecord = {
        ...(standard.record ?? { ...finalized, kind }),
        image: name,
        build: buildId,
        built: new Date(this.#now()).toISOString(),
        base: standard.build,
        layer: { sha256: hash, seconds: Math.round((this.#now() - started) / 1000) },
        sizeGiB: finalized.sizeGiB,
      };
      const wrote = await box.command.run(`printf '%s\\n' ${quote(JSON.stringify(record))} | sudo -n tee /usr/share/bb-box/image.json >/dev/null`, { timeoutMs: 15_000, signal });
      if (wrote.exitCode !== 0) throw new Error(`The image's record could not be written: ${wrote.stderr.trim()}`);
      const captured = await images.capture(box, standard, name, signal);
      made.splice(made.indexOf(box.ref), 1, captured.ref);

      // The trial: a box of the build passes the image's check.
      const trial = await images.box(captured, `trial of ${name}`, signal);
      made.push(trial.ref);
      if (image.check) {
        await trial.command.writeFile(".bb-box-image/check.sh", text.encode(image.check), { mode: "0700", signal });
        const checked = await trial.command.run('bash "$HOME/.bb-box-image/check.sh" 2>&1; s=$?; rm -rf "$HOME/.bb-box-image"; exit $s', { timeoutMs: CHECK_MS, signal, maxOutputBytes: 256 * 1024 });
        if (checked.exitCode !== 0) throw new Error(`A box of the build failed the check: ${checked.stdout.trim().split("\n").at(-1) ?? ""}`);
      }
      await images.remove(trial.ref, signal);
      made.splice(made.indexOf(trial.ref), 1);

      // The build replaces the image's last one there.
      const now = this.#now();
      await this.#deps.storage.set(at, { ref: captured.ref, build: captured.build, script: hash, base: standard.build, at: now, used: last?.used ?? now } satisfies Bake);
      made.splice(made.indexOf(captured.ref), 1);
      await this.#deps.storage.delete(`${at}/failed`);
      if (last && last.ref !== captured.ref) await this.#retire(backend, last.ref);
      this.#lists.delete(backend.id);
      const seconds = Math.round((this.#now() - started) / 1000);
      this.#say(`baked ${what} as ${captured.ref}, in ${seconds} s`);
      return { name: what, outcome: "baked", detail: `now ${captured.build ?? captured.ref}, in ${seconds} s` };
    } catch (error) {
      await this.#deps.storage.set(`${at}/failed`, { at: this.#now(), reason: message(error), output, script: hash, base: standard.build } satisfies BakeFailure);
      throw error;
    } finally {
      // What the bake made and did not keep goes, the newest first.
      for (const ref of made.reverse()) await images.remove(ref).catch((error: unknown) => this.#say(`could not remove ${backend.id}/${ref}: ${message(error)}`));
    }
  }

  /** Removes a build, or keeps it for the nightly upkeep to try again while a box still uses it. */
  async #retire(backend: Backend, ref: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await backend.images!.remove(ref, signal);
      return true;
    } catch (error) {
      this.#say(`${backend.id}/${ref} stays until no box uses it: ${message(error)}`);
      const retired = (await this.#deps.storage.get<{ backend: string; ref: string }[]>(RETIRED)) ?? [];
      if (!retired.some((one) => one.backend === backend.id && one.ref === ref)) await this.#deps.storage.set(RETIRED, [...retired, { backend: backend.id, ref }]);
      return false;
    }
  }

  /**
   * After an image is set or removed (049): its builds out of date, as for
   * a changed script, are baked again, and for an image that says always,
   * those it lacks are baked; a removed image's builds go. In the
   * background, each after the bakes before it.
   */
  settle(name: string): void {
    void (async () => {
      const image = this.#deps.images()[name];
      if (!image) {
        await this.exclusive(async () => {
          for (const entry of await this.#deps.storage.list(`${BAKE}${name}/`)) {
            const { backend: backendId, kind } = parts(entry);
            const bake = entry.endsWith("/failed") ? null : await this.#deps.storage.get<Bake>(entry);
            const backend = this.#backend(backendId);
            // A backend that is off keeps it for the nightly upkeep once it is on.
            if (bake && !backend?.images) continue;
            await this.#deps.storage.delete(entry);
            await this.#deps.storage.delete(key(USAGE, name, backendId, kind));
            if (bake && backend) await this.#retire(backend, bake.ref);
          }
        });
        return;
      }
      const due = new Set<string>();
      for (const entry of await this.#deps.storage.list(`${BAKE}${name}/`)) {
        if (!entry.endsWith("/failed")) due.add(entry);
      }
      if (image.bake === "always") {
        for (const backend of this.#deps.backends()) for (const kind of image.kinds) due.add(key(BAKE, name, backend.id, kind));
      }
      for (const entry of due) {
        const { backend: backendId, kind } = parts(entry);
        const backend = this.#backend(backendId);
        if (backend && this.#bakes(image, backend, kind) && !(await this.current(name, backendId, kind))) void this.bake(name, backend, kind);
      }
    })().catch((error: unknown) => this.#say(`could not bake ${name} again: ${message(error)}`));
  }

  /**
   * The nightly upkeep (049), after the standard images' rebuilds. Builds
   * go that no box started from for 30 days, or whose image no longer
   * covers their kind, and builds left by a bake that did not end. Then
   * builds out of date that boxes started from within 14 days are baked
   * again, and those an image that says always lacks are baked, one at a
   * time, none after `until`.
   */
  async maintain(options: { until?: number; signal?: AbortSignal } = {}): Promise<BakeLine[]> {
    const lines: BakeLine[] = [];
    const due: { name: string; backend: Backend; kind: string }[] = [];
    await this.exclusive(async () => {
      const images = this.#deps.images();
      const kept = new Set<string>();
      for (const entry of await this.#deps.storage.list(BAKE)) {
        const { name, backend: backendId, kind } = parts(entry);
        const image = images[name];
        const gone = !image || !image.kinds.includes(kind) || image.bake === "never";
        if (entry.endsWith("/failed")) {
          if (gone) await this.#deps.storage.delete(entry);
          continue;
        }
        const bake = await this.#deps.storage.get<Bake>(entry);
        const backend = this.#backend(backendId);
        if (!bake || !backend?.images) continue;
        const idle = this.#now() - bake.used > UNUSED_DAYS * DAY_MS && image?.bake !== "always";
        if (gone || idle) {
          await this.#deps.storage.delete(entry);
          await this.#deps.storage.delete(key(USAGE, name, backendId, kind));
          await this.#retire(backend, bake.ref, options.signal);
          lines.push({ name: label(name, backendId, kind), outcome: "removed", detail: gone ? "its image no longer covers the kind there" : `no box started from it for ${UNUSED_DAYS} days` });
          continue;
        }
        kept.add(`${backendId}/${bake.ref}`);
        const recent = this.#now() - bake.used <= USE_DAYS * DAY_MS || image!.bake === "always";
        if (recent && this.#bakes(image!, backend, kind) && !(await this.current(name, backendId, kind))) due.push({ name, backend, kind });
      }
      // Builds again, and builds of projects' images that no bake names, left by one that did not end.
      const retired = (await this.#deps.storage.get<{ backend: string; ref: string }[]>(RETIRED)) ?? [];
      const left: { backend: string; ref: string }[] = [];
      for (const one of retired) {
        const backend = this.#backend(one.backend);
        if (backend?.images) await backend.images.remove(one.ref, options.signal).catch(() => left.push(one));
        else left.push(one);
      }
      await this.#deps.storage.set(RETIRED, left);
      for (const backend of this.#deps.backends()) {
        if (!backend.images?.startsFrom) continue;
        for (const build of await this.#builds(backend, true)) {
          if (build.image === "standard" || kept.has(`${backend.id}/${build.ref}`) || left.some((one) => one.backend === backend.id && one.ref === build.ref)) continue;
          if (await this.#retire(backend, build.ref, options.signal)) lines.push({ name: label(build.image, backend.id, build.kind), outcome: "removed", detail: `${build.ref} was left by a bake that did not end` });
        }
        this.#lists.delete(backend.id);
      }
      for (const [name, image] of Object.entries(images)) {
        if (image.bake !== "always") continue;
        for (const backend of this.#deps.backends()) {
          for (const kind of image.kinds) {
            if (!this.#bakes(image, backend, kind) || due.some((one) => one.name === name && one.backend === backend && one.kind === kind)) continue;
            if (!(await this.current(name, backend.id, kind))) due.push({ name, backend, kind });
          }
        }
      }
    });
    for (const { name, backend, kind } of due) {
      if (options.signal?.aborted || (options.until !== undefined && this.#now() >= options.until)) {
        lines.push({ name: label(name, backend.id, kind), outcome: "not started", detail: options.signal?.aborted ? "the run was stopped" : "the run's time limit came first" });
        continue;
      }
      lines.push(await this.bake(name, backend, kind));
    }
    return lines;
  }

  /** An image's builds and failed bakes, for bb box image list: a line each. */
  async lines(name: string): Promise<string[]> {
    const lines: string[] = [];
    const day = (time: number) => new Date(time).toISOString().slice(0, 10);
    for (const entry of await this.#deps.storage.list(`${BAKE}${name}/`)) {
      const { backend, kind } = parts(entry);
      if (entry.endsWith("/failed")) {
        const failure = await this.#deps.storage.get<BakeFailure>(entry);
        if (failure) lines.push(`its build for ${kind} on ${backend} failed on ${day(failure.at)}: ${failure.reason}`);
        continue;
      }
      const bake = await this.#deps.storage.get<Bake>(entry);
      if (!bake) continue;
      const current = await this.current(name, backend, kind);
      lines.push(`built for ${kind} on ${backend}: ${bake.build ?? bake.ref}, ${current ? "current" : "out of date"}, last used ${day(bake.used)}`);
    }
    return lines;
  }

  /** The doctor's checks: each image whose last bake failed. */
  async checks(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    for (const entry of await this.#deps.storage.list(BAKE)) {
      if (!entry.endsWith("/failed")) continue;
      const failure = await this.#deps.storage.get<BakeFailure>(entry);
      if (!failure) continue;
      const { name, backend, kind } = parts(entry);
      checks.push({
        id: `images.bake.${name}.${backend}.${kind}`,
        name: `Build of ${label(name, backend, kind)}`,
        status: "warn",
        detail: `Its last build, on ${new Date(failure.at).toISOString().slice(0, 10)}, failed: ${failure.reason.replace(/\.?$/, ".")} Its boxes run its script as they start meanwhile.`,
        fix: `Fix its script, then set the image again with bb box image set ${name} or box_image_set, which builds it again.`,
      });
    }
    return checks;
  }

  stop(): void {
    this.#stop.abort(new Error("bb-box is stopping."));
  }
}

/**
 * The bake in its box: the setup files in place, the image's script as root
 * and its check as the box user, with the variables a box's run at start
 * has, then finalizing as for a standard image. What finalizing writes from
 * the setup files' pins is put back as the standard build had it.
 */
export function bakeScript(name: string, kind: string, backend: string, buildId: string, check: boolean): string {
  const src = `${BUILD_DIR}/proxmox-lxc/template`;
  const env = `BB_BOX_IMAGE=${quote(name)} BB_BOX_KIND=${quote(kind)} BB_BOX_BACKEND=${quote(backend)} BB_BOX_ARCH="$(uname -m | sed s/aarch64/arm64/)"`;
  const keep = "/usr/share/bb-box/.bake-keep";
  return [
    "set -euo pipefail",
    "exec 2>&1",
    `sudo -n rm -rf ${BUILD_DIR} && sudo -n install -d -m 0700 ${BUILD_DIR}`,
    `sudo -n tar -xzf ~/bb-box-setup.tgz -C ${BUILD_DIR} && rm -f ~/bb-box-setup.tgz`,
    `printf 'BOX_USER=box\\nBUILD_ID=%s\\n' ${quote(buildId)} | sudo -n tee ${src}/build.env >/dev/null`,
    // The release lines finalizing does not write itself, such as runtime=docker and nvidia=.
    `{ grep -vE '^(kind|built|apt_snapshot|tool)=' /usr/share/bb-box/template-release || true; } | sudo -n tee ${src}/extra-release >/dev/null`,
    `echo "bake: ${name}'s script, as root"`,
    `sudo -n env ${env} bash "$HOME/.bb-box-image/setup.sh"`,
    ...(check ? [`echo "bake: ${name}'s check"`, `env ${env} bash "$HOME/.bb-box-image/check.sh"`] : []),
    'rm -rf "$HOME/.bb-box-image"',
    `sudo -n rm -rf ${keep} && sudo -n install -d ${keep}`,
    `for file in template-release template-pins.json; do [ ! -f /usr/share/bb-box/$file ] || sudo -n cp -p /usr/share/bb-box/$file ${keep}/; done`,
    `sudo -n bash ${src}/guest/finalize.sh ${src} ${kind === "linux" ? "linux" : "desktop"}`,
    `sudo -n sh -c 'cp -p ${keep}/* /usr/share/bb-box/ 2>/dev/null; rm -rf ${keep}'`,
  ].join("\n");
}
