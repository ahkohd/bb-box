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
import { DESKTOP_PAGE, MACHINES_TAB } from "./desktop.tsx";
import { SetupProgress } from "./first-run.tsx";
import { FirstRunSection, JustReady, useHereHostId } from "./settings-first-run.tsx";
import { BoxGlyph } from "./glyphs.tsx";
import { switchKey, useSettings } from "./settings-context.tsx";
import { BOXES_PART, FILES_PART, MONITOR_PART, NETWORK_PART } from "./settings-drafts.ts";
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
import { failedImagesWords, imageStatusItems, useImagesProgress } from "./settings-images.tsx";
import { DEFAULT_STAYS_ON, KindSwitch, keptInPlace, kindPart, useKindSwitch } from "./settings-kinds.tsx";
import { MachineBuildLine, MachinesLine, useMachineHosts, type Machines } from "./settings-docker-hosts.tsx";
import { machineIdOf, machineOf } from "./settings-machine-docker.ts";

let monitorChangedThisLoad = false;

export function noteMonitorChanged(): void {
  monitorChangedThisLoad = true;
}

export function monitorChanged(): boolean {
  return monitorChangedThisLoad;
}

export function Overview() {
  const { state } = useSettings();
  const machines = useMachineHosts();
  const [later, setLater] = useState(false);
  const setUp = state.setupDone !== null;
  return (
    <div className="space-y-7">
      <h2 tabIndex={-1} data-page-heading className="sr-only">
        BB Box settings
      </h2>
      {setUp ? (
        <>
          <SetupProgress empty={false} />
          <JustReady />
          {state.document.backends.length ? <Status machines={machines} /> : null}
        </>
      ) : (
        <FirstRunSection machines={machines} />
      )}
      {setUp || state.document.backends.length ? <Backends machines={machines} /> : null}
      {setUp || later ? (
        <>
          <Kinds />
          <Options />
        </>
      ) : (
        <button type="button" data-row-key="first-run-later" aria-expanded={false} onClick={() => setLater(true)} className={cn("flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-left text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS_RING)}>
          <Icon name="ChevronRight" className="size-3.5" aria-hidden />
          Sizes and options: kinds, images, devices, network, Monitor and the configuration file, for later
        </button>
      )}
    </div>
  );
}

function Status({ machines }: { machines: Machines }) {
  const { state, nav, refresh } = useSettings();
  const rpc = useRpc<Contract>();
  const [checking, setChecking] = useState(0);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const now = Date.now();
  const line = statusLine(state, now, checking, machines.hosts, useHereHostId());
  const images = useImagesProgress();
  const items = [...statusItems(state, now, machines.hosts), ...imageStatusItems(state, images, now)];
  const checkAll = async () => {
    const on = state.document.backends.filter((backend) => backend.enabled);
    setChecking(on.length);
    setCheckNote(null);
    try {
      const inUse = on.map(machineIdOf).filter((hostId): hostId is string => hostId !== null);
      const [results] = await Promise.all([Promise.allSettled(on.map((backend) => rpc.call("config.check", { draft: state.document, test: backend.id }))), inUse.length ? machines.recheck(inUse) : null]);
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
                {item.showSwitch ? (
                  <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" aria-label="Show the backends' switches" data-row-key={`status-${item.key}`} onClick={() => showBackendSwitch(item.showSwitch!)}>
                    Show
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" aria-label={`Open ${item.title}`} data-row-key={`status-${item.key}`} onClick={() => nav.go(item.open, `status-${item.key}`)}>
                    Open
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function showBackendSwitch(id: string): void {
  const toggle = document.querySelector<HTMLElement>(`[data-backend-switch="${CSS.escape(id)}"]`);
  toggle?.scrollIntoView?.({ block: "center" });
  toggle?.focus({ preventScroll: true });
}

function BackendRow({ config, showAge, machines }: { config: BackendConfig; showAge: boolean; machines: Machines }) {
  const { state, nav, instant, writes } = useSettings();
  const now = Date.now();
  const health = backendHealth(state, config, now, machines.hosts);
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
          {config.enabled ? <MachineBuildLine host={machineOf(machines.hosts, config)} className="pointer-events-none mt-0.5" /> : null}
        </span>
        <span className="pointer-events-none self-center">
          <SavedTick show={instant.isSaved(key)} />
        </span>
        <span className="self-center">
          <RowControl>
            <Switch
              aria-label={`${label}: takes new boxes`}
              data-backend-switch={config.id}
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

function Backends({ machines }: { machines: Machines }) {
  const { state, nav } = useSettings();
  const now = Date.now();
  const healths = state.document.backends.filter((backend) => backend.enabled).map((backend) => backendHealth(state, backend, now, machines.hosts));
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
              <BackendRow key={config.id} config={config} showAge={showAge} machines={machines} />
            ))}
          </Rows>
        </Card>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-subtle-foreground">No backend yet. Add backend lists every kind of place boxes can run, and Docker on your BB machines.</p>
      )}
      <MachinesLine machines={machines} />
    </Group>
  );
}

function KindRow({ info }: { info: KindInfoView }) {
  const { state, nav, instant } = useSettings();
  const kind = useKindSwitch(info);
  const draftChip = useDraftChip();
  const availability = kindAvailability(state, info.id);
  const summaryId = `settings-kind-summary-${info.id}`;
  const defaultId = `settings-kind-default-${info.id}`;
  const rowKey = `kind-${info.id}`;
  const twinBadge = kind.name !== info.label ? (info.gpu ? "GPU" : "CPU") : null;
  return (
    <div className={cn("transition-colors duration-150 hover:bg-state-hover", !kind.enabled && "opacity-70")}>
      <div className="relative flex items-center gap-3 px-4 py-2.5">
        <RowButton rowKey={rowKey} label={kind.name} describedBy={summaryId} onClick={() => nav.go({ page: "kind", id: info.id }, rowKey)} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-sm text-foreground">
            <span className="pointer-events-none" aria-hidden>
              {info.label}
            </span>
            {twinBadge ? <Badge>{twinBadge}</Badge> : null}
            {kind.isDefault ? <Badge>Default</Badge> : null}
            {draftChip([kindPart(info.id)])}
          </span>
          <span id={summaryId} className={cn("pointer-events-none min-w-0 flex-1 truncate text-xs sm:text-right", availability === "lost" ? "text-warning-text" : "text-muted-foreground")}>
            {kindSummary(state, info)}
          </span>
        </span>
        <span className="pointer-events-none">
          <SavedTick show={instant.isSaved(kind.key)} />
        </span>
        {kind.locked ? (
          <span id={defaultId} className="sr-only">
            {DEFAULT_STAYS_ON}
          </span>
        ) : null}
        <RowControl>
          <KindSwitch info={info} describedBy={kind.locked ? `${summaryId} ${defaultId}` : summaryId} />
        </RowControl>
        <span className="pointer-events-none">
          <Chevron />
        </span>
      </div>
      <RowNote note={instant.note(kind.key)} className="px-4 pb-2" />
    </div>
  );
}

function Kinds() {
  const { state, nav } = useSettings();
  const [showFolded, setShowFolded] = useState(false);
  const general = { ...state.defaults.general, ...state.document.general };
  const shown = (info: KindInfoView) => keptInPlace(info.id) || kindAvailability(state, info.id) === "offered" || kindAvailability(state, info.id) === "lost";
  const folded = state.kinds.filter((info) => !shown(info));
  const off = folded.filter((info) => kindAvailability(state, info.id) === "off").length;
  const none = folded.length - off;
  const defaultInfo = state.kinds.find((kind) => kind.id === general.defaultKind);
  const changeDefault = (
    <button type="button" data-row-key="change-default" className="cursor-pointer rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => nav.go({ page: "option", id: "boxes" }, "change-default", "general/defaultKind")}>
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
  const failedImages = failedImagesWords(useImagesProgress());
  const monitorKey = switchKey.monitor("enabled");
  const monitorPending = instant.pendingValue<boolean>(monitorKey);
  const monitorOn = monitorPending ?? monitor.enabled;
  const go = (id: string) => nav.go({ page: "option", id }, `option-${id}`);
  const rows: { id: string; icon: ReactNode; title: string; value: string; tone?: "warn" }[] = [
    { id: "boxes", icon: <BoxGlyph />, title: "Boxes", value: [`${defaultInfo ? kindName(state.kinds, defaultInfo) : general.defaultKind} by default`, general.boxesPerThread ? `${general.boxesPerThread} per thread` : "no limit per thread", plural(files, "file")].join(" · ") },
    { id: "images", icon: <OptionIcon icon={Image01Icon} />, title: "Images", value: [general.nightlyImages ? "Rebuilt each night" : "Not rebuilt on a schedule", ...(failedImages ? [failedImages] : []), ...(projectImages ? [plural(projectImages, "project image")] : [])].join(" · "), ...(failedImages ? { tone: "warn" as const } : {}) },
    { id: "devices", icon: <OptionIcon icon={SmartPhone01Icon} />, title: "Devices", value: `iOS video: ${iosEncoderWords(general.iosEncoder)}` },
    { id: "network", icon: <OptionIcon icon={Globe02Icon} />, title: "Network", value: general.tailnet?.mode === "oauth" ? "Machines join your tailnet" : "No tailnet" },
  ];
  return (
    <Group title="Options">
      <Card>
        <Rows>
          {rows.map((row) => (
            <NavRow key={row.id} rowKey={`option-${row.id}`} valueId={`settings-option-${row.id}`} icon={row.icon} title={row.title} chips={unsavedChip(row.id)} value={row.value} tone={row.tone} onClick={() => go(row.id)} />
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

const OPTION_PARTS: Readonly<Record<string, readonly string[]>> = { boxes: [BOXES_PART, FILES_PART], network: [NETWORK_PART], monitor: [MONITOR_PART] };

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
