import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDir } from "../backends/setup-dir.ts";
import { judgeCardCheck } from "../backends/card-check.ts";
import type { NvidiaUserspace } from "./gpu.ts";

export type UserspaceVersion = Exclude<NvidiaUserspace, "unknown">;

export interface UserspaceReading {
  readonly file: UserspaceVersion;
  readonly library: UserspaceVersion;
  readonly hostDriver: string | null;
  readonly at: number;
}

export const USERSPACE_UPDATE_STEPS = ["fetch", "install", "restart", "check"] as const;

export type UserspaceUpdateStep = (typeof USERSPACE_UPDATE_STEPS)[number];

export interface UserspaceUpdate {
  readonly from: string;
  readonly to: string;
  readonly at: number;
  readonly state: "updating" | "done" | "failed" | "unknown";
  readonly step: UserspaceUpdateStep;
  readonly ms: number | null;
  readonly error: string | null;
  readonly restartedSince?: boolean;
}

export interface GpuProcess {
  readonly pid: number;
  readonly name: string;
}

export type UpdateCheck = { readonly ok: true; readonly processes: readonly GpuProcess[] } | { readonly ok: false; readonly why: string };

export const UPDATE_DIR = "/var/tmp/bb-box-nvidia-update";
export const UPDATE_LOCK = "/run/bb-box-nvidia-update.lock";
export const UPDATE_SCRIPT = `${UPDATE_DIR}/nvidia-userspace-update.sh`;
export const UPDATE_FREE_MIB = 2048;

const READ_DONE = "userspace read";
const UPDATE_RUNNING = "update running";
const CHECK_DONE = "check done";
const VERSION = /^\d+(\.\d+)+$/;
const LIBRARY = /libnvidia-ml\.so\.(\d+(?:\.\d+)+)$/;

export const USERSPACE_READ =
  `u=${UPDATE_LOCK}; if [ -e "$u" ]; then flock -n -s -E 75 "$u" true 2>/dev/null; if [ $? = 75 ]; then echo '${UPDATE_RUNNING}'; fi; fi; ` +
  "f=/usr/share/bb-box/nvidia-version; " +
  `if [ -r "$f" ]; then printf 'file %s\\n' "$(head -c 64 "$f" | tr -d '\\n')"; else echo 'file none'; fi; ` +
  "l=; for d in /usr/lib/x86_64-linux-gnu /usr/lib64 /usr/lib; do if [ -e \"$d/libnvidia-ml.so.1\" ]; then l=$(readlink -f \"$d/libnvidia-ml.so.1\"); break; fi; done; " +
  `printf 'library %s\\n' "\${l:-none}"; echo '${READ_DONE}'`;

function valueAfter(lines: readonly string[], key: string): string | null {
  const line = lines.find((candidate) => candidate === key || candidate.startsWith(`${key} `));
  return line === undefined ? null : line.slice(key.length).trim();
}

function versionOf(text: string | null): UserspaceVersion {
  return text && VERSION.test(text) ? (text as UserspaceVersion) : "none";
}

export function judgeReading(output: string, hostDriver: string | null, at: number): UserspaceReading | null {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.includes(READ_DONE)) return null;
  const library = valueAfter(lines, "library");
  return { file: versionOf(valueAfter(lines, "file")), library: versionOf(library ? (LIBRARY.exec(library)?.[1] ?? null) : null), hostDriver, at };
}

export function updateRunning(output: string): boolean {
  return output.split("\n").some((line) => line.trim() === UPDATE_RUNNING);
}

export function stillRunningWords(box: string): string {
  return `An earlier update of NVIDIA's userspace is still running in box ${box}: bb-box reads its userspace once it ends, and starts no other update until then`;
}

export function userspaceOfReading(reading: UserspaceReading): UserspaceVersion {
  return reading.file === reading.library ? reading.file : reading.library;
}

export function halfInstalled(reading: UserspaceReading | null | undefined): boolean {
  return !!reading && reading.file !== reading.library;
}

