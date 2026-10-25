// bb box setup docker (the setup plan's PR 5): what the Box panel's first
// run does, for an agent or a terminal. It picks the BB machine that can
// take Docker boxes, the one that runs BB first, turns its Docker on with
// the Linux image alone, and waits for the image to build. Where something
// stands in the way, it gives that machine's own line to fix it. A plugin's
// command cannot print as it goes, so it says how far the build is when it
// ends, or at once with --no-wait.

import type { ApplyResult } from "./configuration.ts";
import type { ImageBuild } from "./docker-images.ts";
import { building, needsSignIn, restartWords, setupTarget, type MachineAccessProblem, type MachineSetup } from "./setup-offer.ts";

export interface SetupDockerDeps {
  setups(): Promise<MachineSetup[]>;
  setDockerHost(hostId: string, enabled: boolean, linuxOnly: boolean): Promise<ApplyResult>;
  ensure(hostId: string): Promise<ImageBuild>;
  machineAccess(): Promise<MachineAccessProblem | null>;
  now?(): number;
  /** How long --no-wait gives the build before it answers. */
  readonly glanceMs?: number;
}

export interface SetupDockerResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const AGAIN = "Run bb box setup docker again to wait for it, or with --no-wait to see how far it is.";

function minutes(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
}

function targetsWords(build: ImageBuild): string {
  const names = build.targets.map((target) => (target === "linux" ? "Linux" : target === "desktop" ? "desktop" : "Wayland desktop"));
  return names.length ? `the ${names.join(" and ")} image${names.length > 1 ? "s" : ""}` : "the images";
}

/** Where a build is, in a sentence. */
export function progressWords(setup: MachineSetup, now: number): string {
  const build = setup.build!;
  const step = build.step ? (build.image && build.image.of > 1 ? `, image ${build.image.at} of ${build.image.of}, step ${build.step.at} of ${build.step.of}` : `, step ${build.step.at} of ${build.step.of}`) : "";
  return `Building ${targetsWords(build)} on ${setup.name}${step}, started ${minutes(Math.max(0, now - build.startedAt))} ago.`;
}

/** What to do where BB's machine access will not let boxes join BB, as the panel says it (#661). */
export function accessWords(access: MachineAccessProblem): string {
  const how = needsSignIn(access.message)
    ? "Sign in to your bb account in BB, or set Machine access to Manual in BB's settings, under Machines, with an address boxes can reach."
    : `${access.message.replace(/\.?$/, ".")} See Machine access in BB's settings, under Machines.`;
  return `Boxes will not join BB yet. ${how}`;
}

/** The machine `wanted` names, by ID or name, or the one first-run setup would take. */
function pick(machines: readonly MachineSetup[], wanted: string | undefined): MachineSetup | string {
  if (wanted) {
    const found = machines.find((setup) => setup.hostId === wanted) ?? machines.find((setup) => setup.name.toLowerCase() === wanted.toLowerCase());
    if (found) return found;
    return machines.length ? `BB has no machine ${wanted} that can host boxes. These can: ${machines.map((setup) => setup.name).join(", ")}.` : `BB has no machine ${wanted} that can host boxes.`;
  }
  const target = setupTarget(machines) ?? machines.find((setup) => setup.state === "on" && setup.here) ?? machines.find((setup) => setup.state === "on");
  if (target) return target;
  if (!machines.length) return "BB has no machine that can host boxes yet.";
  const why = machines.map((setup) => `${setup.name}: ${setup.state === "none" ? "no Docker" : (setup.problem ?? "offline in BB").replace(/\.$/, "")}`).join("; ");
  return `No BB machine has Docker that BB Box can use. ${why}. Install Docker Engine on one, or set up another backend in BB Box's settings.`;
}

export async function setupDocker(deps: SetupDockerDeps, options: { machine?: string; wait: boolean; signal?: AbortSignal }): Promise<SetupDockerResult> {
  const now = () => deps.now?.() ?? Date.now();
  const picked = pick(await deps.setups(), options.machine);
  if (typeof picked === "string") return { exitCode: 1, stderr: `${picked}\n` };
  const setup = picked;
  if (setup.state === "none") return { exitCode: 1, stderr: `${setup.name} has no Docker. Install Docker Engine there, then run this again.\n` };
  if (setup.state === "offline") return { exitCode: 1, stderr: `${setup.name} is offline in BB. ${setup.problem ?? ""}`.trim() + "\n" };
  if (setup.state === "fix") {
    const lines = [setup.problem ?? `Docker on ${setup.name} cannot be used yet.`];
    if (setup.fix) {
      lines.push("", `On ${setup.name}, run:`, `  ${setup.fix}`, ...(setup.restart ? [`  ${setup.restart}`] : []), restartWords(setup.restart));
    }
    lines.push("", "Then run bb box setup docker again.");
    return { exitCode: 1, stderr: `${lines.join("\n")}\n` };
  }
  if (setup.state === "ready") {
    const result = await deps.setDockerHost(setup.hostId, true, true);
    if (!result.ok) {
      const why = result.reason === "problems" ? result.problems.map((problem) => problem.message).join(" ") : "Someone else saved BB Box's settings at the same moment. Run this again.";
      return { exitCode: 1, stderr: `Docker on ${setup.name} was not turned on: ${why}\n` };
    }
  }
  const access = await deps.machineAccess().catch(() => null);
  const after = access ? `\n${accessWords(access)}` : "";
  const next = "\nMake a box with box_acquire, or with the plus in a thread's Box panel.";
  const build = deps.ensure(setup.hostId);
  // Without waiting, a check that finds nothing to build still ends: it is given a moment before the answer.
  const stop = new Promise<null>((resolve) => {
    options.signal?.addEventListener("abort", () => resolve(null), { once: true });
    if (!options.wait) setTimeout(() => resolve(null), deps.glanceMs ?? 2_000);
  });
  const ended = await Promise.race([build, stop]);
  if (!ended && !options.wait) {
    // The build has started, or was going already: say where it is.
    const current = (await deps.setups()).find((candidate) => candidate.hostId === setup.hostId);
    if (current && building(current)) return { exitCode: 0, stdout: `Docker on ${setup.name} is on for BB Box. ${progressWords(current, now())} ${AGAIN}${after}\n` };
  }
  if (!ended) return { exitCode: 0, stdout: `Docker on ${setup.name} is on for BB Box, and its images go on building. ${AGAIN}${after}\n` };
  const took = ended.endedAt !== null ? ` in ${minutes(ended.endedAt - ended.startedAt)}` : "";
  if (ended.state === "failed") return { exitCode: 1, stderr: `Docker on ${setup.name} is on for BB Box, but ${targetsWords(ended)} did not build${took ? `, after${took.replace(/^ in/, "")}` : ""}: ${ended.detail ?? "no reason given"}\n` };
  const built = ended.targets.length ? `${targetsWords(ended)[0]!.toUpperCase()}${targetsWords(ended).slice(1)} built${took}.` : "It has every image it needs.";
  return { exitCode: 0, stdout: `Docker on ${setup.name} is set up for BB Box. ${built}${next}${after}\n` };
}
