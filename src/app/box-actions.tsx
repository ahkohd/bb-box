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
import { message } from "./common.tsx";
import { ThreadChips } from "./thread-chips.tsx";

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
          <AlertDialogDescription>{inUse ? `${count === 1 ? "A thread is" : `${count} threads are`} working on it, and would lose ${count === 1 ? "its" : "their"} machine.` : null}</AlertDialogDescription>
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
  act: (method: MachineMethod | "start", box: BoxView, force?: boolean) => Promise<void>;
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
  const act = async (method: MachineMethod | "start", box: BoxView, force = false) => {
    setBusy(`${method}:${box.id}`);
    try {
      const input = { box: box.id, ...(method !== "start" && force ? { force: true } : {}) };
      let refused: string | null;
      try {
        const answer = await (method === "remove" ? rpc.call("machines.remove", input) : method === "stop" ? rpc.call("machines.stop", input) : rpc.call("machines.start", input));
        refused = answer.error;
        if (method !== "start" && answer.threads?.length) setInUse({ method, box, threads: answer.threads });
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
