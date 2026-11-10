import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Contract, MonitorSnapshot } from "../../plugin/contract.ts";
import { createSnapshotSource } from "./snapshot-source.ts";
import { createVisiblePoller } from "./visible-poller.ts";

export type OrderedSnapshot = MonitorSnapshot & { readonly takenOrder: number };

let nextTakenOrder = 1;

export function takenOrder(snapshot: MonitorSnapshot): number | null {
  const order = (snapshot as { takenOrder?: unknown }).takenOrder;
  return typeof order === "number" && Number.isSafeInteger(order) ? order : null;
}

function startOrderedReading(load: () => Promise<MonitorSnapshot>): Promise<OrderedSnapshot> {
  const takenOrder = nextTakenOrder;
  nextTakenOrder += 1;

  return load().then((snapshot) => ({ ...snapshot, takenOrder }));
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
  }
  return source;
}

export function forgetMonitorReadings(): void {
  sources.clear();
}

export const SERVER_MACHINE = "server";

export function useMonitorSnapshot(machineId: string) {
  const rpc = useRpc<Contract>();
  const container = useRef<HTMLDivElement>(null);
  const pollerRef = useRef<ReturnType<typeof createVisiblePoller<MonitorSnapshot>> | null>(null);
  const forceRefresh = useRef(false);
  const [active, setActive] = useState(false);
  const [reading, setReading] = useState<{ machineId: string; snapshot: MonitorSnapshot | null }>(() => ({
    machineId,
    snapshot: sourceFor(machineId).snapshot(),
  }));
  const snapshot = reading.machineId === machineId ? reading.snapshot : sourceFor(machineId).snapshot();
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    const source = sourceFor(machineId);
    const current = source.snapshot();
    if (current) setReading({ machineId, snapshot: current });
    return source.subscribe((next) => {
      setReading({ machineId, snapshot: next });
      setError(null);
      setReloading(false);
    });
  }, [machineId]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const source = sourceFor(machineId);
    setReading({ machineId, snapshot: source.snapshot() });
    setError(null);
    setReloading(false);
    let intersecting = false;
    let pageHidden = false;
    const poller = createVisiblePoller({
      load: () => {
        const force = forceRefresh.current;
        forceRefresh.current = false;
        return source.load(
          () =>
            startOrderedReading(() =>
              machineId === SERVER_MACHINE
                ? rpc.call("monitor.server", { force })
                : rpc.call("monitor.machine", { machineId, force }),
            ),
          force,
        );
      },
      receive(next) { setReading({ machineId, snapshot: next }); setError(null); setReloading(false); },
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
