import { useEffect, useMemo, useState, type ReactNode } from "react";

const ICON_PATHS: Readonly<Record<string, string>> = {
  Check: "m5 12.5 4.5 4.5L19 7.5",
  ChevronRight: "m9 6 6 6-6 6",
  ChevronDown: "m6 9 6 6 6-6",
  Circle: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z",
  MoreHorizontal: "M5.5 12h.01M12 12h.01M18.5 12h.01",
  X: "M6 6l12 12M18 6 6 18",
  Copy: "M8 8h11v11H8zM5 16V5h11",
  ExternalLink: "M14 5h5v5M19 5l-8 8M18 14v5H5V6h5",
  ArrowUpRight: "M7 17 17 7M8 7h9v9",
  ArrowReloadHorizontal: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4",
  ArrowTurnBackward: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  Loading: "M12 3a9 9 0 1 0 9 9",
};

export function experimental_Icon({ name, className }: { readonly name: string; readonly className?: string }) {
  return (
    <svg data-icon-root="" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className ?? "size-4"} aria-hidden>
      <path d={ICON_PATHS[name] ?? "M12 12h.01"} />
    </svg>
  );
}

export function UrlLink({ href, className, children }: { readonly href: string; readonly className?: string; readonly children?: ReactNode }) {
  return (
    <a href={href} className={className} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

async function call(method: string, input: unknown): Promise<unknown> {
  const response = await fetch(`/rpc/${method}`, { method: "POST", body: JSON.stringify(input ?? {}) });
  const value = (await response.json()) as unknown;
  if (!response.ok) throw new Error((value as { error?: string }).error ?? `RPC ${method} failed`);
  return value;
}

export function useRpc() {
  return useMemo(() => ({ call }), []);
}

const listeners = new Set<(payload: unknown) => void>();
setInterval(() => {
  for (const listener of listeners) listener({ threadId: null });
}, 1500);

export function useRealtime(_event: string, listener: (payload: unknown) => void) {
  useEffect(() => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, [listener]);
}

export function useRealtimeConnectionState() {
  const [state] = useState("connected");
  return state;
}

export function experimental_usePluginId() {
  return "bb-box";
}

export function useBbNavigate() {
  return { openUrl: async (url: string) => void window.open(url), toThread: () => undefined };
}

export function useSdk() {
  return { threads: { get: async () => null } };
}

export function useBbContext() {
  return {};
}
