// Boxes as BB machines (decision 014). bb-box registers a machine provider
// and enrols a ready box by creating a machine keyed by the box ID. The
// provider's create runs BB's bootstrap through the box's command transport,
// as the box user. Releasing a box removes its machine first. After bb-box
// starts a stopped box, or when the sweep finds a ready box's machine
// disconnected, bootstrap runs again with the same key to start BB's daemon
// (017). A box the sweep restores from its guest enrols again with the same
// key once it runs and answers, and BB gives back the machine it still has
// for it (025, 026). A spare's machine is named "<name> (spare)" until an
// acquire claims the box, which gives it the box's name (032).
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
// box's commands find one, or 10 s later, and the box's first command has
// them. A reconnect waits in the same way for BB to show the machine
// connected again, then for such a worker.
// Each enrolment logs how long its steps took.

import type { MachineExecutor, PluginMachineProviderDeclaration } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { describeError, machineName, type BoxRecord, type Boxes } from "../core/boxes.ts";
import { ACCESS_CHECK_EXITS, accessCheck, accessSetup, accessSetupMs } from "../core/in-box.ts";
import type { CommandTransport } from "../transports/types.ts";

export const MACHINE_PROVIDER_ID = "bb-box";

/** The parts of BB's host API enrolment uses. */
export interface HostApi {
  experimental_create(args: { machineProviderId: string; key: string; inputs: { boxId: string }; wait: false }): Promise<HostState>;
  get(args: { hostId: string; signal?: AbortSignal }): Promise<HostState>;
  update(args: { hostId: string; name: string }): Promise<unknown>;
  delete(args: { hostId: string }): Promise<unknown>;
}

export interface HostState {
  readonly id: string;
  readonly status: "connected" | "disconnected";
  readonly lifecycle: { readonly phase: string; readonly message: string | null };
}

interface Progress {
  step(text: string): void;
  log(text: string): void;
}

export interface EnrolmentDeps {
  readonly boxes: Boxes;
  readonly hosts: () => HostApi;
  bootstrap(request: { key: string; executor: MachineExecutor; report: Progress; signal: AbortSignal }): Promise<{ hostId: string }>;
  logError(operation: string, error: unknown): void;
  log?(message: string): void;
  /** How long an enrolment may take before bb-box gives up on it. */
  readonly timeoutMs?: number;
  /** How often to ask BB about the machine, until bootstrap returns. */
  readonly pollMs?: number;
  /** How often to ask once bootstrap has returned. */
  readonly fastPollMs?: number;
  /** How long to wait, once the machine connects, for a worker with the thread's variables. */
  readonly variablesWaitMs?: number;
}

const QUIET: Progress = { step: () => {}, log: () => {} };
const ACCESS_SETUP_TIMEOUT_MS = 60_000;
const ACCESS_CHECK_TIMEOUT_MS = 10_000;
const VARIABLES_POLL_MS = 250;

