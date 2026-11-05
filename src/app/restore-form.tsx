import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { RestoreFormAnswer, RestoreFormPayload } from "../plugin/restore-form.ts";
import { message, relativeTime } from "./common.tsx";

function takenWords(at: number, now: number): string {
  const clock = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
  return `${clock}, ${relativeTime(at, now)}`;
}

export function restoreFormWords(payload: RestoreFormPayload, now: number): { readonly lead: string; readonly goes: string; readonly undo: string; readonly session: string | null; readonly answer: string; readonly button: string } {
  const box = payload.box.name;
  const why = payload.asks === "machine" ? `${box} is a box threads run on, so an agent restores it only on a yes given here.` : `Settings turn agents' own restores off, so an agent restores ${box} only on a yes given here.`;
  return {
    lead: `${payload.changed ? "What this restore would do changed since it was last asked, so here it is again. " : ""}An agent in this thread asks to restore ${box} to "${payload.snapshot.name}", taken ${takenWords(payload.snapshot.takenAt, now)}. ${why}`,
    goes: `Everything on its disk since then goes: files, installed apps and settings. ${box} restarts, so every process in it ends. What it did to the world since stays done.${payload.sizeBack ? ` It goes back to ${payload.sizeBack}, as it was then.` : ""}${payload.excludes ? ` It leaves out ${payload.excludes}.` : ""}${payload.gpuStay ? ` ${payload.gpuStay}` : ""}${payload.userspaceNote ? ` ${payload.userspaceNote}` : ""}`,
    undo: `bb-box always takes an undo first: ${payload.undo.heldCopy ? "a full copy" : "a snapshot"} of ${box} once stopped, named "${payload.undo.name}", about ${payload.undo.aboutSeconds} s. Restore that to undo this.`,
    session: payload.runsOnIt ? `This thread runs on ${box}: its session there goes back too, and its next turn starts on the restored box.` : null,
    answer: "bb-box records an answer here as a yes given in this thread: it cannot tell who gives it.",
    button: payload.losses.length ? `Restore ${box} anyway` : `Restore ${box}`,
  };
}

export function RestoreForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = interaction.payload as unknown as RestoreFormPayload;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const words = restoreFormWords(payload, Date.now());
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(message(error));
      setBusy(false);
    }
  };
  const answer: RestoreFormAnswer = { restore: true, plan: payload.plan };
  return (
    <div role="alertdialog" aria-label={`Restore ${payload.box.name} to "${payload.snapshot.name}"?`} aria-describedby={`restore-form-lead-${interaction.id}`} className="space-y-3 text-sm text-foreground">
      <p id={`restore-form-lead-${interaction.id}`} className="text-muted-foreground">
        {words.lead}
      </p>
      <p>{words.goes}</p>
      {payload.losses.length ? (
        <div>
          <p>Also goes:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {payload.losses.map((loss) => (
              <li key={loss}>{loss}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {words.session ? <p>{words.session}</p> : null}
      <p>{words.undo}</p>
      <p className="text-xs text-muted-foreground">{words.answer}</p>
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" autoFocus disabled={busy} onClick={() => void act(cancel)}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void act(() => submit(answer as never))}>
          {words.button}
        </Button>
      </div>
    </div>
  );
}
