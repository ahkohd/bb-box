import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDataTransferVerticalIcon, ComputerIcon, CpuIcon, GpuIcon, HardDriveIcon, RamMemoryIcon, VideoReplayIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { BoxHistoryView, BoxPageState, Contract, HistoryRange, HistoryStep, MonitorSnapshot } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { STALL_LIMITS } from "../monitor/health.ts";
import { useMonitorSnapshot } from "./monitor/use-snapshot.ts";
import { LoadingText, Pill } from "./monitor/metric-parts.tsx";
import { MiddleTruncate } from "./monitor/middle-truncate.tsx";
import { loadErrorCopy } from "./monitor/load-error-copy.ts";
import { hasGpuReadings } from "./monitor/panel-shape.ts";
import { SettingsLink } from "./settings-link.tsx";
import { ago, dayAndClock } from "./box-words.ts";
import { AXIS_WIDTH, HistoryChart, SeriesSample, type Band, type ChartSeries } from "./history-chart.tsx";
import {
  GAP_WORDS,
  RANGE_LABELS,
  RANGE_WORDS,
  historyBoundsOf,
  historyNetworkSummary,
  historySummary,
  historyTicks,
  historyTimeWords,
  partlyReadWords,
  stepSpanWords,
  bytesWords,
  clockWithSeconds,
  gapsOf,
  hostAtStart,
  hostBusy,
  liveTicks,
  liveWindow,
  liveWords,
  longestStepMs,
  memoryOfShare,
  memoryPressure,
  minuteClock,
  networkSummary,
  nowPercents,
  percentOfShare,
  rateWords,
  slotCpuWords,
  slotLineWords,
  usageSummary,
  type SlotShare,
} from "./activity-words.ts";

export const CHART_COLOURS = {
  cpu: "var(--chart-cpu)",
  memory: "var(--chart-memory)",
  down: "var(--chart-down)",
  up: "var(--chart-up)",
  host: "var(--chart-host)",
  gpu: "var(--chart-gpu)",
} as const;

export const CHART_TONES =
  "[--chart-cpu:#15803d] [--chart-memory:#a16207] [--chart-down:#1d4ed8] [--chart-up:#6d28d9] [--chart-host:#525252] [--chart-gpu:#b45309] dark:[--chart-cpu:#22c55e] dark:[--chart-memory:#e5c07b] dark:[--chart-down:#5b8def] dark:[--chart-up:#a78bfa] dark:[--chart-host:#a3a3a3] dark:[--chart-gpu:#f59e0b]";

const DASHES = { memory: "6 4", up: "6 4", host: "10 4", disk: "1 4" } as const;

const HISTORY_REFRESH_MS = 60_000;

const HISTORY_HEIGHT = 168;

const CARD = "overflow-hidden rounded-lg border border-border bg-card";

const TILES = "grid grid-cols-2 border-b border-border [&>*]:border-border max-lg:[&>*:nth-child(odd)]:border-r max-lg:[&>*:not(:nth-last-child(-n+2))]:border-b lg:divide-x";

const USAGE_HEIGHT = 152;

const NETWORK_HEIGHT = 56;

const LEAST_RATE_CEILING = 64 * 1024;

type IconData = Parameters<typeof HugeiconsIcon>[0]["icon"];

function TileIcon({ icon, color }: { icon: IconData; color: string }) {
  return <HugeiconsIcon icon={icon} className="size-3.5 shrink-0" style={{ color }} aria-hidden="true" />;
}

function Tile({ label, icon, pill, value, unit, foot, loading, sample }: { label: string; icon: ReactNode; pill?: ReactNode; value: ReactNode; unit?: string; foot: ReactNode; loading: boolean; sample: string }) {
  return (
    <section aria-label={label} className="min-w-0 space-y-1.5 px-4 py-3">
      <div className="flex min-h-5 items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-foreground">
          {icon}
          <span className="truncate">{label}</span>
        </span>
        {loading ? null : pill}
      </div>
      <p className="flex items-baseline gap-1 leading-none">
        <span className="text-xl tabular-nums text-foreground">{loading ? <LoadingText sample="00" /> : value}</span>
        <span className="text-xs text-muted-foreground">{loading ? " " : unit}</span>
      </p>
      <p className="truncate text-xs text-subtle-foreground">{loading ? <LoadingText sample={sample} /> : foot}</p>
    </section>
  );
}

