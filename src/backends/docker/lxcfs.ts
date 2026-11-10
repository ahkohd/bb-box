export const LXCFS_ROOT = "/var/lib/lxcfs";

const PROC_FILES = ["cpuinfo", "meminfo", "stat", "uptime", "swaps", "loadavg", "diskstats"] as const;
const CPU_ONLINE = "sys/devices/system/cpu/online";
const FILES = [...PROC_FILES.map((file) => `proc/${file}`), CPU_ONLINE];
export const LXCFS_TARGETS = FILES.map((file) => `/${file}`);

const PROBE_MOUNT = "/lxcfs";
const PROBE_FILES = "/probe";

type ProbeResult = { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string };

export interface LxcfsOnHost {
  readonly serves: boolean;
  readonly via: "host" | "container";
  readonly files: readonly string[];
}

export const NO_LXCFS: LxcfsOnHost = { serves: false, via: "host", files: [] };

export function lxcfsProbeArgs(image: string): string[] {
  return [
    "container", "run", "--rm", "--pull", "never", "--network", "none",
    "--mount", `type=bind,source=${LXCFS_ROOT},target=${PROBE_MOUNT},readonly`,
    image,
    "sh", "-c", `head -n 1 ${PROBE_MOUNT}/proc/meminfo && if [ -e ${PROBE_MOUNT}/${CPU_ONLINE} ]; then echo cpu-online; fi`,
  ];
}

export function lxcfsFromProbe(result: ProbeResult): LxcfsOnHost | null {
  if (/No such image/i.test(result.stderr)) return null;
  if (!(result.exitCode === 0 && /^MemTotal:/m.test(result.stdout))) return NO_LXCFS;
  return { serves: true, via: "host", files: /^cpu-online$/m.test(result.stdout) ? FILES : FILES.filter((file) => file !== CPU_ONLINE) };
}

export function containerLxcfsProbeArgs(image: string): string[] {
  return [
    "container", "run", "--rm", "--pull", "never", "--network", "none",
    ...FILES.flatMap((file) => ["--mount", `type=bind,source=/${file},target=${PROBE_FILES}/${file},readonly`]),
    image,
    "cat", "/proc/self/mountinfo",
  ];
}

export function lxcfsFromContainerProbe(result: ProbeResult): LxcfsOnHost | null {
  if (/No such image/i.test(result.stderr)) return null;
  if (result.exitCode !== 0) return NO_LXCFS;
  const served = result.stdout
    .split("\n")
    .filter((line) => / - fuse\.lxcfs /.test(line))
    .map((line) => line.split(" ")[4] ?? "")
    .filter((point) => point.startsWith(`${PROBE_FILES}/`))
    .map((point) => point.slice(PROBE_FILES.length + 1));
  const files = FILES.filter((file) => served.includes(file));
  return files.includes("proc/meminfo") ? { serves: true, via: "container", files } : NO_LXCFS;
}

export function lxcfsMountArgs(lxcfs: LxcfsOnHost): string[] {
  if (!lxcfs.serves) return [];
  const source = (file: string) => (lxcfs.via === "host" ? `${LXCFS_ROOT}/${file}` : `/${file}`);
  return lxcfs.files.flatMap((file) => ["--mount", `type=bind,source=${source(file)},target=/${file}`]);
}

export function mountsLxcfs(mountTargets: readonly string[]): boolean {
  return mountTargets.includes("/proc/meminfo");
}
