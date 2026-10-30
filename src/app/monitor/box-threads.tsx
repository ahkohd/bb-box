import { Component, useId, type ReactNode } from "react";
import { experimental_useSidebarThreads, useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Contract, MachinesState, ThreadOnBox } from "../../plugin/contract.ts";
import { threadOnBox } from "../../plugin/thread-on-box.ts";
import { forThread, OPERATOR, useLive } from "../common.tsx";
import { byActivity, threadTitle, WorkingMark } from "../thread-chips.tsx";
import type { BoxScreens, MachineOpens } from "./box-screens.tsx";
import { MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "./menu.tsx";

export const SHOWN_THREADS = 5;

const RECENT_MS = 24 * 60 * 60 * 1000;

function workingOrRecent(thread: ThreadOnBox, now: number): boolean {
  return thread.running || (thread.activeAt !== undefined && now - thread.activeAt <= RECENT_MS);
}

export function threadsOnMachine(machine: Pick<MachineOpens, "hostId" | "box">, sidebar: readonly PluginSidebarThread[], now = Date.now()): ThreadOnBox[] {
  const holderThreadId = machine.box?.holderThreadId ?? null;
  const inBbSidebar = sidebar.filter((thread) => !thread.isArchived && !thread.isHidden);
  const holder = inBbSidebar.find((thread) => thread.id === holderThreadId);
  const runningOnMachine = machine.hostId === null ? [] : inBbSidebar.filter((thread) => thread.host?.id === machine.hostId && thread.id !== holderThreadId).map(threadOnBox);
  const listed = machine.box ? runningOnMachine : runningOnMachine.filter((thread) => workingOrRecent(thread, now));
  return [...(holder ? [threadOnBox(holder)] : []), ...byActivity(listed)];
}

interface WithThreads {
  readonly machine: MachineOpens;
  readonly children: (threads: readonly ThreadOnBox[]) => ReactNode;
}

function FromBbSidebar({ machine, children }: WithThreads) {
  const { threads } = experimental_useSidebarThreads();
  return children(threadsOnMachine(machine, threads));
}

function FromKeptMachineChips({ box, children }: { box: BoxScreens; children: WithThreads["children"] }) {
  const rpc = useRpc<Contract>();
  const { value } = useLive<MachinesState>("machines", () => rpc.call("machines.list"), forThread(OPERATOR));
  const machine = value?.machines.find((entry) => entry.box.id === box.boxId);
  return children(byActivity(machine?.threads ?? []));
}

class ShowInsteadOnError extends Component<{ instead: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.instead : this.props.children;
  }
}

export function ThreadsOnMachine({ machine, children }: WithThreads) {
  const fromChipsSource = machine.box?.kept ? <FromKeptMachineChips box={machine.box}>{children}</FromKeptMachineChips> : children([]);
  return (
    <ShowInsteadOnError instead={fromChipsSource}>
      <FromBbSidebar machine={machine}>{children}</FromBbSidebar>
    </ShowInsteadOnError>
  );
}

function workingWord(thread: ThreadOnBox): string {
  return thread.running ? "working" : "idle";
}

function ThreadItem({ thread, onOpen }: { thread: ThreadOnBox; onOpen: (threadId: string) => void }) {
  const title = threadTitle(thread);
  return (
    <MenuItem aria-label={`${title}, ${workingWord(thread)}`} title={title} onSelect={() => onOpen(thread.id)}>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {thread.running ? <WorkingMark /> : null}
    </MenuItem>
  );
}

function MoreOnBoxesPage({ more, box }: { more: number; box: BoxScreens }) {
  return (
    <MenuItem onSelect={box.openOnBoxesPage} className="text-muted-foreground">
      <span className="min-w-0">{more} more on the Boxes page</span>
    </MenuItem>
  );
}

function MoreInBbSidebar({ more }: { more: number }) {
  return <MenuLabel className="py-1.5">{more} more in BB's sidebar</MenuLabel>;
}

export function ThreadItems({ machine, threads }: { machine: MachineOpens; threads: readonly ThreadOnBox[] }) {
  const labelId = useId();
  if (!threads.length) return null;
  const shown = threads.slice(0, SHOWN_THREADS);
  const more = threads.length - shown.length;
  return (
    <>
      {machine.box ? <MenuSeparator /> : null}
      <MenuGroup aria-labelledby={labelId}>
        <MenuLabel id={labelId}>Threads</MenuLabel>
        {shown.map((thread) => (
          <ThreadItem key={thread.id} thread={thread} onOpen={machine.openThread} />
        ))}
        {more > 0 ? (machine.box ? <MoreOnBoxesPage more={more} box={machine.box} /> : <MoreInBbSidebar more={more} />) : null}
      </MenuGroup>
    </>
  );
}
