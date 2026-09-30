// `bb box`: the same boxes from a terminal, for people and scripts. Commands
// about a thread's boxes use the thread they run in, or --thread.

import { PluginCliError, cliCommand, defineCli, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { BoxError, describeError } from "../core/boxes.ts";
import type { BbBox } from "./setup.ts";
import { boxDetail, boxLine, doctorText } from "./views.ts";

const threadOption = {
  thread: { type: "string", description: "The thread whose boxes to use. Defaults to the thread this runs in." },
} as const;
const jsonOption = { json: { type: "boolean", description: "Print JSON." } } as const;
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
            const kinds = app.kinds();
            if (options.json) return json(kinds);
            if (!kinds.length) return out("No backend is on, so there are no kinds. Turn one on in bb-box's settings.");
            return out(kinds.map((kind) => `${kind.id}: ${kind.label}, ${kind.size}, from ${kind.backends.join(", ")}. ${kind.description}`).join("\n"));
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
          options: { ...threadOption, ...jsonOption, "no-wait": { type: "boolean", description: "Return once the box is recorded." } },
          run: ({ positionals, options }, ctx) =>
            guard("Acquiring a box", async () => {
              const threadId = threadOf(options.thread, ctx);
              const projectId = ctx.projectId ?? (await app.projectOf(threadId));
              let box = await boxes.acquire({ threadId, projectId, kind: positionals.kind });
              if (!options["no-wait"]) box = (await boxes.settled(box)) ?? box;
              if (options.json) return json(app.view(box));
              return { exitCode: box.state === "failed" ? 1 : 0, stdout: `${boxDetail(box)}\n` };
            }),
        }),
        status: cliCommand({
          summary: "Show one box, checking its power state with the backend.",
          positionals: boxPositional,
          options: { ...threadOption, ...jsonOption },
          run: ({ positionals, options }, ctx) =>
            guard("Checking the box", async () => {
              const box = await boxes.refresh(threadOf(options.thread, ctx), positionals.box, ctx.signal);
              return options.json ? json(app.view(box)) : out(boxDetail(box));
            }),
        }),
        release: cliCommand({
          summary: "Release a box. Its disk is deleted.",
          positionals: boxPositional,
          options: threadOption,
          run: ({ positionals, options }, ctx) =>
            guard("Releasing the box", async () => {
              const left = await boxes.release(threadOf(options.thread, ctx), positionals.box);
              if (left) return { exitCode: 1, stderr: `Box ${left.name} is still being released: ${left.error ?? "the backend has not finished"}. The sweep keeps trying.\n` };
              return out(`Released box ${positionals.box}.`);
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
