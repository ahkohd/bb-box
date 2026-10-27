import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { placementData, readPlacement, slotModelRefusal, slotPorts, slotUser, LAST_GENERATION, type SlotKind, type SlotLender, type SlotPlacement, type SlotTaken, type SlotTier } from "../../core/device-host.ts";
import { pause } from "../../transports/ready.ts";
import { quote } from "../../transports/process.ts";
import type { RunResult, SshAccess } from "../../transports/types.ts";
import type { SshTransport } from "../../transports/ssh.ts";
import { setupDir } from "../setup-dir.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type BoxTransports, type DoctorCheck, type Guest, type HeldGuest, type PowerState, type StopReason } from "../types.ts";
import type { IosHostsConfig, TartConfig, TartHost } from "./config.ts";
import { DEVICE_HOST_EXITS, DEVICE_HOST_HELPER, claimantInput, helperCommand, parseHostStatus, slotDaemonKeptByHost, type HostSlotLine, type HostStatus, type SlotClaimant } from "./device-host.ts";
import { claimScript, ownerText, parseFields, script, type HostState } from "./host.ts";

export const HOST_ROLE = "device-host";
export const HOST_VM_PREFIX = "bb-box-host-";
export const HOST_STARTING_MS = 55_000;
export const SLOT_MAKING_MS = 33_000;
export const ABANDONED_START_MS = 5 * 60_000;
export const NEXT_SLOT_WORDS = "The next slot is likely free when a box on a shared host is released.";
const HOST_READY_MS = 10 * 60_000;
const SLOT_READY_MS = 5 * 60_000;
const CLAIM_WAIT_MS = 2_000;
const MEMORY_FREE_LEAST = 15;
const HELPER_SOURCE = "tart/ios/device-host.sh";
const POLL_MS = 1_000;
const STATES_REUSED_MS = 15_000;
const LEAVING_WAIT_MS = 5 * 60_000;
const ROOM_POLL_MS = 10_000;
const DELETING_LEFT_MS = 2 * 60_000;
const HANDING_OVER_MS = 5 * 60_000;
export const DOCTOR_HOST_MS = 15_000;
const CHAIN_WAIT_LOGGED_MS = 2_000;

export type HostPhase = "starting" | "serving" | "failed";

export interface HostOwner {
  readonly vm: string;
  readonly mac: TartHost;
  readonly phase: HostPhase;
  readonly promised: readonly string[];
  readonly made: number;
  readonly image: string;
  readonly build: string | null;
  readonly settings: IosHostsConfig;
  readonly failure: string | null;
  readonly handingOverSince: number | null;
}

