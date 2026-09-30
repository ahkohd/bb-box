// Pieces the panels share: button styles, and state from the server that
// follows its change signals.

import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

export const BUTTON =
  "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-50";
export const DANGER = `${BUTTON} text-destructive`;

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * State from the server for `key`, refetched on each change signal that
 * `relevant` accepts and after a reconnect. Only the newest answer is kept.
 */
export function useLive<T>(key: string, load: () => Promise<T>, relevant: (payload: unknown) => boolean) {
  const latest = useRef({ load, relevant });
  latest.current = { load, relevant };
  const sequence = useRef(0);
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const next = await latest.current.load();
      if (mine !== sequence.current) return;
      setValue(next);
      setError(null);
    } catch (caught) {
      if (mine === sequence.current) setError(message(caught));
    }
  }, []);
  useEffect(() => {
    setValue(null);
    setError(null);
    void refresh();
  }, [key, refresh]);
  useRealtime("changed", (payload) => {
    if (latest.current.relevant(payload)) void refresh();
  });
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") void refresh();
    previous.current = connection;
  }, [connection, refresh]);
  return { value, error, refresh };
}
