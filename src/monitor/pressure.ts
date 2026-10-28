export const MONITOR_INTERVAL_MS = 30_000;
export const HOLD_MS = 60_000;
export const COOLDOWN_MS = 300_000;
export const PRESSURE_CHANNEL = "monitor-pressure";
export type Metric = "cpu" | "memory";
export const LIMITS = { cpu: { high: 95, recovery: 85 }, memory: { high: 90, recovery: 85 } };

export interface PressureEvent {
  type: "incident" | "recovery";
  metric: Metric;
  timestamp: number;
  value: number;
  peak: number;
  durationSeconds: number;
  threshold: number;
}
interface MetricState {
  since: number | null;
  peak: number;
  active: boolean;
  recoveringSince: number | null;
  nextAlertAt: number;
}
export interface PressureState { cpu: MetricState; memory: MetricState; lastSampleAt: number | null }
const freshMetric = (): MetricState => ({ since: null, peak: 0, active: false, recoveringSince: null, nextAlertAt: 0 });
export const freshPressureState = (): PressureState => ({ cpu: freshMetric(), memory: freshMetric(), lastSampleAt: null });

export function stepPressure(previous: PressureState, values: Record<Metric, number | null>, now: number) {
  const state: PressureState = structuredClone(previous);
  const events: PressureEvent[] = [];
  const gap = state.lastSampleAt !== null && (now < state.lastSampleAt || now - state.lastSampleAt > MONITOR_INTERVAL_MS * 3);
  for (const metric of ["cpu", "memory"] as const) {
    const item = state[metric];
    const value = values[metric];
    const valid = value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
    if (gap || !valid) {
      item.recoveringSince = null;
      if (!item.active) { item.since = null; item.peak = 0; }
    }
    if (!valid) continue;
    if (item.active) {
      item.peak = Math.max(item.peak, value);
      if (value <= LIMITS[metric].recovery) {
        item.recoveringSince ??= now;
        if (now - item.recoveringSince >= HOLD_MS) {
          events.push({ type: "recovery", metric, timestamp: now, value, peak: item.peak, durationSeconds: Math.max(0, (now - (item.since ?? now)) / 1000), threshold: LIMITS[metric].high });
          Object.assign(item, freshMetric(), { nextAlertAt: now + COOLDOWN_MS });
        }
      } else item.recoveringSince = null;
    } else if (value >= LIMITS[metric].high) {
      item.since ??= now;
      item.peak = Math.max(item.peak, value);
      if (now - item.since >= HOLD_MS && now >= item.nextAlertAt) {
        item.active = true;
        events.push({ type: "incident", metric, timestamp: now, value, peak: item.peak, durationSeconds: (now - item.since) / 1000, threshold: LIMITS[metric].high });
      }
    } else { item.since = null; item.peak = 0; }
  }
  state.lastSampleAt = now;
  return { state, events };
}

export function isPressureState(value: unknown): value is PressureState {
  if (!value || typeof value !== "object") return false;
  const state = value as PressureState;
  if (state.lastSampleAt !== null && !Number.isFinite(state.lastSampleAt)) return false;
  return (["cpu", "memory"] as const).every((key) => {
    const item = state[key];
    return item && typeof item.active === "boolean" && Number.isFinite(item.peak) && item.peak >= 0 && item.peak <= 100 && Number.isFinite(item.nextAlertAt) && (item.since === null || Number.isFinite(item.since)) && (item.recoveringSince === null || Number.isFinite(item.recoveringSince));
  });
}
