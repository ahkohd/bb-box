// Boxes as BB machines (decision 014). bb-box registers a machine provider
// and enrols a ready box by creating a machine keyed by the box ID. The
// provider's create runs BB's bootstrap through the box's command transport,
// as the box user. Releasing a box removes its machine first. After bb-box
// starts a stopped box, or when the sweep finds a ready box's machine
// disconnected, bootstrap runs again with the same key to start BB's daemon
// (017), on a Mac after unloading the daemon's LaunchAgent if launchd loaded
// it at login and the bootstrap fails for that (#416). A box the sweep
// restores from its guest enrols again with the same key once it runs and
// answers, and BB gives back the machine it still has for it (025, 026). A
// spare's machine is named "<name> (spare)" until an acquire claims the box,
// which gives it the box's name (032).
//
// Plugins can read the names of BB's machine variables but not their values;
// BB gives the values, and GH_TOKEN, to its daemon in the box. Commands in a
// Linux box source ~/.config/bb-box/env, which bb-box writes before each
// command it runs: the box's identity, and a loader that takes those
// variables from the daemon's process as the command starts. Once the daemon
// connects, the box's ~/.bashrc sources the file too, for the thread's own
// SSH commands, git takes GitHub credentials from gh, and git fetches
// GitHub's SSH URLs over HTTPS.
//
// Setting up that access runs alongside BB's bootstrap, which touches
// neither ~/.bashrc nor git's settings. bb-box asks BB about the machine
// every 500 ms, and every 100 ms once bootstrap has returned, since BB shows
// the machine connected soon after. BB starts the daemon's workers, which
// carry the variables, a moment after that, so the enrolment ends once the
// box's commands find GH_TOKEN, which BB can give a new machine some seconds
// after its other variables, or 30 s later, and the box's first command has
// them. BB's daemon can stop meanwhile, as when the box runs out of memory,
// so bb-box then asks BB again: the enrolment fails, and says why, if BB
// does not show the machine connected within 30 s of that, or of bootstrap
// returning (#286). A reconnect waits in the same way for BB to show the
// machine connected again, then for such a worker.
// Each enrolment logs how long its steps took.

import type { MachineExecutor, PluginMachineProviderDeclaration } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BoxError, OPERATOR, describeError, machineName, type BoxRecord, type Boxes } from "../core/boxes.ts";
import { ACCESS_CHECK_EXITS, accessCheck, accessSetup, accessSetupMs } from "../core/in-box.ts";
import type { CommandTransport } from "../transports/types.ts";
import { quote } from "../transports/process.ts";
import type { BackendStorage, DaemonKeptByHost } from "../backends/types.ts";
import { bbServerFolder } from "../backends/tart/device-host.ts";
import { daemonStarting, endThreadProcesses, hideBbConsoles, runWindowsCommand, windowsFailure } from "./enrol-windows.ts";
import { abortable } from "../core/abortable.ts";
import { LINUX_LEAST_MEMORY_GIB, formatMiB } from "../core/sizes.ts";
import { readIdentityResets, resetThatRemoved, type IdentityReset } from "../core/identity.ts";
import { JOIN_TRIES, backendVerdict, dueToJoin, failedBeforeTries, gaveUpWords, joinProblem, nextTry, plainJoinFailure, tryWords, waitWords, waitingToJoin } from "../core/join-tries.ts";
import { PRODUCT } from "../brand.ts";


interface TryOutcome {
  resetFound: { readonly machine: string; readonly reset: IdentityReset } | null;
  startOver: boolean;
}

type ResetFound = { readonly found: "reset"; readonly reset: IdentityReset } | { readonly found: "none" } | { readonly found: "unread"; readonly why: string };

function identityState(box: BoxRecord): string {
  return JSON.stringify([box.enrol.hostId, box.enrol.state, box.identityReset?.foundAt ?? null, box.identityReset?.enrolledAgainAt ?? null, box.removedMachineToCheck?.at ?? null]);
}

function recoveryPending(box: BoxRecord): boolean {
  return !!box.identityReset && box.identityReset.enrolledAgainAt === null;
}

export const MACHINE_PROVIDER_ID = "bb-box";

export interface JoinAgain {
  readonly is: "joined" | "joining" | "trying";
  readonly box: BoxRecord;
}

type MachineInBb = "live" | "adding" | "gone";

const GONE_PHASES = new Set(["removing", "removed", "destroying", "destroyed", "failed"]);

function namedMachine(box: BoxRecord): string | null {
  if (recoveryPending(box) && box.identityReset!.machine === (box.joinTries?.machine ?? box.enrol.hostId)) return null;
  return box.enrol.hostId ?? box.joinTries?.machine ?? null;
}

function joiningNow(box: BoxRecord): boolean {
  return box.enrol.state === "enrolling" && !waitingToJoin(box);
}

/**
 * BB's manual provider, which makes Windows boxes' machines (#539):
 * only its machines have a Windows enrolment command. bb-box owns their
 * lifecycle itself, as BB calls no provider of bb-box's for them.
 */
const MANUAL_PROVIDER_ID = "manual";
/** Where bb-box keeps each manual machine it made, by machine ID, with its box, so none outlives its box. */
const MANUAL_PREFIX = "manual-machine/";
/** How long a manual machine may name no box before the sweep takes it for a leftover: an enrolment records it on the box first. */
const MANUAL_GRACE_MS = 10 * 60_000;

interface ManualMachine {
  readonly boxId: string;
  readonly at: number;
  /** When bb-box asked BB to remove it, while BB has not finished. */
  readonly removing?: number;
  /** Logged as stuck in BB's removal. */
  readonly stuck?: boolean;
}

/** What BB's bootstrap says on a Mac where launchd has its daemon's LaunchAgent loaded already (#416). */
const LOADED = /Bootstrap failed: 5: Input\/output error/;

/**
 * Removes a Linux box's pre-installed BB app when BB's server has another
 * build of it and the box's root is an overlay, as on microsandbox and
 * Docker (#701). BB's installer then installs the server's build into an
 * empty prefix, in about 3 s. Replacing the image's copy in place took npm
 * about 43 s on microsandbox and 19 s on Docker, as overlayfs cannot rename
 * a directory of the image's layer, so npm copies each file it moves. The
 * old app's digest is the one BB's installer wrote, and the server's is in
 * the package's headers; a box that cannot tell keeps its app.
 */
