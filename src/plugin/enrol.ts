// Boxes as BB machines (decision 014). bb-box registers a machine provider
// and enrols a ready box by creating a machine keyed by the box ID. The
// provider's create runs BB's bootstrap through the box's command transport,
// as the box user. Releasing a box removes its machine first. After bb-box
// starts a stopped box, or when the sweep finds a ready box's machine
// disconnected, bootstrap runs again with the same key to start BB's daemon
// (017).
//
// Plugins can read the names of BB's machine variables but not their values;
// BB gives the values, and GH_TOKEN, to its daemon in the box. Commands in a
// Linux box source ~/.config/bb-box/env, which bb-box writes before each
// command it runs: the box's identity, and a loader that takes those
// variables from the daemon's process as the command starts. Once the daemon
// connects, the box's ~/.bashrc sources the file too, for the thread's own
// SSH commands, and git takes GitHub credentials from gh.
//
// Setting up that access runs alongside BB's bootstrap, which touches
// neither ~/.bashrc nor git's settings. bb-box asks BB about the machine
// every 500 ms, and every 100 ms once bootstrap has returned, since BB shows
// the machine connected soon after. Each enrolment logs how long its steps
// took.

import type { MachineExecutor, PluginMachineProviderDeclaration } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { describeError, type BoxRecord, type Boxes } from "../core/boxes.ts";
import { accessSetup, accessSetupMs } from "../core/in-box.ts";
import type { CommandTransport } from "../transports/types.ts";

export const MACHINE_PROVIDER_ID = "bb-box";

/** The parts of BB's host API enrolment uses. */
export interface HostApi {
  experimental_create(args: { machineProviderId: string; key: string; inputs: { boxId: string }; wait: false }): Promise<{ id: string }>;
  get(args: { hostId: string; signal?: AbortSignal }): Promise<HostState>;
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
}

const QUIET: Progress = { step: () => {}, log: () => {} };
const ACCESS_SETUP_TIMEOUT_MS = 60_000;

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
  { end: "enrolled", after: ["connected", "accessed"], label: "finishing" },
];

/**
 * When each step of one enrolment ended, counted from when the box was
 * ready, or for an enrolment `resumed` after a restart, from then.
 */
export class Phases {
  readonly origin: number;
  readonly resumed: boolean;
  readonly #now: () => number;
  readonly marks = new Map<string, number>();
  #wake: (() => void) | null = null;

  constructor(origin: number, now: () => number = Date.now, resumed = false) {
    this.origin = origin;
    this.#now = now;
    this.resumed = resumed;
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
    const from = this.resumed ? "bb-box resumed following it" : "it was ready";
    return `Enrolled box ${boxName} ${seconds(last - this.origin)} after ${from}: ${describe(STEPS)}.`;
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
          return { status: "created", name: box.name, resource: { boxId: box.id } };
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
   * Makes a ready box a BB machine and waits until its daemon connects, or
   * with `resumed`, follows an enrolment a restart interrupted. Never throws.
   */
  async enrol(box: BoxRecord, options: { resumed?: boolean } = {}): Promise<void> {
    if (this.#following.has(box.id)) return;
    this.#following.add(box.id);
    // Enrolment starts once the box is ready, so its time counts from then.
    // A resumed one's time from then would count the restart too.
    const phases = options.resumed ? new Phases(Date.now(), Date.now, true) : new Phases(box.readyAt ?? Date.now());
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
        phases.mark("connected");
        await access;
        // A resumed enrolment's own time is only its last part, so the box shows none.
        const enrolled = await this.#deps.boxes.update(box, (latest) => ({
          enrol: { state: "enrolled", hostId, error: null },
          ...(phases.resumed ? {} : { timings: { ...latest.timings, enrol: Date.now() - phases.origin } }),
        }));
        phases.mark("enrolled");
        if (enrolled) this.#deps.log?.(phases.line(enrolled.name));
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

  /** Starts BB's daemon again after bb-box started a stopped box: bootstrap with the same key. */
  async reconnect(box: BoxRecord): Promise<void> {
    if (this.#reconnecting.has(box.id)) return;
    this.#reconnecting.add(box.id);
    try {
      const transport = await this.#transport(box);
      const signal = AbortSignal.timeout(this.#timeoutMs);
      try {
        await this.#deps.bootstrap({ key: box.id, executor: executor(transport), report: QUIET, signal });
      } catch (error) {
        await this.#deps.boxes.update(box, (current) => ({
          enrol: { ...current.enrol, error: describeError(error, "Reconnecting the box's BB machine") },
        }));
        throw error;
      }
      await this.#deps.boxes.update(box, (current) => ({ enrol: { ...current.enrol, state: "enrolled", error: null } }));
    } finally {
      this.#reconnecting.delete(box.id);
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
      void this.enrol(box, { resumed: true });
    }
  }
}
