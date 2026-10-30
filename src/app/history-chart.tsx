import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { readOutWords } from "./activity-words.ts";

export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly dash?: string;
  readonly values: readonly (number | null)[];
  readonly format: (value: number) => string;
}

export interface Tick {
  readonly at: number;
  readonly words: string;
}

export interface ChartWindow {
  readonly from: number;
  readonly to: number;
}

const WIDTH = 1000;
export const AXIS_WIDTH = "w-14";

const MOVES: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, PageDown: -10, PageUp: 10 };

export function linesOf(values: readonly (number | null)[], times: readonly number[], longestStepMs: number): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((value, index) => {
    const broken = index > 0 && times[index]! - times[index - 1]! > longestStepMs;
    if (value === null || broken) {
      if (run.length) runs.push(run);
      run = [];
    }
    if (value !== null) run.push([times[index]!, value]);
  });
  if (run.length) runs.push(run);
  return runs;
}

function smooth(points: Array<[number, number]>): string {
  if (!points.length) return "";
  if (points.length === 1) return `M${points[0]![0]},${points[0]![1]} h0.01`;
  let path = `M${points[0]![0]},${points[0]![1]}`;
  for (let index = 0; index < points.length - 1; index++) {
    const [x0, y0] = points[index - 1] ?? points[index]!;
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[index + 1]!;
    const [x3, y3] = points[index + 2] ?? points[index + 1]!;
    path += ` C${x1 + (x2 - x0) / 6},${y1 + (y2 - y0) / 6} ${x2 - (x3 - x1) / 6},${y2 - (y3 - y1) / 6} ${x2},${y2}`;
  }
  return path;
}

export function SeriesSample({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 6" className="h-1.5 w-4 shrink-0 overflow-visible">
      <line x1="0" x2="16" y1="3" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  );
}

export function HistoryChart({
  series,
  times,
  window: span,
  longestStepMs,
  ceiling,
  height,
  ticks,
  label,
  summary,
  axis,
  timeWords,
  gapWords,
}: {
  series: readonly ChartSeries[];
  times: readonly number[];
  window: ChartWindow;
  longestStepMs: number;
  ceiling: number;
  height: number;
  ticks: readonly Tick[];
  label: string;
  summary: string;
  axis: readonly string[];
  timeWords: (at: number) => string;
  gapWords: string;
}) {
  const clipId = useId();
  const summaryId = useId();
  const surface = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const count = times.length;
  const length = Math.max(1, span.to - span.from);
  const share = (at: number) => Math.max(0, Math.min(1, (at - span.from) / length));
  const x = (at: number) => share(at) * WIDTH;
  const y = (value: number) => height - Math.min(1, Math.max(0, value) / ceiling) * (height - 4) - 2;
  const nearest = (at: number) => {
    let best = 0;
    times.forEach((time, index) => {
      if (Math.abs(time - at) < Math.abs(times[best]! - at)) best = index;
    });
    return best;
  };
  const track = (event: PointerEvent<HTMLDivElement>) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box || !count) return;
    setHover(nearest(span.from + Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * length));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!count) return;
    if (event.key === "Escape") {
      if (hover !== null) event.preventDefault();
      setHover(null);
      return;
    }
    const jump: Record<string, number> = { Home: 0, End: count - 1 };
    if (event.key in jump) {
      event.preventDefault();
      setHover(jump[event.key]!);
      return;
    }
    const move = MOVES[event.key];
    if (move === undefined) return;
    event.preventDefault();
    setHover((current) => Math.max(0, Math.min(count - 1, (current ?? count) + move)));
  };
  const at = hover === null ? null : Math.min(hover, count - 1);
  const shown = at === null ? null : series.map((line) => ({ line, value: line.values[at] ?? null }));
  const anyValue = shown?.some((each) => each.value !== null) ?? false;
  const spoken = at === null ? "" : readOutWords(series, at, timeWords(times[at]!), gapWords);
  return (
    <div className="flex gap-2">
      <div className={cn("flex shrink-0 flex-col justify-between py-0.5 text-right text-2xs tabular-nums text-subtle-foreground", AXIS_WIDTH)} style={{ height }} aria-hidden>
        {axis.map((words) => (
          <span key={words} className="leading-none">
            {words}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div
          ref={surface}
          data-history-chart
          className="relative touch-none select-none rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ height }}
          onPointerMove={track}
          onPointerDown={track}
          onPointerLeave={() => setHover(null)}
          onKeyDown={keys}
          onBlur={() => setHover(null)}
          tabIndex={0}
          role="application"
          aria-roledescription="chart"
          aria-label={label}
          aria-describedby={summaryId}
        >
          <span id={summaryId} className="sr-only">
            {summary} With focus, Left and Right read each point, Home and End the first and last.
          </span>
          <span data-read-out className="sr-only" aria-live="polite" aria-atomic="true">
            {spoken}
          </span>
          <svg aria-hidden viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
            <defs>
              <clipPath id={clipId}>
                <rect x="0" y="-4" width={WIDTH} height={height + 8} />
              </clipPath>
            </defs>
            {[0, 0.5, 1].map((part) => (
              <line key={part} x1="0" x2={WIDTH} y1={y(ceiling * part)} y2={y(ceiling * part)} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray={part === 0 ? undefined : "2 4"} />
            ))}
            {ticks.map((tick) => (
              <line key={`tick-${tick.at}`} x1={x(tick.at)} x2={x(tick.at)} y1={height - 3} y2={height + 2} stroke="var(--input)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            <g clipPath={`url(#${clipId})`}>
              {series.map((line) =>
                linesOf(line.values, times, longestStepMs).map((run) => (
                  <path key={`${line.key}-${run[0]![0]}`} d={smooth(run.map(([time, value]) => [x(time), y(value)]))} fill="none" stroke={line.color} strokeWidth="1.75" strokeDasharray={line.dash} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
                )),
              )}
            </g>
            {at !== null ? <line x1={x(times[at]!)} x2={x(times[at]!)} y1="0" y2={height} stroke="var(--input)" strokeWidth="1" vectorEffect="non-scaling-stroke" /> : null}
          </svg>
          {at !== null && shown
            ? shown.map(({ line, value }) =>
                value === null ? null : <span key={line.key} aria-hidden className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card" style={{ left: `${share(times[at]!) * 100}%`, top: y(value), backgroundColor: line.color }} />,
              )
            : null}
          {at !== null && shown ? (
            <div aria-hidden data-chart-tip className={cn("pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border border-border bg-popover px-2.5 py-2 text-xs", share(times[at]!) > 0.6 ? "-translate-x-[calc(100%+10px)]" : "translate-x-[10px]")} style={{ left: `${share(times[at]!) * 100}%` }}>
              <p className="mb-1 text-subtle-foreground">{timeWords(times[at]!)}</p>
              {anyValue ? (
                shown.map(({ line, value }) => (
                  <p key={line.key} className="flex items-center justify-between gap-4 tabular-nums">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <SeriesSample color={line.color} dash={line.dash} />
                      {line.label}
                    </span>
                    <span className="text-foreground">{value === null ? "–" : line.format(value)}</span>
                  </p>
                ))
              ) : (
                <p className="text-muted-foreground">{gapWords}</p>
              )}
            </div>
          ) : null}
        </div>
        {ticks.length ? (
          <div aria-hidden className="relative mt-1.5 h-4 text-2xs tabular-nums text-subtle-foreground">
            {ticks.map((tick) => {
              const part = share(tick.at);
              return (
                <span key={tick.at} className={cn("absolute whitespace-nowrap", part < 0.04 ? "" : part > 0.96 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${part * 100}%` }}>
                  {tick.words}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
