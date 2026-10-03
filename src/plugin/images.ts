/**
 * The nightly rebuilds of the standard images (049): what is due, most
 * needed first, a refresh of each in turn within a time limit, what each
 * last did, and the doctor's checks of them. `bb box images refresh`, which
 * a BB script automation runs each night, starts a run here and waits for
 * it; the run goes on should the command's call end first.
 */
import { createHash } from "node:crypto";
import { judgeImage, type ImageFacts, type PinSet } from "../backends/images.ts";
import type { Backend, BackendStorage, DoctorCheck, ImageBuild } from "../backends/types.ts";
import { resolveVersions, type Versions } from "../backends/versions.ts";
import { refreshImage, type RefreshResult } from "../core/refresh.ts";
import { defaultSize, kindSizes } from "../core/sizes.ts";

/** The days after which a standard image is due (049): a week for Linux, a month for macOS and Windows. */
const INTERVAL_DAYS = { linux: 7, macos: 30, windows: 30 } as const;
/** A refresh run stops starting images after this long (049). */
export const RUN_LIMIT_MS = 4 * 60 * 60_000;
/** The doctor warns when no run has ended for this long (049). */
const NIGHTLY_WARN_DAYS = 8;
/** A run's lock older than this is a run that died. */
const LOCK_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const STATE = "images/state/";
const LAST_RUN = "images/last-run";
const LOCK = "images/lock";

/** The automation that runs the job each night, as the setup guide gives it. */
export const AUTOMATION = 'bb automation create --project <project> --name "bb-box images" --cron "0 2 * * *" --timezone <zone> --script "bb box images refresh" --timeout 900000';

export interface ImageJobsDeps {
  /** The backends that are on. */
  backends(): readonly Backend[];
  /** The plugin's setup/ directory. */
  readonly setup: string;
  /** BB's server URL, for images to have BB's app, or null. */
  bbUrl(): string | null;
  readonly facts: ImageFacts;
  readonly storage: BackendStorage;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** Replace refreshImage and resolveVersions, for tests. */
  readonly refresh?: typeof refreshImage;
  readonly versions?: typeof resolveVersions;
}

/** What an image's last rebuild did. */
export interface ImageState {
  readonly at: number;
  readonly ok: boolean;
  /** Why it failed, or why it waits, or null. */
  readonly reason: string | null;
  /** "waiting" when it did not start for want of room. */
  readonly waiting?: boolean;
  readonly build: string | null;
  readonly seconds: number;
  /** Its build's last lines. */
  readonly output: readonly string[];
  /** What it was built from: a failed image is not tried again until this changes (049). */
  readonly from: string;
}

export interface ImageView {
  /** <backend>/<ref>, as bb box images build takes it. */
  readonly name: string;
  readonly backend: string;
  readonly build: ImageBuild;
  /** Why it is due, or null when it is not. */
  readonly due: string | null;
  readonly last: ImageState | null;
}

export interface RunLine {
  readonly name: string;
  readonly outcome: "refreshed" | "failed" | "skipped" | "waiting" | "not started";
  readonly detail: string;
}

export interface RunResult {
  readonly ok: boolean;
  readonly lines: readonly RunLine[];
  readonly seconds: number;
}

/** A kind's OS and pins, by its name. */
function osOf(kind: string): "linux" | "macos" | "windows" {
  return kind.startsWith("macos") ? "macos" : kind.startsWith("windows") ? "windows" : "linux";
}
function pinSet(kind: string): PinSet {
  return osOf(kind) === "macos" ? "macos" : kind.includes("desktop") ? "linux-desktop" : "linux";
}

export class ImageJobs {
  readonly #deps: ImageJobsDeps;
  #running: { readonly started: number; readonly done: Promise<RunResult>; readonly stop: AbortController } | null = null;

