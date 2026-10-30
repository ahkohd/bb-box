import { PluginCliError, cliCommand, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { BoxError, OPERATOR, describeError, type BoxRecord } from "../core/boxes.ts";
import { BY_COMMAND } from "../core/box-log.ts";
import { isKept, type Caller, type SnapshotRecord, type Standing } from "../core/snapshot.ts";
import { HOLD_STEPS, LIVE_CHECKS_VARIABLE, type HoldStepName } from "./live-checks.ts";
import { deletedText, listText, takenText } from "./snapshot-words.ts";
import type { BbBox } from "./setup.ts";

const COMMAND: Caller = { is: "command" };
const jsonOption = { json: { type: "boolean", description: "Print JSON." } } as const;
const threadOption = { thread: { type: "string", description: "The thread whose boxes to use. Defaults to the thread this runs in." } } as const;
const machineOption = { machine: { type: "boolean", description: "The box is one of your machines, from bb box machines, not a thread's." } } as const;

function out(text: string): PluginCliResult {
  return { exitCode: 0, stdout: `${text}\n` };
}

function json(value: unknown): PluginCliResult {
  return out(JSON.stringify(value, null, 2));
}

async function guard(action: string, task: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    const code = error instanceof BoxError ? error.code : "failed";
    return { exitCode: 1, stderr: `${describeError(error, action)} (${code})\n` };
  }
}

function ownerOf(options: { readonly machine?: boolean; readonly thread?: string }, ctx: PluginCliContext): string {
  if (options.machine) return OPERATOR;
  const threadId = options.thread ?? ctx.threadId;
  if (!threadId) throw new PluginCliError("No thread.", { code: "missing_required", hint: "Run this in a BB thread, or pass --thread <id> or --machine." });
  return threadId;
}

function standingOf(box: BoxRecord): Standing {
  return { box: { id: box.id, threadId: box.threadId }, runsOn: false };
}

function shown(records: readonly SnapshotRecord[], kept: boolean): SnapshotRecord[] {
  return kept ? records.filter(isKept) : [...records];
}

