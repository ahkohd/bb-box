import { createContext, useContext } from "react";
import type { GpuPart } from "../backends/types.ts";
import type { BackendConfig, ConfigDocument, ImageBake, Problem } from "../core/document.ts";
import { gpuWhenNotAsked, isGpuPart } from "../core/gpu.ts";
import type { ApplyResult, ConfigState } from "../plugin/contract.ts";
import type { DockerHostView } from "../plugin/docker-hosts.ts";
import { submittedWrite, type InstantWrite, type Operation } from "./settings-drafts.ts";
import { backendFieldPath, backendPath, backendProjectsPath, projectsText, candidateOf, fileIsStored, filePath, hostPath, imageBakePath, imagePath, plain, snapshotPath, storedAt, type EditValue, type Path, type PlainValue } from "./settings-paths.ts";
import type { Instant } from "./settings-saving.tsx";
import type { SettingsNav } from "./settings-nav.ts";
import { machineHostId } from "./settings-status.ts";

export interface Saved {
  readonly saved: boolean;
  readonly problems: readonly Problem[];
}

export interface SettingsContextValue {
  readonly state: ConfigState;
  readonly nav: SettingsNav;
  readonly instant: Instant;
  readonly writes: SettingsWrites;
  readonly notice: string | null;
  refresh(): Promise<void>;
  apply(draft: ConfigDocument): Promise<Saved>;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("BB Box's settings are not loaded.");
  return value;
}

export type GeneralAtOnce = "enrol" | "video" | "nightlyImages" | "defaultKind" | "iosEncoder" | "encoderLedger" | "testDevice";
export type MonitorAtOnce = "enabled" | "backgroundMonitoring" | "pressureNotifications" | "boxHistory";
export type SnapshotsAtOnce = "agentsRestore" | "agentsMemory" | "pictures";

export interface SettingsWrites {
  backendOn(state: ConfigState, config: BackendConfig, on: boolean, what: string): InstantWrite;
  backendLabel(state: ConfigState, config: BackendConfig, label: string, what: string): InstantWrite;
  backendProjects(state: ConfigState, config: BackendConfig, projects: readonly string[], what: string, say: (projects: readonly string[]) => string): InstantWrite;
  removeBackend(state: ConfigState, config: BackendConfig, what: string): InstantWrite;
  hostOn(state: ConfigState, config: BackendConfig, host: string, on: boolean, what: string): InstantWrite;
  kindOn(state: ConfigState, id: string, on: boolean, what: string): InstantWrite;
  kindGpu(state: ConfigState, id: string, gpu: GpuPart, what: string): InstantWrite;
  backendField(state: ConfigState, config: BackendConfig, key: string, value: boolean, what: string): InstantWrite;
  general(state: ConfigState, key: GeneralAtOnce, value: boolean | string, what: string, say?: (value: PlainValue) => string): InstantWrite;
  monitor(state: ConfigState, key: MonitorAtOnce, value: boolean, what: string): InstantWrite;
  snapshots(state: ConfigState, key: SnapshotsAtOnce, value: boolean, what: string): InstantWrite;
  dockerHost(host: DockerHostView, on: boolean): InstantWrite;
  removeFile(state: ConfigState, path: string): InstantWrite;
  imageBake(state: ConfigState, name: string, bake: ImageBake, say: (value: PlainValue) => string): InstantWrite;
  removeImage(state: ConfigState, name: string): InstantWrite;
}

export const switchKey = {
  backend: (id: string) => `backend:${id}`,
  backendLabel: (id: string) => `backend-label:${id}`,
  backendProjects: (id: string) => `backend-projects:${id}`,
  removeBackend: (id: string) => `remove-backend:${id}`,
  host: (id: string, name: string) => `host:${id}:${name}`,
  kind: (id: string) => `kind:${id}`,
  kindGpu: (id: string) => `kind-gpu:${id}`,
  backendField: (id: string, key: string) => `backend-field:${id}:${key}`,
  general: (key: string) => `general:${key}`,
  monitor: (key: string) => `monitor:${key}`,
  snapshots: (key: string) => `snapshots:${key}`,
  dockerHost: (hostId: string) => `docker-host:${hostId}`,
  removeFile: (path: string) => `remove-file:${path}`,
  imageBake: (name: string) => `image-bake:${name}`,
  removeImage: (name: string) => `remove-image:${name}`,
};

function onOff(value: PlainValue): string {
  return value === true ? "on" : value === false ? "off" : String(value);
}

type Call = <T>(method: string, input?: unknown) => Promise<T>;

function pathWrite(state: ConfigState, key: string, what: string, path: Path, value: EditValue, pending: unknown, say: (state: ConfigState) => string): InstantWrite {
  const edits = [{ path, value, base: storedAt(state, path, value) }];
  return { key, what, pending, say, ...submittedWrite({ part: `instant:${key}`, edits }) };
}

