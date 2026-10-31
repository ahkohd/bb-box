import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, useRealtime, useRpc, type ExperimentalSidebarFooterDisclosureProps, type PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { Contract, Machine, MonitorSnapshot, ThreadOnBox } from "../../plugin/contract.ts";
import { STALL_LIMITS } from "../../monitor/health.ts";
import { SERVER_MACHINE, useMonitorSnapshot } from "./use-snapshot.ts";
import { useRevealOnLoad } from "./use-reveal-on-load.ts";
import { machineKey, useMachines } from "./use-machines.ts";
import { useBoxLookOf, useOpensOf, type BoxScreens, type LookOf, type MachineOpens } from "./box-screens.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./menu.tsx";
import { ThreadItems, ThreadsOnMachine } from "./box-threads.tsx";
import { cn } from "@/lib/utils";
import { PressureNotifications, bindStatusOpener } from "./pressure-notifications.tsx";
import { MachinePicker, selectedMachine } from "./machine-picker.tsx";
import { loadErrorCopy } from "./load-error-copy.ts";
import { LoadingTailscaleRows, TailscaleRows, tailscaleRowCount } from "./tailscale-section.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowDataTransferVerticalIcon, BatteryChargingIcon, BatteryFullIcon, Clock01Icon, CloudOffIcon, CpuIcon, GpuIcon, HardDriveIcon, RamMemoryIcon, ServerIcon } from "@hugeicons/core-free-icons";
import { BarChart, BigValue, DetailRow, Footnote, LineChart, LoadingText, METRIC_COLORS, MetricSection, Pill, ProgressBar } from "./metric-parts.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { HudScrollProvider, HudTooltip, HudTooltipContent, HudTooltipTrigger } from "./hud-tooltip.tsx";
import { hasGpuReadings, readPanelShape, rememberPanelShape, type PanelShape } from "./panel-shape.ts";