  constructor(deps: ImageJobsDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** The standard builds bb-box can refresh, on each backend that is on: Linux and macOS, as Windows is later. */
  async #standard(signal?: AbortSignal): Promise<{ backend: Backend; build: ImageBuild }[]> {
    const found: { backend: Backend; build: ImageBuild }[] = [];
    for (const backend of this.#deps.backends()) {
      if (!backend.images) continue;
      const { builds } = await backend.images.list(signal).catch((error: unknown) => {
        this.#deps.log?.(`images: ${backend.id} did not list its images: ${error instanceof Error ? error.message : String(error)}`);
        return { builds: [] as ImageBuild[] };
      });
      for (const build of builds) if (build.current && build.image === "standard" && osOf(build.kind) !== "windows") found.push({ backend, build });
    }
    return found;
  }

  /** Why an image is due (049), in the decision's order of need, or null: [rank, reason]. */
  async #why(build: ImageBuild, app: string | null): Promise<[number, string] | null> {
    const os = osOf(build.kind);
    const pins = await this.#deps.facts.pins(pinSet(build.kind)).catch(() => null);
    const record = build.record;
    if (record && judgeImage(record, { os, pins, bbApp: os === "linux" ? app : null, now: this.#now() }, "").status === "fail") return [1, "it fails the doctor"];
    if (!record) return [2, "it has no record, so its age is not known"];
    const days = (this.#now() - Date.parse(record.built)) / DAY_MS;
    if (days > INTERVAL_DAYS[os]) return [2, `it is ${Math.floor(days)} days old, past its ${INTERVAL_DAYS[os]}-day interval`];
    if (os === "linux" && app && record.bbApp !== app) return [4, "it has another build of BB's app than BB's server gives"];
    if (pins && record.pins !== pins) return [5, "it was built with other pins than this bb-box's"];
    return null;
  }

  async #state(name: string): Promise<ImageState | null> {
    return (await this.#deps.storage.get<ImageState>(`${STATE}${name}`)) ?? null;
  }

  /** Every refreshable image, with why it is due and what its last rebuild did, most needed first. */
  async list(signal?: AbortSignal): Promise<ImageView[]> {
    const app = await this.#deps.facts.bbApp(signal).catch(() => null);
    const views: (ImageView & { rank: number })[] = [];
    for (const { backend, build } of await this.#standard(signal)) {
      const name = `${backend.id}/${build.ref}`;
      const why = await this.#why(build, app);
      views.push({ name, backend: backend.id, build, due: why?.[1] ?? null, last: await this.#state(name), rank: why?.[0] ?? 9 });
    }
    return views.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map(({ rank: _, ...view }) => view);
  }

  /** What an image is built from now: its pins, BB's app, the versions a rebuild takes, and its current build. */
  #from(build: ImageBuild, pins: string | null, app: string | null, versions: Versions | null): string {
    const tools = versions?.tools.filter((tool) => tool.arch === (build.record?.arch === "arm64" ? "arm64" : "x86_64")).map((tool) => `${tool.name}@${tool.version}`) ?? [];
    return createHash("sha256").update(JSON.stringify({ pins, app, tools, current: build.build })).digest("hex").slice(0, 16);
  }

  /** Whether a run is going on, and since when. */
  running(): number | null {
    return this.#running?.started ?? null;
  }

  /**
   * Refreshes the due images one at a time, most needed first, and starts
   * none after `limitMs`. A run already going on is joined, not doubled.
   * Image boxes left by a run that did not end go first. An image whose last
   * rebuild failed is not tried again until what it is built from changes.
   */
  refreshAll(options: { pinned?: boolean; limitMs?: number; log?: (line: string) => void } = {}): Promise<RunResult> {
    if (this.#running) return this.#running.done;
    const stop = new AbortController();
    const started = this.#now();
    const done = this.#run(options, stop.signal).finally(() => {
      this.#running = null;
    });
    this.#running = { started, done, stop };
    return done;
  }

  /** Stops a run: the image being refreshed fails, its old build stays, and no other starts. */
  stop(): void {
    this.#running?.stop.abort(new Error("bb-box is stopping."));
  }

  async #run(options: { pinned?: boolean; limitMs?: number; log?: (line: string) => void }, signal: AbortSignal): Promise<RunResult> {
    const started = this.#now();
    const say = (line: string) => {
      options.log?.(line);
      this.#deps.log?.(`images: ${line}`);
    };
    const lock = await this.#deps.storage.get<{ at: number }>(LOCK);
    if (lock && started - lock.at < LOCK_MS) {
      return { ok: false, lines: [{ name: "images", outcome: "not started", detail: `Another run started at ${new Date(lock.at).toISOString()} and has not ended.` }], seconds: 0 };
    }
    await this.#deps.storage.set(LOCK, { at: started });
    const lines: RunLine[] = [];
    try {
      // Image boxes and refresh builds left by a run that did not end.
      for (const backend of this.#deps.backends()) {
        if (!backend.images) continue;
        const left = await backend.images.list(signal).catch(() => ({ boxes: [] as string[], builds: [] as ImageBuild[] }));
        const refs = [...left.boxes, ...left.builds.filter((build) => !build.current && build.image === "standard").map((build) => build.ref)];
        for (const ref of refs) {
          say(`removing ${backend.id}/${ref}, left by a run that did not end`);
          await backend.images.remove(ref, signal).catch((error: unknown) => say(`could not remove ${backend.id}/${ref}: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      const versions = await (this.#deps.versions ?? resolveVersions)(this.#deps.setup, { pinned: !!options.pinned, signal }).catch(() => null);
      const app = await this.#deps.facts.bbApp(signal).catch(() => null);
      const views = await this.list(signal);
      const limit = started + (options.limitMs ?? RUN_LIMIT_MS);
      for (const view of views) {
        if (!view.due) continue;
        if (signal.aborted || this.#now() >= limit) {
          lines.push({ name: view.name, outcome: "not started", detail: signal.aborted ? "the run was stopped" : "the run's time limit came first" });
          continue;
        }
        const backend = this.#deps.backends().find((candidate) => candidate.id === view.backend)!;
        const pins = await this.#deps.facts.pins(pinSet(view.build.kind)).catch(() => null);
        const from = this.#from(view.build, pins, app, versions);
        if (view.last && !view.last.ok && !view.last.waiting && view.last.from === from) {
          lines.push({ name: view.name, outcome: "skipped", detail: `its last rebuild failed and nothing it is built from has changed; bb box images build ${view.name} tries again` });
          continue;
        }
        // Room for the build's boxes, as for any two boxes of the kind at its default size (049).
        if (backend.kinds().some((kind) => kind.id === view.build.kind)) {
          const size = defaultSize(kindSizes(view.build.kind));
          const room = await backend.capacity(view.build.kind, size, [{ kind: view.build.kind, size }], signal).catch(() => null);
          if (room && !room.ok) {
            const reason = `no room for its build and trial boxes: ${room.message ?? "the host is full"}`;
            await this.#record(view.name, { at: this.#now(), ok: false, waiting: true, reason, build: view.build.build, seconds: 0, output: [], from });
            lines.push({ name: view.name, outcome: "waiting", detail: reason });
            continue;
          }
        }
        say(`refreshing ${view.name}: ${view.due}`);
        const result = await this.#refreshOne(backend, view, { pinned: !!options.pinned, replace: true, signal, from, log: (line) => say(`${view.name}: ${line}`) });
        lines.push(result.ok ? { name: view.name, outcome: "refreshed", detail: `now ${result.build?.build ?? "a new build"}, in ${result.seconds} s` } : { name: view.name, outcome: "failed", detail: result.reason ?? "no reason given" });
      }
      for (const view of views) if (!view.due) lines.push({ name: view.name, outcome: "skipped", detail: "not due" });
      const ok = !lines.some((line) => line.outcome === "failed");
      await this.#deps.storage.set(LAST_RUN, { at: this.#now(), ok, lines });
      return { ok, lines, seconds: Math.round((this.#now() - started) / 1000) };
    } finally {
      await this.#deps.storage.delete(LOCK);
    }
  }

  async #record(name: string, state: ImageState): Promise<void> {
    await this.#deps.storage.set(`${STATE}${name}`, state);
  }

  async #refreshOne(
    backend: Backend,
    view: ImageView,
    options: { pinned: boolean; replace: boolean; signal: AbortSignal; from: string; log: (line: string) => void },
  ): Promise<RefreshResult> {
    const result = await (this.#deps.refresh ?? refreshImage)({
      images: backend.images!,
      current: view.build,
      setup: this.#deps.setup,
      bbUrl: this.#deps.bbUrl(),
      bbApp: await this.#deps.facts.bbApp(options.signal).catch(() => null),
      pinned: options.pinned,
      replace: options.replace,
      signal: options.signal,
      log: options.log,
    });
    // A try changes nothing, so it records nothing.
    if (options.replace) {
      await this.#record(view.name, { at: this.#now(), ok: result.ok, reason: result.reason, build: result.build?.build ?? view.build.build, seconds: result.seconds, output: result.output, from: options.from });
    }
    return result;
  }

  /** Rebuilds one image now, due or not, and whatever its last rebuild did: `bb box images build <name>`. */
  async build(name: string, options: { pinned?: boolean; try?: boolean; signal: AbortSignal; log?: (line: string) => void }): Promise<RefreshResult> {
    const views = await this.list(options.signal);
    const view = views.find((candidate) => candidate.name === name);
    if (!view) throw new Error(`There is no image ${name}. bb box images list names them: ${views.map((other) => other.name).join(", ") || "none"}.`);
    const backend = this.#deps.backends().find((candidate) => candidate.id === view.backend)!;
    const pins = await this.#deps.facts.pins(pinSet(view.build.kind)).catch(() => null);
    const app = await this.#deps.facts.bbApp(options.signal).catch(() => null);
    const versions = await (this.#deps.versions ?? resolveVersions)(this.#deps.setup, { pinned: !!options.pinned, signal: options.signal }).catch(() => null);
    return this.#refreshOne(backend, view, {
      pinned: !!options.pinned,
      replace: !options.try,
      signal: options.signal,
      from: this.#from(view.build, pins, app, versions),
      log: options.log ?? (() => {}),
    });
  }

  /** The doctor's checks (049): "Nightly rebuilds", and each image whose last rebuild failed or waits for room. */
  async checks(signal?: AbortSignal): Promise<DoctorCheck[]> {
    const views = await this.list(signal).catch(() => [] as ImageView[]);
    if (!views.length) return [];
    const checks: DoctorCheck[] = [];
    const last = await this.#deps.storage.get<{ at: number; ok: boolean }>(LAST_RUN);
    const days = last ? (this.#now() - last.at) / DAY_MS : null;
    checks.push(
      days !== null && days <= NIGHTLY_WARN_DAYS
        ? { id: "images.nightly", name: "Nightly rebuilds", status: "ok", detail: `The last run ended ${days < 1 ? "today" : `${Math.floor(days)} days ago`}${last!.ok ? "" : ", with a failure"}.`, fix: null }
        : {
            id: "images.nightly",
            name: "Nightly rebuilds",
            status: "warn",
            detail: days === null ? "No run of bb box images refresh has ended yet, so images are rebuilt only by hand." : `No run of bb box images refresh has ended for ${Math.floor(days)} days.`,
            fix: `Have a BB script automation run it each night: ${AUTOMATION}`,
          },
    );
    for (const view of views) {
      if (!view.last || view.last.ok) continue;
      const when = new Date(view.last.at).toISOString().slice(0, 10);
      checks.push({
        id: `images.${view.name}`,
        name: `Rebuild of ${view.name}`,
        status: "warn",
        detail: view.last.waiting
          ? `On ${when} it waited: ${(view.last.reason ?? "").replace(/\.$/, "")}. It waits for the next night.`
          : `Its last rebuild, on ${when}, failed: ${view.last.reason ?? "no reason given"}${view.last.output.length ? ` Its last line: ${view.last.output.at(-1)}` : ""}`,
        fix: view.last.waiting ? "Free room on the host, or lower its reserve." : `Fix the cause, then run bb box images build ${view.name}. bb box images list shows its last lines.`,
      });
    }
    return checks;
  }
}
