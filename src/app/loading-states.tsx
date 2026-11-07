import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { EmptyPanel } from "./common.tsx";

export const LOADING_SHOWN_AFTER_MS = 150;

export function useShownAfter(delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);
  return shown;
}

export function WhileLoading({ words, className, children }: { words: string; className?: string; children: ReactNode }) {
  if (!useShownAfter(LOADING_SHOWN_AFTER_MS)) return null;
  return (
    <div role="status" data-loading className={className}>
      <span className="sr-only">{words}</span>
      <div aria-hidden className="contents">
        {children}
      </div>
    </div>
  );
}

function Bar({ className }: { className: string }) {
  return <Skeleton className={cn("motion-reduce:animate-none", className)} />;
}

const NAME_WIDTHS = ["w-28", "w-36", "w-24", "w-32", "w-20"] as const;

const LINE_WIDTHS = ["w-56", "w-44", "w-64", "w-48", "w-52"] as const;

function widthAt(widths: readonly string[], index: number): string {
  return widths[index % widths.length]!;
}

function NameLine({ index, withSystem = true }: { index: number; withSystem?: boolean }) {
  return (
    <span className="flex h-[1lh] min-w-0 items-center gap-2 text-sm">
      <Bar className={cn("h-3.5 max-w-full", widthAt(NAME_WIDTHS, index))} />
      {withSystem ? <Bar className="h-3 w-12 max-sm:hidden" /> : null}
    </span>
  );
}

function StatusLineBar({ index }: { index: number }) {
  return (
    <span className="mt-0.5 flex h-[1lh] min-w-0 items-center gap-1.5 text-xs leading-snug">
      <Bar className="size-1.5 shrink-0 rounded-full" />
      <Bar className={cn("h-3 max-w-full", widthAt(LINE_WIDTHS, index))} />
    </span>
  );
}

function ActionSpaces({ count, chevron = false }: { count: number; chevron?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="flex size-7 items-center justify-center">
          <Bar className="size-4 rounded-sm" />
        </span>
      ))}
      {chevron ? <span className="ml-0.5 size-7" /> : null}
    </span>
  );
}

function NarrowWrapBar() {
  return (
    <span className="flex h-[1lh] items-center pl-3 text-xs leading-snug sm:hidden">
      <Bar className="h-3 w-24" />
    </span>
  );
}

export function BoxRowSkeleton({ index, onPage = false }: { index: number; onPage?: boolean }) {
  return (
    <div data-skeleton-row className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 py-3">
      <span className="flex size-6 items-center justify-center">
        <Bar className="size-4 rounded-sm" />
      </span>
      <span className="block min-w-0">
        <NameLine index={index} />
        <StatusLineBar index={index} />
        {onPage ? <NarrowWrapBar /> : null}
      </span>
      <ActionSpaces count={3} chevron={onPage} />
    </div>
  );
}

export function BoxRowsSkeleton({ rows, onPage = false, className }: { rows: number; onPage?: boolean; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card px-4", className)}>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, index) => (
          <BoxRowSkeleton key={index} index={index} onPage={onPage} />
        ))}
      </div>
    </div>
  );
}

export function ThreadCardSkeleton({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="mt-1.5 flex h-7 items-center gap-3 pl-4 pr-3">
        <Bar className="h-3.5 w-40 max-w-full" />
      </div>
      <div className="mt-1.5 divide-y divide-border px-4">
        {Array.from({ length: rows }, (_, index) => (
          <BoxRowSkeleton key={index} index={index + 1} onPage />
        ))}
      </div>
    </div>
  );
}

export function SearchRowSkeleton({ tools = 2 }: { tools?: number }) {
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
      <span className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input px-2.5 sm:w-auto sm:flex-1">
        <Icon name="Search" className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
      </span>
      {tools ? (
        <span className="flex w-max shrink-0 items-center gap-1.5">
          {Array.from({ length: tools }, (_, index) => (
            <span key={index} className="size-8 rounded-md border border-input" />
          ))}
        </span>
      ) : null}
    </div>
  );
}

export function NewBoxButtonSpace() {
  return (
    <Button type="button" size="sm" tabIndex={-1} aria-hidden className="invisible">
      <Icon name="Plus" aria-hidden />
      New box
    </Button>
  );
}

export function BoxListSkeleton({ threads }: { threads: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      <SearchRowSkeleton />
      {threads ? <ThreadCardSkeleton rows={3} /> : <BoxRowsSkeleton rows={4} onPage />}
    </div>
  );
}

