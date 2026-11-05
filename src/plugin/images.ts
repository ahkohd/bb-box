/**
 * The nightly rebuilds of the standard images (049): what is due, most
 * needed first, a refresh of each in turn within a time limit, what each
 * last did, and the doctor's checks of them. `bb box images refresh`, which
 * a BB script automation runs each night, starts a run here and waits for
 * it; the run goes on should the command's call end first. Projects'
 * images' builds are kept in order after the rebuilds (bakes.ts). After a
 * BB update, the Linux images with BB's old app are refreshed within the
 * hour rather than at night (afterBbUpdate).
 */
import { createHash } from "node:crypto";
import { judgeImage, prepareDigest, type ImageFacts, type PinSet } from "../backends/images.ts";
import type { Backend, BackendStorage, DoctorCheck, ImageBuild } from "../backends/types.ts";
import { resolveVersions, type Versions } from "../backends/versions.ts";
import { refreshImage, type RefreshResult } from "../core/refresh.ts";
import { defaultSize, kindSizes } from "../core/sizes.ts";
import type { ImageBakes } from "./bakes.ts";

/** The days after which a standard image is due (049): a week for Linux, a month for macOS and Windows. */
const INTERVAL_DAYS = { linux: 7, android: 30, macos: 30, ios: 30, windows: 30 } as const;
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
const BB_UPDATE = "images/bb-update";
/**
 * After BB's server gives another build of BB's app, as after a BB update, the images that carry the old one are
 * refreshed this long after bb-box notices, rather than at night (the operator, 11 October 2026): time for BB to settle,
 * and, with a look every few minutes, well within the hour.
 */
export const BB_UPDATE_DELAY_MS = 15 * 60_000;

/** A BB update bb-box noticed: the app's build, when it noticed, and when its refresh started. */
interface BbUpdate {
  readonly app: string;
  readonly noticed: number;
  readonly started: number | null;
}

/** A refresh that starts soon, for a BB update: when, and the images it takes. */
export interface DueSoon {
  readonly at: number;
  readonly names: readonly string[];
}

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
  /** Projects' images' builds: no bake while a run removes what runs left, and their upkeep after the rebuilds. */
  readonly bakes?: Pick<ImageBakes, "exclusive" | "maintain">;
  readonly log?: (line: string) => void;
  /** Says a run's progress changed: an image started or ended, or a build's step moved. */
  readonly changed?: () => void;
  /** Whether a BB update starts a refresh of the images it leaves behind: General's nightly switch. Off without it. */
  readonly afterBbUpdates?: () => boolean;
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
  readonly kind?: string;
}

export interface StandardImageFailure {
  readonly name: string;
  readonly backend: string;
  readonly kind: string | null;
  readonly at: number;
  readonly reason: string;
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

export interface RunOptions {
  readonly pinned?: boolean;
  readonly limitMs?: number;
  readonly log?: (line: string) => void;
  /** "bb-app": only the images that carry another build of BB's app than BB's server gives, after a BB update; the night does the rest. */
  readonly only?: "bb-app";
  readonly image?: string;
}

/** Where a refresh run is, image by image, for the settings page's Rebuild now: the run going on, or the last one. */
export interface RunProgress {
  readonly started: number;
  /** When it ended, or null while it runs. */
  readonly ended: number | null;
  /** "bb-app" for a BB update's run. */
  readonly only: "bb-app" | null;
  /** The images it takes, in turn. */
  readonly images: readonly {
    readonly name: string;
    readonly kind: string;
    readonly state: "next" | "refreshing" | "refreshed" | "failed" | "waiting" | "skipped" | "not started";
    readonly detail: string | null;
    /** While it refreshes: when it started, its last line, and the step a Docker build last started. */
    readonly since?: number;
    readonly line?: string | null;
    readonly step?: { readonly at: number; readonly of: number };
  }[];
}

export interface RunLine {
  readonly name: string;
  readonly outcome: "refreshed" | "baked" | "removed" | "failed" | "skipped" | "waiting" | "not started";
  readonly detail: string;
}

export interface RunResult {
  readonly ok: boolean;
  readonly lines: readonly RunLine[];
  readonly seconds: number;
}

/** A kind's OS and pins, by its name. */
function osOf(kind: string): keyof typeof INTERVAL_DAYS {
  return kind === "android" ? "android" : kind === "ios" ? "ios" : kind.startsWith("macos") ? "macos" : kind.startsWith("windows") ? "windows" : "linux";
}
function carriesBbApp(kind: string): boolean {
  return osOf(kind) === "linux" || osOf(kind) === "android";
}
function pinSet(kind: string): PinSet {
  if (osOf(kind) === "windows") return kind.includes("arm64") ? "windows-arm64" : "windows";
  if (osOf(kind) === "android") return "android";
  if (osOf(kind) === "ios") return "ios";
  return osOf(kind) === "macos" ? "macos" : kind.includes("desktop") ? "linux-desktop" : "linux";
}

function macosBuildBeside(build: ImageBuild, backend: Backend, standard: readonly { readonly backend: Backend; readonly build: ImageBuild }[]): string | null {
  if (osOf(build.kind) !== "ios") return null;
  const host = build.ref.split("/")[0];
  return standard.find((other) => other.backend === backend && osOf(other.build.kind) === "macos" && other.build.ref.split("/")[0] === host)?.build.build ?? null;
}

export class ImageJobs {
  readonly #deps: ImageJobsDeps;
  #running: { readonly started: number; readonly done: Promise<RunResult>; readonly stop: AbortController; readonly only?: "bb-app" } | null = null;
  #progress: RunProgress | null = null;

