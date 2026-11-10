import type { BoxIdentity, GpuPart } from "../types.ts";
import { IDENTITY_VARIABLE } from "../../core/identity.ts";
import { LABELS } from "./cli.ts";
import { formatCpuList, type CpuList } from "./cpus.ts";
import { ALL_CARDS_DEVICE, cudaVisible } from "./gpus.ts";
import { lxcfsMountArgs, type LxcfsOnHost } from "./lxcfs.ts";

const SHM_MIN_MIB = 1024;
const DOCKER_DATA = "/var/lib/docker";

export const BOX_START = "/usr/local/sbin/bb-box-start";

export const VOLUME_OF = "bbbox.volume-of";

export const IMAGE_HOLDS_FORKS = "bbbox.fork-hold";

export const FORK_HOLD_VARIABLE = "BBBOX_FORK_HOLD";

export type FirstStart = "runs-its-services" | "holds-them-for-the-fork-check";

export const ENV_A_BOX_IS_GIVEN = [
  IDENTITY_VARIABLE,
  FORK_HOLD_VARIABLE,
  "BBBOX_DOCKERD",
  "NVIDIA_DRIVER_CAPABILITIES",
  "CUDA_VISIBLE_DEVICES",
  "NVIDIA_VISIBLE_DEVICES",
  "BBBOX_GPU_CARD",
  "BBBOX_GPU",
  "BBBOX_GPU_ID",
  "OMP_NUM_THREADS",
] as const;

type BoxEnv = (typeof ENV_A_BOX_IS_GIVEN)[number];

export interface BoxContainerSettings {
  readonly box: BoxIdentity;
  readonly installId: string;
  readonly name: string;
  readonly image: string;
  readonly dockerVolume: string | null;
  readonly placement: {
    readonly gpu: string | null;
    readonly card: string | null;
    readonly part: GpuPart;
    readonly cpus: CpuList | null;
  };
  readonly lxcfs: LxcfsOnHost | null;
  readonly privileged: boolean;
  readonly network: string;
  readonly firstStart: FirstStart;
  readonly fromSnapshot: string | null;
}

export function shmSize(memoryMiB: number): string {
  return `${Math.max(SHM_MIN_MIB, Math.floor(memoryMiB / 2))}m`;
}

export function hostnameOf(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return cleaned || "box";
}

export function boxVolumeName(containerName: string): string {
  return `${containerName}-docker`;
}

export function dockerVolumeCreateArgs(volume: string, containerName: string, installId: string): readonly string[] {
  return ["volume", "create", "--label", `${VOLUME_OF}=${containerName}`, "--label", `${LABELS.install}=${installId}`, volume];
}

export function dockerVolumesOfArgs(containerName: string, installId: string): readonly string[] {
  return [
    "volume", "ls",
    "--filter", `label=${VOLUME_OF}=${containerName}`,
    "--filter", `label=${LABELS.install}=${installId}`,
    "--format", "{{.Name}}",
  ];
}

function given(key: BoxEnv, value: string): readonly string[] {
  return ["--env", `${key}=${value}`];
}

export function labelsOf(settings?: BoxContainerSettings): Record<string, string> {
  const box = settings?.box;
  const placement = settings?.placement;
  return {
    [LABELS.backend]: settings ? "docker" : "",
    [LABELS.install]: settings?.installId ?? "",
    [LABELS.box]: box?.boxId ?? "",
    [LABELS.thread]: box?.threadId ?? "",
    [LABELS.name]: box?.name ?? "",
    [LABELS.kind]: box?.kind ?? "",
    [LABELS.created]: box ? String(box.createdAt) : "",
    [LABELS.gpu]: placement?.gpu ?? "",
    [LABELS.gpuCard]: placement?.gpu ? placement.card ?? "" : "",
    [LABELS.gpuPart]: placement?.gpu && placement.card ? placement.part : "",
    [LABELS.fromSnapshot]: settings?.fromSnapshot ?? "",
  };
}

