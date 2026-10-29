// First-run setup (the operator's setup job, 11 October 2026): what each BB
// machine offers bb-box, so the Box panel and settings can offer one action,
// such as "Use Docker on this machine", or one line that fixes what stands
// in its way. It reads what the Docker host list already knows (042), and
// the facts bb-box's host entry gives with it: who BB's daemon runs as, how
// it restarts, KVM, and free disk.

import type { SetupFacts } from "../host/relay.ts";
import type { ImageBuild } from "./docker-images.ts";
import type { DockerHostView } from "./docker-hosts.ts";

/** Disk the Linux image needs free to build, in GB, as setup/docker/build.sh checks. */
export const LINUX_BUILD_GB = 10;

export interface MachineSetup {
  readonly hostId: string;
  readonly name: string;
  /** The machine that runs BB's server, which the panel offers first and calls "this machine". */
  readonly here: boolean;
  /**
   * on: bb-box already uses its Docker. ready: Docker answers, and one click sets it up.
   * fix: Docker is there, but something stands in the way. none: no Docker. offline: BB cannot reach it.
   */
  readonly state: "on" | "ready" | "fix" | "none" | "offline";
  /** Docker's version, where it answers. */
  readonly docker: string | null;
  /** What stands in the way, in a sentence, for `fix`. */
  readonly problem: string | null;
  /** The one line that fixes it, when bb-box knows it. */
  readonly fix: string | null;
  /** The command that restarts BB's daemon after the fix, or null to say "restart BB" in words. Restarting it ends running threads' turns. */
  readonly restart: string | null;
  readonly kvm: SetupFacts["kvm"] | null;
  readonly freeGb: number | null;
  /** The machine's image build, running or last. */
  readonly build: ImageBuild | null;
  /** How long each image last took to build alone there, in ms, by build target ("linux", "desktop"): its next estimate. */
  readonly took: Readonly<Record<string, number>>;
  readonly boxFollows?: boolean;
}

export interface DockerFix {
  readonly problem: string;
  readonly command: string | null;
  readonly restart: string | null;
}

export function dockerFix(host: Pick<DockerHostView, "name" | "connected" | "docker" | "absent" | "backend">, known: SetupFacts | null, here: boolean): DockerFix | null {
  if (!host.connected) return null;
  const where = here ? "this machine" : host.name;
  if (host.docker) {
    if (host.backend?.enabled || known?.freeGb === null || known?.freeGb === undefined || known.freeGb >= LINUX_BUILD_GB) return null;
    return { problem: `The Linux image needs about ${LINUX_BUILD_GB} GB free to build, and ${where} has ${known.freeGb} GB. Free some, for example with docker builder prune, then check again.`, command: null, restart: null };
  }
  if (host.absent || known?.inSocketGroup !== false) return null;
  const group = known.socketGroup ?? "docker";
  return {
    problem: `Docker is on ${where}, but BB's user, ${known.user}, cannot use it. Add ${known.user} to the ${group} group, then restart BB's daemon there.`,
    command: `sudo usermod -aG ${group} ${known.user}`,
    restart: known.restart,
  };
}

const ORDER: Record<MachineSetup["state"], number> = { on: 0, ready: 1, fix: 2, none: 3, offline: 4 };