/** A wait for the log, such as "10 s" or "0.3 s". */
function waited(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

function sh(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Runs BB's installer commands in the box, as the box user, through its command transport. */
export function executor(transport: CommandTransport, phases?: Phases): MachineExecutor {
  return {
    async exec({ command, stdin, timeoutMs, signal, onOutput }) {
      const decoder = new TextDecoder();
      phases?.mark("install");
      const result = await transport.stream(command.map(sh).join(" "), {
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
  { end: "called", after: [], label: "BB calling bb-box's create" },
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
export type EnrolSince = "ready" | "resumed" | "restored";

const SINCE: Record<EnrolSince, string> = {
  ready: "it was ready",
  resumed: "bb-box resumed following it",
  restored: "bb-box found the restored box answering",
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
  /** Boxes whose enrolment this process is following. */
  readonly #following = new Set<string>();
  /** Boxes whose BB daemon this process is starting again. */
  readonly #reconnecting = new Set<string>();
  /** The steps of each enrolment this process is following. */
  readonly #phases = new Map<string, Phases>();

  constructor(deps: EnrolmentDeps) {
    this.#deps = deps;
    this.#timeoutMs = deps.timeoutMs ?? 5 * 60_000;
    this.#pollMs = deps.pollMs ?? 500;
    this.#fastPollMs = deps.fastPollMs ?? 100;
    this.#variablesWaitMs = deps.variablesWaitMs ?? 10_000;
  }

  /** The machine provider BB calls to create and remove a box's machine. */
  provider(): PluginMachineProviderDeclaration<z.ZodObject<{ boxId: z.ZodString }>> {
    const boxes = this.#deps.boxes;
    return {
      id: MACHINE_PROVIDER_ID,
      displayName: "bb-box",
      description: "A box an agent or the bb-box panel acquired. bb-box adds it when the box is ready.",
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
          const transport = await this.#transport(box);
          phases?.mark("prepared");
          report.step(`Installing BB in box ${box.name}`);
          await this.#deps.bootstrap({ key, executor: executor(transport, phases), report, signal });
          phases?.mark("bootstrapped");
          return { status: "created", name: machineName(box), resource: { boxId: box.id } };
        } catch (error) {
          return { status: "failed", message: describeError(error, `Enrolling box ${box.name}`) };
        }
      },
      // The box is bb-box's, and outlives its machine: removing the machine leaves the box running.
      reconcileCleanup: async () => ({ status: "removed" }),
      remove: async ({ resource }) => {
        const boxId = (resource as { boxId?: unknown }).boxId;
        if (typeof boxId === "string") await this.#off(boxId);
        return { status: "removed" };
      },
    };
  }

  async #transport(box: BoxRecord): Promise<CommandTransport> {
    const { command } = await this.#deps.boxes.transports(box);
    if (!command) throw new Error(`bb-box cannot run commands in box ${box.name}.`);
    return command;
  }

  async #off(boxId: string): Promise<void> {
    const box = await this.#deps.boxes.find(boxId);
    if (box) await this.#deps.boxes.update(box, () => ({ enrol: { state: "off", hostId: null, error: null } }));
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
    const phases = new Phases(since === "ready" ? (box.readyAt ?? Date.now()) : Date.now(), Date.now, since);
    this.#phases.set(box.id, phases);
    try {
      let current: BoxRecord = box;
      if (!box.enrol.hostId) {
        const host = await this.#deps.hosts().experimental_create({
          machineProviderId: MACHINE_PROVIDER_ID,
          key: box.id,
          inputs: { boxId: box.id },
          wait: false,
        });
        phases.mark("requested");
        const recorded = await this.#deps.boxes.update(box, () => ({ enrol: { state: "enrolling", hostId: host.id, error: null } }));
        // Released meanwhile: its release did not know the machine yet.
        if (!recorded || recorded.state === "releasing") {
          await this.#remove(host.id);
          return;
        }
        current = recorded;
        // BB still had the box's machine, as for a box the sweep restored,
        // and its daemon is not running. BB does not create the machine
        // again, so bootstrap with the same key starts the daemon.
        if (host.lifecycle.phase === "active" && host.status !== "connected") {
          const transport = await this.#transport(current);
          await this.#deps.bootstrap({ key: box.id, executor: executor(transport, phases), report: QUIET, signal: AbortSignal.timeout(this.#timeoutMs) });
          phases.mark("bootstrapped");
        }
      }
      await this.#follow(current, phases, this.#setUpAccess(current, phases));
    } catch (error) {
      this.#deps.logError("enrol", error);
      await this.#deps.boxes
        .update(box, (current) => ({ enrol: { ...current.enrol, state: "failed", error: describeError(error, "Enrolling the box") } }))
        .catch(() => null);
    } finally {
      this.#phases.delete(box.id);
      this.#following.delete(box.id);
    }
  }

  /** Waits for BB to show the machine connected. `access` is the access setup running alongside. */
  async #follow(box: BoxRecord, phases: Phases, access: Promise<void>): Promise<void> {
    const hostId = box.enrol.hostId!;
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const current = await this.#deps.boxes.find(box.id);
      if (!current || current.state === "releasing" || current.enrol.hostId !== hostId) return;
      const host = await this.#deps.hosts().get({ hostId });
      const phase = host.lifecycle.phase;
      if (phase === "active" && host.status === "connected") {
        const connected = Date.now();
        phases.mark("connected", connected);
        await access;
        await this.#variables(current, "the machine connected", connected, phases);
        // BB may have removed the machine during the waits, and the box is then not enrolled.
        // A resumed enrolment's own time is only its last part, so the box shows none.
        const enrolled = await this.#deps.boxes.update(box, (latest) =>
          latest.enrol.hostId !== hostId
            ? {}
            : {
                enrol: { state: "enrolled", hostId, error: null },
                ...(phases.since === "resumed" ? {} : { timings: { ...latest.timings, enrol: Date.now() - phases.origin } }),
              },
        );
        if (enrolled?.enrol.hostId !== hostId) return;
        phases.mark("enrolled");
        this.#deps.log?.(phases.line(enrolled.name));
        return;
      }
      if (phase === "destroyed" || phase === "removing") {
        const reason = host.lifecycle.message ?? "BB removed the machine before it connected.";
        await this.#deps.boxes.update(box, () => ({ enrol: { state: "failed", hostId: null, error: reason } }));
        return;
      }
      if (Date.now() > deadline) {
        const reason = `BB did not finish adding the box as a machine within ${Math.round(this.#timeoutMs / 60_000)} minutes.${host.lifecycle.message ? ` ${host.lifecycle.message}` : ""}`;
        await this.#deps.boxes.update(box, () => ({ enrol: { state: "failed", hostId, error: reason } }));
        return;
      }
      await phases.sleep(phases.marks.has("bootstrapped") ? this.#fastPollMs : this.#pollMs);
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
        if (Date.now() >= deadline) {
          this.#deps.log?.(`BB's daemon in box ${box.name} had no worker with the thread's variables ${waited(this.#variablesWaitMs)} after ${since}. Its commands take them once one has.`);
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
    if (box.enrol.hostId) await this.#remove(box.enrol.hostId);
  }

  async #remove(hostId: string): Promise<void> {
    try {
      await this.#deps.hosts().delete({ hostId });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  /**
   * Starts BB's daemon again after bb-box started a stopped box: bootstrap
   * with the same key. Returns once BB shows the machine connected again and
   * the box's commands have the thread's variables, or the waits for them
   * end. A box whose machine BB removed meanwhile is left unenrolled.
   */
  async reconnect(box: BoxRecord): Promise<void> {
    const hostId = box.enrol.hostId;
    if (!hostId || this.#reconnecting.has(box.id)) return;
    this.#reconnecting.add(box.id);
    try {
      const transport = await this.#transport(box);
      const signal = AbortSignal.timeout(this.#timeoutMs);
      try {
        // A thread's own box joined BB under the thread's key; any other under its own ID.
        const key = box.role === "machine" ? box.threadId : box.id;
        await this.#deps.bootstrap({ key, executor: executor(transport), report: QUIET, signal });
      } catch (error) {
        await this.#deps.boxes.update(box, (current) =>
          current.enrol.hostId !== hostId ? {} : { enrol: { ...current.enrol, error: describeError(error, "Reconnecting the box's BB machine") } },
        );
        throw error;
      }
      const reconnected = await this.#deps.boxes.update(box, (current) =>
        current.enrol.hostId !== hostId ? {} : { enrol: { ...current.enrol, state: "enrolled", error: null } },
      );
      if (reconnected?.enrol.hostId !== hostId) return;
      const connected = await this.#connected(reconnected, hostId);
      if (connected !== null) await this.#variables(reconnected, "the machine connected again", connected);
    } finally {
      this.#reconnecting.delete(box.id);
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
    void this.#deps
      .hosts()
      .update({ hostId, name: machineName(box) })
      .catch((error) => this.#deps.logError("rename machine", error));
    const host = await this.#deps.hosts().get({ hostId });
    return host.lifecycle.phase === "active" && host.status !== "connected";
  }

  /**
   * Waits for BB to show a box's machine connected after its daemon started
   * again, for as long as an enrolment waits for the variables. Returns when
   * it did, or null.
   */
  async #connected(box: BoxRecord, hostId: string): Promise<number | null> {
    const deadline = Date.now() + this.#variablesWaitMs;
    for (;;) {
      const host = await this.#deps.hosts().get({ hostId });
      if (host.lifecycle.phase !== "active") return null;
      if (host.status === "connected") return Date.now();
      if (Date.now() >= deadline) {
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
  async sweep(): Promise<void> {
    const enrolled = (await this.#deps.boxes.all()).filter((box) => box.state === "ready" && box.enrol.state === "enrolled" && box.enrol.hostId);
    await Promise.all(
      enrolled.map(async (box) => {
        try {
          const host = await this.#deps.hosts().get({ hostId: box.enrol.hostId! });
          if (host.status === "connected" || host.lifecycle.phase !== "active") return;
          await this.reconnect(box);
        } catch (error) {
          if (isNotFound(error)) await this.forgetHost(box.enrol.hostId!);
          else this.#deps.logError("reconnect", error);
        }
      }),
    );
  }

  /** BB removed a machine, for example from its Machines page: its box is no longer enrolled. */
  async forgetHost(hostId: string): Promise<void> {
    for (const box of await this.#deps.boxes.all()) {
      if (box.enrol.hostId === hostId) await this.#deps.boxes.update(box, () => ({ enrol: { state: "off", hostId: null, error: null } }));
    }
  }

  /** Follows enrolments a restart interrupted. */
  async resume(): Promise<void> {
    for (const box of await this.#deps.boxes.all()) {
      if (box.state !== "ready" || box.enrol.state !== "enrolling") continue;
      void this.enrol(box, { since: "resumed" });
    }
  }
}
