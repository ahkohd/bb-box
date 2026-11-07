import { currentKindId } from "../backends/kinds.ts";
import { GPU_PARTS, type BoxKind, type BoxSize, type CardClaim, type CardPlacement, type GpuPart, type GpuRefusal, type GpuResize, type KindCapabilities, type MachineSize, type Resizing } from "../backends/types.ts";

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

export function kindWithGpu(kind: string): string {
  return kindNamingNoGpu(kind) ?? kind;
}

export function resizingWithDesktopGpu(own: Resizing | null, desktop: Resizing | null): Resizing | null {
  if (!own || own.gpu) return own;
  const gpu = desktop?.gpu;
  if (!gpu || gpu.add === "no") return own;
  return { ...own, gpu };
}

export function boxResizing(backend: { resizing?(kind: string): Resizing | null } | null | undefined, kind: string): Resizing | null {
  const own = backend?.resizing?.(kind) ?? null;
  if (!kindNamingNoGpu(kind)) return own;
  return resizingWithDesktopGpu(own, backend?.resizing?.(kindWithGpu(kind)) ?? null);
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

export function gpuPartsOffered(kind: Pick<BoxKind, "capabilities" | "gpuParts">): readonly GpuPart[] {
  return kind.gpuParts ?? (kind.capabilities.gpu ? ["shared"] : ["none"]);
}

export function offersGpuPart(kind: Pick<BoxKind, "capabilities" | "gpuParts">, gpu: GpuPart): boolean {
  return gpuPartsOffered(kind).includes(gpu);
}

export function gpuOnOffer(kind: Pick<BoxKind, "capabilities" | "gpuParts">, gpu: GpuPart, asked: boolean): GpuPart {
  if (asked || offersGpuPart(kind, gpu)) return gpu;
  return gpuPartsOffered(kind).some(holdsCard) ? gpu : "none";
}

export function gpuPartWords(gpu: GpuPart): string {
  return gpu === "none" ? "no GPU" : gpu === "shared" ? "a shared GPU" : "a whole card";
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

export function snapshotGpuWordsFor(system: string, gpu: SnapshotGpu | null | undefined): string | null {
  return system !== "linux" && (!gpu || gpu.part === "none") ? null : snapshotGpuWords(gpu);
}

export function snapshotGpuWords(gpu: SnapshotGpu | null | undefined): string {
  if (!gpu) return "GPU not recorded";
  const card = gpu.part === "none" ? "" : gpu.index !== null ? `, card ${gpu.index}` : gpu.card ? `, ${gpu.card}` : "";
  return `GPU: ${gpu.part}${card}; NVIDIA userspace: ${gpu.userspace}`;
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

export const WHOLE_CARDS_OFF = {
  person: "Whole cards are off on this install, so no box gets a card to itself. Ask for gpu shared, or turn whole cards on with bb box option set general.wholeCards=true.",
  agent: "Not made: whole cards are off on this install. Ask for gpu shared, or ask the user. bb-box changed nothing.",
} as const;

export const WHOLE_CARDS_OFF_FOR_FORK = {
  person: "Not forked: whole cards are off on this install. Fork it with gpu shared or none, or turn whole cards on with bb box option set general.wholeCards=true. bb-box copied nothing.",
  agent: "Not forked: whole cards are off on this install. Fork it with gpu shared or none, or ask the user. bb-box copied nothing.",
} as const;

export const WHOLE_CARDS_OFF_FOR_RESIZE = {
  person: "Not resized: whole cards are off on this install. Keep the GPU shared, or turn whole cards on with bb box option set general.wholeCards=true. bb-box changed nothing.",
  agent: "Not resized: whole cards are off on this install. Keep the GPU shared, or ask the user. bb-box changed nothing.",
} as const;

export function gpuResizingWords(gpu: { readonly add: string; readonly share: string; readonly move: string } | null | undefined): string {
  if (!gpu) return "";
  const share = gpu.share === "live" ? "switches between shared and whole live" : gpu.share === "restart" ? "switches between shared and whole with a restart" : null;
  const changes = (way: string) => [...(gpu.add === way ? ["added", "removed"] : []), ...(gpu.move === way ? ["moved to another card"] : [])];
  const either = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);
  const restarted = changes("restart");
  const fixed = changes("no");
  const clauses = [...(share ? [share] : []), ...(restarted.length ? [`is ${either(restarted)} with a restart`] : []), ...(fixed.length ? [`cannot be ${either(fixed)}`] : [])];
  if (!share && !restarted.length) clauses.unshift("keeps its share");
  return ` A box's GPU ${clauses.join(", and ")}.`;
}

function planCard(card: CardPlacement | null): string {
  return card ? `card ${card.index}` : "its card";
}

export function gpuPlanSummary(plan: GpuResize): string {
  const to = planCard(plan.toCard);
  const from = planCard(plan.fromCard);
  if (plan.stopped) {
    if (plan.to === "none") return "would lose its card while stopped";
    if (plan.to === "whole") return `would take ${to} whole while stopped`;
    return plan.from === "none" ? "would get a shared GPU from its next start" : `would open ${from} to other boxes while stopped`;
  }
  if (plan.way === "live") return plan.to === "whole" ? `could change to a whole card live, on ${to}` : `could open ${from} to other boxes live`;
  if (plan.to === "none") return `would lose ${from} with a restart`;
  if (plan.from === "none") return `would get ${plan.installs ? `NVIDIA's userspace ${plan.installs} and ` : ""}${to}${plan.to === "whole" ? " whole" : ""} with a restart`;
  return `would move to ${to} with a restart`;
}

export function sameGpuPlan(agreed: GpuResize, now: GpuResize): boolean {
  return agreed.from === now.from && agreed.to === now.to && agreed.way === now.way && agreed.stopped === now.stopped && (agreed.toCard?.card ?? null) === (now.toCard?.card ?? null) && (now.installs === null || now.installs === agreed.installs);
}

export function gpuPlanChangedWords(name: string, agreed: GpuResize, now: GpuResize, because: GpuRefusal | null): GpuRefusal {
  const said = (reason: string | null) => `when you checked, ${name} ${gpuPlanSummary(agreed)}; now ${reason ? `${reason}, so it` : "it"} ${gpuPlanSummary(now)}`;
  const restart = now.way === "restart";
  return {
    person: `Not resized: ${said(because?.person ?? null)}. ${restart ? "Resize it again with the restart" : "Resize it again"} to do that, or keep its GPU as it is. bb-box changed nothing.`,
    agent: `Not resized: ${said(because?.agent ?? null)}. ${restart ? "Call box_resize with restart true" : "Call box_resize again"} to do that, or ask the user. bb-box changed nothing.`,
  };
}

export const WHOLE_CARDS_OFF_IN_LIST = "Whole cards are off on this install: ask the user if a box needs a card to itself.";
