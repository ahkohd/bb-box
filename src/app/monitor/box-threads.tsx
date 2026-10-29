import { Component, useId, type ReactNode } from "react";
import { experimental_useSidebarThreads, useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Contract, MachinesState, ThreadOnBox } from "../../plugin/contract.ts";
import { threadOnBox } from "../../plugin/thread-on-box.ts";
import { forThread, OPERATOR, useLive } from "../common.tsx";
import { byActivity, threadTitle, WorkingMark } from "../thread-chips.tsx";
import type { BoxScreens } from "./box-screens.tsx";
import { MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "./menu.tsx";

export const SHOWN_THREADS = 5;

export function threadsOnBox(box: Pick<BoxScreens, "holderThreadId" | "hostId">, sidebar: readonly PluginSidebarThread[]): ThreadOnBox[] {
  const unarchived = sidebar.filter((thread) => !thread.isArchived);
  const holder = unarchived.find((thread) => thread.id === box.holderThreadId);
  const runningOnBox = box.hostId === null ? [] : unarchived.filter((thread) => thread.host?.id === box.hostId && thread.id !== box.holderThreadId);
  return [...(holder ? [threadOnBox(holder)] : []), ...byActivity(runningOnBox.map(threadOnBox))];
}

interface WithThreads {
  readonly box: BoxScreens;
  readonly children: (threads: readonly ThreadOnBox[]) => ReactNode;
}

function FromBbSidebar({ box, children }: WithThreads) {
  const { threads } = experimental_useSidebarThreads();
  return children(threadsOnBox(box, threads));
}

function FromKeptMachineChips({ box, children }: WithThreads) {
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

export function ThreadsOnBox({ box, children }: WithThreads) {
  const fromChipsSource = box.kept ? <FromKeptMachineChips box={box}>{children}</FromKeptMachineChips> : children([]);
  return (
    <ShowInsteadOnError instead={fromChipsSource}>
      <FromBbSidebar box={box}>{children}</FromBbSidebar>
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
      <span className="flex h-4 w-3.5 shrink-0 items-center justify-center">{thread.running ? <WorkingMark /> : null}</span>
      <span className="min-w-0 truncate">{title}</span>
    </MenuItem>
  );
}

export function ThreadItems({ box, threads }: { box: BoxScreens; threads: readonly ThreadOnBox[] }) {
  const labelId = useId();
  if (!threads.length) return null;
  const shown = threads.slice(0, SHOWN_THREADS);
  const more = threads.length - shown.length;
  return (
    <>
      <MenuSeparator />
      <MenuGroup aria-labelledby={labelId}>
        <MenuLabel id={labelId}>Threads</MenuLabel>
        {shown.map((thread) => (
          <ThreadItem key={thread.id} thread={thread} onOpen={box.openThread} />
        ))}
        {more > 0 ? (
          <MenuItem onSelect={box.openOnBoxesPage} className="text-muted-foreground">
            <span className="h-4 w-3.5 shrink-0" />
            <span className="min-w-0">{more} more on the Boxes page</span>
          </MenuItem>
        ) : null}
      </MenuGroup>
    </>
  );
}
