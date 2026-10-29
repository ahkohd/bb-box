import type { BackendConfig, ConfigDocument } from "../core/document.ts";
import type { DockerHostView } from "../plugin/docker-hosts.ts";
import type { ImageBuild } from "../plugin/docker-images.ts";
import type { DockerFix } from "../plugin/setup-offer.ts";
import type { Tone } from "./common.tsx";

export type MachineHosts = readonly DockerHostView[] | null;

export function machineIdOf(config: BackendConfig): string | null {
  const host = config.type === "docker" ? config.fields.host : undefined;
  return typeof host === "string" && host.startsWith("bb:") ? host.slice("bb:".length) : null;
}

export function machineOf(hosts: MachineHosts, config: BackendConfig): DockerHostView | null {
  const hostId = machineIdOf(config);
  return hostId ? (hosts?.find((host) => host.hostId === hostId) ?? null) : null;
}

export function backendOfMachine(document: ConfigDocument, hostId: string): BackendConfig | null {
  return document.backends.find((backend) => machineIdOf(backend) === hostId) ?? null;
}

export function dockerFacts(host: DockerHostView): string[] {
  if (!host.docker) return [];
  const { version, cpus, memoryMiB, arch } = host.docker;
  return [`Docker ${version}`, `${cpus} ${cpus === 1 ? "core" : "cores"}`, `${Math.round(memoryMiB / 1024)} GiB memory`, ...(arch === "x86_64" ? [] : [`${arch}, so boxes run under emulation`])];
}

export function hostState(host: DockerHostView, backend: BackendConfig | null): { tone: Tone; text: string } {
  const boxes = host.backend?.boxes ?? 0;
  const held = boxes ? `, ${boxes} ${boxes === 1 ? "box" : "boxes"} on it` : "";
  if (!host.connected) return { tone: "warn", text: `Offline in BB${held}` };
  if (!host.docker && !host.absent) return { tone: "bad", text: `Cannot host boxes${held}` };
  if (!host.docker) return { tone: backend ? "bad" : "off", text: backend ? `No Docker now${held}` : "No Docker" };
  if (backend?.enabled) return { tone: "ok", text: `Hosts boxes${held}` };
  if (backend) return { tone: "off", text: `Off: takes no new boxes${held}` };
  return { tone: "off", text: "Can host boxes" };
}

export function buildWords(host: DockerHostView): { tone: Tone; text: string } | null {
  const build = host.images;
  if (!build) return null;
  if (build.state === "checking") return { tone: "busy", text: "Checking its images" };
  if (build.state === "building") return { tone: "busy", text: `Building ${namesWords(build.targets)} images${buildStep(build)}` };
  if (build.state === "failed") return { tone: "bad", text: `Building its images failed: ${build.detail ?? "no reason given"}` };
  return build.detail ? { tone: "warn", text: build.detail } : null;
}

function buildStep(build: ImageBuild): string {
  const images = build.image && build.image.of > 1 ? `image ${build.image.at} of ${build.image.of}` : null;
  const step = build.step ? `step ${build.step.at} of ${build.step.of}` : null;
  const place = [images, step].filter(Boolean).join(", ");
  if (place) return ` · ${place[0]!.toUpperCase()}${place.slice(1)}`;
  return build.detail && !build.detail.startsWith("Building ") ? `: ${build.detail}` : "";
}

export function fixLines(fix: DockerFix): string {
  return `${fix.command}${fix.restart ? `, then ${fix.restart}` : ", then restart BB there"}`;
}

export interface MachineTrouble {
  readonly status: "failing";
  readonly tone: Tone;
  readonly words: string;
  readonly detail: string;
  readonly fix: string | null;
  readonly offline?: boolean;
}

export function machineTrouble(config: BackendConfig, hosts: MachineHosts): MachineTrouble | null {
  const hostId = machineIdOf(config);
  if (!hostId || !hosts) return null;
  const host = hosts.find((candidate) => candidate.hostId === hostId);
  if (!host) return { status: "failing", tone: "bad", words: "Cannot host boxes", detail: "BB has no such persistent machine now.", fix: "Add the machine to BB again, or remove this backend." };
  if (!host.connected) return { status: "failing", tone: "warn", words: "Offline in BB", detail: host.problem ?? "The machine is offline in BB.", fix: `Start ${host.name}, or BB on it, then check again.`, offline: true };
  if (host.docker) return null;
  if (host.absent) return { status: "failing", tone: "bad", words: "Cannot host boxes", detail: `${host.name} has no Docker now.`, fix: "Install Docker Engine there, then check again." };
  const detail = host.problem ?? "Docker there does not answer.";
  if (host.fix?.command) return { status: "failing", tone: "bad", words: "Cannot host boxes", detail: host.fix.problem, fix: `On ${host.name}, run ${fixLines(host.fix)}. Then check again.` };
  return { status: "failing", tone: "bad", words: "Cannot host boxes", detail, fix: "Make Docker answer there, then check again." };
}

export interface MachineOffers {
  readonly ready: readonly DockerHostView[];
  readonly cannot: readonly DockerHostView[];
  readonly offline: readonly DockerHostView[];
  readonly none: readonly DockerHostView[];
  readonly used: readonly DockerHostView[];
}

export function machineOffers(hosts: readonly DockerHostView[], document: ConfigDocument): MachineOffers {
  const unused = hosts.filter((host) => !backendOfMachine(document, host.hostId));
  return {
    ready: unused.filter((host) => host.connected && host.docker),
    cannot: unused.filter((host) => host.connected && !host.docker && !host.absent),
    offline: unused.filter((host) => !host.connected),
    none: unused.filter((host) => host.connected && !host.docker && host.absent),
    used: hosts.filter((host) => backendOfMachine(document, host.hostId)),
  };
}

export function namesWords(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function isBuilding(hosts: MachineHosts): boolean {
  return hosts?.some((host) => host.images?.state === "checking" || host.images?.state === "building") ?? false;
}