export interface HostsAccess {
  readonly installId: string;
  config(): TartConfig;
  macs(): readonly TartHost[];
  mac(name: string | null): TartHost | null;
  states(signal?: AbortSignal): Promise<ReadonlyMap<string, HostState | Error>>;
  hostRoom(mac: TartHost, state: HostState | Error, settings: IosHostsConfig, leaving: ReadonlySet<string>): string | null;
  placement<T>(task: () => Promise<T>): Promise<T>;
  encoderLoad?(mac: TartHost): number;
  placing(mac: TartHost, vm: string, memoryMiB: number): () => void;
  run(mac: TartHost, body: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RunResult>;
  boot(mac: TartHost, vm: string, size: { readonly cores: number; readonly memoryMiB: number } | null, deadline: number, signal?: AbortSignal): Promise<string>;
  address(mac: TartHost, vm: string): Promise<string | null>;
  vmCommand(mac: TartHost, address: string): Promise<SshTransport>;
  slotAccess(mac: TartHost, address: string, user: string): Promise<{ readonly command: SshTransport; readonly access: SshAccess }>;
  waitAnswers(mac: TartHost, vm: string, access: SshAccess, deadline: number, signal?: AbortSignal): Promise<void>;
  deleteVm(mac: TartHost, vm: string, signal?: AbortSignal): Promise<void>;
  publicKey(): Promise<string>;
  logError(operation: string, error: unknown): void;
  log(message: string): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface SlotRef {
  readonly vm: string;
  readonly slot: string | null;
}

export function slotRefOf(guest: Guest): SlotRef | null {
  const vm = guest.data?.slotVm;
  if (typeof vm !== "string" || !vm.startsWith(HOST_VM_PREFIX)) return null;
  const slot = guest.data?.slot;
  return { vm, slot: typeof slot === "string" ? slot : null };
}

export function isHostOwner(fields: Readonly<Record<string, string>>): boolean {
  return fields.role === HOST_ROLE;
}

function wholeOf(text: string | undefined, fallback: number): number {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : fallback;
}

export function readHostOwner(vm: string, mac: TartHost, fields: Readonly<Record<string, string>>, defaults: IosHostsConfig): HostOwner {
  const phase = fields["host-state"];
  return {
    vm,
    mac,
    phase: phase === "serving" || phase === "failed" ? phase : "starting",
    promised: (fields.promised ?? "").split(/\s+/).filter(Boolean),
    made: wholeOf(fields.made, 0),
    image: fields.image ?? "",
    build: fields.build || null,
    failure: fields.failed || null,
    handingOverSince: fields["handing-over"] && /^\d+$/.test(fields["handing-over"]) ? Number(fields["handing-over"]) : null,
    settings: {
      on: true,
      most: wholeOf(fields.most, defaults.most),
      ahead: wholeOf(fields.ahead, defaults.ahead),
      resettingMost: wholeOf(fields["resetting-most"], defaults.resettingMost),
      cores: wholeOf(fields.cores, defaults.cores),
      memoryGiB: wholeOf(fields["memory-gib"], defaults.memoryGiB),
      perMac: defaults.perMac,
      diskReserveGiB: wholeOf(fields["disk-reserve-gib"], defaults.diskReserveGiB),
    },
  };
}

const OWNER_LOCK = String.raw`l="$d/run/$vm.lock"
i=0
until mkdir "$l" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 100 ]; then rmdir "$l" 2>/dev/null; mkdir "$l" 2>/dev/null; break; fi
  sleep 0.1
done
trap 'rmdir "$l" 2>/dev/null' EXIT
mine_host() { grep -qxF "install=$1" "$f" 2>/dev/null && grep -qx 'role=${HOST_ROLE}' "$f"; }
value() { sed -n "s/^$1=//p" "$f" | head -n 1; }
rewrite() { { grep -v "^$1=" "$f"; printf '%s=%s\n' "$1" "$2"; } > "$f.new" && mv -f "$f.new" "$f"; }
`;

export function hostPromiseScript(vm: string, installId: string, box: string, most: number): string {
  return script(String.raw`vm=${quote(vm)}; f="$d/owners/$vm"; box=${quote(box)}
${OWNER_LOCK}
mine_host ${quote(installId)} || { echo gone; exit 0; }
state=$(value host-state)
[ "$state" = starting ] || { echo "state=$state"; exit 0; }
promised=$(value promised)
case " $promised " in *" $box "*) echo promised; exit 0 ;; esac
[ "$(printf '%s\n' $promised | grep -c .)" -lt ${most} ] || { echo full; exit 0; }
rewrite promised "$(echo $promised $box)"
echo promised
`);
}

export function hostUnpromiseScript(vm: string, installId: string, box: string): string {
  return script(String.raw`vm=${quote(vm)}; f="$d/owners/$vm"; box=${quote(box)}
${OWNER_LOCK}
mine_host ${quote(installId)} || { echo gone; exit 0; }
left=$(printf '%s\n' $(value promised) | grep -vxF "$box" | grep . | tr '\n' ' ')
rewrite promised "$(echo $left)"
echo "state=$(value host-state)"
echo "left=$(echo $left)"
`);
}

export function hostServingScript(vm: string, installId: string): string {
  return script(String.raw`vm=${quote(vm)}; f="$d/owners/$vm"
${OWNER_LOCK}
mine_host ${quote(installId)} || { echo gone; exit 0; }
rewrite handing-over "$(date +%s)"
rewrite host-state serving
echo "promised=$(value promised)"
`);
}

export function hostHandedOverScript(vm: string, installId: string): string {
  return script(String.raw`vm=${quote(vm)}; f="$d/owners/$vm"
${OWNER_LOCK}
mine_host ${quote(installId)} || { echo gone; exit 0; }
grep -v '^handing-over=' "$f" > "$f.new" && mv -f "$f.new" "$f"
echo handed
`);
}

export function hostPhaseScript(vm: string, installId: string, phase: HostPhase, words: string | null = null): string {
  return script(String.raw`vm=${quote(vm)}; f="$d/owners/$vm"
${OWNER_LOCK}
mine_host ${quote(installId)} || { echo gone; exit 0; }
rewrite host-state ${quote(phase)}
${words ? `rewrite failed ${quote(words.replace(/\s+/g, " "))}` : ""}
echo "promised=$(value promised)"
`);
}

function helperInstallCommand(): string {
  return `sudo -n /bin/sh -c 'umask 022; mkdir -p "$(dirname "$1")" && cat > "$1.new" && chmod 755 "$1.new" && mv -f "$1.new" "$1"' sh ${DEVICE_HOST_HELPER}`;
}

function slotNameOf(id: string): { readonly carried: true; readonly generation: 1 | 2 } | { readonly carried: false; readonly generation: number } | null {
  if (id === "i1" || id === "i2") return { carried: true, generation: id === "i1" ? 1 : 2 };
  return /^\d+$/.test(id) && Number(id) >= 1 && Number(id) <= LAST_GENERATION ? { carried: false, generation: Number(id) } : null;
}

export function slotPlacement(vm: string, id: string, portBase: number, most: number): SlotPlacement | null {
  const name = slotNameOf(id);
  const place = (portBase - slotPorts(0).base) / slotPorts(0).count;
  if (!name || !Number.isInteger(place) || place < 0 || place >= most) return null;
  return { on: "slot", host: vm, hostOn: "tart", ...name, place, most };
}

interface Surveyed {
  readonly owner: HostOwner;
  readonly running: boolean;
  readonly address: string | null;
  readonly status: HostStatus | null;
  readonly why: string | null;
}

function readyFor(slot: HostSlotLine, box: string | null, acquiring: ReadonlySet<string>): boolean {
  return slot.is === "ready" && (slot.madeFor === null || slot.madeFor === box || !acquiring.has(slot.madeFor));
}

function spareMaking(slot: HostSlotLine, box: string | null): boolean {
  return slot.is === "making" && (slot.madeFor === null || slot.madeFor === box);
}

function heldCount(status: HostStatus): number {
  return status.slots.filter((slot) => slot.is === "held").length;
}

export function noRoomWords(vm: string, status: HostStatus): string | null {
  if (status.generation >= LAST_GENERATION) return `The shared iOS host ${vm} has given all its slot UIDs.`;
  if (status.counted + status.promises.length >= status.most) return `The shared iOS host ${vm} has all its ${status.most} slots making, ready, held or promised (${heldCount(status)} held).`;
  if (status.diskGiB !== null && status.diskGiB < status.diskReserveGiB) return `The shared iOS host ${vm} has ${status.diskGiB} GiB of disk free, under the ${status.diskReserveGiB} GiB it keeps.`;
  if (status.memoryFreePercent !== null && status.memoryFreePercent < MEMORY_FREE_LEAST) return `The shared iOS host ${vm} has ${status.memoryFreePercent}% of its memory free, under ${MEMORY_FREE_LEAST}%.`;
  return null;
}

export class IosHosts implements SlotLender {
  readonly on = "tart" as const;
  readonly #access: HostsAccess;
  readonly #starts = new Map<string, Promise<void>>();
  readonly #boots = new Map<string, Promise<void>>();
  readonly #deletions = new Map<string, Promise<void>>();
  readonly #releasing = new Map<string, number>();
  #hostsSeen = false;
  #lastStates: { readonly at: number; readonly states: ReadonlyMap<string, HostState | Error> } | null = null;
  readonly #acquiring = new Map<string, number>();
  readonly #acquiringBoxes = new Set<string>();
  readonly #stopping = new AbortController();
  readonly #doctorHostMs: number;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(access: HostsAccess, doctorHostMs = DOCTOR_HOST_MS) {
    this.#access = access;
    this.#doctorHostMs = doctorHostMs;
  }

  get #settings(): IosHostsConfig {
    return this.#access.config().iosHosts;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(task, task);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  #sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.#access.sleep ?? pause)(ms, signal);
  }

  lends(_kind: SlotKind): boolean {
    return this.#settings.on && !!this.#access.config().iosImage;
  }

