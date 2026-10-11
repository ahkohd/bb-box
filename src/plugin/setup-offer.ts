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
}

const ORDER: Record<MachineSetup["state"], number> = { on: 0, ready: 1, fix: 2, none: 3, offline: 4 };

/** Each BB machine's setup, the server's first, then those that can be set up now. */
export function machineSetups(hosts: readonly DockerHostView[], facts: ReadonlyMap<string, SetupFacts>, serverHostname: string): MachineSetup[] {
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
      };
      if (!host.connected) return { ...base, state: "offline", problem: host.problem };
      if (host.backend?.enabled) return { ...base, state: "on" };
      if (host.docker) {
        if (known?.freeGb !== null && known?.freeGb !== undefined && known.freeGb < LINUX_BUILD_GB) {
          return { ...base, state: "fix", problem: `The Linux image needs about ${LINUX_BUILD_GB} GB free to build, and ${base.here ? "this machine" : host.name} has ${known.freeGb} GB. Free some, for example with docker builder prune, then check again.` };
        }
        return { ...base, state: "ready" };
      }
      if (host.absent) return { ...base, state: "none" };
      // Docker is there, but refused BB's daemon: its user is not in the socket's group, or joined it after the daemon started.
      if (known && known.inSocketGroup === false) {
        const group = known.socketGroup ?? "docker";
        return {
          ...base,
          state: "fix",
          problem: `Docker is on ${base.here ? "this machine" : host.name}, but BB's user, ${known.user}, cannot use it. Add ${known.user} to the ${group} group, then restart BB's daemon there.`,
          fix: `sudo usermod -aG ${group} ${known.user}`,
          restart: known.restart,
        };
      }
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
