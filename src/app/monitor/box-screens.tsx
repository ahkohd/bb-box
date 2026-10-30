import { useCallback, useMemo } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { BoxEntry, Contract, Machine } from "../../plugin/contract.ts";
import { useLive } from "../common.tsx";
import { openActions, type OpenAction } from "../box-opens.tsx";
import { opensFrom, useBoxesNav } from "../box-nav.tsx";
import { boxPage } from "../box-route.ts";

export interface BoxScreens {
  readonly boxId: string;
  readonly actions: readonly OpenAction[];
  readonly kept: boolean;
  readonly holderThreadId: string | null;
  readonly openOnBoxesPage: () => void;
}

export interface MachineOpens {
  readonly machineName: string;
  readonly hostId: string | null;
  readonly box: BoxScreens | null;
  readonly openThread: (threadId: string) => void;
}

export type OpensOf = (machine: Machine | undefined) => MachineOpens | null;

export function useOpensOf(): OpensOf {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const nav = useBoxesNav();
  const { value: entries } = useLive<BoxEntry[]>("allBoxes", () => rpc.call("allBoxes"), () => true);
  const entryOf = useMemo(() => new Map((entries ?? []).map((entry) => [entry.box.id, entry])), [entries]);
  return useCallback(
    (machine) => {
      if (!machine) return null;
      const openThread = (threadId: string) => navigate.toThread(threadId);
      if (machine.boxId === null) return { machineName: machine.name, hostId: machine.id, box: null, openThread };
      const entry = entryOf.get(machine.boxId);
      if (!entry) return null;
      const kept = entry.owner === "yours";
      return {
        machineName: entry.box.name,
        hostId: entry.box.enrol.hostId,
        box: {
          boxId: entry.box.id,
          actions: openActions(entry.box, opensFrom(nav, [])),
          kept,
          holderThreadId: kept ? null : entry.threadId,
          openOnBoxesPage: () => nav.go(boxPage(entry.box.id)),
        },
        openThread,
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
