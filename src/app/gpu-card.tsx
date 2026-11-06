import { useId, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GpuCard as MonitorGpu, GpuProcess, GpuReading } from "../monitor/snapshot.ts";
import type { BoxPageState, MonitorReach } from "../plugin/contract.ts";
import {
  cardHeading,
  gpuFactValue,
  gpuFooter,
  gpuProgramsWords,
  holdsItsCard,
  monitorCard,
  partOf,
  readCardFact,
  USERSPACE_UPDATE_REFUSAL,
  userspaceGap,
  otherCheckNotice,
  userspaceNotice,
  wrongCardNotice,
  type GpuMate,
} from "../plugin/gpu-page.ts";
import type { BoxView } from "../plugin/views.ts";
import { bytesWords } from "./activity-words.ts";
import { hostOf, type ThreadTitles } from "./box-words.ts";
import { useBoxesNav } from "./box-nav.tsx";
import { boxPage } from "./box-route.ts";
import { useMonitorSnapshot } from "./monitor/use-snapshot.ts";

function Notice({ tone, title, children, actions }: { tone: "bad" | "warn"; title: string; children: ReactNode; actions?: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-notice={tone} className={cn("rounded-lg border px-4 py-3", tone === "bad" ? "border-surface-destructive-border bg-surface-destructive" : "border-warning/40 bg-warning/5")}>
      <h2 id={headingId} className={cn("text-sm font-normal", tone === "bad" ? "text-destructive-text" : "text-warning-text")}>
        {title}
      </h2>
      <div className="mt-1 text-sm text-foreground">{children}</div>
      {actions ? <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">{actions}</div> : null}
    </section>
  );
}

export function GpuNotices({ box, onUpdate }: { box: BoxView; onUpdate: () => void }) {
  const wrong = wrongCardNotice(box);
  const userspace = userspaceNotice(box);
  const other = otherCheckNotice(box);
  const gap = userspaceGap(box);
  if (!wrong && !userspace && !other) return null;
  return (
    <div className="space-y-3">
      {wrong ? (
        <Notice tone="warn" title="On the wrong card">
          {wrong}
        </Notice>
      ) : null}
      {other ? (
        <Notice tone="warn" title="The card check failed">
          {other}
        </Notice>
      ) : null}
      {userspace ? (
        <Notice
          tone="warn"
          title="NVIDIA's userspace does not match the host's driver"
          actions={
            gap?.running ? (
              <Button type="button" variant="outline" size="sm" className="h-7 font-normal" onClick={onUpdate}>
                Update NVIDIA's userspace…
              </Button>
            ) : null
          }
        >
          {userspace}
        </Notice>
      ) : null}
    </div>
  );
}

function workingWords(box: BoxView, titles: ThreadTitles, threads: BoxPageState["threads"]): string {
  const names = threads.map((thread) => titles[thread.id] ?? thread.title ?? thread.id).filter(Boolean);
  if (!names.length) return "";
  const listed = names.length === 1 ? `"${names[0]}"` : names.map((name) => `"${name}"`).join(", ");
  return ` ${listed} ${names.length === 1 ? "works" : "work"} on it: ${names.length === 1 ? "its" : "their"} work stops while it restarts.`;
}

export function UpdateUserspaceDialog({ box, titles, threads, monitor, onClose }: { box: BoxView; titles: ThreadTitles; threads: BoxPageState["threads"]; monitor: MonitorReach; onClose: () => void }) {
  const gap = userspaceGap(box);
  const machineId = monitor.is === "read" ? monitor.machineId : null;
  const reading = useMonitorSnapshot(machineId ?? "gpu-unread");
  const [refused, setRefused] = useState<string | null>(null);
  if (!gap) return null;
  const card = monitorCard(reading.snapshot?.gpus?.cards ?? [], readCardFact(gpuFactValue(box) ?? "")?.model ?? null);
  const processes = (reading.snapshot?.gpus?.processes ?? []).filter((process) => card === null || process.card === card.index);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="shadow-none" data-userspace-update>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base font-normal">Update NVIDIA's userspace in {box.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            bb-box installs NVIDIA's userspace {gap.host} over {gap.boxVersion}, for the host's driver, then restarts {box.name}. Everything running in it stops{gpuProgramsWords(processes)}.{workingWords(box, titles, threads)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-xs leading-snug text-muted-foreground">It never runs by itself. If {box.name} has NVIDIA's packages from apt, bb-box says so and changes nothing.</p>
        {refused ? (
          <p role="alert" className="text-xs text-destructive-text">
            {refused}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel className="font-normal">Cancel</AlertDialogCancel>
          <Button type="button" className="font-normal" onClick={() => setRefused(USERSPACE_UPDATE_REFUSAL)}>
            Update and restart
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function widthOf(part: number | null, total: number | null): string {
  if (part === null || !total) return "0%";
  return `${Math.min(100, Math.max(0, (part / total) * 100))}%`;
}

function memoryParts(card: MonitorGpu | null): { mine: number | null; other: number | null; free: number | null; used: number | null; total: number | null } {
  if (!card) return { mine: null, other: null, free: null, used: null, total: null };
  const { memoryUsedBytes: used, memoryTotalBytes: total, ownMemoryBytes: mine } = card;
  const other = used !== null && mine !== null ? Math.max(0, used - mine) : null;
  const free = used !== null && total !== null ? Math.max(0, total - used) : null;
  return { mine, other, free, used, total };
}

function Memory({ card, waiting }: { card: MonitorGpu | null; waiting: string | null }) {
  const parts = memoryParts(card);
  const known = parts.total !== null && parts.used !== null;
  const value = waiting ?? (known ? `${bytesWords(parts.used!)} of ${bytesWords(parts.total!)} used` : "Not read");
  const legend: readonly [string, number | null, string][] = parts.mine === null && parts.other === null
    ? [
        ["Used", parts.used, "bg-foreground"],
        ["Free", parts.free, "border border-border bg-surface-recessed"],
      ]
    : [
        ["This box", parts.mine, "bg-foreground"],
        ["Other use", parts.other, "bg-foreground/45"],
        ["Free", parts.free, "border border-border bg-surface-recessed"],
      ];
  return (
    <div className="min-h-[4.5rem] space-y-1.5" data-gpu-memory>
      <div className="flex min-h-4 items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Memory on the card</span>
        <span className="tabular-nums text-foreground">{value}</span>
      </div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-surface-recessed"
        role="img"
        aria-label={legend.map(([label, amount]) => `${label} ${amount === null ? "not read" : bytesWords(amount)}`).join(", ")}
      >
        {known && parts.mine !== null ? <span className="h-full bg-foreground" style={{ width: widthOf(parts.mine, parts.total) }} /> : null}
        {known && parts.other !== null ? <span className="h-full border-l border-card bg-foreground/45" style={{ width: widthOf(parts.other, parts.total) }} /> : null}
        {known && parts.mine === null ? <span className="h-full bg-foreground" style={{ width: widthOf(parts.used, parts.total) }} /> : null}
      </div>
      <dl className="flex min-h-4 flex-wrap gap-x-4 gap-y-1 text-xs">
        {legend.map(([label, amount, swatch]) => (
          <div key={label} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2 rounded-sm", swatch)} />
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular-nums text-foreground">{amount === null ? "–" : bytesWords(amount)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Processes({ processes, waiting }: { processes: readonly GpuProcess[] | null; waiting: string | null }) {
  return (
    <div className="min-h-8 space-y-1" data-gpu-processes>
      <p className="text-xs text-muted-foreground">Its processes on the card</p>
      {waiting ? <p className="text-xs text-subtle-foreground">{waiting}</p> : null}
      {!waiting && processes === null ? <p className="text-xs text-subtle-foreground">bb-box could not read which processes use the card.</p> : null}
      {!waiting && processes !== null && !processes.length ? <p className="text-xs text-subtle-foreground">None now.</p> : null}
      {!waiting && processes?.length ? (
        <ul className="space-y-0.5 text-xs">
          {processes.map((process) => (
            <li key={process.pid} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3">
              <span className="truncate text-foreground">{process.name}</span>
              <span className="tabular-nums text-muted-foreground">{process.pid}</span>
              <span className="w-16 text-right tabular-nums text-foreground">{process.memoryBytes === null ? "–" : bytesWords(process.memoryBytes)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MateChip({ mate }: { mate: GpuMate }) {
  const nav = useBoxesNav();
  const route = boxPage(mate.id);
  const stopped = mate.state === "stopped";
  return (
    <a href={nav.href(route)} onClick={nav.onLink(route)} className="inline-flex h-6 cursor-pointer items-center rounded-full border border-border bg-background px-2 text-xs font-normal text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      {mate.name}
      {stopped ? <span className="pl-1 text-muted-foreground">stopped</span> : null}
    </a>
  );
}

function memoryWaiting(reach: MonitorReach, box: BoxView): string {
  if (reach.is === "not-running") return box.state === "stopped" ? "Not read while it is stopped." : "Not read while it is not running.";
  if (reach.is === "off") return "The Monitor is off.";
  return reach.why ?? "Not read.";
}

function readingOf(reach: MonitorReach, snapshot: { readonly gpus?: GpuReading | null } | null, box: BoxView): { card: MonitorGpu | null; processes: readonly GpuProcess[] | null; memoryWaiting: string | null; processWaiting: string | null } {
  const model = readCardFact(gpuFactValue(box) ?? "")?.model ?? null;
  if (reach.is !== "read") {
    const waiting = memoryWaiting(reach, box);
    return { card: null, processes: box.state === "stopped" ? [] : null, memoryWaiting: waiting, processWaiting: box.state === "stopped" ? null : waiting };
  }
  if (!snapshot) return { card: null, processes: null, memoryWaiting: "Reading the card…", processWaiting: "Reading the card…" };
  const card = monitorCard(snapshot.gpus?.cards ?? [], model);
  const processes = snapshot.gpus ? (snapshot.gpus.processes?.filter((process) => card === null || process.card === card.index) ?? null) : null;
  return { card, processes, memoryWaiting: null, processWaiting: null };
}

export function GpuCard({ box, mates, monitor, busy, onChange }: { box: BoxView; mates: readonly GpuMate[]; monitor: MonitorReach; busy: boolean; onChange: () => void }) {
  const machineId = monitor.is === "read" ? monitor.machineId : null;
  const container = useMonitorSnapshot(machineId ?? "gpu-unread");
  const read = readCardFact(gpuFactValue(box) ?? "");
  const part = partOf(box);
  const shown = readingOf(monitor, container.snapshot, box);
  const use = shown.card?.usagePercent ?? null;
  const holding = mates.length + (holdsItsCard(box) ? 1 : 0);
  const host = hostOf(box.backendLabel);
  return (
    <section ref={machineId ? container.container : undefined} aria-label="GPU card" className="overflow-hidden rounded-lg border border-border bg-card" data-gpu-card>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-1 pt-2.5">
        <h2 className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-sm font-normal text-foreground">
          GPU
          <span className="text-xs font-normal text-muted-foreground">{cardHeading(box)}</span>
        </h2>
        <Button type="button" variant="outline" size="sm" className="h-7 font-normal" disabled={busy} onClick={onChange}>
          Change…
        </Button>
      </div>
      <div className="space-y-3 px-4 py-3">
        <Memory card={shown.memoryWaiting ? null : shown.card} waiting={shown.memoryWaiting} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Card use</dt>
            <dd className="tabular-nums text-foreground">{use === null ? "–" : `${Math.round(use)}%`}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Boxes holding it</dt>
            <dd className="tabular-nums text-foreground">{holding}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Index{host ? ` on ${host}` : ""}</dt>
            <dd className="tabular-nums text-foreground">{read ? read.index : "–"}</dd>
          </div>
        </dl>
        <Processes processes={shown.processWaiting ? null : shown.processes} waiting={shown.processWaiting} />
        {part === "shared" || mates.length ? (
          <div className="min-h-8 space-y-1">
            <p className="text-xs text-muted-foreground">Other boxes on this card</p>
            {mates.length ? (
              <div className="flex flex-wrap gap-1.5">
                {mates.map((mate) => (
                  <MateChip key={mate.id} mate={mate} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-subtle-foreground">None now.</p>
            )}
          </div>
        ) : null}
        <p className="min-h-4 text-xs leading-snug text-subtle-foreground">{gpuFooter(box, host)}</p>
      </div>
    </section>
  );
}