export function removeStaleApp(bbUrl: string): string {
  return `/bin/sh -c ${quote(String.raw`[ "$(stat -f -c %T / 2>/dev/null)" = overlayfs ] || exit 0
want=$(curl -fsSI --max-time 10 ${quote(`${bbUrl.replace(/\/+$/, "")}/install/bb-app.tgz`)} | tr -d '\r' | sed -n 's/^x-bb-artifact-sha256: *\([a-f0-9]\{64\}\)$/\1/Ip' | tail -n 1)
[ -n "$want" ] || exit 0
for d in "$HOME"/.bb-machines/*/; do
  [ -d "$d/npm/lib/node_modules/bb-app" ] || continue
  [ "$(cat "$d/host-artifact.sha256" 2>/dev/null)" = "$want" ] || rm -rf "$d/npm/lib/node_modules/bb-app"
done
`)}`;
}

export function keepDaemonPortScript(bbUrl: string, port: number): string {
  return `/bin/sh -c ${quote(`umask 077 && d="$HOME/.bb-machines/"${quote(bbServerFolder(bbUrl))} && mkdir -p "$d" && printf '%s\\n' ${port} > "$d/host-daemon-port"`)}`;
}

/**
 * Sets aside BB's data for any machine but `keep` in a Linux or macOS box,
 * as a restored box has from the machine BB removed: BB's installer refuses
 * a data folder that belongs to another machine. It stops that machine's
 * daemon, a systemd user unit or a LaunchAgent, and moves its folder to
 * ~/.bb-machines/.set-aside/<folder>-<machine>, keeping its threads' files.
 * Prints each folder it moved. In /bin/sh, as the box user's zsh fails a
 * glob that matches nothing.
 */
export function setAsideOtherMachines(keep: string | null): string {
  return `/bin/sh -c ${quote(String.raw`keep=${quote(keep ?? "")}
for d in "$HOME"/.bb-machines/*/; do
  d=$(dirname "$d/.")
  id=$(cat "$d/host-id" 2>/dev/null)
  [ -n "$id" ] && [ "$id" != "$keep" ] || continue
  if [ "$(uname)" = Darwin ]; then
    for p in "$HOME"/Library/LaunchAgents/app.getbb.host-daemon.*-"$id".plist; do
      [ -f "$p" ] || continue
      launchctl bootout "gui/$(id -u)/$(basename "$p" .plist)" >/dev/null 2>&1
      rm -f "$p"
    done
  else
    for u in "$HOME"/.config/systemd/user/bb-host-daemon-*-"$id".service; do
      [ -f "$u" ] || continue
      systemctl --user disable --now "$(basename "$u")" >/dev/null 2>&1
      rm -f "$u"
    done
    systemctl --user daemon-reload >/dev/null 2>&1
  fi
  mkdir -p "$HOME/.bb-machines/.set-aside" || exit 1
  to="$HOME/.bb-machines/.set-aside/$(basename "$d")-$id"
  rm -rf "$to"
  mv "$d" "$to" || exit 1
  echo "$d $id"
done
`)}`;
}

/**
 * Unloads BB's daemon's LaunchAgent for machine `hostId` in the box user's
 * session, and waits up to 10 s for it to go, as `launchctl bootstrap` fails
 * the same way while it is going (#416). In /bin/sh, as the box user's zsh
 * fails a glob that matches nothing.
 */
export function unloadMacDaemon(hostId: string): string {
  return `/bin/sh -c ${quote(String.raw`uid=$(id -u)
for p in "$HOME"/Library/LaunchAgents/app.getbb.host-daemon.*-${hostId}.plist; do
  [ -f "$p" ] || continue
  l=$(basename "$p" .plist)
  launchctl print "gui/$uid/$l" >/dev/null 2>&1 || continue
  launchctl bootout "gui/$uid/$l" >/dev/null 2>&1
  i=0
  while launchctl print "gui/$uid/$l" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 100 ] || exit 1
    sleep 0.1
  done
done
`)}`;
}

/** The parts of BB's host API enrolment uses. */
export interface HostApi {
  experimental_create(args: { machineProviderId: string; key: string; inputs: { boxId: string } | null; wait: false }): Promise<HostState>;
  get(args: { hostId: string; signal?: AbortSignal }): Promise<HostState>;
  update(args: { hostId: string; name: string }): Promise<unknown>;
  delete(args: { hostId: string }): Promise<unknown>;
  /** A pending machine's enrolment command, with its Windows form (#539). Null when it has none. */
  experimental_getEnrollmentCommand(args: { hostId: string }): Promise<{ command: string; windowsCommand?: string; expiresAt: number } | null>;
  /** The command that starts a known machine's daemon again, with its Windows form (#539). */
  experimental_reconnect(args: { hostId: string; signal?: AbortSignal }): Promise<{ command: string; windowsCommand?: string; hostId: string; expiresAt: number }>;
}

export interface HostState {
  readonly id: string;
  readonly name?: string;
  readonly status: "connected" | "disconnected";
  readonly lifecycle: { readonly phase: string; readonly message: string | null };
}

interface Progress {
  step(text: string): void;
  log(text: string): void;
}

export interface EnrolmentDeps {
  readonly boxes: Boxes;
  /** bb-box's storage, for the manual machines it made (#539). */
  readonly kv: BackendStorage;
  readonly hosts: () => HostApi;
  bootstrap(request: { key: string; executor: MachineExecutor; report: Progress; signal: AbortSignal }): Promise<{ hostId: string }>;
  logError(operation: string, error: unknown): void;
  log?(message: string): void;
  /** BB's server URL, to tell whether a box's pre-installed app is the server's build (#701). */
  bbUrl?(): string | null;
  /** How long an enrolment may take before bb-box gives up on it. */
  readonly timeoutMs?: number;
  /** How often to ask BB about the machine, until bootstrap returns. */
  readonly pollMs?: number;
  /** How often to ask once bootstrap has returned. */
  readonly fastPollMs?: number;
  /** How long to wait, once the machine connects, for a worker with the thread's variables. */
  readonly variablesWaitMs?: number;
  /** How long a Windows box's daemon may take to connect by itself, as BB's logon entry starts it after a boot, before bb-box runs BB's reconnect (#917). */
  readonly logonWaitMs?: number;
  /** How long to wait before asking BB again to add a box, when BB does not know bb-box's machine provider yet. */
  readonly providerRetryMs?: number;
  /** How long a release waits for BB to finish removing a Windows box's manual machine (#539). */
  readonly manualRemoveMs?: number;
  readonly joinWaitsMs?: readonly number[];
  readonly joinAlarm?: JoinAlarm;
  readonly now?: () => number;
}

export interface JoinAlarm {
  set(at: number, ring: () => void): () => void;
}

const QUIET: Progress = { step: () => {}, log: () => {} };

interface Reach {
  readonly command: CommandTransport;
  readonly daemonKeptByHost: DaemonKeptByHost | undefined;
}
const ACCESS_SETUP_TIMEOUT_MS = 60_000;
const ACCESS_CHECK_TIMEOUT_MS = 10_000;
const VARIABLES_POLL_MS = 250;
/** How many times bb-box asks BB to add a box while BB does not know its machine provider: about 30 s by default (#285). */
const PROVIDER_TRIES = 6;

/** BB's answer while it does not know bb-box's machine provider, as for some seconds while the plugin restarts. */
function isUnknownProvider(error: unknown): boolean {
  return error instanceof Error && /\bUnknown machine provider\b/i.test(error.message);
}

/** A wait for the log, such as "10 s" or "0.3 s". */
function waited(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/** For a daemon that stopped: the memory of a box with less than it needs, or nothing (#286). */
function lowMemory(box: BoxRecord): string {
  const memoryMiB = (box.guest?.size ?? box.size)?.memoryMiB;
  if (memoryMiB === undefined || memoryMiB >= LINUX_LEAST_MEMORY_GIB * 1024) return "";
  return ` The box has ${formatMiB(memoryMiB)} memory: with less than ${LINUX_LEAST_MEMORY_GIB} GiB it can run out of memory as it becomes a BB machine.`;
}

/** A box's enrolment once its machine is gone: off, unless it failed to join, which keeps its reason. */
function gone(enrol: BoxRecord["enrol"]): BoxRecord["enrol"] {
  return enrol.state === "failed" ? { state: "failed", hostId: null, error: enrol.error } : { state: "off", hostId: null, error: null };
}

function sh(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

const RETIRE_AGAIN_MS = 60_000;

/** Runs BB's installer commands in the box, as the box user, through its command transport. */
export function executor(transport: CommandTransport, phases?: Phases, environment: Readonly<Record<string, string>> = {}): MachineExecutor {
  const assignments = Object.entries(environment).map(([name, value]) => `${name}=${sh(value)}`);
  const prefix = assignments.length ? ["env", ...assignments] : [];
  return {
    async exec({ command, stdin, timeoutMs, signal, onOutput }) {
      const decoder = new TextDecoder();
      phases?.mark("install");
      const result = await transport.stream([...prefix, ...command.map(sh)].join(" "), {
        stdin,
        timeoutMs,
        signal,
        onOutput: (chunk) => onOutput(decoder.decode(chunk, { stream: true })),
      });
      phases?.mark("installed");
      // 124 is what timeout(1) exits with; BB reports the exit code with the output's tail.
      return { exitCode: result.exitCode ?? (result.timedOut ? 124 : 137) };
    },
  };
}

/**
 * A step of an enrolment in the log. It runs from the latest of the marks in
 * `after` that were made, or from when the box was ready, to the mark `end`.
 */
interface Step {
  readonly end: string;
  readonly after: readonly string[];
  readonly label: string;
  /** Overlaps the other steps, which add up to the total. */
  readonly alongside?: boolean;
  /** Left out when it took no time. */
  readonly optional?: boolean;
  /** Shown when all their marks were made. */
  readonly parts?: readonly Step[];
}

/** The steps of an enrolment. The log lists them in the order they start. */
const STEPS: readonly Step[] = [
  { end: "requested", after: [], label: "asking BB", alongside: true },
  { end: "called", after: [], label: `BB calling ${PRODUCT}'s create` },
  { end: "prepared", after: ["called"], label: "reaching the box" },
  { end: "install", after: ["prepared"], label: "BB preparing the enrolment" },
  { end: "installed", after: ["install"], label: "BB's installer in the box" },
  {
    end: "accessed",
    after: ["access"],
    label: "setting up the thread's access",
    alongside: true,
    parts: [
      { end: "names", after: ["access"], label: "fetching the variable names" },
      { end: "env", after: ["names"], label: "reaching the box and back" },
      { end: "accessed", after: ["env"], label: "running the script" },
    ],
  },
  { end: "bootstrapped", after: ["installed"], label: "BB waiting for the daemon" },
  { end: "connected", after: ["bootstrapped"], label: "BB showing the machine connected" },
  { end: "accessed", after: ["connected"], label: "waiting for the access setup", optional: true },
  { end: "variables", after: ["connected", "accessed"], label: "waiting for a worker with the thread's variables", optional: true },
  { end: "enrolled", after: ["connected", "accessed", "variables"], label: "finishing" },
];

/**
 * What an enrolment's time counts from: the box being ready, bb-box
 * resuming the enrolment after a restart, or bb-box finding a box the sweep
 * restored running and answering.
 */
export type EnrolSince = "ready" | "resumed" | "restored" | "reset" | "retry";

const SINCE: Record<EnrolSince, string> = {
  ready: "it was ready",
  resumed: `${PRODUCT} resumed following it`,
  restored: `${PRODUCT} found the restored box answering`,
  reset: `${PRODUCT} found its identity reset`,
  retry: `${PRODUCT} tried again`,
};

/** When each step of one enrolment ended, counted from `origin`. */
export class Phases {
  readonly origin: number;
  readonly since: EnrolSince;
  readonly #now: () => number;
  readonly marks = new Map<string, number>();
  #wake: (() => void) | null = null;

  constructor(origin: number, now: () => number = Date.now, since: EnrolSince = "ready") {
    this.origin = origin;
    this.#now = now;
    this.since = since;
  }

  mark(step: string, at = this.#now()): void {
    this.marks.set(step, at);
    if (step === "bootstrapped") this.#wake?.();
  }

  /** Waits `ms`, or less if bootstrap returns meanwhile. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.#wake === done) this.#wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wake = done;
    });
  }

  /** One line for the log: how long each step took, in the order the steps started. */
  line(boxName: string): string {
    const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
    const describe = (steps: readonly Step[]): string =>
      steps
        .flatMap((step) => {
          const end = this.marks.get(step.end);
          if (end === undefined) return [];
          const start = Math.max(this.origin, ...step.after.map((mark) => this.marks.get(mark) ?? this.origin));
          if (step.optional && end <= start) return [];
          const parts = step.parts?.every((part) => this.marks.has(part.end)) ? ` (${describe(step.parts)})` : "";
          return [{ start, text: `${step.label} ${seconds(Math.max(0, end - start))}${step.alongside ? " alongside" : ""}${parts}` }];
        })
        .sort((a, b) => a.start - b.start)
        .map((step) => step.text)
        .join(", ");
    const last = Math.max(this.origin, ...this.marks.values());
    return `Enrolled box ${boxName} ${seconds(last - this.origin)} after ${SINCE[this.since]}: ${describe(STEPS)}.`;
  }
}

/** BB's answer to a reconnect of a machine it shows connected: HTTP 409. */
function isConflict(error: unknown): boolean {
  const { status } = (error ?? {}) as { status?: unknown };
  return status === 409 || /\bHTTP 409\b|doesn't need reconnecting/i.test(error instanceof Error ? error.message : "");
}

function isNotFound(error: unknown): boolean {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  return status === 404 || code === "not_found" || /not found/i.test(error instanceof Error ? error.message : "");
}

export class Enrolment {
  readonly #deps: EnrolmentDeps;
  readonly #timeoutMs: number;
  readonly #pollMs: number;
  readonly #fastPollMs: number;
  readonly #variablesWaitMs: number;
  readonly #logonWaitMs: number;
  readonly #providerRetryMs: number;
  readonly #manualRemoveMs: number;
  /** Boxes whose enrolment this process is following. */
  readonly #following = new Set<string>();
  /** Boxes whose BB daemon this process is starting again. */
  readonly #reconnecting = new Set<string>();
  readonly #recovering = new Set<string>();
  readonly #trying = new Set<string>();
  readonly #nextTries = new Map<string, () => void>();
  readonly #joinAlarm: JoinAlarm;
  readonly #joinWaitsMs: readonly number[] | undefined;
  readonly #now: () => number;
  readonly #identityTurns = new Map<string, Promise<unknown>>();
  /** The steps of each enrolment this process is following. */
  readonly #phases = new Map<string, Phases>();
  readonly #stopping = new AbortController();
  readonly #stopped = new Promise<void>((resolve) => this.#stopping.signal.addEventListener("abort", () => resolve(), { once: true }));

  constructor(deps: EnrolmentDeps) {
    this.#deps = deps;
    this.#timeoutMs = deps.timeoutMs ?? 5 * 60_000;
    this.#pollMs = deps.pollMs ?? 500;
    this.#fastPollMs = deps.fastPollMs ?? 100;
    // BB can give a new machine GH_TOKEN some seconds after it connects.
    this.#variablesWaitMs = deps.variablesWaitMs ?? 30_000;
    this.#logonWaitMs = deps.logonWaitMs ?? 90_000;
    this.#providerRetryMs = deps.providerRetryMs ?? 6_000;
    this.#manualRemoveMs = deps.manualRemoveMs ?? 2 * 60_000;
    this.#joinWaitsMs = deps.joinWaitsMs;
    this.#now = deps.now ?? (() => Date.now());
    this.#joinAlarm = deps.joinAlarm ?? {
      set: (at, ring) => {
        const timer = setTimeout(ring, Math.max(0, at - this.#now()));
        timer.unref?.();
        return () => clearTimeout(timer);
      },
    };
  }

  dispose(): void {
    for (const cancel of this.#nextTries.values()) cancel();
    this.#nextTries.clear();
    this.#stopping.abort(new Error(`${PRODUCT} stopped, as for a reload`));
  }

  #tryAt(boxId: string, at: number): void {
    if (this.#stopping.signal.aborted) return;
    this.#nextTries.get(boxId)?.();
    const cancel = this.#joinAlarm.set(at, () => {
      this.#nextTries.delete(boxId);
      void this.#tryWhenDue(boxId);
    });
    this.#nextTries.set(boxId, cancel);
  }

  async #tryWhenDue(boxId: string): Promise<void> {
    const box = await this.#deps.boxes.find(boxId).catch(() => null);
    if (!box || box.state !== "ready") return;
    if (recoveryPending(box)) await this.#recover(boxId);
    else await this.#tryAgain(boxId);
  }

  #isStopping(error: unknown): boolean {
    return this.#stopping.signal.aborted || /stale API handle|reloaded or disabled/i.test(error instanceof Error ? error.message : String(error));
  }

  #untilStopping(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.#stopping.signal]);
  }

  /** The machine provider BB calls to create and remove a box's machine. */
  provider(): PluginMachineProviderDeclaration<z.ZodObject<{ boxId: z.ZodString }>> {
    const boxes = this.#deps.boxes;
    return {
      id: MACHINE_PROVIDER_ID,
      displayName: "bb-box",
      description: `A box an agent or the ${PRODUCT} panel acquired. ${PRODUCT} adds it when the box is ready.`,
      icon: "Box",
      inputs: z.object({ boxId: z.string().min(1) }),
      create: async ({ inputs, key, checkpoint, report, signal }) => {
        const box = await boxes.find(inputs.boxId);
        if (!box || box.state !== "ready") {
          return { status: "failed", message: `Box ${box?.name ?? inputs.boxId} is not ready, so it cannot become a BB machine.` };
        }
        const phases = this.#phases.get(box.id);
        phases?.mark("called");
        await checkpoint({ boxId: box.id });
        try {
          const reach = await this.#reach(box);
          const transport = reach.command;
          phases?.mark("prepared");
          report.step(`Installing BB in box ${box.name}`);
          const bbUrl = box.capabilities.os === "windows" ? null : this.#deps.bbUrl?.();
          if (bbUrl) await transport.run(removeStaleApp(bbUrl), { timeoutMs: 30_000, signal }).catch((error) => this.#deps.logError("remove a stale BB app", error));
          if (box.capabilities.os !== "windows") await this.#setAside(box, transport, signal);
          await this.#keepDaemonPort(box, reach, signal);
          await this.#deps.bootstrap({ key, executor: executor(transport, phases, reach.daemonKeptByHost?.installerEnvironment), report, signal });
          await reach.daemonKeptByHost?.takeOver(signal);
          phases?.mark("bootstrapped");
          return { status: "created", name: machineName(box), resource: { boxId: box.id } };
        } catch (error) {
          if (this.#isStopping(error) || signal.aborted) return { status: "failed", message: `${PRODUCT} stopped while it installed BB in box ${box.name}; its next run installs it again.` };
          const described = describeError(error, `Enrolling box ${box.name}`);
          const message = plainJoinFailure(described);
          if (message !== described) this.#deps.log?.(described);
          // Kept on the box, so its row says why: BB removes the machine next, and that removal must not leave the box looking fine.
          await boxes.update(box, (current) => ({ enrol: { state: "failed", hostId: current.enrol.hostId, error: message } })).catch(() => null);
          return { status: "failed", message };
        }
      },
      // The box is bb-box's, and outlives its machine: removing the machine leaves the box running.
      reconcileCleanup: async () => ({ status: "removed" }),
      remove: async (removal) => {
        const boxId = (removal.resource as { boxId?: unknown }).boxId;
        if (typeof boxId !== "string") return { status: "removed" };
        const box = await this.#deps.boxes.find(boxId);
        const named = (removal as { hostId?: unknown }).hostId;
        const machine = typeof named === "string" ? named : (box?.enrol.hostId ?? null);
        if (box && machine) await this.#machineGone(box, machine, { removedInBb: true });
        else if (box) await this.#off(boxId);
        return { status: "removed" };
      },
    };
  }

  /**
   * BB creates a new machine for the box only when it has none: data another
   * machine left, as in a box the sweep restored after its machine was
   * removed, is set aside first, so BB's installer takes the box.
   */
  async #setAside(box: BoxRecord, transport: CommandTransport, signal: AbortSignal): Promise<void> {
    const keep = (await this.#deps.boxes.find(box.id))?.enrol.hostId ?? null;
    const result = await transport.run(setAsideOtherMachines(keep), { timeoutMs: 60_000, signal });
    if (result.exitCode !== 0) throw new Error(`BB's data from another machine in box ${box.name} could not be set aside: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const [folder, machine] = line.split(" ");
      this.#deps.log?.(`Box ${box.name} had BB's data for machine ${machine}, which is not its machine now: set aside ${folder} in ~/.bb-machines/.set-aside, and stopped its daemon.`);
    }
  }

  /**
   * BB's bootstrap of a machine BB has already, to start its daemon again.
   * After a Mac boots, launchd has the daemon's LaunchAgent loaded already,
   * from the login, and BB's `launchctl bootstrap` fails for it: bb-box
   * unloads it then and runs the bootstrap once more (#416).
   */
  async #keepDaemonPort(box: BoxRecord, reach: Reach, signal: AbortSignal): Promise<void> {
    const port = reach.daemonKeptByHost?.daemonPort ?? null;
    const bbUrl = this.#deps.bbUrl?.() ?? null;
    if (port === null || !bbUrl) return;
    const kept = await reach.command.run(keepDaemonPortScript(bbUrl, port), { timeoutMs: 30_000, signal });
    if (kept.exitCode !== 0) throw new Error(`Could not give BB's daemon in box ${box.name} its slot's port ${port}: ${kept.stderr.trim() || `exit code ${kept.exitCode}`}`);
  }

  async #bootstrapAgain(box: BoxRecord, hostId: string, reach: Reach, request: Parameters<EnrolmentDeps["bootstrap"]>[0]): Promise<void> {
    const transport = reach.command;
    if (box.capabilities.os === "windows") {
      // BB's daemon runs on through a suspend, and its logon starts it after
      // a boot. BB refuses a reconnect while it shows the machine connected.
      if ((await this.#deps.hosts().get({ hostId })).status === "connected") return;
      // After a boot BB's logon entry starts the daemon, and a resumed box's daemon connects again by itself: BB's
      // reconnect command meanwhile could start a second supervisor beside it (#917). So bb-box waits for that first.
      const starting = await daemonStarting(transport, hostId, { timeoutMs: 30_000, signal: request.signal }).catch((error: unknown) => {
        this.#deps.logError("look for BB's daemon in a Windows box", error);
        return null;
      });
      if (starting && (await this.#connectedWithin(hostId, this.#logonWaitMs, request.signal))) {
        this.#deps.log?.(`BB's daemon in box ${box.name} connected by itself, ${starting === "logon" ? "started by its logon" : "as it ran already"}, so bb-box started no other.`);
        return;
      }
      // BB's reconnect command, in its Windows form (#539).
      const reconnect = await this.#deps
        .hosts()
        .experimental_reconnect({ hostId, signal: request.signal })
        .catch((error: unknown) => {
          if (isConflict(error)) return null;
          throw error;
        });
      if (!reconnect) return;
      if (!reconnect.windowsCommand) throw new Error(`BB gave no Windows command to start BB's daemon in box ${box.name} again.`);
      const result = await runWindowsCommand(transport, reconnect.windowsCommand, { timeoutMs: this.#timeoutMs, signal: request.signal });
      if (result.exitCode !== 0) throw new Error(windowsFailure(`Starting BB's daemon in box ${box.name} again`, result));
      return;
    }
    await this.#keepDaemonPort(box, reach, request.signal);
    try {
      await this.#deps.bootstrap(request);
    } catch (error) {
      if (box.capabilities.os !== "macos" || reach.daemonKeptByHost || !LOADED.test(error instanceof Error ? error.message : String(error))) throw error;
      this.#deps.log?.(`BB's daemon in box ${box.name} was loaded already, as after a boot: unloading it, and running BB's bootstrap again.`);
      const unloaded = await transport.run(unloadMacDaemon(hostId), { timeoutMs: 30_000, signal: request.signal });
      if (unloaded.exitCode !== 0) throw error;
      await this.#deps.bootstrap(request);
    }
    await reach.daemonKeptByHost?.takeOver(request.signal);
  }

  /**
   * Enrols a Windows box (#539) as the manual machine bb-box made
   * for it: names the machine after the box, then runs the machine's
   * enrolment command, in its Windows form, in the box user's desktop
   * session, where BB's daemon has to run. BB's installer names the machine
   * after the computer, so #follow names it again once it connects.
   */
  async #enrolWindows(box: BoxRecord, hostId: string, phases: Phases): Promise<void> {
    await this.#rename(box, hostId);
    const enrolment = await this.#deps.hosts().experimental_getEnrollmentCommand({ hostId });
    if (!enrolment?.windowsCommand) throw new Error(`BB gave no Windows enrolment command for box ${box.name}'s machine ${hostId}.`);
    const transport = await this.#transport(box);
    phases.mark("install");
    const result = await runWindowsCommand(transport, enrolment.windowsCommand, { timeoutMs: this.#timeoutMs, signal: this.#untilStopping(AbortSignal.timeout(this.#timeoutMs)) });
    phases.mark("installed");
    if (result.exitCode !== 0) throw new Error(windowsFailure(`BB's Windows installer in box ${box.name}`, result));
    phases.mark("bootstrapped");
  }

  /** Names the box's BB machine after the box, as a spare that stops to wait says it does (#539). */
  async rename(box: BoxRecord): Promise<void> {
    if (box.enrol.hostId) await this.#rename(box, box.enrol.hostId);
  }

  /** Names the box's machine in BB after the box. Nothing fails without it, so it only logs an error. */
  async #rename(box: BoxRecord, hostId: string): Promise<void> {
    await this.#deps
      .hosts()
      .update({ hostId, name: machineName(box) })
      .catch((error) => this.#deps.logError("rename machine", error));
  }

  async #transport(box: BoxRecord): Promise<CommandTransport> {
    return (await this.#reach(box)).command;
  }

  async #reach(box: BoxRecord): Promise<Reach> {
    const { command, daemonKeptByHost } = await this.#deps.boxes.transports(box);
    if (!command) throw new Error(`${PRODUCT} cannot run commands in box ${box.name}.`);
    return { command, daemonKeptByHost };
  }

  /** The box's machine went: it is no longer enrolled, but one that failed to join still says why (the newcomer check, 11 October 2026). */
  async #off(boxId: string): Promise<void> {
    const box = await this.#deps.boxes.find(boxId);
    if (box) await this.#deps.boxes.update(box, (current) => ({ enrol: gone(current.enrol) }));
  }

  /**
   * Makes a ready box a BB machine and waits until its daemon connects.
   * `since` "resumed" follows an enrolment a restart interrupted, and
   * "restored" enrols a box the sweep restored, once it answers. Never throws.
   */
  async enrol(box: BoxRecord, options: { since?: EnrolSince } = {}): Promise<void> {
    if (this.#following.has(box.id)) return;
    this.#following.add(box.id);
    // Enrolment starts once the box is ready, so its time counts from then.
    // A resumed one's time from then would count the restart too, and a
    // restored box was ready long before, or was restored stopped.
    const since = options.since ?? "ready";
    const phases = new Phases(since === "ready" ? (box.readyAt ?? this.#now()) : this.#now(), this.#now, since);
    this.#phases.set(box.id, phases);
    const outcome: TryOutcome = { resetFound: null, startOver: false };
    try {
      if (!(await this.#oneTry(box, phases, since, outcome))) return;
      await this.#afterTry(box.id).catch((error) => {
        if (!this.#isStopping(error)) this.#deps.logError("plan the next try to add a box to BB", error);
      });
    } finally {
      this.#following.delete(box.id);
    }
    const found = outcome.resetFound;
    if (found) {
      await this.#identityTurn(box.id, async () => {
        const latest = await this.#deps.boxes.find(box.id);
        if (latest) await this.#deps.boxes.identityResetFound(latest, { at: found.reset.at, why: found.reset.why, machine: found.machine });
      });
      void this.#recover(box.id);
      return;
    }
    if (!outcome.startOver || this.#stopping.signal.aborted) return;
    const latest = await this.#deps.boxes.find(box.id);
    if (latest?.state === "ready" && latest.enrol.state === "enrolling" && !latest.enrol.hostId) await this.enrol(latest, { since: "resumed" });
  }

  async #oneTry(box: BoxRecord, phases: Phases, since: EnrolSince, outcome: TryOutcome): Promise<boolean> {
    try {
      let current: BoxRecord = box;
      let access: Promise<void> | null = null;
      if (!box.enrol.hostId) {
        const host = await this.#create(box);
        if (!host) return false;
        if (since === "reset" && host.id === box.identityReset?.machine) {
          await this.#deps.boxes.update(box, (latest) => (latest.identityReset ? { identityReset: { ...latest.identityReset, retiredAt: null } } : {}));
          throw new Error(`BB gave back machine ${host.id}, which the identity reset left, so ${PRODUCT} removes it again at its next sweep before it enrols the box`);
        }
        phases.mark("requested");
        const recorded = await this.#deps.boxes.update(box, () => ({ enrol: { state: "enrolling", hostId: host.id, error: null } }));
        // Released meanwhile: its release did not know the machine yet.
        if (!recorded || recorded.state === "releasing") {
          await this.#remove(host.id);
          return false;
        }
        current = recorded;
        // The thread's access needs only the machine's ID, so on Windows too it is set up while BB's installer runs,
        // which takes most of a minute there, not once it has.
        if (box.capabilities.os === "windows") {
          access = this.#setUpAccess(current, phases);
          await this.#enrolWindows(current, host.id, phases);
        }
        // BB still had the box's machine, as for a box the sweep restored,
        // and its daemon is not running. BB does not create the machine
        // again, so bootstrap with the same key starts the daemon.
        if (box.capabilities.os !== "windows" && host.lifecycle.phase === "active" && host.status !== "connected") {
          const found = await this.#resetThatRemoved(current, host.id);
          if (found.found === "reset") outcome.resetFound = { machine: host.id, reset: found.reset };
          else {
            const reach = await this.#reach(current);
            await this.#bootstrapAgain(current, host.id, reach, {
              key: box.id,
              executor: executor(reach.command, phases, reach.daemonKeptByHost?.installerEnvironment),
              report: QUIET,
              signal: this.#untilStopping(AbortSignal.timeout(this.#timeoutMs)),
            });
            phases.mark("bootstrapped");
          }
        }
      }
      if (!outcome.resetFound) {
        outcome.startOver = (await this.#follow(current, phases, access ?? this.#setUpAccess(current, phases))) === "start over";
        if (current.capabilities.os === "windows" && !outcome.startOver) void this.#hideConsoles(current);
      }
    } catch (error) {
      if (this.#isStopping(error)) return false;
      this.#deps.logError("enrol", error);
      // A Windows box's manual machine is bb-box's to remove: none may stay in BB's list (#539).
      const manual = box.capabilities.os === "windows" ? (await this.#deps.boxes.find(box.id))?.enrol.hostId : null;
      if (manual) await this.#remove(manual).catch((removal) => this.#deps.logError("enrol", removal));
      await this.#deps.boxes
        .update(box, (current) => ({
          enrol: { ...current.enrol, ...(manual ? { hostId: null } : {}), state: "failed", error: current.enrol.state === "failed" && current.enrol.error ? current.enrol.error : plainJoinFailure(describeError(error, "Enrolling the box")) },
        }))
        .catch(() => null);
    } finally {
      this.#phases.delete(box.id);
    }
    return true;
  }

  /**
   * Asks BB to add the box as a machine. While the plugin restarts, BB can
   * say for some seconds that it knows no such machine provider, so bb-box
   * asks again then. Null when the box was released meanwhile.
   */
  async #create(box: BoxRecord): Promise<HostState | null> {
    if (box.capabilities.os === "windows") {
      const host = await this.#deps.hosts().experimental_create({ machineProviderId: MANUAL_PROVIDER_ID, key: box.id, inputs: null, wait: false });
      await this.#deps.kv.set(`${MANUAL_PREFIX}${host.id}`, { boxId: box.id, at: this.#now() } satisfies ManualMachine);
      return host;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#deps.hosts().experimental_create({ machineProviderId: MACHINE_PROVIDER_ID, key: box.id, inputs: { boxId: box.id }, wait: false });
      } catch (error) {
        if (!isUnknownProvider(error) || attempt >= PROVIDER_TRIES) throw error;
        this.#deps.log?.(`Enrolling box ${box.name}: BB does not know bb-box's machine provider yet, as while the plugin restarts. Asking again in ${this.#providerRetryMs / 1000} s, ${PROVIDER_TRIES - attempt} more times at most.`);
      }
      await Promise.race([new Promise((resolve) => setTimeout(resolve, this.#providerRetryMs)), this.#stopped]);
      this.#stopping.signal.throwIfAborted();
      const current = await this.#deps.boxes.find(box.id);
      if (!current || current.state === "releasing") return null;
    }
  }

  /**
   * Waits for BB to show the machine connected, and still connected once
   * the waits for the box's access end. `access` is the access setup
   * running alongside.
   */
  async #follow(box: BoxRecord, phases: Phases, access: Promise<void>): Promise<"start over" | void> {
    const hostId = box.enrol.hostId!;
    const deadline = this.#now() + this.#timeoutMs;
    /** When the waits for the box's access ended. */
    let waitsEnded: number | undefined;
    for (;;) {
      this.#stopping.signal.throwIfAborted();
      const current = await this.#deps.boxes.find(box.id);
      if (!current || current.state === "releasing" || current.enrol.hostId !== hostId || current.enrol.state === "failed") return;
      const host = await this.#deps.hosts().get({ hostId });
      const phase = host.lifecycle.phase;
      if (phase === "active" && host.status === "connected" && waitsEnded === undefined) {
        const connected = this.#now();
        phases.mark("connected", connected);
        if (current.capabilities.os === "windows") await this.#rename(current, hostId);
        await access;
        await this.#variables(current, "the machine connected", connected, phases);
        // BB's daemon can stop during the waits, as when the box runs out of
        // memory, so bb-box asks BB again before it records the box enrolled (#286).
        waitsEnded = this.#now();
        continue;
      }
      if (phase === "active" && host.status === "connected") {
        // BB may have removed the machine during the waits, and the box is then not enrolled.
        // A resumed enrolment's own time is only its last part, so the box shows none.
        const enrolled = await this.#deps.boxes.update(box, (latest) =>
          latest.enrol.hostId !== hostId
            ? {}
            : {
                enrol: { state: "enrolled", hostId, error: null },
                joinTries: null,
                ...(phases.since === "resumed" || phases.since === "retry" ? {} : { timings: { ...latest.timings, enrol: this.#now() - phases.origin } }),
              },
        );
        if (enrolled?.enrol.hostId !== hostId) return;
        phases.mark("enrolled");
        this.#deps.log?.(phases.line(enrolled.name));
        if (current.joinTries) this.#deps.log?.(`Box ${enrolled.name} joined BB at its ${tryWords(current.joinTries.failed)}.`);
        return;
      }
      if (phases.since === "resumed" && phase === "removing") {
        await Promise.race([phases.sleep(this.#pollMs), this.#stopped]);
        continue;
      }
      if (phases.since === "resumed" && phase === "destroyed") {
        this.#deps.log?.(`BB removed box ${current.name}'s machine while bb-box restarted, as when a restart ended BB's installer in it; bb-box adds the box again.`);
        await this.#deps.boxes.update(box, () => ({ enrol: { state: "enrolling", hostId: null, error: null } }));
        return "start over";
      }
      if (phase === "destroyed" || phase === "removing") {
        const reason = plainJoinFailure(host.lifecycle.message ?? "BB removed the machine before it connected.");
        await this.#deps.boxes.update(box, () => ({ enrol: { state: "failed", hostId: null, error: reason } }));
        return;
      }
      if (this.#now() > deadline) {
        const reason = `BB did not finish adding the box as a machine within ${Math.round(this.#timeoutMs / 60_000)} minutes.${host.lifecycle.message ? ` ${host.lifecycle.message}` : ""}`;
        await this.#deps.boxes.update(box, () => ({ enrol: { state: "failed", hostId, error: reason } }));
        return;
      }
      // Once BB's daemon has started, or has connected and the waits ended,
      // BB shows the machine connected within a second or so. If it does not
      // within as long as an enrolment waits for the variables, the daemon
      // stopped, and the box is not a BB machine (#286).
      const from = waitsEnded ?? phases.marks.get("bootstrapped");
      if (from !== undefined && this.#now() - from > this.#variablesWaitMs) {
        const reason =
          (waitsEnded !== undefined
            ? `BB's daemon in box ${current.name} stopped soon after it connected, and BB did not show the machine connected again within ${waited(this.#variablesWaitMs)}.`
            : `BB's daemon in box ${current.name} started, but BB did not show the machine connected within ${waited(this.#variablesWaitMs)}.`) + lowMemory(current);
        this.#deps.log?.(reason);
        await this.#deps.boxes.update(box, () => ({ enrol: { state: "failed", hostId, error: reason } }));
        return;
      }
      await Promise.race([phases.sleep(phases.marks.has("bootstrapped") ? this.#fastPollMs : this.#pollMs), this.#stopped]);
    }
  }

  /**
   * Makes the box's shells and git use the thread's access. It needs only
   * the machine's ID, so it runs while BB installs its daemon. A failure
   * leaves the box enrolled.
   */
  async #setUpAccess(box: BoxRecord, phases: Phases): Promise<void> {
    const script = accessSetup(box.capabilities.os);
    if (!script) return;
    phases.mark("access");
    let scriptMs: number | null = null;
    try {
      const { result } = await this.#deps.boxes.run(box.threadId, box.id, script, {
        timeoutMs: ACCESS_SETUP_TIMEOUT_MS,
        waitForEnrolment: false,
        onSend: () => phases.mark("names"),
      });
      if (result.exitCode !== 0) throw new Error(`Setting up the thread's access in box ${box.name} exited with ${result.exitCode ?? "no code"}: ${result.stderr.trim()}`);
      scriptMs = accessSetupMs(result.stdout);
    } catch (error) {
      this.#deps.logError("enrol access", error);
    } finally {
      phases.mark("accessed");
    }
    // The script timed itself by the box's clock. The rest of the time since
    // the command was sent went on the trip there and back, with writing the
    // env file; it is shown before the script.
    const sent = phases.marks.get("names");
    if (scriptMs !== null && sent !== undefined) phases.mark("env", Math.max(sent, phases.marks.get("accessed")! - scriptMs));
  }

  /**
   * Waits, once the machine connects, until the box's commands find a worker
   * of BB's daemon with the thread's variables, which BB starts a moment
   * later. The wait counts from `connected`, and `since` says what happened
   * then. A box with no names to take, or in which bb-box finds no daemon,
   * does not wait, nor one whose machine BB removes. A failure leaves the
   * box enrolled.
   */
  async #variables(box: BoxRecord, since: string, connected: number, phases?: Phases): Promise<void> {
    const deadline = connected + this.#variablesWaitMs;
    try {
      const access = await this.#deps.boxes.access(box);
      const script = access ? accessCheck(box.capabilities.os, access) : null;
      if (!script) return;
      for (;;) {
        const current = await this.#deps.boxes.find(box.id);
        if (!current || current.state !== "ready" || current.enrol.hostId !== box.enrol.hostId) return;
        const { result } = await this.#deps.boxes.run(box.threadId, box.id, script, { timeoutMs: ACCESS_CHECK_TIMEOUT_MS, waitForEnrolment: false });
        if (result.exitCode === ACCESS_CHECK_EXITS.found || result.exitCode === ACCESS_CHECK_EXITS.noDaemon) return;
        if (result.exitCode !== ACCESS_CHECK_EXITS.waiting) {
          throw new Error(`Looking for the thread's variables in box ${box.name} exited with ${result.exitCode ?? "no code"}: ${result.stderr.trim()}`);
        }
        if (this.#now() >= deadline) {
          this.#deps.log?.(`BB's daemon in box ${box.name} had no process with the thread's GH_TOKEN ${waited(this.#variablesWaitMs)} after ${since}. Its commands take it once one has.`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, VARIABLES_POLL_MS));
      }
    } catch (error) {
      this.#deps.logError("enrol variables", error);
    } finally {
      phases?.mark("variables");
    }
  }

  /** Removes a box's machine from BB, before its release. */
  async unenrol(box: BoxRecord): Promise<void> {
    if (!box.enrol.hostId) return;
    if (box.capabilities.os === "windows") await this.#endThreads(box);
    await this.#remove(box.enrol.hostId);
  }

  /**
   * Ends the processes of threads in a Windows box before its machine is
   * removed (#539). A thread's agent, and the worker of BB's daemon that runs
   * it, work in the thread's worktree, and Windows does not remove a folder
   * a process works in: BB's teardown of the worktree failed with EBUSY, and
   * the machine stayed "removing" once the box was gone. Best effort: a box
   * that does not answer, as a stopped one, is removed as before.
   */
  async #endThreads(box: BoxRecord): Promise<void> {
    try {
      // The box is releasing, but its guest runs until the backend releases it.
      const { command } = await this.#deps.boxes.transports({ ...box, state: "ready" });
      if (!command) return;
      const ended = await endThreadProcesses(command, { timeoutMs: 60_000 });
      if (ended) this.#deps.log?.(`Ended ${ended} processes of threads in box ${box.name} before its BB machine's removal, so that BB can remove their worktrees.`);
    } catch (error) {
      this.#deps.logError("end the threads' processes", error);
    }
  }

  /**
   * Removes a machine from BB. BB's delete of a manual machine returns
   * before BB has removed it: BB first tears down the threads' environments
   * on it, which needs the machine. So for one, bb-box waits up to `waitMs`
   * for BB to finish, as the box must not go first, and keeps its record of
   * the machine until BB no longer has it (#539).
   */
  async #remove(hostId: string, waitMs = this.#manualRemoveMs): Promise<void> {
    const key = `${MANUAL_PREFIX}${hostId}`;
    const made = await this.#deps.kv.get<ManualMachine>(key);
    const removing = made?.removing ?? this.#now();
    try {
      await this.#deps.hosts().delete({ hostId });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (!made) return;
    const left = await this.#removing(hostId, waitMs);
    if (left === null) await this.#deps.kv.delete(key);
    else await this.#stillRemoving(hostId, { ...made, removing }, left);
  }

  /** Waits up to `waitMs` for BB to no longer have machine `hostId`. Null once it has not; otherwise what BB says of it. */
  async #removing(hostId: string, waitMs: number): Promise<string | null> {
    const deadline = this.#now() + waitMs;
    for (;;) {
      let host: HostState;
      try {
        host = await this.#deps.hosts().get({ hostId });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      if (host.lifecycle.phase === "removed") return null;
      // With the machine's name, which is its box's, to see which machine stays and why (#539).
      if (this.#now() >= deadline) return `${host.name ? `"${host.name}" is ` : ""}${host.lifecycle.phase}, ${host.lifecycle.message ?? host.status}`;
      await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
    }
  }

  /** Keeps the record of a manual machine BB is still removing, and logs it once BB has taken longer than a release waits. */
  async #stillRemoving(hostId: string, made: ManualMachine & { removing: number }, left: string): Promise<void> {
    const stuck = this.#now() - made.removing >= this.#manualRemoveMs;
    if (stuck && !made.stuck) {
      this.#deps.log?.(
        `BB has not finished removing machine ${hostId}, a manual machine bb-box made for a Windows box, ${Math.round((this.#now() - made.removing) / 1000)} s after bb-box asked: ${left}. bb-box keeps its record, and its sweep looks again.`,
      );
    }
    await this.#deps.kv.set(`${MANUAL_PREFIX}${hostId}`, { ...made, stuck: made.stuck || stuck } satisfies ManualMachine);
  }

  /**
   * Removes each manual machine bb-box made whose box is gone, or whose box
   * no longer names it once an enrolment has had time to (#539), and
   * forgets one BB no longer has.
   */
  async #sweepManual(signal?: AbortSignal): Promise<void> {
    for (const key of await this.#deps.kv.list(MANUAL_PREFIX)) {
      if (signal?.aborted) return;
      const hostId = key.slice(MANUAL_PREFIX.length);
      const made = await this.#deps.kv.get<ManualMachine>(key);
      // One bb-box asked BB to remove: forgotten once BB no longer has it.
      if (made?.removing) {
        const left = await this.#removing(hostId, 0).catch((error) => (this.#deps.logError("sweep manual machines", error), "unknown"));
        if (left === null) await this.#deps.kv.delete(key);
        else await this.#stillRemoving(hostId, { ...made, removing: made.removing }, left);
        continue;
      }
      const box = made ? await this.#deps.boxes.find(made.boxId) : null;
      const gone = !box || box.state === "releasing" || box.state === "gone" || box.state === "failed";
      const unnamed = !!box && box.enrol.hostId !== hostId && this.#now() - (made?.at ?? 0) > MANUAL_GRACE_MS;
      if (!made || gone || unnamed) {
        this.#deps.log?.(`Removing BB machine ${hostId}, a manual machine bb-box made for a Windows box: ${box ? `box ${box.name} no longer uses it` : "its box is gone"}.`);
        await this.#remove(hostId, 0).catch((error) => this.#deps.logError("sweep manual machines", error));
      }
    }
  }

  /**
   * Starts BB's daemon again after bb-box started a stopped box: bootstrap
   * with the same key. Returns once BB shows the machine connected again and
   * the box's commands have the thread's variables, or the waits for them
   * end. A box whose machine BB removed meanwhile is left unenrolled.
   */
  async reconnect(box: BoxRecord, stop?: AbortSignal): Promise<void> {
    const hostId = box.enrol.hostId;
    if (!hostId || this.#reconnecting.has(box.id) || stop?.aborted) return;
    this.#reconnecting.add(box.id);
    try {
      const reach = await this.#reach(box);
      if ((await this.#identityTurn(box.id, () => this.#recordReset(box.id, hostId, stop))) === "recover") {
        await this.#recover(box.id);
        return;
      }
      // Its own time limit, or the plugin stopping, whichever comes first.
      const signal = stop ? AbortSignal.any([this.#untilStopping(AbortSignal.timeout(this.#timeoutMs)), stop]) : this.#untilStopping(AbortSignal.timeout(this.#timeoutMs));
      try {
        // A thread's own box joined BB under the thread's key; any other under its own ID.
        const key = box.role === "machine" ? box.threadId : box.id;
        await this.#bootstrapAgain(box, hostId, reach, { key, executor: executor(reach.command, undefined, reach.daemonKeptByHost?.installerEnvironment), report: QUIET, signal });
      } catch (error) {
        await this.#deps.boxes.update(box, (current) =>
          current.enrol.hostId !== hostId ? {} : { enrol: { ...current.enrol, error: describeError(error, "Reconnecting the box's BB machine") } },
        );
        throw error;
      }
      const reconnected = await this.#deps.boxes.update(box, (current) =>
        current.enrol.hostId !== hostId ? {} : { enrol: { ...current.enrol, state: "enrolled", error: null } },
      );
      if (reconnected?.enrol.hostId !== hostId || stop?.aborted) return;
      const connected = await this.#connected(reconnected, hostId, stop);
      if (connected !== null && !stop?.aborted) await this.#variables(reconnected, "the machine connected again", connected);
      if (reconnected.capabilities.os === "windows" && !stop?.aborted) void this.#hideConsoles(reconnected);
    } finally {
      this.#reconnecting.delete(box.id);
    }
  }

  /**
   * Hides the windows of BB's daemon's consoles on a Windows box's desktop,
   * which BB starts in front, so a person's first keys go to them and a
   * Ctrl+C could stop the daemon, until BB starts them hidden (bb-requests
   * 27). After an enrolment and each reconnect. Never throws.
   */
  async #hideConsoles(box: BoxRecord): Promise<void> {
    try {
      const transport = await this.#transport(box);
      const { consoles, hidden } = await hideBbConsoles(transport, { timeoutMs: 60_000 });
      if (hidden) this.#deps.log?.(`Hid ${hidden} of BB's ${consoles} console ${consoles === 1 ? "window" : "windows"} on box ${box.name}'s desktop (bb-requests 27).`);
    } catch (error) {
      this.#deps.logError("hide BB's console windows", error);
    }
  }

  /** Whether BB shows machine `hostId` connected within `ms`. */
  async #connectedWithin(hostId: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = this.#now() + ms;
    for (;;) {
      if (signal?.aborted) return false;
      if ((await abortable(this.#deps.hosts().get({ hostId }), signal)).status === "connected") return true;
      if (this.#now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
    }
  }

  /**
   * After an acquire claims a spare (032): gives its machine the box's name,
   * and says whether BB shows the machine disconnected, so bb-box starts
   * BB's daemon again.
   */
  async claimed(box: BoxRecord): Promise<boolean> {
    const hostId = box.enrol.hostId;
    if (!hostId) return false;
    // The rename goes on in the background: nothing in the box needs it.
    void this.#rename(box, hostId);
    const host = await this.#deps.hosts().get({ hostId });
    return host.lifecycle.phase === "active" && host.status !== "connected";
  }

  /**
   * Waits for BB to show a box's machine connected after its daemon started
   * again, for as long as an enrolment waits for the variables. Returns when
   * it did, or null.
   */
  async #connected(box: BoxRecord, hostId: string, stop?: AbortSignal): Promise<number | null> {
    const deadline = this.#now() + this.#variablesWaitMs;
    for (;;) {
      if (stop?.aborted) return null;
      const host = await abortable(this.#deps.hosts().get({ hostId }), stop);
      if (host.lifecycle.phase !== "active") return null;
      if (host.status === "connected") return this.#now();
      if (this.#now() >= deadline) {
        this.#deps.log?.(`BB did not show box ${box.name}'s machine connected ${waited(this.#variablesWaitMs)} after its daemon started again.`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, this.#fastPollMs));
    }
  }

  /**
   * Part of the sweep: starts BB's daemon again in each ready, enrolled box
   * that BB shows disconnected, as after a reboot bb-box did not start, such
   * as the host's (017). A machine BB no longer has leaves its box unenrolled.
   */
  /** Starts BB's daemon again in each enrolled box whose machine BB shows disconnected. Ends at once when `signal` aborts, as when the plugin stops. */
  async sweep(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await this.#sweepManual(signal).catch((error) => this.#deps.logError("sweep manual machines", error));
    const all = await this.#deps.boxes.all();
    for (const box of all) {
      if (box.state !== "ready") continue;
      if (box.identityReset && box.identityReset.enrolledAgainAt === null) void this.#recover(box.id);
      else if (box.removedMachineToCheck) void this.#checkRemovedMachine(box);
      else if (dueToJoin(box, this.#now())) void this.#tryAgain(box.id);
      else if (failedBeforeTries(box)) void this.#startTries(box.id);
    }
    const enrolled = all.filter((box) => box.state === "ready" && box.enrol.state === "enrolled" && box.enrol.hostId);
    await Promise.all(
      enrolled.map(async (box) => {
        try {
          const host = await abortable(this.#deps.hosts().get({ hostId: box.enrol.hostId! }), signal);
          if (host.status === "connected" || host.lifecycle.phase !== "active") return;
          await this.reconnect(box, signal);
        } catch (error) {
          if (signal?.aborted) return;
          if (isNotFound(error)) await this.#machineGone(box, box.enrol.hostId!, { removedInBb: false });
          else this.#deps.logError("reconnect", error);
        }
      }),
    );
  }

  async #resetThatRemoved(box: BoxRecord, machine: string, signal?: AbortSignal): Promise<ResetFound> {
    if (!this.#deps.boxes.identityChecked(box)) return { found: "none" };
    try {
      const { command } = await this.#reach(box);
      const record = await readIdentityResets(command, signal);
      if (record.state === "absent") return { found: "none" };
      const reset = resetThatRemoved(record.resets, machine);
      return reset ? { found: "reset", reset } : { found: "none" };
    } catch (error) {
      if (this.#isStopping(error) || signal?.aborted) throw error;
      return { found: "unread", why: error instanceof Error ? error.message : String(error) };
    }
  }

  #identityTurn<T>(boxId: string, work: () => Promise<T>): Promise<T> {
    const turn = (this.#identityTurns.get(boxId) ?? Promise.resolve()).catch(() => undefined).then(work);
    const done = turn.catch(() => undefined);
    this.#identityTurns.set(boxId, done);
    void done.then(() => {
      if (this.#identityTurns.get(boxId) === done) this.#identityTurns.delete(boxId);
    });
    return turn;
  }

  async #recordReset(boxId: string, machine: string, signal?: AbortSignal): Promise<"recover" | null> {
    const box = await this.#deps.boxes.find(boxId);
    if (!box) return null;
    if (recoveryPending(box)) return box.identityReset!.machine === machine ? "recover" : null;
    const found = await this.#resetThatRemoved(box, machine, signal);
    if (found.found !== "reset") return null;
    await this.#deps.boxes.identityResetFound(box, { at: found.reset.at, why: found.reset.why, machine });
    return "recover";
  }

  async #machineGone(box: BoxRecord, machine: string, options: { readonly removedInBb: boolean }): Promise<void> {
    if (box.identityReset?.machine === machine) {
      void this.#recover(box.id);
      return;
    }
    if ((await this.#identityTurn(box.id, () => this.#decideMachineGone(box.id, machine, options))) === "recover") void this.#recover(box.id);
  }

  async #decideMachineGone(boxId: string, machine: string, options: { readonly removedInBb: boolean }): Promise<"recover" | null> {
    const box = await this.#deps.boxes.find(boxId);
    if (!box) return null;
    if (recoveryPending(box)) return box.identityReset!.machine === machine ? "recover" : null;
    if (box.enrol.hostId && box.enrol.hostId !== machine) return null;
    const seen = identityState(box);
    const found = await this.#resetThatRemoved(box, machine);
    if (found.found === "reset") {
      await this.#deps.boxes.identityResetFound(box, { at: found.reset.at, why: found.reset.why, machine });
      return "recover";
    }
    if (found.found === "unread") {
      await this.#deps.boxes.machineToCheck(box, machine, found.why);
      return null;
    }
    await this.#deps.kv.delete(`${MANUAL_PREFIX}${machine}`);
    let release = false;
    const decided = await this.#deps.boxes.update(box, (current) => {
      const named = current.enrol.hostId === machine || (current.enrol.hostId === null && current.removedMachineToCheck?.machine === machine);
      if (identityState(current) !== seen || recoveryPending(current) || !named) return {};
      // One of your machines lives as its BB machine (036): removing that in BB removes the box.
      release = options.removedInBb && current.threadId === OPERATOR && current.state !== "releasing" && current.enrol.state !== "failed";
      return { enrol: current.enrol.hostId === machine ? gone(current.enrol) : current.enrol, removedMachineToCheck: null };
    });
    if (release && decided) await this.#deps.boxes.release(OPERATOR, decided.id, "its BB machine was removed in BB");
    return null;
  }

  async #checkRemovedMachine(box: BoxRecord): Promise<void> {
    const check = box.removedMachineToCheck;
    if (!check) return;
    try {
      if ((await this.#identityTurn(box.id, () => this.#decideMachineGone(box.id, check.machine, { removedInBb: true }))) === "recover") void this.#recover(box.id);
    } catch (error) {
      if (!this.#isStopping(error)) this.#deps.logError("check a removed machine for an identity reset", error);
    }
  }

  async #recover(boxId: string): Promise<void> {
    if (this.#recovering.has(boxId)) return;
    this.#recovering.add(boxId);
    try {
      let box = await this.#deps.boxes.find(boxId);
      if (!box?.identityReset || box.identityReset.enrolledAgainAt !== null || box.state !== "ready" || box.role === "machine") return;
      if (box.identityReset.retiredAt === null) {
        if (!(await this.#retire(box.identityReset.machine))) return;
        box = await this.#deps.boxes.identityResetRetired(boxId);
        if (!box?.identityReset) return;
      }
      if (waitingToJoin(box)) {
        if (!dueToJoin(box, this.#now())) return;
        await this.#tryAgain(boxId, "reset");
        await this.#deps.boxes.enrolledAgainAfterReset(boxId);
        return;
      }
      if (box.enrol.state === "failed" || (box.enrol.state === "enrolling" && box.enrol.hostId === box.identityReset.machine)) {
        box = await this.#deps.boxes.update(box, () => ({ enrol: { state: "off", hostId: null, error: null } }));
        if (!box) return;
      }
      if (box.enrol.state === "off") await this.enrol(box, { since: "reset" });
      await this.#deps.boxes.enrolledAgainAfterReset(boxId);
    } catch (error) {
      if (!this.#isStopping(error)) this.#deps.logError("enrol again after an identity reset", error);
    } finally {
      this.#recovering.delete(boxId);
    }
  }

  async #retire(machine: string): Promise<boolean> {
    try {
      await this.#deps.hosts().delete({ hostId: machine });
    } catch (error) {
      if (!isNotFound(error)) {
        this.#deps.logError("remove the BB machine an identity reset left", error);
        return false;
      }
    }
    const left = await this.#removing(machine, this.#manualRemoveMs).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    if (left === null) return true;
    this.#deps.log?.(`BB has not finished removing machine ${machine}, which an identity reset left: ${left}. bb-box asks again at its next sweep, and enrols the box as a new machine only once it has.`);
    return false;
  }

  async #afterTry(boxId: string): Promise<void> {
    const box = await this.#deps.boxes.find(boxId);
    if (!box || box.state !== "ready" || box.enrol.state !== "failed" || box.role === "machine") return;
    const found = joinProblem(box.enrol.error ?? "");
    if (!found) {
      if (box.joinTries) await this.#deps.boxes.update(box, () => ({ joinTries: null }));
      return;
    }
    const failed = (box.joinTries?.failed ?? 0) + 1;
    const now = this.#now();
    const since = box.joinTries?.since ?? now;
    const verdict = backendVerdict(box, await this.#deps.boxes.all());
    const planned = nextTry({ failed, problem: found.problem, verdict, now, since, waits: this.#joinWaitsMs });
    const stopped = planned.next === null;
    const settled = await this.#deps.boxes.update(box, (current) =>
      current.enrol.state !== "failed"
        ? {}
        : {
            joinTries: { failed, next: planned.next, words: found.sentence, problem: found.problem, setup: planned.setup, machine: current.enrol.hostId, since },
            enrol: planned.gaveUp
              ? { state: "failed", hostId: null, error: gaveUpWords({ sentence: found.sentence, failed, verdict, backendLabel: current.backendLabel, setup: planned.setup, stopped }) }
              : { state: "enrolling", hostId: null, error: null },
          },
    );
    if (!settled?.joinTries) return;
    if (planned.next !== null) this.#tryAt(boxId, planned.next);
    const when = planned.next === null ? null : `${PRODUCT} tries again in ${waitWords(planned.next - this.#now())}.`;
    const after = when ?? `${PRODUCT} gave up, ${waitWords(now - since)} after the first failure of this round.`;
    this.#deps.log?.(
      planned.gaveUp
        ? `Box ${settled.name} did not join BB after ${failed} ${failed === 1 ? "try" : "tries"}${planned.setup ? `, and no box on ${settled.backendLabel} reaches BB` : verdict === "others joined" ? `, while other boxes on ${settled.backendLabel} joined` : ""}: ${found.sentence} ${after}`
        : `Box ${settled.name} did not join BB at try ${failed} of ${JOIN_TRIES}: ${found.sentence} ${after}`,
    );
  }

  async tryNow(box: BoxRecord): Promise<BoxRecord | null> {
    if (box.state !== "ready" || box.role === "machine" || !box.capabilities.enrol) return null;
    return this.#tryAtOnce(box, (current) => current.enrol.state === "failed" || waitingToJoin(current));
  }

  async joinAgain(box: BoxRecord): Promise<JoinAgain> {
    if (box.role === "machine") throw new BoxError("unsupported", `Box ${box.name} is a thread's own machine, which BB adds itself, so ${PRODUCT} cannot add it to BB again.`);
    if (!box.capabilities.enrol) throw new BoxError("unsupported", `A ${box.kindLabel} box cannot become a BB machine.`);
    if (box.state !== "ready") throw new BoxError("not_ready", `Box ${box.name} is ${box.state}, and only a ready box can join BB. ${PRODUCT} does not start a box to add it to BB: start it first.`);
    if (box.enrol.state === "enrolled") return { is: "joined", box };
    if (this.isTrying(box.id) || joiningNow(box)) return { is: "joining", box };
    const known = namedMachine(box);
    if (known) {
      const kept = await this.#keptAsMachine(box, known);
      const latest = (await this.#deps.boxes.find(box.id)) ?? box;
      if (kept === "live") return { is: "joined", box: latest };
      if (kept === "adding") return { is: "joining", box: latest };
    }
    const marked = await this.#tryAtOnce(box, (current) => current.state === "ready" && current.enrol.state !== "enrolled" && !joiningNow(current));
    if (marked) return { is: "trying", box: marked };
    const latest = (await this.#deps.boxes.find(box.id)) ?? box;
    return { is: latest.enrol.state === "enrolled" ? "joined" : "joining", box: latest };
  }

  isTrying(boxId: string): boolean {
    return this.#following.has(boxId) || this.#trying.has(boxId) || this.#recovering.has(boxId);
  }

  async #tryAtOnce(box: BoxRecord, accepts: (current: BoxRecord) => boolean): Promise<BoxRecord | null> {
    if (this.isTrying(box.id)) return null;
    const now = this.#now();
    const marked = await this.#deps.boxes.update(box, (current) => {
      if (!accepts(current)) return {};
      const tries = current.joinTries;
      const newRound = current.enrol.state !== "enrolling";
      return {
        enrol: { state: "enrolling", hostId: null, error: null },
        joinTries: {
          failed: newRound ? 0 : (tries?.failed ?? 0),
          next: now,
          words: tries?.words ?? current.enrol.error ?? "",
          problem: tries?.problem ?? null,
          setup: tries?.setup ?? false,
          machine: tries?.machine ?? current.enrol.hostId,
          since: newRound ? now : (tries?.since ?? now),
        },
      };
    });
    if (!marked?.joinTries || marked.joinTries.next !== now) return null;
    void this.#tryAgain(marked.id, recoveryPending(marked) ? "reset" : "retry");
    return marked;
  }

  async #machineInBb(hostId: string): Promise<MachineInBb> {
    try {
      const host = await this.#deps.hosts().get({ hostId });
      if (GONE_PHASES.has(host.lifecycle.phase)) return "gone";
      return host.lifecycle.phase === "active" ? "live" : "adding";
    } catch (error) {
      if (isNotFound(error)) return "gone";
      throw error;
    }
  }

  async #keptAsMachine(box: BoxRecord, hostId: string): Promise<MachineInBb> {
    const found = await this.#machineInBb(hostId);
    if (found !== "live") return found;
    const kept = await this.#deps.boxes.update(box, (current) =>
      current.state !== "ready" || current.enrol.state === "enrolled" ? {} : { enrol: { state: "enrolled", hostId, error: null }, joinTries: null },
    );
    if (kept?.enrol.state === "enrolled" && kept.enrol.hostId === hostId) {
      this.#nextTries.get(box.id)?.();
      this.#nextTries.delete(box.id);
      this.#deps.log?.(`Box ${kept.name}'s machine ${hostId} is in BB, so bb-box records the box as a BB machine and neither removes that machine nor adds the box again.`);
    }
    return found;
  }

  async #startTries(boxId: string): Promise<void> {
    if (this.isTrying(boxId)) return;
    this.#trying.add(boxId);
    try {
      const box = await this.#deps.boxes.find(boxId);
      if (!box || !failedBeforeTries(box) || !(await this.#deps.boxes.enrols(box))) return;
      const known = namedMachine(box);
      if (known && (await this.#keptAsMachine(box, known)) !== "gone") return;
      this.#deps.log?.(`Box ${box.name} could not join BB and had no tries planned, as a box that failed before bb-box tried such failures again: bb-box plans them now.`);
      await this.#afterTry(boxId);
    } catch (error) {
      if (!this.#isStopping(error)) this.#deps.logError("plan tries to add a box to BB", error);
    } finally {
      this.#trying.delete(boxId);
    }
  }

  async #tryAgain(boxId: string, since: EnrolSince = "retry"): Promise<void> {
    if (this.#trying.has(boxId) || this.#following.has(boxId)) return;
    this.#trying.add(boxId);
    try {
      const box = await this.#deps.boxes.find(boxId);
      if (!box || box.role === "machine" || !dueToJoin(box, this.#now())) return;
      const left = box.joinTries!.machine ?? (box.enrol.state === "failed" ? box.enrol.hostId : null);
      const known = namedMachine(box);
      if (known && (await this.#keptAsMachine(box, known)) !== "gone") {
        if ((await this.#deps.boxes.find(boxId))?.enrol.state === "enrolled") return;
        const at = this.#now() + RETIRE_AGAIN_MS;
        await this.#deps.boxes.update(box, (current) => (current.joinTries ? { joinTries: { ...current.joinTries, next: at } } : {}));
        this.#tryAt(boxId, at);
        return;
      }
      if (left && !(await this.#retire(left))) {
        const at = this.#now() + RETIRE_AGAIN_MS;
        await this.#deps.boxes.update(box, (current) => (current.joinTries ? { joinTries: { ...current.joinTries, next: at } } : {}));
        this.#tryAt(boxId, at);
        return;
      }
      const trying = await this.#deps.boxes.update(box, (current) =>
        !dueToJoin(current, this.#now()) ? {} : { enrol: { state: "enrolling", hostId: null, error: null }, joinTries: { ...current.joinTries!, next: null, machine: null } },
      );
      if (!trying?.joinTries || trying.joinTries.next !== null) return;
      this.#deps.log?.(`Adding box ${trying.name} to BB again, ${tryWords(trying.joinTries.failed)}.`);
      await this.enrol(trying, { since });
    } catch (error) {
      if (!this.#isStopping(error)) this.#deps.logError("try again to add a box to BB", error);
    } finally {
      this.#trying.delete(boxId);
    }
  }

  async machineDeleted(hostId: string): Promise<void> {
    await this.#deps.kv.delete(`${MANUAL_PREFIX}${hostId}`);
    for (const box of await this.#deps.boxes.all()) {
      if (box.enrol.hostId === hostId || box.identityReset?.machine === hostId) await this.#machineGone(box, hostId, { removedInBb: false });
    }
  }

  /** BB removed a machine, for example from its Machines page: its box is no longer enrolled. */
  async forgetHost(hostId: string): Promise<void> {
    await this.#deps.kv.delete(`${MANUAL_PREFIX}${hostId}`);
    for (const box of await this.#deps.boxes.all()) {
      if (box.enrol.hostId === hostId) await this.#deps.boxes.update(box, (current) => ({ enrol: gone(current.enrol) }));
    }
  }

  /** Follows enrolments a restart interrupted. */
  async resume(): Promise<void> {
    for (const box of await this.#deps.boxes.all()) {
      if (box.state !== "ready" || box.enrol.state !== "enrolling" || waitingToJoin(box)) continue;
      void this.enrol(box, { since: "resumed" });
    }
  }
}
