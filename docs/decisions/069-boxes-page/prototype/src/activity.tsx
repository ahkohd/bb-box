import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDataTransferVerticalIcon, ComputerIcon, CpuIcon, HardDriveIcon, RamMemoryIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { BigValue, Footnote, LoadingText, Pill } from "@/src/app/monitor/metric-parts.tsx";
import { MiddleTruncate } from "@/src/app/monitor/middle-truncate.tsx";
import { AXIS_WIDTH, HistoryChart, SeriesSample, type Band, type ChartSeries, type Tick } from "./chart";
import { HOUR, MINUTE, type FakeBox } from "./data";
import { hasAnyHistory, history, hostHistory, hostPointAt, pointAt, RANGES, running, type Gap, type Point, type Range } from "./history";
import { go } from "./nav";
import { useStore } from "./store";
import { bytes, clock, dayAndClock, rate } from "./words";

const FIRST_READING_MS = 900;

export const CHART = {
  cpu: "var(--chart-cpu)",
  memory: "var(--chart-memory)",
  disk: "var(--chart-disk)",
  down: "var(--chart-down)",
  up: "var(--chart-up)",
  host: "var(--chart-host)",
} as const;

const DASHES = { memory: "6 4", disk: "1 4", up: "6 4", host: "10 4" } as const;

function useFirstReading(boxId: string, live: boolean): boolean {
  const [readAt, setReadAt] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    const timer = window.setTimeout(() => setReadAt(boxId), FIRST_READING_MS);
    return () => window.clearTimeout(timer);
  }, [boxId, live]);
  return readAt === boxId;
}

