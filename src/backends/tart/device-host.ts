import { performance } from "node:perf_hooks";
import { quote } from "../../transports/process.ts";
import type { CommandTransport, RunResult } from "../../transports/types.ts";
import type { DaemonKeptByHost } from "../types.ts";

export const DEVICE_HOST_HELPER = "/usr/local/libexec/bb-box/device-host";
export const DEVICE_HOST_EXITS = { done: 0, failed: 1, usage: 2, lost: 3, notOurs: 4, full: 5, notReady: 6, deleting: 7, lending: 8 } as const;
export const SLOT_INSTALLER_ENVIRONMENT: Readonly<Record<string, string>> = { BB_INSTALL_SKIP_SERVICE: "1" };
export const HELD_PORTS = [3000, 4200, 5000, 5173, 8000, 8080, 8081, 19000] as const;

export type SlotStateWord = "making" | "ready" | "held" | "releasing" | "resetting";

export interface SlotClaimant {
  readonly install: string;
  readonly box: string;
}

export interface HostSlotLine {
  readonly id: string;
  readonly user: string;
  readonly uid: number;
  readonly carried: boolean;
  readonly portBase: number;
  readonly is: SlotStateWord;
  readonly step: string | null;
  readonly box: string | null;
  readonly madeFor: string | null;
  readonly since: number | null;
  readonly model: string | null;
  readonly udid: string | null;
  readonly booted: boolean;
  readonly daemonsLoaded: boolean;
  readonly cores: number;
  readonly memoryMiB: number;
  readonly homeMiB: number | null;
}

export interface HostSweep {
  readonly uid: number;
  readonly uidsInPass: number;
  readonly found: number;
  readonly left: number;
  readonly seconds: number;
  readonly at: number;
}

export interface HostClaim {
  readonly slot: string;
  readonly install: string;
  readonly box: string;
  readonly thread: string | null;
  readonly name: string | null;
  readonly kind: string | null;
  readonly created: number | null;
}

export interface HostStatus {
  readonly helper: number;
  readonly boot: string;
  readonly deletingSince: number | null;
  readonly kept: boolean;
  readonly closedSince: number | null;
  readonly most: number;
  readonly ahead: number;
  readonly resettingMost: number;
  readonly diskReserveGiB: number;
  readonly generation: number;
  readonly cores: number | null;
  readonly memoryMiB: number | null;
  readonly diskGiB: number | null;
  readonly memoryFreePercent: number | null;
  readonly runtime: string | null;
  readonly model: string | null;
  readonly counted: number;
  readonly promises: readonly { readonly box: string; readonly install: string; readonly since: number }[];
  readonly claims: readonly HostClaim[];
  readonly slots: readonly HostSlotLine[];
  readonly secondDevices: readonly { readonly slot: string; readonly booted: number; readonly since: number | null }[];
  readonly deviceWords: readonly { readonly slot: string; readonly words: string }[];
  readonly sweeping: number;
  readonly sweeps: readonly HostSweep[];
  readonly bbApp: string | null;
  readonly bbAppKept: boolean;
}

export interface ServerApp {
  readonly url: string;
  readonly digest: string;
}

const SLOT_STATES: readonly SlotStateWord[] = ["making", "ready", "held", "releasing", "resetting"];

function wholeOrNull(text: string | undefined): number | null {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
}

