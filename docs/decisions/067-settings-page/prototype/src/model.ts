import type { Tone } from "@/src/app/common.tsx";
import { DRIVERS, KINDS, driverOf, kindOf, type BackendConfig, type BackendLive, type BoxSize, type Check, type Document, type KindConfig } from "./data";

export function qualifierOf(backend: BackendConfig, live: BackendLive | undefined): string | null {
  if (live?.bbMachine) return live.bbMachine.name;
  if (backend.id.includes(":")) return backend.id.slice(backend.id.indexOf(":") + 1);
  if (backend.type === "proxmox-lxc" || backend.type === "proxmox-qemu") return String(backend.fields.node || "pve-1");
  if (backend.type === "docker") return "docker-1";
  if (backend.type === "tart") return (backend.hosts ?? []).map((host) => host.name).join(", ") || null;
  return null;
}

export function backendTitle(backend: BackendConfig, live?: BackendLive): string {
  const qualifier = qualifierOf(backend, live);
  return qualifier ? `${driverOf(backend.type).label} on ${qualifier}` : driverOf(backend.type).label;
}

export interface BackendState {
  readonly tone: Tone;
  readonly words: string;
  readonly items: readonly string[];
  readonly problem: Check | null;
}

export function firstProblem(live: BackendLive | undefined): Check | null {
  return live?.health?.checks.find((check) => check.status === "fail") ?? live?.health?.checks.find((check) => check.status === "warn") ?? null;
}

export function backendState(backend: BackendConfig, live: BackendLive | undefined): BackendState {
  const boxes = live?.boxes ?? 0;
  const boxWords = boxes ? [`${boxes} ${boxes === 1 ? "box" : "boxes"}`] : [];
  if (!backend.enabled) return { tone: "off", words: "Off", items: boxWords.length ? [...boxWords, "takes no new boxes"] : ["takes no new boxes"], problem: null };
  if (live?.checking) return { tone: "busy", words: "Checking…", items: boxWords, problem: null };
  const problem = firstProblem(live);
  if (problem) return { tone: problem.status === "fail" ? "bad" : "warn", words: problem.status === "fail" ? "Not working" : "Needs attention", items: [problem.detail], problem };
  const offers = live?.offers.length ?? 0;
  return { tone: "ok", words: "Ready", items: [...boxWords, `${offers} ${offers === 1 ? "kind" : "kinds"}`], problem: null };
}

export function offering(doc: Document, live: Readonly<Record<string, BackendLive>>, kind: string): BackendConfig[] {
  return doc.backends.filter((backend) => backend.enabled && live[backend.id]?.offers.includes(kind));
}

export function canMake(doc: Document, kind: string): BackendConfig[] {
  return doc.backends.filter((backend) => driverOf(backend.type).kinds.includes(kind));
}

export function warmTotal(doc: Document, kind: string): number {
  return doc.backends.reduce((sum, backend) => sum + (backend.warm?.[kind] ?? 0), 0);
}

export function gib(mib: number): number {
  return Math.round((mib / 1024) * 10) / 10;
}

export function sizeWords(size: BoxSize, disk = false): string {
  const parts = [`${size.cores} ${size.cores === 1 ? "core" : "cores"}`, `${gib(size.memoryMiB)} GiB`];
  if (disk) parts.push(size.diskGiB === null ? "base disk" : `${size.diskGiB} GiB disk`);
  return parts.join(" · ");
}

export function defaultSize(kind: KindConfig): BoxSize {
  return kind.presets[kind.default];
}

export const KIND_GROUPS: readonly { readonly title: string; readonly ids: readonly string[] }[] = [
  { title: "Linux", ids: ["linux", "linux-desktop", "linux-desktop-cpu", "linux-desktop-wayland-cpu", "linux-arm64", "linux-arm64-desktop-cpu"] },
  { title: "macOS and iOS", ids: ["macos", "macos-desktop", "ios"] },
  { title: "Windows and Android", ids: ["windows-desktop", "windows-arm64-desktop", "android"] },
];

export function kindTitle(id: string): string {
  const kind = kindOf(id);
  if (id === "linux-desktop") return "Linux desktop";
  return kind.label;
}

export function kindName(id: string): string {
  const badges = kindBadges(id);
  return badges.length ? `${kindTitle(id)} (${badges.join(", ")})` : kindTitle(id);
}

export function kindBadges(id: string): string[] {
  const kind = kindOf(id);
  const badges: string[] = [];
  if (kind.gpu) badges.push("GPU");
  if (id === "linux-desktop-cpu" || id === "linux-desktop-wayland-cpu" || id === "linux-arm64-desktop-cpu") badges.push("CPU");
  return badges;
}

export function kindOrder(): string[] {
  return KIND_GROUPS.flatMap((group) => group.ids).filter((id) => KINDS.some((kind) => kind.id === id));
}

export function availableTypes(doc: Document): string[] {
  return DRIVERS.filter((driver) => driver.several || !doc.backends.some((backend) => backend.type === driver.type)).map((driver) => driver.type);
}

export const FORMS: Record<string, string> = { "proxmox-lxc": "LXC", "proxmox-qemu": "VM", docker: "Container", hetzner: "Container", microsandbox: "microVM", tart: "VM", namespace: "VM", "ssh-pool": "Physical" };

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
