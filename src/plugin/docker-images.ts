// Building bb-box's images on a BB machine that hosts Docker boxes (042).
// Turning a machine on builds any image its Docker backend runs that the
// machine lacks, or has from another layout: bb-box's setup/docker/build.sh
// runs on BB's server with DOCKER_HOST at the machine's relay socket, as
// `docker build` sends its files through Docker's API. Images are built, not
// copied, as everywhere. One build at a time per machine; the settings row
// shows it until it ends. build.sh does not start with less disk free than
// the build needs, about 36 GB for all three images, and says how much is free.
//
// When BB has a public URL, the images have BB's host app from it, so a box
// enrols without downloading it, and an image with another build of the app
// is built again: only its last layer, with the app, changes (#95).

import { spawn } from "node:child_process";
import { LABELS } from "../backends/docker/cli.ts";
import { IMAGE_VERSION } from "../backends/docker/config.ts";
import { IMAGE_CONTRACT, recordFromJson } from "../backends/images.ts";

/** What build.sh builds: its target, by the image it tags. */
export const BUILT_IMAGES: Readonly<Record<string, "linux" | "desktop" | "desktop-wayland">> = {
  [`bbbox/linux:${IMAGE_VERSION}`]: "linux",
  [`bbbox/linux-desktop:${IMAGE_VERSION}`]: "desktop",
  [`bbbox/linux-desktop-wayland:${IMAGE_VERSION}`]: "desktop-wayland",
};

/** The disk a machine needs free to build all three images, in GB, as build.sh checks before it starts. */
export const BUILD_FREE_GB = 36;

export interface ImageBuild {
  readonly state: "checking" | "building" | "built" | "failed";
  /** The targets being built, or built. */
  readonly targets: readonly string[];
  /** The build's last line of output while it runs, or why it failed. */
  readonly detail: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface DockerImagesDeps {
  /** bb-box's setup/docker/build.sh, or null when this install has none. */
  readonly script: string | null;
  /** The images the machine's Docker backend runs. */
  images(hostId: string): readonly string[];
  /** The docker CLI's host for the machine, ready for use. */
  host(hostId: string): Promise<string>;
  /**
   * Whether the machine lacks `image`, or has it from another layout, or,
   * with `app` not null, with another build of BB's app than `app`.
   */
  stale(hostId: string, image: string, app: string | null): Promise<boolean>;
  /** BB's URL that boxes enrol from, for the images to have BB's app, or null for none. */
  appUrl?(): string | null;
  /** The digest of BB's app on the server at `url`, or null when it gives none. */
  appDigest?(url: string): Promise<string | null>;
  /** Says a machine's build changed, for the settings page. */
  changed(hostId: string): void;
  logError(operation: string, error: unknown): void;
  log?(message: string): void;
  /** Runs build.sh with `args`; spawn by default. Resolves with its exit code. */
  run?(script: string, args: readonly string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void): Promise<number | null>;
  now?(): number;
}

/**
 * Whether an image with `labels` needs building again: it has no record
 * (049) or an older contract, or, with `app` not null, another build of BB's
 * app.
 */
export function outdated(labels: Readonly<Record<string, unknown>>, app: string | null): boolean {
  const record = recordFromJson(labels[LABELS.imageRecord]);
  return !record || record.contract < IMAGE_CONTRACT || (app !== null && record.bbApp !== app);
}

/** The digest of BB's app on the server at `url`, from the header build.sh reads, or null when it gives none. */
export async function bbAppDigest(url: string): Promise<string | null> {
  const response = await fetch(`${url.replace(/\/+$/, "")}/install/bb-app.tgz`, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
  const digest = response.ok ? response.headers.get("x-bb-artifact-sha256") : null;
  return digest && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function run(script: string, args: readonly string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let rest = "";
    const read = (chunk: Buffer) => {
      const lines = (rest + chunk.toString("utf8")).split(/\r?\n|\r/);
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => {
      onLine(`bb-box could not run build.sh: ${error.message}`);
      resolve(null);
    });
    child.on("close", (code) => {
      if (rest.trim()) onLine(rest);
      resolve(code);
    });
  });
}

export class DockerImages {
  readonly #deps: DockerImagesDeps;
  readonly #builds = new Map<string, ImageBuild>();
  readonly #running = new Map<string, Promise<ImageBuild>>();

