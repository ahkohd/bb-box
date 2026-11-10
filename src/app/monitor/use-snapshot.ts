import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Contract, MonitorSnapshot } from "../../plugin/contract.ts";
import { createSnapshotSource } from "./snapshot-source.ts";
import { createVisiblePoller } from "./visible-poller.ts";

type PublishedReading = {
  snapshot: MonitorSnapshot;
  startedOrder: number;
};

const publishedReadings = new Map<string, PublishedReading>();
const listeners = new Set<() => void>();
let nextStartedOrder = 1;

function takeStartedOrder(): number {
  return nextStartedOrder++;
}

function publishReading(stream: string, startedOrder: number, snapshot: MonitorSnapshot): MonitorSnapshot {
  const current = publishedReadings.get(stream);
  if (current && startedOrder < current.startedOrder) return current.snapshot;

  publishedReadings.set(stream, { snapshot, startedOrder });
  for (const notify of listeners) notify();
  return snapshot;
}

type SnapshotSource = ReturnType<typeof createSnapshotSource<MonitorSnapshot>>;

const sources = new Map<string, { source: SnapshotSource; stream: string }>();

const MAX_REMEMBERED_MACHINES = 8;

function sourceFor(machineKey: string, stream: string): SnapshotSource {
  const entry = sources.get(machineKey) ?? { source: createSnapshotSource<MonitorSnapshot>((value) => value.refreshIntervalMs), stream };
  sources.delete(machineKey);
  sources.set(machineKey, entry);
  for (const oldest of sources.keys()) {
    if (sources.size <= MAX_REMEMBERED_MACHINES) break;
    const removed = sources.get(oldest);
    sources.delete(oldest);
    if (removed && !Array.from(sources.values()).some((entry) => entry.stream === removed.stream)) {
      publishedReadings.delete(removed.stream);
    }
  }
  return entry.source;
}

export function forgetMonitorReadings(): void {
  sources.clear();
  publishedReadings.clear();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

export const SERVER_MACHINE = "server";

export function useMonitorSnapshot(machineId: string, boxId?: string) {
  const rpc = useRpc<Contract>();
  const container = useRef<HTMLDivElement>(null);
  const pollerRef = useRef<ReturnType<typeof createVisiblePoller<MonitorSnapshot>> | null>(null);
  const forceRefresh = useRef(false);
  const [active, setActive] = useState(false);
  const stream = boxId === undefined ? JSON.stringify(["machine", machineId]) : JSON.stringify(["box", boxId]);
  const getSnapshot = useCallback(() => publishedReadings.get(stream)?.snapshot ?? null, [stream]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element || !machineId) return;
    const source = sourceFor(JSON.stringify([stream, machineId]), stream);
    setError(null);
    setReloading(false);
    let intersecting = false;
    let pageHidden = false;
    const poller = createVisiblePoller({
      load: () => {
        const force = forceRefresh.current;
        forceRefresh.current = false;
        return source.load(async () => {
          const startedOrder = takeStartedOrder();
          const fetched = machineId === SERVER_MACHINE
            ? await rpc.call("monitor.server", { force })
            : await rpc.call("monitor.machine", { machineId, force });
          return publishReading(stream, startedOrder, fetched);
        }, force);
      },
      receive() { setError(null); setReloading(false); },
      error(cause) { setError(cause instanceof Error ? cause.message : String(cause)); setReloading(false); },
      intervalMs: (next) => next.refreshIntervalMs,
    });
    pollerRef.current = poller;
    const update = () => {
      const visible = intersecting && !pageHidden && document.visibilityState === "visible" && element.getClientRects().length > 0;
      poller.setActive(visible);
      setActive(visible);
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      update();
    });
    const hide = () => { pageHidden = true; update(); };
    const show = () => { pageHidden = false; update(); };
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      poller.dispose();
      pollerRef.current = null;
    };
  }, [rpc, machineId, stream]);

  const reload = useCallback(() => {
    forceRefresh.current = true;
    if (pollerRef.current?.refresh()) setReloading(true);
  }, []);

  return { container, active, snapshot, error, reload, reloading };
}