  constructor(deps: ImageJobsDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** The standard builds bb-box can refresh, on each backend that is on: Linux and macOS, and Windows where the backend refreshes it (054). */
  #unlistable: string[] = [];

  /** Backends that are on whose image list failed, from the last list. */
  unlistable(): readonly string[] {
    return this.#unlistable;
  }

  async #standard(signal?: AbortSignal): Promise<{ backend: Backend; build: ImageBuild }[]> {
    const found: { backend: Backend; build: ImageBuild }[] = [];
    const problems: string[] = [];
    for (const backend of this.#deps.backends()) {
      if (!backend.images) continue;
      const { builds } = await backend.images.list(signal).catch((error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        this.#deps.log?.(`images: ${backend.id} did not list its images: ${why}`);
        problems.push(`${backend.label} did not list its images: ${why}`);
        return { builds: [] as ImageBuild[] };
      });
      for (const build of builds) if (build.current && build.image === "standard" && (osOf(build.kind) !== "windows" || backend.images.windows)) found.push({ backend, build });
    }
    this.#unlistable = problems;
    return found;
  }

  /** Whether a Linux image carries another build of BB's app than BB's server gives: one a BB update leaves behind. */
  #appStale(build: ImageBuild, app: string | null): boolean {
    return carriesBbApp(build.kind) && !!app && !!build.record && build.record.bbApp !== app;
  }

