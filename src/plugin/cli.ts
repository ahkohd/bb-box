// `bb box`: the same boxes from a terminal, for people and scripts. Commands
// about a thread's boxes use the thread they run in, or --thread.

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { BoxError, OPERATOR, describeError } from "../core/boxes.ts";
import type { DoctorReport } from "../backends/types.ts";
import type { Problem } from "../core/document.ts";
import { PRESETS } from "../core/sizes.ts";
import type { BbBox } from "./setup.ts";
import { adminText, boxDetail, dockerText, boxLine, configText, doctorText, idleWords, movedText, problemsText } from "./views.ts";

const threadOption = {
  thread: { type: "string", description: "The thread whose boxes to use. Defaults to the thread this runs in." },
} as const;
const jsonOption = { json: { type: "boolean", description: "Print JSON." } } as const;
/** A preset and any parts of a custom size (028). bb-box refuses a size above the kind's largest. */
const sizeOptions = {
  size: { type: "enum", values: PRESETS, description: "A preset. Defaults to the kind's default preset; bb box kinds shows each kind's sizes." },
  cores: { type: "integer", min: 1, max: 1024, description: "Cores, for a custom size. Parts left out come from the preset." },
  "memory-gib": { type: "integer", min: 1, max: 65536, description: "Memory in GiB, for a custom size." },
  "disk-gib": { type: "integer", min: 1, max: 65536, description: "Root disk in GiB, for a custom size. Presets keep the kind's own disk." },
} as const;
const boxPositional = [{ name: "box", description: "The box's name or ID.", required: true }] as const;

function out(text: string): PluginCliResult {
  return { exitCode: 0, stdout: `${text}\n` };
}

function json(value: unknown): PluginCliResult {
  return out(JSON.stringify(value, null, 2));
}

function threadOf(option: string | undefined, ctx: PluginCliContext): string {
  const threadId = option ?? ctx.threadId;
  if (!threadId) throw new PluginCliError("No thread.", { code: "missing_required", hint: "Run this in a BB thread, or pass --thread <id>." });
  return threadId;
}

/** Runs a command, turning bb-box's refusals into CLI errors that say what to do. */
async function guard(action: string, task: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    const code = error instanceof BoxError ? error.code : "failed";
    return { exitCode: 1, stderr: `${describeError(error, action)} (${code})\n` };
  }
}

const fileArgument = [
  {
    name: "file",
    description: "A JSON file in the form bb box config show --json prints. It is read on the machine BB's server runs on; a relative path is from where you run bb.",
    required: true,
  },
] as const;

