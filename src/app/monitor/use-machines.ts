import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Contract, Machine } from "../../plugin/contract.ts";
import { SERVER_MACHINE } from "./use-snapshot.ts";

const SELECTED_MACHINE_KEY = "bb-box:monitor:machine";
const LIST_ATTEMPTS = 4;
const LIST_RETRY_MS = 1000;

function readSelectedMachine(): string {
  try {
    return globalThis.localStorage?.getItem(SELECTED_MACHINE_KEY) ?? SERVER_MACHINE;
  } catch {
    return SERVER_MACHINE;
  }
}

const MACHINES_CACHE_KEY = "bb-box:monitor:machines";

function readCachedMachines(): Machine[] | null {
  try {
    const stored = globalThis.localStorage?.getItem(MACHINES_CACHE_KEY);
    if (stored == null) return null;
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? (parsed as Machine[]) : null;
  } catch {
    return null;
  }
}

function writeCachedMachines(machines: Machine[]): void {
  try {
    globalThis.localStorage?.setItem(MACHINES_CACHE_KEY, JSON.stringify(machines));
  } catch {
    return;
  }
}

function writeSelectedMachine(machineId: string): void {
  try {
    globalThis.localStorage?.setItem(SELECTED_MACHINE_KEY, machineId);
  } catch {
    return;
  }
}

export function machineKey(machine: Machine): string {
  return machine.isServer ? SERVER_MACHINE : machine.id;
}

export function useMachines() {
  const rpc = useRpc<Contract>();
  const [machines, setMachines] = useState<Machine[] | null>(readCachedMachines);
  const [listIsFresh, setListIsFresh] = useState(false);
  const [selected, setSelectedState] = useState(readSelectedMachine);

  const latestRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    for (let attempt = 0; attempt < LIST_ATTEMPTS; attempt += 1) {
      try {
        const { machines: next } = await rpc.call("monitor.machines", null);
        if (request === latestRequest.current) {
          setMachines(next);
          setListIsFresh(true);
          writeCachedMachines(next);
        }
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, LIST_RETRY_MS * (attempt + 1)));
        if (request !== latestRequest.current) return;
      }
    }
    if (request === latestRequest.current) setMachines((current) => current ?? []);
  }, [rpc]);

  useEffect(() => {
    void refresh();
    return () => { latestRequest.current += 1; };
  }, [refresh]);

  const setSelected = useCallback((machineId: string) => {
    setSelectedState(machineId);
    writeSelectedMachine(machineId);
  }, []);

  const selectedIsGone =
    listIsFresh &&
    selected !== SERVER_MACHINE &&
    machines !== null &&
    !machines.some((machine) => machineKey(machine) === selected);

  useEffect(() => {
    if (selectedIsGone) setSelected(SERVER_MACHINE);
  }, [selectedIsGone, setSelected]);

  return {
    machines,
    selected: selectedIsGone ? SERVER_MACHINE : selected,
    setSelected,
    refresh,
  };
}
