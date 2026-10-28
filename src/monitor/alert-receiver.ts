import type { AlertNotice } from "./monitor-store.ts";

export function isAlertNotice(value: unknown): value is AlertNotice {
  if (!value || typeof value !== "object") return false;
  const v = value as AlertNotice;
  return (v.type === "incident" || v.type === "recovery") && (v.metric === "cpu" || v.metric === "memory") && Number.isSafeInteger(v.sequence) && v.sequence > 0 && [v.timestamp, v.value, v.peak, v.durationSeconds, v.threshold].every(Number.isFinite) && v.value >= 0 && v.value <= 100 && v.peak >= 0 && v.peak <= 100 && v.durationSeconds >= 0;
}

export interface AlertCursor { cpu: number; memory: number }
const validCursor = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function createAlertReceiver(initial: unknown, show: (notice: AlertNotice) => void, save: (cursor: AlertCursor) => void) {
  const seed = initial && typeof initial === "object" ? initial as AlertCursor : { cpu: initial, memory: initial };
  const cursor: AlertCursor = { cpu: validCursor(seed.cpu), memory: validCursor(seed.memory) };
  let reconciled = cursor.cpu > 0 || cursor.memory > 0;
  function receive(value: unknown) {
    if (!isAlertNotice(value) || value.sequence <= cursor[value.metric]) return;
    cursor[value.metric] = value.sequence;
    save({ ...cursor });
    show(value);
  }
  return {
    receive,
    reconcile(status: { enabled: boolean; notifications: boolean; cursor: number; active: AlertNotice[]; recent: AlertNotice[] }) {
      if (!status.enabled || !status.notifications) return;
      const notices = reconciled ? [...status.recent, ...status.active] : status.active;
      reconciled = true;
      const latest = new Map<string, AlertNotice>();
      for (const notice of notices) if (isAlertNotice(notice) && notice.sequence > (latest.get(notice.metric)?.sequence ?? -1)) latest.set(notice.metric, notice);
      [...latest.values()].sort((a, b) => a.sequence - b.sequence).forEach(receive);
      cursor.cpu = Math.max(cursor.cpu, validCursor(status.cursor));
      cursor.memory = Math.max(cursor.memory, validCursor(status.cursor));
      save({ ...cursor });
    },
  };
}
