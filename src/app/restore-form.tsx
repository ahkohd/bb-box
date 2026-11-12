import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import type { RestoreFormAnswer, RestoreFormPayload } from "../plugin/restore-form.ts";
import { ago } from "./box-words.ts";
import { message } from "./common.tsx";
import { PRODUCT } from "./product.ts";
import { DIALOG_FOOTER, DialogButton, Refused } from "./box-dialog.tsx";
import { whenInSentence } from "./snapshot-words.ts";
import { homeRestoreGoesWords } from "../core/snapshot.ts";

function takenWords(at: number, now: number): string {
  return `${whenInSentence(at, now)}, ${ago(at, now)}`;
}

export function restoreFormWords(payload: RestoreFormPayload, now: number): { readonly lead: string; readonly goes: string; readonly undo: string; readonly session: string | null; readonly answer: string; readonly button: string } {
  const box = payload.box.name;
  const why = payload.asks === "machine" ? `${box} is a box threads run on, so an agent restores it only on a yes given here.` : `Settings turn agents' own restores off, so an agent restores ${box} only on a yes given here.`;
  return {
    lead: `${payload.changed ? "What this restore would do changed since it was last asked, so here it is again. " : ""}An agent in this thread asks to restore ${box} to "${payload.snapshot.name}", taken ${takenWords(payload.snapshot.takenAt, now)}. ${why}`,
    goes: `${payload.snapshot.scope === "home" ? homeRestoreGoesWords(box, payload.homeUser) : `Everything on its disk since then goes: files, installed apps and settings. ${box} restarts, so every process in it ends.`} What it did to the world since stays done.${payload.sizeBack ? ` It goes back to ${payload.sizeBack}, as it was then.` : ""}${payload.excludes ? ` It leaves out ${payload.excludes}.` : ""}${payload.gpuStay ? ` ${payload.gpuStay}` : ""}${payload.userspaceNote ? ` ${payload.userspaceNote}` : ""}`,
    undo: `${PRODUCT} always takes an undo first: ${payload.undo.heldCopy ? "a full copy" : "a snapshot"} of ${box} once stopped, named "${payload.undo.name}", about ${payload.undo.aboutSeconds} s. Restore that to undo this.`,
    session: payload.runsOnIt ? `This thread runs on ${box}: its session there goes back too, and its next turn starts on the restored box.` : null,
    answer: `${PRODUCT} records an answer here as a yes given in this thread: it cannot tell who gives it.`,
    button: payload.losses.length ? `Restore ${box} anyway` : `Restore ${box}`,
  };
}

export function RestoreForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = interaction.payload as unknown as RestoreFormPayload;
  const [busy, setBusy] = useState<"submit" | "cancel" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const words = restoreFormWords(payload, Date.now());
  const act = async (which: "submit" | "cancel", work: () => Promise<void>) => {
    setBusy(which);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(message(error));
      setBusy(null);
    }
  };
  const answer: RestoreFormAnswer = { restore: true, plan: payload.plan };
  return (
    <div role="alertdialog" aria-busy={busy !== null || undefined} aria-label={`Restore ${payload.box.name} to "${payload.snapshot.name}"?`} aria-describedby={`restore-form-lead-${interaction.id}`} className="space-y-3 text-sm text-foreground">
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
      <Refused words={problem} />
      <div className={`flex ${DIALOG_FOOTER}`}>
        <DialogButton variant="outline" autoFocus disabled={busy !== null} onClick={() => void act("cancel", cancel)}>
          {busy === "cancel" ? "Cancelling…" : "Cancel"}
        </DialogButton>
        <DialogButton disabled={busy !== null} onClick={() => void act("submit", () => submit(answer as never))}>
          {busy === "submit" ? "Submitting approval…" : words.button}
        </DialogButton>
      </div>
    </div>
  );
}