const GREEN = "#22c55e";
const AMBER = "#eab308";
const RED = "#ef4444";
const SECTION = "min-w-0 space-y-2 p-3";
const HISTORY_BARS = 24;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const value = bytes / 1024 ** index;
  const precision = index < 2 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(precision))} ${units[index]}`;
}

function Sampling() {
  return <span className="inline-block min-w-10 text-right" aria-label="Sampling" title="Waiting for a second sample">–</span>;
}

function formatRate(bytes: number | null): ReactNode {
  return bytes === null ? <Sampling /> : `${formatBytes(bytes)}/s`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatClockTime(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function formatUpdatedAt(value: string): string {
  const time = formatClockTime(value);
  return time ? `Updated at ${time}` : "Updated recently";
}


function colorForPercent(value: number | null): string {
  if (value !== null && value >= 95) return RED;
  if (value !== null && value >= 75) return AMBER;
  return GREEN;
}



function Section({ label, value, children, ariaLabel }: { label: ReactNode; value?: ReactNode; children?: ReactNode; ariaLabel?: string }) {
  return (
    <section className={SECTION} aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-sidebar-foreground">{label}</span>
        {value === undefined ? null : <span className="shrink-0 tabular-nums text-sidebar-foreground">{value}</span>}
      </div>
      {children}
    </section>
  );
}


const HEADER_BUTTON_CLASS = "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50";

function HeaderButton({ label, tooltip, onClick, disabled, busy, children }: { label: string; tooltip: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean; children: ReactNode }) {
  return (
    <Tooltip delayDuration={350} disableHoverableContent>
      <TooltipTrigger asChild>
        <button type="button" className={HEADER_BUTTON_CLASS} aria-label={label} aria-busy={busy} disabled={disabled} onClick={onClick}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function openTooltip(machineName: string, listsThreads: boolean): string {
  return listsThreads ? `Views and threads of ${machineName}` : `Open a view of ${machineName}`;
}

function threadsOnWords(machineName: string): string {
  return `Threads on ${machineName}`;
}

function HeaderOpenMenu({ opens }: { opens: MachineOpens | null }) {
  if (!opens) return null;
  return <ThreadsOnMachine machine={opens}>{(threads) => <OpenMenu opens={opens} threads={threads} />}</ThreadsOnMachine>;
}

function OpenMenu({ opens, threads }: { opens: MachineOpens; threads: readonly ThreadOnBox[] }) {
  if (!opens.box && !threads.length) return null;
  const name = opens.box ? "Open" : threadsOnWords(opens.machineName);
  const tooltip = opens.box ? openTooltip(opens.machineName, threads.length > 0) : threadsOnWords(opens.machineName);
  return (
    <Menu>
      <Tooltip delayDuration={350} disableHoverableContent>
        <TooltipTrigger asChild>
          <MenuTrigger className={cn(HEADER_BUTTON_CLASS, "-ml-1 shrink-0 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground")} aria-label={name}>
            <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
          </MenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
      <MenuContent side="bottom" className="max-w-64">
        {opens.box ? <BoxViewItems box={opens.box} /> : null}
        <ThreadItems machine={opens} threads={threads} />
      </MenuContent>
    </Menu>
  );
}

function BoxViewItems({ box }: { box: BoxScreens }) {
  return (
    <>
      <MenuItem onSelect={box.openOnBoxesPage}>
        <span className="flex h-4 shrink-0 items-center text-muted-foreground">
          <Icon name="Info" className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0">Open details</span>
      </MenuItem>
      {box.actions.map((action) => (
        <MenuItem key={action.key} disabled={action.closedBecause !== null} onSelect={action.open}>
          <span className={cn("flex h-4 shrink-0 items-center text-muted-foreground", action.closedBecause && "opacity-50")}>{action.glyph("size-3.5")}</span>
          <span className="min-w-0">
            <span className={cn("block", action.closedBecause && "text-muted-foreground")}>{action.words}</span>
            {action.closedBecause ? <span className="block text-muted-foreground">{action.closedBecause}</span> : null}
          </span>
        </MenuItem>
      ))}
    </>
  );
}

function ReloadButton({ onReload, reloading, loading, updatedAt }: { onReload: () => void; reloading: boolean; loading: boolean; updatedAt: string | null }) {
  return (
    <HeaderButton
      label="Reload machine status"
      tooltip={reloading ? "Reloading" : loading ? "Loading" : updatedAt ? `${formatUpdatedAt(updatedAt)} · Reload` : "Reload"}
      onClick={onReload}
      disabled={reloading || loading}
      busy={reloading || loading}
    >
      <Icon
        name={reloading ? "Loading" : "RotateCcw"}
        className={reloading ? "size-3.5 animate-spin motion-reduce:animate-none" : "size-3.5"}
        aria-hidden
      />
    </HeaderButton>
  );
}

function CollapseButton({ onCollapse }: { onCollapse: () => void }) {
  return (
    <HeaderButton label="Hide machine status" tooltip="Hide" onClick={onCollapse}>
      <Icon name="ChevronDown" className="size-4" aria-hidden />
    </HeaderButton>
  );
}

const SECTION_ICON_CLASS = "size-3.5 opacity-90";

function SectionIcon({ icon, color }: { icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; color: string }) {
  return <HugeiconsIcon icon={icon} className={SECTION_ICON_CLASS} style={{ color }} aria-hidden="true" />;
}

function temperatureTone(celsius: number): "neutral" | "warn" | "bad" {
  if (celsius >= 95) return "bad";
  return celsius >= 80 ? "warn" : "neutral";
}

function TemperaturePill({ celsius }: { celsius: number }) {
  return <Pill tone={temperatureTone(celsius)}>{Math.round(celsius)}°C</Pill>;
}

function formatWatts(watts: number | null | undefined): string | null {
  if (watts === null || watts === undefined) return null;
  if (watts < 0.1) return "<0.1W";
  return `${watts < 10 ? watts.toFixed(1) : Math.round(watts)}W`;
}

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function joinParts(parts: Array<string | null | false | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function bytesParts(bytes: number): { value: string; unit: string } {
  const [value, unit] = formatBytes(bytes).split(" ");
  return { value: value ?? "0", unit: unit ?? "B" };
}

function cpuState(percent: number | null): string | null {
  if (percent === null) return null;
  if (percent < 25) return "idle";
  if (percent < 75) return "normal";
  return "busy";
}

function memoryPressure(percent: number): { label: string; tone: "neutral" | "warn" | "bad" } {
  if (percent >= 95) return { label: "Critical", tone: "bad" };
  if (percent >= 85) return { label: "High", tone: "warn" };
  return { label: "Normal", tone: "neutral" };
}

const PLATFORM_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

const HEALTH_LABELS = {
  healthy: { label: "Healthy", tone: "good", color: METRIC_COLORS.good },
  warning: { label: "Warning", tone: "warn", color: METRIC_COLORS.warn },
  critical: { label: "Critical", tone: "bad", color: METRIC_COLORS.bad },
} as const;

export function upWords(snapshot: MonitorSnapshot, isBox: boolean): string {
  const up = formatDuration(snapshot.host.uptimeSeconds);
  if (!isBox) return `up ${up}`;
  return snapshot.slot || snapshot.host.container ? `host up ${up}` : `system up ${up}`;
}

function SummaryStrip({ snapshot, isServer, isBox, waitingFor }: { snapshot: MonitorSnapshot | null; isServer: boolean; isBox: boolean; waitingFor: string | null }) {
  if (!snapshot) {
    return (
      <div className="relative flex flex-wrap items-center gap-1 px-3 py-2">
        {["● Healthy", "macOS · arm64", "16 GB", "8 cores", "up 1d 2h", ...(isServer ? ["bb up 1h 2m"] : [])].map((sample) => <Pill key={sample} loading>{sample}</Pill>)}
        {waitingFor ? (
          <div role="status" className="absolute inset-0 flex items-center justify-center px-3">
            <span className="flex items-center gap-1.5 rounded-md bg-sidebar px-2 py-1 text-xs text-subtle-foreground">
              <HugeiconsIcon icon={Clock01Icon} className="size-3.5 shrink-0" aria-hidden="true" />
              Still waiting for {waitingFor}
            </span>
          </div>
        ) : null}
      </div>
    );
  }
  const { host, memory, cpu, health, runtime } = snapshot;
  const status = HEALTH_LABELS[health.status];
  const healthPill = (
    <Pill tone={status.tone === "good" ? "neutral" : status.tone}>
      <span className="size-1.5 rounded-full" style={{ backgroundColor: status.color }} />
      {status.label}
    </Pill>
  );
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2">
      {health.issues.length > 0 ? (
        <HudTooltip delayDuration={300}>
          <HudTooltipTrigger asChild><span tabIndex={0} className="inline-flex outline-none">{healthPill}</span></HudTooltipTrigger>
          <HudTooltipContent side="right" align="start" className="max-w-64 space-y-1 text-xs">
            {health.issues.map((issue) => <p key={issue.label}>{issue.message}</p>)}
          </HudTooltipContent>
        </HudTooltip>
      ) : healthPill}
      <Pill>{PLATFORM_NAMES[host.platform] ?? host.platform} · {host.arch}</Pill>
      <Pill>{formatBytes(memory.totalBytes)}</Pill>
      <Pill>{cpu.cores} cores</Pill>
      <Pill>{upWords(snapshot, isBox)}</Pill>
      {isServer && runtime ? <Pill>bb up {formatDuration(runtime.processUptimeSeconds)}</Pill> : null}
      {snapshot.slot ? <SlotPills slot={snapshot.slot} /> : null}
    </div>
  );
}

function stallText(stall: readonly [number, number, number]): string {
  return stall.map((value) => `${value.toFixed(1)}%`).join(" · ");
}

function stallTone(minute: number): "neutral" | "warn" | "bad" {
  if (minute >= STALL_LIMITS.cpu.critical) return "bad";
  return minute >= STALL_LIMITS.cpu.warning ? "warn" : "neutral";
}

function CpuLoadPill({ cpu, slot }: { cpu: MonitorSnapshot["cpu"]; slot: boolean }) {
  if (cpu.loadAverage) return <Pill>{slot ? "host load" : "load"} {cpu.loadAverage[0].toFixed(2)}</Pill>;
  if (cpu.stallPercent) return <Pill tone={stallTone(cpu.stallPercent[1])}>pressure {Math.round(cpu.stallPercent[1])}%</Pill>;
  return null;
}

function SlotPills({ slot }: { slot: NonNullable<MonitorSnapshot["slot"]> }) {
  return (
    <>
      <Pill>on {slot.host}</Pill>
      {slot.encoder ? (
        <HudTooltip delayDuration={300}>
          <HudTooltipTrigger asChild><span tabIndex={0} className="inline-flex outline-none"><Pill>encoder {Math.round(slot.encoder.usedPercent)}%</Pill></span></HudTooltipTrigger>
          <HudTooltipContent side="right" align="start" className="max-w-64 text-xs">{slot.encoder.words}</HudTooltipContent>
        </HudTooltip>
      ) : null}
    </>
  );
}

function CpuDetails({ snapshot }: { snapshot: MonitorSnapshot }) {
  const { cpu, sensors } = snapshot;
  const temperature = sensors?.cpuTempC ?? null;
  return (
    <>
      <p>{cpu.model}</p>
      <DetailRow label="Cores" value={cpu.cores} />
      {cpu.speedMHz > 0 ? <DetailRow label="Speed" value={`${(cpu.speedMHz / 1000).toFixed(2)} GHz`} /> : null}
      {cpu.loadAverage ? <DetailRow label={snapshot.slot ? "Host load 1 · 5 · 15 min" : "Load 1 · 5 · 15 min"} value={cpu.loadAverage.map((value) => value.toFixed(2)).join(" · ")} /> : null}
      {cpu.stallPercent ? <DetailRow label="Pressure 10 s · 1 · 5 min" value={stallText(cpu.stallPercent)} /> : null}
      {temperature !== null ? <DetailRow label="Temperature" value={`${temperature.toFixed(1)}°C`} /> : null}
      {sensors?.cpuWatts != null ? <DetailRow label="Power" value={formatWatts(sensors.cpuWatts)} /> : null}
      <div className="grid grid-cols-4 gap-x-3 gap-y-1 pt-1">
        {cpu.perCoreUsagePercent.map((value, index) => (
          <div key={index} className="space-y-0.5">
            <div className="flex justify-between gap-1 text-2xs tabular-nums opacity-80"><span>{index + 1}</span><span>{value === null ? "–" : `${Math.round(value)}%`}</span></div>
            <div className="h-1 overflow-hidden rounded-full bg-primary-foreground/20"><div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%`, backgroundColor: colorForPercent(value) }} /></div>
          </div>
        ))}
      </div>
    </>
  );
}

