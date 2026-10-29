import { createContext, useContext } from "react";
import type { BackendConfig, ConfigDocument, Problem } from "../core/document.ts";
import type { ApplyResult, ConfigState } from "../plugin/contract.ts";
import type { DockerHostView } from "../plugin/docker-hosts.ts";
import { submittedWrite, type InstantWrite, type Operation } from "./settings-drafts.ts";
import { candidateOf, fileIsStored, filePath, plain, storedAt, type EditValue, type Path, type PlainValue } from "./settings-paths.ts";
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

export type GeneralAtOnce = "enrol" | "video" | "nightlyImages" | "defaultKind";
export type MonitorAtOnce = "enabled" | "backgroundMonitoring" | "pressureNotifications";

export interface SettingsWrites {
  backendOn(state: ConfigState, config: BackendConfig, on: boolean, what: string): InstantWrite;
  kindOn(state: ConfigState, id: string, on: boolean, what: string): InstantWrite;
  general(state: ConfigState, key: GeneralAtOnce, value: boolean | string, what: string, say?: (value: PlainValue) => string): InstantWrite;
  monitor(state: ConfigState, key: MonitorAtOnce, value: boolean, what: string): InstantWrite;
  dockerHost(host: DockerHostView, on: boolean): InstantWrite;
  removeFile(state: ConfigState, path: string): InstantWrite;
}

export const switchKey = {
  backend: (id: string) => `backend:${id}`,
  kind: (id: string) => `kind:${id}`,
  general: (key: string) => `general:${key}`,
  monitor: (key: string) => `monitor:${key}`,
  dockerHost: (hostId: string) => `docker-host:${hostId}`,
  removeFile: (path: string) => `remove-file:${path}`,
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
      if (!hostId) return write;
      return { ...write, send: (_transport, _built, _state, operation) => dockerHostSet(hostId, on, operation) };
    },
    kindOn(state, id, on, what) {
      const path = `kinds/${id}/enabled`;
      return pathWrite(state, switchKey.kind(id), what, path, plain(on), on, settingWords(path, onOff));
    },
    general(state, key, value, what, say = onOff) {
      const path = `general/${key}`;
      return pathWrite(state, switchKey.general(key), what, path, plain(value), value, settingWords(path, say));
    },
    monitor(state, key, value, what) {
      const path = `monitor/${key}`;
      return pathWrite(state, switchKey.monitor(key), what, path, plain(value), value, settingWords(path, onOff));
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
  };
}