function RadioGroup<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { id: T; label: string; disabled?: string | null }[]; onChange: (value: T) => void; label: string }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = enabled.indexOf(options.findIndex((option) => option.id === value));
    const next = enabled[(at + step + enabled.length) % enabled.length]!;
    onChange(options[next]!.id);
    buttons.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={keys} className="inline-flex items-center gap-0.5 rounded-md bg-surface-recessed p-0.5">
      {options.map((option, index) => (
        <button
          key={option.id}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          aria-disabled={!!option.disabled}
          aria-description={option.disabled ?? undefined}
          tabIndex={value === option.id ? 0 : -1}
          title={option.disabled ?? undefined}
          onClick={() => (option.disabled ? undefined : onChange(option.id))}
          className={cn(
            "h-6 cursor-pointer rounded-[5px] px-2 text-xs tabular-nums transition-colors aria-disabled:cursor-default aria-disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            value === option.id ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Tile({ label, icon, pill, children }: { label: ReactNode; icon: ReactNode; pill?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2 px-4 py-3">
      <div className="flex min-h-5 items-center justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          {icon}
          <span className="truncate">{label}</span>
        </span>
        {pill}
      </div>
      {children}
    </section>
  );
}

function TileIcon({ icon, color }: { icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; color: string }) {
  return <HugeiconsIcon icon={icon} className="size-3.5 shrink-0 opacity-90" style={{ color }} aria-hidden="true" />;
}

function cpuPill(box: FakeBox, cpu: number): ReactNode {
  if (box.view.form === "LXC" || box.view.form === "Docker") {
    const pressure = Math.max(0, Math.round((cpu - 70) * 1.6));
    return <Pill tone={pressure >= 50 ? "bad" : pressure >= 25 ? "warn" : "neutral"}>pressure {pressure}%</Pill>;
  }
  return <Pill>load {((cpu / 100) * box.load.cores).toFixed(2)}</Pill>;
}

const TILES = "grid grid-cols-2 border-b border-border [&>*]:border-border max-lg:[&>*:nth-child(odd)]:border-r max-lg:[&>*:not(:nth-last-child(-n+2))]:border-b lg:divide-x";

function NowTiles({ box, now, ready }: { box: FakeBox; now: number; ready: boolean }) {
  const point = pointAt(box, now, 5_000);
  const cpu = point.cpu ?? 0;
  const memory = point.memory ?? 0;
  const disk = point.disk ?? 0;
  const loading = (sample: string) => <LoadingText sample={sample} />;
  return (
    <div className={cn(TILES, "lg:grid-cols-4")}>
      <Tile label="CPU" icon={<TileIcon icon={CpuIcon} color={CHART.cpu} />} pill={ready ? cpuPill(box, cpu) : <Pill loading>pressure 0%</Pill>}>
        <BigValue value={ready ? Math.round(cpu) : null} unit="%" loading={!ready} />
        <Footnote>{ready ? `${box.load.cores} cores` : loading("4 cores")}</Footnote>
      </Tile>
      <Tile label="Memory" icon={<TileIcon icon={RamMemoryIcon} color={CHART.memory} />} pill={ready ? <Pill tone={memory >= 95 ? "bad" : memory >= 85 ? "warn" : "neutral"}>{memory >= 95 ? "Critical" : memory >= 85 ? "High" : "Normal"}</Pill> : <Pill loading>Normal</Pill>}>
        <BigValue value={ready ? Math.round(memory) : null} unit="%" loading={!ready} />
        <Footnote>{ready ? `${bytes((memory / 100) * box.load.memoryGiB)} of ${bytes(box.load.memoryGiB)}` : loading("4.0 GiB of 8 GiB")}</Footnote>
      </Tile>
      <Tile label="Disk" icon={<TileIcon icon={HardDriveIcon} color={CHART.disk} />} pill={ready ? <Pill>{bytes(box.load.diskGiB)}</Pill> : <Pill loading>32 GiB</Pill>}>
        <BigValue value={ready ? bytes(box.load.diskGiB - (disk / 100) * box.load.diskGiB).split(" ")[0] : null} unit="GiB free" loading={!ready} />
        <Footnote>{ready ? `${bytes((disk / 100) * box.load.diskGiB)} used · ${Math.round(disk)}%` : loading("12 GiB used · 40%")}</Footnote>
      </Tile>
      <Tile label="Network" icon={<TileIcon icon={ArrowDataTransferVerticalIcon} color={CHART.down} />} pill={ready ? <Pill>eth0</Pill> : <Pill loading>eth0</Pill>}>
        <BigValue value={ready ? rate(point.rxKiB ?? 0).split(" ")[0] : null} unit={ready ? `${rate(point.rxKiB ?? 0).split(" ")[1]} down` : undefined} loading={!ready} />
        <Footnote>{ready ? `${rate(point.txKiB ?? 0)} up` : loading("10 KB/s up")}</Footnote>
      </Tile>
    </div>
  );
}

function SlotTiles({ box, now, ready }: { box: FakeBox; now: number; ready: boolean }) {
  const host = box.shared!;
  const own = pointAt(box, now, 5_000);
  const mac = hostPointAt(box, now, 5_000);
  const ownCpu = own.cpu ?? 0;
  const ownMemoryGiB = ((own.memory ?? 0) / 100) * host.memoryGiB;
  const loading = (sample: string) => <LoadingText sample={sample} />;
  const busyHost = (mac.cpu ?? 0) >= 85;
  return (
    <div className="border-b border-border">
      <div className={cn(TILES, "border-b-0 lg:grid-cols-5")}>
        <Tile label="This slot's CPU" icon={<TileIcon icon={CpuIcon} color={CHART.cpu} />}>
          <BigValue value={ready ? Math.round(ownCpu) : null} unit={`% of ${host.name}`} loading={!ready} />
          <Footnote>{ready ? `About ${((ownCpu / 100) * host.cores).toFixed(1)} of ${host.cores} cores` : loading("1.2 of 12 cores")}</Footnote>
        </Tile>
        <Tile label="This slot's memory" icon={<TileIcon icon={RamMemoryIcon} color={CHART.memory} />}>
          <BigValue value={ready ? ownMemoryGiB.toFixed(1) : null} unit="GiB" loading={!ready} />
          <Footnote>{ready ? `${Math.round(own.memory ?? 0)}% of ${host.name}'s ${host.memoryGiB} GiB` : loading("5% of 32 GiB")}</Footnote>
        </Tile>
        <Tile label={`${host.name}, all slots`} icon={<TileIcon icon={ComputerIcon} color={CHART.host} />} pill={busyHost ? <Pill tone="warn">busy</Pill> : undefined}>
          <BigValue value={ready ? Math.round(mac.cpu ?? 0) : null} unit="% CPU" loading={!ready} />
          <Footnote>{ready ? `Host load ${(1 + ((mac.cpu ?? 0) / 100) * host.cores * 0.6).toFixed(2)} · memory ${Math.round(mac.memory ?? 0)}%` : loading("Host load 5.12 · memory 71%")}</Footnote>
        </Tile>
        <Tile label={`${host.name}'s encoder`} icon={<TileIcon icon={ComputerIcon} color={CHART.host} />}>
          <BigValue value={ready ? host.encoderUsed : null} unit="% used" loading={!ready} />
          <Footnote>{ready ? "Room for 1 more stream" : loading("Room for 1 more")}</Footnote>
        </Tile>
        <Tile label={`${host.name}'s disk`} icon={<TileIcon icon={HardDriveIcon} color={CHART.disk} />}>
          <BigValue value={ready ? Math.round(host.diskGiB - host.diskUsedGiB) : null} unit="GiB free" loading={!ready} />
          <Footnote>{ready ? `This slot's files: ${bytes(box.load.diskUsedGiB)}` : loading("3.1 GiB")}</Footnote>
        </Tile>
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-subtle-foreground">
        This slot is a macOS user on {host.name}, shared with {host.otherSlots} other slots. Its CPU and memory are its own processes'. {host.name}'s numbers are every slot's together, and never make this slot busy.
      </p>
    </div>
  );
}

const GAP_WORDS: Readonly<Record<Gap, string>> = {
  "not-made": "Not made yet",
  stopped: "Stopped",
  starting: "Starting",
  "no-reading": "No reading",
  off: "Not read",
};

function bandsOf(points: readonly Point[]): Band[] {
  const bands: Band[] = [];
  let start: number | null = null;
  let kind: Gap | null = null;
  points.forEach((point, index) => {
    if (point.gap !== kind) {
      if (kind && start !== null) bands.push({ from: start, to: Math.max(start + 0.6, index - 0.5), label: GAP_WORDS[kind] });
      start = point.gap ? index : null;
      kind = point.gap;
    }
  });
  if (kind && start !== null) bands.push({ from: start, to: points.length - 1, label: GAP_WORDS[kind] });
  return bands;
}

const TICK_STEPS: Readonly<Record<Range, number>> = { live: 2 * MINUTE, hour: 15 * MINUTE, day: 6 * HOUR, week: 24 * HOUR };

function ticksOf(points: readonly Point[], range: Range): Tick[] {
  const start = points[0]?.at ?? 0;
  const end = points.at(-1)?.at ?? 0;
  const step = TICK_STEPS[range];
  const offset = range === "week" || range === "day" ? -new Date(end).getTimezoneOffset() * MINUTE : 0;
  const ticks: Tick[] = [];
  for (let at = Math.ceil((start + offset) / step) * step - offset; at <= end; at += step) {
    ticks.push({ at, words: range === "week" ? new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at) : clock(at) });
  }
  return ticks;
}

function summaryOf(points: readonly Point[], words: string, timeWords: (at: number) => string): string {
  const read = points.filter((point) => point.cpu !== null);
  if (!read.length) return `No readings over ${words}.`;
  const mean = read.reduce((sum, point) => sum + (point.cpu ?? 0), 0) / read.length;
  const top = read.reduce((best, point) => ((point.cpuPeak ?? point.cpu ?? 0) > (best.cpuPeak ?? best.cpu ?? 0) ? point : best));
  const memory = read.at(-1)?.memory ?? 0;
  const gaps = bandsOf(points).map((band) => `${band.label} from ${timeWords(points[Math.floor(band.from)]?.at ?? 0)}`);
  return `Over ${words}: CPU averaged ${Math.round(mean)}%, highest ${Math.round(top.cpuPeak ?? top.cpu ?? 0)}% at ${timeWords(top.at)}; memory last ${Math.round(memory)}%.${gaps.length ? ` ${gaps.join("; ")}.` : ""}`;
}

type SeriesKey = "cpu" | "memory" | "disk" | "host";

export function Activity({ box, now }: { box: FakeBox; now: number }) {
  const store = useStore();
  const reading = store.monitorOn && box.view.state === "ready" && running(box, now);
  const [range, setRange] = useState<Range>(reading ? "live" : "day");
  const shownRange: Range = !reading && range === "live" ? "day" : range;
  const [hidden, setHidden] = useState<ReadonlySet<SeriesKey>>(new Set(["disk", "host"]));
  const read = useFirstReading(box.view.id, reading);
  const points = useMemo(() => history(box, shownRange, now, store.offSince), [box, shownRange, now, store.offSince]);
  const hostPoints = useMemo(() => (box.shared ? hostHistory(box, shownRange, now) : []), [box, shownRange, now]);
  const spec = RANGES.find((each) => each.id === shownRange)!;
  const slot = !!box.shared;
  const series: (ChartSeries & { key: SeriesKey })[] = [
    { key: "cpu", label: slot ? "This slot's CPU" : "CPU", color: CHART.cpu, values: points.map((point) => point.cpu), peaks: shownRange === "day" || shownRange === "week" ? points.map((point) => point.cpuPeak) : undefined, format: (value) => `${Math.round(value)}%` },
    { key: "memory", label: slot ? "This slot's memory" : "Memory", color: CHART.memory, dash: DASHES.memory, values: points.map((point) => point.memory), format: (value) => `${Math.round(value)}%` },
    ...(slot
      ? [{ key: "host" as const, label: `${box.shared!.name}'s CPU, all slots`, color: CHART.host, dash: DASHES.host, values: hostPoints.map((point) => point.cpu), format: (value: number) => `${Math.round(value)}%` }]
      : [{ key: "disk" as const, label: "Disk", color: CHART.disk, dash: DASHES.disk, values: points.map((point) => point.disk), format: (value: number) => `${Math.round(value)}%` }]),
  ];
  const visible = series.filter((line) => !hidden.has(line.key));
  const network: ChartSeries[] = [
    { key: "down", label: "Down", color: CHART.down, values: points.map((point) => point.rxKiB), format: rate },
    { key: "up", label: "Up", color: CHART.up, dash: DASHES.up, values: points.map((point) => point.txKiB), format: rate },
  ];
  const ceiling = Math.max(64, ...points.map((point) => point.rxKiB ?? 0)) * 1.15;
  const bands = bandsOf(points);
  const empty = !hasAnyHistory(points);
  const timeWords = (at: number) => (shownRange === "week" || shownRange === "day" ? dayAndClock(at, now) : clock(at));
  const gapWords = (index: number) => GAP_WORDS[points[index]?.gap ?? "no-reading"];
  const ticks = ticksOf(points, shownRange);
  const status = !store.monitorOn ? null : box.unreachable ? `Not answering since ${clock(box.unreachable.since)}` : box.backendGone ? "Not read: its backend is not in settings" : reading ? (read ? `Read at ${clock(now)}` : "Reading…") : "Not running";
  return (
    <section aria-labelledby="activity-heading" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 id="activity-heading" className="text-sm font-medium text-foreground">
            Activity
          </h2>
          {status ? <span className="truncate text-xs text-subtle-foreground">{status}</span> : null}
        </div>
        <RadioGroup<Range>
          label="Time range"
          value={shownRange}
          onChange={setRange}
          options={RANGES.map((each) => ({ id: each.id, label: each.label, disabled: each.id === "live" && !reading ? (store.monitorOn ? `${box.view.name} is not being read now` : "The Monitor is off") : null }))}
        />
      </div>
      {!store.monitorOn ? (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          The Monitor is off, so bb-box reads nothing now. What it read before stays.{" "}
          <button type="button" className="cursor-pointer text-foreground underline underline-offset-2" onClick={() => go({ page: "settings", section: "monitor" })}>
            Turn it on in Monitor settings
          </button>
        </p>
      ) : !store.historyOn ? (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          Box history is off: 1 h, 24 h and 7 d keep what was read before.{" "}
          <button type="button" className="cursor-pointer text-foreground underline underline-offset-2" onClick={() => go({ page: "settings", section: "monitor" })}>
            Monitor settings
          </button>
        </p>
      ) : null}
      {reading ? slot ? <SlotTiles box={box} now={now} ready={read} /> : <NowTiles box={box} now={now} ready={read} /> : null}
      <div className="space-y-4 px-4 pb-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Lines shown">
            {series.map((line) => {
              const off = hidden.has(line.key);
              return (
                <button
                  key={line.key}
                  type="button"
                  aria-pressed={!off}
                  onClick={() =>
                    setHidden((current) => {
                      const next = new Set(current);
                      if (off) next.delete(line.key);
                      else next.add(line.key);
                      return next;
                    })
                  }
                  className={cn("inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", off ? "text-subtle-foreground hover:text-muted-foreground" : "text-foreground hover:bg-state-hover")}
                >
                  <span className={cn(off && "opacity-30")}>
                    <SeriesSample color={line.color} dash={line.dash} />
                  </span>
                  {line.label}
                </button>
              );
            })}
          </div>
          <span className="text-xs text-subtle-foreground">
            % used, {spec.words}
            {shownRange === "day" || shownRange === "week" ? "; the light band is each step's busiest minute of CPU" : ""}
          </span>
        </div>
        {empty ? (
          <p className="py-10 text-center text-xs text-subtle-foreground">No readings in this range.</p>
        ) : (
          <HistoryChart series={visible} times={points.map((point) => point.at)} ceiling={100} height={168} axis={["100%", "50%", "0%"]} ticks={ticks} bands={bands} label={`CPU and memory, ${spec.words}`} summary={summaryOf(points, spec.words, timeWords)} timeWords={timeWords} gapWords={gapWords} />
        )}
        {!empty && !slot ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className={cn("shrink-0 text-right font-medium text-foreground", AXIS_WIDTH)}>Network</span>
              {network.map((line) => (
                <span key={line.key} className="flex items-center gap-1.5">
                  <SeriesSample color={line.color} dash={line.dash} />
                  {line.label}
                </span>
              ))}
            </p>
            <HistoryChart series={network} times={points.map((point) => point.at)} ceiling={ceiling} height={56} axis={[rate(ceiling), "0"]} ticks={[]} bands={bands} label={`Network, ${spec.words}`} summary={`Download and upload over ${spec.words}.`} timeWords={timeWords} gapWords={gapWords} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function Processes({ box, now }: { box: FakeBox; now: number }) {
  const store = useStore();
  const live = store.monitorOn && box.view.state === "ready" && running(box, now);
  const read = useFirstReading(box.view.id, live);
  if (!live || !box.processes.length) return null;
  const bucket = Math.floor(now / 5_000);
  const rows = box.processes.map((process, index) => ({ ...process, cpu: Math.max(0, process.cpu * (0.85 + (((bucket * 7 + index * 13) % 10) / 30))) })).sort((a, b) => b.cpu - a.cpu);
  return (
    <section id="processes" aria-labelledby="processes-heading" className="scroll-mt-4 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-baseline justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 id="processes-heading" className="text-sm font-medium text-foreground">
          {box.shared ? "This slot's processes" : "Top processes"}
        </h2>
        <span className="text-xs text-subtle-foreground">{box.shared ? `Its own user's only, not ${box.shared.name}'s` : "By CPU, by name only"}</span>
      </div>
      <table className="w-full table-fixed text-xs">
        <thead>
          <tr className="text-subtle-foreground">
            <th className="px-4 py-2 text-left font-normal">Process</th>
            <th className="w-20 px-2 py-2 text-right font-normal max-sm:hidden">PID</th>
            <th className="w-16 px-2 py-2 text-right font-normal">CPU</th>
            <th className="w-20 py-2 pl-2 pr-4 text-right font-normal">Memory</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border border-t border-border">
          {rows.map((process) => (
            <tr key={process.pid}>
              <td className="px-4 py-1.5 font-mono text-foreground">{read ? <MiddleTruncate text={process.name} className="flex w-full" /> : <LoadingText sample={process.name} />}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-subtle-foreground max-sm:hidden">{read ? process.pid : <LoadingText sample="0000" />}</td>
              <td className={cn("px-2 py-1.5 text-right tabular-nums", process.cpu >= 100 ? "text-warning-text" : "text-muted-foreground")}>{read ? `${process.cpu.toFixed(process.cpu >= 100 ? 0 : 1)}%` : <LoadingText sample="0.0%" />}</td>
              <td className="py-1.5 pl-2 pr-4 text-right tabular-nums text-muted-foreground">{read ? (process.memoryMiB >= 1024 ? `${(process.memoryMiB / 1024).toFixed(1)} GiB` : `${process.memoryMiB} MiB`) : <LoadingText sample="000 MiB" />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-4 py-2 text-xs text-subtle-foreground">CPU is per core: a process using four cores shows 400%. bb-box reads names and PIDs only, never arguments or environment.</p>
    </section>
  );
}
