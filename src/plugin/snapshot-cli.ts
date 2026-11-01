import { PluginCliError, cliCommand, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { BoxError, OPERATOR, describeError, type BoxRecord } from "../core/boxes.ts";
import { BY_COMMAND } from "../core/box-log.ts";
import { isKept, type Caller, type SnapshotRecord, type Standing } from "../core/snapshot.ts";
import { HOLD_STEPS, HOLD_WORDS, LIVE_CHECKS_VARIABLE, type HoldStepName } from "./live-checks.ts";
import { deletedText, forkCheckText, forkedText, keepCheckText, keptText, listText, restoreCheckText, restoredText, takenText } from "./snapshot-words.ts";
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

function ownerOrNone(options: { readonly machine?: boolean; readonly thread?: string }, ctx: PluginCliContext): string | null {
  return options.machine ? OPERATOR : (options.thread ?? ctx.threadId ?? null);
}

async function boxOrGone(app: BbBox, owner: string | null, boxRef: string): Promise<BoxRecord | null> {
  if (owner === null) {
    if (app.snapshots.ledger.records().some((record) => record.boxGone !== null && (record.box.id === boxRef || record.box.name === boxRef))) return null;
    throw new PluginCliError("No thread.", { code: "missing_required", hint: "Run this in a BB thread, or pass --thread <id> or --machine." });
  }
  try {
    return await app.boxes.get(owner, boxRef);
  } catch (error) {
    if (error instanceof BoxError && error.code === "not_found") return null;
    throw error;
  }
}

function keepInput(options: { readonly days?: unknown; readonly until?: unknown }): { days?: number; until?: string } {
  return { ...(typeof options.days === "number" ? { days: options.days } : {}), ...(typeof options.until === "string" ? { until: options.until } : {}) };
}

function memoryAsked(options: { readonly memory?: unknown; readonly "no-memory"?: unknown }): { memory?: boolean } {
  if (options.memory && options["no-memory"]) throw new BoxError("invalid_value", "Give --memory or --no-memory, not both.");
  if (options.memory) return { memory: true };
  if (options["no-memory"]) return { memory: false };
  return {};
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
        memory: { type: "boolean", description: "Hold the box's memory too, so a restore brings back its running apps: only where its backend can, and slower. Where every snapshot holds it, as on a macOS box on Tart, a take holds it unasked." },
        "no-memory": { type: "boolean", description: "Hold the box's disk only. Refused where every snapshot holds the memory." },
        request: { type: "string", description: "An ID you make, so a repeat of this command is the same take." },
      },
      run: ({ positionals, options }, ctx) =>
        guard("Taking the snapshot", async () => {
          const box = await boxes.get(ownerOf(options, ctx), positionals.box);
          const answer = await snapshots.take(COMMAND, box, standingOf(box), {
            ...(options.name !== undefined ? { name: String(options.name) } : {}),
            ...(options.note !== undefined ? { note: String(options.note) } : {}),
            ...memoryAsked(options),
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
          const box = await boxOrGone(app, ownerOrNone(options, ctx), positionals.box);
          if (!box) {
            const record = snapshots.findGone(positionals.box, positionals.snapshot);
            const answer = await snapshots.deleteGone(record, BY_COMMAND);
            return options.json ? json(answer) : out(deletedText(answer, record.box.name));
          }
          const answer = await snapshots.delete(COMMAND, standingOf(box), positionals.snapshot, options.request !== undefined ? { request: String(options.request) } : {});
          return options.json ? json(answer) : out(deletedText(answer, box.name));
        }),
    }),
    "snapshot restore": cliCommand({
      summary:
        "Restore a thread's box, or with --machine one of your machines, to one of its snapshots: everything on its disk since then goes, and the box restarts. bb-box takes an undo first, a snapshot of the box once stopped, unless --no-undo. It refuses while a person holds the box's desktop or a BB terminal is open on it, unless --force. It refuses a box threads run on, as restores of such boxes stay off until bb-box can hold every turn on them. Asks for --replace.",
      positionals: [
        { name: "box", description: "The box's name or ID.", required: true },
        { name: "snapshot", description: "The snapshot's name or ID.", required: true },
      ],
      options: {
        ...threadOption,
        ...machineOption,
        ...jsonOption,
        replace: { type: "boolean", description: "Replace the box's disk with the snapshot's." },
        "no-undo": { type: "boolean", description: "Take no undo first, so this cannot be undone." },
        force: { type: "boolean", description: "Restore anyway while a person holds the box's desktop or a BB terminal is open on it, ending them." },
        unflushed: { type: "boolean", description: "Restore anyway when bb-box cannot flush the box's writes to its disk before stopping it, so its undo may miss the last seconds' writes." },
        check: { type: "boolean", description: "Say what the restore would do, and refuse what it would refuse, changing nothing." },
        request: { type: "string", description: "An ID you make, so a repeat of this command is the same restore." },
      },
      run: ({ positionals, options }, ctx) =>
        guard("Restoring the snapshot", async () => {
          const box = await boxes.get(ownerOf(options, ctx), positionals.box);
          if (options.check) {
            const check = await snapshots.checkRestore(COMMAND, box, standingOf(box), positionals.snapshot, { ...(options["no-undo"] ? { undo: false } : {}), ...(options.force ? { force: true } : {}) });
            return options.json ? json(check) : out(restoreCheckText(check));
          }
          if (!options.replace) {
            return {
              exitCode: 1,
              stderr: `A restore replaces box ${box.name}'s disk with the snapshot's: everything on it since goes, and every process in it ends. Run it again with --replace to restore.\n`,
            };
          }
          const answer = await snapshots
            .restore(COMMAND, box, standingOf(box), positionals.snapshot, {
              ...(options["no-undo"] ? { undo: false } : {}),
              ...(options.force ? { force: true } : {}),
              ...(options.unflushed ? { unflushed: "go-on" as const } : {}),
              ...(options.request !== undefined ? { request: String(options.request) } : {}),
            })
            .catch((error: unknown) => {
              if (error instanceof BoxError && error.code === "unflushed") throw new BoxError("unflushed", `${error.message} Run it again with --unflushed to restore anyway.`);
              throw error;
            });
          return options.json ? json(answer) : out(restoredText(answer, box.name));
        }),
    }),
    "snapshot fork": cliCommand({
      summary:
        "Fork a snapshot of a thread's box, or with --machine one of your machines, into a new box: of the box's thread, or with --as-machine one of your machines. The fork gets the snapshot's files, at its size, and an identity of its own: it resets at its first boot, and bb-box checks that before it is ready. Waits until it is ready. A kept snapshot of a box that was released forks, from its held copy on Proxmox and from the snapshot itself on Tart, as one of your machines; name its box as bb box snapshot list --all does.",
      positionals: [
        { name: "box", description: "The box's name or ID.", required: true },
        { name: "snapshot", description: "The snapshot's name or ID.", required: true },
      ],
      options: {
        ...threadOption,
        ...machineOption,
        ...jsonOption,
        "as-machine": { type: "boolean", description: "Make the fork one of your machines, not a box of the source's thread." },
        name: { type: "string", description: "The new box's name. One is made up when left out." },
        check: { type: "boolean", description: "Say what the fork would be, and refuse what it would refuse, changing nothing." },
        request: { type: "string", description: "An ID you make, so a repeat of this command is the same fork." },
      },
      run: ({ positionals, options }, ctx) =>
        guard("Forking the snapshot", async () => {
          const box = await boxOrGone(app, ownerOrNone(options, ctx), positionals.box);
          const input = { ...(options.name !== undefined ? { name: String(options.name) } : {}), ...(options["as-machine"] ? { asMachine: true } : {}) };
          const gone = box ? null : snapshots.findGone(positionals.box, positionals.snapshot);
          if (options.check) {
            const check = gone ? await snapshots.checkForkGone(gone, input) : await snapshots.checkFork(COMMAND, box!, standingOf(box!), positionals.snapshot, input);
            return options.json ? json(check) : out(forkCheckText(check));
          }
          const request = options.request !== undefined ? { request: String(options.request) } : {};
          const answer = gone ? await snapshots.forkGone(gone, { is: "command" }, { ...input, ...request }) : await snapshots.fork(COMMAND, box!, standingOf(box!), positionals.snapshot, { ...input, ...request });
          const settled = answer.box ? ((await boxes.settled(answer.box)) ?? answer.box) : null;
          if (options.json) return json({ ...answer, box: settled });
          return { exitCode: settled?.state === "ready" ? 0 : 1, stdout: `${forkedText(answer, settled)}\n` };
        }),
    }),
    "snapshot keep": cliCommand({
      summary:
        "Keep a snapshot of a thread's box, or with --machine one of your machines, for 30 days from today unless Settings say otherwise, or until a date: it becomes yours, no agent can delete it, and it outlives its box's release, as a held copy on Proxmox and as it is on Tart. bb-box deletes it after that date. Again on a kept snapshot, it renews its keep, never shortening it unless you give the date. A box that was released is named as bb box snapshot list --all names it.",
      positionals: [
        { name: "box", description: "The box's name or ID.", required: true },
        { name: "snapshot", description: "The snapshot's name or ID.", required: true },
      ],
      options: {
        ...threadOption,
        ...machineOption,
        ...jsonOption,
        days: { type: "integer", min: 1, max: 365, description: "Keep it this many days from today." },
        until: { type: "string", description: "Keep it until the end of this day, in UTC, as yyyy-mm-dd." },
        check: { type: "boolean", description: "Say what keeping it would cost and refuse what it would refuse, changing nothing." },
      },
      run: ({ positionals, options }, ctx) =>
        guard("Keeping the snapshot", async () => {
          const box = await boxOrGone(app, ownerOrNone(options, ctx), positionals.box);
          const input = keepInput(options);
          if (box) {
            if (options.check) {
              const check = await snapshots.checkKeep(COMMAND, standingOf(box), positionals.snapshot, input);
              return options.json ? json(check) : out(keepCheckText(check));
            }
            const answer = await snapshots.keep(COMMAND, standingOf(box), positionals.snapshot, input);
            return options.json ? json(answer) : out(keptText(answer));
          }
          const record = snapshots.findGone(positionals.box, positionals.snapshot);
          if (options.check) {
            const check = await snapshots.checkKeepGone(record, input);
            return options.json ? json(check) : out(keepCheckText(check));
          }
          const answer = await snapshots.keepGone(record, BY_COMMAND, input);
          return options.json ? json(answer) : out(keptText(answer));
        }),
    }),
    "snapshot unkeep": cliCommand({
      summary: "Stop keeping a snapshot of a thread's box, or with --machine one of your machines: it goes with its box again. A released box's kept snapshot is deleted instead, with bb box snapshot delete.",
      positionals: [
        { name: "box", description: "The box's name or ID.", required: true },
        { name: "snapshot", description: "The snapshot's name or ID.", required: true },
      ],
      options: { ...threadOption, ...machineOption, ...jsonOption },
      run: ({ positionals, options }, ctx) =>
        guard("Stopping keeping the snapshot", async () => {
          const box = await boxOrGone(app, ownerOrNone(options, ctx), positionals.box);
          const record = box ? await snapshots.unkeep(COMMAND, standingOf(box), positionals.snapshot) : await snapshots.unkeepGone(snapshots.findGone(positionals.box, positionals.snapshot), BY_COMMAND);
          return options.json ? json(record) : out(`"${record.name}" (${record.id}) of box ${record.box.name} is no longer kept: it goes with its box again.`);
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
            summary: `For live checks, with ${LIVE_CHECKS_VARIABLE}=1 on BB's server: the next snapshot operation to reach the step named stops there, as if bb-box stopped there, until bb-box restarts.`,
            options: {
              at: {
                type: "enum",
                values: HOLD_STEPS,
                description:
                  "planned: once recorded, before the backend is asked; task: once a provider's task has begun; checked: once a restore's last check for running turns is done, before its stop; stopped, undo, rolled-back, started: once a restore's stop, undo, rollback or start is done; forked: once a fork's copy is made, given its own addresses and disarmed, before its links come up and its first start.",
              },
              seconds: { type: "integer", min: 1, max: 3600, description: "Hold for this many seconds, then go on. Without it, the hold lasts until bb-box restarts." },
              off: { type: "boolean", description: "Hold nothing." },
            },
            async run({ options }) {
              const step = options.off ? null : ((options.at as HoldStepName | undefined) ?? "task");
              const seconds = typeof options.seconds === "number" && options.seconds > 0 ? options.seconds : null;
              holds.arm(step, seconds === null ? null : seconds * 1000);
              return out(step ? `The next snapshot operation to reach it stops after ${HOLD_WORDS[step]}, ${seconds === null ? "until bb-box restarts" : `for ${seconds} s`}.` : "No snapshot operation is held.");
            },
          }),
        }
      : {}),
    ...(app.machineRestores
      ? {
          "snapshot machine-restores": cliCommand({
            summary: `For live checks, with ${LIVE_CHECKS_VARIABLE}=1 on BB's server: turns restores of boxes threads run on, by the person and by an agent through the form, on or off until bb-box restarts.`,
            positionals: [{ name: "switch", description: "on or off.", required: true }],
            async run({ positionals }) {
              if (positionals.switch !== "on" && positionals.switch !== "off") throw new PluginCliError(`Give on or off, not "${positionals.switch}".`, { code: "invalid_value" });
              app.machineRestores!.set(positionals.switch === "on");
              return out(
                positionals.switch === "on"
                  ? "Restores of boxes threads run on are on until bb-box restarts: always with an undo, from disk snapshots only, holding every turn on the box while they run."
                  : "Restores of boxes threads run on are off, for live checks, until bb-box restarts.",
              );
            },
          }),
        }
      : {}),
    ...(app.zfsOrder
      ? {
          "snapshot zfs-order": cliCommand({
            summary: `For live checks, with ${LIVE_CHECKS_VARIABLE}=1 on BB's server: restores on a backend from now on run ZFS's order where its storage is not ZFS, until bb-box restarts. Such a restore takes a held copy of the stopped box as its undo and restores only the newest snapshot, and undoing it swaps the box to a new guest made from the copy.`,
            positionals: [
              { name: "backend", description: "The backend's ID, as bb box config show lists it.", required: true },
              { name: "switch", description: "on or off.", required: true },
            ],
            async run({ positionals }) {
              const backend = positionals.backend!;
              if (!app.backends.get(backend)) throw new PluginCliError(`There is no backend "${backend}".`, { code: "not_found", hint: "bb box config show lists the backends' IDs." });
              if (positionals.switch !== "on" && positionals.switch !== "off") throw new PluginCliError(`Give on or off, not "${positionals.switch}".`, { code: "invalid_value" });
              app.zfsOrder!.set(backend, positionals.switch === "on");
              return out(positionals.switch === "on" ? `Restores on ${backend} run ZFS's order from now on, for live checks, until bb-box restarts.` : `Restores on ${backend} run in its storage's own order again.`);
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
          "snapshot fake-included": cliCommand({
            summary: `For live checks, with ${LIVE_CHECKS_VARIABLE}=1 on BB's server: bb-box counts a backend's plan as including fewer snapshots than its provider says, so the ceiling can be checked without holding many. Until bb-box restarts.`,
            positionals: [
              { name: "backend", description: "The backend's ID, as bb box config show lists it.", required: true },
              { name: "count", description: "How many snapshots to count as included, such as 1; or off.", required: true },
            ],
            async run({ positionals }) {
              const backend = positionals.backend!;
              if (!app.backends.get(backend)) throw new PluginCliError(`There is no backend "${backend}".`, { code: "not_found", hint: "bb box config show lists the backends' IDs." });
              if (positionals.count === "off") {
                prices.setIncluded(backend, null);
                return out(`bb-box counts the snapshots ${backend}'s plan includes as its provider says again.`);
              }
              const included = Number(positionals.count);
              if (!Number.isInteger(included) || included < 0) throw new PluginCliError(`Give a whole number of snapshots, 0 or more, or off; not "${positionals.count}".`, { code: "invalid_value" });
              prices.setIncluded(backend, included);
              return out(`bb-box counts ${backend}'s plan as including ${included} snapshot${included === 1 ? "" : "s"}, at most what its provider says, for live checks, until bb-box restarts.`);
            },
          }),
        }
      : {}),
  };
}