  /** Why an image is due (049), in the decision's order of need, or null: [rank, reason]. */
  async #why(backend: Backend, build: ImageBuild, app: string | null, macosBuild: string | null): Promise<[number, string] | null> {
    const why = await this.#whyAlone(backend, build, app, macosBuild);
    const afterTheMacosImageItIsBuiltOn = 0.5;
    return why && osOf(build.kind) === "ios" ? [why[0] + afterTheMacosImageItIsBuiltOn, why[1]] : why;
  }

  async #whyAlone(backend: Backend, build: ImageBuild, app: string | null, macosBuild: string | null): Promise<[number, string] | null> {
    const os = osOf(build.kind);
    const pins = await this.#deps.facts.pins(pinSet(build.kind)).catch(() => null);
    const record = build.record;
    const pinChrome = record ? await this.#deps.facts.chrome?.(record.arch).catch(() => null) : null;
    if (record && judgeImage(record, { os, pins, bbApp: carriesBbApp(build.kind) ? app : null, pinChrome: pinChrome ?? null, now: this.#now() }, "").status === "fail") return [1, "it fails the doctor"];
    if (record && os === "ios" && macosBuild && record.base !== macosBuild) return [3, `it is built on another build of the macOS image than ${macosBuild}`];
    if (!record) return [2, "it has no record, so its age is not known"];
    const days = (this.#now() - Date.parse(record.built)) / DAY_MS;
    if (days > INTERVAL_DAYS[os]) return [2, `it is ${Math.floor(days)} days old, past its ${INTERVAL_DAYS[os]}-day interval`];
    if (carriesBbApp(build.kind) && app && record.bbApp !== app) return [4, "it has another build of BB's app than BB's server gives"];
    if (pins && record.pins !== pins) return [5, "it was built with other pins than this bb-box's"];
    const program = await this.#deps.facts.program?.(build.kind, backend.id).catch(() => null);
    if (program && record.program !== program) return [6, "its guest program or prepare script changed"];
    return null;
  }

  async #state(name: string): Promise<ImageState | null> {
    return (await this.#deps.storage.get<ImageState>(`${STATE}${name}`)) ?? null;
  }

  /** Every refreshable image, with why it is due and what its last rebuild did, most needed first. */
  async list(signal?: AbortSignal): Promise<ImageView[]> {
    const app = await this.#deps.facts.bbApp(signal).catch(() => null);
    const views: (ImageView & { rank: number })[] = [];
    const standard = await this.#standard(signal);
    for (const { backend, build } of standard) {
      const name = `${backend.id}/${build.ref}`;
      const why = await this.#why(backend, build, app, macosBuildBeside(build, backend, standard));
      views.push({ name, backend: backend.id, build, due: why?.[1] ?? null, last: await this.#state(name), rank: why?.[0] ?? 9 });
    }
    return views.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map(({ rank: _, ...view }) => view);
  }

  /** What an image is built from now: its pins, BB's app, the versions a rebuild takes, and its current build. */
  #from(build: ImageBuild, pins: string | null, app: string | null, versions: Versions | null): string {
    // A Windows image takes its pins alone, and Windows' updates, which come monthly (054).
    if (osOf(build.kind) === "windows") return createHash("sha256").update(JSON.stringify({ pins, month: new Date(this.#now()).toISOString().slice(0, 7), current: build.build })).digest("hex").slice(0, 16);
    const tools = versions?.tools.filter((tool) => tool.arch === (build.record?.arch === "arm64" ? "arm64" : "x86_64")).map((tool) => `${tool.name}@${tool.version}`) ?? [];
    return createHash("sha256").update(JSON.stringify({ pins, app, tools, current: build.build })).digest("hex").slice(0, 16);
  }

  async failures(): Promise<StandardImageFailure[]> {
    const on = new Set(this.#deps.backends().map((backend) => backend.id));
    const failures: StandardImageFailure[] = [];
    for (const entry of await this.#deps.storage.list(STATE)) {
      const name = entry.slice(STATE.length);
      const backend = name.slice(0, name.indexOf("/"));
      if (!on.has(backend)) continue;
      const state = await this.#deps.storage.get<ImageState>(entry);
      if (!state || state.ok || state.waiting) continue;
      failures.push({ name, backend, kind: state.kind ?? null, at: state.at, reason: state.reason ?? "no reason given" });
    }
    return failures.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  }

  /** Where the run going on is, image by image, or the last run of this bb-box's life; null before any. */
  progress(): RunProgress | null {
    return this.#progress;
  }

  #setProgress(next: RunProgress): void {
    this.#progress = next;
    this.#deps.changed?.();
  }

  #setImage(name: string, change: Partial<RunProgress["images"][number]>): void {
    const progress = this.#progress;
    if (!progress) return;
    this.#setProgress({ ...progress, images: progress.images.map((image) => (image.name === name ? { ...image, ...change } : image)) });
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
  refreshAll(options: RunOptions = {}): Promise<RunResult> {
    const running = this.#running;
    // A full run asked for during a BB update's run waits for it, then runs: that run took only the images with BB's old app.
    if (running?.only && !options.only) return running.done.then(() => this.refreshAll(options));
    if (running) return running.done;
    const stop = new AbortController();
    const started = this.#now();
    const done = this.#run(options, stop.signal).finally(() => {
      this.#running = null;
    });
    this.#running = { started, done, stop, ...(options.only ? { only: options.only } : {}) };
    return done;
  }

  /**
   * After a BB update (the operator, 11 October 2026): when BB's server gives another build of BB's app than Linux
   * images carry, bb-box notes it, and BB_UPDATE_DELAY_MS later starts a refresh of those images alone, once per build
   * of the app. A run going on is waited for: this is asked again every few minutes. With nothing that carries an old
   * build, it forgets what it noted. The nightly switch decides whether it is asked at all.
   */
  async afterBbUpdate(signal?: AbortSignal): Promise<"noticed" | "started" | "waiting" | null> {
    if (!this.#deps.afterBbUpdates?.()) return null;
    const app = await this.#deps.facts.bbApp(signal).catch(() => null);
    if (!app) return null;
    const stale = (await this.list(signal)).filter((view) => this.#appStale(view.build, app));
    const kept = await this.#deps.storage.get<BbUpdate>(BB_UPDATE);
    if (!stale.length) {
      if (kept) await this.#deps.storage.delete(BB_UPDATE);
      return null;
    }
    const now = this.#now();
    if (kept?.app !== app) {
      await this.#deps.storage.set(BB_UPDATE, { app, noticed: now, started: null } satisfies BbUpdate);
      this.#deps.log?.(
        `images: BB's server gives another build of BB's app than ${stale.map((view) => view.name).join(", ")} ${stale.length === 1 ? "carries" : "carry"}, as after a BB update. A refresh of ${stale.length === 1 ? "it" : "them"} starts by ${new Date(now + BB_UPDATE_DELAY_MS).toISOString()}.`,
      );
      return "noticed";
    }
    if (kept.started !== null) return null;
    if (now < kept.noticed + BB_UPDATE_DELAY_MS) return "waiting";
    if (this.#running) return "waiting";
    await this.#deps.storage.set(BB_UPDATE, { ...kept, started: now } satisfies BbUpdate);
    this.#deps.log?.(`images: refreshing ${stale.map((view) => view.name).join(", ")}, as BB was updated.`);
    void this.refreshAll({ only: "bb-app" }).then(
      async (result) => {
        // Another bb-box's run held the lock: this one is tried again at the next look.
        if (result.lines[0]?.name === "images" && result.lines[0].outcome === "not started") await this.#deps.storage.set(BB_UPDATE, { ...kept, started: null } satisfies BbUpdate);
      },
      () => {},
    );
    return "started";
  }

  /** The refresh a BB update will start, while it waits: when, and the images it takes; null when none waits. */
  async dueSoon(signal?: AbortSignal): Promise<DueSoon | null> {
    if (!this.#deps.afterBbUpdates?.()) return null;
    const kept = await this.#deps.storage.get<BbUpdate>(BB_UPDATE);
    if (!kept || kept.started !== null) return null;
    const views = await this.list(signal).catch(() => [] as ImageView[]);
    const names = views.filter((view) => this.#appStale(view.build, kept.app)).map((view) => view.name);
    return names.length ? { at: Math.max(this.#now(), kept.noticed + BB_UPDATE_DELAY_MS), names } : null;
  }

  /**
   * Rebuild now (the operator, 11 October 2026): starts the night's refresh, unless a run goes on, which is not joined
   * but refused, with when it started, so the page says so rather than showing another's run as its own.
   */
  startNow(): { readonly started: boolean; readonly message: string | null } {
    const running = this.#running;
    if (running) {
      const what = running.only === "bb-app" ? "A refresh after a BB update" : "A rebuild";
      return { started: false, message: `${what} has gone on since ${new Date(running.started).toISOString().slice(11, 16)} UTC, one image at a time. Start another once it ends.` };
    }
    void this.refreshAll().catch(() => null);
    return { started: true, message: null };
  }

  async startOne(name: string): Promise<{ readonly started: boolean; readonly message: string | null }> {
    const views = await this.list().catch(() => [] as ImageView[]);
    if (!views.some((view) => view.name === name)) return { started: false, message: `There is no image ${name} on a backend that is on.` };
    const running = this.#running;
    if (running) return this.startNow();
    void this.refreshAll({ image: name }).catch(() => null);
    return { started: true, message: null };
  }

  /** Stops a run: the image being refreshed fails, its old build stays, and no other starts. */
  stop(): void {
    this.#running?.stop.abort(new Error("bb-box is stopping."));
  }

  async #run(options: RunOptions, signal: AbortSignal): Promise<RunResult> {
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
      // Image boxes and refresh builds left by a run or a bake that did not end, while no bake makes any.
      const bakes = this.#deps.bakes;
      const alone = (work: () => Promise<void>) => (bakes ? bakes.exclusive(work) : work());
      await alone(async () => {
        for (const backend of this.#deps.backends()) {
          if (!backend.images) continue;
          const left = await backend.images.list(signal).catch(() => ({ boxes: [] as string[], builds: [] as ImageBuild[] }));
          const refs = [...left.boxes, ...left.builds.filter((build) => !build.current && build.image === "standard").map((build) => build.ref)];
          for (const ref of refs) {
            say(`removing ${backend.id}/${ref}, left by a run that did not end`);
            await backend.images.remove(ref, signal).catch((error: unknown) => say(`could not remove ${backend.id}/${ref}: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
      });
      const versions = await (this.#deps.versions ?? resolveVersions)(this.#deps.setup, { pinned: !!options.pinned, signal }).catch(() => null);
      const app = await this.#deps.facts.bbApp(signal).catch(() => null);
      const views = await this.list(signal);
      const limit = started + (options.limitMs ?? RUN_LIMIT_MS);
      // After a BB update, the images with BB's old app alone; the others stay for the night.
      const taken = (view: ImageView) => (options.image ? view.name === options.image : !!view.due && (options.only !== "bb-app" || this.#appStale(view.build, app)));
      /** A taken image's outcome, in the run's lines and its progress. */
      const note = (line: RunLine & { outcome: RunProgress["images"][number]["state"] }) => {
        lines.push(line);
        this.#setImage(line.name, { state: line.outcome, detail: line.detail, line: null });
      };
      this.#setProgress({ started, ended: null, only: options.only ?? null, images: views.filter(taken).map((view) => ({ name: view.name, kind: view.build.kind, state: "next", detail: view.due })) });
      for (const view of views) {
        if (!taken(view)) continue;
        if (signal.aborted || this.#now() >= limit) {
          note({ name: view.name, outcome: "not started", detail: signal.aborted ? "the run was stopped" : "the run's time limit came first" });
          continue;
        }
        const backend = this.#deps.backends().find((candidate) => candidate.id === view.backend)!;
        const pins = await this.#deps.facts.pins(pinSet(view.build.kind)).catch(() => null);
        const from = this.#from(view.build, pins, app, versions);
        if (!options.image && view.last && !view.last.ok && !view.last.waiting && view.last.from === from) {
          note({ name: view.name, outcome: "skipped", detail: `its last rebuild failed and nothing it is built from has changed; bb box images build ${view.name} tries again` });
          continue;
        }
        // Room for the build's boxes, as for any boxes of the kind at its default size (049): a build box and a trial box, or
        // the trial box alone where the backend builds without a box, as Docker's build script does.
        if (backend.kinds().some((kind) => kind.id === view.build.kind)) {
          const size = defaultSize(kindSizes(view.build.kind));
          const boxless = !!backend.images?.build;
          const room = await backend.capacity(view.build.kind, size, boxless ? [] : [{ kind: view.build.kind, size }], signal).catch(() => null);
          if (room && !room.ok) {
            const reason = `no room for its ${boxless ? "trial box" : "build and trial boxes"}: ${room.message ?? "the host is full"}`;
            await this.#record(view.name, { at: this.#now(), ok: false, waiting: true, reason, build: view.build.build, seconds: 0, output: [], from, kind: view.build.kind });
            note({ name: view.name, outcome: "waiting", detail: reason });
            continue;
          }
          // Room the backend needs to build, such as disk where it builds.
          const short = await backend.images?.room?.(view.build, signal).catch(() => null);
          if (short) {
            const reason = `no room for its build: ${short}`;
            await this.#record(view.name, { at: this.#now(), ok: false, waiting: true, reason, build: view.build.build, seconds: 0, output: [], from, kind: view.build.kind });
            note({ name: view.name, outcome: "waiting", detail: reason });
            continue;
          }
        }
        say(`refreshing ${view.name}: ${view.due ?? "asked for again"}`);
        this.#setImage(view.name, { state: "refreshing", since: this.#now(), line: null });
        let step: { at: number; of: number } | undefined;
        const result = await this.#refreshOne(backend, view, {
          pinned: !!options.pinned,
          replace: true,
          signal,
          from,
          log: (line) => {
            say(`${view.name}: ${line}`);
            // The page follows the image's steps, as first-run setup's card does, and its last line; only a new step says so at once.
            const header = /\[[^\]\s]+ (\d+)\/(\d+)\]/.exec(line);
            const moved = header && (Number(header[1]) !== step?.at || Number(header[2]) !== step?.of);
            if (header) step = { at: Number(header[1]), of: Number(header[2]) };
            const image = this.#progress?.images.find((one) => one.name === view.name);
            if (image) this.#progress = { ...this.#progress!, images: this.#progress!.images.map((one) => (one === image ? { ...one, line: line.slice(0, 300), ...(step ? { step } : {}) } : one)) };
            if (moved) this.#deps.changed?.();
          },
        });
        this.#setImage(view.name, result.ok ? { state: "refreshed", detail: `now ${result.build?.build ?? "a new build"}, in ${result.seconds} s`, line: null } : { state: "failed", detail: result.reason ?? "no reason given", line: null });
        lines.push(result.ok ? { name: view.name, outcome: "refreshed", detail: `now ${result.build?.build ?? "a new build"}, in ${result.seconds} s` } : { name: view.name, outcome: "failed", detail: result.reason ?? "no reason given" });
      }
      if (!options.image) for (const view of views) if (!taken(view)) lines.push({ name: view.name, outcome: "skipped", detail: view.due ? "it is due for another reason than a BB update: the night refreshes it" : "not due" });
      if (bakes && options.only !== "bb-app" && !options.image) lines.push(...(await bakes.maintain({ until: limit, signal })));
      const ok = !lines.some((line) => line.outcome === "failed");
      await this.#deps.storage.set(LAST_RUN, { at: this.#now(), ok, lines });
      if (this.#progress) this.#setProgress({ ...this.#progress, ended: this.#now() });
      return { ok, lines, seconds: Math.round((this.#now() - started) / 1000) };
    } finally {
      await this.#deps.storage.delete(LOCK);
      // A run that threw ends too: what it did not reach did not start.
      const progress = this.#progress;
      if (progress && progress.ended === null) {
        this.#setProgress({ ...progress, ended: this.#now(), images: progress.images.map((image) => (image.state === "next" || image.state === "refreshing" ? { ...image, state: "not started", line: null } : image)) });
      }
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
      prepare: await prepareDigest(this.#deps.setup, backend.id).catch(() => null),
      pinned: options.pinned,
      replace: options.replace,
      signal: options.signal,
      log: options.log,
    });
    // A try changes nothing, so it records nothing.
    if (options.replace) {
      await this.#record(view.name, { at: this.#now(), ok: result.ok, reason: result.reason, build: result.build?.build ?? view.build.build, seconds: result.seconds, output: result.output, from: options.from, kind: view.build.kind });
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
    const nightlyOn = this.#deps.afterBbUpdates?.() ?? false;
    checks.push(
      days !== null && days <= NIGHTLY_WARN_DAYS
        ? { id: "images.nightly", name: "Nightly rebuilds", status: "ok", detail: `The last run ended ${days < 1 ? "today" : `${Math.floor(days)} days ago`}${last!.ok ? "" : ", with a failure"}.`, fix: null }
        : days === null && nightlyOn
          ? { id: "images.nightly", name: "Nightly rebuilds", status: "ok", detail: "Rebuild each night is on, and no run has ended yet: the first is tonight.", fix: null }
          : {
            id: "images.nightly",
            name: "Nightly rebuilds",
            status: "warn",
            detail: days === null ? "No run of bb box images refresh has ended yet, so images are rebuilt only by hand." : `No run of bb box images refresh has ended for ${Math.floor(days)} days.`,
            fix: `Turn on Rebuild each night on the Images page of BB Box's settings, or have a BB script automation run it each night: ${AUTOMATION}`,
          },
    );
    const soon = await this.dueSoon(signal).catch(() => null);
    if (soon) {
      checks.push({
        id: "images.bb-update",
        name: "Refresh after a BB update",
        status: "ok",
        detail: `BB was updated: ${soon.names.join(", ")} ${soon.names.length === 1 ? "has" : "have"} another build of BB's app than BB's server gives. A refresh of ${soon.names.length === 1 ? "it" : "them"} starts by ${new Date(soon.at).toISOString().slice(11, 16)} UTC.`,
        fix: null,
      });
    }
    for (const view of views) {
      if (!view.last || view.last.ok) continue;
      const when = new Date(view.last.at).toISOString().slice(0, 10);
      checks.push({
        id: `images.${view.backend}/${view.build.ref}`,
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
