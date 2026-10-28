import { useEffect, useRef } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Contract } from "../../plugin/contract.ts";
import { PRESSURE_CHANNEL } from "../../monitor/pressure.ts";
import { createAlertReceiver, type AlertCursor } from "../../monitor/alert-receiver.ts";
import { pressureAlertCopy, TEST_ALERT_COPY } from "../../monitor/alert-copy.ts";

const CURSOR_KEY = "bb-box-monitor-pressure-cursor";
let openStatus = () => {};

function readSavedCursor(): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(CURSOR_KEY) ?? "null");
  } catch {
    return null;
  }
}

function saveCursor(cursor: AlertCursor): void {
  try {
    sessionStorage.setItem(CURSOR_KEY, JSON.stringify(cursor));
  } catch {
    return;
  }
}
export function bindStatusOpener(open: () => void) {
  openStatus = open;
}

function ActiveNotifications() {
  const rpc = useRpc<Contract>();
  const connection = useRealtimeConnectionState();
  const pageHidden = useRef(false);
  const previousConnection = useRef(connection);
  const receiver = useRef<ReturnType<typeof createAlertReceiver> | null>(null);
  const sync = useRef<() => void>(() => {});
  useRealtime(PRESSURE_CHANNEL, (value) => {
    if (pageHidden.current || document.visibilityState !== "visible") return;
    if (value && typeof value === "object" && "type" in value && value.type === "test") {
      toast.warning(TEST_ALERT_COPY.title, {
        id: "bb-box-monitor-pressure-test", description: TEST_ALERT_COPY.description,
        duration: 20_000, closeButton: true,
        action: { label: "Open Status", onClick: () => openStatus() },
      });
      return;
    }
    receiver.current?.receive(value);
  });

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let repeat = false;
    let generation = 0;
    const saved = readSavedCursor();
    const nextReceiver = createAlertReceiver(saved, (notice) => {
      const recovered = notice.type === "recovery";
      const { title, description } = pressureAlertCopy(notice);
      (recovered ? toast.success : toast.warning)(title, {
        id: `bb-box-monitor-pressure-${notice.metric}`, description, duration: 12_000,
        action: { label: "Open Status", onClick: () => openStatus() },
      });
    }, saveCursor);
    receiver.current = nextReceiver;
    const reconcile = async () => {
      if (disposed || pageHidden.current || document.visibilityState !== "visible") return;
      if (pending) { repeat = true; return; }
      pending = true;
      const requestGeneration = generation;
      try {
        const status = await rpc.call("monitor.alerts", null);
        if (!disposed && !pageHidden.current && requestGeneration === generation && document.visibilityState === "visible") nextReceiver.reconcile(status);
      } catch { return; }
      finally {
        pending = false;
        if (repeat && !disposed) { repeat = false; void reconcile(); }
      }
    };
    sync.current = () => { generation++; void reconcile(); };
    const visible = () => { generation++; if (document.visibilityState === "visible") void reconcile(); };
    const hide = () => { pageHidden.current = true; generation++; };
    const show = () => { pageHidden.current = false; visible(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    void reconcile();
    return () => {
      disposed = true;
      receiver.current = null;
      sync.current = () => {};
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      toast.dismiss("bb-box-monitor-pressure-cpu");
      toast.dismiss("bb-box-monitor-pressure-memory");
      toast.dismiss("bb-box-monitor-pressure-test");
    };
  }, [rpc]);

  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected") sync.current();
    previousConnection.current = connection;
  }, [connection]);
  return null;
}

export function PressureNotifications({ active }: { active: boolean }) {
  return active ? <ActiveNotifications /> : null;
}
