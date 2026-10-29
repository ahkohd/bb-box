import type { DoctorReport } from "../backends/types.ts";
import type { BackendConfig } from "../core/document.ts";
import type { BackendState, ConfigState, KindInfoView } from "../plugin/configuration.ts";
import { relativeTime, type Tone } from "./common.tsx";
import { effectiveKind, problemsUnder } from "./config.ts";
import type { SettingsView } from "./settings-route.ts";

export const FRESH_CHECK_MS = 60 * 60_000;
const SAME_AGE_MS = 5 * 60_000;

export type BackendStatus = "off" | "unfinished" | "never" | "changed" | "stale" | "ready" | "failing";

export interface BackendHealth {
  readonly status: BackendStatus;
  readonly tone: Tone;
  readonly words: string;
  readonly detail: string | null;
  readonly fix: string | null;
  readonly checkedAt: number | null;
  readonly warnings: number;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function onBbMachine(config: BackendConfig): boolean {
  return (config.type === "docker" || config.type === "microsandbox") && typeof config.fields.host === "string" && config.fields.host.startsWith("bb:");
}

export function warningsIn(report: DoctorReport): number {
  return report.checks.filter((check) => check.status === "warn").length;
}

export function withWarnings(words: string, warnings: number): string {
  return warnings ? `${words}, ${plural(warnings, "warning")}` : words;
}

export function isMachineDocker(config: BackendConfig): boolean {
  return config.type === "docker" && typeof config.fields.host === "string" && config.fields.host.startsWith("bb:");
}

export function machineHostId(config: BackendConfig): string | null {
  return isMachineDocker(config) ? (config.fields.host as string).slice("bb:".length) : null;
}

function fieldText(config: BackendConfig, key: string): string {
  const value = config.fields[key];
  return typeof value === "string" ? value.trim() : "";
}

function urlHost(url: string): string | null {
  try {
    return url ? new URL(url).hostname || null : null;
  } catch {
    return null;
  }
}

function daemonHost(host: string): string | null {
  if (!host || host.startsWith("unix://")) return "this machine";
  if (host.startsWith("bb:")) return null;
  const ssh = /^ssh:\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+)/.exec(host);
  return ssh ? ssh[1]!.replace(/^\[|\]$/g, "") : urlHost(host);
}

