import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDataTransferVerticalIcon, ComputerIcon, CpuIcon, GpuIcon, HardDriveIcon, RamMemoryIcon, VideoReplayIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { BoxHistoryView, BoxPageState, Contract, HistoryRange, HistoryStep, MonitorSnapshot } from "../plugin/contract.ts";
import type { GpuCard } from "../monitor/snapshot.ts";
import { MOST_CARDS } from "../monitor/nvidia.ts";
import type { BoxView } from "../plugin/views.ts";
import { PRODUCT } from "./product.ts";
import { countsAsThisBox } from "../plugin/gpu-page.ts";
import { STALL_LIMITS } from "../monitor/health.ts";
import { useMonitorSnapshot } from "./monitor/use-snapshot.ts";
import { useRevealOnLoad } from "./monitor/use-reveal-on-load.ts";
import { HISTORY_RANGES, historyWindow } from "../monitor/history-view.ts";
import { LoadingText, Pill } from "./monitor/metric-parts.tsx";
import { MiddleTruncate } from "./monitor/middle-truncate.tsx";
import { loadErrorCopy } from "./monitor/load-error-copy.ts";
import { gpuCardCount, hasGpuReadings, rememberGpuCards, rememberedGpuCards } from "./monitor/panel-shape.ts";
import { SHARED_PILL, cardFoot, cardLabel, cardName, cardSlots, gpuMemoryOf, sharedCardWords } from "./gpu-words.ts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsLink } from "./settings-link.tsx";
import { ago } from "./box-words.ts";
import { whenInSentence } from "./snapshot-words.ts";
import { AXIS_WIDTH, HistoryChart, SeriesSample, type Band, type ChartSeries } from "./history-chart.tsx";
import {
  GAP_WORDS,
  RANGE_LABELS,
  RANGE_WORDS,
  historyBoundsOf,
  historyClock,
  historyNetworkSummary,
  historySummary,
  historyTicks,
  historyTimeWords,
  partlyReadWords,
  stepSpanWords,
  stepWhenWords,
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
  gpu2: "var(--chart-gpu-2)",
} as const;

export const CHART_TONES =
  "[--chart-cpu:#15803d] [--chart-memory:#a16207] [--chart-down:#1d4ed8] [--chart-up:#6d28d9] [--chart-host:#525252] [--chart-gpu:#b45309] [--chart-gpu-2:#be123c] dark:[--chart-cpu:#22c55e] dark:[--chart-memory:#e5c07b] dark:[--chart-down:#5b8def] dark:[--chart-up:#a78bfa] dark:[--chart-host:#a3a3a3] dark:[--chart-gpu:#f59e0b] dark:[--chart-gpu-2:#fb7185]";

const DASHES = { memory: "6 4", up: "6 4", host: "10 4", disk: "1 4" } as const;

const HISTORY_REFRESH_MS = 60_000;

const CHART_HEIGHT = 160;

export const PROCESS_ROWS = 6;

const CARD = "overflow-hidden rounded-lg border border-border bg-card";

const TILE_GRID = "-mb-px -mr-px grid grid-cols-2 [&>*]:border-b [&>*]:border-r [&>*]:border-border max-lg:[&>*:last-child:nth-child(odd)]:col-span-2";

function TileGrid({ tiles, children }: { tiles: number; children: ReactNode }) {
  return (
    <div className="overflow-hidden">
      <div data-tiles className={cn(TILE_GRID, tileColumns(tiles))}>
        {children}
      </div>
    </div>
  );
}

const NETWORK_HEIGHT = 56;

const LEAST_RATE_CEILING = 64 * 1024;

type IconData = Parameters<typeof HugeiconsIcon>[0]["icon"];

function TileIcon({ icon, color }: { icon: IconData; color: string }) {
  return <HugeiconsIcon icon={icon} className="size-3.5 shrink-0" style={{ color }} aria-hidden="true" />;
}

