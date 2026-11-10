import type { BbPluginApi, PluginAgentToolResult, PluginInteractionCancelReason } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PRODUCT } from "../brand.ts";
import { BoxError, describeError, describeErrorForAgent, errorForAgent, type BoxErrorCode, type BoxRecord } from "../core/boxes.ts";
import { countsAgainstLimit, snapshotLine, type Caller, type Standing } from "../core/snapshot.ts";
import { YesNeeded, type RestoreAnswer } from "../core/snapshots.ts";
import { toolsForPurposes } from "./purposes.ts";
import { RESTORE_FORM, RESTORE_FORM_TIMEOUT_MS, isRestoreYes, restoreFormPayload, restoreFormTitle, type RestoreFormPayload } from "./restore-form.ts";
import type { BbBox } from "./setup.ts";
import { deletedText, forkMayMissWords, offerSnapshotWords, restoredText, takeCheckText, takenText } from "./snapshot-words.ts";
import { agentErrorText, boxParam, failure, ready, runsOnBox, thread, using, withHint } from "./tools.ts";
import { boxDetail, startingWords } from "./views.ts";
import { forkedFromWords, isAcquiring, isMachineName } from "../core/boxes.ts";

const FORK_NAME_RULE = 'a lower-case letter first, then letters, digits and "-", up to 32 characters, not ending in "-".';
import { next } from "./views.ts";

const QUIET_WAIT_MS = 60_000;
const QUIET_POLL_MS = 2_000;
const ASKS_AGAIN_AT_MOST = 3;

const SNAPSHOT_HINTS: Partial<Record<BoxErrorCode, string>> = {
  not_found: "Call box_snapshots to see the boxes and snapshots this thread may see.",
  limit_reached: "Delete a snapshot you took and no longer need with box_snapshot_delete, or ask the user.",
  try_again: "This holds only for now, not for good: it can work once what it names changes, such as snapshots deleted or a task ended. Do what it says you can, or try again later, not in a loop.",
  in_use: "Tell the person, in the thread, what the refusal names: it says what would have to change first.",
  not_owner: "Ask the person, in the thread, if it should be done.",
  needs_yes: "Call box_restore again: it asks for a yes in the thread with a form. Then end your turn.",
  no_capacity: "Try again later, or ask the user.",
  unsupported: "Call box_status to see what the box can do: its Snapshots line says what its backend offers.",
};

function snapshotFailure(error: unknown, action: string): PluginAgentToolResult {
  const hint = error instanceof BoxError ? SNAPSHOT_HINTS[error.code] : undefined;
  if (!hint) return failure(error, action);
  return { content: [{ type: "text", text: agentErrorText(error, action, hint) }], isError: true };
}

function agent(threadId: string): Caller {
  return { is: "agent", threadId };
}

async function snapshotTarget(app: BbBox, threadId: string, ref: string, signal?: AbortSignal): Promise<{ box: BoxRecord; standing: Standing }> {
  const { box, runsOn } = await app.resolve(threadId, ref, signal);
  return { box, standing: { box: { id: box.id, threadId: box.threadId }, runsOn: runsOn || (await runsOnBox(app, threadId, box, signal)) } };
}

function boxSnapshotsText(app: BbBox, threadId: string, box: BoxRecord, standing: Standing): string {
  const offer = app.snapshots.offerFor(app.backends.get(box.backend), box.kind);
  const seen = app.snapshots.seen(agent(threadId), standing);
  const perBox = app.snapshots.settings.perBox;
  const hidden = seen.hidden ? `, and ${seen.hidden === 1 ? "one" : seen.hidden} you cannot see` : "";
  const heading = `Box ${box.name} (${box.id}), ${box.backendLabel}: ${offer ? `snapshots of ${offerSnapshotWords(offer)}` : "its backend takes no snapshots"}.`;
  if (!seen.records.length) return `${heading}\n  No snapshots${hidden}.`;
  return [heading, ...seen.records.map((record) => `  ${snapshotLine(record)}`), `  ${seen.counted} of ${perBox} for this box${hidden}.`].join("\n");
}

