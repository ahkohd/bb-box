export const LXCFS_ROOT = "/var/lib/lxcfs";

const PROC_FILES = ["cpuinfo", "meminfo", "stat", "uptime", "swaps", "loadavg", "diskstats"] as const;
const CPU_ONLINE = "sys/devices/system/cpu/online";
const PROBE_MOUNT = "/lxcfs";

export interface LxcfsOnHost {
  readonly serves: boolean;
  readonly cpuOnline: boolean;
}

export function lxcfsProbeArgs(image: string): string[] {
  return [
    "container", "run", "--rm", "--pull", "never", "--network", "none",
    "--mount", `type=bind,source=${LXCFS_ROOT},target=${PROBE_MOUNT},readonly`,
    image,
    "sh", "-c", `head -n 1 ${PROBE_MOUNT}/proc/meminfo && if [ -e ${PROBE_MOUNT}/${CPU_ONLINE} ]; then echo cpu-online; fi`,
  ];
}

export function lxcfsFromProbe(result: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }): LxcfsOnHost | null {
  if (/No such image/i.test(result.stderr)) return null;
  const serves = result.exitCode === 0 && /^MemTotal:/m.test(result.stdout);
  return { serves, cpuOnline: serves && /^cpu-online$/m.test(result.stdout) };
}

export function lxcfsMountArgs(lxcfs: LxcfsOnHost): string[] {
  if (!lxcfs.serves) return [];
  const files = [...PROC_FILES.map((file) => `proc/${file}`), ...(lxcfs.cpuOnline ? [CPU_ONLINE] : [])];
  return files.flatMap((file) => ["--mount", `type=bind,source=${LXCFS_ROOT}/${file},target=/${file}`]);
}

export function mountsLxcfs(mountSources: readonly string[]): boolean {
  return mountSources.some((source) => source.startsWith(`${LXCFS_ROOT}/`));
}