export function matchesDriver(reading: UserspaceReading, driver: string): boolean {
  return !halfInstalled(reading) && reading.library === driver;
}

export function readingWords(reading: UserspaceReading): string {
  if (!halfInstalled(reading)) return reading.library === "none" ? "no NVIDIA userspace" : `NVIDIA's userspace ${reading.library}`;
  const library = reading.library === "none" ? "no NVIDIA libraries" : `NVIDIA's libraries ${reading.library}`;
  const file = reading.file === "none" ? "no version file" : `a version file that says ${reading.file}`;
  return `a half-installed NVIDIA userspace: ${library} and ${file}`;
}

export function fromWords(reading: UserspaceReading): string {
  if (halfInstalled(reading)) return `over its half-installed userspace (libraries ${reading.library}, version file ${reading.file})`;
  return reading.library === "none" ? "where it has none" : `over ${reading.library}`;
}

export function fromOf(reading: UserspaceReading): string {
  return halfInstalled(reading) ? `half-installed (libraries ${reading.library}, version file ${reading.file})` : reading.library;
}

export function processesWords(processes: readonly GpuProcess[]): string {
  if (!processes.length) return "Everything running in it stops.";
  const named = processes.slice(0, 4).map((process) => `${process.name} (${process.pid})`);
  const more = processes.length > named.length ? `, and ${processes.length - named.length} more` : "";
  const list = named.length < 2 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return `Everything running in it stops: ${list}${more} ${processes.length === 1 ? "has" : "have"} the GPU open.`;
}

export function planWords(box: string, reading: UserspaceReading, driver: string, processes: readonly GpuProcess[]): string {
  return `bb-box installs NVIDIA's userspace ${driver} in ${box}, ${fromWords(reading)}, then restarts it. ${processesWords(processes)}`;
}

function base64Of(path: string): string {
  return readFileSync(path).toString("base64");
}

export function updateFilesCommand(root = setupDir()): string {
  const guest = join(root, "proxmox-lxc", "template", "guest");
  const files: readonly [string, string][] = [
    [UPDATE_SCRIPT, join(guest, "nvidia-userspace-update.sh")],
    [`${UPDATE_DIR}/guest/nvidia-userspace.sh`, join(guest, "nvidia-userspace.sh")],
    [`${UPDATE_DIR}/guest/bb-box-nvidia-drivers.sh`, join(guest, "bb-box-nvidia-drivers.sh")],
  ];
  return [`install -d -m 0755 ${UPDATE_DIR}/guest`, ...files.map(([to, from]) => `printf '%s' '${base64Of(from)}' | base64 -d >${to}`)].join(" && ");
}

export function asRoot(script: string): string {
  return `s=; [ "$(id -u)" = 0 ] || s="sudo -n"; $s bash -c '${script.replaceAll("'", "'\\''")}'`;
}

export const UPDATE_CHECK = asRoot("bash -s check");

export function updateScriptText(root = setupDir()): string {
  return readFileSync(join(root, "proxmox-lxc", "template", "guest", "nvidia-userspace-update.sh"), "utf8");
}

export function fetchCommand(driver: string, root = setupDir()): string {
  return asRoot(`${updateFilesCommand(root)} && bash ${UPDATE_SCRIPT} fetch ${UPDATE_DIR} ${driver}`);
}

export function installCommand(): string {
  return asRoot(`bash ${UPDATE_SCRIPT} install ${UPDATE_DIR}`);
}

