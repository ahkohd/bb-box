import type { Backend, BoxTransports, Guest } from "../src/backends/types.ts";
import type { CommandTransport, RunOptions, RunResult } from "../src/transports/types.ts";

export type FakeCall = "read" | "check" | "fetch" | "install" | "card-check" | "desktop-check";

export interface FakeNvidia {
  driver: string;
  file: string;
  library: string;
  apt: string[];
  freeMiB: number;
  arch: string;
  processes: string[];
  card: string | null;
  fetchFails: string | null;
  install: "works" | "fails-before" | "fails-half" | "hangs-half" | "changes-nothing";
  calls: FakeCall[];
  hostRefused: { readonly why: string; readonly fix: string | null } | null;
  display: "gpu" | "cpu";
  cardCheckThrows: boolean;
  running: boolean;
  hostThrows: boolean;
}

export function fakeNvidia(start: Partial<FakeNvidia> = {}): FakeNvidia {
  return {
    driver: "580.142",
    file: "570.86",
    library: "570.86",
    apt: [],
    freeMiB: 20_000,
    arch: "x86_64",
    processes: [],
    card: "3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00",
    fetchFails: null,
    install: "works",
    calls: [],
    hostRefused: null,
    display: "gpu",
    cardCheckThrows: false,
    running: false,
    hostThrows: false,
    ...start,
  };
}

const ok = (stdout: string, exitCode = 0, stderr = ""): RunResult => ({ exitCode, stdout, stderr, durationMs: 1, timedOut: false, truncated: false });

function callOf(script: string): FakeCall | null {
  if (script.includes("bash -s check")) return "check";
  if (script.includes("nvidia-userspace-update.sh fetch")) return "fetch";
  if (script.includes("nvidia-userspace-update.sh install")) return "install";
  if (script.includes("libnvidia-ml.so.1")) return "read";
  if (script.includes("nvidia-smi --query-gpu=uuid")) return "card-check";
  if (script.includes("selkies-probe.mjs")) return "desktop-check";
  return null;
}

function answer(nvidia: FakeNvidia, call: FakeCall, options: RunOptions | undefined): Promise<RunResult> {
  switch (call) {
    case "read": {
      const library = nvidia.library === "none" ? "none" : `/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.${nvidia.library}`;
      return Promise.resolve(ok(`${nvidia.running ? "update running\n" : ""}file ${nvidia.file}\nlibrary ${library}\nuserspace read\n`));
    }
    case "check":
      return Promise.resolve(
        ok(
          [
            `arch ${nvidia.arch}`,
            "os ubuntu 24.04",
            "image bb-box",
            `free-mib ${nvidia.freeMiB}`,
            `kernel-driver ${nvidia.driver}`,
            `apt ${nvidia.apt.length ? nvidia.apt.join(" ") : "none"}`,
            ...nvidia.processes.map((process) => `gpu-process ${process}`),
            "check done",
            "",
          ].join("\n"),
        ),
      );
    case "fetch":
      return Promise.resolve(nvidia.fetchFails ? ok("", 1, `nvidia-userspace-update: ${nvidia.fetchFails}\n`) : ok(`fetched NVIDIA-Linux-x86_64-${nvidia.driver}.run\n`));
    case "install":
      if (nvidia.install === "fails-before") return Promise.resolve(ok("", 1, "nvidia-userspace: the NVIDIA installer failed before it changed anything\n"));
      if (nvidia.install === "fails-half") {
        nvidia.library = "none";
        return Promise.resolve(ok("", 1, "ERROR: An error occurred while performing the step: \"Installing 'NVIDIA Accelerated Graphics Driver'\".\n"));
      }
      if (nvidia.install === "hangs-half") {
        nvidia.library = "none";
        return new Promise((_, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (nvidia.install === "works") {
        nvidia.file = nvidia.driver;
        nvidia.library = nvidia.driver;
      }
      return Promise.resolve(ok(`installed ${nvidia.driver}\n`));
    case "card-check":
      if (nvidia.cardCheckThrows) return Promise.reject(new Error("the connection to the box closed"));
      if (nvidia.library !== nvidia.driver || !nvidia.card) {
        return Promise.resolve(ok("Failed to initialize NVML: Driver/library version mismatch\ncuinit 999\nuserspace " + nvidia.file + "\ncard check done\n"));
      }
      return Promise.resolve(ok(`GPU-${nvidia.card}, Fake RTX, 24576\ncuinit 0\nuserspace ${nvidia.file}\ncard check done\n`));
    case "desktop-check":
      return Promise.resolve(
        nvidia.display === "gpu"
          ? ok('display-mode gpu\ndisplay-reason DISPLAY_MODE=auto\nvideo {"frames":12}\nnvenc yes\ndesktop check done\n')
          : ok('display-mode cpu\ndisplay-reason no NVIDIA device nodes\nvideo {"frames":12}\nnvenc no\ndesktop check done\n'),
      );
  }
}

function wrapped(command: CommandTransport, nvidia: FakeNvidia): CommandTransport {
  return new Proxy(command, {
    get(target, property, receiver) {
      if (property === "run") {
        return (script: string, options?: RunOptions) => {
          const call = callOf(script);
          if (!call) return target.run(script, options);
          nvidia.calls.push(call);
          return answer(nvidia, call, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function withFakeNvidia(backend: Backend, nvidia: FakeNvidia, kinds: readonly string[] = ["linux", "linux-desktop"]): void {
  const writable = backend as { -readonly [K in keyof Backend]: Backend[K] };
  const transports = backend.transports.bind(backend);
  writable.transports = async (guest: Guest, kind: string): Promise<BoxTransports> => {
    const found = await transports(guest, kind);
    return found.command ? { ...found, command: wrapped(found.command, nvidia) } : found;
  };
  writable.nvidiaHost = async (kind: string) => {
    if (!kinds.includes(kind)) return null;
    if (nvidia.hostThrows) throw new Error("the host's report could not be read");
    return nvidia.hostRefused ? { driver: null, refused: nvidia.hostRefused } : { driver: nvidia.driver, refused: null };
  };
}

export function updateCalls(nvidia: FakeNvidia): FakeCall[] {
  return nvidia.calls.filter((call) => call === "check" || call === "fetch" || call === "install");
}