function takenNote(answer: { readonly evicted?: { readonly name: string } | null; readonly evictionRefused?: string | null }, perBox: number): string {
  if (answer.evicted) return `\nThe box was at its limit of ${perBox}, so ${PRODUCT} deleted the oldest snapshot an agent of this thread took and nobody kept: "${answer.evicted.name}".`;
  if (answer.evictionRefused) return `\n${answer.evictionRefused}`;
  return "";
}

function restoredForAgent(answer: RestoreAnswer, box: BoxRecord, yes: boolean): string {
  const lines = [restoredText(answer, box.name)];
  if (yes) lines.push("It was restored on a yes given in this thread.");
  const undo = answer.undo ? `If it went wrong, restore "${answer.undo.name}" with box_restore to undo it.` : "";
  return `${lines.join("\n")}${next(...[undo, `Call box_status with box "${box.name}" to see it.`].filter(Boolean))}`;
}

function cancelledText(reason: PluginInteractionCancelReason, box: string): PluginAgentToolResult {
  const why: Record<PluginInteractionCancelReason, string> = {
    user: "the form was cancelled in the thread",
    timeout: "nobody answered the form within 10 minutes",
    "thread-stopped": "the thread was stopped",
    "thread-deleted": "the thread was deleted",
    "server-restarted": "BB's server restarted",
    "plugin-disposed": `${PRODUCT} stopped, as for an update`,
    "request-aborted": "the request was cancelled",
  };
  const text = `${PRODUCT} did not restore box ${box}: ${why[reason]}. Nothing changed.${next("Carry on with the box as it is, or ask again with box_restore if the person wants it.")}`;
  return reason === "user" || reason === "timeout" ? text : { content: [{ type: "text", text }], isError: true };
}

async function quietOn(app: BbBox, box: BoxRecord, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + QUIET_WAIT_MS;
  while (Date.now() < deadline && !signal.aborted) {
    const working = (await app.threadsOn(box).catch(() => [])).filter((each) => each.running);
    if (!working.length) return;
    await new Promise((resolve) => setTimeout(resolve, QUIET_POLL_MS));
  }
}

export function forkParameters(wholeCards: boolean) {
  return z.object({
    box: boxParam.describe("The box to fork, by its name or ID: one of this thread's boxes, not one it runs on."),
    snapshot: z.string().min(1).optional().describe('The snapshot\'s name or ID, from box_snapshots. Left out, bb-box takes one of the box now, named "for a fork", and forks that.'),
    name: z.string().min(1).max(32).refine(isMachineName, FORK_NAME_RULE).optional().describe(`The new box's name: ${FORK_NAME_RULE} One is made up when left out.`),
    gpu: wholeCards
      ? z.enum(["none", "shared", "whole"]).optional().describe("The fork's GPU. none, the default, starts it with no card. shared places a shared card, and whole a card to itself where this install has whole cards on, before anything is copied; only a desktop can take either.")
      : z.enum(["none", "shared"]).optional().describe("The fork's GPU. none, the default, starts it with no card. shared places a shared card before anything is copied, and only a desktop can take it."),
  });
}