export function SnapshotsSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <span className="flex h-[1lh] items-center text-xs leading-snug">
        <Bar className="h-3 w-72 max-w-full" />
      </span>
      <SearchRowSkeleton tools={3} />
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="box-content flex h-[1lh] items-center gap-2 pl-4 pr-3 pt-3 text-sm">
          <Bar className="h-3.5 w-28" />
          <Bar className="h-3 w-16" />
        </div>
        <div className="divide-y divide-border px-4">
          {[0, 1, 2].map((index) => (
            <div key={index} data-skeleton-row className="flex min-w-0 items-start gap-3 py-3">
              <span className="block min-w-0 flex-1">
                <NameLine index={index + 2} withSystem={false} />
                <StatusLineBar index={index + 1} />
              </span>
              <span className="size-7 shrink-0 self-center" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsRowSkeleton({ index }: { index: number }) {
  return (
    <div data-skeleton-row className="flex items-center gap-3 px-4 py-2.5">
      <Bar className="size-5 shrink-0 rounded-sm" />
      <span className="flex h-5 min-w-0 flex-1 items-center">
        <Bar className={cn("h-3.5 max-w-full", widthAt(NAME_WIDTHS, index))} />
      </span>
      <Bar className={cn("h-3 max-sm:hidden", index % 2 ? "w-20" : "w-28")} />
    </div>
  );
}

function SettingsGroupSkeleton({ rows, first }: { rows: number; first: number }) {
  return (
    <div className="space-y-2.5">
      <span className="flex h-[1lh] items-center text-xs">
        <Bar className="h-3 w-24" />
      </span>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="divide-y divide-border">
          {Array.from({ length: rows }, (_, index) => (
            <SettingsRowSkeleton key={index} index={first + index} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SettingsSkeleton() {
  return (
    <div className="space-y-5">
      <SearchRowSkeleton tools={0} />
      <SettingsGroupSkeleton rows={3} first={0} />
      <SettingsGroupSkeleton rows={4} first={3} />
    </div>
  );
}

export function ImageRowsSkeleton() {
  return (
    <div className="divide-y divide-border">
      {[0, 1].map((index) => (
        <div key={index} data-skeleton-row className="px-4 py-2.5">
          <span className="flex h-[1lh] items-center gap-1.5 text-sm">
            <Bar className={cn("h-3.5", widthAt(NAME_WIDTHS, index + 1))} />
            <Bar className="h-3 w-16" />
          </span>
          <StatusLineBar index={index + 3} />
        </div>
      ))}
    </div>
  );
}

export function BoxPageSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 size-9 shrink-0 rounded-lg border border-border bg-card" />
          <span className="block min-w-0">
            <span className="flex h-[1lh] items-center text-lg leading-tight">
              <Bar className="h-4 w-40 max-w-full" />
            </span>
            <span className="mt-1 flex h-[1lh] items-center gap-1.5 text-sm">
              <Bar className="size-1.5 shrink-0 rounded-full" />
              <Bar className="h-3 w-48 max-w-full" />
            </span>
            <span className="mt-1 flex h-[1lh] items-center text-xs">
              <Bar className="h-3 w-32" />
            </span>
          </span>
        </div>
        <span className="flex items-center gap-1.5">
          <span className="h-8 w-24 rounded-md border border-input" />
          <span className="size-8 rounded-md border border-input" />
        </span>
      </div>
      {[3, 2].map((rows, card) => (
        <div key={card} className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="divide-y divide-border">
            {Array.from({ length: rows }, (_, index) => (
              <div key={index} data-skeleton-row className="flex items-center justify-between gap-3 px-4 py-2.5">
                <Bar className={cn("h-3", widthAt(NAME_WIDTHS, card + index))} />
                <Bar className={cn("h-3", widthAt(LINE_WIDTHS, card + index + 1))} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function LoadFailed({ what, error, onRetry, className }: { what: string; error: string; onRetry: () => Promise<unknown> | void; className?: string }) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <EmptyPanel role="alert" title={`${what} did not load.`} className={className}>
      <p className="mt-1 break-words">{error}</p>
      <Button type="button" variant="outline" size="sm" className="mt-3" disabled={retrying} onClick={() => void retry()}>
        {retrying ? <Icon name="Loading" className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
        Try again
      </Button>
    </EmptyPanel>
  );
}