function numberOrNull(text: string | undefined): number | null {
  return text !== undefined && /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

function wordOrNull(text: string | undefined): string | null {
  return text ? text : null;
}

export function parseHostSlot(fields: readonly string[]): HostSlotLine | null {
  const [id, user, uid, carried, portBase, is, step, box, madeFor, since, model, udid, booted, loaded, cores, memory, home] = fields;
  if (!id || !user || wholeOrNull(uid) === null || wholeOrNull(portBase) === null || !SLOT_STATES.includes(is as SlotStateWord)) return null;
  return {
    id,
    user,
    uid: Number(uid),
    carried: carried === "1",
    portBase: Number(portBase),
    is: is as SlotStateWord,
    step: wordOrNull(step),
    box: wordOrNull(box),
    madeFor: wordOrNull(madeFor),
    since: wholeOrNull(since),
    model: wordOrNull(model),
    udid: wordOrNull(udid),
    booted: booted === "1",
    daemonsLoaded: loaded === "1",
    cores: numberOrNull(cores) ?? 0,
    memoryMiB: wholeOrNull(memory) ?? 0,
    homeMiB: wholeOrNull(home),
  };
}

export function parseHostStatus(stdout: string): HostStatus | null {
  const values = new Map<string, string>();
  const slots: HostSlotLine[] = [];
  const promises: { box: string; install: string; since: number }[] = [];
  const secondDevices: { slot: string; booted: number; since: number | null }[] = [];
  const deviceWords: { slot: string; words: string }[] = [];
  const sweeps: HostSweep[] = [];
  const claims: HostClaim[] = [];
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at);
    const fields = line.slice(at + 1).split("\t");
    switch (key) {
      case "slot": {
        const slot = parseHostSlot(fields);
        if (slot) slots.push(slot);
        break;
      }
      case "promise":
        if (fields[0] && wholeOrNull(fields[2]) !== null) promises.push({ box: fields[0], install: fields[1] ?? "", since: Number(fields[2]) });
        break;
      case "claim": {
        const [slot, install, box, thread, name, kind, created] = fields;
        if (slot && install && box) claims.push({ slot, install, box, thread: wordOrNull(thread), name: wordOrNull(name), kind: wordOrNull(kind), created: wholeOrNull(created) });
        break;
      }
      case "devices":
        if (fields[0] && wholeOrNull(fields[1]) !== null) secondDevices.push({ slot: fields[0], booted: Number(fields[1]), since: wholeOrNull(fields[2]) });
        break;
      case "device_words":
        if (fields[0] && fields[1]) deviceWords.push({ slot: fields[0], words: fields.slice(1).join("\t") });
        break;
      case "sweep": {
        const [uid, inPass, found, left, seconds, when] = fields.map(numberOrNull);
        if (uid !== null && inPass !== null && found !== null && left !== null && seconds !== null && when !== null) sweeps.push({ uid, uidsInPass: inPass, found, left, seconds, at: when });
        break;
      }
      default:
        values.set(key, line.slice(at + 1));
    }
  }
  const helper = wholeOrNull(values.get("helper"));
  const most = wholeOrNull(values.get("most"));
  if (helper === null || most === null) return null;
  return {
    helper,
    boot: values.get("boot") ?? "",
    deletingSince: wholeOrNull(values.get("deleting")),
    kept: values.get("kept") === "1",
    closedSince: wholeOrNull(values.get("closed")),
    most,
    ahead: wholeOrNull(values.get("ahead")) ?? 0,
    resettingMost: wholeOrNull(values.get("resetting-most")) ?? 0,
    diskReserveGiB: wholeOrNull(values.get("disk-reserve-gib")) ?? 0,
    generation: wholeOrNull(values.get("generation")) ?? 0,
    cores: wholeOrNull(values.get("cores")),
    memoryMiB: wholeOrNull(values.get("memory")),
    diskGiB: wholeOrNull(values.get("disk")),
    memoryFreePercent: wholeOrNull(values.get("memory_free")),
    runtime: wordOrNull(values.get("runtime")),
    model: wordOrNull(values.get("model")),
    counted: wholeOrNull(values.get("counted")) ?? 0,
    promises,
    claims,
    slots,
    secondDevices,
    deviceWords,
    sweeping: wholeOrNull(values.get("sweeping")) ?? 0,
    sweeps,
    bbApp: /^[a-f0-9]{64}$/.test(values.get("bb-app") ?? "") ? values.get("bb-app")! : null,
    bbAppKept: values.get("bb-app-kept") === "yes",
  };
}

export function bbServerFolder(url: string): string {
  return new URL(url).host.replace(/[^a-zA-Z0-9.-]/gu, "-");
}