function settingWords(path: Path, say: (value: PlainValue) => string) {
  return (state: ConfigState) => {
    const stored = storedAt(state, path);
    return say(stored.kind === "value" ? stored.value : null);
  };
}

function dockerHostOn(state: ConfigState, hostId: string): boolean {
  return state.document.backends.some((backend) => machineHostId(backend) === hostId && backend.enabled);
}

export function settingsWrites(rpc: { call: (...args: never[]) => Promise<unknown> }): SettingsWrites {
  const call = rpc.call as unknown as Call;
  const dockerHostSet = async (hostId: string, enabled: boolean, operation: Operation) => (await call<{ result: ApplyResult }>("docker.host.set", { hostId, enabled, operation: operation.id })).result;
  return {
    backendOn(state, config, on, what) {
      const path = `backends/${config.id}/enabled`;
      const write = pathWrite(state, switchKey.backend(config.id), what, path, plain(on), on, settingWords(path, onOff));
      const hostId = machineHostId(config);
      if (!hostId || !on) return write;
      return { ...write, send: (_transport, _built, _state, operation) => dockerHostSet(hostId, on, operation) };
    },
    backendLabel(state, config, label, what) {
      const path = `${backendPath(config.id)}/label`;
      return pathWrite(state, switchKey.backendLabel(config.id), what, path, plain(label), label, (latest) => latest.document.backends.find((backend) => backend.id === config.id)?.label ?? "the driver's name");
    },
    backendProjects(state, config, projects, what, say) {
      const path = backendProjectsPath(config.id);
      return pathWrite(state, switchKey.backendProjects(config.id), what, path, plain(projectsText(projects)), projects, (latest) => say(latest.document.backends.find((backend) => backend.id === config.id)?.projects ?? []));
    },
    removeBackend(state, config, what) {
      const path = backendPath(config.id);
      return {
        ...pathWrite(state, switchKey.removeBackend(config.id), what, path, { kind: "removed" }, true, (latest) => (latest.document.backends.some((backend) => backend.id === config.id) ? "still here" : "removed")),
        undone: "removed",
      };
    },
    hostOn(state, config, host, on, what) {
      const path = `${hostPath(config.id, host)}/enabled`;
      return pathWrite(state, switchKey.host(config.id, host), what, path, plain(on), on, settingWords(path, onOff));
    },
    kindOn(state, id, on, what) {
      const path = `kinds/${id}/enabled`;
      return pathWrite(state, switchKey.kind(id), what, path, plain(on), on, settingWords(path, onOff));
    },
    kindGpu(state, id, gpu, what) {
      const path = `kinds/${id}/gpu`;
      const stored = gpu === gpuWhenNotAsked(id) ? null : gpu;
      return pathWrite(state, switchKey.kindGpu(id), what, path, plain(stored), gpu, settingWords(path, (value) => (isGpuPart(value) ? value : gpuWhenNotAsked(id))));
    },
    backendField(state, config, key, value, what) {
      const path = backendFieldPath(config.id, key);
      return pathWrite(state, switchKey.backendField(config.id, key), what, path, plain(value), value, settingWords(path, onOff));
    },
    general(state, key, value, what, say = onOff) {
      const path = `general/${key}`;
      return pathWrite(state, switchKey.general(key), what, path, plain(value), value, settingWords(path, say));
    },
    monitor(state, key, value, what) {
      const path = `monitor/${key}`;
      return pathWrite(state, switchKey.monitor(key), what, path, plain(value), value, settingWords(path, onOff));
    },
    snapshots(state, key, value, what) {
      const path = snapshotPath(key);
      return pathWrite(state, switchKey.snapshots(key), what, path, plain(value), value, settingWords(path, onOff));
    },
    dockerHost(host, on) {
      return {
        key: switchKey.dockerHost(host.hostId),
        what: `Hosting boxes on ${host.name}`,
        pending: on,
        say: (state) => (dockerHostOn(state, host.hostId) ? "on" : "off"),
        build: (state) => ({ ...candidateOf(state, []), needed: dockerHostOn(state, host.hostId) !== on }),
        send: (_transport, _built, _state, operation) => dockerHostSet(host.hostId, on, operation),
      };
    },
    removeFile(state, path) {
      const at = filePath(path);
      return {
        ...pathWrite(state, switchKey.removeFile(path), `~/${path}`, at, { kind: "removed" }, true, (latest) => (fileIsStored(latest, at) ? "still here" : "removed")),
        undone: "removed",
      };
    },
    imageBake(state, name, bake, say) {
      const path = imageBakePath(name);
      return pathWrite(state, switchKey.imageBake(name), `When ${name} is built ahead`, path, plain(bake), bake, settingWords(path, say));
    },
    removeImage(state, name) {
      return {
        ...pathWrite(state, switchKey.removeImage(name), `The image ${name}`, imagePath(name), { kind: "removed" }, true, (latest) => (latest.document.images?.[name] ? "still here" : "removed")),
        undone: "removed",
      };
    },
  };
}