  #owners(states: ReadonlyMap<string, HostState | Error>): HostOwner[] {
    const owners: HostOwner[] = this.#collect(states);
    if (owners.length) this.#hostsSeen = true;
    return owners;
  }

  #collect(states: ReadonlyMap<string, HostState | Error>): HostOwner[] {
    const owners: HostOwner[] = [];
    for (const mac of this.#access.macs()) {
      const state = states.get(mac.name);
      if (!state || state instanceof Error) continue;
      for (const [vm, fields] of state.owners) {
        if (fields.install !== this.#access.installId || !isHostOwner(fields)) continue;
        owners.push(readHostOwner(vm, mac, fields, this.#settings));
      }
    }
    return owners;
  }

  async #status(command: SshTransport, signal?: AbortSignal): Promise<HostStatus> {
    const result = await command.run(helperCommand("status"), { timeoutMs: 60_000, signal, maxOutputBytes: 1 << 20 });
    const status = result.exitCode === 0 ? parseHostStatus(result.stdout) : null;
    if (!status) throw new Error(`The shared iOS host's helper did not give its status: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    return status;
  }

  async #helper(command: SshTransport, verb: string, args: readonly string[], stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    return command.run(helperCommand(verb, ...args), { stdin, timeoutMs, signal, maxOutputBytes: 1 << 16 });
  }

  #running(state: HostState | Error | undefined, vm: string): boolean {
    return !!state && !(state instanceof Error) && state.vms.some((each) => each.name === vm && each.running);
  }

  async #survey(states: ReadonlyMap<string, HostState | Error>, signal?: AbortSignal, boundMs: number | null = null): Promise<Surveyed[]> {
    return Promise.all(
      this.#owners(states).map(async (owner): Promise<Surveyed> => {
        const running = this.#running(states.get(owner.mac.name), owner.vm);
        if (owner.phase !== "serving" || !running) return { owner, running, address: null, status: null, why: null };
        let waitingOn = `its address from Tart on ${owner.mac.name}`;
        const bound = boundMs === null ? null : new AbortController();
        const timer = bound && setTimeout(() => bound.abort(), boundMs!);
        const hostSignal = bound ? (signal ? AbortSignal.any([signal, bound.signal]) : bound.signal) : signal;
        const look = async (): Promise<Surveyed> => {
          const address = await this.#access.address(owner.mac, owner.vm);
          if (!address) return { owner, running, address: null, status: null, why: `The shared iOS host ${owner.vm} on ${owner.mac.name} has no address.` };
          waitingOn = `its helper's status over SSH at ${address}, through ${owner.mac.name}`;
          const status = await this.#status(await this.#access.vmCommand(owner.mac, address), hostSignal);
          return { owner, running, address, status, why: null };
        };
        const gaveUp = bound && new Promise<never>((_, reject) => bound.signal.addEventListener("abort", () => reject(new Error("bounded")), { once: true }));
        try {
          return await (gaveUp ? Promise.race([look(), gaveUp]) : look());
        } catch (error) {
          if (bound?.signal.aborted) return { owner, running, address: null, status: null, why: `The shared iOS host ${owner.vm} on ${owner.mac.name} did not answer within ${Math.round(boundMs! / 1000)} s: bb-box waited on ${waitingOn}.` };
          return { owner, running, address: null, status: null, why: `The shared iOS host ${owner.vm} on ${owner.mac.name} did not answer: ${error instanceof Error ? error.message : String(error)}` };
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }

  #currentBuild(state: HostState | Error | undefined): string | null {
    const image = this.#access.config().iosImage;
    if (!image || !state || state instanceof Error) return null;
    return state.records.get(image)?.build ?? null;
  }

  #slotModel(states: ReadonlyMap<string, HostState | Error>): string | null {
    const image = this.#access.config().iosImage;
    for (const state of states.values()) {
      if (state instanceof Error || !image) continue;
      const model = state.records.get(image)?.devices?.[0]?.model;
      if (model) return model;
    }
    return null;
  }

  #newHostWhy(mac: TartHost, states: ReadonlyMap<string, HostState | Error>, owners: readonly HostOwner[], leaving: ReadonlySet<string> = new Set()): string | null {
    const state = states.get(mac.name);
    if (!state || state instanceof Error) return `${mac.name} did not answer${state ? `: ${state.message}` : ""}`;
    const image = this.#access.config().iosImage;
    if (!image || !state.vms.some((vm) => vm.name === image)) return `${mac.name} has no iOS image ${image ?? ""}`;
    const here = owners.filter((owner) => owner.mac.name === mac.name && owner.phase !== "failed" && !leaving.has(owner.vm)).length;
    if (here >= this.#settings.perMac) return `${mac.name} runs ${here === 1 ? "a shared iOS host" : `${here} shared iOS hosts`} already, as many as it may (${this.#settings.perMac})`;
    return this.#access.hostRoom(mac, state, this.#settings, leaving);
  }

  #leavingOf(surveyed: readonly Surveyed[]): Set<string> {
    return new Set([...this.#deletions.keys(), ...surveyed.flatMap(({ owner, status }) => (status?.deletingSince != null ? [owner.vm] : []))]);
  }

  async #gone(mac: TartHost, leaving: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + LEAVING_WAIT_MS;
    while (leaving.size && Date.now() < deadline) {
      const states = await this.#readStates(signal);
      const state = states.get(mac.name);
      if (state && !(state instanceof Error) && !state.vms.some((vm) => leaving.has(vm.name) && vm.running)) return;
      await this.#sleep(POLL_MS * 2, signal);
    }
  }

  async offer(kind: SlotKind, model: string | null, signal: AbortSignal): Promise<SlotTier> {
    if (!this.lends(kind)) return { tier: "wait", words: "Shared iOS hosts are off in bb-box's Tart settings." };
    const states = await this.#readStates(signal);
    const slotModel = this.#slotModel(states);
    if (model && slotModel && model !== slotModel) return { tier: "wait", words: slotModelRefusal(slotModel, model) };
    const surveyed = await this.#survey(states, signal);
    const owners = surveyed.map((each) => each.owner);
    const leaving = this.#leavingOf(surveyed);
    const tiers: SlotTier[] = [];
    const words: string[] = [];
    const now = Date.now();
    for (const { owner, running, status, why } of surveyed) {
      if (why) words.push(why);
      if (owner.phase === "failed") continue;
      if (owner.phase === "starting") {
        if (owner.promised.length < owner.settings.most) tiers.push({ tier: "join", host: owner.vm, waitMs: Math.max(5_000, owner.made + HOST_STARTING_MS - now) });
        else words.push(`The shared iOS host ${owner.vm} starting on ${owner.mac.name} has all its ${owner.settings.most} slots promised.`);
        continue;
      }
      if (!running) {
        words.push(`The shared iOS host ${owner.vm} on ${owner.mac.name} is starting again.`);
        continue;
      }
      if (!status || status.deletingSince !== null) continue;
      const draining = owner.build !== null && owner.build !== this.#currentBuild(states.get(owner.mac.name));
      if (draining && this.#newHostWhy(owner.mac, states, owners.filter((other) => other.vm !== owner.vm), leaving) === null) continue;
      if (status.slots.some((slot) => readyFor(slot, null, this.#acquiringBoxes))) {
        tiers.push({ tier: "ready", host: owner.vm, waitMs: CLAIM_WAIT_MS });
        continue;
      }
      const full = noRoomWords(owner.vm, status);
      if (status.slots.some((slot) => spareMaking(slot, null))) tiers.push({ tier: "join", host: owner.vm, waitMs: SLOT_MAKING_MS / 2 });
      else if (!full && !draining) tiers.push({ tier: "make", host: owner.vm, waitMs: SLOT_MAKING_MS });
      else words.push(full ?? `The shared iOS host ${owner.vm} on ${owner.mac.name} is on an older build of the iOS image, so it makes no new slot.`);
    }
    for (const mac of this.#access.macs()) {
      const why = this.#newHostWhy(mac, states, owners, leaving);
      if (why === null) tiers.push({ tier: "new-host", where: mac.name, waitMs: HOST_STARTING_MS, cost: "vm-slot" });
      else words.push(`No shared iOS host can start on ${mac.name}: ${why}.`);
    }
    const order = ["ready", "join", "make", "new-host"];
    const loadOf = (tier: SlotTier) => {
      const mac = tier.tier === "new-host" ? this.#access.mac(tier.where) : null;
      return mac ? (this.#access.encoderLoad?.(mac) ?? 0) : 0;
    };
    tiers.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || loadOf(a) - loadOf(b) || ("waitMs" in a && "waitMs" in b ? a.waitMs - b.waitMs : 0));
    if (tiers[0]) return tiers[0];
    const freesFirst = surveyed.some(({ status }) => status && heldCount(status) > 0) ? ` ${NEXT_SLOT_WORDS}` : "";
    return { tier: "wait", words: `${[...new Set(words)].join(" ") || "No Mac can hold a shared iOS host now."}${freesFirst}` };
  }

  async take(choice: SlotTier, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    return this.#serial(async () => {
      switch (choice.tier) {
        case "ready":
          return this.#claimReady(choice.host, box, signal);
        case "join":
        case "make":
          return this.#promise(choice.host, box, signal);
        case "new-host":
          return this.#newHost(choice.where, box, signal);
        default:
          return { lost: `The Tart backend cannot take a ${choice.tier} answer.` };
      }
    });
  }

  async #recentStates(signal?: AbortSignal): Promise<ReadonlyMap<string, HostState | Error>> {
    const recent = this.#lastStates;
    if (recent && Date.now() - recent.at < STATES_REUSED_MS) return recent.states;
    return this.#readStates(signal);
  }

  async #readStates(signal?: AbortSignal): Promise<ReadonlyMap<string, HostState | Error>> {
    const states = await this.#access.states(signal);
    this.#lastStates = { at: Date.now(), states };
    return states;
  }

  async #ownerOf(vm: string, signal?: AbortSignal, recent = false): Promise<{ readonly owner: HostOwner | null; readonly states: ReadonlyMap<string, HostState | Error> }> {
    const states = recent ? await this.#recentStates(signal) : await this.#readStates(signal);
    return { owner: this.#owners(states).find((each) => each.vm === vm) ?? null, states };
  }

  #promiseGuest(mac: TartHost, vm: string, boxId: string): Guest {
    return { ref: `${vm}/for-${boxId}`, host: mac.name, address: null, size: null, data: { box: boxId, slotVm: vm } };
  }

  #slotGuest(mac: TartHost, vm: string, address: string | null, boxId: string, placement: SlotPlacement, id: string): Guest {
    return { ref: `${vm}/${id}`, host: mac.name, address, size: null, data: { box: boxId, slotVm: vm, slot: id, ...placementData(placement) } };
  }

  async #claimant(box: BoxIdentity): Promise<string> {
    const key = (await this.#access.publicKey()).trim();
    return `install=${this.#access.installId}\nbox=${box.boxId}\nthread=${box.threadId}\nname=${box.name}\nkind=${box.kind}\ncreated=${box.createdAt}\nkey=${key}\n`;
  }

  async #claim(mac: TartHost, vm: string, address: string, command: SshTransport, slot: string, box: BoxIdentity, most: number, signal?: AbortSignal): Promise<Guest | { readonly lost: string }> {
    const result = await this.#helper(command, "claim", [slot], await this.#claimant(box), 360_000, signal);
    if (result.exitCode !== DEVICE_HOST_EXITS.done) {
      const said = result.stderr.trim() || `exit code ${result.exitCode}`;
      if (result.exitCode === DEVICE_HOST_EXITS.lost || result.exitCode === DEVICE_HOST_EXITS.notReady || result.exitCode === DEVICE_HOST_EXITS.deleting) return { lost: said };
      throw new Error(`The shared iOS host ${vm} could not lend slot ${slot}: ${said}`);
    }
    const answer = parseFields(result.stdout);
    const placement = slotPlacement(vm, answer.slot ?? slot, Number(answer.ports), most);
    if (!placement) throw new Error(`The shared iOS host ${vm} lent slot ${slot}, but its answer could not be read: ${result.stdout.trim()}`);
    return this.#slotGuest(mac, vm, address, box.boxId, placement, answer.slot ?? slot);
  }

  async #claimReady(vm: string, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    const { owner } = await this.#ownerOf(vm, signal, true);
    if (!owner || owner.phase !== "serving") return { lost: `The shared iOS host ${vm} is no longer serving.` };
    const address = await this.#access.address(owner.mac, vm);
    if (!address) return { lost: `The shared iOS host ${vm} has no address.` };
    const command = await this.#access.vmCommand(owner.mac, address);
    const status = await this.#status(command, signal);
    const ready = status.slots.filter((slot) => readyFor(slot, null, this.#acquiringBoxes)).sort((a, b) => Number(b.carried) - Number(a.carried) || a.uid - b.uid);
    if (!ready.length) return { lost: `The shared iOS host ${vm} has no ready slot now.` };
    return this.#claim(owner.mac, vm, address, command, ready[0]!.id, box, status.most, signal);
  }

  async #promise(vm: string, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    const { owner } = await this.#ownerOf(vm, signal, true);
    if (!owner || owner.phase === "failed") return { lost: `The shared iOS host ${vm} is no longer there.` };
    if (owner.phase === "starting") {
      const said = (await this.#access.run(owner.mac, hostPromiseScript(vm, this.#access.installId, box.boxId, owner.settings.most), { signal })).stdout.trim();
      if (said === "promised") return this.#promiseGuest(owner.mac, vm, box.boxId);
      if (said !== "state=serving") return { lost: said === "full" ? `The shared iOS host ${vm} has all its slots promised.` : `The shared iOS host ${vm} is ${said}.` };
    }
    const address = await this.#access.address(owner.mac, vm);
    if (!address) return { lost: `The shared iOS host ${vm} has no address.` };
    const command = await this.#access.vmCommand(owner.mac, address);
    const result = await this.#helper(command, "promise", [], claimantInput(this.#claimantOf(box)), 90_000, signal);
    if (result.exitCode === DEVICE_HOST_EXITS.done) return this.#promiseGuest(owner.mac, vm, box.boxId);
    if (result.exitCode === DEVICE_HOST_EXITS.full && (await this.#status(command, signal)).slots.some((slot) => spareMaking(slot, null))) return this.#promiseGuest(owner.mac, vm, box.boxId);
    return { lost: result.stderr.trim() || `The shared iOS host ${vm} refused the promise, exit code ${result.exitCode}.` };
  }

  #claimantOf(box: { readonly boxId: string }): SlotClaimant {
    return { install: this.#access.installId, box: box.boxId };
  }

  async #newHost(macName: string, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    const mac = this.#access.mac(macName);
    if (!mac) return { lost: `There is no Mac ${macName} in bb-box's Tart settings.` };
    const settings = this.#settings;
    const image = this.#access.config().iosImage!;
    const asked = performance.now();
    return this.#access.placement(async (): Promise<SlotTaken> => {
      const queued = performance.now() - asked;
      if (queued >= CHAIN_WAIT_LOGGED_MS) this.#access.log(`A new shared iOS host for box ${box.name} waited ${(queued / 1000).toFixed(1)} s for the Tart backend's other placements.`);
      const states = await this.#readStates(signal);
      const leaving = this.#leavingOf(await this.#survey(states, signal));
      const why = this.#newHostWhy(mac, states, this.#owners(states), leaving);
      if (why) return { lost: `No shared iOS host can start on ${mac.name} now: ${why}.` };
      const vm = `${HOST_VM_PREFIX}${randomBytes(5).toString("hex")}`;
      const owner = ownerText({
        install: this.#access.installId,
        role: HOST_ROLE,
        image,
        build: this.#currentBuild(states.get(mac.name)) ?? "",
        made: Date.now(),
        "host-state": "starting",
        promised: box.boxId,
        most: settings.most,
        ahead: settings.ahead,
        "resetting-most": settings.resettingMost,
        "disk-reserve-gib": settings.diskReserveGiB,
        cores: settings.cores,
        "memory-gib": settings.memoryGiB,
      });
      const claimed = (await this.#access.run(mac, claimScript(vm, owner), { signal })).stdout.trim();
      if (claimed !== "claimed") return { lost: `The name ${vm} was taken on ${mac.name}.` };
      const unplace = this.#access.placing(mac, vm, settings.memoryGiB * 1024);
      void this.#start(mac, vm, leaving).finally(unplace).catch(() => undefined);
      this.#access.log(`Starting shared iOS host ${vm} on ${mac.name} for box ${box.name}.`);
      return this.#promiseGuest(mac, vm, box.boxId);
    });
  }

  #bootAgain(mac: TartHost, vm: string): Promise<void> {
    const booting = this.#boots.get(vm);
    if (booting) return booting;
    const began = performance.now();
    const boot = this.#access
      .boot(mac, vm, null, Date.now() + HOST_READY_MS, this.#stopping.signal)
      .then(() => this.#access.log(`Shared iOS host ${vm} on ${mac.name} runs again, ${((performance.now() - began) / 1000).toFixed(1)} s after bb-box started it.`))
      .finally(() => this.#boots.delete(vm));
    this.#boots.set(vm, boot);
    return boot;
  }

  #start(mac: TartHost, vm: string, leaving: ReadonlySet<string> = new Set()): Promise<void> {
    const running = this.#starts.get(vm);
    if (running) return running;
    const started = this.#startHost(mac, vm, leaving).finally(() => this.#starts.delete(vm));
    this.#starts.set(vm, started);
    started.catch((error) => this.#access.logError(`start shared iOS host ${vm}`, error));
    return started;
  }

  async #startHost(mac: TartHost, vm: string, leaving: ReadonlySet<string>): Promise<void> {
    const signal = this.#stopping.signal;
    const began = performance.now();
    const { owner: found } = await this.#ownerOf(vm, signal);
    if (!found) throw new Error(`The shared iOS host ${vm} on ${mac.name} has no owner file.`);
    const owner = found;
    try {
      await this.#gone(mac, leaving, signal);
      const address = await this.#bootWhenRoom(mac, vm, owner.settings, signal);
      const booted = performance.now();
      const command = await this.#access.vmCommand(mac, address);
      await this.#installHelper(command, signal);
      const init = await this.#helper(
        command,
        "init",
        [],
        `most=${owner.settings.most}\nahead=${owner.settings.ahead}\nresetting-most=${owner.settings.resettingMost}\ndisk-reserve-gib=${owner.settings.diskReserveGiB}\n`,
        90_000,
        signal,
      );
      if (init.exitCode !== DEVICE_HOST_EXITS.done) throw new Error(`Its helper's init failed: ${init.stderr.trim() || `exit code ${init.exitCode}`}`);
      const promised = await this.#serial(async () => {
        const said = parseFields((await this.#access.run(mac, hostServingScript(vm, this.#access.installId), { signal })).stdout);
        const boxes = (said.promised ?? "").split(/\s+/).filter(Boolean);
        for (const box of boxes) {
          const result = await this.#helper(command, "promise", [], claimantInput({ install: this.#access.installId, box }), 90_000, signal);
          if (result.exitCode !== DEVICE_HOST_EXITS.done) this.#access.log(`Shared iOS host ${vm} did not take the promise for box ${box}: ${result.stderr.trim()}`);
        }
        await this.#access.run(mac, hostHandedOverScript(vm, this.#access.installId), { signal });
        return boxes;
      });
      this.#access.log(`Shared iOS host ${vm} on ${mac.name} serves, ${((performance.now() - began) / 1000).toFixed(1)} s after its start (its VM ${((booted - began) / 1000).toFixed(1)} s), for ${promised.length} boxes.`);
      if (!promised.length) await this.#vacate(mac, vm, command, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      const words = error instanceof Error ? error.message : String(error);
      await this.#access.run(mac, hostPhaseScript(vm, this.#access.installId, "failed", words), { signal }).catch(() => undefined);
      await this.#access.deleteVm(mac, vm, signal).catch((cause) => this.#access.logError(`delete shared iOS host ${vm}`, cause));
      throw new Error(`The shared iOS host ${vm} on ${mac.name} did not start: ${words}`);
    }
  }

  async #bootWhenRoom(mac: TartHost, vm: string, settings: IosHostsConfig, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + HOST_READY_MS;
    for (;;) {
      try {
        return await this.#access.boot(mac, vm, { cores: settings.cores, memoryMiB: settings.memoryGiB * 1024 }, deadline, signal);
      } catch (error) {
        if (!(error instanceof BackendError) || error.code !== "no_capacity" || Date.now() + ROOM_POLL_MS > deadline) throw error;
        this.#access.log(`Shared iOS host ${vm} waits for room on ${mac.name}: ${error.message}`);
        await this.#sleep(ROOM_POLL_MS, signal);
      }
    }
  }

  async #installHelper(command: SshTransport, signal?: AbortSignal): Promise<void> {
    const source = readFileSync(join(setupDir(), HELPER_SOURCE));
    const result = await command.run(helperInstallCommand(), { stdin: source, timeoutMs: 60_000, signal });
    if (result.exitCode !== 0) throw new Error(`bb-box could not install its device-host helper: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }

  async #vacate(mac: TartHost, vm: string, command: SshTransport, signal?: AbortSignal): Promise<boolean> {
    const result = await this.#helper(command, "vacate", [], `install=${this.#access.installId}\n`, 90_000, signal);
    if (result.exitCode !== DEVICE_HOST_EXITS.done || parseFields(result.stdout).last !== "yes") return false;
    await this.#deleteHost(mac, vm, signal);
    return true;
  }

  async #deleteHost(mac: TartHost, vm: string, signal?: AbortSignal): Promise<void> {
    const began = performance.now();
    const deletion = this.#access.deleteVm(mac, vm, signal);
    this.#deletions.set(vm, deletion);
    try {
      await deletion;
    } finally {
      this.#deletions.delete(vm);
    }
    this.#access.log(`Deleted shared iOS host ${vm} on ${mac.name}, as its last box went, in ${((performance.now() - began) / 1000).toFixed(1)} s.`);
  }

  async #serving(mac: TartHost, vm: string, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + HOST_READY_MS;
    for (;;) {
      signal.throwIfAborted();
      const running = this.#starts.get(vm);
      if (running) {
        await Promise.race([running, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
        continue;
      }
      const { owner, states } = await this.#ownerOf(vm, signal);
      if (!owner) throw new Error(`The shared iOS host ${vm} on ${mac.name} is gone.`);
      if (owner.phase === "failed") throw new Error(`The shared iOS host ${vm} on ${mac.name} failed: ${owner.failure ?? "no reason recorded"}.`);
      if (owner.phase === "starting") {
        await this.#start(mac, vm);
        continue;
      }
      if (!this.#running(states.get(mac.name), vm)) {
        await this.#bootAgain(mac, vm);
        continue;
      }
      const address = await this.#access.address(mac, vm);
      if (address) return address;
      if (Date.now() > deadline) throw new Error(`The shared iOS host ${vm} on ${mac.name} has no address.`);
      await this.#sleep(POLL_MS, signal);
    }
  }

  async acquire(box: BoxIdentity, previous: Guest, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const ref = slotRefOf(previous)!;
    const mac = this.#access.mac(previous.host);
    if (!mac) throw new Error(`The shared iOS host ${ref.vm} is on Mac ${previous.host ?? "unknown"}, which is not in bb-box's Tart settings.`);
    this.#acquiring.set(ref.vm, (this.#acquiring.get(ref.vm) ?? 0) + 1);
    this.#acquiringBoxes.add(box.boxId);
    try {
      await hooks.starting();
      const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
        const began = performance.now();
        try {
          return await run();
        } finally {
          hooks.timing(step, Math.round(performance.now() - began));
        }
      };
      const claimed = readPlacement(previous.data).ok && ref.slot !== null;
      const address = claimed && previous.address ? previous.address : await timed("host", () => this.#serving(mac, ref.vm, signal));
      let guest = claimed ? { ...previous, address } : await timed("slot", () => this.#slotFor(mac, ref.vm, address, box, signal));
      await hooks.claim(guest);
      const placement = readPlacement(guest.data);
      if (!placement.ok || placement.value.on !== "slot") throw new Error(`Box ${box.name}'s slot could not be read: ${placement.ok ? "no slot" : placement.words}`);
      const { access } = await this.#access.slotAccess(mac, address, slotUserOf(guest));
      await timed("ssh", () => this.#access.waitAnswers(mac, ref.vm, access, Date.now() + SLOT_READY_MS, signal));
      guest = { ...guest, address };
      await hooks.claim(guest);
      return guest;
    } finally {
      this.#acquiringBoxes.delete(box.boxId);
      const left = (this.#acquiring.get(ref.vm) ?? 1) - 1;
      if (left > 0) this.#acquiring.set(ref.vm, left);
      else this.#acquiring.delete(ref.vm);
    }
  }

  async #slotFor(mac: TartHost, vm: string, address: string, box: BoxIdentity, signal: AbortSignal): Promise<Guest> {
    const command = await this.#access.vmCommand(mac, address);
    const deadline = Date.now() + SLOT_READY_MS;
    for (;;) {
      signal.throwIfAborted();
      const status = await this.#status(command, signal);
      const mine = status.claims.find((claim) => claim.install === this.#access.installId && claim.box === box.boxId);
      const line = mine && status.slots.find((slot) => slot.id === mine.slot);
      if (line) {
        const placement = slotPlacement(vm, line.id, line.portBase, status.most);
        if (placement) return this.#slotGuest(mac, vm, address, box.boxId, placement, line.id);
      }
      if (status.deletingSince !== null) throw new Error(`The shared iOS host ${vm} was being deleted before box ${box.name} got a slot.`);
      if (Date.now() > deadline) throw new Error(`The shared iOS host ${vm} gave box ${box.name} no slot within ${SLOT_READY_MS / 60_000} minutes.`);
      const ready = status.slots.filter((slot) => readyFor(slot, box.boxId, this.#acquiringBoxes)).sort((a, b) => Number(b.madeFor === box.boxId) - Number(a.madeFor === box.boxId));
      if (ready.length) {
        const claimed = await this.#claim(mac, vm, address, command, ready[0]!.id, box, status.most, signal);
        if (!("lost" in claimed)) return claimed;
        continue;
      }
      const promised = status.promises.some((promise) => promise.box === box.boxId);
      if (status.slots.some((slot) => spareMaking(slot, box.boxId))) {
        await this.#sleep(POLL_MS, signal);
        continue;
      }
      if (!promised) {
        const again = await this.#helper(command, "promise", [], claimantInput(this.#claimantOf(box)), 90_000, signal);
        if (again.exitCode !== DEVICE_HOST_EXITS.done) throw new BackendError("no_capacity", `The shared iOS host ${vm} has no room for box ${box.name} now: ${again.stderr.trim()}`);
      }
      const made = await this.#helper(command, "make", [], claimantInput(this.#claimantOf(box)), SLOT_READY_MS, signal);
      if (made.exitCode === DEVICE_HOST_EXITS.done) continue;
      if (made.exitCode === DEVICE_HOST_EXITS.full || made.exitCode === DEVICE_HOST_EXITS.lost) {
        await this.#sleep(POLL_MS * 2, signal);
        continue;
      }
      throw new Error(`The shared iOS host ${vm} could not make a slot for box ${box.name}: ${made.stderr.trim() || `exit code ${made.exitCode}`}`);
    }
  }

  async release(guest: Guest, signal?: AbortSignal): Promise<{ readonly last: boolean; readonly hostDeleted: boolean }> {
    const ref = slotRefOf(guest)!;
    this.#releasing.set(ref.vm, (this.#releasing.get(ref.vm) ?? 0) + 1);
    try {
      return await this.#release(guest, ref, signal);
    } finally {
      const left = (this.#releasing.get(ref.vm) ?? 1) - 1;
      if (left > 0) this.#releasing.set(ref.vm, left);
      else this.#releasing.delete(ref.vm);
    }
  }

  async #release(guest: Guest, ref: SlotRef, signal?: AbortSignal): Promise<{ readonly last: boolean; readonly hostDeleted: boolean }> {
    const mac = this.#access.mac(guest.host);
    if (!mac) throw new Error(`The shared iOS host ${ref.vm} is on Mac ${guest.host ?? "unknown"}, which is not in bb-box's Tart settings.`);
    const boxId = typeof guest.data?.box === "string" ? guest.data.box : "";
    const { owner, states } = await this.#ownerOf(ref.vm, signal);
    if (!owner) return { last: false, hostDeleted: false };
    if (owner.phase === "failed") return { last: true, hostDeleted: false };
    if (owner.phase === "starting" && !ref.slot) {
      const said = parseFields((await this.#access.run(mac, hostUnpromiseScript(ref.vm, this.#access.installId, boxId), { signal })).stdout);
      if (said.state === "starting") return { last: !said.left, hostDeleted: false };
    }
    if (!this.#running(states.get(mac.name), ref.vm)) await this.#bootAgain(mac, ref.vm);
    const address = await this.#access.address(mac, ref.vm);
    if (!address) throw new Error(`The shared iOS host ${ref.vm} on ${mac.name} has no address, so box ${boxId}'s slot cannot be released yet.`);
    const command = await this.#access.vmCommand(mac, address);
    const result = ref.slot
      ? await this.#helper(command, "release", [ref.slot], claimantInput({ install: this.#access.installId, box: boxId }), 300_000, signal)
      : await this.#helper(command, "unpromise", [], claimantInput({ install: this.#access.installId, box: boxId }), 90_000, signal);
    if (result.exitCode === DEVICE_HOST_EXITS.notOurs) return { last: false, hostDeleted: false };
    if (result.exitCode !== DEVICE_HOST_EXITS.done) throw new Error(`The shared iOS host ${ref.vm} could not release box ${boxId}'s ${ref.slot ? `slot ${ref.slot}` : "promise"}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    const last = parseFields(result.stdout).last === "yes";
    if (last) await this.#deleteHost(mac, ref.vm, signal);
    return { last, hostDeleted: last };
  }

  async held(states: ReadonlyMap<string, HostState | Error>, signal?: AbortSignal): Promise<HeldGuest[]> {
    const held: HeldGuest[] = [];
    for (const { owner, running, address, status } of await this.#survey(states, signal)) {
      for (const box of owner.promised) if (owner.phase === "starting") held.push({ ...this.#promiseGuest(owner.mac, owner.vm, box), owner: null, power: "running" });
      if (!status) continue;
      for (const promise of status.promises) {
        if (promise.install !== this.#access.installId) continue;
        held.push({ ...this.#promiseGuest(owner.mac, owner.vm, promise.box), owner: null, power: "running" });
      }
      for (const claim of status.claims) {
        if (claim.install !== this.#access.installId) continue;
        const line = status.slots.find((slot) => slot.id === claim.slot);
        const placement = line && slotPlacement(owner.vm, line.id, line.portBase, status.most);
        if (!placement || line.is !== "held") continue;
        held.push({
          ...this.#slotGuest(owner.mac, owner.vm, address, claim.box, placement, claim.slot),
          owner: { boxId: claim.box, threadId: claim.thread ?? "", name: claim.name, kind: claim.kind, createdAt: claim.created },
          power: running ? "running" : "stopped",
        });
      }
    }
    return held;
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const ref = slotRefOf(guest)!;
    const { owner, states } = await this.#ownerOf(ref.vm, signal);
    if (!owner) return null;
    const state = states.get(owner.mac.name);
    if (!state || state instanceof Error) return "unknown";
    if (!state.vms.some((vm) => vm.name === ref.vm)) return owner.phase === "starting" ? "stopped" : null;
    return this.#running(state, ref.vm) ? "running" : "stopped";
  }

  async stopped(guest: Guest, signal?: AbortSignal): Promise<StopReason | null> {
    const power = await this.power(guest, signal);
    if (power !== "stopped") return null;
    return { reason: "The shared iOS host's VM is not running, as after its Mac restarted. bb-box starts the host again, and every box on it comes back.", crashed: true, at: null };
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<void> {
    const ref = slotRefOf(guest)!;
    const mac = this.#access.mac(guest.host);
    if (!mac) throw new Error(`The shared iOS host ${ref.vm} is on Mac ${guest.host ?? "unknown"}, which is not in bb-box's Tart settings.`);
    const address = await this.#serving(mac, ref.vm, signal ?? this.#stopping.signal);
    const { access } = await this.#access.slotAccess(mac, address, slotUserOf(guest));
    await this.#access.waitAnswers(mac, ref.vm, access, Date.now() + SLOT_READY_MS, signal);
  }

  async transports(guest: Guest): Promise<BoxTransports> {
    const ref = slotRefOf(guest)!;
    const mac = this.#access.mac(guest.host);
    if (!mac) throw new Error(`The shared iOS host ${ref.vm} is on Mac ${guest.host ?? "unknown"}, which is not in bb-box's Tart settings.`);
    const address = (await this.#access.address(mac, ref.vm)) ?? guest.address;
    if (!address) throw new Error(`The shared iOS host ${ref.vm} on ${mac.name} has no address. It may be starting again.`);
    const { command, access } = await this.#access.slotAccess(mac, address, slotUserOf(guest));
    const host = await this.#access.vmCommand(mac, address);
    const box = typeof guest.data?.box === "string" ? guest.data.box : "";
    return {
      command,
      displays: [],
      access: { ssh: access, dockerHost: null },
      ...(ref.slot ? { daemonKeptByHost: slotDaemonKeptByHost(host, ref.slot, this.#claimantOf({ boxId: box })) } : {}),
    };
  }

  async restartDeviceServer(guest: Guest, signal?: AbortSignal): Promise<void> {
    const ref = slotRefOf(guest)!;
    const mac = this.#access.mac(guest.host);
    if (!mac || !ref.slot) return;
    const address = await this.#access.address(mac, ref.vm);
    if (!address) throw new Error(`The shared iOS host ${ref.vm} has no address.`);
    const box = typeof guest.data?.box === "string" ? guest.data.box : "";
    const result = await this.#helper(await this.#access.vmCommand(mac, address), "restart", [ref.slot], claimantInput(this.#claimantOf({ boxId: box })), 60_000, signal);
    if (result.exitCode !== DEVICE_HOST_EXITS.done) throw new Error(`The shared iOS host ${ref.vm} could not start slot ${ref.slot}'s device server again: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }

  async maintain(signal?: AbortSignal): Promise<void> {
    if (!this.#settings.on && !this.#hostsSeen) return;
    const states = await this.#access.states(signal);
    const now = Date.now();
    for (const { owner, running, address, status } of await this.#survey(states, signal)) {
      signal?.throwIfAborted();
      const { mac, vm } = owner;
      try {
        if (this.#starts.has(vm)) continue;
        if (owner.phase === "failed") {
          if (!running || !status || !status.claims.some((claim) => claim.install === this.#access.installId)) await this.#access.deleteVm(mac, vm, signal);
          continue;
        }
        if (owner.phase === "starting") {
          if (now - owner.made < ABANDONED_START_MS) continue;
          if (owner.promised.length) void this.#start(mac, vm).catch(() => undefined);
          else await this.#access.deleteVm(mac, vm, signal);
          continue;
        }
        const state = states.get(mac.name);
        if (state && !(state instanceof Error) && !state.vms.some((each) => each.name === vm)) {
          await this.#access.deleteVm(mac, vm, signal);
          continue;
        }
        if (!running) {
          this.#access.log(`Starting shared iOS host ${vm} on ${mac.name} again: its VM is not running, as after its Mac restarted.`);
          void this.#bootAgain(mac, vm).catch((error) => this.#access.logError(`start shared iOS host ${vm} again`, error));
          continue;
        }
        if (!status || !address) continue;
        if (status.deletingSince !== null) {
          if (!this.#releasing.has(vm) && now - status.deletingSince * 1000 >= DELETING_LEFT_MS) await this.#deleteHost(mac, vm, signal);
          continue;
        }
        if (this.#acquiring.has(vm) || this.#handingOver(owner, now)) continue;
        const kept = status.slots.some((slot) => slot.is === "held" || (slot.is === "making" && slot.madeFor !== null)) || status.promises.length > 0;
        if (!kept) await this.#serial(async () => (this.#acquiring.has(vm) ? false : this.#vacate(mac, vm, await this.#access.vmCommand(mac, address), signal)));
      } catch (error) {
        this.#access.logError(`upkeep of shared iOS host ${vm}`, error);
      }
    }
  }

  #handingOver(owner: HostOwner, now: number): boolean {
    return owner.handingOverSince !== null && now - owner.handingOverSince * 1000 < HANDING_OVER_MS;
  }

  async doctor(states: ReadonlyMap<string, HostState | Error>, signal?: AbortSignal): Promise<DoctorCheck[]> {
    if (!this.#settings.on) return [];
    const surveyed = await this.#survey(states, signal, this.#doctorHostMs);
    return this.#access.macs().map((mac): DoctorCheck => {
      const here = surveyed.filter((each) => each.owner.mac.name === mac.name);
      if (!here.length) {
        const why = this.#newHostWhy(mac, states, surveyed.map((each) => each.owner));
        return {
          id: `ios-hosts.${mac.name}`,
          name: `Shared iOS hosts on ${mac.name}`,
          status: why ? "warn" : "ok",
          detail: why ? `No shared iOS host runs, and none can start now: ${why}.` : "No shared iOS host runs. One starts when an ios box asks for shared: true.",
          fix: null,
        };
      }
      const lines = here.map(({ owner, running, status, why }) => {
        if (why) return why;
        if (owner.phase !== "serving") return `${owner.vm}: ${owner.phase}${owner.failure ? `, ${owner.failure}` : ""}, ${owner.promised.length} boxes promised.`;
        if (!running || !status) return `${owner.vm}: its VM is not running.`;
        const count = (is: string) => status.slots.filter((slot) => slot.is === is).length;
        const load = status.slots
          .filter((slot) => slot.is === "held")
          .map((slot) => `slot ${slot.id} (box ${slot.box ?? "?"}): ${slot.cores.toFixed(2)} cores, ${(slot.memoryMiB / 1024).toFixed(1)} GiB${slot.homeMiB !== null ? `, home ${(slot.homeMiB / 1024).toFixed(1)} GiB` : ""}`);
        const build = owner.build && owner.build !== this.#currentBuild(states.get(mac.name)) ? ` On build ${owner.build}, older than the iOS image's, so it lends only while no host on the new build can start.` : "";
        return `${owner.vm}: ${count("held")} held, ${count("ready")} ready, ${count("making")} making, ${status.sweeping} sweeping, of ${status.most}; ${status.diskGiB ?? "?"} GiB disk free (keeps ${status.diskReserveGiB}), ${status.memoryFreePercent ?? "?"}% memory free.${build}${load.length ? ` ${load.join("; ")}.` : ""}`;
      });
      const failing = here.some((each) => each.owner.phase === "failed" || each.why);
      return { id: `ios-hosts.${mac.name}`, name: `Shared iOS hosts on ${mac.name}`, status: failing ? "warn" : "ok", detail: `${lines.join(" ")} Each slot's stream is at two thirds at most until the encoder's ledger comes.`, fix: null };
    });
  }

  dispose(): void {
    this.#stopping.abort(new Error("bb-box stopped."));
  }
}

export function slotUserOf(guest: Guest): string {
  const placement = readPlacement(guest.data);
  if (!placement.ok || placement.value.on !== "slot") throw new Error(`Box guest ${guest.ref} holds no slot.`);
  return slotUser(placement.value);
}