export function hostAppInstallScript(app: ServerApp): string {
  return `/bin/sh -c ${quote(String.raw`set -eu
want=${quote(app.digest)}
d="$HOME/.bb-machines/"${quote(bbServerFolder(app.url))}
if [ "$(cat "$d/host-artifact.sha256" 2>/dev/null)" != "$want" ] || [ ! -d "$d/npm/lib/node_modules/bb-app" ]; then
  PATH=$PATH:/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/local/bin
  command -v npm >/dev/null 2>&1 || { echo "There is no npm for $(id -un), so bb-box cannot install BB's app for the slots." >&2; exit 3; }
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fsS --max-time 120 -o "$work/bb-app.tgz" ${quote(`${app.url.replace(/\/+$/, "")}/install/bb-app.tgz`)}
  echo "$want  $work/bb-app.tgz" | shasum -a 256 -c --quiet - >/dev/null 2>&1 || { echo "BB's server gave an app that is not build $want." >&2; exit 4; }
  umask 022
  mkdir -p "$d"
  chmod 700 "$HOME/.bb-machines" "$d"
  rm -rf "$d/npm.new"
  npm install -g --no-fund --no-audit --allow-scripts=better-sqlite3,node-pty,@parcel/watcher --prefix "$d/npm.new" "$work/bb-app.tgz" >"$work/npm.log" 2>&1 || { tail -n 5 "$work/npm.log" >&2; exit 5; }
  rm -rf "$d/npm"
  mv "$d/npm.new" "$d/npm"
  (umask 077 && printf '%s\n' "$want" >"$d/host-artifact.sha256")
  echo installed=yes
fi
echo "home=$HOME"
`)}`;
}

export type KeptApp = { readonly kept: true; readonly installed: boolean; readonly installSeconds: number; readonly seconds: number } | { readonly kept: false; readonly why: string };

export async function keepServerApp(app: ServerApp, installAsHostUser: (script: string) => Promise<RunResult>, keepAsRoot: (input: string) => Promise<RunResult>): Promise<KeptApp> {
  const began = performance.now();
  const installed = await installAsHostUser(hostAppInstallScript(app));
  const home = fieldOf(installed.stdout, "home");
  if (installed.exitCode !== 0 || !home) return { kept: false, why: `installing build ${app.digest.slice(0, 12)} as the host's user failed: ${installed.stderr.trim() || `exit code ${installed.exitCode}`}` };
  const installSeconds = (performance.now() - began) / 1000;
  const kept = await keepAsRoot(keepAppInput(app, home));
  if (kept.exitCode !== DEVICE_HOST_EXITS.done || fieldOf(kept.stdout, "kept") !== "yes") return { kept: false, why: fieldOf(kept.stdout, "why") ?? (kept.stderr.trim() || `its helper's keep-app ended with exit code ${kept.exitCode}`) };
  return { kept: true, installed: fieldOf(installed.stdout, "installed") === "yes", installSeconds, seconds: (performance.now() - began) / 1000 };
}

export function keptAppWords(app: ServerApp, kept: Extract<KeptApp, { kept: true }>): string {
  return `BB's app build ${app.digest.slice(0, 12)} for its slots, in ${kept.seconds.toFixed(1)} s (${kept.installed ? `installed in ${kept.installSeconds.toFixed(1)} s` : "installed already"})`;
}

function fieldOf(stdout: string, key: string): string | null {
  const line = stdout.split("\n").find((each) => each.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : null;
}

export function keepAppInput(app: ServerApp, home: string): string {
  return `server=${bbServerFolder(app.url)}\ndigest=${app.digest}\nfrom=${home}\n`;
}

export function helperCommand(verb: string, ...args: readonly string[]): string {
  return ["sudo", "-n", DEVICE_HOST_HELPER, verb, ...args].join(" ");
}

export function claimantInput(claimant: SlotClaimant): string {
  return `install=${claimant.install}\nbox=${claimant.box}\n`;
}

export function slotDaemonKeptByHost(host: CommandTransport, slot: string, claimant: SlotClaimant): DaemonKeptByHost {
  return {
    installerEnvironment: SLOT_INSTALLER_ENVIRONMENT,
    async takeOver(signal) {
      const result = await host.run(helperCommand("daemon", slot), { stdin: claimantInput(claimant), timeoutMs: 60_000, signal });
      if (result.exitCode !== DEVICE_HOST_EXITS.done) {
        throw new Error(`The iOS host could not take over BB's daemon for slot ${slot}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      }
    },
  };
}
