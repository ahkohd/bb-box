import { forwardRef } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { BoxForm, WarmShortfall } from "../backends/types.ts";
import type { BackendConfig } from "../core/document.ts";
import type { ConfigState, DriverView, KindInfoView } from "../plugin/configuration.ts";
import type { Tone } from "./common.tsx";
import { effectiveKind } from "./config.ts";
import { switchKey, useSettings } from "./settings-context.tsx";
import { kindPath } from "./settings-paths.ts";
import { backendHealth, backendLabel, hostChip, kindName, onBbMachine } from "./settings-status.ts";

export function kindPart(id: string): string {
  return `kind/${id}`;
}

export const DEFAULT_STAYS_ON = "The default kind stays on. Choose another default to turn it off.";

const turnedThisVisit = new Set<string>();

export function keepKindInPlace(id: string): void {
  turnedThisVisit.add(id);
}

export function keptInPlace(id: string): boolean {
  return turnedThisVisit.has(id);
}

export function forgetKindsKeptInPlace(): void {
  turnedThisVisit.clear();
}

export function useKindSwitch(info: KindInfoView) {
  const { state, instant, writes } = useSettings();
  const key = switchKey.kind(info.id);
  const general = { ...state.defaults.general, ...state.document.general };
  const isDefault = (instant.pendingValue<string>(switchKey.general("defaultKind")) ?? general.defaultKind) === info.id;
  const enabled = instant.pendingValue<boolean>(key) ?? effectiveKind(state, info.id).enabled;
  const name = kindName(state.kinds, info);
  const turn = (on: boolean) => {
    keepKindInPlace(info.id);
    return instant.run(writes.kindOn(state, info.id, on, name));
  };
  return { key, isDefault, enabled, locked: isDefault && enabled, name, turn };
}

export const KindSwitch = forwardRef<HTMLButtonElement, { info: KindInfoView; describedBy?: string }>(function KindSwitch({ info, describedBy }, ref) {
  const { instant } = useSettings();
  const kind = useKindSwitch(info);
  return (
    <Switch
      ref={ref}
      data-draft-path={kindPath(info.id, "enabled")}
      aria-label={`${kind.name}: offered to threads`}
      aria-describedby={describedBy}
      aria-disabled={kind.locked || instant.pending !== null || undefined}
      title={kind.locked ? DEFAULT_STAYS_ON : undefined}
      className={cn(kind.locked && "cursor-not-allowed opacity-50")}
      checked={kind.enabled}
      onClick={(event) => {
        if (kind.locked) event.preventDefault();
      }}
      onCheckedChange={(on) => void kind.turn(on)}
    />
  );
});

export type MakesIt = "makes" | "off" | "left-out" | "cannot";

export type NoWarmReason = "shared-ios-hosts" | "made-when-asked";

export interface RunsOn {
  readonly config: BackendConfig;
  readonly label: string;
  readonly chip: string | null;
  readonly bbMachine: boolean;
  readonly form: BoxForm | null;
  readonly makes: MakesIt;
  readonly problem: string | null;
  readonly keepsWarm: boolean;
  readonly noWarm: NoWarmReason | null;
  readonly sharedIosField: string | null;
  readonly short: WarmShortfall | null;
}

function makesIt(state: ConfigState, config: BackendConfig, kind: string): { readonly makes: MakesIt; readonly problem: string | null } {
  if (!config.enabled) return { makes: "off", problem: null };
  const live = state.backends.find((each) => each.id === config.id);
  if (live?.state === "active" && live.kinds.includes(kind)) return { makes: "makes", problem: null };
  const health = backendHealth(state, config, Date.now());
  if (live?.state === "active" && health.tone !== "bad") return { makes: "left-out", problem: null };
  return { makes: "cannot", problem: health.detail ?? health.words };
}

export function sharedIosFieldOf(driver: DriverView | undefined): string | null {
  const fields = driver?.fields.filter((field) => field.group === "ios-hosts") ?? [];
  return (fields.find((field) => field.key.endsWith("ios-hosts-ahead")) ?? fields[0])?.key ?? null;
}

export function runsOn(state: ConfigState, info: KindInfoView): RunsOn[] {
  return state.document.backends
    .filter((config) => info.drivers.includes(config.type) || state.backends.some((live) => live.id === config.id && live.kinds.includes(info.id)))
    .map((config) => {
      const driver = state.drivers.find((each) => each.type === config.type);
      const keepsWarm = driver?.warmKinds.includes(info.id) ?? false;
      const sharedIosField = info.device === "ios" ? sharedIosFieldOf(driver) : null;
      const label = backendLabel(state, config);
      return {
        config,
        label,
        chip: hostChip(config, label, state.backends.find((each) => each.id === config.id)?.hosts),
        bbMachine: onBbMachine(config),
        form: state.backends.find((each) => each.id === config.id)?.form ?? null,
        ...makesIt(state, config, info.id),
        keepsWarm,
        noWarm: keepsWarm ? null : sharedIosField ? "shared-ios-hosts" : "made-when-asked",
        sharedIosField,
        short: state.backends.find((each) => each.id === config.id)?.warmShort.find((pool) => pool.kinds.includes(info.id)) ?? null,
      };
    });
}

export const MAKES_WORDS: Readonly<Record<MakesIt, string>> = {
  makes: "Makes it now",
  off: "Off",
  "left-out": "Set up not to make it",
  cannot: "Cannot make it now",
};

export const MAKES_TONES: Readonly<Record<MakesIt, Tone>> = { makes: "ok", off: "off", "left-out": "off", cannot: "warn" };

export const NO_WARM_WORDS: Readonly<Record<NoWarmReason, string>> = {
  "shared-ios-hosts": "No warm boxes: its shared iOS hosts keep slots ready instead.",
  "made-when-asked": "No warm boxes of this kind: it makes each box when a thread asks.",
};

/** A kind's spares in its status line (032): "2 spares ready", "1 of 2 spares ready" or "2 spares, being made". */
export function sparesWords(target: number, now: { readonly ready: number; readonly making: number }): string[] {
  if (target <= 0) return [];
  const spares = `${target} ${target === 1 ? "spare" : "spares"}`;
  if (now.ready >= target) return [`${spares} ready`];
  if (now.ready > 0) return [`${now.ready} of ${spares} ready`];
  return now.making > 0 ? [`${spares}, being made`] : [];
}
