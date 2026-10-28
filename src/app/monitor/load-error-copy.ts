const UNREACHABLE = /HTTP 5\d\d|time(d)? ?out|disconnect|not connected|unavailable|unreachable|ECONN|fetch failed|network/i;
const MONITOR_OFF = /The Monitor is off/;

export const MONITOR_OFF_COPY = "The Monitor is off. Turn it on under Monitor in BB Box's settings.";

export function loadErrorCopy(error: string, machineName: string): string {
  if (MONITOR_OFF.test(error)) return MONITOR_OFF_COPY;
  return UNREACHABLE.test(error) ? `Can't reach ${machineName}.` : `Couldn't get stats from ${machineName}.`;
}
