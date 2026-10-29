import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly dash?: string;
  readonly values: readonly (number | null)[];
  readonly peaks?: readonly (number | null)[];
  readonly format: (value: number) => string;
}

export interface Band {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

export interface Tick {
  readonly at: number;
  readonly words: string;
}

const WIDTH = 1000;
export const AXIS_WIDTH = "w-14";

function segments(values: readonly (number | null)[]): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push([index, value]);
  });
  if (run.length) runs.push(run);
  return runs;
}

function smooth(points: Array<[number, number]>): string {
  if (!points.length) return "";
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

const MOVES: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, PageDown: -10, PageUp: 10 };

export function HistoryChart({
  series,
  times,
  ceiling,
  height,
  ticks,
  bands,
  label,
  summary,
  axis,
  timeWords,
  gapWords,
}: {
  series: readonly ChartSeries[];
  times: readonly number[];
  ceiling: number;
  height: number;
  ticks: readonly Tick[];
  bands: readonly Band[];
  label: string;
  summary: string;
  axis: readonly string[];
  timeWords: (at: number) => string;
  gapWords: (index: number) => string;
}) {
  const clipId = useId();
  const summaryId = useId();
  const surface = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const count = Math.max(2, times.length);
  const start = times[0] ?? 0;
  const end = times.at(-1) ?? 1;
  const x = (index: number) => (index / (count - 1)) * WIDTH;
  const y = (value: number) => height - Math.min(1, value / ceiling) * (height - 4) - 2;
  const share = (at: number) => Math.max(0, Math.min(1, (at - start) / Math.max(1, end - start)));
  const track = (event: PointerEvent<HTMLDivElement>) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return;
    setHover(Math.round(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * (count - 1)));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const jump: Record<string, number> = { Home: 0, End: count - 1 };
    if (event.key === "Escape") {
      setHover(null);
      return;
    }
    if (event.key in jump) {
      event.preventDefault();
      setHover(jump[event.key]!);
      return;
    }
    const move = MOVES[event.key];
    if (move === undefined) return;
    event.preventDefault();
    setHover((current) => Math.max(0, Math.min(count - 1, (current ?? count - 1) + move)));
  };
  const shown = hover === null ? null : series.map((line) => ({ line, value: line.values[hover] ?? null, peak: line.peaks?.[hover] ?? null }));
  const anyValue = shown?.some((each) => each.value !== null) ?? false;
  const spoken = hover === null || !shown ? "" : `${timeWords(times[hover] ?? 0)}: ${anyValue ? shown.map(({ line, value, peak }) => `${line.label} ${value === null ? "no reading" : line.format(value)}${peak !== null && value !== null && peak - value >= 5 ? `, busiest minute ${line.format(peak)}` : ""}`).join(", ") : gapWords(hover)}`;
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
          className="relative touch-none select-none rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ height }}
          onPointerMove={track}
          onPointerDown={track}
          onPointerLeave={() => setHover(null)}
          onKeyDown={keys}
          onBlur={() => setHover(null)}
          tabIndex={0}
          role="img"
          aria-label={label}
          aria-describedby={summaryId}
        >
          <span id={summaryId} className="sr-only">
            {summary} Left and Right read each point; Home and End go to the first and last.
          </span>
          <span className="sr-only" aria-live="polite" aria-atomic="true">
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
              <line key={`tick-${tick.at}`} x1={share(tick.at) * WIDTH} x2={share(tick.at) * WIDTH} y1={height - 3} y2={height + 2} stroke="var(--input)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {bands.map((band) => (
              <rect key={`${band.from}-${band.label}`} x={x(band.from)} y="0" width={Math.max(2, x(band.to) - x(band.from))} height={height} fill="var(--surface-recessed)" />
            ))}
            <g clipPath={`url(#${clipId})`}>
              {series.map((line) =>
                line.peaks
                  ? segments(line.values.map((value, index) => (value === null ? null : index))).map((run) => {
                      const top = run.map(([index]) => [x(index), y(line.peaks![index] ?? line.values[index] ?? 0)] as [number, number]);
                      const bottom = run.map(([index]) => [x(index), y(line.values[index] ?? 0)] as [number, number]).reverse();
                      return <path key={`${line.key}-peak-${run[0]![0]}`} d={`${smooth(top)} L${bottom.map(([px, py]) => `${px},${py}`).join(" L")} Z`} fill={line.color} opacity={0.2} />;
                    })
                  : null,
              )}
              {series.map((line) =>
                segments(line.values).map((run) => (
                  <path key={`${line.key}-${run[0]![0]}`} d={smooth(run.map(([index, value]) => [x(index), y(value)]))} fill="none" stroke={line.color} strokeWidth="1.75" strokeDasharray={line.dash} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
                )),
              )}
            </g>
            {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} stroke="var(--input)" strokeWidth="1" vectorEffect="non-scaling-stroke" /> : null}
          </svg>
          {bands.map((band) =>
            x(band.to) - x(band.from) > 90 ? (
              <span key={`label-${band.from}`} aria-hidden className="pointer-events-none absolute top-1.5 -translate-x-1/2 whitespace-nowrap text-2xs text-subtle-foreground" style={{ left: `${((band.from + band.to) / 2 / (count - 1)) * 100}%` }}>
                {band.label}
              </span>
            ) : null,
          )}
          {hover !== null && shown
            ? shown.map(({ line, value }) =>
                value === null ? null : <span key={line.key} aria-hidden className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card" style={{ left: `${(hover / (count - 1)) * 100}%`, top: y(value), backgroundColor: line.color }} />,
              )
            : null}
          {hover !== null && shown ? (
            <div aria-hidden className={cn("pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border border-border bg-popover px-2.5 py-2 text-xs shadow-md", hover / (count - 1) > 0.6 ? "-translate-x-[calc(100%+10px)]" : "translate-x-[10px]")} style={{ left: `${(hover / (count - 1)) * 100}%` }}>
              <p className="mb-1 text-subtle-foreground">{timeWords(times[hover] ?? 0)}</p>
              {anyValue ? (
                shown.map(({ line, value, peak }) => (
                  <p key={line.key} className="flex items-center justify-between gap-4 tabular-nums">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <SeriesSample color={line.color} dash={line.dash} />
                      {line.label}
                    </span>
                    <span className="text-foreground">
                      {value === null ? "–" : line.format(value)}
                      {peak !== null && value !== null && peak - value >= 5 ? <span className="text-subtle-foreground"> · busiest {line.format(peak)}</span> : null}
                    </span>
                  </p>
                ))
              ) : (
                <p className="text-muted-foreground">{gapWords(hover)}</p>
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
