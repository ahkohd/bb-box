import { useCallback, useMemo } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { BoxEntry, Contract, Machine } from "../../plugin/contract.ts";
import { useLive } from "../common.tsx";
import { openActions, type OpenAction } from "../box-opens.tsx";
import { opensFrom, useBoxesNav } from "../box-nav.tsx";
import { boxPage } from "../box-route.ts";

export interface BoxScreens {
  readonly boxId: string;
  readonly boxName: string;
  readonly actions: readonly OpenAction[];
  readonly kept: boolean;
  readonly holderThreadId: string | null;
  readonly hostId: string | null;
  readonly openThread: (threadId: string) => void;
  readonly openOnBoxesPage: () => void;
}

export type ScreensOf = (machine: Machine | undefined) => BoxScreens | null;

export function useScreensOf(): ScreensOf {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const nav = useBoxesNav();
  const { value: entries } = useLive<BoxEntry[]>("allBoxes", () => rpc.call("allBoxes"), () => true);
  const entryOf = useMemo(() => new Map((entries ?? []).map((entry) => [entry.box.id, entry])), [entries]);
  return useCallback(
    (machine) => {
      const entry = machine?.boxId ? entryOf.get(machine.boxId) : undefined;
      if (!entry) return null;
      const actions = openActions(entry.box, opensFrom(nav, []));
      const kept = entry.owner === "yours";
      return {
        boxId: entry.box.id,
        boxName: entry.box.name,
        actions,
        kept,
        holderThreadId: kept ? null : entry.threadId,
        hostId: entry.box.enrol.hostId,
        openThread: (threadId) => navigate.toThread(threadId),
        openOnBoxesPage: () => nav.go(boxPage(entry.box.id)),
      };
    },
    [entryOf, navigate, nav],
  );
}

export type BoxLook = "device" | "desktop";

export type LookOf = (machine: Machine | undefined) => BoxLook | null;

export function useBoxLookOf(): LookOf {
  const rpc = useRpc<Contract>();
  const { value: entries } = useLive<BoxEntry[]>("allBoxes", () => rpc.call("allBoxes"), () => true);
  const boxOf = useMemo(() => new Map((entries ?? []).map((entry) => [entry.box.id, entry.box])), [entries]);
  return useCallback(
    (machine) => {
      const box = machine?.boxId ? boxOf.get(machine.boxId) : undefined;
      if (!box) return null;
      if (box.device) return "device";
      return box.desktop ? "desktop" : null;
    },
    [boxOf],
  );
}