function firstStartArgs(firstStart: FirstStart): readonly string[] {
  return firstStart === "holds-them-for-the-fork-check"
    ? ["--restart", "no", ...given(FORK_HOLD_VARIABLE, "1")]
    : ["--restart", "unless-stopped"];
}

function dockerArgs(settings: BoxContainerSettings): readonly string[] {
  return [
    ...(settings.privileged ? ["--privileged", ...given("BBBOX_DOCKERD", "1")] : []),
    ...(settings.dockerVolume ? ["--volume", `${settings.dockerVolume}:${DOCKER_DATA}`] : []),
  ];
}

function gpuArgs(settings: BoxContainerSettings): readonly string[] {
  const { gpu, card } = settings.placement;
  if (!gpu) return [];
  const desktopGpuId = gpu !== ALL_CARDS_DEVICE ? gpu.slice(gpu.indexOf("=") + 1) : card ? cudaVisible(card) : null;
  const seesEveryCard = settings.privileged || gpu === ALL_CARDS_DEVICE;
  return [
    "--device", gpu,
    ...given("NVIDIA_DRIVER_CAPABILITIES", "all"),
    ...(card
      ? [...given("CUDA_VISIBLE_DEVICES", cudaVisible(card)), ...given("NVIDIA_VISIBLE_DEVICES", cudaVisible(card)), ...given("BBBOX_GPU_CARD", cudaVisible(card))]
      : []),
    ...(settings.box.kind === "linux-desktop" ? given("BBBOX_GPU", "1") : []),
    ...(settings.box.kind === "linux-desktop" && seesEveryCard && desktopGpuId ? given("BBBOX_GPU_ID", desktopGpuId) : []),
  ];
}

export interface ImageContainerSettings {
  readonly imageBox: true;
  readonly name: string;
  readonly image: string;
  readonly installId: string;
  readonly kind: string;
  readonly label: string;
  readonly cores: number;
  readonly memoryMiB: number;
  readonly privileged: boolean;
  readonly network: string;
}

function resourceArgs(cores: number, memoryMiB: number): readonly string[] {
  return [
    "--init",
    "--cpus", String(cores),
    "--memory", `${memoryMiB}m`,
    "--memory-swap", `${memoryMiB}m`,
    "--shm-size", shmSize(memoryMiB),
    "--pids-limit", "16384",
    "--stop-timeout", "10",
    "--tmpfs", "/run:exec,mode=755",
  ];
}

export function createArgs(settings: BoxContainerSettings | ImageContainerSettings): readonly string[] {
  if ("imageBox" in settings) {
    const labels = {
      [LABELS.backend]: "docker",
      [LABELS.install]: settings.installId,
      [LABELS.imageBox]: settings.installId,
      [LABELS.kind]: settings.kind,
      [LABELS.name]: settings.label.slice(0, 120),
    };
    return [
      "container", "create", "--pull", "never", "--name", settings.name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--hostname", "bb-box-image",
      ...resourceArgs(settings.cores, settings.memoryMiB),
      "--network", settings.network,
      ...(settings.privileged ? ["--privileged", ...given("BBBOX_DOCKERD", "1"), "--volume", DOCKER_DATA] : []),
      settings.image, BOX_START,
    ];
  }
  const { box, placement } = settings;
  const { cores, memoryMiB } = box.size;
  const labels = Object.fromEntries(Object.entries(labelsOf(settings)).filter(([, value]) => value !== ""));

  return [
    "container", "create",
    "--pull", "never",
    "--name", settings.name,
    ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--hostname", hostnameOf(box.name),
    ...resourceArgs(cores, memoryMiB),
    ...given(IDENTITY_VARIABLE, box.boxId),
    ...(placement.cpus ? ["--cpuset-cpus", formatCpuList(placement.cpus)] : given("OMP_NUM_THREADS", String(Math.ceil(cores)))),
    ...(settings.lxcfs ? lxcfsMountArgs(settings.lxcfs) : []),
    ...firstStartArgs(settings.firstStart),
    "--network", settings.network,
    ...dockerArgs(settings),
    ...gpuArgs(settings),
    settings.image,
    BOX_START,
  ];
}
