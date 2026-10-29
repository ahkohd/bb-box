import { useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ConfigDocument } from "../core/document.ts";
import type { ConfigState, Contract } from "../plugin/contract.ts";
import { EmptyPanel, message, useLive } from "./common.tsx";
import { SettingsContext, settingsWrites, type Saved, type SettingsContextValue } from "./settings-context.tsx";
import { useInstant } from "./settings-instant.ts";
import { scrollParent, useSettingsNav, type Arrival } from "./settings-nav.ts";
import { forgetKindsKeptHere, Overview } from "./settings-overview.tsx";
import { TopRow, viewPage } from "./settings-pages.tsx";
import { hashOf } from "./settings-route.ts";

export type { Saved } from "./settings-context.tsx";

const STALE = "Someone saved the configuration first. It has been reloaded; make your change again.";
const RESTORE_TRIES = 40;

function useArrival(arrival: Arrival | null, root: RefObject<HTMLDivElement | null>, page: RefObject<HTMLDivElement | null>, ready: boolean): void {
  const handled = useRef(0);
  const tries = useRef(0);
  useLayoutEffect(() => {
    if (!arrival || !ready || handled.current === arrival.serial) return;
    const scroller = scrollParent(root.current);
    if (arrival.kind === "return") {
      const row = arrival.row ? root.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(arrival.row)}"]`) : null;
      if (arrival.row && !row && tries.current++ < RESTORE_TRIES) return;
      scroller?.scrollTo({ top: arrival.scroll });
      row?.focus({ preventScroll: true });
    } else {
      scroller?.scrollTo({ top: 0 });
      page.current?.querySelector<HTMLElement>("[data-page-heading]")?.focus({ preventScroll: true });
    }
    handled.current = arrival.serial;
    tries.current = 0;
  });
}

export function SettingsSection() {
  const rpc = useRpc<Contract>();
  const { value: state, error, refresh } = useLive<ConfigState>("config", () => rpc.call("config.get"), () => true);
  const root = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const scroller = useCallback(() => scrollParent(root.current), []);
  const nav = useSettingsNav(scroller);
  const reload = useCallback(() => rpc.call("config.get"), [rpc]);
  const instant = useInstant(state, reload, refresh);
  const writes = useMemo(() => settingsWrites(rpc), [rpc]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => () => forgetKindsKeptHere(), []);
  useEffect(() => setNotice(null), [nav.view]);
  useArrival(nav.arrival, root, page, state !== null);

  const latest = useRef(state);
  latest.current = state;
  const apply = useCallback(
    async (draft: ConfigDocument): Promise<Saved> => {
      const seen = latest.current;
      if (!seen) return { saved: false, problems: [] };
      try {
        const result = await rpc.call("config.apply", { draft, revision: seen.revision });
        if (result.ok) {
          setNotice(null);
          await refresh();
          return { saved: true, problems: result.problems };
        }
        if (result.reason === "revision") {
          setNotice(STALE);
          await refresh();
          return { saved: false, problems: [{ path: "", message: STALE }] };
        }
        return { saved: false, problems: result.problems };
      } catch (caught) {
        return { saved: false, problems: [{ path: "", message: message(caught) }] };
      }
    },
    [rpc, refresh],
  );
  const applyNow = useCallback(
    async (key: string, draft: ConfigDocument): Promise<void> => {
      setBusy(key);
      try {
        const { saved, problems } = await apply(draft);
        setNotice(!saved && problems.length ? problems.map((problem) => problem.message).join(" ") : null);
      } finally {
        setBusy(null);
      }
    },
    [apply],
  );

  if (error) return <EmptyPanel role="alert">{error}</EmptyPanel>;
  if (!state) return null;
  const context: SettingsContextValue = { state, nav, instant, writes, notice, busy, refresh, apply, applyNow };
  return (
    <SettingsContext.Provider value={context}>
      <div ref={root} className="space-y-5" data-settings-view={hashOf(nav.view) || "#"}>
        <TopRow />
        {notice ? (
          <p role="alert" className="rounded-md border border-warning/40 bg-surface-recessed px-3 py-2 text-xs leading-snug text-warning-text">
            {notice}
          </p>
        ) : null}
        <div ref={page} key={hashOf(nav.view) || "#"}>
          {nav.view.page === "overview" ? <Overview /> : viewPage(nav.view)}
        </div>
      </div>
    </SettingsContext.Provider>
  );
}
