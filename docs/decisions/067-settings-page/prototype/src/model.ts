import type { Tone } from "@/src/app/common.tsx";
import { DOCKER_MACHINES, DRIVERS, KINDS, driverOf, kindOf, offersOf, type BackendConfig, type BackendLive, type BoxSize, type Check, type Document, type KindConfig, type StandardImage } from "./data";
import { problemsOf, relative, STALE_MS } from "./store";

export function qualifierOf(backend: BackendConfig, live: BackendLive | undefined): string | null {
  if (live?.bbMachine) return live.bbMachine.name;
  if (backend.id.includes(":")) return backend.id.slice(backend.id.indexOf(":") + 1);
  if (backend.type === "proxmox-lxc" || backend.type === "proxmox-qemu") return String(backend.fields.node || "pve-1");
  if (backend.type === "docker") return backend.fields.host ? "docker-1" : "this machine";
  if (backend.type === "tart") return (backend.hosts ?? []).map((host) => host.name).join(", ") || null;
  return null;
}

export function backendTitle(backend: BackendConfig, live?: BackendLive): string {
  const qualifier = qualifierOf(backend, live);
  const label = backend.label ?? driverOf(backend.type).label;
  return qualifier ? `${label} on ${qualifier}` : label;
}

export type BackendStatus = "off" | "unfinished" | "checking" | "building" | "never" | "changed" | "stale" | "ready" | "attention" | "failing";

export interface BackendState {
  readonly status: BackendStatus;
  readonly tone: Tone;
  readonly words: string;
  readonly items: readonly string[];
  readonly problem: Check | null;
}

export function firstProblem(live: BackendLive | undefined): Check | null {
  return live?.health?.checks.find((check) => check.status === "fail") ?? live?.health?.checks.find((check) => check.status === "warn") ?? null;
}

export function unfinished(doc: Document, backend: BackendConfig): string | null {
  const problems = problemsOf({ ...doc, backends: [{ ...backend, enabled: true }] }, new Set([`backends/${backend.id}`]));
  return problems.length ? problems[0]!.message.replace(" It cannot be on without it.", "") : null;
}

export function backendState(doc: Document, backend: BackendConfig, live: BackendLive | undefined): BackendState {
  const boxes = live?.boxes ?? 0;
  const boxWords = boxes ? [plural(boxes, "box", "boxes")] : [];
  const offers = live?.offers.length ?? 0;
  const missing = unfinished(doc, backend);
  if (!backend.enabled && missing) return { status: "unfinished", tone: "warn", words: "Not finished", items: [missing], problem: null };
  if (!backend.enabled) return { status: "off", tone: "off", words: "Off", items: boxWords.length ? [...boxWords, "takes no new boxes"] : ["takes no new boxes"], problem: null };
  if (live?.checking) return { status: "checking", tone: "busy", words: "Checking…", items: boxWords, problem: null };
  if (live?.building) return { status: "building", tone: "busy", words: live.building, items: [], problem: null };
  const problem = firstProblem(live);
  if (problem) return { status: problem.status === "fail" ? "failing" : "attention", tone: problem.status === "fail" ? "bad" : "warn", words: problem.status === "fail" ? "Not working" : "Needs attention", items: [problem.detail], problem };
  if (!live?.health) return { status: "never", tone: "off", words: "Not checked yet", items: boxWords, problem: null };
  if ((live.health.checkedRevision ?? 0) < live.changedRevision) return { status: "changed", tone: "off", words: "Not checked since it changed", items: [...boxWords, plural(offers, "kind")], problem: null };
  if (Date.now() - live.health.checkedAt > STALE_MS) return { status: "stale", tone: "ok", words: "Last check passed", items: [relative(live.health.checkedAt), ...boxWords, plural(offers, "kind")], problem: null };
  return { status: "ready", tone: "ok", words: "Ready", items: [...boxWords, plural(offers, "kind")], problem: null };
}

export function offering(doc: Document, live: Readonly<Record<string, BackendLive>>, kind: string): BackendConfig[] {
  return doc.backends.filter((backend) => backend.enabled && live[backend.id]?.offers.includes(kind));
}

export function configuredFor(doc: Document, kind: string): BackendConfig[] {
  return doc.backends.filter((backend) => backend.enabled && offersOf(backend).includes(kind));
}

export function canMake(doc: Document, kind: string): BackendConfig[] {
  return doc.backends.filter((backend) => driverOf(backend.type).kinds.includes(kind));
}