/** A configuration file, read where BB's server runs: the command runs there and gets no input. */
async function readConfigFile(path: string, ctx: PluginCliContext): Promise<unknown> {
  const file = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new PluginCliError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      code: "invalid_input",
      hint: "The file is read on the machine BB's server runs on.",
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PluginCliError(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`, { code: "invalid_input" });
  }
}

function refused(problems: readonly Problem[], what: string): PluginCliResult {
  return { exitCode: 1, stderr: `${what}\n${problemsText(problems)}\n` };
}

export function registerCli(bb: BbPluginApi, app: BbBox): void {
  const { boxes } = app;
  bb.cli.register(
    defineCli({
      name: "box",
      summary: "Fast boxes for BB threads: list, acquire and release them, and check the backends.",
      commands: {
        doctor: cliCommand({
          summary: "Check each backend's settings and host, and say how to fix what is wrong.",
          options: jsonOption,
          async run({ options }, ctx) {
            const view = await app.doctor(ctx.signal);
            if (options.json) return json(view);
            return { exitCode: view.ok ? 0 : 1, stdout: `${doctorText(view)}\n` };
          },
        }),
        kinds: cliCommand({
          summary: "List the kinds of box the active backends offer.",
          options: jsonOption,
          async run({ options }) {
            const kinds = await app.kinds();
            if (options.json) return json(kinds);
            if (!kinds.length) return out("No backend is on, so there are no kinds. Turn one on in bb-box's settings.");
            return out(
              kinds
                .map((kind) => {
                  const presets = kind.presets.map((preset) => `  ${preset.name}${preset.name === kind.defaultPreset ? " (default)" : ""}: ${preset.words}`);
                  return [`${kind.id}: ${kind.label}${kind.gpu ? " (GPU)" : ""}, from ${kind.backends.join(", ")}. ${kind.description} ${[adminText(kind), dockerText(kind)].filter(Boolean).join(" ")}`, ...presets, `  largest: ${kind.largest.words}`].join("\n");
                })
                .join("\n"),
            );
          },
        }),
        list: cliCommand({
          summary: "List a thread's boxes, or every box with --all.",
          options: { ...threadOption, ...jsonOption, all: { type: "boolean", description: "List the boxes of every thread." } },
          async run({ options }, ctx) {
            const list = options.all ? await boxes.all() : await boxes.list(threadOf(options.thread, ctx));
            if (options.json) return json(list.map(app.view));
            if (!list.length) return out(options.all ? "There are no boxes." : "This thread has no boxes.");
            return out(list.map((box) => (options.all ? `${boxLine(box)} [thread ${box.threadId}]` : boxLine(box))).join("\n"));
          },
        }),
        acquire: cliCommand({
          summary: "Acquire a box for a thread and wait until it answers.",
          positionals: [{ name: "kind", description: "The kind of box, from bb box kinds.", required: true }],
          options: { ...threadOption, ...jsonOption, ...sizeOptions, "no-wait": { type: "boolean", description: "Return once the box is recorded." } },
          run: ({ positionals, options }, ctx) =>
            guard("Acquiring a box", async () => {
              const threadId = threadOf(options.thread, ctx);
              const projectId = ctx.projectId ?? (await app.projectOf(threadId));
              const size = { preset: options.size, cores: options.cores, memoryGiB: options["memory-gib"], diskGiB: options["disk-gib"] };
              let box = await boxes.acquire({ threadId, projectId, kind: positionals.kind, size });
              if (!options["no-wait"]) box = (await boxes.settled(box)) ?? box;
              if (options.json) return json(app.view(box));
              return { exitCode: box.state === "failed" ? 1 : 0, stdout: `${boxDetail(box, app.control(box))}\n` };
            }),
        }),
        status: cliCommand({
          summary: "Show one box, checking its power state with the backend.",
          positionals: boxPositional,
          options: { ...threadOption, ...jsonOption },
          run: ({ positionals, options }, ctx) =>
            guard("Checking the box", async () => {
              const box = await boxes.refresh(threadOf(options.thread, ctx), positionals.box, ctx.signal);
              return options.json ? json(app.view(box)) : out(boxDetail(box, app.control(box)));
            }),
        }),
        machines: cliCommand({
          summary: "List your machines: boxes you own, kept as BB machines, which no thread ending releases.",
          options: jsonOption,
          async run({ options }) {
            const machines = (await boxes.list(OPERATOR)).filter((box) => box.state !== "releasing").sort((a, b) => a.createdAt - b.createdAt);
            if (options.json) return json(machines.map(app.view));
            if (!machines.length) return out("You have no machines. bb box machines add <kind> adds one.");
            return out(machines.map(boxLine).join("\n"));
          },
        }),
        "machines add": cliCommand({
          summary: "Add a machine of your own: a box of the kind, kept as a BB machine under the name until you remove it.",
          positionals: [{ name: "kind", description: "The kind of box, from bb box kinds. It must be able to become a BB machine.", required: true }],
          options: { ...jsonOption, ...sizeOptions, name: { type: "string", description: "Its name, which is also its BB machine's: a lower-case letter first, then letters, digits and \"-\". bb-box picks one when left out." }, "no-wait": { type: "boolean", description: "Return once the box is recorded." } },
          run: ({ positionals, options }) =>
            guard("Adding the machine", async () => {
              const size = { preset: options.size, cores: options.cores, memoryGiB: options["memory-gib"], diskGiB: options["disk-gib"] };
              let box = await boxes.acquire({ threadId: OPERATOR, projectId: null, kind: positionals.kind, size, ...(options.name ? { name: options.name } : {}) });
              if (!options["no-wait"]) box = await boxes.enrolled((await boxes.settled(box)) ?? box);
              if (options.json) return json(app.view(box));
              return { exitCode: box.state === "failed" ? 1 : 0, stdout: `${boxDetail(box, app.control(box))}\n` };
            }),
        }),
        "machines remove": cliCommand({
          summary: "Remove one of your machines: its box is released and its disk deleted. A machine a thread is working on is refused unless --force.",
          positionals: [{ name: "machine", description: "The machine's name or ID, from bb box machines.", required: true }],
          options: { force: { type: "boolean", description: "Remove it even while threads are working on it, which ends their work." } },
          run: ({ positionals, options }) =>
            guard("Removing the machine", async () => {
              const box = await boxes.get(OPERATOR, positionals.machine);
              const idle = options.force ? await app.threadsOn(box) : await app.checkInUse(box, "Releasing");
              const left = await boxes.release(OPERATOR, box.id);
              if (left) return { exitCode: 1, stderr: `Machine ${left.name} is still being removed: ${left.error ?? "the backend has not finished"}. The sweep keeps trying.\n` };
              return out(`Removed machine ${box.name}.${idleWords(idle, false)}`);
            }),
        }),
        thread: cliCommand({
          summary: "Start a child thread of a thread on one of its boxes, as a BB machine, with the thread's project.",
          positionals: boxPositional,
          options: { ...threadOption, ...jsonOption, prompt: { type: "string", description: "The child thread's first message.", required: true } },
          run: ({ positionals, options }, ctx) =>
            guard("Starting a thread on the box", async () => {
              const threadId = await app.startThread({ threadId: threadOf(options.thread, ctx), box: positionals.box, prompt: options.prompt, signal: ctx.signal });
              return options.json ? json({ threadId }) : out(`Started thread ${threadId} on box ${positionals.box}.`);
            }),
        }),
        release: cliCommand({
          summary: "Release a box. Its disk is deleted. A box a thread is working on is refused unless --force.",
          positionals: boxPositional,
          options: { ...threadOption, force: { type: "boolean", description: "Release it even while threads are working on it, which ends their work." } },
          run: ({ positionals, options }, ctx) =>
            guard("Releasing the box", async () => {
              const threadId = threadOf(options.thread, ctx);
              const box = await boxes.get(threadId, positionals.box);
              const idle = options.force ? await app.threadsOn(box) : await app.checkInUse(box, "Releasing");
              const left = await boxes.release(threadId, positionals.box);
              if (left) return { exitCode: 1, stderr: `Box ${left.name} is still being released: ${left.error ?? "the backend has not finished"}. The sweep keeps trying.\n` };
              return out(`Released box ${positionals.box}.${idleWords(idle, false)}`);
            }),
        }),
        "docker-check": cliCommand({
          summary: "Check that Docker on a BB machine answers through bb-box's Docker relay (042), with its version, cores and memory.",
          positionals: [{ name: "machine", description: "The BB machine's ID or name, from bb machine list.", required: true }],
          options: jsonOption,
          run: ({ positionals, options }, ctx) =>
            guard("Checking Docker on the machine", async () => {
              const check = await app.dockerCheck(positionals.machine, ctx.signal);
              if (options.json) return json(check);
              const { info } = check;
              return out(
                `Docker ${info.version} on ${check.name} (${check.hostId}) answers through bb-box's relay: ${info.operatingSystem}, ${info.arch}, ` +
                  `${info.cpus} cores, ${(info.memoryMiB / 1024).toFixed(1)} GiB memory. ` +
                  `The first call took ${(check.firstMs / 1000).toFixed(1)} s, opening the relay if it was closed; the next ${(check.againMs / 1000).toFixed(2)} s.`,
              );
            }),
        }),
        "docker-build": cliCommand({
          summary: "Build the images a BB machine that hosts Docker boxes lacks there, or has from another layout, through bb-box's relay (042). Waits for the build.",
          positionals: [{ name: "machine", description: "The BB machine's ID or name, from bb machine list. It must be turned on under Docker on BB machines.", required: true }],
          run: ({ positionals }) =>
            guard("Building the images", async () => {
              const host = (await app.dockerHosts.list()).find((candidate) => candidate.hostId === positionals.machine || candidate.name === positionals.machine);
              if (!host?.backend) throw new BoxError("not_found", `${positionals.machine} is not a Docker host in bb-box's settings. Turn it on under Docker on BB machines first.`);
              const build = await app.dockerImages.ensure(host.hostId);
              const took = build.endedAt ? ` in ${Math.round((build.endedAt - build.startedAt) / 1000)} s` : "";
              if (build.state === "failed") return { exitCode: 1, stderr: `Building the images on ${host.name} failed${took}: ${build.detail ?? "no reason given"}\n` };
              return out(build.targets.length ? `Built ${build.targets.join(" and ")} on ${host.name}${took}.` : `${host.name} has every image it needs.${build.detail ? ` ${build.detail}` : ""}`);
            }),
        }),
        "install-id": cliCommand({
          summary: "Show this install's ID, which it records on its guests. --set takes back the ID it had before it lost its storage.",
          options: { ...jsonOption, set: { type: "string", description: "The ID to use from now on, as bb box doctor lists it." } },
          run: ({ options }) =>
            guard("Setting the install ID", async () => {
              const before = app.backends.installId;
              if (options.set !== undefined) await app.setInstallId(options.set);
              const installId = app.backends.installId;
              if (options.json) return json({ installId });
              if (installId === before) return out(`This install's ID is ${installId}.`);
              return out(`This install's ID is now ${installId}. The next sweep restores the boxes of the guests that carry it; run bb box sweep to do it now.`);
            }),
        }),
        "config show": cliCommand({
          summary: "Show bb-box's configuration. --json prints it as a file for config apply, with no secret in it: keep it to set bb-box up again.",
          options: jsonOption,
          async run({ options }) {
            const state = await app.configuration.state();
            if (options.json) return json(state.document);
            return out(configText(state));
          },
        }),
        "config check": cliCommand({
          summary: "Check a configuration file without saving it. --test also runs the doctor of each backend in it that is on, within 30 s each.",
          positionals: fileArgument,
          options: { ...jsonOption, test: { type: "boolean", description: "Run each backend's doctor against the file's settings. It acquires nothing." } },
          run: ({ positionals, options }, ctx) =>
            guard("Checking the configuration", async () => {
              const draft = await readConfigFile(positionals.file, ctx);
              const { configuration } = app;
              const result = await configuration.check(draft, undefined, ctx.signal);
              const tested: { id: string; report: DoctorReport | null }[] = [];
              for (const id of options.test ? configuration.enabledIn(draft) : []) {
                tested.push({ id, report: (await configuration.check(draft, id, ctx.signal)).doctor });
              }
              if (options.json) return json({ problems: result.problems, doctors: tested });
              const lines = [result.problems.length ? `Problems:\n${problemsText(result.problems)}` : "No problems."];
              for (const { id, report } of tested) {
                lines.push(report ? doctorText({ ok: report.ok, sections: [{ title: id, report }] }) : `${id}: not checked, since its settings have problems.`);
              }
              const ok = !result.problems.length && tested.every(({ report }) => report?.ok);
              return { exitCode: ok ? 0 : 1, stdout: `${lines.join("\n")}\n` };
            }),
        }),
        "config apply": cliCommand({
          summary:
            "Save a configuration file as bb-box's whole configuration, then rebuild what changed. A revision in the file must be the current one; a file without one, or --replace, saves over what is there, as when setting bb-box up again from an export.",
          positionals: fileArgument,
          options: { ...jsonOption, replace: { type: "boolean", description: "Save over the current configuration whatever revision the file names." } },
          run: ({ positionals, options }, ctx) =>
            guard("Applying the configuration", async () => {
              const draft = await readConfigFile(positionals.file, ctx);
              const revision = (draft as { revision?: unknown })?.revision;
              const result = await app.configuration.apply(draft, typeof revision === "number" && !options.replace ? revision : null);
              if (options.json) return { exitCode: result.ok ? 0 : 1, stdout: `${JSON.stringify(result.ok ? result.state.document : result, null, 2)}\n` };
              if (result.ok) {
                const saved = `Saved revision ${result.state.revision}. bb box config show shows it, and bb box doctor checks the backends.`;
                return out(result.problems.length ? `${saved}\nSaved with these problems, in backends that are off:\n${problemsText(result.problems)}` : saved);
              }
              if (result.reason === "revision") {
                return {
                  exitCode: 1,
                  stderr:
                    `The configuration changed since revision ${String(revision)}: it is at revision ${result.state.revision}. ` +
                    "Run bb box config show --json again and make your change there, or, to save the file over it, remove its revision or use --replace.\n",
                };
              }
              return refused(result.problems, "Nothing was saved. Fix these first:");
            }),
        }),
        "config migrated": cliCommand({
          summary: "Show the copy of BB's settings bb-box kept when it moved them into its configuration. --remove removes it.",
          options: { ...jsonOption, remove: { type: "boolean", description: "Remove the copy." } },
          async run({ options }) {
            if (options.remove) {
              const had = await app.configuration.removeMigrated();
              return out(had ? "Removed the copy of BB's settings." : "There is no copy of BB's settings.");
            }
            const copy = await app.configuration.migrated();
            if (options.json) return json(copy);
            return out(copy ? movedText(copy) : "There is no copy of BB's settings: bb-box never moved any, or the copy was removed.");
          },
        }),
        sweep: cliCommand({
          summary: "Run the clean-up now: release the boxes of ended threads, finish interrupted work and remove leftovers.",
          options: jsonOption,
          run: ({ options }, ctx) =>
            guard("Sweeping", async () => {
              const report = await boxes.sweep(ctx.signal);
              if (options.json) return json(report);
              return out(
                [
                  `Boxes of ended threads released: ${report.released}`,
                  `Leftover guests removed: ${report.leftovers}`,
                  `Boxes restored from their guests: ${report.adopted}`,
                  `Guests kept until BB says whether their thread ended: ${report.kept}`,
                  `Interrupted acquires and releases carried on: ${report.resumed}`,
                ].join("\n"),
              );
            }),
        }),
      },
    }),
  );
}
