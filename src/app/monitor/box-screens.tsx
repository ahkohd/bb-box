import { useCallback, useMemo } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { BoxEntry, Contract, Machine } from "../../plugin/contract.ts";
import { useLive } from "../common.tsx";
import { openActions, type OpenAction } from "../box-opens.tsx";
import { opensOnBoxesPage } from "../desktop.tsx";

export interface BoxScreens {
  readonly boxName: string;
  readonly actions: readonly OpenAction[];
}

export type ScreensOf = (machine: Machine | undefined) => BoxScreens | null;

export function useScreensOf(): ScreensOf {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const { value: entries } = useLive<BoxEntry[]>("allBoxes", () => rpc.call("allBoxes"), () => true);
  const entryOf = useMemo(() => new Map((entries ?? []).map((entry) => [entry.box.id, entry])), [entries]);
  return useCallback(
    (machine) => {
      const entry = machine?.boxId ? entryOf.get(machine.boxId) : undefined;
      if (!entry) return null;
      const actions = openActions(entry.box, opensOnBoxesPage(navigate, entry.threadId));
      return actions.length ? { boxName: entry.box.name, actions } : null;
    },
    [entryOf, navigate],
  );
}
