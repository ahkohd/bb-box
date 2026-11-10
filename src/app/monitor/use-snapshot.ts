import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Contract, MonitorSnapshot } from "../../plugin/contract.ts";
import { createSnapshotSource } from "./snapshot-source.ts";
import { createVisiblePoller } from "./visible-poller.ts";

type PublishedReading = {
  snapshot: MonitorSnapshot;
  startedOrder: number;
  late: boolean;
};

type ShownReading = {
  machineId: string;
  snapshot: MonitorSnapshot | null;
  startedOrder: number;
};

const publishedReadings = new Map<string, PublishedReading>();

let nextStartedOrder = 1;
let highestPublishedOrder = 0;
let readingsEpoch = 0;

function takeStartedOrder(): number {
  const startedOrder = nextStartedOrder;
  nextStartedOrder += 1;
  return startedOrder;
}

function publishReading(epoch: number, machineId: string, startedOrder: number, snapshot: MonitorSnapshot): MonitorSnapshot {
  if (epoch !== readingsEpoch) return snapshot;

  const current = publishedReadings.get(machineId);
  if (current && startedOrder < current.startedOrder) return current.snapshot;

  const late = startedOrder < highestPublishedOrder;
  publishedReadings.set(machineId, { snapshot, startedOrder, late });
  if (startedOrder > highestPublishedOrder) highestPublishedOrder = startedOrder;
  return snapshot;
}

function emptyReading(machineId: string): ShownReading {
  return { machineId, snapshot: null, startedOrder: 0 };
}

function chooseShown(shown: ShownReading, machineId: string, published: PublishedReading | null): ShownReading {
  if (!published) return shown.machineId === machineId ? shown : emptyReading(machineId);

  const aheadOfShown = !shown.snapshot || published.startedOrder >= shown.startedOrder;
  if (!published.late && (aheadOfShown || shown.machineId !== machineId)) {
    return { machineId, snapshot: published.snapshot, startedOrder: published.startedOrder };
  }

  if (shown.snapshot && published.startedOrder < shown.startedOrder) return { ...shown, machineId };

  return { machineId, snapshot: published.snapshot, startedOrder: published.startedOrder };
}

function settleReading(current: ShownReading, machineId: string): ShownReading {
  const next = chooseShown(current, machineId, publishedReadings.get(machineId) ?? null);
  if (next.machineId === current.machineId && next.snapshot === current.snapshot && next.startedOrder === current.startedOrder) return current;
  return next;
}

type SnapshotSource = ReturnType<typeof createSnapshotSource<MonitorSnapshot>>;

const sources = new Map<string, SnapshotSource>();

const MAX_REMEMBERED_MACHINES = 8;

function sourceFor(machineKey: string): SnapshotSource {
  const source = sources.get(machineKey) ?? createSnapshotSource<MonitorSnapshot>((value) => value.refreshIntervalMs);
  sources.delete(machineKey);
  sources.set(machineKey, source);
  for (const oldest of sources.keys()) {
    if (sources.size <= MAX_REMEMBERED_MACHINES) break;
    sources.delete(oldest);
    publishedReadings.delete(oldest);
  }
  return source;
}

export function forgetMonitorReadings(): void {
  readingsEpoch += 1;
  sources.clear();
  publishedReadings.clear();
}

export const SERVER_MACHINE = "server";

export function useMonitorSnapshot(machineId: string) {
  const rpc = useRpc<Contract>();
  const container = useRef<HTMLDivElement>(null);
  const pollerRef = useRef<ReturnType<typeof createVisiblePoller<MonitorSnapshot>> | null>(null);
  const forceRefresh = useRef(false);
  const [active, setActive] = useState(false);
  const [reading, setReading] = useState<ShownReading>(() => settleReading(emptyReading(machineId), machineId));
  const snapshot = chooseShown(reading, machineId, publishedReadings.get(machineId) ?? null).snapshot;
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    const source = sourceFor(machineId);
    setReading((current) => settleReading(current, machineId));
    return source.subscribe(() => {
      setReading((current) => settleReading(current, machineId));
      setError(null);
      setReloading(false);
    });
  }, [machineId]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const source = sourceFor(machineId);
    const epoch = readingsEpoch;
    setReading((current) => settleReading(current, machineId));
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
          return publishReading(epoch, machineId, startedOrder, fetched);
        }, force);
      },
      receive() { setReading((current) => settleReading(current, machineId)); setError(null); setReloading(false); },
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
  }, [rpc, machineId]);

  const reload = useCallback(() => {
    forceRefresh.current = true;
    if (pollerRef.current?.refresh()) setReloading(true);
  }, []);

  return { container, active, snapshot, error, reload, reloading };
}
