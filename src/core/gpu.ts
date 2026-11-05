import { currentKindId } from "../backends/kinds.ts";
import { GPU_PARTS, type BoxSize, type CardClaim, type GpuPart, type KindCapabilities, type MachineSize } from "../backends/types.ts";

export type NvidiaUserspace = "none" | "unknown" | `${number}.${string}`;

export type GpuWhenNotAsked = Readonly<Record<string, GpuPart>>;

export type RecordedSize = MachineSize & { readonly gpu?: GpuPart };

export type GpuChoice = { readonly ok: true; readonly gpu: GpuPart } | { readonly ok: false; readonly message: string };

const KINDS_WITH_CARDS: readonly string[] = ["linux", "linux-desktop"];

const SHIPPED_GPU_WHEN_NOT_ASKED: GpuWhenNotAsked = { linux: "none", "linux-desktop": "shared" };

const KIND_WITH_NO_GPU: ReadonlyMap<string, string> = new Map([["linux-desktop-cpu", "linux-desktop"]]);

export function isGpuPart(value: unknown): value is GpuPart {
  return typeof value === "string" && (GPU_PARTS as readonly string[]).includes(value);
}

export function cardsOf(gpu: GpuPart): number {
  return gpu === "none" ? 0 : 1;
}

export function holdsCard(gpu: GpuPart): boolean {
  return cardsOf(gpu) > 0;
}

export function kindNamingNoGpu(kind: string): string | null {
  return KIND_WITH_NO_GPU.get(currentKindId(kind)) ?? null;
}

export function gpuPartsOf(kind: string): readonly GpuPart[] {
  return KINDS_WITH_CARDS.includes(currentKindId(kind)) ? GPU_PARTS : ["none"];
}

export function gpuWhenNotAsked(kind: string, settings: GpuWhenNotAsked = {}): GpuPart {
  const id = currentKindId(kind);
  if (kindNamingNoGpu(id)) return "none";
  const chosen = settings[id] ?? SHIPPED_GPU_WHEN_NOT_ASKED[id] ?? "none";
  return gpuPartsOf(id).includes(chosen) ? chosen : "none";
}

export function chooseGpu(kind: string, asked?: GpuPart, settings: GpuWhenNotAsked = {}): GpuChoice {
  if (asked === undefined) return { ok: true, gpu: gpuWhenNotAsked(kind, settings) };
  if (!holdsCard(asked)) return { ok: true, gpu: asked };
  const named = kindNamingNoGpu(kind);
  if (named) {
    return { ok: false, message: `${kind} is a ${named} box with no GPU, so it cannot have gpu ${asked}. Ask for ${named} with gpu ${asked}, or leave gpu out.` };
  }
  if (!gpuPartsOf(kind).includes(asked)) return { ok: false, message: `A ${kind} box has no GPU. Leave gpu out, or ask for gpu none.` };
  return { ok: true, gpu: asked };
}

export interface GpuOfRecord {
  readonly kind: string;
  readonly capabilities: Pick<KindCapabilities, "gpu">;
  readonly size?: RecordedSize;
}

export function gpuBeforeGpuParts(box: Pick<GpuOfRecord, "kind" | "capabilities">): GpuPart {
  return currentKindId(box.kind) === "linux-desktop" && box.capabilities.gpu ? "shared" : "none";
}

export function recordedGpu(box: GpuOfRecord): GpuPart {
  const gpu = box.size?.gpu;
  return isGpuPart(gpu) ? gpu : gpuBeforeGpuParts(box);
}

export function withGpu(size: MachineSize, gpu: GpuPart): BoxSize {
  return { cores: size.cores, memoryMiB: size.memoryMiB, diskGiB: size.diskGiB, gpu };
}

export function machineSizeOf(size: MachineSize): MachineSize {
  return { cores: size.cores, memoryMiB: size.memoryMiB, diskGiB: size.diskGiB };
}

export function withRecordedGpu(size: MachineSize, recorded: RecordedSize | null | undefined): RecordedSize {
  const gpu = recorded?.gpu;
  return gpu === undefined ? machineSizeOf(size) : { ...machineSizeOf(size), gpu };
}

export function hasGpuPart(kind: string): boolean {
  return gpuPartsOf(kindNamingNoGpu(kind) ?? kind).some(holdsCard);
}

export function userspaceOf(box: { readonly kind: string; readonly nvidiaUserspace?: NvidiaUserspace | null }): NvidiaUserspace {
  return box.nvidiaUserspace ?? (hasGpuPart(box.kind) ? "unknown" : "none");
}

export function claimOf(box: { readonly guest: { readonly claim?: CardClaim | null } | null }): CardClaim | null {
  return box.guest?.claim ?? null;
}

export interface SnapshotGpu {
  readonly part: GpuPart;
  readonly card: string | null;
  readonly index: number | null;
  readonly userspace: NvidiaUserspace;
}

export function snapshotGpuOf(box: GpuOfRecord & { readonly nvidiaUserspace?: NvidiaUserspace | null; readonly size?: RecordedSize | null; readonly guest: { readonly claim?: CardClaim | null } | null }): SnapshotGpu {
  const claim = box.guest?.claim ?? null;
  const part = claim?.part ?? recordedGpu(box);
  return { part, card: claim && part !== "none" ? claim.card : null, index: null, userspace: userspaceOf(box) };
}

export function gpuStayWords(part: GpuPart, index: number | null): string {
  if (part === "none") return "Its GPU stays as it is now: none.";
  return `Its GPU stays as it is now: ${part}, ${index === null ? "its card" : `card ${index}`}.`;
}

export function userspaceRestoreWords(recorded: SnapshotGpu | null, hostDriver: string | null): string | null {
  if (!recorded) return "GPU not recorded.";
  const userspace = recorded.userspace;
  if (recorded.part === "none" && (userspace === "none" || userspace === "unknown")) return null;
  const host = hostDriver && hostDriver !== "unknown" && hostDriver !== "none" ? hostDriver : null;
  if (userspace === "unknown" || userspace === "none" || !host) return "Whether this snapshot's NVIDIA userspace matches the host's driver is not known.";
  if (userspace !== host) return `This snapshot has NVIDIA's userspace ${userspace}, and the host's driver is now ${host}: nvidia-smi will fail in the box until its userspace is updated.`;
  return null;
}