/** Each BB machine's setup, the server's first, then those that can be set up now. */
export function machineSetups(
  hosts: readonly DockerHostView[],
  facts: ReadonlyMap<string, SetupFacts>,
  serverHostname: string,
  took: ReadonlyMap<string, Readonly<Record<string, number>>> = new Map(),
): MachineSetup[] {
  return hosts
    .map((host): MachineSetup => {
      const known = facts.get(host.hostId) ?? null;
      const base = {
        hostId: host.hostId,
        name: host.name,
        here: known?.hostname === serverHostname,
        docker: host.docker?.version ?? null,
        problem: null,
        fix: null,
        restart: null,
        kvm: known?.kvm ?? null,
        freeGb: known?.freeGb ?? null,
        build: host.images,
        took: took.get(host.hostId) ?? {},
      };
      if (!host.connected) return { ...base, state: "offline", problem: host.problem };
      if (host.backend?.enabled) return { ...base, state: "on" };
      const fix = dockerFix(host, known, base.here);
      if (host.docker) return fix ? { ...base, state: "fix", problem: fix.problem } : { ...base, state: "ready" };
      if (host.absent) return { ...base, state: "none" };
      if (fix) return { ...base, state: "fix", problem: fix.problem, fix: fix.command, restart: fix.restart };
      return { ...base, state: "fix", problem: host.problem };
    })
    .sort((a, b) => Number(b.here) - Number(a.here) || ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}

/** Why BB's machine access will not let boxes join BB, as BB's Machines settings would say it. */
export interface MachineAccessProblem {
  /** The way of access BB uses, such as "bb connect". */
  readonly provider: string;
  /** BB's own words, such as "Sign in to your bb account to use bb connect". */
  readonly message: string;
}

/** The parts of BB's system configuration that say how machines reach BB. */
export interface AccessConfig {
  readonly generalSettings?: { readonly defaultMachineAccess?: string | null };
  readonly serverAccess?: {
    readonly defaultProviderId: string;
    readonly providers: readonly { readonly id: string; readonly displayName: string; readonly availability: { readonly status: string; readonly message?: string } | null }[];
  };
}

/**
 * What stands in the way of boxes joining BB: the way of access BB uses, unless it is available. Null where it is, or
 * where bb-box cannot tell. A box joins BB through it, so without it every box's enrolment fails (the newcomer check:
 * BB's desktop app starts with bb connect, which needs a sign-in).
 */
export function machineAccessProblem(config: AccessConfig | null): MachineAccessProblem | null {
  const access = config?.serverAccess;
  if (!access) return null;
  const id = config.generalSettings?.defaultMachineAccess ?? access.defaultProviderId;
  const provider = access.providers.find((candidate) => candidate.id === id);
  const availability = provider?.availability;
  if (!provider || !availability || availability.status === "available") return null;
  return { provider: provider.displayName, message: availability.message ?? `${provider.displayName} is not set up.` };
}

/** Whether BB's words say its machine access needs a sign-in to the user's bb account, as bb connect does. */
export function needsSignIn(words: string | null): boolean {
  return !!words && /sign in to your bb account/i.test(words);
}

/** Whether the machine's image build is going on. */
export const building = (setup: MachineSetup) => setup.build?.state === "checking" || setup.build?.state === "building";

/** The machine setup is about: one building, else the one that runs BB if it can be set up, else the first that can. */
export function setupTarget(machines: readonly MachineSetup[]): MachineSetup | null {
  return (
    machines.find(building) ??
    machines.find((setup) => setup.here && (setup.state === "ready" || setup.state === "fix")) ??
    machines.find((setup) => setup.state === "ready") ??
    machines.find((setup) => setup.state === "fix") ??
    null
  );
}

/**
 * What the restart does, beside its line. A user service's restart restarts all of that user's services, so on a machine
 * where the user also has a desktop it ends its audio, notifications and the like too; logging out and in, or rebooting,
 * is the gentler way. Every way ends the turns of threads running there.
 */
export function restartWords(restart: string | null): string {
  if (!restart) return "Then restart BB there, or log out and in again, or reboot. That ends the turns of threads running there.";
  if (/^sudo systemctl restart user@\d+\.service$/.test(restart)) {
    return "The second line restarts all of that user's services, BB's daemon among them. That ends the turns of threads running there and, if the user has a desktop there, its audio, notifications and other services too. Logging out and in again, or rebooting, does the same more gently.";
  }
  return "The second line restarts BB's daemon there, which ends the turns of threads running there. Rebooting does the same.";
}
