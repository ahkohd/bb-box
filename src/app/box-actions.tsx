// What the Box panel, settings' Machines and the Boxes page share for acting on boxes: the red line for a failure
// that needs action, with Dismiss (as #468 gave the desktop's); the dialog that asks before taking a box from
// threads working on it (034); and your machines' Start, Stop and Remove with settings' warnings (036), so the
// Boxes page manages machines exactly as settings does (the operator's note of 5 October 2026).

import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Contract, ThreadOnBox } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { message, OPERATOR } from "./common.tsx";
import { ThreadChips, threadTitle } from "./thread-chips.tsx";
import type { BoxAction } from "./box-menu.tsx";

/** A failure that needs action: red, and lasting until dismissed or the next action. Nothing when there is none. */
export function ProblemLine({ problem, onDismiss, className }: { problem: string | null; onDismiss: () => void; className?: string }) {
  if (!problem) return null;
  return (
    <div className={cn("flex items-start gap-2 text-xs", className)}>
      <p role="alert" className="min-w-0 flex-1 leading-snug text-destructive-text">
        {problem}
      </p>
      <Button type="button" variant="ghost" size="sm" className="-my-1 h-6 px-2 text-xs" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/** A release, stop or remove left alone because threads work on the box, until the person says. */
export interface InUse<M extends string> {
  readonly method: M;
  readonly box: BoxView;
  readonly threads: readonly ThreadOnBox[];
}

/** "Release calm-otter anyway?": who is working on the box, and the verb's "anyway" to go on. */
export function InUseDialog<M extends string>({ inUse, words, onClose, onForce }: { inUse: InUse<M> | null; words: Readonly<Record<M, string>>; onClose: () => void; onForce: (inUse: InUse<M>) => void }) {
  const verb = inUse ? words[inUse.method] : "";
  const count = inUse?.threads.length ?? 0;
  return (
    <AlertDialog open={inUse !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{inUse ? `${verb} ${inUse.box.name} anyway?` : null}</AlertDialogTitle>
          <AlertDialogDescription>{inUse ? `${count === 1 ? threadTitle(inUse.threads[0]!) : `${count} threads`} ${count === 1 ? "is" : "are"} working on ${inUse.box.name}.` : null}</AlertDialogDescription>
          {inUse ? <ThreadChips threads={inUse.threads} /> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => inUse && onForce(inUse)}>
            {verb} anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Remove build-1?", with what removing does to the machine. */
export function RemoveMachineDialog({ box, onClose, onRemove }: { box: BoxView | null; onClose: () => void; onRemove: (box: BoxView) => void }) {
  return (
    <AlertDialog open={box !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {box?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {box?.nature === "real"
              ? "Its machine leaves BB, and it is reset and returned to its pool. Anything in the box user's home will be deleted."
              : "Its machine leaves BB, and its disk and everything on it will be deleted. Copy out anything you want to keep first."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => box && onRemove(box)}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type MachineMethod = "remove" | "stop";

/** Your machines' Start, Stop and Remove, as settings does them: Remove asks first, and either asks again when threads work on the machine. */
export function useMachineActions(refresh: () => Promise<unknown>): {
  act: (method: MachineMethod | "start" | "forget" | "refresh", box: BoxView, force?: boolean) => Promise<void>;
  busy: string | null;
  problem: string | null;
  setProblem: (problem: string | null) => void;
  askRemove: (box: BoxView) => void;
  dialogs: ReactNode;
} {
  const rpc = useRpc<Contract>();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inUse, setInUse] = useState<InUse<MachineMethod> | null>(null);
  const [removing, setRemoving] = useState<BoxView | null>(null);
  const call = (method: MachineMethod | "start" | "forget" | "refresh", box: BoxView, force: boolean) => {
    const input = { box: box.id, ...((method === "remove" || method === "stop") && force ? { force: true } : {}) };
    switch (method) {
      case "remove":
        return rpc.call("machines.remove", input);
      case "stop":
        return rpc.call("machines.stop", input);
      case "start":
        return rpc.call("machines.start", input);
      case "forget":
        return rpc.call("forget", { threadId: OPERATOR, box: box.id });
      case "refresh":
        return rpc.call("refresh", { threadId: OPERATOR, box: box.id });
    }
  };
  const act = async (method: MachineMethod | "start" | "forget" | "refresh", box: BoxView, force = false) => {
    setBusy(`${method}:${box.id}`);
    try {
      let refused: string | null;
      try {
        const answer = await call(method, box, force);
        refused = answer.error;
        if ((method === "remove" || method === "stop") && answer.threads?.length) setInUse({ method, box, threads: answer.threads });
      } catch (caught) {
        refused = message(caught);
      }
      await refresh();
      setProblem(refused);
    } finally {
      setBusy(null);
    }
  };
  const dialogs = (
    <>
      <RemoveMachineDialog box={removing} onClose={() => setRemoving(null)} onRemove={(box) => void act("remove", box)} />
      <InUseDialog inUse={inUse} words={{ remove: "Remove", stop: "Stop" }} onClose={() => setInUse(null)} onForce={(found) => void act(found.method, found.box, true)} />
    </>
  );
  return { act, busy, problem, setProblem, askRemove: setRemoving, dialogs };
}

export type GuardedMethod = "release" | "stop";

export interface ThreadBoxActions {
  readonly act: (threadId: string, method: BoxAction, box: BoxView, force?: boolean) => Promise<void>;
  readonly busy: string | null;
  readonly problem: string | null;
  readonly setProblem: (problem: string | null) => void;
  readonly dialogs: ReactNode;
}

export function useThreadBoxActions(refresh: () => Promise<unknown>): ThreadBoxActions {
  const rpc = useRpc<Contract>();
  const [problem, setProblem] = useState<string | null>(null);
  const [inUse, setInUse] = useState<(InUse<GuardedMethod> & { readonly threadId: string }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (threadId: string, method: BoxAction, box: BoxView, force = false) => {
    const guarded = method === "release" || method === "stop";
    let refused: string | null;
    setBusy(`${method}:${box.id}`);
    try {
      const answer = await rpc.call(method, { threadId, box: box.id, ...(guarded && force ? { force: true } : {}) });
      refused = answer.error;
      if (guarded && answer.threads?.length) setInUse({ method, box, threads: answer.threads, threadId });
    } catch (caught) {
      refused = message(caught);
    } finally {
      setBusy(null);
    }
    await refresh();
    setProblem(refused);
  };
  const dialogs = <InUseDialog inUse={inUse} words={{ release: "Release", stop: "Stop" }} onClose={() => setInUse(null)} onForce={(found) => void act(inUse?.threadId ?? "", found.method, found.box, true)} />;
  return { act, busy, problem, setProblem, dialogs };
}