function Tile({ label, name = label, icon, pill, value, unit, foot, loading, sample, children }: { label: string; name?: string; icon: ReactNode; pill?: ReactNode; value: ReactNode; unit?: string; foot: ReactNode; loading: boolean; sample: string; children?: ReactNode }) {
  return (
    <section aria-label={name} className="min-w-0 space-y-1.5 px-4 py-3">
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
        <span className="flex shrink-0 items-center gap-1.5 text-foreground">
          {icon}
          <span>{label}</span>
        </span>
        {loading ? null : pill}
      </div>
      <p className="flex items-baseline gap-1 leading-none" data-reveal={loading ? undefined : ""}>
        <span className="text-xl tabular-nums text-foreground">{loading ? <LoadingText sample="00" /> : value}</span>
        <span className="text-xs text-muted-foreground">{loading ? " " : unit}</span>
      </p>
      <p className="break-words text-xs text-subtle-foreground" data-reveal={loading ? undefined : ""}>{loading ? <LoadingText sample={sample} /> : foot}</p>
      {children}
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

const TILE_COLUMNS: Readonly<Record<number, string>> = { 4: "lg:grid-cols-4" };

function tileColumns(tiles: number): string {
  return TILE_COLUMNS[Math.min(tiles, 4)] ?? "lg:grid-cols-4";
}

function cardColour(card: number): string {
  return card % 2 === 0 ? CHART_COLOURS.gpu : CHART_COLOURS.gpu2;
}

function SharedPill({ words }: { words: string }) {
  const id = useId();
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-describedby={id} data-gpu-shared className="inline-flex rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <Pill>{SHARED_PILL}</Pill>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-xs">
          {words}
        </TooltipContent>
      </Tooltip>
      <span id={id} className="sr-only" data-gpu-shared-words>
        {words}
      </span>
    </TooltipProvider>
  );
}

function CardTile({ card, cards, slot, read, own }: { card: GpuCard | null; cards: number; slot: number; read: boolean; own: boolean }) {
  const label = cardName({ index: slot }, cards);
  if (!card) return <Tile label={label} icon={<TileIcon icon={GpuIcon} color={cardColour(slot)} />} loading={!read} sample="8 of 24 GiB · 120 W" value="–" unit="not read" foot="No reading of this card this time" />;
  const shared = card.shared ? sharedCardWords(card, cards, bytesWords) : null;
  const pill = shared ? <SharedPill words={shared} /> : card.temperatureC === null ? null : <Pill tone={card.temperatureC >= 95 ? "bad" : card.temperatureC >= 85 ? "warn" : "neutral"}>{Math.round(card.temperatureC)}°C</Pill>;
  return <Tile label={label} name={cardLabel(card, cards)} icon={<TileIcon icon={GpuIcon} color={cardColour(slot)} />} pill={pill} loading={false} sample="" value={wholePercent(card.usagePercent)} unit={shared ? "% whole card" : "%"} foot={cardFoot(card, bytesWords, own)} />;
}

function NowTiles({ snapshot, expectedCards = 0, box = null }: { snapshot: MonitorSnapshot | null; expectedCards?: number; box?: Pick<BoxView, "form" | "backendLabel" | "claim" | "facts"> | null }) {
  const loading = !snapshot;
  const cpu = snapshot?.cpu;
  const memory = snapshot?.memory;
  const disk = snapshot?.disk ?? null;
  const network = snapshot?.network ?? null;
  const percents = snapshot ? nowPercents(snapshot) : null;
  const pressure = memory ? memoryPressure(memory.usagePercent) : null;
  const cards = snapshot?.gpus?.cards ?? [];
  const slots = cardSlots(cards.map((card) => card.index), expectedCards);
  const gpu = !slots.length && snapshot && hasGpuReadings(snapshot) ? snapshot.sensors! : null;
  const free = disk ? splitWords(bytesWords(disk.freeBytes)) : null;
  const down = network?.rxBytesPerSecond == null ? null : splitWords(rateWords(network.rxBytesPerSecond));
  return (
    <div className="border-b border-border">
    <TileGrid tiles={4 + (gpu ? 1 : slots.length)}>
      <Tile label="CPU" icon={<TileIcon icon={CpuIcon} color={CHART_COLOURS.cpu} />} pill={cpu ? <CpuPill cpu={cpu} /> : null} loading={loading} sample="normal · 4 cores" value={wholePercent(percents?.cpu)} unit="%" foot={cpu ? [cpuState(cpu.usagePercent), `${cpu.cores} ${cpu.cores === 1 ? "core" : "cores"}`].filter(Boolean).join(" · ") : null} />
      <Tile label="Memory" icon={<TileIcon icon={RamMemoryIcon} color={CHART_COLOURS.memory} />} pill={pressure ? <Pill tone={pressure.tone}>{pressure.label}</Pill> : null} loading={loading} sample="4 GiB of 8 GiB" value={wholePercent(percents?.memory)} unit="%" foot={memory ? `${bytesWords(memory.usedBytes)} of ${bytesWords(memory.totalBytes)}` : null} />
      <Tile label="Disk" icon={<TileIcon icon={HardDriveIcon} color={CHART_COLOURS.down} />} pill={disk ? <Pill>{bytesWords(disk.totalBytes)}</Pill> : null} loading={loading} sample="12 GiB used · 40%" value={free?.value ?? "–"} unit={free ? `${free.unit} free` : "not read"} foot={disk ? `${bytesWords(disk.usedBytes)} used · ${Math.round(disk.usagePercent)}%` : "Its disk could not be read."} />
      <Tile label="Network" icon={<TileIcon icon={ArrowDataTransferVerticalIcon} color={CHART_COLOURS.down} />} pill={network ? <Pill>{network.interface}</Pill> : null} loading={loading} sample="10 KB/s up" value={down?.value ?? "–"} unit={down ? `${down.unit} down` : network ? "measuring" : "not read"} foot={network ? (network.txBytesPerSecond === null ? "Measuring…" : `${rateWords(network.txBytesPerSecond)} up`) : "Its network could not be read."} />
      {gpu ? <Tile label="GPU" icon={<TileIcon icon={GpuIcon} color={CHART_COLOURS.gpu} />} loading={false} sample="" value={wholePercent(gpu.gpuPercent)} unit="%" foot={[cpuState(gpu.gpuPercent), gpu.gpuTempC === null ? null : `${Math.round(gpu.gpuTempC)}°C`].filter(Boolean).join(" · ") || "Read"} /> : null}
      {slots.map((slot) => {
        const card = cards.find((item) => item.index === slot) ?? null;
        return <CardTile key={slot} card={card} cards={slots.length} slot={slot} read={!loading} own={!box || !card || countsAsThisBox(box, card)} />;
      })}
    </TileGrid>
    </div>
  );
}

const SLOT_SHARE_GUESS: SlotShare = { slots: 3, cores: 4, memoryBytes: 8 * 1024 ** 3 };

function SlotTiles({ snapshot }: { snapshot: MonitorSnapshot | null }) {
  const slot = snapshot?.slot ?? null;
  const share = slot?.share ?? null;
  const loading = !snapshot || !share;
  const host = slot?.host ?? "its Mac";
  const owner = `${hostAtStart(host)}'s`;
  const own = snapshot?.own ?? null;
  const percents = snapshot && share ? nowPercents(snapshot) : null;
  const ownMemory = own ? splitWords(bytesWords(own.memoryBytes)) : null;
  const disk = snapshot?.disk ?? null;
  const free = disk ? splitWords(bytesWords(disk.freeBytes)) : null;
  const macCpu = snapshot?.cpu.usagePercent ?? null;
  const load = snapshot?.cpu.loadAverage ?? null;
  const busy = snapshot ? hostBusy(snapshot) : false;
  return (
    <div className="border-b border-border">
      <TileGrid tiles={slot?.encoder ? 5 : 4}>
        <Tile label="This slot's CPU" icon={<TileIcon icon={CpuIcon} color={CHART_COLOURS.cpu} />} loading={loading} sample="1.5 of its 4 cores, of mac-1's 12" value={wholePercent(percents?.cpu)} unit={own ? "% of its share" : "not read"} foot={share && snapshot ? slotCpuWords(own?.cpuCores ?? null, share, host, snapshot.cpu.cores) : null} />
        <Tile label="This slot's memory" icon={<TileIcon icon={RamMemoryIcon} color={CHART_COLOURS.memory} />} loading={loading} sample="of its 8 GiB · 20%" value={ownMemory?.value ?? "–"} unit={ownMemory?.unit ?? "not read"} foot={share ? `of its ${bytesWords(share.memoryBytes)}${own ? ` · ${wholePercent(percents?.memory)}%` : ""}` : null} />
        <Tile
          label={`${hostAtStart(host)}, all slots`}
          icon={<TileIcon icon={ComputerIcon} color={CHART_COLOURS.host} />}
          pill={busy ? <Pill tone="warn">busy</Pill> : null}
          loading={loading}
          sample="memory 50% · 12 cores"
          value={macCpu !== null ? wholePercent(macCpu) : load ? load[0].toFixed(2) : "–"}
          unit={macCpu !== null ? "% CPU" : load ? "host load" : "not read"}
          foot={snapshot ? [macCpu !== null && load ? `host load ${load[0].toFixed(2)}` : null, `memory ${Math.round(snapshot.memory.usagePercent)}%`, `${snapshot.cpu.cores} cores`].filter(Boolean).join(" · ") : null}
        />
        {slot?.encoder ? (
          <Tile label={`${hostAtStart(slot.host)}'s encoder`} icon={<TileIcon icon={VideoReplayIcon} color={CHART_COLOURS.host} />} loading={false} sample="" value={wholePercent(slot.encoder.usedPercent)} unit="% used" foot={<span title={slot.encoder.words}>{slot.encoder.words}</span>} />
        ) : null}
        <Tile label={`${owner} disk`} icon={<TileIcon icon={HardDriveIcon} color={CHART_COLOURS.down} />} loading={loading} sample="of 460 GiB, every slot's files" value={free?.value ?? "–"} unit={free ? `${free.unit} free` : "not read"} foot={disk ? `of ${bytesWords(disk.totalBytes)}, every slot's files together` : "Its disk could not be read."} />
      </TileGrid>
      <p data-slot-line className="border-t border-border px-4 py-2 text-xs text-subtle-foreground" data-reveal={loading ? undefined : ""}>
        {loading ? <LoadingText sample={slotLineWords("mac-1", SLOT_SHARE_GUESS.slots)} /> : slotLineWords(slot!.host, share!.slots)}
      </p>
    </div>
  );
}

function TilesNow({ snapshot, shared, expectedCards, box = null }: { snapshot: MonitorSnapshot | null; shared: boolean; expectedCards: number; box?: Pick<BoxView, "form" | "backendLabel" | "claim" | "facts"> | null }) {
  return shared || snapshot?.slot ? <SlotTiles snapshot={snapshot} /> : <NowTiles snapshot={snapshot} expectedCards={expectedCards} box={box} />;
}

function TilesSayWhy({ shared, expectedCards, children }: { shared: boolean; expectedCards: number; children: ReactNode }) {
  return (
    <div className="relative" data-tiles-frame>
      <div aria-hidden className="invisible">
        <TilesNow snapshot={null} shared={shared} expectedCards={expectedCards} />
      </div>
      <div data-activity-quiet className="absolute inset-0 flex items-center overflow-hidden px-4 text-sm text-muted-foreground">
        <p className="line-clamp-3">{children}</p>
      </div>
    </div>
  );
}

type GpuLineKey = `gpu:${number}` | `gpuMemory:${number}`;

type LineKey = "cpu" | "memory" | "host" | GpuLineKey;

const GPU_MEMORY_HIDDEN: readonly GpuLineKey[] = Array.from({ length: MOST_CARDS }, (_, card) => `gpuMemory:${card}` as const);

interface CardLine {
  readonly card: number;
  readonly usage: readonly (number | null)[];
  readonly memory: readonly (number | null)[];
  readonly peaks?: readonly (number | null)[];
  readonly weights?: readonly number[];
}

function gpuLines(cards: readonly CardLine[]): (ChartSeries & { key: GpuLineKey; weights?: readonly number[] })[] {
  return cards.flatMap((line) => {
    const name = cardName({ index: line.card }, cards.length);
    const color = cardColour(line.card);
    return [
      { key: `gpu:${line.card}` as const, label: name, color, values: line.usage, ...(line.peaks ? { peaks: line.peaks } : {}), ...(line.weights ? { weights: line.weights } : {}), format: percentWords },
      { key: `gpuMemory:${line.card}` as const, label: `${name} memory`, color, dash: DASHES.memory, values: line.memory, format: percentWords },
    ];
  });
}

function emptyCards(count: number): CardLine[] {
  return Array.from({ length: count }, (_, card) => ({ card, usage: [], memory: [] }));
}

function liveCards(snapshot: MonitorSnapshot, expectedCards: number): CardLine[] {
  const points = snapshot.history;
  const read = [...(snapshot.gpus?.cards ?? []).map((card) => card.index), ...points.flatMap((point) => point.gpus?.map((each) => each.card) ?? [])];
  return cardSlots(read, expectedCards).map((card) => ({
    card,
    usage: points.map((point) => point.gpus?.find((each) => each.card === card)?.usage ?? null),
    memory: points.map((point) => point.gpus?.find((each) => each.card === card)?.memory ?? null),
  }));
}

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

function usageLines(snapshot: MonitorSnapshot, share: SlotShare | null, expectedCards: number): (ChartSeries & { key: LineKey })[] {
  const points = snapshot.history;
  if (!share) {
    return [
      { key: "cpu", label: "CPU", color: CHART_COLOURS.cpu, values: points.map((point) => point.cpuPercent), format: percentWords },
      { key: "memory", label: "Memory", color: CHART_COLOURS.memory, dash: DASHES.memory, values: points.map((point) => point.memoryPercent), format: percentWords },
      ...gpuLines(liveCards(snapshot, expectedCards)),
    ];
  }
  const host = snapshot.slot!.host;
  return [
    { key: "cpu", label: "This slot's CPU", color: CHART_COLOURS.cpu, values: points.map((point) => percentOfShare(point.ownCpuCores, share)), format: percentWords },
    { key: "memory", label: "This slot's memory", color: CHART_COLOURS.memory, dash: DASHES.memory, values: points.map((point) => memoryOfShare(point.ownMemoryBytes, share)), format: percentWords },
    { key: "host", label: `${hostAtStart(host)}'s CPU, all slots`, color: CHART_COLOURS.host, dash: DASHES.host, values: points.map((point) => point.cpuPercent), format: percentWords },
  ];
}

type ChartSpec = Omit<Parameters<typeof HistoryChart>[0], "series" | "height" | "ceiling" | "axis" | "reserveTicks">;

interface NetworkSpec {
  readonly whose: string | null;
  readonly series: readonly ChartSeries[];
  readonly ceiling: number;
  readonly chart: Omit<ChartSpec, "ticks">;
}

function ChartsBody<Key extends string>({
  lines,
  hidden,
  onToggle,
  words,
  usage,
  usageNote,
  network,
  held,
  onFocus,
  onBlur,
}: {
  lines: readonly (ChartSeries & { key: Key })[];
  hidden: ReadonlySet<Key>;
  onToggle: (key: Key) => void;
  words: ReactNode;
  usage: ChartSpec;
  usageNote?: string | null;
  network: NetworkSpec;
  held?: boolean;
  onFocus?: () => void;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
}) {
  const downUp = [
    { key: "down", label: "Download", color: CHART_COLOURS.down },
    { key: "up", label: "Upload", color: CHART_COLOURS.up, dash: DASHES.up },
  ];
  return (
    <div className="space-y-4 px-4 pb-3 pt-3" onFocus={onFocus} onBlur={onBlur} data-held={held ? "" : undefined} data-charts>
      <div className="space-y-1">
        <div className="-ml-2 flex flex-wrap items-center gap-1" role="group" aria-label="Lines shown">
          {lines.map((line) => (
            <LegendChip key={line.key} line={line} off={hidden.has(line.key)} onToggle={() => onToggle(line.key)} />
          ))}
        </div>
        <p className="text-xs text-subtle-foreground" data-chart-words>
          {words}
        </p>
      </div>
      <div className="space-y-1.5">
        <HistoryChart {...usage} series={lines.filter((line) => !hidden.has(line.key))} ceiling={100} height={CHART_HEIGHT} axis={["100%", "50%", "0%"]} reserveTicks />
        {usageNote ? (
          <p className="text-xs text-subtle-foreground" data-usage-note>
            {usageNote}
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <p className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className={cn("shrink-0 text-right text-foreground", AXIS_WIDTH)}>Network</span>
          {downUp.map((line) => (
            <span key={line.key} className="flex items-center gap-1.5">
              <SeriesSample color={line.color} dash={line.dash} />
              {line.label}
            </span>
          ))}
          {network.whose ? (
            <span data-network-whose className="min-w-0 truncate text-subtle-foreground">
              {network.whose}
            </span>
          ) : null}
        </p>
        <HistoryChart {...network.chart} series={network.series} ceiling={network.ceiling} height={NETWORK_HEIGHT} axis={[rateWords(network.ceiling), "0"]} ticks={[]} />
      </div>
    </div>
  );
}

function useHidden<Key extends string>(first: readonly Key[]): [ReadonlySet<Key>, (key: Key) => void] {
  const [hidden, setHidden] = useState<ReadonlySet<Key>>(() => new Set(first));
  const toggle = (key: Key) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return [hidden, toggle];
}

const SLOT_SHORT_WORK_WORDS = "Work shorter than a minute may not show here, as box history reads this slot once a minute. Live shows it.";

function slotLabels(host: string | null) {
  return { cpu: "This slot's CPU", memory: "This slot's memory", host: `${hostAtStart(host ?? "its Mac")}'s CPU, all slots` };
}

function liveSkeleton(shared: boolean, expectedCards: number): (ChartSeries & { key: LineKey })[] {
  const labels = shared ? slotLabels(null) : { cpu: "CPU", memory: "Memory", host: "" };
  return [
    { key: "cpu", label: labels.cpu, color: CHART_COLOURS.cpu, values: [], format: percentWords },
    { key: "memory", label: labels.memory, color: CHART_COLOURS.memory, dash: DASHES.memory, values: [], format: percentWords },
    ...(shared ? [{ key: "host" as const, label: labels.host, color: CHART_COLOURS.host, dash: DASHES.host, values: [], format: percentWords }] : gpuLines(emptyCards(expectedCards))),
  ];
}

const LIVE_FRAME_MS = 6 * 60_000;

type LiveLines = [ReadonlySet<LineKey>, (key: LineKey) => void];

function LiveFrame({ shared, expectedCards, words, lines: [hidden, toggle] }: { shared: boolean; expectedCards: number; words: string; lines: LiveLines }) {
  const now = Date.now();
  const window = { from: now - LIVE_FRAME_MS, to: now };
  const empty = { times: [], window, longestStepMs: LIVE_FRAME_MS, timeWords: clockWithSeconds, gapWords: "No reading" };
  return (
    <ChartsBody
      lines={liveSkeleton(shared, expectedCards)}
      hidden={hidden}
      onToggle={toggle}
      words={words}
      usage={{ ...empty, ticks: liveTicks(window), label: `${shared ? "This slot's CPU and memory" : usageWhat(expectedCards > 0)}, Live`, summary: words }}
      network={{ whose: shared ? "Its Mac, all slots" : null, series: [], ceiling: LEAST_RATE_CEILING * 1.15, chart: { ...empty, label: shared ? "Its Mac's download and upload, Live" : "Download and upload, Live", summary: words } }}
    />
  );
}

function Charts({ snapshot: live, share, expectedCards, lines: [hidden, toggle] }: { snapshot: MonitorSnapshot; share: SlotShare | null; expectedCards: number; lines: LiveLines }) {
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
  const words = liveWords(interval);
  const lines = usageLines(snapshot, share, expectedCards);
  const cpuLine = lines.find((line) => line.key === "cpu")!;
  const memoryLine = lines.find((line) => line.key === "memory")!;
  const down = points.map((point) => point.networkRxBytesPerSecond);
  const up = points.map((point) => point.networkTxBytesPerSecond);
  const ceiling = Math.max(LEAST_RATE_CEILING, ...down.map((value) => value ?? 0), ...up.map((value) => value ?? 0)) * 1.15;
  const host = share ? snapshot.slot!.host : null;
  const common = { times, window, longestStepMs: longestStepMs(interval), timeWords: clockWithSeconds, gapWords: "No reading" };
  return (
    <ChartsBody
      lines={lines}
      hidden={hidden}
      onToggle={toggle}
      words={held ? `Held at ${clockWithSeconds(Date.parse(held.timestamp))} while you read it` : `% used, ${words}`}
      held={Boolean(held)}
      onFocus={holdWhileRead}
      onBlur={goOnWhenLeft}
      usage={{ ...common, ticks: liveTicks(window), label: `${share ? "This slot's CPU and memory" : usageWhat(lines.length > 2 && !share)}, ${words}`, summary: usageSummary(words, times, { cpu: cpuLine, memory: memoryLine, gpus: lines.filter((line) => line.key.startsWith("gpu:")) }, gapsOf(times, cpuLine.values, interval), clockWithSeconds) }}
      network={{
        whose: host ? `${hostAtStart(host)}, all slots` : null,
        series: [
          { key: "down", label: "Download", color: CHART_COLOURS.down, values: down, format: rateWords },
          { key: "up", label: "Upload", color: CHART_COLOURS.up, dash: DASHES.up, values: up, format: rateWords },
        ],
        ceiling,
        chart: { ...common, label: `${host ? `${hostAtStart(host)}'s download and upload` : "Download and upload"}, ${words}`, summary: networkSummary(words, times, down, up, gapsOf(times, down, interval), clockWithSeconds) },
      }}
    />
  );
}

function usageWhat(gpu: boolean): string {
  return gpu ? "CPU, memory and GPU" : "CPU and memory";
}

export type ActivityRange = "live" | HistoryRange;

const RANGE_ORDER: readonly HistoryRange[] = ["1h", "24h", "7d"];

function RangeGroup({ value, onChange, liveWhy }: { value: ActivityRange; onChange: (range: ActivityRange) => void; liveWhy: string | null }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const options: { id: ActivityRange; label: string; why: string | null }[] = [{ id: "live", label: "Live", why: liveWhy }, ...RANGE_ORDER.map((id) => ({ id, label: RANGE_LABELS[id], why: null }))];
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
        <div className="flex min-w-0 flex-1 items-baseline gap-x-3">
          <h2 id="activity-heading" className="shrink-0 text-sm font-normal text-foreground">
            Activity
          </h2>
          {status ? <span className="min-w-0 truncate text-xs tabular-nums text-subtle-foreground">{status}</span> : null}
        </div>
        {group ? <div className="max-sm:w-full">{group}</div> : null}
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

type HistoryLineKey = "cpu" | "memory" | "disk" | "host" | GpuLineKey;

export function cardsOfSteps(steps: readonly HistoryStep[]): number[] {
  return [...new Set(steps.flatMap((step) => (step.gpus ?? []).map((gpu) => gpu.card)))].sort((left, right) => left - right);
}

function historyCards(steps: readonly HistoryStep[], range: HistoryRange, expectedCards: number): CardLine[] {
  const cards = cardSlots(cardsOfSteps(steps), expectedCards);
  const busiest = range !== "1h";
  const of = (step: HistoryStep, card: number) => step.gpus?.find((gpu) => gpu.card === card);
  return cards.map((card) => ({
    card,
    usage: steps.map((step) => of(step, card)?.usage ?? null),
    memory: steps.map((step) => of(step, card)?.memory ?? null),
    weights: steps.map((step) => of(step, card)?.covered ?? 0),
    ...(busiest ? { peaks: steps.map((step) => of(step, card)?.usageBusiest ?? null) } : {}),
  }));
}

function historyLines(steps: readonly HistoryStep[], range: HistoryRange, shared: boolean, host: string | null, expectedCards: number): (ChartSeries & { key: HistoryLineKey; weights?: readonly number[] })[] {
  const busiest = range !== "1h";
  const labels = shared ? slotLabels(host) : { cpu: "CPU", memory: "Memory", host: "" };
  return [
    { key: "cpu", label: labels.cpu, color: CHART_COLOURS.cpu, values: steps.map((step) => step.cpu), weights: steps.map((step) => step.cpuCovered), ...(busiest ? { peaks: steps.map((step) => step.cpuBusiest) } : {}), format: percentWords },
    { key: "memory", label: labels.memory, color: CHART_COLOURS.memory, dash: DASHES.memory, values: steps.map((step) => step.memory), weights: steps.map((step) => step.memoryCovered), format: percentWords },
    shared
      ? { key: "host", label: labels.host, color: CHART_COLOURS.host, dash: DASHES.host, values: steps.map((step) => step.host), format: percentWords }
      : { key: "disk", label: "Disk", color: CHART_COLOURS.down, dash: DASHES.disk, values: steps.map((step) => step.disk), format: percentWords },
    ...(shared ? [] : gpuLines(historyCards(steps, range, expectedCards))),
  ];
}

function sharedCardsWords(steps: readonly HistoryStep[]): string {
  const cards = cardsOfSteps(steps);
  const read = (card: number) => steps.flatMap((step) => step.gpus?.filter((gpu) => gpu.card === card && gpu.usage !== null) ?? []);
  const shared = cards.filter((card) => read(card).some((gpu) => gpu.shared));
  if (!shared.length) return "";
  const always = shared.every((card) => read(card).every((gpu) => gpu.shared));
  const names = shared.map((card) => cardName({ index: card }, cards.length));
  const one = shared.length === 1;
  return always
    ? ` ${names.join(" and ")} ${one ? "was" : "were"} shared with other boxes, so ${one ? "its lines are" : "their lines are"} the whole card's.`
    : ` ${names.join(" and ")} ${one ? "was" : "were"} shared with other boxes for some of this time, so ${one ? "its lines are" : "their lines are"} the whole card's then.`;
}

function gapAtStep(view: BoxHistoryView, step: HistoryStep | undefined): string {
  if (!step) return GAP_WORDS["no-reading"];
  const gap = view.gaps.find((each) => step.at >= each.from && step.at < each.to);
  return GAP_WORDS[gap?.kind ?? "no-reading"];
}

function HistoryWords({ view, range, held, failed }: { view: BoxHistoryView | null; range: HistoryRange; held: boolean; failed: string | null }) {
  if (view && failed) {
    return (
      <span data-history-stale className="text-warning-text" title={failed}>
        Could not refresh: as read at {historyClock(view.now)}
      </span>
    );
  }
  if (held) return <>Held while you read it</>;
  if (view && view.monitor && !view.kept) {
    return (
      <span data-history-off>
        Box history is off: what it kept stays.{" "}
        <SettingsLink view={{ page: "option", id: "monitor" }} className="cursor-pointer text-foreground underline underline-offset-2 hover:no-underline">
          Monitor settings
        </SettingsLink>
      </span>
    );
  }
  if (view?.full) {
    return (
      <span data-history-full className="text-warning-text" title={view.full}>
        Box history's file is full, so it keeps nothing new
      </span>
    );
  }
  return <>{`% used, ${RANGE_WORDS[range]}${range === "1h" ? "" : "; the light band is each step's busiest minute"}`}</>;
}

function HistoryCharts({ box, range, expectedCards }: { box: BoxView; range: HistoryRange; expectedCards: number }) {
  const { view: latest, error } = useBoxHistory(box.id, range, box.state);
  const shared = box.shared || Boolean(latest?.slot);
  const [hidden, toggle] = useHidden<HistoryLineKey>(["disk", "host", ...GPU_MEMORY_HIDDEN]);
  const [held, setHeld] = useState<BoxHistoryView | null>(null);
  const container = useRef<HTMLDivElement>(null);
  useRevealOnLoad(container, `${box.id}:${range}`, latest !== null);
  const view = held ?? latest;
  const holdWhileRead = () => setHeld((current) => current ?? latest);
  const goOnWhenLeft = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(null);
  };
  const now = view?.now ?? Date.now();
  const shape = view ?? { ...historyWindow(range, now), steps: [] as HistoryStep[], gaps: [], slot: null };
  const stepMs = view?.stepMs ?? HISTORY_RANGES[range].stepMs;
  const steps = shape.steps;
  const times = steps.map((step) => step.at + stepMs / 2);
  const window = historyBoundsOf(shape.from, shape.to, stepMs);
  const words = RANGE_WORDS[range];
  const clockOf = historyTimeWords(range, now);
  const timeWords = (centre: number) => stepSpanWords(range, centre - stepMs / 2, stepMs, clockOf);
  const host = view?.slot?.host ?? null;
  const lines = historyLines(steps, range, shared, host, expectedCards);
  const gpuUsage = lines.filter((line) => line.key.startsWith("gpu:"));
  const stepWords = (index: number) => stepWhenWords(range, steps[index]?.at ?? shape.from, stepMs, clockOf);
  const cpuLine = lines.find((line) => line.key === "cpu")!;
  const memoryLine = lines.find((line) => line.key === "memory")!;
  const gaps = view?.gaps ?? [];
  const bands: Band[] = gaps.map((gap) => ({ from: gap.from, to: gap.to, label: GAP_WORDS[gap.kind] }));
  const down = shared ? [] : steps.map((step) => step.down);
  const up = shared ? [] : steps.map((step) => step.up);
  const ceiling = Math.max(LEAST_RATE_CEILING, ...down.map((value) => value ?? 0), ...up.map((value) => value ?? 0)) * 1.15;
  const gapWords = (index: number) => (view ? gapAtStep(view, steps[index]) : GAP_WORDS["no-reading"]);
  const notes = (index: number) => {
    const step = steps[index];
    return step?.partial ? partlyReadWords(range, step.covered) : null;
  };
  const waiting = error ? `${PRODUCT} could not read ${box.name}'s history: ${error}` : "Reading its history…";
  const failed = view && error ? error : null;
  const staleWords = view && failed ? `${PRODUCT} could not read ${box.name}'s history again (${failed}), so this is as read at ${historyClock(view.now)}. ` : "";
  const common = { times, window, longestStepMs: stepMs * 1.5, timeWords, gapWords, notes, bands };
  const usageSummaryWords = view ? `${staleWords}${historySummary(words, { cpu: cpuLine, memory: memoryLine, gpus: gpuUsage }, gaps, stepWords, clockOf, now)}${sharedCardsWords(steps)}` : waiting;
  const shortWorkNote = shared && range !== "1h" ? SLOT_SHORT_WORK_WORDS : null;
  const networkSummaryWords = !view
    ? waiting
    : shared
      ? `${staleWords}${hostAtStart(host ?? "its Mac")}'s network is every slot's, so box history keeps none of it for a slot; Live shows it.`
      : `${staleWords}${historyNetworkSummary(words, down, up, steps.map((step) => step.netCovered), gaps, stepWords, clockOf, now)}`;
  return (
    <div ref={container} data-history={range} data-history-ready={view ? "" : undefined}>
      <span role="status" className="sr-only" data-history-announce>
        {staleWords.trim()}
      </span>
      <ChartsBody
        lines={lines}
        hidden={hidden}
        onToggle={toggle}
        words={view ? <HistoryWords view={view} range={range} held={Boolean(held)} failed={failed} /> : waiting}
        held={Boolean(held)}
        onFocus={holdWhileRead}
        onBlur={goOnWhenLeft}
        usage={{ ...common, ticks: historyTicks(range, window), label: `${shared ? "This slot's CPU and memory" : usageWhat(gpuUsage.length > 0)}, ${words}`, summary: usageSummaryWords }}
        usageNote={shortWorkNote}
        network={{
          whose: shared ? `${hostAtStart(host ?? "its Mac")}, all slots` : null,
          series: [
            { key: "down", label: "Download", color: CHART_COLOURS.down, values: down, format: rateWords },
            { key: "up", label: "Upload", color: CHART_COLOURS.up, dash: DASHES.up, values: up, format: rateWords },
          ],
          ceiling,
          chart: { ...common, label: `${shared ? `${hostAtStart(host ?? "its Mac")}'s download and upload` : "Download and upload"}, ${words}`, summary: networkSummaryWords },
        }}
      />
    </div>
  );
}

function SettingsWord({ children }: { children: ReactNode }) {
  return (
    <SettingsLink view={{ page: "option", id: "monitor" }} className="cursor-pointer text-foreground underline underline-offset-2 hover:no-underline">
      {children}
    </SettingsLink>
  );
}

export function notReadWords(box: BoxView, now: number): string {
  if (box.state === "stopped") {
    const stop = box.log?.lastStop;
    return stop ? `${box.name} is stopped, so ${PRODUCT} is not reading it. It stopped ${ago(stop.at, now)}, ${whenInSentence(stop.at, now)}.` : `${box.name} is stopped, so ${PRODUCT} is not reading it.`;
  }
  return `${box.name} is not running, so ${PRODUCT} is not reading it.`;
}

function notReadWhy(page: BoxPageState, box: BoxView, now: number): ReactNode {
  const reach = page.monitor;
  if (reach.is === "off") {
    return (
      <>
        The Monitor is off, so {PRODUCT} reads nothing now. What it read before stays. <SettingsWord>Turn it on in Monitor settings</SettingsWord>
      </>
    );
  }
  if (reach.is === "not-running") return notReadWords(box, now);
  return reach.why ?? `${PRODUCT} cannot read ${box.name}.`;
}

function processesWhy(page: BoxPageState, box: BoxView): string {
  const reach = page.monitor;
  if (reach.is === "off") return `The Monitor is off, so ${PRODUCT} lists no processes.`;
  if (reach.is === "not-running") return `${PRODUCT} lists ${box.name}'s processes while it runs.`;
  return `${PRODUCT} cannot list ${box.name}'s processes.`;
}

function liveWhyNot(page: BoxPageState, box: BoxView): string | null {
  const reach = page.monitor;
  if (reach.is === "read" && reach.machineId) return null;
  if (reach.is === "off") return "The Monitor is off";
  if (reach.is === "not-running") return `${box.name} is not running`;
  return reach.why ?? `${PRODUCT} cannot read ${box.name}`;
}

const chosenRanges = new Map<string, ActivityRange>();

function useChosenRange(boxId: string): [ActivityRange | null, (range: ActivityRange) => void] {
  const [chosen, setChosen] = useState<ActivityRange | null>(() => chosenRanges.get(boxId) ?? null);
  const choose = (range: ActivityRange) => {
    chosenRanges.set(boxId, range);
    setChosen(range);
  };
  return [chosenRanges.get(boxId) ?? chosen, choose];
}

export function forgetActivity(): void {
  chosenRanges.clear();
  keptHistory.clear();
}

export function expectedCardsOf(box: Pick<BoxView, "id" | "gpu" | "shared">): number {
  if (box.shared) return 0;
  return rememberedGpuCards(box.id) ?? (box.gpu ? 1 : 0);
}

export function Activity({ page, box, now }: { page: BoxPageState; box: BoxView; now: number }) {
  const reach = page.monitor;
  const [chosen, setChosen] = useChosenRange(box.id);
  const liveWhy = liveWhyNot(page, box);
  const range: ActivityRange = chosen === "live" && liveWhy ? "24h" : (chosen ?? (liveWhy ? "24h" : "live"));
  const group = <RangeGroup value={range} onChange={setChosen} liveWhy={liveWhy} />;
  const liveLines = useHidden<LineKey>(["host", ...GPU_MEMORY_HIDDEN]);
  const expectedCards = expectedCardsOf(box);
  if (reach.is === "read" && reach.machineId) return <LiveActivity key={reach.machineId} machineId={reach.machineId} box={box} range={range} group={group} lines={liveLines} expectedCards={expectedCards} />;
  return (
    <div className="space-y-5" data-activity-frame>
      <ActivityCard status={reach.is === "off" ? "Not read" : null} group={group}>
        <TilesSayWhy shared={box.shared} expectedCards={expectedCards}>{notReadWhy(page, box, now)}</TilesSayWhy>
        {range === "live" ? <LiveFrame shared={box.shared} expectedCards={expectedCards} words={liveWhy ?? ""} lines={liveLines} /> : <HistoryCharts key={range} box={box} range={range} expectedCards={expectedCards} />}
      </ActivityCard>
      <Processes snapshot={null} slot={box.shared} host={null} why={processesWhy(page, box)} gpu={expectedCards > 0} />
    </div>
  );
}

function readStatus(snapshot: MonitorSnapshot | null, error: string | null, active: boolean): string {
  if (snapshot && !error) return `Read at ${clockWithSeconds(Date.parse(snapshot.timestamp))}`;
  if (snapshot) return `Last read at ${minuteClock(Date.parse(snapshot.timestamp))}`;
  if (error) return "Not answering";
  return active ? "Reading…" : "Read while this page is shown";
}

function LiveActivity({ machineId, box, range, group, lines, expectedCards }: { machineId: string; box: BoxView; range: ActivityRange; group: ReactNode; lines: LiveLines; expectedCards: number }) {
  const { container, active, snapshot, error } = useMonitorSnapshot(machineId);
  const readCards = snapshot ? gpuCardCount(snapshot) : 0;
  const [seenCards, setSeenCards] = useState(expectedCards);
  const cards = Math.max(seenCards, readCards);
  useEffect(() => {
    if (readCards === 0) return;
    rememberGpuCards(box.id, readCards);
    setSeenCards((seen) => Math.max(seen, readCards));
  }, [box.id, readCards]);
  useRevealOnLoad(container, machineId, snapshot !== null);
  const errorWords = error ? loadErrorCopy(error, box.name) : null;
  const share = snapshot?.slot?.share ?? null;
  const shared = box.shared || Boolean(snapshot?.slot);
  const unanswered = errorWords && !snapshot ? `${errorWords} ${PRODUCT} tries again while this page is open.` : null;
  return (
    <div ref={container} className="space-y-5" aria-busy={active && !snapshot && !error} data-activity-frame>
      <ActivityCard status={readStatus(snapshot, error, active)} group={group}>
        {errorWords && snapshot ? (
          <p role="status" data-stale className="border-b border-border px-4 py-2 text-xs text-warning-text">
            {errorWords} Showing data from {minuteClock(Date.parse(snapshot.timestamp))}.
          </p>
        ) : null}
        {unanswered ? <TilesSayWhy shared={shared} expectedCards={cards}>{unanswered}</TilesSayWhy> : <TilesNow snapshot={snapshot} shared={shared} expectedCards={cards} box={box} />}
        {range !== "live" ? <HistoryCharts key={range} box={box} range={range} expectedCards={cards} /> : snapshot ? <Charts snapshot={snapshot} share={share} expectedCards={cards} lines={lines} /> : <LiveFrame shared={shared} expectedCards={cards} words={unanswered ? "Not read" : "Reading…"} lines={lines} />}
      </ActivityCard>
      <Processes snapshot={snapshot} slot={shared} host={snapshot?.slot?.host ?? null} why={unanswered ? `${PRODUCT} cannot list ${box.name}'s processes now.` : null} gpu={cards > 0 || Boolean(snapshot?.gpus)} />
    </div>
  );
}

function processMemory(bytes: number): string {
  return bytesWords(bytes);
}

type ProcessRow = MonitorSnapshot["processes"]["top"][number];

function ProcessCells({ process, gpu, gpuMemory }: { process: ProcessRow; gpu: boolean; gpuMemory: number | null }) {
  return (
    <>
      <td className="px-4 py-1.5 font-mono text-foreground" data-reveal="">
        <MiddleTruncate text={process.name} className="flex w-full" />
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums text-subtle-foreground max-sm:hidden" data-reveal="">
        {process.pid}
      </td>
      <td className={cn("px-2 py-1.5 text-right tabular-nums", process.cpuPercent >= 100 ? "text-warning-text" : "text-muted-foreground")} data-reveal="">{`${process.cpuPercent.toFixed(process.cpuPercent >= 100 ? 0 : 1)}%`}</td>
      <td className="py-1.5 pl-2 pr-4 text-right tabular-nums text-muted-foreground" data-reveal="">
        {processMemory(process.rssBytes)}
      </td>
      {gpu ? (
        <td className="py-1.5 pl-2 pr-4 text-right tabular-nums text-muted-foreground" data-reveal="" data-gpu-memory>
          {gpuMemory === null ? "–" : processMemory(gpuMemory)}
        </td>
      ) : null}
    </>
  );
}

const PROCESS_SAMPLES = ["node", "com.apple.Webkit", "dockerd", "systemd", "sshd", "bash"] as const;

function PlaceholderCells({ index, pulse, gpu }: { index: number; pulse: boolean; gpu: boolean }) {
  const text = (sample: string) => (pulse ? <LoadingText sample={sample} /> : "\u00a0");
  return (
    <>
      <td className="px-4 py-1.5 font-mono">{text(PROCESS_SAMPLES[index % PROCESS_SAMPLES.length]!)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums max-sm:hidden">{text("1234")}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{text("0.0%")}</td>
      <td className="py-1.5 pl-2 pr-4 text-right tabular-nums">{text("100 MiB")}</td>
      {gpu ? <td className="py-1.5 pl-2 pr-4 text-right tabular-nums">{text("1 GiB")}</td> : null}
    </>
  );
}

export function Processes({ snapshot, slot, host, why = null, gpu = false }: { snapshot: MonitorSnapshot | null; slot: boolean; host: string | null; why?: string | null; gpu?: boolean }) {
  const processes = snapshot?.processes ?? null;
  const read = processes?.available ? processes.top.slice(0, PROCESS_ROWS) : [];
  const said = why ?? (processes && !processes.available ? `${PRODUCT} could not list its processes.` : null);
  const pulse = !snapshot && !said;
  return (
    <section id="processes" aria-labelledby="processes-heading" data-processes className={cn("scroll-mt-4", CARD)} aria-busy={pulse || undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 id="processes-heading" tabIndex={-1} className="text-sm font-normal text-foreground focus:outline-none">
          {slot ? "This slot's processes" : "Top processes"}
        </h2>
        <span className="text-xs text-subtle-foreground">{slot ? `Its own user's only, not ${host ?? "its Mac"}'s` : "By CPU, by name only"}</span>
      </div>
      <div className="relative">
        <table className="w-full table-fixed text-xs" aria-hidden={said ? true : undefined}>
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
              {gpu ? (
                <th scope="col" className="w-20 py-2 pl-2 pr-4 text-right font-normal">
                  GPU
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className={cn("divide-y divide-border border-t border-border", said && "invisible")}>
            {Array.from({ length: PROCESS_ROWS }, (_, index) => {
              const process = said ? null : read[index];
              return process ? (
                <tr key={process.pid}>
                  <ProcessCells process={process} gpu={gpu} gpuMemory={gpuMemoryOf(snapshot?.gpus, process.pid)} />
                </tr>
              ) : (
                <tr key={`empty-${index}`} aria-hidden data-process-placeholder>
                  <PlaceholderCells index={index} pulse={pulse} gpu={gpu} />
                </tr>
              );
            })}
          </tbody>
        </table>
        {said ? (
          <p data-processes-quiet className="absolute inset-x-0 bottom-0 top-[33px] flex items-center px-4 text-sm text-muted-foreground">
            {said}
          </p>
        ) : null}
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-subtle-foreground">CPU is per core, so a process using four cores shows 400%.{gpu ? " GPU is the card memory a process uses for compute or drawing; processes on the GPU are always listed." : ""} {PRODUCT} reads names and PIDs only, never arguments or environment.</p>
    </section>
  );
}
