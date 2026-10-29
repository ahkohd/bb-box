import { createContext, useContext } from "react";
import type { BackendConfig, ConfigDocument, Problem } from "../core/document.ts";
import type { ApplyResult, ConfigState } from "../plugin/contract.ts";
import { effectiveKind, kindChanges, withBackend, withGeneral, withKind, withMonitor } from "./config.ts";
import type { Instant, InstantWrite } from "./settings-instant.ts";
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
  readonly busy: string | null;
  refresh(): Promise<void>;
  apply(draft: ConfigDocument): Promise<Saved>;
  applyNow(key: string, draft: ConfigDocument): Promise<void>;
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
  backendOn(config: BackendConfig, on: boolean, what: string): InstantWrite<boolean>;
  kindOn(id: string, on: boolean, what: string): InstantWrite<boolean>;
  general(key: GeneralAtOnce, value: boolean | string, what: string, say?: (value: boolean | string) => string): InstantWrite<boolean | string>;
  monitor(key: MonitorAtOnce, value: boolean, what: string): InstantWrite<boolean>;
}

export const switchKey = {
  backend: (id: string) => `backend:${id}`,
  kind: (id: string) => `kind:${id}`,
  general: (key: string) => `general:${key}`,
  monitor: (key: string) => `monitor:${key}`,
};

function onOff(value: unknown): string {
  return value === true ? "on" : value === false ? "off" : String(value);
}

export function settingsWrites(rpc: { call: (...args: never[]) => Promise<unknown> }): SettingsWrites {
  const call = rpc.call as unknown as <T>(method: string, input?: unknown) => Promise<T>;
  const applyTo = (state: ConfigState, draft: ConfigDocument) => call<ApplyResult>("config.apply", { draft, revision: state.revision });
  return {
    backendOn(config, on, what) {
      const hostId = machineHostId(config);
      return {
        key: switchKey.backend(config.id),
        what,
        value: on,
        read: (state) => state.document.backends.find((backend) => backend.id === config.id)?.enabled ?? false,
        say: onOff,
        send: async (state) => {
          if (hostId) return (await call<{ result: ApplyResult }>("docker.host.set", { hostId, enabled: on })).result;
          const latest = state.document.backends.find((backend) => backend.id === config.id);
          if (!latest) return { ok: false, reason: "problems", problems: [{ path: `backends.${config.id}`, message: "It was removed elsewhere." }] };
          return applyTo(state, withBackend(state.document, { ...latest, enabled: on }));
        },
      };
    },
    kindOn(id, on, what) {
      return {
        key: switchKey.kind(id),
        what,
        value: on,
        read: (state) => effectiveKind(state, id).enabled,
        say: onOff,
        send: (state) => applyTo(state, withKind(state.document, id, kindChanges(state, id, { ...effectiveKind(state, id), enabled: on }))),
      };
    },
    general(key, value, what, say = onOff) {
      return {
        key: switchKey.general(key),
        what,
        value,
        read: (state) => ({ ...state.defaults.general, ...state.document.general })[key] as boolean | string,
        say,
        send: (state) => applyTo(state, withGeneral(state.document, { [key]: value === state.defaults.general[key] ? undefined : value })),
      };
    },
    monitor(key, value, what) {
      return {
        key: switchKey.monitor(key),
        what,
        value,
        read: (state) => ({ ...state.defaults.monitor, ...state.document.monitor })[key] as boolean,
        say: onOff,
        send: (state) => applyTo(state, withMonitor(state.document, { [key]: value === state.defaults.monitor[key] ? undefined : value })),
      };
    },
  };
}