export function registerSnapshotTools(bb: BbPluginApi, app: BbBox): void {
  const registerTool = toolsForPurposes(bb);
  const titleOf = async (threadId: string): Promise<string | null> => {
    const found = await bb.sdk.threads.get({ threadId }).catch(() => null);
    return found?.title ?? found?.titleFallback ?? null;
  };

  registerTool({
    name: "box_snapshot",
    description:
      "Take a snapshot of a box: its disk, or with memory its disk and running apps where its backend can, so you can restore it if a change goes wrong. Take one before a change you cannot undo, such as a migration, an upgrade, a deletion or a change to the system, and when the person asks; never on a schedule of your own. A take can pause the box: call it with check first to see for how long, and tell the person before a pause of more than a few seconds. Its answer says how long it paused the box.",
    presentation: { label: { pending: "Taking a snapshot", completed: "Took a snapshot" } },
    parameters: z.object({
      box: boxParam,
      name: z.string().min(1).max(60).optional().describe('Its name, at most 60 characters, unique on the box, such as "before the migration". The time, such as Thu 10:42, when left out.'),
      note: z.string().min(1).optional().describe("A note, at most 1 KB: what the box held, or why you took it."),
      memory: z.boolean().optional().describe("Hold the box's memory too, so a restore brings back its running apps: only where its backend can, and slower. Defaults to false where its backend can leave it out, and to true where every snapshot holds it, as on a macOS box on Tart, where false is refused."),
      check: z.boolean().optional().describe("Say how long the take would take and pause the box, and refuse what it would refuse, taking nothing."),
    }),
    async execute({ box: ref, name, note, memory, check }, { threadId, signal }) {
      try {
        const id = thread(threadId);
        const { box, standing } = await snapshotTarget(app, id, ref, signal);
        if (check) {
          const planned = await app.snapshots.checkTake(agent(id), box, standing, memory !== undefined ? { memory } : {});
          return `${takeCheckText(planned, box.name)}${next("Nothing was taken. Call box_snapshot again without check to take it.")}`;
        }
        const answer = await app.snapshots.take(agent(id), box, standing, { ...(name !== undefined ? { name } : {}), ...(note !== undefined ? { note } : {}), ...(memory !== undefined ? { memory } : {}) });
        const perBox = app.snapshots.settings.perBox;
        const snapshot = answer.snapshot;
        return `${takenText(answer, box.name, perBox)}${takenNote(answer, perBox)}${next(
          ...(snapshot ? [`Restore it with box_restore (box "${box.name}", snapshot "${snapshot.name}") if the change goes wrong, rather than undoing it by hand.`, "Delete it with box_snapshot_delete once it is no longer needed."] : []),
        )}`;
      } catch (error) {
        return snapshotFailure(error, "Taking the snapshot");
      }
    },
  });

  registerTool({
    name: "box_snapshots",
    description: "List the snapshots of a box, or of every box of this thread and the machine it runs on: per box, what its snapshots hold or that it has none; per snapshot, its name, ID, when, by whom, what it holds, its size, its price, whether it is kept, and where it is.",
    presentation: { label: { pending: "Listing snapshots", completed: "Listed snapshots" } },
    parameters: z.object({ box: boxParam.optional().describe("The box's name or ID. Every box of this thread, and the machine it runs on, when left out.") }),
    async execute({ box: ref }, { threadId, signal }) {
      try {
        const id = thread(threadId);
        if (ref !== undefined) {
          const { box, standing } = await snapshotTarget(app, id, ref, signal);
          return `${boxSnapshotsText(app, id, box, standing)}${next("box_snapshot takes one; box_restore restores one; box_snapshot_delete deletes one you took.")}`;
        }
        const own = await app.boxes.list(id);
        const machine = await app.runsOn(id, signal).catch(() => null);
        const blocks: string[] = [];
        for (const box of own) blocks.push(boxSnapshotsText(app, id, box, { box: { id: box.id, threadId: box.threadId }, runsOn: machine?.id === box.id || (await runsOnBox(app, id, box, signal)) }));
        if (machine && !own.some((box) => box.id === machine.id)) blocks.unshift(boxSnapshotsText(app, id, machine, { box: { id: machine.id, threadId: machine.threadId }, runsOn: true }));
        if (!blocks.length) return `This thread has no boxes, and runs on none.${next("Call box_acquire to get a box.")}`;
        return `${blocks.join("\n")}${next("box_snapshot takes one; box_restore restores one; box_snapshot_delete deletes one you took.")}`;
      } catch (error) {
        return snapshotFailure(error, "Listing snapshots");
      }
    },
  });

  registerTool({
    name: "box_snapshot_delete",
    description: "Delete a snapshot of a box that an agent of this thread took and nobody kept. A kept snapshot, the person's and another thread's are the person's to delete.",
    presentation: { label: { pending: "Deleting a snapshot", completed: "Deleted a snapshot" } },
    parameters: z.object({ box: boxParam, snapshot: z.string().min(1).describe("The snapshot's name or ID, from box_snapshots.") }),
    async execute({ box: ref, snapshot }, { threadId, signal }) {
      try {
        const id = thread(threadId);
        const { box, standing } = await snapshotTarget(app, id, ref, signal);
        const answer = await app.snapshots.delete(agent(id), standing, snapshot);
        const counted = app.snapshots.ledger.records({ box: box.id }).filter(countsAgainstLimit).length;
        return `${deletedText(answer, box.name)}\nBox ${box.name} holds ${counted} of ${app.snapshots.settings.perBox} snapshots.${next("box_snapshots lists what is left.")}`;
      } catch (error) {
        return snapshotFailure(error, "Deleting the snapshot");
      }
    },
  });

  registerTool({
    name: "box_fork",
    description:
      "Make a new box of this thread from a snapshot of one of its boxes, or from the box as it is now, to try two things from one set-up state. The fork gets the snapshot's files and its own identity: a new BB machine, address and keys, so it never acts as its source. Everything else on the disk comes with it, project secrets and signed-in browsers too. It starts fresh, with no apps running, at the snapshot's size.",
    presentation: { label: { pending: "Forking a box", completed: "Forked a box" } },
    parameters: forkParameters(true),
    async execute({ box: ref, snapshot, name, gpu }, { threadId, projectId, signal }) {
      try {
        const id = thread(threadId);
        const { box, standing } = await snapshotTarget(app, id, ref, signal);
        const caller = agent(id);
        const input = { ...(name !== undefined ? { name } : {}), ...(gpu ? { gpu } : {}), projectId: projectId ?? null };
        let taken: { readonly id: string; readonly words: string } | null = null;
        if (snapshot === undefined) {
          await app.snapshots.checkForkOfBox(caller, box, standing, input);
          const answer = await app.snapshots.take(caller, box, standing, { name: "for a fork" });
          if (!answer.snapshot) throw new BoxError("failed", `${PRODUCT} took no snapshot of box ${box.name} to fork.`);
          taken = { id: answer.snapshot.id, words: `${takenText(answer, box.name, app.snapshots.settings.perBox)}${takenNote(answer, app.snapshots.settings.perBox)}\n` };
        }
        let answer;
        try {
          answer = await app.snapshots.fork(caller, box, standing, snapshot ?? taken!.id, input);
        } catch (error) {
          if (!taken) throw error;
          const removed = await app.snapshots.delete(caller, standing, taken.id).then(
            () => `${PRODUCT} deleted the snapshot "for a fork" it took for this, as the fork was refused.`,
            (cause: unknown) => `${PRODUCT} could not delete the snapshot "for a fork" it took for this: ${describeError(cause, "Deleting it")} Delete it with box_snapshot_delete.`,
          );
          throw new BoxError(error instanceof BoxError ? error.code : "failed", `${describeError(error, "Forking the box")}\n${taken.words}${removed}`, `${describeErrorForAgent(error, "Forking the box")}\n${taken.words}${removed}`);
        }
        const made = answer.box;
        if (!made) throw new BoxError("not_found", `${PRODUCT} has no record of the fork's box any more.`);
        const origin = made.fork ? `\n${forkedFromWords(made.fork)}` : "";
        const settled = await ready(app, made, signal);
        const before = taken?.words ?? "";
        if (!settled || isAcquiring(settled)) return `${before}${startingWords(settled ?? made, !!settled && app.boxes.stopping)}${origin}${next(`Call box_status with box "${made.name}" to see when it is ready.`)}`;
        if (settled.state === "failed") {
          const said = `${before}Fork ${settled.name} failed: ${errorForAgent(settled) ?? "no reason given"}`;
          return { content: [{ type: "text", text: withHint(said, "Tell the person what it says, or ask the user.") }], isError: true };
        }
        const enrolled = await app.boxes.enrolled(settled, signal);
        const mayMiss = answer.snapshot ? forkMayMissWords(answer.snapshot) : null;
        return `${before}${boxDetail(enrolled, app.control(enrolled))}${mayMiss ? `\n${mayMiss}` : ""}${next(...using(enrolled))}`;
      } catch (error) {
        return snapshotFailure(error, "Forking the box");
      }
    },
  });

  registerTool({
    name: "box_restore",
    description:
      `Restore a box to one of its snapshots when an attempt went wrong, rather than undoing it by hand. Everything on its disk since then goes, and the box restarts, so every process in it ends. ${PRODUCT} always takes an undo first, a snapshot of the box once stopped, or on ZFS a full copy of it. On ZFS only the newest snapshot restores. While Settings turn agents' restores off, this opens a form for a yes given in the thread and answers at once: then end your turn. A box this thread or another runs on, or one of the person's machines, is restored only through such a form, and only where ${PRODUCT} allows it; this says so when it does not.`,
    presentation: { label: { pending: "Restoring a box", completed: "Restored a box" } },
    parameters: z.object({
      box: boxParam,
      snapshot: z.string().min(1).describe("The snapshot's name or ID, from box_snapshots."),
      replace: z.boolean().describe("Must be true: you mean to replace the box's disk with the snapshot's."),
      request: z.string().min(1).max(80).optional().describe("An ID you make, so a repeat of this call is the same restore, not a second one."),
    }),
    async execute({ box: ref, snapshot, replace, request }, { threadId, signal }) {
      try {
        const id = thread(threadId);
        if (replace !== true) {
          return {
            content: [{ type: "text", text: `A restore replaces the box's disk with the snapshot's: everything on it since goes, and every process in it ends. ${PRODUCT} changed nothing.${next("Call box_restore with replace true if you mean it.")}` }],
            isError: true,
          };
        }
        const { box, standing } = await snapshotTarget(app, id, ref, signal);
        const caller = agent(id);
        const base = request !== undefined ? { request } : {};
        try {
          return restoredForAgent(await app.snapshots.restore(caller, box, standing, snapshot, base), box, false);
        } catch (error) {
          if (!(error instanceof YesNeeded)) throw error;
          let needed: YesNeeded = error;
          const title = await titleOf(id);
          for (let round = 0; round < ASKS_AGAIN_AT_MOST; round++) {
            const payload: RestoreFormPayload = restoreFormPayload(needed.check, needed.asks, standing.runsOn, needed.changed);
            const result = await bb.ui.requestInput(
              {
                threadId: id,
                rendererId: RESTORE_FORM,
                title: restoreFormTitle(payload),
                payload: payload as never,
                timeoutMs: RESTORE_FORM_TIMEOUT_MS,
                presentation: { label: { pending: `Waiting for a yes to restore ${box.name}`, completed: `Answered: restore ${box.name}` } },
                describeSubmission: (value) => ({
                  title: isRestoreYes(value, payload.plan) ? `Restore ${box.name} to "${payload.snapshot.name}": a yes given in this thread` : `Restore ${box.name}: not a yes to this restore`,
                }),
              },
              { signal },
            );
            if (result.outcome === "cancelled") return cancelledText(result.reason, box.name);
            if (!isRestoreYes(result.value, payload.plan)) {
              return {
                content: [{ type: "text", text: `${PRODUCT} did not restore box ${box.name}: the form's answer was not a yes to this restore. Nothing changed.${next("Ask again with box_restore if the person wants it.")}` }],
                isError: true,
              };
            }
            const release = app.turnHold.ask(box, payload.snapshot.name);
            try {
              await quietOn(app, box, AbortSignal.timeout(QUIET_WAIT_MS));
              const answer = await app.snapshots.restore(caller, box, standing, payload.snapshot.id, { ...base, yes: { thread: id, title, plan: payload.plan, at: Date.now() } });
              return restoredForAgent(answer, box, true);
            } catch (again) {
              if (again instanceof YesNeeded && again.changed) {
                needed = again;
                continue;
              }
              const hint = again instanceof BoxError ? (SNAPSHOT_HINTS[again.code] ?? "Call box_status to see the box.") : "Call box_status to see the box.";
              return agentErrorText(again, "Restoring the box on the yes given in this thread", hint);
            } finally {
              release();
            }
          }
          throw new BoxError("in_use", `What restoring box ${box.name} would do kept changing, so ${PRODUCT} asked ${ASKS_AGAIN_AT_MOST} times and restored nothing.`);
        }
      } catch (error) {
        return snapshotFailure(error, "Restoring the box");
      }
    },
  });
}
