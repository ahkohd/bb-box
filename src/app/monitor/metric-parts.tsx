import { useId, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const METRIC_COLORS = {
  good: "#22c55e",
  warn: "#eab308",
  warnDim: "rgb(234 179 8 / 0.75)",
  badDim: "rgb(239 68 68 / 0.8)",
  gpu: "#f59e0b",
  bad: "#ef4444",
  memory: "#e5c07b",
  disk: "#5b8def",
  download: "#5b8def",
  upload: "#a78bfa",
} as const;

const CHART_HEIGHT = 28;

function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x0, y0] = points[index - 1] ?? points[index];
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    const [x3, y3] = points[index + 2] ?? points[index + 1];
    path += ` C${x1 + (x2 - x0) / 6},${y1 + (y2 - y0) / 6} ${x2 - (x3 - x1) / 6},${y2 - (y3 - y1) / 6} ${x2},${y2}`;
  }
  return path;
}

export interface Series {
  values: Array<number | null>;
  color: string;
}

export function LineChart({ series, max, label }: { series: Series[]; max?: number; label: string }) {
  const gradientId = useId();
  const length = Math.max(2, ...series.map((line) => line.values.length));
  const ceiling = max ?? Math.max(1, ...series.flatMap((line) => line.values.map((value) => value ?? 0))) * 1.15;
  const toPoints = (values: Array<number | null>): Array<[number, number]> =>
    values.flatMap((value, index) =>
      value === null
        ? []
        : [[(index / (length - 1)) * 100, CHART_HEIGHT - Math.min(1, value / ceiling) * (CHART_HEIGHT - 2) - 1]],
    );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 100 ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      className="block h-7 w-full overflow-visible"
    >
      {series.map((line, index) => {
        const points = toPoints(line.values);
        if (points.length === 0) return null;
        const path = smoothPath(points);
        const first = points[0];
        const last = points[points.length - 1];
        return (
          <g key={index}>
            {index === 0 ? (
              <>
                <defs>
                  <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={line.color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={line.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <path d={`${path} L${last[0]},${CHART_HEIGHT} L${first[0]},${CHART_HEIGHT} Z`} fill={`url(#${gradientId})`} />
              </>
            ) : null}
            <path d={path} fill="none" stroke={line.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
  );
}

export function BarChart({ values, colorFor, label, slots }: { values: Array<number | null>; colorFor: (value: number) => string; label: string; slots: number }) {
  const recent = values.slice(-slots);
  const padded = [...Array.from({ length: slots - recent.length }, () => null), ...recent];
  return (
    <div className="flex h-7 items-end gap-[3px]" role="img" aria-label={label}>
      {padded.map((value, index) => (
        <span
          key={index}
          className="min-w-0 flex-1 rounded-[2px] bg-sidebar-border"
          style={{
            height: `${value === null ? 14 : Math.max(14, Math.min(100, value))}%`,
            backgroundColor: value === null ? undefined : colorFor(value),
          }}
        />
      ))}
    </div>
  );
}

export function ProgressBar({ value, color, label }: { value: number; color: string; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-sidebar-border"
    >
      <div className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${clamped}%`, backgroundColor: color }} />
    </div>
  );
}

const PULSE = "animate-pulse motion-reduce:animate-none";

export function LoadingText({ sample }: { sample: string }) {
  return (
    <span aria-hidden="true" className={cn(PULSE, "select-none rounded-sm bg-foreground/[0.07] text-transparent")}>
      {sample}
    </span>
  );
}

export function Pill({ children, tone = "neutral", loading = false }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad"; loading?: boolean }) {
  return (
    <span
      aria-hidden={loading || undefined}
      data-reveal={loading ? undefined : ""}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-sidebar-accent px-1.5 text-2xs tabular-nums text-subtle-foreground",
        tone === "warn" && "text-[#eab308]",
        tone === "bad" && "text-[#ef4444]",
        loading && cn(PULSE, "select-none text-transparent"),
      )}
    >
      {children}
    </span>
  );
}

export function BigValue({ value, unit, loading = false }: { value: ReactNode | null; unit?: string; loading?: boolean }) {
  return (
    <p className="flex items-baseline gap-1 leading-none" aria-label={loading ? "Loading" : undefined} data-reveal={loading ? undefined : ""}>
      <span className="text-2xl font-semibold tabular-nums tracking-tight text-sidebar-foreground">
        {loading ? <LoadingText sample="00" /> : value ?? "–"}
      </span>
      <span className="text-xs text-muted-foreground">{loading || value === null ? "\u00a0" : unit}</span>
    </p>
  );
}

export function MetricSection({
  label,
  icon,
  pill,
  details,
  children,
}: {
  label: string;
  icon?: ReactNode;
  pill?: ReactNode;
  details?: ReactNode;
  children: ReactNode;
}) {
  const body = (
    <section
      aria-label={label}
      tabIndex={details ? 0 : undefined}
      className="min-w-0 space-y-2 p-3 outline-none focus-visible:bg-sidebar-accent/40"
    >
      <div className="flex min-h-5 items-center justify-between gap-3 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-sidebar-foreground">
          {icon}
          {label}
        </span>
        {pill}
      </div>
      {children}
    </section>
  );
  if (!details) return body;
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-64 space-y-1 text-xs">
        {details}
      </TooltipContent>
    </Tooltip>
  );
}

export function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="opacity-70">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export function Footnote({ children }: { children: ReactNode }) {
  return <p className="truncate text-xs text-subtle-foreground" data-reveal="">{children}</p>;
}