function machineLines(text: string): number {
  return text.split("\n").filter((line) => line.replace(/#.*/, "").trim()).length;
}

function hostOfFields(config: BackendConfig): string | null {
  switch (config.type) {
    case "proxmox-lxc":
    case "proxmox-qemu":
      return fieldText(config, "node") || urlHost(fieldText(config, "url"));
    case "tart": {
      const names = (config.hosts ?? []).map((host) => host.name);
      return names.length === 1 ? names[0]! : names.length > 1 ? plural(names.length, "Mac") : null;
    }
    case "docker":
    case "microsandbox":
      return daemonHost(fieldText(config, "host"));
    case "ssh-pool": {
      const count = machineLines(fieldText(config, "machines"));
      return count ? plural(count, "machine") : null;
    }
    default:
      return null;
  }
}

function hostsWords(config: BackendConfig, hosts: readonly string[]): string | null {
  if (hosts.length === 1) return hosts[0]!;
  return hosts.length > 1 ? plural(hosts.length, config.type === "tart" ? "Mac" : "host") : null;
}

export function hostChip(config: BackendConfig, label: string, hosts: readonly string[] = []): string | null {
  const named = config.id.includes(":") ? config.id.slice(config.id.indexOf(":") + 1) : null;
  const host = hostsWords(config, hosts) ?? hostOfFields(config) ?? named;
  return host && !label.toLowerCase().includes(host.toLowerCase()) ? host : null;
}

export function backendLabel(state: ConfigState, config: BackendConfig): string {
  const live = state.backends.find((candidate) => candidate.id === config.id);
  return live?.label ?? config.label ?? state.drivers.find((driver) => driver.type === config.type)?.label ?? config.type;
}

export function backendHealth(state: ConfigState, config: BackendConfig, now: number): BackendHealth {
  const live: BackendState | undefined = state.backends.find((candidate) => candidate.id === config.id);
  const stored = problemsUnder(state.problems, `backends.${config.id}`);
  const doctor = live?.doctor ?? null;
  const checkedAt = doctor?.at ?? null;
  const quiet = { checkedAt, warnings: 0 };
  if (!config.enabled) {
    const missing = live?.problems[0]?.message ?? stored[0]?.message ?? null;
    if (missing) return { status: "unfinished", tone: "warn", words: "Not finished", detail: missing, fix: "Finish its settings, then turn it on.", ...quiet };
    return { status: "off", tone: "off", words: "Off", detail: "takes no new boxes", fix: null, ...quiet };
  }
  if (live?.state === "misconfigured") {
    const first = live.problems[0]?.message ?? stored[0]?.message ?? "Its settings have a problem.";
    return { status: "failing", tone: "bad", words: "Not working", detail: first, fix: "Open it and fix its settings.", ...quiet };
  }
  if (!doctor) return { status: "never", tone: "off", words: "Not checked yet", detail: null, fix: null, ...quiet };
  const failed = doctor.report.checks.find((check) => check.status === "fail");
  const warnings = warningsIn(doctor.report);
  if (failed || (!doctor.report.ok && !warnings)) {
    return { status: "failing", tone: "bad", words: "Not working", detail: failed ? failed.detail || failed.name : doctor.report.summary, fix: failed?.fix ?? null, ...quiet };
  }
  if (live && doctor.revision !== null && doctor.revision < live.changed) return { status: "changed", tone: "off", words: "Not checked since it changed", detail: null, fix: null, ...quiet };
  if (now - doctor.at > FRESH_CHECK_MS) return { status: "stale", tone: "ok", words: withWarnings("Last check passed", warnings), detail: null, fix: null, checkedAt, warnings };
  return { status: "ready", tone: "ok", words: withWarnings("Ready", warnings), detail: null, fix: null, checkedAt, warnings };
}

export function backendLine(state: ConfigState, config: BackendConfig, health: BackendHealth, now: number, showAge: boolean): string[] {
  const live = state.backends.find((candidate) => candidate.id === config.id);
  const boxes = live?.boxes ?? 0;
  const kinds = live?.kinds.length ?? 0;
  const age = showAge && health.checkedAt !== null && (health.status === "stale" || health.status === "ready") ? [relativeTime(health.checkedAt, now)] : [];
  if (health.status === "off" || health.status === "unfinished") return [...(boxes ? [plural(boxes, "box", "boxes")] : []), ...(health.detail ? [health.detail] : [])];
  if (health.status === "failing") return health.detail ? [health.detail] : [];
  return [...age, ...(boxes ? [plural(boxes, "box", "boxes")] : []), ...(health.status === "never" || health.status === "changed" ? [] : [plural(kinds, "kind")])];
}

export function checkAges(healths: readonly BackendHealth[]): { readonly oldest: number; readonly newest: number } | null {
  const times = healths.filter((health) => health.status !== "off" && health.status !== "unfinished").map((health) => health.checkedAt).filter((at): at is number => at !== null);
  return times.length ? { oldest: Math.min(...times), newest: Math.max(...times) } : null;
}

export function sameCheckAge(healths: readonly BackendHealth[]): boolean {
  const ages = checkAges(healths);
  return ages !== null && ages.newest - ages.oldest < SAME_AGE_MS;
}

export interface StatusLine {
  readonly tone: Tone;
  readonly headline: string;
  readonly details: readonly string[];
  readonly checkFirst: boolean;
}

export function statusLine(state: ConfigState, now: number, checking: number): StatusLine {
  const on = state.document.backends.filter((backend) => backend.enabled);
  const off = state.document.backends.length - on.length;
  const healths = on.map((backend) => backendHealth(state, backend, now));
  const offered = offeredKinds(state).length;
  if (checking) return { tone: "busy", headline: `Checking ${plural(checking, "backend")}, up to 30 s each, side by side…`, details: [], checkFirst: false };
  if (!state.document.backends.length) return { tone: "off", headline: "No backend yet", details: [], checkFirst: false };
  if (!on.length) return { tone: "bad", headline: "Every backend is off", details: [plural(off, "backend") + " off"], checkFirst: false };
  const fresh = healths.filter((health) => health.status === "ready").length;
  const stale = healths.filter((health) => health.status === "stale").length;
  const never = healths.filter((health) => health.status === "never").length;
  const changed = healths.filter((health) => health.status === "changed").length;
  const troubled = healths.filter((health) => health.status === "failing").length;
  const passed = fresh + stale;
  const words = stale ? "passed their last check" : "ready";
  const headline =
    on.length === 1 && passed === 1
      ? `${backendLabel(state, on[0]!)} ${stale ? "passed its last check" : "is ready"}`
      : on.length === 1 && never === 1
        ? `${backendLabel(state, on[0]!)} is not checked yet`
        : on.length === 1 && changed === 1
          ? `${backendLabel(state, on[0]!)} is not checked since it changed`
        : on.length === 1
          ? `${backendLabel(state, on[0]!)} is not working`
          : passed === on.length
        ? `All ${plural(on.length, "backend")} ${words}`
        : `${passed} of ${plural(on.length, "backend")} ${words}`;
  const ages = checkAges(healths);
  const age = ages === null ? null : ages.newest - ages.oldest < SAME_AGE_MS ? `checked ${relativeTime(ages.oldest, now)}` : `checked between ${relativeTime(ages.newest, now)} and ${relativeTime(ages.oldest, now)}`;
  const details = [
    ...(never && on.length > 1 ? [`${never} not checked yet`] : []),
    ...(changed && on.length > 1 ? [`${changed} not checked since ${changed === 1 ? "it" : "they"} changed`] : []),
    ...(off ? [`${off} off`] : []),
    `${plural(offered, "kind")} on offer`,
    ...(age ? [age] : []),
  ];
  const tone: Tone = troubled ? "warn" : stale || never || changed ? "off" : "ok";
  return { tone, headline, details, checkFirst: stale > 0 || never > 0 || changed > 0 };
}

export function offeredKinds(state: ConfigState): string[] {
  const on = new Set(state.document.backends.filter((backend) => backend.enabled).map((backend) => backend.id));
  const offered = new Set(state.backends.filter((backend) => on.has(backend.id) && backend.state === "active").flatMap((backend) => backend.kinds));
  return state.kinds.filter((kind) => offered.has(kind.id) && effectiveKind(state, kind.id).enabled).map((kind) => kind.id);
}

export type KindAvailability = "offered" | "lost" | "none" | "off";

export function kindAvailability(state: ConfigState, id: string): KindAvailability {
  if (!effectiveKind(state, id).enabled) return "off";
  if (offeringBackends(state, id).length) return "offered";
  const info = state.kinds.find((kind) => kind.id === id);
  const stuck = state.document.backends.filter((backend) => backend.enabled && info?.drivers.includes(backend.type) && state.backends.find((live) => live.id === backend.id)?.state === "misconfigured");
  return stuck.length ? "lost" : "none";
}

export function offeringBackends(state: ConfigState, id: string): BackendConfig[] {
  return state.document.backends.filter((backend) => backend.enabled && state.backends.some((live) => live.id === backend.id && live.state === "active" && live.kinds.includes(id)));
}

export function warmCount(state: ConfigState, id: string): number {
  return state.document.backends.reduce((sum, backend) => sum + (backend.warm?.[id] ?? 0), 0);
}

export function kindName(kinds: readonly KindInfoView[], info: KindInfoView): string {
  const twins = kinds.filter((kind) => kind.label === info.label);
  if (twins.length < 2) return info.label;
  return `${info.label} (${info.gpu ? "GPU" : "CPU"})`;
}

export function kindSummary(state: ConfigState, info: KindInfoView): string {
  const availability = kindAvailability(state, info.id);
  if (availability === "off") return "Off: no new boxes";
  if (availability === "lost") return "Not offered now: its backends cannot make it";
  if (availability === "none") return "No backend you have makes it";
  const sizes = effectiveKind(state, info.id);
  const size = sizes.presets[sizes.default];
  const warm = warmCount(state, info.id);
  return [`${size.cores} ${size.cores === 1 ? "core" : "cores"} · ${Math.round((size.memoryMiB / 1024) * 10) / 10} GiB`, plural(offeringBackends(state, info.id).length, "backend"), ...(warm ? [`${warm} warm`] : []), ...(sizes.spares ? [plural(sizes.spares, "spare")] : [])].join(" · ");
}

export const KIND_GROUPS = ["linux", "apple", "windows"] as const;

export function kindGroup(info: KindInfoView): (typeof KIND_GROUPS)[number] {
  if (info.device === "ios" || info.os === "macos") return "apple";
  if (info.device === "android" || info.os === "windows") return "windows";
  return "linux";
}

export interface StatusItem {
  readonly key: string;
  readonly tone: Tone;
  readonly title: string;
  readonly detail: string;
  readonly fix: string | null;
  readonly open: SettingsView;
}

export function statusItems(state: ConfigState, now: number): StatusItem[] {
  const items: StatusItem[] = [];
  for (const backend of state.document.backends) {
    const health = backendHealth(state, backend, now);
    const label = backendLabel(state, backend);
    const open: SettingsView = { page: "backend", id: backend.id };
    if (health.status === "failing") items.push({ key: `backend-${backend.id}`, tone: health.tone, title: label, detail: health.detail ?? "", fix: health.fix, open });
    if (health.status === "unfinished") items.push({ key: `unfinished-${backend.id}`, tone: "warn", title: `${label} is not finished`, detail: health.detail ?? "", fix: health.fix, open });
    for (const short of state.backends.find((live) => live.id === backend.id)?.warmShort ?? []) {
      const kinds = short.kinds.map((kind) => state.kinds.find((info) => info.id === kind)).filter((info): info is KindInfoView => !!info);
      items.push({
        key: `warm-${backend.id}-${short.kinds.join("-")}`,
        tone: "warn",
        title: `Warm ${kinds.map((info) => kindName(state.kinds, info)).join(" and ")} boxes on ${label}`,
        detail: `${short.have} of ${short.count} ready: ${short.reason}`,
        fix: "Lower the warm count, or free room on the host.",
        open: { page: "kind", id: short.kinds[0] ?? "" },
      });
    }
  }
  const general = { ...state.defaults.general, ...state.document.general };
  const defaultInfo = state.kinds.find((kind) => kind.id === general.defaultKind);
  if (defaultInfo && !effectiveKind(state, defaultInfo.id).enabled) {
    items.push({ key: "default-off", tone: "bad", title: `The default kind, ${kindName(state.kinds, defaultInfo)}, is off`, detail: "A thread that names no kind gets no box.", fix: "Turn it on, or choose another default.", open: { page: "option", id: "boxes" } });
  }
  if (state.document.backends.some((backend) => backend.enabled)) {
    for (const info of state.kinds) {
      if (kindAvailability(state, info.id) !== "lost") continue;
      items.push({ key: `kind-${info.id}`, tone: "warn", title: `Not offered now: ${kindName(state.kinds, info)}`, detail: "The backends that make it cannot make it now.", fix: null, open: { page: "kind", id: info.id } });
    }
  }
  return items;
}