  constructor(deps: DockerImagesDeps) {
    this.#deps = deps;
  }

  /** The machine's last build, or the one running. */
  state(hostId: string): ImageBuild | null {
    return this.#builds.get(hostId) ?? null;
  }

  /** Builds what the machine lacks, unless a build is running there already. Resolves when it ends. */
  ensure(hostId: string): Promise<ImageBuild> {
    const running = this.#running.get(hostId);
    if (running) return running;
    const build = this.#build(hostId).finally(() => this.#running.delete(hostId));
    this.#running.set(hostId, build);
    return build;
  }

  async #build(hostId: string): Promise<ImageBuild> {
    const now = () => this.#deps.now?.() ?? Date.now();
    const startedAt = now();
    let current: ImageBuild = { state: "checking", targets: [], detail: null, startedAt, endedAt: null };
    const set = (next: Partial<ImageBuild>) => {
      current = { ...current, ...next };
      this.#builds.set(hostId, current);
      this.#deps.changed(hostId);
      return current;
    };
    set({});
    try {
      const images = this.#deps.images(hostId);
      const unknown = images.filter((image) => !BUILT_IMAGES[image]);
      const url = this.#deps.appUrl?.() ?? null;
      const app = url ? await this.#appDigest(url) : null;
      const stale: string[] = [];
      for (const image of images.filter((each) => BUILT_IMAGES[each])) if (await this.#deps.stale(hostId, image, app)) stale.push(image);
      const targets = [...new Set(stale.map((image) => BUILT_IMAGES[image]!))];
      if (!targets.length) {
        return set({ state: "built", detail: unknown.length ? `bb-box does not build ${unknown.join(", ")}; load it on the machine.` : null, endedAt: now() });
      }
      if (!this.#deps.script) {
        return set({ state: "failed", targets, detail: "This install of bb-box has no setup/docker/build.sh to build the images with.", endedAt: now() });
      }
      const host = await this.#deps.host(hostId);
      set({ state: "building", targets, detail: `Building ${targets.join(" and ")}` });
      this.#deps.log?.(`Building ${targets.join(" and ")} on BB machine ${hostId}.`);
      const tail: string[] = [];
      const args = url && app ? ["--bb-url", url, ...targets] : targets;
      const code = await (this.#deps.run ?? run)(this.#deps.script, args, { ...process.env, DOCKER_HOST: host }, (line) => {
        const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
        if (!clean) return;
        tail.push(clean);
        if (tail.length > 5) tail.shift();
        set({ detail: clean.slice(0, 300) });
      });
      if (code === 0) {
        this.#deps.log?.(`Built ${targets.join(" and ")} on BB machine ${hostId} in ${Math.round((now() - startedAt) / 1000)} s.`);
        return set({ state: "built", detail: null, endedAt: now() });
      }
      const why = tail.join(" ").slice(-500);
      const full = /no space left on device/i.test(why) ? ` The machine ran out of disk: building all three images needs about ${BUILD_FREE_GB} GB free.` : "";
      return set({ state: "failed", detail: `build.sh exited with ${code ?? "no code"}: ${why}${full}`, endedAt: now() });
    } catch (error) {
      this.#deps.logError("docker images", error);
      return set({ state: "failed", detail: message(error), endedAt: now() });
    }
  }

  /** BB's app's digest, or null when the server does not say: the images are then built without it. */
  async #appDigest(url: string): Promise<string | null> {
    try {
      return (await this.#deps.appDigest?.(url)) ?? null;
    } catch (error) {
      this.#deps.logError("BB's app digest", error);
      return null;
    }
  }
}
