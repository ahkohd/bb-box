import { experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { Activity01Icon, ComputerIcon, Globe02Icon, Image01Icon, Settings01Icon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { BackendConfig } from "../core/document.ts";
import type { Contract } from "../plugin/contract.ts";
import type { KindInfoView } from "../plugin/configuration.ts";
import { Badge, StatusDot } from "./common.tsx";
import { effectiveKind } from "./config.ts";
import { DESKTOP_PAGE, MACHINES_TAB } from "./desktop.tsx";
import { FirstRun, SetupProgress } from "./first-run.tsx";
import { BoxGlyph } from "./glyphs.tsx";
import { switchKey, useSettings } from "./settings-context.tsx";
import { BOXES_PART, FILES_PART, MONITOR_PART } from "./settings-drafts.ts";
import { Card, Chevron, FOCUS_RING, Group, NavRow, ProviderGlyph, RowButton, RowControl, RowNote, Rows, SavedTick, StateLine } from "./settings-parts.tsx";
import { useRegistry } from "./settings-saving.tsx";
import {
  backendHealth,
  backendLabel,
  backendLine,
  hostChip,
  onBbMachine,
  KIND_GROUPS,
  kindAvailability,
  kindGroup,
  kindName,
  kindSummary,
  plural,
  sameCheckAge,
  statusItems,
  statusLine,
} from "./settings-status.ts";
import { backendPart } from "./settings-backend-fields.tsx";

const keptHere = new Set<string>();
let monitorChangedThisLoad = false;

export function forgetKindsKeptHere(): void {
  keptHere.clear();
}

export function noteMonitorChanged(): void {
  monitorChangedThisLoad = true;
}

export function monitorChanged(): boolean {
  return monitorChangedThisLoad;
}

export function Overview() {
  const { state } = useSettings();
  return (
    <div className="space-y-7">
      <h2 tabIndex={-1} data-page-heading className="sr-only">
        BB Box settings
      </h2>
      {state.document.backends.some((backend) => backend.enabled) ? <SetupProgress empty={false} /> : <FirstRun fallback={null} others={false} />}
      {state.document.backends.length ? <Status /> : null}
      <Backends />
      <Kinds />
      <Options />
    </div>
  );
}

function Status() {
  const { state, nav, refresh } = useSettings();
  const rpc = useRpc<Contract>();
  const [checking, setChecking] = useState(0);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const now = Date.now();
  const line = statusLine(state, now, checking);
  const items = statusItems(state, now);
  const checkAll = async () => {
    const on = state.document.backends.filter((backend) => backend.enabled);
    setChecking(on.length);
    setCheckNote(null);
    try {
      const results = await Promise.allSettled(on.map((backend) => rpc.call("config.check", { draft: state.document, test: backend.id })));
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed) setCheckNote(`${plural(failed, "check")} could not run. Try again.`);
      await refresh();
    } finally {
      setChecking(0);
    }
  };
  const anyOn = state.document.backends.some((backend) => backend.enabled);
  return (
    <section aria-label="Status" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-foreground" role="status" aria-live="polite">
          <StatusDot tone={items.length && !checking ? "warn" : line.tone} />
          <span>
            {line.headline}
            {line.details.length ? <span className="text-muted-foreground">{line.details.map((detail) => ` · ${detail}`).join("")}</span> : null}
          </span>
        </p>
        {anyOn ? (
          <Button type="button" variant={line.checkFirst ? "default" : "outline"} size="sm" className="h-7 shrink-0" disabled={checking > 0} onClick={() => void checkAll()}>
            {checking ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            {checking ? "Checking…" : "Check all"}
          </Button>
        ) : null}
      </div>
      <RowNote note={checkNote} className="px-1" />
      {items.length ? (
        <div className="rounded-lg border border-warning/40 bg-warning/5 px-4 py-3" role="region" aria-label="Things that need you">
          <p className="text-sm font-medium text-foreground">{items.length === 1 ? "1 thing needs you" : `${items.length} things need you`}</p>
          <ul className="mt-2 space-y-2.5">
            {items.map((item) => (
              <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                <StatusDot tone={item.tone} className="text-sm" />
                <div className="min-w-0 flex-1 text-xs leading-snug">
                  <p className="font-medium text-foreground">{item.title}</p>
                  {item.detail ? <p className="text-muted-foreground">{item.detail}</p> : null}
                  {item.fix ? <p className="mt-0.5 text-foreground">Fix: {item.fix}</p> : null}
                </div>
                <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" aria-label={`Open ${item.title}`} data-row-key={`status-${item.key}`} onClick={() => nav.go(item.open, `status-${item.key}`)}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function BackendRow({ config, showAge }: { config: BackendConfig; showAge: boolean }) {
  const { state, nav, instant, writes } = useSettings();
  const now = Date.now();
  const health = backendHealth(state, config, now);
  const label = backendLabel(state, config);
  const chip = hostChip(config, label, state.backends.find((candidate) => candidate.id === config.id)?.hosts);
  const key = switchKey.backend(config.id);
  const pending = instant.pendingValue<boolean>(key);
  const stateId = `settings-backend-state-${config.id.replace(/[^a-z0-9]/gi, "-")}`;
  const chipsId = `settings-backend-chips-${config.id.replace(/[^a-z0-9]/gi, "-")}`;
  const rowKey = `backend-${config.id}`;
  const note = instant.note(key);
  const draftChip = useDraftChip();
  return (
    <div className="transition-colors duration-150 hover:bg-state-hover">
      <div className="relative flex items-start gap-3 px-4 py-3">
        <RowButton rowKey={rowKey} label={label} describedBy={`${chipsId} ${stateId}`} onClick={() => nav.go({ page: "backend", id: config.id }, rowKey)} />
        <ProviderGlyph type={config.type} className="pointer-events-none mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="pointer-events-none min-w-0 truncate" aria-hidden>
              {label}
            </span>
            <span id={chipsId} className="pointer-events-none flex items-center gap-1.5 empty:hidden">
              {chip ? <Badge>{chip}</Badge> : null}
              {onBbMachine(config) ? <Badge>BB machine</Badge> : null}
              {draftChip([backendPart(config.id)])}
            </span>
          </span>
          <StateLine id={stateId} className="pointer-events-none mt-0.5" tone={health.tone} words={health.words} items={backendLine(state, config, health, now, showAge)} />
        </span>
        <span className="pointer-events-none self-center">
          <SavedTick show={instant.isSaved(key)} />
        </span>
        <span className="self-center">
          <RowControl>
            <Switch
              aria-label={`${label}: takes new boxes`}
              aria-describedby={stateId}
              checked={pending ?? config.enabled}
              aria-disabled={instant.pending !== null || undefined}
              onCheckedChange={(on) => void instant.run(writes.backendOn(state, config, on, label))}
            />
          </RowControl>
        </span>
        <span className="pointer-events-none self-center">
          <Chevron />
        </span>
      </div>
      <RowNote note={note} className="pb-3 pl-11 pr-4" />
    </div>
  );
}

function Backends() {
  const { state, nav } = useSettings();
  const now = Date.now();
  const healths = state.document.backends.filter((backend) => backend.enabled).map((backend) => backendHealth(state, backend, now));
  const showAge = !sameCheckAge(healths);
  const addBackend = (
    <Button type="button" variant="outline" size="sm" className="h-7" data-row-key="add-backend" onClick={() => nav.go({ page: "add" }, "add-backend")}>
      <Icon name="Plus" aria-hidden />
      Add backend
    </Button>
  );
  return (
    <Group title="Backends" description="Where boxes run. Off, a backend takes no new boxes; its boxes keep working." action={addBackend}>
      {state.document.backends.length ? (
        <Card>
          <Rows>
            {state.document.backends.map((config) => (
              <BackendRow key={config.id} config={config} showAge={showAge} />
            ))}
          </Rows>
        </Card>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-subtle-foreground">No backend yet. Add backend lists every kind of place boxes can run, and Docker on your BB machines.</p>
      )}
    </Group>
  );
}

function KindRow({ info }: { info: KindInfoView }) {
  const { state, nav, instant, writes } = useSettings();
  const key = switchKey.kind(info.id);
  const pending = instant.pendingValue<boolean>(key);
  const enabled = pending ?? effectiveKind(state, info.id).enabled;
  const general = { ...state.defaults.general, ...state.document.general };
  const isDefault = general.defaultKind === info.id;
  const name = kindName(state.kinds, info);
  const availability = kindAvailability(state, info.id);
  const summaryId = `settings-kind-summary-${info.id}`;
  const defaultId = `settings-kind-default-${info.id}`;
  const rowKey = `kind-${info.id}`;
  const note = instant.note(key);
  const twinBadge = name !== info.label ? (info.gpu ? "GPU" : "CPU") : null;
  return (
    <div className={cn("transition-colors duration-150 hover:bg-state-hover", !enabled && "opacity-70")}>
      <div className="relative flex items-center gap-3 px-4 py-2.5">
        <RowButton rowKey={rowKey} label={name} describedBy={summaryId} onClick={() => nav.go({ page: "kind", id: info.id }, rowKey)} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-sm text-foreground">
            <span className="pointer-events-none" aria-hidden>
              {info.label}
            </span>
            {twinBadge ? <Badge>{twinBadge}</Badge> : null}
            {isDefault ? <Badge>Default</Badge> : null}
          </span>
          <span id={summaryId} className={cn("pointer-events-none min-w-0 flex-1 truncate text-xs sm:text-right", availability === "lost" ? "text-warning-text" : "text-muted-foreground")}>
            {kindSummary(state, info)}
          </span>
        </span>
        <span className="pointer-events-none">
          <SavedTick show={instant.isSaved(key)} />
        </span>
        {isDefault && enabled ? <span id={defaultId} className="sr-only">The default kind stays on. Choose another default on the Boxes page to turn it off.</span> : null}
        <RowControl>
          <Switch
            aria-label={`${name}: offered to threads`}
            aria-describedby={isDefault && enabled ? `${summaryId} ${defaultId}` : summaryId}
            title={isDefault && enabled ? "The default kind stays on. Choose another default on the Boxes page to turn it off." : undefined}
            checked={enabled}
            disabled={isDefault && enabled}
            aria-disabled={instant.pending !== null || undefined}
            onCheckedChange={(on) => {
              keptHere.add(info.id);
              void instant.run(writes.kindOn(state, info.id, on, name));
            }}
          />
        </RowControl>
        <span className="pointer-events-none">
          <Chevron />
        </span>
      </div>
      <RowNote note={note} className="px-4 pb-2" />
    </div>
  );
}

function Kinds() {
  const { state, nav } = useSettings();
  const [showFolded, setShowFolded] = useState(false);
  const general = { ...state.defaults.general, ...state.document.general };
  const shown = (info: KindInfoView) => keptHere.has(info.id) || kindAvailability(state, info.id) === "offered" || kindAvailability(state, info.id) === "lost";
  const folded = state.kinds.filter((info) => !shown(info));
  const off = folded.filter((info) => kindAvailability(state, info.id) === "off").length;
  const none = folded.length - off;
  const defaultInfo = state.kinds.find((kind) => kind.id === general.defaultKind);
  const changeDefault = (
    <button type="button" data-row-key="change-default" className="cursor-pointer rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => nav.go({ page: "option", id: "boxes" }, "change-default")}>
      Change the default
    </button>
  );
  const listed = KIND_GROUPS.flatMap((group) => state.kinds.filter((info) => kindGroup(info) === group && (shown(info) || showFolded)));
  return (
    <Group title="Kinds" description={defaultInfo ? `What a thread can ask for. ${kindName(state.kinds, defaultInfo)} is the default.` : "What a thread can ask for."} action={changeDefault}>
      <Card>
        {listed.length ? (
          <Rows>
            {listed.map((info) => (
              <KindRow key={info.id} info={info} />
            ))}
          </Rows>
        ) : null}
        {folded.length ? (
          <button type="button" aria-expanded={showFolded} onClick={() => setShowFolded((current) => !current)} className={cn("flex w-full cursor-pointer items-center gap-1.5 border-t border-border px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS_RING)}>
            <Icon name={showFolded ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
            {showFolded ? "Hide them" : [off ? `${plural(off, "kind")} off` : "", none ? `${plural(none, "kind")} no backend you have makes` : ""].filter(Boolean).join(" · ")}
          </button>
        ) : null}
      </Card>
    </Group>
  );
}

function OptionIcon({ icon }: { icon: Parameters<typeof HugeiconsIcon>[0]["icon"] }) {
  return <HugeiconsIcon icon={icon} className="size-4" aria-hidden="true" />;
}

const IOS_ENCODER_WORDS: Readonly<Record<string, string>> = { auto: "automatic", hardware: "hardware only", software: "software only" };

export function iosEncoderWords(value: string): string {
  return IOS_ENCODER_WORDS[value] ?? value;
}

function Options() {
  const { state, nav, instant, writes } = useSettings();
  const navigate = useBbNavigate();
  const draftChip = useDraftChip();
  const unsavedChip = (option: string) => draftChip(OPTION_PARTS[option] ?? []);
  const general = { ...state.defaults.general, ...state.document.general };
  const monitor = { ...state.defaults.monitor, ...state.document.monitor };
  const defaultInfo = state.kinds.find((kind) => kind.id === general.defaultKind);
  const files = state.document.general.files?.length ?? 0;
  const projectImages = Object.keys(state.document.images ?? {}).length;
  const monitorKey = switchKey.monitor("enabled");
  const monitorPending = instant.pendingValue<boolean>(monitorKey);
  const monitorOn = monitorPending ?? monitor.enabled;
  const go = (id: string) => nav.go({ page: "option", id }, `option-${id}`);
  const rows: { id: string; icon: ReactNode; title: string; value: string }[] = [
    { id: "boxes", icon: <BoxGlyph />, title: "Boxes", value: [`${defaultInfo ? kindName(state.kinds, defaultInfo) : general.defaultKind} by default`, general.boxesPerThread ? `${general.boxesPerThread} per thread` : "no limit per thread", plural(files, "file")].join(" · ") },
    { id: "images", icon: <OptionIcon icon={Image01Icon} />, title: "Images", value: [general.nightlyImages ? "Rebuilt each night" : "Not rebuilt on a schedule", ...(projectImages ? [plural(projectImages, "project image")] : [])].join(" · ") },
    { id: "devices", icon: <OptionIcon icon={SmartPhone01Icon} />, title: "Devices", value: `iOS video: ${iosEncoderWords(general.iosEncoder)}` },
    { id: "network", icon: <OptionIcon icon={Globe02Icon} />, title: "Network", value: general.tailnet?.mode === "oauth" ? "Machines join your tailnet" : "No tailnet" },
  ];
  return (
    <Group title="Options">
      <Card>
        <Rows>
          {rows.map((row) => (
            <NavRow key={row.id} rowKey={`option-${row.id}`} valueId={`settings-option-${row.id}`} icon={row.icon} title={row.title} chips={unsavedChip(row.id)} value={row.value} onClick={() => go(row.id)} />
          ))}
          <div>
            <NavRow
              rowKey="option-monitor"
              valueId="settings-option-monitor"
              icon={<OptionIcon icon={Activity01Icon} />}
              title="Monitor"
              chips={unsavedChip("monitor")}
              value={monitorOn ? `In the sidebar · every ${monitor.refreshIntervalSeconds} s` : "Off"}
              onClick={() => go("monitor")}
              saved={<SavedTick show={instant.isSaved(monitorKey)} />}
              control={
                <Switch
                  aria-label="Monitor: machine status in BB's sidebar"
                  aria-describedby="settings-option-monitor"
                  checked={monitorOn}
                  aria-disabled={instant.pending !== null || undefined}
                  onCheckedChange={(enabled) =>
                    void instant.run(writes.monitor(state, "enabled", enabled, "The Monitor")).then((outcome) => {
                      if (outcome?.kind === "saved") noteMonitorChanged();
                    })
                  }
                />
              }
            />
            <RowNote note={instant.note(monitorKey)} className="px-4 pb-2" />
          </div>
          <NavRow rowKey="option-configuration" valueId="settings-option-configuration" icon={<OptionIcon icon={Settings01Icon} />} title="Configuration" value={`Revision ${state.revision}`} onClick={() => go("configuration")} />
          <NavRow rowKey="machines" valueId="settings-option-machines" icon={<OptionIcon icon={ComputerIcon} />} title="Your machines" value="On the Boxes page, Machines tab" outward onClick={() => navigate.toPluginPanel(DESKTOP_PAGE, { subPath: MACHINES_TAB })} />
        </Rows>
      </Card>
      {monitorChanged() ? <ReloadNote /> : null}
    </Group>
  );
}

const OPTION_PARTS: Readonly<Record<string, readonly string[]>> = { boxes: [BOXES_PART, FILES_PART], monitor: [MONITOR_PART] };

function useDraftChip(): (parts: readonly string[]) => ReactNode {
  const registry = useRegistry();
  return (parts) => {
    if (parts.some((part) => registry.saving(part))) return <Badge>Saving…</Badge>;
    return parts.some((part) => registry.hasChanges(part)) ? <Badge tone="warn">Unsaved changes</Badge> : null;
  };
}

export function ReloadNote() {
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
      The sidebar's machine status changes when BB next loads.
      <button type="button" className="cursor-pointer rounded-sm text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => window.location.reload()}>
        Reload BB now
      </button>
    </p>
  );
}