export function judgeUpdateCheck(output: string, driver: string): UpdateCheck {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.includes(UPDATE_RUNNING)) return { ok: false, why: "is still running an earlier update of NVIDIA's userspace, which must end before bb-box starts another" };
  if (!lines.includes(CHECK_DONE)) {
    const said = lines.find((line) => /sudo|password|not permitted|denied/i.test(line));
    return { ok: false, why: said ? `lets bb-box run nothing as root (${said.replace(/\.$/, "")})` : "did not finish bb-box's check" };
  }
  const arch = valueAfter(lines, "arch");
  if (arch !== "x86_64") return { ok: false, why: `runs on ${arch || "an unknown architecture"}, and NVIDIA's userspace is for x86_64 boxes only` };
  if (valueAfter(lines, "os") !== "ubuntu 24.04" || valueAfter(lines, "image") !== "bb-box") {
    return { ok: false, why: "is not on bb-box's own Linux image (Ubuntu 24.04 on x86_64), where bb-box knows NVIDIA's installer works" };
  }
  const free = Number(valueAfter(lines, "free-mib"));
  if (!Number.isFinite(free) || free < UPDATE_FREE_MIB) {
    return { ok: false, why: `has ${Number.isFinite(free) ? `${free} MiB` : "an unknown amount"} free in /var/tmp, and NVIDIA's installer and its files need ${UPDATE_FREE_MIB / 1024} GiB` };
  }
  const apt = valueAfter(lines, "apt") ?? "unreadable";
  if (apt === "unreadable") return { ok: false, why: "did not let bb-box list its packages from apt, so bb-box cannot tell whether NVIDIA's installer would conflict with them" };
  const packages = apt.split(/\s+/).filter((name) => name && name !== "none");
  if (packages.length) {
    const named = packages.map((entry) => {
      const [name, state] = entry.split(":");
      return state ? `${name} (${state.replace(",", ", ")})` : name!;
    });
    return { ok: false, why: `has ${named.join(", ")} from apt, which NVIDIA's installer would conflict with. Remove ${packages.length === 1 ? "it" : "them"}, or make a new box with a GPU` };
  }
  const seen = valueAfter(lines, "kernel-driver");
  if (seen !== driver) return { ok: false, why: `sees the host's NVIDIA driver as ${seen || "none"}, not ${driver} as the host reports it` };
  const processes = lines.flatMap((line) => {
    const match = /^gpu-process (\d+) (.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), name: match[2]!.trim() || "?" }] : [];
  });
  return { ok: true, processes };
}

export function lastLines(text: string, count = 6): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(" / ");
}

export function updateLeftWords(box: string, update: UserspaceUpdate): string {
  const step = update.step === "fetch" ? "downloading NVIDIA's installer" : update.step === "install" ? "installing it" : update.step === "restart" ? "restarting the box" : "checking the box after its restart";
  if (update.state === "unknown") return `An update of NVIDIA's userspace in ${box} to ${update.to} was cut short while ${step}, and bb-box has not read its userspace since.`;
  return `The last update of NVIDIA's userspace in ${box} to ${update.to} did not finish: it stopped while ${step}${update.error ? `: ${update.error.replace(/\.$/, "")}` : ""}.`;
}

export type UserspaceState =
  | { readonly is: "matches"; readonly version: string }
  | { readonly is: "differs"; readonly version: UserspaceVersion; readonly driver: string }
  | { readonly is: "half"; readonly reading: UserspaceReading }
  | { readonly is: "updating"; readonly update: UserspaceUpdate }
  | { readonly is: "running" }
  | { readonly is: "unfinished"; readonly update: UserspaceUpdate }
  | { readonly is: "not-checked" }
  | { readonly is: "driver-unknown"; readonly version: UserspaceVersion };

function installedBeforeItFailed(update: UserspaceUpdate): boolean {
  return update.step === "restart" || update.step === "check";
}

export function userspaceState(reading: UserspaceReading | null | undefined, update: UserspaceUpdate | null | undefined, driver: string | null, running = false): UserspaceState {
  if (update?.state === "updating") return { is: "updating", update };
  if (running) return { is: "running" };
  if (reading && halfInstalled(reading)) return { is: "half", reading };
  if (update?.state === "unknown" || update?.state === "failed") return { is: "unfinished", update };
  if (!reading) return { is: "not-checked" };
  if (!driver) return { is: "driver-unknown", version: reading.library };
  return reading.library === driver ? { is: "matches", version: driver } : { is: "differs", version: reading.library, driver };
}