export function snapshotCommands(app: BbBox) {
  const { boxes, snapshots } = app;
  const holds = app.snapshotHolds;
  const prices = app.snapshotPrices;
  return {
    "snapshot take": cliCommand({
      summary:
        "Take a snapshot of a thread's box, or with --machine one of your machines: its disk, or with --memory its disk and its memory where its backend can. Waits until the backend confirms it. A box holds as many as Settings, Snapshots allows, 5 unless set.",
      positionals: [{ name: "box", description: "The box's name or ID.", required: true }],
      options: {
        ...threadOption,
        ...machineOption,
        ...jsonOption,
        name: { type: "string", description: "Its name, at most 60 characters, unique on the box. The time, such as Thu 10:42, when left out." },
        note: { type: "string", description: "A note, at most 1 KB." },
        memory: { type: "boolean", description: "Hold the box's memory too, so a restore brings back its running apps: only where its backend can, and slower." },
        request: { type: "string", description: "An ID you make, so a repeat of this command is the same take." },
      },
      run: ({ positionals, options }, ctx) =>
        guard("Taking the snapshot", async () => {
          const box = await boxes.get(ownerOf(options, ctx), positionals.box);
          const answer = await snapshots.take(COMMAND, box, standingOf(box), {
            ...(options.name !== undefined ? { name: String(options.name) } : {}),
            ...(options.note !== undefined ? { note: String(options.note) } : {}),
            ...(options.memory ? { memory: true } : {}),
            ...(options.request !== undefined ? { request: String(options.request) } : {}),
          });
          return options.json ? json(answer) : out(takenText(answer, box.name, app.snapshots.settings.perBox));
        }),
    }),
    "snapshot list": cliCommand({
      summary: "List the snapshots of a box, of a thread's boxes, of your machines with --machine, or with --all every snapshot bb-box records, those of released boxes too.",
      positionals: [{ name: "box", description: "The box's name or ID. Every box of the thread, or of your machines, when left out.", required: false }],
      options: {
        ...threadOption,
        ...machineOption,
        ...jsonOption,
        all: { type: "boolean", description: "Every snapshot bb-box records, of every thread's boxes and of boxes that are gone." },
        kept: { type: "boolean", description: "Only kept snapshots." },
      },
      run: ({ positionals, options }, ctx) =>
        guard("Listing snapshots", async () => {
          let records: SnapshotRecord[];
          if (options.all) records = snapshots.ledger.records();
          else if (positionals.box) {
            const box = await boxes.get(ownerOf(options, ctx), positionals.box);
            records = snapshots.visible(COMMAND, standingOf(box));
          } else {
            const ids = new Set((await boxes.list(ownerOf(options, ctx))).map((box) => box.id));
            records = snapshots.ledger.records().filter((record) => ids.has(record.box.id));
          }
          const list = shown(records, options.kept === true);
          if (options.json) return json(list);
          if (!list.length) return out(options.kept ? "There are no kept snapshots." : "There are no snapshots.");
          return out(listText(list, app.snapshots.settings.perBox));
        }),
    }),
    "snapshot delete": cliCommand({
      summary: "Delete a snapshot of a thread's box, or with --machine one of your machines, by its name or ID, and wait until its backend confirms. An incomplete one is cleaned up on its host. A box that is gone is named by the ID bb box snapshot list --all gives.",
      positionals: [
        { name: "box", description: "The box's name or ID.", required: true },
        { name: "snapshot", description: "The snapshot's name or ID.", required: true },
      ],
      options: { ...threadOption, ...machineOption, ...jsonOption, request: { type: "string", description: "An ID you make, so a repeat of this command is the same delete." } },
      run: ({ positionals, options }, ctx) =>
        guard("Deleting the snapshot", async () => {
          let box: BoxRecord | null = null;
          try {
            box = await boxes.get(ownerOf(options, ctx), positionals.box);
          } catch (error) {
            if (!(error instanceof BoxError && error.code === "not_found")) throw error;
          }
          if (!box) {
            const record = snapshots.findGone(positionals.box, positionals.snapshot);
            const answer = await snapshots.deleteGone(record, BY_COMMAND);
            return options.json ? json(answer) : out(deletedText(answer, record.box.name));
          }
          const answer = await snapshots.delete(COMMAND, standingOf(box), positionals.snapshot, options.request !== undefined ? { request: String(options.request) } : {});
          return options.json ? json(answer) : out(deletedText(answer, box.name));
        }),
    }),
    "snapshot forget": cliCommand({
      summary:
        "Forget every snapshot bb-box records on a backend, so the backend can be removed from bb-box's settings. bb-box deletes nothing: they may still exist there, and be billed. Asks for --yes.",
      positionals: [{ name: "backend", description: "The backend's ID, from bb box backend list.", required: true }],
      options: { yes: { type: "boolean", description: "Forget them." } },
      run: ({ positionals, options }) =>
        guard("Forgetting the snapshots", async () => {
          const held = snapshots.heldOn(positionals.backend);
          const records = snapshots.ledger.records({ backend: positionals.backend });
          if (!records.length) return out(`bb-box records no snapshots on backend ${positionals.backend}.`);
          if (!options.yes) {
            return {
              exitCode: 1,
              stderr: `This forgets ${held?.words ?? `${records.length} records of snapshots`}. bb-box deletes none of them: they may still exist on that backend, and be billed. Run it again with --yes to forget them.\n`,
            };
          }
          const forgotten = snapshots.forgetBackend(positionals.backend);
          return out(`Forgot ${forgotten.length} ${forgotten.length === 1 ? "snapshot" : "snapshots"} on backend ${positionals.backend}. Nothing was deleted there.`);
        }),
    }),
    ...(holds
      ? {
          "snapshot hold-next": cliCommand({
            summary: `For live checks, with ${LIVE_CHECKS_VARIABLE}=1 on BB's server: the next snapshot take or delete stops after the step named, as if bb-box stopped there, until bb-box restarts.`,
            options: {
              at: { type: "enum", values: HOLD_STEPS, description: "planned: once recorded, before the backend is asked; task: once the backend's task has begun." },
              off: { type: "boolean", description: "Hold nothing." },
            },
            async run({ options }) {
              const step = options.off ? null : ((options.at as HoldStepName | undefined) ?? "task");
              holds.arm(step);
              return out(step ? `The next snapshot take or delete stops ${step === "planned" ? "once it is recorded" : "once its backend's task has begun"}, until bb-box restarts.` : "No snapshot operation is held.");
            },
          }),
        }
      : {}),
    ...(prices
      ? {
          "snapshot fake-price": cliCommand({
            summary: `For live checks, with ${LIVE_CHECKS_VARIABLE}=1 on BB's server: snapshots taken on a backend from now on carry a made-up price in US dollars a day, so the ceiling on paid snapshots can be checked where no backend charges. Until bb-box restarts.`,
            positionals: [
              { name: "backend", description: "The backend's ID, as bb box config show lists it.", required: true },
              { name: "amount", description: "Dollars a day for each snapshot, such as 0.056; or off.", required: true },
            ],
            async run({ positionals }) {
              const backend = positionals.backend!;
              if (!app.backends.get(backend)) throw new PluginCliError(`There is no backend "${backend}".`, { code: "not_found", hint: "bb box config show lists the backends' IDs." });
              if (positionals.amount === "off") {
                prices.set(backend, null);
                return out(`Snapshots taken on ${backend} from now on carry its own price.`);
              }
              const daily = Number(positionals.amount);
              if (!Number.isFinite(daily) || daily <= 0) throw new PluginCliError(`Give an amount a day above 0, such as 0.056, or off; not "${positionals.amount}".`, { code: "invalid_value" });
              prices.set(backend, daily);
              return out(`Snapshots taken on ${backend} from now on carry a made-up price of $${daily} a day, for live checks, until bb-box restarts.`);
            },
          }),
        }
      : {}),
  };
}