function stallTone(minute: number): "neutral" | "warn" | "bad" {
  if (minute >= STALL_LIMITS.cpu.critical) return "bad";
  return minute >= STALL_LIMITS.cpu.warning ? "warn" : "neutral";
}

function CpuPill({ cpu }: { cpu: MonitorSnapshot["cpu"] }) {
  if (cpu.loadAverage) return <Pill>load {cpu.loadAverage[0].toFixed(2)}</Pill>;
  if (cpu.stallPercent) return <Pill tone={stallTone(cpu.stallPercent[1])}>pressure {Math.round(cpu.stallPercent[1])}%</Pill>;
  return null;
}

function cpuState(percent: number | null): string | null {
  if (percent === null) return null;
  if (percent < 25) return "idle";
  if (percent < 75) return "normal";
  return "busy";
}

function wholePercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : String(Math.round(value));
}

function splitWords(words: string): { value: string; unit: string } {
  const [value = "0", ...unit] = words.split(" ");
  return { value, unit: unit.join(" ") };
}

function NowTiles({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  const loading = !snapshot;
  const cpu = snapshot?.cpu;
  const memory = snapshot?.memory;
  const disk = snapshot?.disk ?? null;
  const network = snapshot?.network ?? null;
  const percents = snapshot ? nowPercents(snapshot) : null;
  const pressure = memory ? memoryPressure(memory.usagePercent) : null;
  const gpu = snapshot && hasGpuReadings(snapshot) ? snapshot.sensors! : null;
  const free = disk ? splitWords(bytesWords(disk.freeBytes)) : null;
  const down = network?.rxBytesPerSecond == null ? null : splitWords(rateWords(network.rxBytesPerSecond));
  return (
    <div data-tiles className={cn(TILES, gpu ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
      <Tile label="CPU" icon={<TileIcon icon={CpuIcon} color={CHART_COLOURS.cpu} />} pill={cpu ? <CpuPill cpu={cpu} /> : null} loading={loading} sample="normal · 4 cores" value={wholePercent(percents?.cpu)} unit="%" foot={cpu ? [cpuState(cpu.usagePercent), `${cpu.cores} ${cpu.cores === 1 ? "core" : "cores"}`].filter(Boolean).join(" · ") : null} />
      <Tile label="Memory" icon={<TileIcon icon={RamMemoryIcon} color={CHART_COLOURS.memory} />} pill={pressure ? <Pill tone={pressure.tone}>{pressure.label}</Pill> : null} loading={loading} sample="4 GiB of 8 GiB" value={wholePercent(percents?.memory)} unit="%" foot={memory ? `${bytesWords(memory.usedBytes)} of ${bytesWords(memory.totalBytes)}` : null} />
      <Tile label="Disk" icon={<TileIcon icon={HardDriveIcon} color={CHART_COLOURS.down} />} pill={disk ? <Pill>{bytesWords(disk.totalBytes)}</Pill> : null} loading={loading} sample="12 GiB used · 40%" value={free?.value ?? "–"} unit={free ? `${free.unit} free` : "not read"} foot={disk ? `${bytesWords(disk.usedBytes)} used · ${Math.round(disk.usagePercent)}%` : "Its disk could not be read."} />
      <Tile label="Network" icon={<TileIcon icon={ArrowDataTransferVerticalIcon} color={CHART_COLOURS.down} />} pill={network ? <Pill>{network.interface}</Pill> : null} loading={loading} sample="10 KB/s up" value={down?.value ?? "–"} unit={down ? `${down.unit} down` : network ? "measuring" : "not read"} foot={network ? (network.txBytesPerSecond === null ? "Measuring…" : `${rateWords(network.txBytesPerSecond)} up`) : "Its network could not be read."} />
      {gpu ? <Tile label="GPU" icon={<TileIcon icon={GpuIcon} color={CHART_COLOURS.gpu} />} loading={false} sample="" value={wholePercent(gpu.gpuPercent)} unit="%" foot={[cpuState(gpu.gpuPercent), gpu.gpuTempC === null ? null : `${Math.round(gpu.gpuTempC)}°C`].filter(Boolean).join(" · ") || "Read"} /> : null}
    </div>
  );
}

function SlotTiles({ snapshot, slot, share }: { snapshot: MonitorSnapshot; slot: NonNullable<MonitorSnapshot["slot"]>; share: SlotShare }) {
  const host = slot.host;
  const own = snapshot.own ?? null;
  const percents = nowPercents(snapshot);
  const ownMemory = own ? splitWords(bytesWords(own.memoryBytes)) : null;
  const disk = snapshot.disk;
  const free = disk ? splitWords(bytesWords(disk.freeBytes)) : null;
  const macCpu = snapshot.cpu.usagePercent;
  const load = snapshot.cpu.loadAverage;
  const busy = hostBusy(snapshot);
  return (
    <div className="border-b border-border">
      <div data-tiles className={cn(TILES, "border-b-0", slot.encoder ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
        <Tile label="This slot's CPU" icon={<TileIcon icon={CpuIcon} color={CHART_COLOURS.cpu} />} loading={false} sample="" value={wholePercent(percents.cpu)} unit={own ? "% of its share" : "not read"} foot={slotCpuWords(own?.cpuCores ?? null, share, host, snapshot.cpu.cores)} />
        <Tile label="This slot's memory" icon={<TileIcon icon={RamMemoryIcon} color={CHART_COLOURS.memory} />} loading={false} sample="" value={ownMemory?.value ?? "–"} unit={ownMemory?.unit ?? "not read"} foot={`of its ${bytesWords(share.memoryBytes)}${own ? ` · ${wholePercent(percents.memory)}%` : ""}`} />
        <Tile
          label={`${hostAtStart(host)}, all slots`}
          icon={<TileIcon icon={ComputerIcon} color={CHART_COLOURS.host} />}
          pill={busy ? <Pill tone="warn">busy</Pill> : null}
          loading={false}
          sample=""
          value={macCpu !== null ? wholePercent(macCpu) : load ? load[0].toFixed(2) : "–"}
          unit={macCpu !== null ? "% CPU" : load ? "host load" : "not read"}
          foot={[macCpu !== null && load ? `host load ${load[0].toFixed(2)}` : null, `memory ${Math.round(snapshot.memory.usagePercent)}%`, `${snapshot.cpu.cores} cores`].filter(Boolean).join(" · ")}
        />
        {slot.encoder ? (
          <Tile label={`${hostAtStart(host)}'s encoder`} icon={<TileIcon icon={VideoReplayIcon} color={CHART_COLOURS.host} />} loading={false} sample="" value={wholePercent(slot.encoder.usedPercent)} unit="% used" foot={<span title={slot.encoder.words}>{slot.encoder.words}</span>} />
        ) : null}
        <Tile label={`${hostAtStart(host)}'s disk`} icon={<TileIcon icon={HardDriveIcon} color={CHART_COLOURS.down} />} loading={false} sample="" value={free?.value ?? "–"} unit={free ? `${free.unit} free` : "not read"} foot={disk ? `of ${bytesWords(disk.totalBytes)}, every slot's files together` : "Its disk could not be read."} />
      </div>
      <p data-slot-line className="border-t border-border px-4 py-2 text-xs text-subtle-foreground">
        {slotLineWords(host, share.slots)}
      </p>
    </div>
  );
}

type LineKey = "cpu" | "memory" | "host";

function LegendChip({ line, off, onToggle }: { line: ChartSeries; off: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={!off}
      onClick={onToggle}
      className={cn("inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", off ? "text-subtle-foreground hover:text-muted-foreground" : "text-foreground hover:bg-state-hover")}
    >
      <span className={cn(off && "opacity-30")}>
        <SeriesSample color={line.color} dash={line.dash} />
      </span>
      {line.label}
    </button>
  );
}

const percentWords = (value: number) => `${Math.round(value)}%`;

function usageLines(snapshot: MonitorSnapshot, share: SlotShare | null): (ChartSeries & { key: LineKey })[] {
  const points = snapshot.history;
  if (!share) {
    return [
      { key: "cpu", label: "CPU", color: CHART_COLOURS.cpu, values: points.map((point) => point.cpuPercent), format: percentWords },
      { key: "memory", label: "Memory", color: CHART_COLOURS.memory, dash: DASHES.memory, values: points.map((point) => point.memoryPercent), format: percentWords },
    ];
  }
  const host = snapshot.slot!.host;
  return [
    { key: "cpu", label: "This slot's CPU", color: CHART_COLOURS.cpu, values: points.map((point) => percentOfShare(point.ownCpuCores, share)), format: percentWords },
    { key: "memory", label: "This slot's memory", color: CHART_COLOURS.memory, dash: DASHES.memory, values: points.map((point) => memoryOfShare(point.ownMemoryBytes, share)), format: percentWords },
    { key: "host", label: `${hostAtStart(host)}'s CPU, all slots`, color: CHART_COLOURS.host, dash: DASHES.host, values: points.map((point) => point.cpuPercent), format: percentWords },
  ];
}

function Charts({ snapshot: live, share }: { snapshot: MonitorSnapshot; share: SlotShare | null }) {
  const [hidden, setHidden] = useState<ReadonlySet<LineKey>>(() => new Set(["host"]));
  const [held, setHeld] = useState<MonitorSnapshot | null>(null);
  const snapshot = held ?? live;
  const holdWhileRead = () => setHeld((current) => current ?? live);
  const goOnWhenLeft = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(null);
  };
  const points = snapshot.history;
  const times = points.map((point) => point.timestamp);
  const interval = snapshot.refreshIntervalMs;
  const window = liveWindow(points, interval);
  const ticks = liveTicks(window);
  const words = liveWords(interval);
  const lines = usageLines(snapshot, share);
  const shown = lines.filter((line) => !hidden.has(line.key));
  const cpuLine = lines.find((line) => line.key === "cpu")!;
  const memoryLine = lines.find((line) => line.key === "memory")!;
  const usageGaps = gapsOf(times, cpuLine.values, interval);
  const down = points.map((point) => point.networkRxBytesPerSecond);
  const up = points.map((point) => point.networkTxBytesPerSecond);
  const networkGaps = gapsOf(times, down, interval);
  const ceiling = Math.max(LEAST_RATE_CEILING, ...down.map((value) => value ?? 0), ...up.map((value) => value ?? 0)) * 1.15;
  const network: ChartSeries[] = [
    { key: "down", label: "Download", color: CHART_COLOURS.down, values: down, format: rateWords },
    { key: "up", label: "Upload", color: CHART_COLOURS.up, dash: DASHES.up, values: up, format: rateWords },
  ];
  const toggle = (key: LineKey) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const step = longestStepMs(interval);
  return (
    <div className="space-y-4 px-4 pb-3 pt-3" onFocus={holdWhileRead} onBlur={goOnWhenLeft} data-held={held ? "" : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="-ml-2 flex flex-wrap items-center gap-1" role="group" aria-label="Lines shown">
          {lines.map((line) => (
            <LegendChip key={line.key} line={line} off={hidden.has(line.key)} onToggle={() => toggle(line.key)} />
          ))}
        </div>
        <span className="text-xs text-subtle-foreground">{held ? `Held at ${clockWithSeconds(Date.parse(held.timestamp))} while you read it` : `% used, ${words}`}</span>
      </div>
      {points.length ? (
        <HistoryChart
          series={shown}
          times={times}
          window={window}
          longestStepMs={step}
          ceiling={100}
          height={USAGE_HEIGHT}
          axis={["100%", "50%", "0%"]}
          ticks={ticks}
          label={`${share ? "This slot's CPU and memory" : "CPU and memory"}, ${words}`}
          summary={usageSummary(words, times, { cpu: cpuLine, memory: memoryLine }, usageGaps, clockWithSeconds)}
          timeWords={clockWithSeconds}
          gapWords="No reading"
        />
      ) : null}
      {points.length ? (
        <div className="space-y-1.5">
          <p className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className={cn("shrink-0 text-right text-foreground", AXIS_WIDTH)}>Network</span>
            {network.map((line) => (
              <span key={line.key} className="flex items-center gap-1.5">
                <SeriesSample color={line.color} dash={line.dash} />
                {line.label}
              </span>
            ))}
            {share ? <span data-network-whose className="min-w-0 truncate text-subtle-foreground">{hostAtStart(snapshot.slot!.host)}, all slots</span> : null}
          </p>
          <HistoryChart
            series={network}
            times={times}
            window={window}
            longestStepMs={step}
            ceiling={ceiling}
            height={NETWORK_HEIGHT}
            axis={[rateWords(ceiling), "0"]}
            ticks={[]}
            label={`${share ? `${hostAtStart(snapshot.slot!.host)}'s download and upload` : "Download and upload"}, ${words}`}
            summary={networkSummary(words, times, down, up, networkGaps, clockWithSeconds)}
            timeWords={clockWithSeconds}
            gapWords="No reading"
          />
        </div>
      ) : null}
    </div>
  );
}

export type ActivityRange = "live" | HistoryRange;

const HISTORY_RANGES: readonly HistoryRange[] = ["1h", "24h", "7d"];

function RangeGroup({ value, onChange, liveWhy }: { value: ActivityRange; onChange: (range: ActivityRange) => void; liveWhy: string | null }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const options: { id: ActivityRange; label: string; why: string | null }[] = [{ id: "live", label: "Live", why: liveWhy }, ...HISTORY_RANGES.map((id) => ({ id, label: RANGE_LABELS[id], why: null }))];
  const open = options.flatMap((option, index) => (option.why ? [] : [index]));
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step || !open.length) return;
    event.preventDefault();
    const at = open.indexOf(options.findIndex((option) => option.id === value));
    const next = open[(at + step + open.length) % open.length]!;
    onChange(options[next]!.id);
    buttons.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Time range" data-range-group onKeyDown={keys} className="inline-flex items-center gap-0.5 rounded-md bg-surface-recessed p-0.5">
      {options.map((option, index) => (
        <button
          key={option.id}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          aria-disabled={option.why ? true : undefined}
          aria-description={option.why ?? undefined}
          tabIndex={value === option.id ? 0 : -1}
          title={option.why ?? undefined}
          onClick={() => (option.why ? undefined : onChange(option.id))}
          className={cn(
            "h-6 cursor-pointer rounded-[5px] px-2 text-xs tabular-nums aria-disabled:cursor-default aria-disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            value === option.id ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ActivityCard({ status, group, children }: { status: ReactNode; group?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby="activity-heading" data-activity className={cn(CARD, CHART_TONES)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="activity-heading" className="text-sm font-normal text-foreground">
            Activity
          </h2>
          {status ? <span className="text-xs tabular-nums text-subtle-foreground">{status}</span> : null}
        </div>
        {group}
      </div>
      {children}
    </section>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const keptHistory = new Map<string, BoxHistoryView | null>();

const HISTORY_KEPT_IN_PAGE = 24;

function keepHistory(key: string, view: BoxHistoryView | null): void {
  keptHistory.delete(key);
  keptHistory.set(key, view);
  for (const oldest of keptHistory.keys()) {
    if (keptHistory.size <= HISTORY_KEPT_IN_PAGE) break;
    keptHistory.delete(oldest);
  }
}

function useBoxHistory(boxId: string, range: HistoryRange, state: string) {
  const rpc = useRpc<Contract>();
  const key = `${boxId}:${range}`;
  const [view, setView] = useState<BoxHistoryView | null>(() => keptHistory.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setView(keptHistory.get(key) ?? null);
    setError(null);
    const load = () =>
      rpc.call("monitor.history", { box: boxId, range }).then(
        (next) => {
          if (!current) return;
          keepHistory(key, next);
          setView(next);
          setError(null);
        },
        (caught: unknown) => {
          if (current) setError(message(caught));
        },
      );
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, HISTORY_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [rpc, boxId, range, key, state]);
  return { view, error };
}

type HistoryLineKey = "cpu" | "memory" | "disk" | "host";

function historyLines(view: BoxHistoryView): (ChartSeries & { key: HistoryLineKey })[] {
  const steps = view.steps;
  const busiest = view.range !== "1h";
  const host = view.slot?.host ?? null;
  return [
    { key: "cpu", label: host ? "This slot's CPU" : "CPU", color: CHART_COLOURS.cpu, values: steps.map((step) => step.cpu), ...(busiest ? { peaks: steps.map((step) => step.cpuBusiest) } : {}), format: percentWords },
    { key: "memory", label: host ? "This slot's memory" : "Memory", color: CHART_COLOURS.memory, dash: DASHES.memory, values: steps.map((step) => step.memory), format: percentWords },
    host
      ? { key: "host", label: `${host}'s CPU, all slots`, color: CHART_COLOURS.host, dash: DASHES.host, values: steps.map((step) => step.host), format: percentWords }
      : { key: "disk", label: "Disk", color: CHART_COLOURS.down, dash: DASHES.disk, values: steps.map((step) => step.disk), format: percentWords },
  ];
}

function gapAtStep(view: BoxHistoryView, step: HistoryStep | undefined): string {
  if (!step) return GAP_WORDS["no-reading"];
  const gap = view.gaps.find((each) => step.at >= each.from && step.at < each.to);
  return GAP_WORDS[gap?.kind ?? "no-reading"];
}

function HistoryOff() {
  return (
    <p data-history-off className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
      Box history is off, so bb-box keeps nothing new. What it kept stays until it ages out.{" "}
      <SettingsLink view={{ page: "option", id: "monitor" }} className="cursor-pointer text-foreground underline underline-offset-2 hover:no-underline">
        Monitor settings
      </SettingsLink>
    </p>
  );
}

function HistoryCharts({ box, range, quietWhenNone = false }: { box: BoxView; range: HistoryRange; quietWhenNone?: boolean }) {
  const { view: latest, error } = useBoxHistory(box.id, range, box.state);
  const [hidden, setHidden] = useState<ReadonlySet<HistoryLineKey>>(() => new Set(["disk", "host"]));
  const [held, setHeld] = useState<BoxHistoryView | null>(null);
  const view = held ?? latest;
  if (!view) {
    return error ? <Quiet>{`bb-box could not read ${box.name}'s history: ${error}`}</Quiet> : <Quiet><LoadingText sample="Reading its history" /></Quiet>;
  }
  if (quietWhenNone && view.newest === null) return <span data-history-none hidden />;
  const holdWhileRead = () => setHeld((current) => current ?? latest);
  const goOnWhenLeft = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(null);
  };
  const { stepMs } = view;
  const steps = view.steps;
  const times = steps.map((step) => step.at + stepMs / 2);
  const window = historyBoundsOf(view.from, view.to, stepMs);
  const ticks = historyTicks(range, window);
  const words = RANGE_WORDS[range];
  const clockOf = historyTimeWords(range, view.now);
  const timeWords = (centre: number) => stepSpanWords(range, centre - stepMs / 2, stepMs, clockOf);
  const lines = historyLines(view);
  const shown = lines.filter((line) => !hidden.has(line.key));
  const cpuLine = lines.find((line) => line.key === "cpu")!;
  const memoryLine = lines.find((line) => line.key === "memory")!;
  const bands: Band[] = view.gaps.map((gap) => ({ from: gap.from, to: gap.to, label: GAP_WORDS[gap.kind] }));
  const down = steps.map((step) => step.down);
  const up = steps.map((step) => step.up);
  const ceiling = Math.max(LEAST_RATE_CEILING, ...down.map((value) => value ?? 0), ...up.map((value) => value ?? 0)) * 1.15;
  const network: ChartSeries[] = [
    { key: "down", label: "Download", color: CHART_COLOURS.down, values: down, format: rateWords },
    { key: "up", label: "Upload", color: CHART_COLOURS.up, dash: DASHES.up, values: up, format: rateWords },
  ];
  const gapWords = (index: number) => gapAtStep(view, steps[index]);
  const notes = (index: number) => {
    const step = steps[index];
    return step?.partial ? partlyReadWords(range, step.covered) : null;
  };
  const toggle = (key: HistoryLineKey) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const host = view.slot?.host ?? null;
  return (
    <div data-history={range} onFocus={holdWhileRead} onBlur={goOnWhenLeft} data-held={held ? "" : undefined}>
      {view.monitor && !view.kept ? <HistoryOff /> : null}
      {view.full ? (
        <p role="status" data-history-full className="border-b border-border px-4 py-2 text-xs text-warning-text">
          {view.full}
        </p>
      ) : null}
      <div className="space-y-4 px-4 pb-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="-ml-2 flex flex-wrap items-center gap-1" role="group" aria-label="Lines shown">
            {lines.map((line) => (
              <LegendChip key={line.key} line={line} off={hidden.has(line.key)} onToggle={() => toggle(line.key)} />
            ))}
          </div>
          <span className="text-xs text-subtle-foreground">
            {held ? `Held while you read it` : `% used, ${words}${range === "1h" ? "" : "; the light band is each step's busiest minute"}`}
          </span>
        </div>
        <HistoryChart
          series={shown}
          times={times}
          window={window}
          longestStepMs={stepMs * 1.5}
          ceiling={100}
          height={HISTORY_HEIGHT}
          axis={["100%", "50%", "0%"]}
          ticks={ticks}
          bands={bands}
          label={`${host ? "This slot's CPU and memory" : "CPU and memory"}, ${words}`}
          summary={historySummary(words, times, { cpu: cpuLine, memory: memoryLine }, view.gaps, clockOf, view.now)}
          timeWords={timeWords}
          gapWords={gapWords}
          notes={notes}
        />
        {host ? null : (
          <div className="space-y-1.5">
            <p className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className={cn("shrink-0 text-right text-foreground", AXIS_WIDTH)}>Network</span>
              {network.map((line) => (
                <span key={line.key} className="flex items-center gap-1.5">
                  <SeriesSample color={line.color} dash={line.dash} />
                  {line.label}
                </span>
              ))}
            </p>
            <HistoryChart
              series={network}
              times={times}
              window={window}
              longestStepMs={stepMs * 1.5}
              ceiling={ceiling}
              height={NETWORK_HEIGHT}
              axis={[rateWords(ceiling), "0"]}
              ticks={[]}
              bands={bands}
              label={`Download and upload, ${words}`}
              summary={historyNetworkSummary(words, times, down, up, view.gaps, clockOf, view.now)}
              timeWords={timeWords}
              gapWords={gapWords}
              notes={notes}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p data-activity-quiet className="px-4 py-3 text-sm text-muted-foreground">{children}</p>;
}

export function notReadWords(box: BoxView, now: number): string {
  if (box.state === "stopped") {
    const stop = box.log?.lastStop;
    return stop ? `${box.name} is stopped, so bb-box is not reading it. It stopped ${ago(stop.at, now)}, ${dayAndClock(stop.at, now)}.` : `${box.name} is stopped, so bb-box is not reading it.`;
  }
  return `${box.name} is not running, so bb-box is not reading it.`;
}

function MonitorOff() {
  return (
    <Quiet>
      The Monitor is off, so bb-box reads nothing now. What it read before stays.{" "}
      <SettingsLink view={{ page: "option", id: "monitor" }} className="cursor-pointer text-foreground underline underline-offset-2 hover:no-underline">
        Turn it on in Monitor settings
      </SettingsLink>
    </Quiet>
  );
}

function liveWhyNot(page: BoxPageState, box: BoxView): string | null {
  const reach = page.monitor;
  if (reach.is === "read" && reach.machineId) return null;
  if (reach.is === "off") return "The Monitor is off";
  if (reach.is === "not-running") return `${box.name} is not running`;
  return reach.why ?? `bb-box cannot read ${box.name}`;
}

export function Activity({ page, box, now }: { page: BoxPageState; box: BoxView; now: number }) {
  const reach = page.monitor;
  const [chosen, setChosen] = useState<ActivityRange | null>(null);
  const liveWhy = liveWhyNot(page, box);
  const range: ActivityRange = chosen === "live" && liveWhy ? "24h" : (chosen ?? (liveWhy ? "24h" : "live"));
  const group = <RangeGroup value={range} onChange={setChosen} liveWhy={liveWhy} />;
  if (reach.is === "read" && reach.machineId) return <LiveActivity key={reach.machineId} machineId={reach.machineId} box={box} range={range} group={group} />;
  return (
    <ActivityCard status={reach.is === "off" ? "Not read" : null} group={group}>
      {reach.is === "off" ? <MonitorOff /> : reach.is === "not-running" ? <Quiet>{notReadWords(box, now)}</Quiet> : <Quiet>{reach.why ?? `bb-box cannot read ${box.name}.`}</Quiet>}
      {range === "live" ? null : <HistoryCharts key={range} box={box} range={range} quietWhenNone={reach.is === "unreadable"} />}
    </ActivityCard>
  );
}

function readStatus(snapshot: MonitorSnapshot | null, error: string | null, active: boolean): string {
  if (snapshot && !error) return `Read at ${clockWithSeconds(Date.parse(snapshot.timestamp))}`;
  if (snapshot) return `Last read at ${minuteClock(Date.parse(snapshot.timestamp))}`;
  if (error) return "Not answering";
  return active ? "Reading…" : "Read while this page is shown";
}

function LiveActivity({ machineId, box, range, group }: { machineId: string; box: BoxView; range: ActivityRange; group: ReactNode }) {
  const { container, active, snapshot, error } = useMonitorSnapshot(machineId);
  const errorWords = error ? loadErrorCopy(error, box.name) : null;
  const share = snapshot?.slot?.share ?? null;
  return (
    <div ref={container} className="space-y-5" aria-busy={active && !snapshot && !error}>
      <ActivityCard status={readStatus(snapshot, error, active)} group={group}>
          {errorWords && snapshot ? (
            <p role="status" data-stale className="border-b border-border px-4 py-2 text-xs text-warning-text">
              {errorWords} Showing data from {minuteClock(Date.parse(snapshot.timestamp))}.
            </p>
          ) : null}
          {errorWords && !snapshot ? (
            <Quiet>
              {errorWords} bb-box tries again while this page is open.
            </Quiet>
          ) : snapshot?.slot && share ? (
            <SlotTiles snapshot={snapshot} slot={snapshot.slot} share={share} />
          ) : (
            <NowTiles snapshot={snapshot} />
          )}
          {range === "live" ? (snapshot ? <Charts snapshot={snapshot} share={share} /> : null) : <HistoryCharts key={range} box={box} range={range} />}
      </ActivityCard>
      {snapshot ? <Processes snapshot={snapshot} slot={Boolean(snapshot.slot)} host={snapshot.slot?.host ?? null} /> : null}
    </div>
  );
}

function processMemory(bytes: number): string {
  return bytesWords(bytes);
}

export function Processes({ snapshot, slot, host }: { snapshot: MonitorSnapshot; slot: boolean; host: string | null }) {
  const { processes } = snapshot;
  return (
    <section id="processes" aria-labelledby="processes-heading" data-processes className={cn("scroll-mt-4", CARD)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 id="processes-heading" className="text-sm font-normal text-foreground">
          {slot ? "This slot's processes" : "Top processes"}
        </h2>
        <span className="text-xs text-subtle-foreground">{slot ? `Its own user's only, not ${host ?? "its Mac"}'s` : "By CPU, by name only"}</span>
      </div>
      {!processes.available ? (
        <Quiet>bb-box could not list its processes.</Quiet>
      ) : (
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="text-subtle-foreground">
              <th scope="col" className="px-4 py-2 text-left font-normal">
                Process
              </th>
              <th scope="col" className="w-20 px-2 py-2 text-right font-normal max-sm:hidden">
                PID
              </th>
              <th scope="col" className="w-16 px-2 py-2 text-right font-normal">
                CPU
              </th>
              <th scope="col" className="w-20 py-2 pl-2 pr-4 text-right font-normal">
                Memory
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-t border-border">
            {processes.top.map((process) => (
              <tr key={process.pid}>
                <td className="px-4 py-1.5 font-mono text-foreground">
                  <MiddleTruncate text={process.name} className="flex w-full" />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-subtle-foreground max-sm:hidden">{process.pid}</td>
                <td className={cn("px-2 py-1.5 text-right tabular-nums", process.cpuPercent >= 100 ? "text-warning-text" : "text-muted-foreground")}>{`${process.cpuPercent.toFixed(process.cpuPercent >= 100 ? 0 : 1)}%`}</td>
                <td className="py-1.5 pl-2 pr-4 text-right tabular-nums text-muted-foreground">{processMemory(process.rssBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="border-t border-border px-4 py-2 text-xs text-subtle-foreground">CPU is per core, so a process using four cores shows 400%. bb-box reads names and PIDs only, never arguments or environment.</p>
    </section>
  );
}