export function agentUserspaceWords(box: string, state: UserspaceState): string | null {
  switch (state.is) {
    case "differs":
      return state.version === "none"
        ? `nvidia-smi in ${box} fails: it has no NVIDIA userspace, and the host's driver is ${state.driver}. Ask the user to update it.`
        : `nvidia-smi in ${box} fails: its NVIDIA userspace is ${state.version} and the host's driver ${state.driver}. Ask the user to update it.`;
    case "half":
      return `nvidia-smi and CUDA may fail in ${box}: it has ${readingWords(state.reading)}. Ask the user to update it again.`;
    case "unfinished":
      return `${updateLeftWords(box, state.update)} nvidia-smi and CUDA may fail in it. Ask the user${state.update.state === "unknown" ? "" : " to update it again"}.`;
    case "running":
      return `${stillRunningWords(box)}. nvidia-smi and CUDA may fail in it until it ends. Ask the user.`;
    default:
      return null;
  }
}

export function settledUpdate(update: UserspaceUpdate | null | undefined, reading: UserspaceReading): { readonly userspaceUpdate?: UserspaceUpdate } {
  if (!update || (update.state !== "unknown" && update.state !== "failed")) return {};
  const driver = reading.hostDriver;
  if (driver && matchesDriver(reading, driver) && (update.restartedSince || update.step === "fetch")) return { userspaceUpdate: { ...update, state: "done", ms: null } };
  if (update.state !== "unknown") return {};
  const step = matchesDriver(reading, update.to) && !installedBeforeItFailed(update) ? "restart" : update.step;
  return { userspaceUpdate: { ...update, state: "failed", step, error: `${update.error ?? "It was cut short."} When bb-box read the box again, it had ${readingWords(reading)}.` } };
}

export function judgeAnyCard(output: string): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  const uuid = /GPU-([0-9a-f-]{36})/i.exec(output)?.[1]?.toLowerCase();
  if (!uuid) return { ok: false, why: `nvidia-smi in it listed no card${lastLines(output, 2) ? ` (${lastLines(output, 2)})` : ""}` };
  const judged = judgeCardCheck(output, uuid, null);
  return judged.ok ? { ok: true } : { ok: false, why: judged.why };
}

const DESKTOP_DONE = "desktop check done";

export const DESKTOP_GPU_CHECK =
  `printf 'display-mode %s\\n' "$(cat /run/bb-box/display-mode 2>/dev/null || echo none)"; ` +
  `printf 'display-reason %s\\n' "$(cat /run/bb-box/display-reason 2>/dev/null)"; ` +
  `printf 'video %s\\n' "$(timeout 30 node /usr/local/libexec/bb-box/selkies-probe.mjs 5980 3 2>&1 | tail -1)"; ` +
  `n=no; for p in $(pgrep -u "$(id -un)" -x selkies) $(pgrep -u "$(id -un)" -x python3); do grep -q libnvidia-encode "/proc/$p/maps" 2>/dev/null && n=yes; done; ` +
  `echo "nvenc $n"; echo '${DESKTOP_DONE}'`;

export function judgeDesktopCheck(output: string): string | null {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.includes(DESKTOP_DONE)) return "the desktop's check did not finish";
  const mode = valueAfter(lines, "display-mode");
  if (mode !== "gpu") {
    const reason = valueAfter(lines, "display-reason");
    return `its desktop came up on ${mode === "cpu" ? "the CPU" : `display mode ${mode ?? "none"}`}${reason ? ` (${reason})` : ""}`;
  }
  const video = valueAfter(lines, "video") ?? "";
  if (!/"frames":[1-9]/.test(video)) return `its desktop's video sent no frames${video ? ` (${video})` : ""}`;
  if (valueAfter(lines, "nvenc") !== "yes") return "its desktop's video is not encoded with NVENC";
  return null;
}

export function restartedSinceUpdate(update: UserspaceUpdate | null | undefined): { readonly userspaceUpdate?: UserspaceUpdate } {
  if (!update || (update.state !== "unknown" && update.state !== "failed") || update.restartedSince) return {};
  return { userspaceUpdate: { ...update, restartedSince: true } };
}