export type KindAvailability = "offered" | "lost" | "none" | "off";

export function availability(doc: Document, live: Readonly<Record<string, BackendLive>>, kind: string): KindAvailability {
  if (!doc.kinds[kind]?.enabled) return "off";
  if (offering(doc, live, kind).length) return "offered";
  if (configuredFor(doc, kind).length) return "lost";
  return "none";
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
  return kindOf(id).label;
}

export function kindBadges(id: string): string[] {
  const kind = kindOf(id);
  if (kind.gpu) return ["GPU"];
  if (id === "linux-desktop-cpu" || id === "linux-desktop-wayland-cpu" || id === "linux-arm64-desktop-cpu") return ["CPU"];
  return [];
}

export function kindName(id: string): string {
  const badges = kindBadges(id);
  return badges.length ? `${kindTitle(id)} (${badges.join(", ")})` : kindTitle(id);
}

export function kindOrder(): string[] {
  return KIND_GROUPS.flatMap((group) => group.ids).filter((id) => KINDS.some((kind) => kind.id === id));
}

export function availableTypes(doc: Document): string[] {
  return DRIVERS.filter((driver) => driver.several || !doc.backends.some((backend) => backend.type === driver.type)).map((driver) => driver.type);
}

export const FORMS: Record<string, string> = { "proxmox-lxc": "LXC", "proxmox-qemu": "VM", docker: "Container", hetzner: "Container", microsandbox: "microVM", tart: "VM", namespace: "VM", "ssh-pool": "Physical machine" };

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface StatusItem {
  readonly key: string;
  readonly tone: Tone;
  readonly title: string;
  readonly detail: string;
  readonly fix?: string;
  readonly open: { readonly page: "backend"; readonly id: string } | { readonly page: "kind"; readonly id: string } | { readonly page: "option"; readonly id: "images" | "boxes" } | { readonly page: "add" };
}

export function statusItems(doc: Document, live: Readonly<Record<string, BackendLive>>, images: readonly StandardImage[]): StatusItem[] {
  const items: StatusItem[] = [];
  for (const backend of doc.backends) {
    const state = backendState(doc, backend, live[backend.id]);
    if (state.problem) items.push({ key: `b-${backend.id}`, tone: state.tone, title: backendTitle(backend, live[backend.id]), detail: state.problem.detail, fix: state.problem.fix, open: { page: "backend", id: backend.id } });
    if (state.status === "unfinished") items.push({ key: `u-${backend.id}`, tone: "warn", title: `${backendTitle(backend, live[backend.id])} is not finished`, detail: state.items[0] ?? "", fix: "Finish its settings, then turn it on.", open: { page: "backend", id: backend.id } });
    for (const short of live[backend.id]?.warmShort ?? []) {
      items.push({ key: `w-${backend.id}-${short.kind}`, tone: "warn", title: `Warm ${kindName(short.kind)} boxes on ${backendTitle(backend, live[backend.id])}`, detail: `${short.ready} of ${short.wanted} ready: ${short.reason}`, fix: "Lower the warm count, or free memory on the host.", open: { page: "kind", id: short.kind } });
    }
  }
  const defaultKind = doc.general.defaultKind;
  if (!doc.kinds[defaultKind]?.enabled) items.push({ key: "default-off", tone: "bad", title: `The default kind, ${kindName(defaultKind)}, is off`, detail: "A thread that names no kind gets no box.", fix: "Turn it on, or choose another default.", open: { page: "option", id: "boxes" } });
  for (const id of kindOrder()) {
    if (availability(doc, live, id) === "lost") items.push({ key: `k-${id}`, tone: "warn", title: `Not offered now: ${kindName(id)}`, detail: `Its backends cannot make it: ${configuredFor(doc, id).map((backend) => backendTitle(backend, live[backend.id])).join(", ")}.`, open: { page: "kind", id } });
  }
  for (const image of images) if (image.lastState === "failed") items.push({ key: `i-${image.name}`, tone: "warn", title: `Image ${image.name} did not rebuild`, detail: image.last, fix: "Free disk on the Mac, then Rebuild what is due.", open: { page: "option", id: "images" } });
  for (const machine of DOCKER_MACHINES) {
    const used = doc.backends.find((backend) => backend.fields.host === `bb:${machine.id}`);
    if (used && machine.fault) items.push({ key: `d-${machine.id}`, tone: "bad", title: `Docker on ${machine.name}`, detail: machine.fault, open: { page: "backend", id: used.id } });
  }
  return items;
}