function CpuSection({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  const cpu = snapshot?.cpu;
  const sensors = snapshot?.sensors;
  const temperature = sensors?.cpuTempC ?? null;
  return (
    <MetricSection
      label="CPU"
      icon={<SectionIcon icon={CpuIcon} color={METRIC_COLORS.good} />}
      pill={!cpu ? <Pill loading>load 0.00</Pill> : temperature === null ? <CpuLoadPill cpu={cpu} slot={Boolean(snapshot?.slot)} /> : <TemperaturePill celsius={temperature} />}
      details={snapshot ? <CpuDetails snapshot={snapshot} /> : undefined}
    >
      <BigValue value={cpu?.usagePercent == null ? null : Math.round(cpu.usagePercent)} unit="%" loading={!cpu} />
      <BarChart values={snapshot?.history.map((point) => point.cpuPercent) ?? []} colorFor={colorForPercent} label="CPU usage over the last few minutes" slots={HISTORY_BARS} />
      <Footnote>{cpu ? joinParts([cpuState(cpu.usagePercent), formatWatts(sensors?.cpuWatts) ?? `${cpu.cores} cores`]) : <LoadingText sample="normal · 8 cores" />}</Footnote>
    </MetricSection>
  );
}

function MemorySection({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  const memory = snapshot?.memory;
  const pressure = memory ? memoryPressure(memory.usagePercent) : null;
  return (
    <MetricSection
      label="Memory"
      icon={<SectionIcon icon={RamMemoryIcon} color={METRIC_COLORS.memory} />}
      pill={pressure ? <Pill tone={pressure.tone}>{pressure.label}</Pill> : <Pill loading>Normal</Pill>}
      details={memory ? <>
        <DetailRow label="Used" value={formatBytes(memory.usedBytes)} />
        <DetailRow label="Available" value={formatBytes(memory.availableBytes)} />
        {memory.cachedBytes > 0 ? <DetailRow label="Cached" value={formatBytes(memory.cachedBytes)} /> : null}
        {memory.swapTotalBytes > 0 ? <DetailRow label="Swap" value={`${formatBytes(memory.swapUsedBytes)} of ${formatBytes(memory.swapTotalBytes)}`} /> : null}
        {memory.stallPercent ? <DetailRow label="Pressure 10 s · 1 · 5 min" value={stallText(memory.stallPercent)} /> : null}
      </> : undefined}
    >
      <BigValue value={memory ? Math.round(memory.usagePercent) : null} unit="%" loading={!memory} />
      <LineChart series={[{ values: snapshot?.history.map((point) => point.memoryPercent) ?? [], color: METRIC_COLORS.memory }]} max={100} label="Memory usage over the last few minutes" />
      <Footnote>{memory ? `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}` : <LoadingText sample="8.00 GB / 16 GB" />}</Footnote>
    </MetricSection>
  );
}

function DiskSection({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  const disk = snapshot?.disk;
  const icon = <SectionIcon icon={HardDriveIcon} color={METRIC_COLORS.disk} />;
  if (snapshot && !disk) {
    return <MetricSection label="Free space" icon={icon} pill={<Pill>Unavailable</Pill>}><Footnote>Disk usage could not be read.</Footnote></MetricSection>;
  }
  const free = disk ? bytesParts(disk.freeBytes) : null;
  return (
    <MetricSection
      label="Free space"
      icon={icon}
      pill={disk ? <Pill>{formatBytes(disk.totalBytes)}</Pill> : <Pill loading>500 GB</Pill>}
      details={disk ? <>
        <DetailRow label="Mount" value={disk.mount} />
        <DetailRow label="Used" value={formatBytes(disk.usedBytes)} />
        <DetailRow label="Free" value={formatBytes(disk.freeBytes)} />
      </> : undefined}
    >
      <BigValue value={free ? free.value : null} unit={free?.unit} loading={!disk} />
      <ProgressBar value={disk?.usagePercent ?? 0} color={!disk ? METRIC_COLORS.disk : disk.usagePercent >= 95 ? METRIC_COLORS.bad : disk.usagePercent >= 85 ? METRIC_COLORS.warn : METRIC_COLORS.disk} label="Disk usage" />
      <Footnote>{disk ? `${formatBytes(disk.usedBytes)} used · ${Math.round(disk.usagePercent)}%` : <LoadingText sample="250 GB used · 50%" />}</Footnote>
    </MetricSection>
  );
}

function NetworkSection({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  const network = snapshot?.network;
  const icon = <SectionIcon icon={ArrowDataTransferVerticalIcon} color={METRIC_COLORS.download} />;
  if (snapshot && !network) {
    return <MetricSection label="Network" icon={icon} pill={<Pill>Unavailable</Pill>}><Footnote>Network counters could not be read.</Footnote></MetricSection>;
  }
  const down = network?.rxBytesPerSecond == null ? null : bytesParts(network.rxBytesPerSecond);
  const history = snapshot?.history ?? [];
  return (
    <MetricSection
      label="Network"
      icon={icon}
      pill={network ? <Pill>{network.interface}</Pill> : <Pill loading>en0</Pill>}
      details={network ? <>
        <DetailRow label="Download" value={formatRate(network.rxBytesPerSecond)} />
        <DetailRow label="Upload" value={formatRate(network.txBytesPerSecond)} />
        <DetailRow label="Received" value={formatBytes(network.rxTotalBytes)} />
        <DetailRow label="Sent" value={formatBytes(network.txTotalBytes)} />
      </> : undefined}
    >
      <BigValue value={down ? down.value : null} unit={down ? `${down.unit}/s down` : undefined} loading={!network} />
      <LineChart
        series={[
          { values: history.map((point) => point.networkRxBytesPerSecond), color: METRIC_COLORS.download },
          { values: history.map((point) => point.networkTxBytesPerSecond), color: METRIC_COLORS.upload },
        ]}
        label="Download and upload over the last few minutes"
      />
      <Footnote>
        {network
          ? <><span style={{ color: METRIC_COLORS.upload }}>●</span> {formatRate(network.txBytesPerSecond)} up</>
          : <LoadingText sample="● 10 KB/s up" />}
      </Footnote>
    </MetricSection>
  );
}

function GpuSection({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  const sensors = snapshot?.sensors;
  if (snapshot && !hasGpuReadings(snapshot)) return null;
  const history = snapshot?.history ?? [];
  return (
    <MetricSection
      label="GPU"
      icon={<SectionIcon icon={GpuIcon} color={METRIC_COLORS.gpu} />}
      pill={!sensors ? <Pill loading>50°C</Pill> : sensors.gpuTempC === null ? undefined : <TemperaturePill celsius={sensors.gpuTempC} />}
      details={sensors ? <>
        {sensors.gpuPercent !== null ? <DetailRow label="Usage" value={`${sensors.gpuPercent}%`} /> : null}
        {sensors.gpuTempC !== null ? <DetailRow label="Temperature" value={`${sensors.gpuTempC.toFixed(1)}°C`} /> : null}
        {sensors.gpuWatts !== null ? <DetailRow label="Power" value={formatWatts(sensors.gpuWatts)} /> : null}
      </> : undefined}
    >
      <BigValue value={sensors?.gpuPercent ?? null} unit="%" loading={!sensors} />
      <LineChart series={[{ values: history.map((point) => point.gpuPercent ?? null), color: METRIC_COLORS.gpu }]} max={100} label="GPU usage over the last few minutes" />
      <Footnote>{sensors ? joinParts([cpuState(sensors.gpuPercent), formatWatts(sensors.gpuWatts)]) : <LoadingText sample="idle" />}</Footnote>
    </MetricSection>
  );
}

const BATTERY_STATES = {
  charging: "Charging",
  discharging: "On battery",
  full: "Fully charged",
  "plugged-in": "Plugged in",
} as const;

function batteryColor(percent: number, charging: boolean): string {
  if (charging || percent > 40) return METRIC_COLORS.good;
  return percent > 15 ? METRIC_COLORS.warn : METRIC_COLORS.bad;
}

function BatterySection({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  const battery = snapshot?.battery;
  if (snapshot && !battery) return null;
  if (!battery) {
    return (
      <MetricSection label="Battery" icon={<SectionIcon icon={BatteryFullIcon} color={METRIC_COLORS.good} />} pill={<Pill loading>90% health</Pill>}>
        <BigValue value={null} unit="%" loading />
        <ProgressBar value={0} color={METRIC_COLORS.good} label="Battery charge" />
        <Footnote><LoadingText sample="Fully charged" /></Footnote>
      </MetricSection>
    );
  }
  const timeLeft = battery.minutesRemaining === null
    ? null
    : battery.state === "charging"
      ? `${formatMinutes(battery.minutesRemaining)} to full`
      : `${formatMinutes(battery.minutesRemaining)} left`;
  return (
    <MetricSection
      label="Battery"
      icon={<SectionIcon icon={battery.state === "charging" ? BatteryChargingIcon : BatteryFullIcon} color={batteryColor(battery.percent, battery.state === "charging")} />}
      pill={battery.healthPercent === null ? undefined : <Pill>{Math.round(battery.healthPercent)}% health</Pill>}
      details={<>
        <DetailRow label="State" value={BATTERY_STATES[battery.state]} />
        {battery.cycleCount !== null ? <DetailRow label="Cycles" value={battery.cycleCount} /> : null}
        {battery.temperatureC !== null ? <DetailRow label="Temperature" value={`${battery.temperatureC.toFixed(1)}°C`} /> : null}
        {battery.watts !== null ? <DetailRow label={battery.state === "charging" ? "Charging power" : "Power draw"} value={formatWatts(battery.watts)} /> : null}
      </>}
    >
      <BigValue value={Math.round(battery.percent)} unit="%" />
      <ProgressBar value={battery.percent} color={batteryColor(battery.percent, battery.state === "charging")} label="Battery charge" />
      <Footnote>{joinParts([BATTERY_STATES[battery.state], battery.state === "charging" || battery.state === "discharging" ? formatWatts(battery.watts) : null, timeLeft])}</Footnote>
    </MetricSection>
  );
}

function shareColor(share: number, warnAt: number, badAt: number): string | undefined {
  if (share >= badAt) return METRIC_COLORS.badDim;
  return share >= warnAt ? METRIC_COLORS.warnDim : undefined;
}

const PROCESS_ROWS = 5;
const LOADING_PROCESS_NAMES = ["WindowServer", "node", "Helium Helper", "kernel_task", "bb"];

function ProcessRows({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  if (!snapshot) {
    return LOADING_PROCESS_NAMES.map((name) => (
      <div key={name} className="contents">
        <span className="min-w-0 truncate"><LoadingText sample={name} /></span>
        <span className="text-right tabular-nums"><LoadingText sample="512 MB" /></span>
        <span className="text-right tabular-nums"><LoadingText sample="1.0" /></span>
      </div>
    ));
  }
  const { processes, memory } = snapshot;
  if (!processes.available) return <span className="col-span-3 text-muted-foreground">Unavailable</span>;
  return processes.top.slice(0, PROCESS_ROWS).map((process) => (
    <div key={process.pid} className="contents">
      <HudTooltip delayDuration={400}>
        <HudTooltipTrigger asChild>
          <span className="min-w-0 truncate text-sidebar-foreground" data-reveal="">{process.name}</span>
        </HudTooltipTrigger>
        <HudTooltipContent side="right" className="text-xs">{process.name} · PID {process.pid}</HudTooltipContent>
      </HudTooltip>
      <span className="text-right tabular-nums text-subtle-foreground" data-reveal="" style={{ color: shareColor(memory.totalBytes > 0 ? process.rssBytes / memory.totalBytes : 0, 0.25, 0.5) }}>{formatBytes(process.rssBytes)}</span>
      <span className="text-right tabular-nums text-subtle-foreground" data-reveal="" style={{ color: shareColor(process.cpuPercent, 50, 100) }}>{process.cpuPercent.toFixed(1)}</span>
    </div>
  ));
}

function ProcessesSection({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  return (
    <section aria-label="Top processes" className="min-w-0 p-3">
      <div className="grid grid-cols-[1fr_auto_3rem] items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="text-sidebar-foreground">Top processes</span>
        <span className="text-right text-subtle-foreground/75">Memory</span>
        <span className="text-right text-subtle-foreground/75">% CPU</span>
        <ProcessRows snapshot={snapshot} />
      </div>
    </section>
  );
}

function StatusPopover({ snapshot, isServer, isBox, expected, waitingFor }: { snapshot: MonitorSnapshot | null; isServer: boolean; isBox: boolean; expected: PanelShape; waitingFor: string | null }) {
  return (
    <>
      <SummaryStrip snapshot={snapshot} isServer={isServer} isBox={isBox} waitingFor={waitingFor} />
      <CpuSection snapshot={snapshot} />
      {snapshot || expected.gpu ? <GpuSection snapshot={snapshot} /> : null}
      <MemorySection snapshot={snapshot} />
      <DiskSection snapshot={snapshot} />
      <NetworkSection snapshot={snapshot} />
      {snapshot || expected.battery ? <BatterySection snapshot={snapshot} /> : null}
      {snapshot?.tailscale ? (
        <Section label="Tailscale">
          <TailscaleRows tailscale={snapshot.tailscale} />
        </Section>
      ) : !snapshot && expected.tailscaleRows > 0 ? (
        <Section label="Tailscale">
          <LoadingTailscaleRows rows={expected.tailscaleRows} />
        </Section>
      ) : null}
      <ProcessesSection snapshot={snapshot} />
    </>
  );
}

function MachineHeader({ machines, selected, onSelect, onOpen, opens, lookOf, actions }: { machines: Machine[] | null; selected: string; onSelect: (machineId: string) => void; onOpen: () => void; opens: MachineOpens | null; lookOf: LookOf; actions: ReactNode }) {
  return (
    <div data-bb-box-monitor-header className="sticky top-0 z-10 bg-sidebar">
      <div className="flex h-9 min-w-0 items-center gap-1 bg-sidebar-accent/50 px-1.5">
        <span className="flex min-w-0 items-center">
          <MachinePicker machines={machines} selected={selected} onSelect={onSelect} onOpen={onOpen} lookOf={lookOf} />
          <HeaderOpenMenu opens={opens} />
        </span>
        <span className="flex-1" />
        {actions}
      </div>
    </div>
  );
}

function lastReadingText(updatedAt: string): string {
  const time = formatClockTime(updatedAt);
  return time ? `Showing data from ${time}.` : "Showing the last data.";
}

function StaleNotice({ message, updatedAt }: { message: string; updatedAt: string }) {
  return (
    <div role="status" className="flex items-start gap-1.5 px-3 py-2 text-xs text-subtle-foreground">
      <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" style={{ color: METRIC_COLORS.warn }} aria-hidden="true" />
      <span>{message} {lastReadingText(updatedAt)}</span>
    </div>
  );
}

function UnavailableState({ message }: { message: string }) {
  return (
    <div role="status" className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
      <HugeiconsIcon icon={CloudOffIcon} className="size-5 text-subtle-foreground" aria-hidden="true" />
      <p className="text-xs text-sidebar-foreground">{message}</p>
      <p className="text-xs text-subtle-foreground">Trying again while this panel is open.</p>
    </div>
  );
}

const SLOW_LOAD_MS = 6000;

function useSlowLoad(machineId: string, loading: boolean): boolean {
  const [slow, setSlow] = useState<string | null>(null);
  useEffect(() => {
    if (!loading) {
      setSlow(null);
      return;
    }
    const timer = setTimeout(() => setSlow(machineId), SLOW_LOAD_MS);
    return () => clearTimeout(timer);
  }, [machineId, loading]);
  return loading && slow === machineId;
}

function ServerMark({ className }: { className?: string }) {
  return <HugeiconsIcon icon={ServerIcon} className={className} aria-hidden="true" />;
}

function StatusDisclosure({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const { machines, selected, setSelected, refresh: refreshMachines } = useMachines();
  const opensOf = useOpensOf();
  const lookOf = useBoxLookOf();
  const { container, active, snapshot, error, reload, reloading } = useMonitorSnapshot(selected);
  const machineName = selectedMachine(machines, selected).name;
  const isBox = machines?.find((machine) => machineKey(machine) === selected)?.isBox ?? false;
  const errorMessage = error ? loadErrorCopy(error, machineName) : "";
  const slowLoad = useSlowLoad(selected, !snapshot && !error);
  useRevealOnLoad(container, selected, snapshot !== null);
  const expectedShape = useMemo(() => readPanelShape(selected), [selected]);
  const loadedGpu = snapshot ? hasGpuReadings(snapshot) : null;
  const loadedBattery = snapshot ? Boolean(snapshot.battery) : null;
  const loadedTailscaleRows = snapshot ? (snapshot.tailscale ? tailscaleRowCount(snapshot.tailscale) : 0) : null;
  useEffect(() => {
    if (loadedGpu === null || loadedBattery === null || loadedTailscaleRows === null) return;
    rememberPanelShape(selected, { gpu: loadedGpu, battery: loadedBattery, tailscaleRows: loadedTailscaleRows });
  }, [selected, loadedGpu, loadedBattery, loadedTailscaleRows]);
  return (
    <TooltipProvider>
    <HudScrollProvider container={container}>
    <div ref={container} data-bb-box-monitor-shell aria-busy={(active && !snapshot && !error) || reloading} className="w-full min-w-0 divide-y divide-sidebar-border">
      <MachineHeader
        machines={machines}
        selected={selected}
        onSelect={setSelected}
        onOpen={() => void refreshMachines()}
        opens={opensOf(machines?.find((machine) => machineKey(machine) === selected))}
        lookOf={lookOf}
        actions={<>
          <ReloadButton onReload={reload} reloading={reloading} loading={!snapshot && !error} updatedAt={snapshot?.timestamp ?? null} />
          <CollapseButton onCollapse={dismiss} />
        </>}
      />
      {error && snapshot ? <StaleNotice message={errorMessage} updatedAt={snapshot.timestamp} /> : null}
      {!snapshot && error
        ? <UnavailableState message={errorMessage} />
        : <StatusPopover snapshot={snapshot} isServer={selected === SERVER_MACHINE} isBox={isBox} expected={expectedShape} waitingFor={slowLoad ? machineName : null} />}
    </div>
    </HudScrollProvider>
    </TooltipProvider>
  );
}

const MONITOR_ON_KEY = "bb-box:monitor:on";

export function rememberedMonitorOn(): boolean {
  try {
    return globalThis.localStorage?.getItem(MONITOR_ON_KEY) !== "off";
  } catch {
    return true;
  }
}

function rememberMonitorOn(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(MONITOR_ON_KEY, on ? "on" : "off");
  } catch {
    return;
  }
}

interface MonitorState {
  readonly enabled: boolean;
  readonly backgroundMonitoring: boolean;
  readonly pressureNotifications: boolean;
}

function MonitorOverlay() {
  const rpc = useRpc<Contract>();
  const [state, setState] = useState<MonitorState | null>(null);
  const load = useCallback(() => {
    rpc.call("monitor.state", null).then((next) => {
      setState(next);
      rememberMonitorOn(next.enabled);
    }, () => undefined);
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("changed", load);
  return <PressureNotifications active={state !== null && state.enabled && state.backgroundMonitoring && state.pressureNotifications} />;
}

export const MACHINE_STATUS_ICON = "bb-box-machine-status";

export function registerMonitor(app: PluginAppBuilder): void {
  app.experimental_icons.register({ name: MACHINE_STATUS_ICON, component: ServerMark });
  app.slots.experimental_appOverlay({ id: "monitor", component: MonitorOverlay });
  if (!rememberedMonitorOn()) return;
  bindStatusOpener(app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "status",
    label: "Machine status",
    icon: MACHINE_STATUS_ICON,
    component: StatusDisclosure,
  }).open);
}
