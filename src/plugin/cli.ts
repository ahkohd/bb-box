// `bb box`: the same boxes from a terminal, for people and scripts. Commands
// about a thread's boxes use the thread they run in, or --thread.

import { wholeCardsOn } from "./whole-cards.ts";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { BoxError, OPERATOR, describeError, isAcquiring, type BoxRecord } from "../core/boxes.ts";
import { BY_COMMAND } from "../core/box-log.ts";
import type { DoctorReport } from "../backends/types.ts";
import { withoutSecretVersions, type ImageBake, type Problem } from "../core/document.ts";
import { LIVE_CHECKS_VARIABLE, type ReplyDrops } from "./live-checks.ts";
import { PRESETS } from "../core/sizes.ts";
import { SHARED_MACOS_WORDS } from "../core/device-host.ts";
import { BUILD_FREE_GB } from "./docker-images.ts";
import type { BbBox } from "./setup.ts";
import { adminText, boxDetail, joinAgainWords, dockerText, kindResizeText, kindSnapshotText, resizeText, boxLine, configText, doctorText, idleWords, imageLine, movedText, problemsText, startingWords, tryText, userspaceFixLine, versionsText } from "./views.ts";
import { listensOnEveryAddress, reachableUrl, setupDocker, type ListenOffer } from "./setup-docker.ts";
import { monitorCommands } from "./monitor-cli.ts";
import { configCommands } from "./config-cli.ts";
import { snapshotCommands } from "./snapshot-cli.ts";
import { gpuCommands } from "./gpu-cli.ts";
import { isGpuPart } from "../core/gpu.ts";
import { snapshotStatusLine } from "./snapshot-words.ts";
import { importChangeText } from "../app/settings-import.ts";
import { PRODUCT } from "../brand.ts";

const threadOption = {
  thread: { type: "string", description: "The thread whose boxes to use. Defaults to the thread this runs in." },
} as const;
const jsonOption = { json: { type: "boolean", description: "Print JSON." } } as const;
const deleteKeptOption = { "delete-kept": { type: "boolean", description: "Delete the snapshots of it you kept too, instead of copying them first so they outlive it." } } as const;
/** A preset and any parts of a custom size (028). bb-box refuses a size above the kind's largest. */
/** A resize's size (061): parts left out stay as the box has them. */
const resizeOptions = {
  size: { type: "enum", values: PRESETS, description: "A preset: its cores and memory. The disk stays as it is." },
  cores: { type: "integer", min: 1, max: 1024, description: "Cores. Left out, the box keeps its own." },
  "memory-gib": { type: "integer", min: 1, max: 65536, description: "Memory in GiB: at least 2 for a Linux box. Left out, the box keeps its own." },
  "disk-gib": { type: "integer", min: 1, max: 65536, description: "Root disk in GiB, which only grows. Left out, the box keeps its own." },
  restart: { type: "boolean", description: "Allow a restart, which ends everything running in the box, where a part needs one." },
  check: { type: "boolean", description: "Only say what would change, how, and whether there is room." },
  force: { type: "boolean", description: "Restart it even while threads are working on it, which ends their work." },
} as const;
const sizeOptions = {
  size: { type: "enum", values: PRESETS, description: "A preset. Defaults to the kind's default preset; bb box kinds shows each kind's sizes." },
  cores: { type: "integer", min: 1, max: 1024, description: "Cores, for a custom size. Parts left out come from the preset." },
  "memory-gib": { type: "integer", min: 1, max: 65536, description: "Memory in GiB, for a custom size: at least 2 for a Linux box." },
  "disk-gib": { type: "integer", min: 1, max: 65536, description: "Root disk in GiB, for a custom size. Presets keep the kind's own disk." },
} as const;
/** Where a box goes (044): a provider by its name from bb box kinds, its backend ID or its one host. */
const onOption = {
  on: { type: "string", description: "The provider to use, from bb box kinds, such as \"Docker on devpc\", or several with commas between (pve1,devpc) for the first with room among them: only they are tried. Without it, the first with room." },
} as const;
/** --on's names, one or several with commas between (044). */
function providersOf(text: string): string | string[] {
  const names = text.split(",").map((name) => name.trim()).filter((name) => name.length);
  return names.length === 1 ? names[0]! : names;
}
const CLI_JOIN_WAIT_MS = 2 * 60_000;
const boxPositional = [{ name: "box", description: "The box's name or ID.", required: true }] as const;
const machineOption = { machine: { type: "boolean", description: "The box is one of your machines, from bb box machines, not a thread's." } } as const;

function out(text: string): PluginCliResult {
  return { exitCode: 0, stdout: `${text}\n` };
}

function json(value: unknown): PluginCliResult {
  return out(JSON.stringify(value, null, 2));
}

/** A line for a box an acquire waited for that is not ready yet, with the command that follows it (#533). */
function starting(box: BoxRecord, restarted: boolean, follow: string): string {
  return isAcquiring(box) ? `\n${startingWords(box, restarted)} Follow it with: ${follow}\n` : "";
}

function portOf(url: string | null | undefined): number | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function bbServerPort(appUrl: string | null | undefined, machineServerUrl: string | null | undefined): number | null {
  return portOf(appUrl) ?? portOf(machineServerUrl);
}

export function bbDirectListen(appUrl: string | null | undefined, machineServerUrl: string | null | undefined, tcp: string, tcp6: string, addresses: readonly string[]): ListenOffer | null {
  const port = bbServerPort(appUrl, machineServerUrl);
  if (port === null || !listensOnEveryAddress(port, tcp, tcp6)) return null;
  return { port, url: reachableUrl(port, addresses) };
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

function replyDropCommands(drops: ReplyDrops) {
  return {
    "config drop-replies": cliCommand({
      summary: `For live checks, with ${LIVE_CHECKS_VARIABLE}=1 on BB's server: the next config.apply calls from the settings page that save store the configuration and then drop their reply.`,
      options: { count: { type: "string", description: "How many replies to drop. 1 by default." }, off: { type: "boolean", description: "Drop no more replies." } },
      async run({ options }) {
        const count = options.off ? 0 : Number(options.count ?? "1");
        if (!Number.isInteger(count) || count < 0 || count > 100) return { exitCode: 1, stderr: "Give --count as a whole number from 0 to 100.\n" };
        drops.arm(count);
        return { exitCode: 0, stdout: count ? `The next ${count === 1 ? "save's reply is" : `${count} saves' replies are`} dropped after storing.\n` : "No reply is dropped.\n" };
      },
    }),
  };
}

const fileArgument = [
  {
    name: "file",
    description: "A JSON file in the form bb box config show --json prints. It is read on the machine BB's server runs on; a relative path is from where you run bb.",
    required: true,
  },
] as const;

/** A configuration file, read where BB's server runs: the command runs there and gets no input. */
/** A text file, read on the machine BB's server runs on, from where bb runs for a relative path. */
async function readTextFile(path: string, ctx: PluginCliContext): Promise<string> {
  const file = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new PluginCliError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      code: "invalid_input",
      hint: "The file is read on the machine BB's server runs on.",
    });
  }
}

/** A comma-separated list, such as linux,linux-desktop-cpu. */
const listOf = (value: unknown) => String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

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

/** bb box resize and bb box machines resize (061): a restart asks nothing more, but is refused while a person holds control, and while threads work on the box unless --force. */
async function resizeBox(
  app: BbBox,
  threadId: string,
  ref: string,
  options: { size?: string; cores?: number; "memory-gib"?: number; "disk-gib"?: number; gpu?: string; restart?: boolean; check?: boolean; force?: boolean },
) {
  const gpu = options.gpu === undefined ? undefined : String(options.gpu);
  if (gpu !== undefined && !isGpuPart(gpu)) throw new BoxError("unsupported", `--gpu takes ${wholeCardsOn(app) ? "none, shared or whole" : "none or shared"}, not ${gpu}.`);
  return app.boxes.resize(threadId, ref, { preset: options.size, cores: options.cores, memoryGiB: options["memory-gib"], diskGiB: options["disk-gib"], ...(gpu !== undefined ? { gpu } : {}) }, {
    restart: options.restart === true,
    check: options.check === true,
    by: "the CLI",
    who: BY_COMMAND,
    beforeRestart: async (box) => {
      await app.checkRestart(box, options.force === true);
    },
  });
}

/** A resize's answer, and what it means for the box's BB machine. */
async function resizeWords(app: BbBox, answer: Awaited<ReturnType<typeof resizeBox>>, checked: boolean): Promise<string> {
  const machine = checked ? null : await app.machineCores(answer);
  return `${resizeText(answer, checked)}${machine ? `\n${machine}` : ""}`;
}

function resizeGpuOption(app: BbBox) {
  return {
    gpu: {
      type: "string",
      get description() {
        return wholeCardsOn(app)
          ? "The box's GPU: none; shared, one card other boxes may share; or whole, a card to itself. Left out, the GPU stays as it is. Shared and whole switch live where the box's card allows; on Proxmox LXC adding a GPU, removing it or moving to another card needs --restart, and on Docker it cannot be done. A box with no NVIDIA userspace for the host's driver gets it installed in the same restart, about 60 s more, and a linux-desktop-cpu box becomes a GPU desktop, linux-desktop. A stopped box stays stopped. A resize whose plan changed since its --check is refused, saying what changed."
          : "The box's GPU: none, or shared, one card other boxes may share. Left out, the GPU stays as it is. On Proxmox LXC adding or removing a GPU needs --restart, and on Docker it cannot be done. A box with no NVIDIA userspace for the host's driver gets it installed in the same restart, about 60 s more, and a linux-desktop-cpu box becomes a GPU desktop, linux-desktop. A stopped box stays stopped. A resize whose plan changed since its --check is refused, saying what changed.";
      },
    },
  } as const;
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
            if (!kinds.length) return out(`No backend is on, so there are no kinds. bb box setup docker sets up Docker on the machine that runs BB; or add one with bb box backend add <type>, or in ${PRODUCT}'s settings.`);
            return out(
              kinds
                .map((kind) => {
                  const presets = kind.presets.map((preset) => `  ${preset.name}${preset.name === kind.defaultPreset ? " (default)" : ""}: ${preset.words}`);
                  return [`${kind.id}: ${kind.label}${kind.gpu ? " (GPU)" : ""}, on ${kind.offers.map((offer) => offer.name).join(", ")}. ${kind.description} ${[adminText(kind), dockerText(kind), kindResizeText(kind), kindSnapshotText(kind)].filter(Boolean).join(" ")}`, ...presets, `  largest: ${kind.largest.words}`].join("\n");
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
          options: {
            ...threadOption,
            ...jsonOption,
            ...sizeOptions,
            ...onOption,
            image: { type: "string", description: 'The image to start from: a project\'s image, from bb box image list, or "standard". The thread\'s project\'s image for the kind by default.' },
            device: { type: "string", description: "For an ios or android box, the device it boots, such as iPhone 18 Pro or Pixel Fold. The kind's first by default." },
            "no-slim": { type: "boolean", description: "For an ios box: its iOS Simulator keeps every service, for an app that uses widgets, Siri, iCloud, Health, Wallet or the like. Slimmed by default." },
            gpu: {
              type: "string",
              get description() {
                return wholeCardsOn(app)
                  ? "The box's GPU: none; shared, one card other boxes may share; or whole, a card to itself. Left out, the kind's GPU when not asked for: shared for linux-desktop and none for linux unless bb box kind set --gpu changed it."
                  : "The box's GPU: none, or shared, one card other boxes may share. Left out, the kind's GPU when not asked for: shared for linux-desktop and none for linux unless bb box kind set --gpu changed it.";
              },
            },
            dedicated: { type: "boolean", description: "For an ios box: a macOS VM of its own, with sudo, brew install, its own cores, ports and desktop. Without it, an ios box is shared where a shared iOS host has room. Give it with a size: where a shared iOS host is set up, a size without it is refused." },
            shared: { type: "boolean", description: `For an ios box: a macOS user on a Mac or VM shared with other ios boxes, ready in seconds, with its own device, files and keychain, but no sudo, Homebrew installs or app windows. For a macos box: ${SHARED_MACOS_WORDS}. Only where a shared iOS host is set up; box_list says.` },
            "no-wait": { type: "boolean", description: "Return once the box is recorded." },
          },
          run: ({ positionals, options }, ctx) =>
            guard("Acquiring a box", async () => {
              const threadId = threadOf(options.thread, ctx);
              const projectId = ctx.projectId ?? (await app.projectOf(threadId));
              const size = { preset: options.size, cores: options.cores, memoryGiB: options["memory-gib"], diskGiB: options["disk-gib"] };
              const gpu = options.gpu === undefined ? undefined : String(options.gpu);
              if (gpu !== undefined && gpu !== "none" && gpu !== "shared" && gpu !== "whole") throw new BoxError("unsupported", `--gpu takes ${wholeCardsOn(app) ? "none, shared or whole" : "none or shared"}, not ${gpu}.`);
              let box = await boxes.acquire({ threadId, projectId, kind: positionals.kind, size, ...(options.on ? { on: providersOf(options.on) } : {}), ...(options.image ? { image: String(options.image) } : {}), ...(options.device !== undefined ? { device: String(options.device) } : {}), ...(options["no-slim"] ? { slim: false } : {}), ...(gpu !== undefined ? { gpu } : {}), ...(options.dedicated ? { dedicated: true } : {}), ...(options.shared ? { shared: true } : {}), who: BY_COMMAND });
              if (!options["no-wait"]) box = (await boxes.settled(box)) ?? box;
              if (options.json) return json(app.view(box));
              const follow = `bb box status ${box.name}${options.thread ? ` --thread ${threadId}` : ""}`;
              return { exitCode: box.state === "failed" ? 1 : 0, stdout: `${boxDetail(box, app.control(box))}\n${options["no-wait"] ? "" : starting(box, boxes.stopping, follow)}` };
            }),
        }),
        status: cliCommand({
          summary: "Show one box, checking its power state with the backend.",
          positionals: boxPositional,
          options: { ...threadOption, ...jsonOption },
          run: ({ positionals, options }, ctx) =>
            guard("Checking the box", async () => {
              const box = await boxes.refresh(threadOf(options.thread, ctx), positionals.box, ctx.signal);
              if (options.json) return json(app.view(box));
              const snapshots = snapshotStatusLine(box, app.snapshots.offerFor(app.backends.get(box.backend), box.kind), app.snapshots.seen({ is: "command" }, { box: { id: box.id, threadId: box.threadId }, runsOn: false }), app.snapshots.settings.perBox);
              const userspace = userspaceFixLine(box);
              return out(`${boxDetail(box, app.control(box))}${userspace ? `\n${userspace}` : ""}${snapshots ? `\n${snapshots}` : ""}`);
            }),
        }),
        run: cliCommand({
          summary: "Run a shell command in a thread's box, or with --machine in one of your machines, as its user, and print its output. It exits with the command's exit code. For a long command, use box_run, which keeps it as a job.",
          positionals: [
            { name: "box", description: "The box's name or ID.", required: true },
            { name: "command", description: "The command, run by the box user's shell, such as \"uname -a\". Quote it as one word.", required: true, variadic: true },
          ],
          options: {
            ...threadOption,
            machine: { type: "boolean", description: "The box is one of your machines, from bb box machines, not a thread's." },
            "timeout-seconds": { type: "integer", min: 1, max: 600, description: "Seconds before the command is stopped: 120 by default, at most 600." },
          },
          run: ({ positionals, options }, ctx) =>
            guard("Running the command", async () => {
              const owner = options.machine ? OPERATOR : threadOf(options.thread, ctx);
              const box = await boxes.get(owner, positionals.box);
              const command = (positionals.command as string[]).join(" ");
              const { result } = await boxes.run(owner, box.id, command, { timeoutMs: (options["timeout-seconds"] ?? 120) * 1000, ...(ctx.signal ? { signal: ctx.signal } : {}), maxOutputBytes: 1024 * 1024 });
              if (result.timedOut) return { exitCode: 124, stdout: result.stdout, stderr: `${result.stderr}Timed out in box ${box.name} after ${(result.durationMs / 1000).toFixed(1)} s.\n` };
              return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
            }),
        }),
        resize: cliCommand({
          summary: "Resize a thread's box: its cores, memory, disk or GPU, where its backend can, live or with --restart. Parts left out stay as they are, and the disk only grows.",
          positionals: boxPositional,
          options: { ...threadOption, ...resizeOptions, ...resizeGpuOption(app) },
          run: ({ positionals, options }, ctx) =>
            guard("Resizing the box", async () => {
              const threadId = threadOf(options.thread, ctx);
              return out(await resizeWords(app, await resizeBox(app, threadId, positionals.box, options), options.check === true));
            }),
        }),
        machines: cliCommand({
          summary: "List your machines: boxes you own, kept as BB machines, which no thread ending releases.",
          description: [
            "Its commands:",
            "  bb box machines add <kind>        Add a machine of your own, of the kind",
            "  bb box machines resize <machine>  Resize one of your machines",
            "  bb box machines remove <machine>  Remove one of your machines and delete its disk",
            "Run one with --help for its options.",
          ].join("\n"),
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
          options: { ...jsonOption, ...sizeOptions, ...onOption, name: { type: "string", description: `Its name, which is also its BB machine's: a lower-case letter first, then letters, digits and "-". ${PRODUCT} picks one when left out.` }, "no-wait": { type: "boolean", description: "Return once the box is recorded." } },
          run: ({ positionals, options }) =>
            guard("Adding the machine", async () => {
              const size = { preset: options.size, cores: options.cores, memoryGiB: options["memory-gib"], diskGiB: options["disk-gib"] };
              let box = await boxes.acquire({ threadId: OPERATOR, projectId: null, kind: positionals.kind, size, ...(options.name ? { name: options.name } : {}), ...(options.on ? { on: providersOf(options.on) } : {}), who: BY_COMMAND });
              if (!options["no-wait"]) box = await boxes.enrolled((await boxes.settled(box)) ?? box);
              if (options.json) return json(app.view(box));
              const failed = box.state === "failed" || (!options["no-wait"] && box.enrol.state === "failed");
              const detail = `${boxDetail(box, app.control(box))}\n${options["no-wait"] ? "" : starting(box, boxes.stopping, "bb box machines")}`;
              return failed ? { exitCode: 1, stderr: detail } : { exitCode: 0, stdout: detail };
            }),
        }),
        "machines resize": cliCommand({
          summary: "Resize one of your machines: its cores, memory, disk or GPU, where its backend can, live or with --restart. Parts left out stay as they are, and the disk only grows.",
          positionals: [{ name: "machine", description: "The machine's name or ID, from bb box machines.", required: true }],
          options: { ...resizeOptions, ...resizeGpuOption(app) },
          run: ({ positionals, options }) =>
            guard("Resizing the machine", async () => out(await resizeWords(app, await resizeBox(app, OPERATOR, positionals.machine, options), options.check === true))),
        }),
        "machines remove": cliCommand({
          summary: "Remove one of your machines: its box is released and its disk deleted. A machine a thread is working on is refused unless --force. Snapshots you kept are copied first, so they outlive it, unless --delete-kept.",
          positionals: [{ name: "machine", description: "The machine's name or ID, from bb box machines.", required: true }],
          options: { force: { type: "boolean", description: "Remove it even while threads are working on it, which ends their work." }, ...deleteKeptOption },
          run: ({ positionals, options }) =>
            guard("Removing the machine", async () => {
              const box = await boxes.get(OPERATOR, positionals.machine);
              const idle = options.force ? await app.threadsOn(box) : await app.checkInUse(box, "Releasing");
              if (options["delete-kept"]) await app.snapshots.unkeepForRelease(box, BY_COMMAND);
              const left = await boxes.release(OPERATOR, box.id, "removed with bb box machines remove", BY_COMMAND);
              if (left) return { exitCode: 1, stderr: `Machine ${left.name} is still being removed: ${(left.error ?? "the backend has not finished").replace(/\.$/, "")}. The sweep keeps trying.\n` };
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
          summary: "Release a box. Its disk is deleted. A box a thread is working on is refused unless --force. Snapshots you kept are copied first, so they outlive it, unless --delete-kept.",
          positionals: boxPositional,
          options: { ...threadOption, force: { type: "boolean", description: "Release it even while threads are working on it, which ends their work." }, ...deleteKeptOption },
          run: ({ positionals, options }, ctx) =>
            guard("Releasing the box", async () => {
              const threadId = threadOf(options.thread, ctx);
              const box = await boxes.get(threadId, positionals.box);
              const idle = options.force ? await app.threadsOn(box) : await app.checkInUse(box, "Releasing");
              if (options["delete-kept"]) await app.snapshots.unkeepForRelease(box, BY_COMMAND);
              const left = await boxes.release(threadId, positionals.box, "released with bb box release", BY_COMMAND);
              if (left) return { exitCode: 1, stderr: `Box ${left.name} is still being released: ${(left.error ?? "the backend has not finished").replace(/\.$/, "")}. The sweep keeps trying.\n` };
              return out(`Released box ${positionals.box}.${idleWords(idle, false)}`);
            }),
        }),
        stop: cliCommand({
          summary: "Stop a thread's box, or with --machine one of your machines, keeping its disk. A box a thread is working on is refused unless --force.",
          positionals: boxPositional,
          options: { ...threadOption, ...machineOption, force: { type: "boolean", description: "Stop it even while threads are working on it, which ends their work." } },
          run: ({ positionals, options }, ctx) =>
            guard("Stopping the box", async () => {
              const owner = options.machine ? OPERATOR : threadOf(options.thread, ctx);
              const found = await boxes.get(owner, positionals.box);
              const idle = options.force ? await app.threadsOn(found) : await app.checkInUse(found, "Stopping");
              const box = await boxes.stop(owner, found.id, ctx.signal, BY_COMMAND);
              return out(`Box ${box.name} is stopped.${idleWords(idle, true)}`);
            }),
        }),
        start: cliCommand({
          summary: "Start a thread's stopped box, or with --machine one of your machines, and wait until it answers.",
          positionals: boxPositional,
          options: { ...threadOption, ...machineOption, ...jsonOption },
          run: ({ positionals, options }, ctx) =>
            guard("Starting the box", async () => {
              const owner = options.machine ? OPERATOR : threadOf(options.thread, ctx);
              const box = await boxes.enrolled(await boxes.start(owner, positionals.box, ctx.signal, BY_COMMAND), ctx.signal);
              return options.json ? json(app.view(box)) : out(boxDetail(box, app.control(box)));
            }),
        }),
        enrol: cliCommand({
          summary:
            "Add a ready box that is not a BB machine to BB again, as a thread's box, or with --machine one of your machines: BB's installer runs in it as its user. It does not restart, stop or resize the box. It stops only the BB daemon of a machine that BB no longer has. A box whose machine BB still has is left as it is, and recorded as a BB machine. Waits up to 2 minutes for the try.",
          positionals: boxPositional,
          options: { ...threadOption, ...machineOption, ...jsonOption },
          run: ({ positionals, options }, ctx) =>
            guard("Adding the box to BB", async () => {
              const owner = options.machine ? OPERATOR : threadOf(options.thread, ctx);
              const answer = await app.joinAgain(owner, positionals.box, { waitMs: CLI_JOIN_WAIT_MS, ...(ctx.signal ? { signal: ctx.signal } : {}) });
              const said = joinAgainWords(answer, options.machine ? "bb box machines" : `bb box status ${answer.box.name}${options.thread ? ` --thread ${owner}` : ""}`);
              if (options.json) return { exitCode: said.failed ? 1 : 0, stdout: `${JSON.stringify({ is: answer.is, words: said.text, box: app.view(answer.box) }, null, 2)}\n` };
              return said.failed ? { exitCode: 1, stderr: `${said.text}\n` } : out(said.text);
            }),
        }),
        forget: cliCommand({
          summary: `Forget a box whose backend is no longer in ${PRODUCT}'s settings: ${PRODUCT} removes its record and deletes nothing, so a guest that still runs keeps running.`,
          positionals: boxPositional,
          options: { ...threadOption, ...machineOption },
          run: ({ positionals, options }, ctx) =>
            guard("Forgetting the box", async () => {
              const owner = options.machine ? OPERATOR : threadOf(options.thread, ctx);
              const box = await boxes.get(owner, positionals.box);
              await app.forget(owner, box.id, BY_COMMAND);
              return out(`Forgot box ${box.name}: ${PRODUCT} removed its record. Nothing was deleted on ${box.backendLabel}: if the box still runs there, it keeps running.`);
            }),
        }),
        "image set": cliCommand({
          summary:
            `Set a project's image (049): a script run as root on its kinds' standard images, for the boxes of the project's threads, with an optional check run as the box user. ${PRODUCT} keeps a copy of the files. Setting it changes every new box of those kinds in the project.`,
          positionals: [{ name: "name", description: "The image's name: a lower-case letter first, then letters, digits and \"-\".", required: true }],
          options: {
            kinds: { type: "string", description: "The kinds it builds on, comma-separated, such as linux,linux-desktop-cpu." },
            "script-file": { type: "string", description: "The script, such as .bb/box-setup.sh, read where bb runs." },
            "check-file": { type: "string", description: "A check run as the box user after the script, such as .bb/box-check.sh." },
            project: { type: "string", description: "The BB projects whose boxes get it, by ID, comma-separated." },
            bake: { type: "string", description: "auto (after two boxes in 14 days), always, or never (the script at each start). auto by default." },
          },
          run: ({ positionals, options }, ctx) =>
            guard("Setting the image", async () => {
              const kinds = listOf(options.kinds);
              const projects = listOf(options.project);
              if (!kinds.length || !projects.length || !options["script-file"]) {
                throw new PluginCliError("Give --kinds, --project and --script-file.", { code: "invalid_input", hint: "bb box image set rust-tools --kinds linux --script-file .bb/box-setup.sh --project <id>" });
              }
              const script = await readTextFile(String(options["script-file"]), ctx);
              const check = options["check-file"] ? await readTextFile(String(options["check-file"]), ctx) : undefined;
              const bake = options.bake === undefined ? undefined : String(options.bake);
              const result = await app.setImage(positionals.name, {
                kinds,
                script,
                ...(check !== undefined ? { check } : {}),
                ...(bake !== undefined ? { bake: bake as ImageBake } : {}),
                projects,
                source: { script: String(options["script-file"]), ...(options["check-file"] ? { check: String(options["check-file"]) } : {}) },
                updated: new Date().toISOString(),
              });
              if (!result.ok) return result.reason === "problems" ? refused(result.problems, "Nothing was saved. Fix these first:") : { exitCode: 1, stderr: "The configuration kept changing; try again.\n" };
              return out(`Saved image ${positionals.name} for ${kinds.join(", ")} boxes in ${projects.length === 1 ? "project" : "projects"} ${projects.join(", ")}, at revision ${result.state.revision}.`);
            }),
        }),
        "image remove": cliCommand({
          summary: "Remove a project's image (049). Boxes of its kinds in its projects start from the standard images again.",
          positionals: [{ name: "name", description: "The image's name, from bb box image list.", required: true }],
          run: ({ positionals }) =>
            guard("Removing the image", async () => {
              if (!app.configuration.exported().images?.[positionals.name]) throw new BoxError("not_found", `There is no image ${positionals.name}.`);
              const result = await app.setImage(positionals.name, null);
              if (!result.ok) return result.reason === "problems" ? refused(result.problems, "Nothing was saved. Fix these first:") : { exitCode: 1, stderr: "The configuration kept changing; try again.\n" };
              return out(`Removed image ${positionals.name}, at revision ${result.state.revision}.`);
            }),
        }),
        "image list": cliCommand({
          summary: "List projects' images (049): each one's kinds, projects, how it is baked, where its script came from, and its builds.",
          options: jsonOption,
          run: ({ options }) =>
            guard("Listing the images", async () => {
              const images = app.configuration.exported().images ?? {};
              if (options.json) return json(images);
              const names = Object.keys(images).sort();
              if (!names.length) return out("No project has an image. bb box image set sets one.");
              const lines: string[] = [];
              for (const name of names) {
                const image = images[name]!;
                lines.push(`${name}: ${image.kinds.join(", ")} boxes in ${image.projects.join(", ")}; baked ${image.bake ?? "auto"}; script ${image.source?.script ?? "set by hand"}${image.check ? `, check ${image.source?.check ?? "set by hand"}` : ""}${image.updated ? `; set ${image.updated.slice(0, 10)}` : ""}.`);
                for (const line of await app.imageBakes.lines(name)) lines.push(`  ${line}`);
              }
              return out(lines.join("\n"));
            }),
        }),
        "image show": cliCommand({
          summary: `Print a project's image's script, and its check, as ${PRODUCT} keeps them (049).`,
          positionals: [{ name: "name", description: "The image's name, from bb box image list.", required: true }],
          run: ({ positionals }) =>
            guard("Showing the image", async () => {
              const image = app.configuration.exported().images?.[positionals.name];
              if (!image) throw new BoxError("not_found", `There is no image ${positionals.name}.`);
              return out(`${image.script.trimEnd()}${image.check ? `\n\n# The check, run as the box user:\n${image.check.trimEnd()}` : ""}`);
            }),
        }),
        "image try": cliCommand({
          summary: "Try a project's image's script as a build runs it (049), on a kind it covers, and remove what the try made. It prints each check's result and the build's last lines, and exits 1 if one failed.",
          positionals: [{ name: "name", description: "The image's name, from bb box image list.", required: true }],
          options: {
            kind: { type: "string", description: "The kind to try it on: its first kind by default." },
            on: { type: "string", description: "A backend's ID, such as proxmox-lxc: the first that builds the kind's images by default." },
          },
          run: ({ positionals, options }, ctx) =>
            guard("Trying the image", async () => {
              const image = app.configuration.exported().images?.[positionals.name];
              if (!image) throw new BoxError("not_found", `There is no image ${positionals.name}.`);
              const kind = options.kind === undefined ? image.kinds[0]! : String(options.kind);
              if (!image.kinds.includes(kind)) throw new BoxError("unknown_kind", `Image ${positionals.name} covers ${image.kinds.join(", ")}, not ${kind}.`);
              const result = await app.imageBakes.try(
                { name: positionals.name, kind, script: image.script, ...(image.check ? { check: image.check } : {}), ...(options.on ? { on: String(options.on) } : {}) },
                ctx.signal,
              );
              return { exitCode: result.ok ? 0 : 1, stdout: `${tryText(result)}\n` };
            }),
        }),
        "images list": cliCommand({
          summary: `List the standard images ${PRODUCT} rebuilds (049): each one's build and age, why it is due, and what its last rebuild did, most needed first.`,
          options: { ...jsonOption, output: { type: "string", description: "Print this image's last rebuild's last lines, as <backend>/<ref>." } },
          run: ({ options }, ctx) =>
            guard("Listing the images", async () => {
              const views = await app.imageJobs.list(ctx.signal);
              const problems = app.imageJobs.unlistable();
              if (options.json) return json(views);
              if (options.output) {
                const view = views.find((candidate) => candidate.name === options.output);
                if (!view) throw new BoxError("not_found", `There is no image ${String(options.output)}.`);
                return out(view.last?.output.length ? view.last.output.join("\n") : `${view.name} has no rebuild with output yet.`);
              }
              if (!views.length) return out(problems.length ? problems.join("\n") : `No backend that is on has images ${PRODUCT} rebuilds.`);
              const running = app.imageJobs.running();
              const soon = await app.imageJobs.dueSoon(ctx.signal).catch(() => null);
              return out(
                [
                  ...(running ? [`A run has gone on since ${new Date(running).toISOString()}.`] : []),
                  ...(soon ? [`BB was updated: a refresh of ${soon.names.join(", ")} starts by ${new Date(soon.at).toISOString()}, as ${soon.names.length === 1 ? "it has" : "they have"} another build of BB's app than BB's server gives.`] : []),
                  ...views.map(imageLine),
                ].join("\n"),
              );
            }),
        }),
        "images refresh": cliCommand({
          summary:
            "Rebuild the standard images that are due (049), one at a time, most needed first, and start none after the time limit. A BB script automation runs it each night. It ends with a line per image, and exits 1 if one failed. Should this command end first, the run goes on.",
          options: {
            pinned: { type: "boolean", description: "Build from the repository's pins alone." },
            hours: { type: "string", description: "Start no image after this many hours: 4 by default." },
          },
          run: ({ options }, ctx) =>
            guard("Refreshing the images", async () => {
              const hours = options.hours === undefined ? 4 : Number(options.hours);
              if (!(hours > 0)) throw new Error("Give --hours as a number of hours above 0.");
              const run = app.imageJobs.refreshAll({ pinned: !!options.pinned, limitMs: hours * 60 * 60_000 });
              const result = await new Promise<Awaited<typeof run>>((resolve, reject) => {
                run.then(resolve, reject);
                ctx.signal?.addEventListener("abort", () => reject(new Error("The command ended; the run goes on, and bb box images list shows its results.")), { once: true });
              });
              const text = result.lines.map((line) => `${line.name}: ${line.outcome}, ${line.detail}`).join("\n") || "No image is due.";
              return { exitCode: result.ok ? 0 : 1, stdout: `${text}\n` };
            }),
        }),
        "images build": cliCommand({
          summary: "Rebuild one standard image now, due or not, and whatever its last rebuild did (049), and replace it when its trial box passes. --try checks a new build and keeps the old one.",
          positionals: [{ name: "image", description: "The image, as <backend>/<ref>, from bb box images list.", required: true }],
          options: { pinned: { type: "boolean", description: "Build from the repository's pins alone." }, try: { type: "boolean", description: "Build and check, then keep the old build." } },
          run: ({ positionals, options }, ctx) =>
            guard("Building the image", async () => {
              const result = await app.imageJobs.build(positionals.image, { pinned: !!options.pinned, try: !!options.try, signal: ctx.signal ?? new AbortController().signal });
              const lines = [
                `${result.ok ? "ok" : "FAILED"} in ${result.seconds} s${result.build ? `: ${positionals.image} is now ${result.build.build}` : ""}`,
                ...result.checks.map((check) => `${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`),
                ...(result.reason ? [result.reason, "", ...result.output.slice(-20)] : []),
              ];
              return { exitCode: result.ok ? 0 : 1, stdout: `${lines.join("\n")}\n` };
            }),
        }),
        "images versions": cliCommand({
          summary:
            `Show what a rebuild of the standard Linux images would take now (049): upstream's latest stable Claude Code, Codex, pi, gh and Chrome, each with the SHA-256 it publishes, and the day's apt snapshot, against this ${PRODUCT}'s pins.`,
          options: { ...jsonOption, pinned: { type: "boolean", description: "Take the repository's pins alone, as a build with --pinned does." } },
          run: ({ options }, ctx) =>
            guard("Reading the latest versions", async () => {
              const versions = await app.imageVersions({ pinned: !!options.pinned, signal: ctx.signal });
              // The pin files are for builds, not people.
              if (options.json) return json({ ...versions, files: undefined });
              return out(versionsText(versions));
            }),
        }),
        "setup docker": cliCommand({
          summary:
            "Set up Docker for boxes, as the Box panel's first run does: on the BB machine that runs BB, or --machine, turn Docker on with the Linux image alone and wait while it builds, usually 5 to 12 min. " +
            "Where something stands in the way, it gives that machine's line to fix it. --no-wait starts it and says how far the build is; run it again to see.",
          options: {
            machine: { type: "string", description: "The BB machine, by ID or name, from bb machine list. The one that runs BB by default." },
            "no-wait": { type: "boolean", description: "Start the build, and say how far it is, without waiting for it." },
            "set-machine-access": { type: "boolean", description: "Where BB listens on every address and boxes cannot join, set Machine access to direct at an address they can reach. This changes BB's settings. Without it, the command only says it can." },
          },
          run: ({ options }, ctx) =>
            guard("Setting up Docker", () =>
              setupDocker(
                {
                  setups: () => app.setups(),
                  setDockerHost: (hostId, enabled, linuxOnly) => app.setDockerHost(hostId, enabled, linuxOnly),
                  ensure: (hostId) => app.dockerImages.ensure(hostId),
                  machineAccess: () => app.machineAccess(),
                  say: (line) => process.stderr.write(`${line}\n`),
                  listening: async () => {
                    const { readFileSync } = await import("node:fs");
                    const { networkInterfaces } = await import("node:os");
                    const read = (path: string) => {
                      try {
                        return readFileSync(path, "utf8");
                      } catch {
                        return "";
                      }
                    };
                    const config = await bb.sdk.system.config().catch(() => null);
                    const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries?.filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address) ?? []);
                    return bbDirectListen(bb.server.experimental_appUrl, config?.generalSettings.machineServerUrl, read("/proc/net/tcp"), read("/proc/net/tcp6"), addresses);
                  },
                  setDirectAccess: async (url) => {
                    const config = await bb.sdk.system.config();
                    await bb.sdk.system.updateGeneralSettings({ ...config.generalSettings, machineServerUrl: url, defaultMachineAccess: "direct" });
                  },
                },
                { ...(options.machine ? { machine: String(options.machine) } : {}), wait: !options["no-wait"], setAccess: options["set-machine-access"] === true, ...(ctx.signal ? { signal: ctx.signal } : {}) },
              ),
            ),
        }),
        "docker-check": cliCommand({
          summary: `Check that Docker on a BB machine answers through ${PRODUCT}'s Docker relay (042), with its version, cores and memory.`,
          positionals: [{ name: "machine", description: "The BB machine's ID or name, from bb machine list.", required: true }],
          options: jsonOption,
          run: ({ positionals, options }, ctx) =>
            guard("Checking Docker on the machine", async () => {
              const check = await app.dockerCheck(positionals.machine, ctx.signal);
              if (options.json) return json(check);
              const { info } = check;
              return out(
                `Docker ${info.version} on ${check.name} (${check.hostId}) answers through ${PRODUCT}'s relay: ${info.operatingSystem}, ${info.arch}, ` +
                  `${info.cpus} cores, ${(info.memoryMiB / 1024).toFixed(1)} GiB memory. ` +
                  `The first call took ${(check.firstMs / 1000).toFixed(1)} s, opening the relay if it was closed; the next ${(check.againMs / 1000).toFixed(2)} s.`,
              );
            }),
        }),
        "docker-build": cliCommand({
          summary:
            `Build the images a BB machine that hosts Docker boxes lacks there, or has from another layout or with another build of BB's app, through ${PRODUCT}'s relay (042). Waits for the build. ` +
            `Building all three needs about ${BUILD_FREE_GB} GB free there; with less, it does not start.`,
          positionals: [{ name: "machine", description: `The BB machine's ID or name, from bb machine list. Its Docker must be added in ${PRODUCT}'s settings, under Add backend.`, required: true }],
          run: ({ positionals }) =>
            guard("Building the images", async () => {
              // From BB's record and the configuration: listing would look at every machine's Docker.
              const host = await app.dockerHostOf(positionals.machine);
              if (!host?.backend) throw new BoxError("not_found", `${positionals.machine} is not a Docker host in ${PRODUCT}'s settings. Add its Docker under Add backend first.`);
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
          summary: `Show ${PRODUCT}'s configuration. --json prints it as a file for config apply, with no secret in it: keep it to set ${PRODUCT} up again.`,
          options: jsonOption,
          async run({ options }) {
            const state = await app.configuration.state();
            if (options.json) return json(withoutSecretVersions(state.document));
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
              const result = await configuration.check(draft, undefined, ctx.signal, { read: true });
              const changes = result.read ? importChangeText(await configuration.state(), result.read, draft) : null;
              const tested: { id: string; report: DoctorReport | null }[] = [];
              for (const id of options.test ? configuration.enabledIn(draft) : []) {
                tested.push({ id, report: (await configuration.check(draft, id, ctx.signal)).doctor });
              }
              if (options.json) return json({ problems: result.problems, changes, doctors: tested });
              const lines = [result.problems.length ? `Problems:\n${problemsText(result.problems)}` : "No problems."];
              if (changes) lines.push(changes);
              for (const { id, report } of tested) {
                lines.push(report ? doctorText({ ok: report.ok, sections: [{ title: id, report }] }) : `${id}: not checked, since its settings have problems.`);
              }
              const ok = !result.problems.length && tested.every(({ report }) => report?.ok);
              return { exitCode: ok ? 0 : 1, stdout: `${lines.join("\n")}\n` };
            }),
        }),
        "config apply": cliCommand({
          summary:
            `Save a configuration file as ${PRODUCT}'s whole configuration, then rebuild what changed. A revision in the file must be the current one; a file without one, or --replace, saves over what is there, as when setting ${PRODUCT} up again from an export.`,
          positionals: fileArgument,
          options: { ...jsonOption, replace: { type: "boolean", description: "Save over the current configuration whatever revision the file names." } },
          run: ({ positionals, options }, ctx) =>
            guard("Applying the configuration", async () => {
              const draft = await readConfigFile(positionals.file, ctx);
              const revision = (draft as { revision?: unknown })?.revision;
              const result = await app.configuration.apply(draft, typeof revision === "number" && !options.replace ? revision : null);
              if (options.json) return { exitCode: result.ok ? 0 : 1, stdout: `${JSON.stringify(result.ok ? withoutSecretVersions(result.state.document) : result, null, 2)}\n` };
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
          summary: `Show the copy of BB's settings ${PRODUCT} kept when it moved them into its configuration. --remove removes it.`,
          options: { ...jsonOption, remove: { type: "boolean", description: "Remove the copy." } },
          async run({ options }) {
            if (options.remove) {
              const had = await app.configuration.removeMigrated();
              return out(had ? "Removed the copy of BB's settings." : "There is no copy of BB's settings.");
            }
            const copy = await app.configuration.migrated();
            if (options.json) return json(copy);
            return out(copy ? movedText(copy) : `There is no copy of BB's settings: ${PRODUCT} never moved any, or the copy was removed.`);
          },
        }),
        ...(app.replyDrops ? replyDropCommands(app.replyDrops) : {}),
        ...configCommands(app.configuration),
        ...snapshotCommands(app),
        ...gpuCommands(app),
        ...monitorCommands(bb, app.monitor, app.history),
        sweep: cliCommand({
          summary: `Run the clean-up now: release the boxes of ended threads, finish interrupted work and remove leftovers, and settle and check ${PRODUCT}'s snapshots against each backend's.`,
          options: jsonOption,
          run: ({ options }, ctx) =>
            guard("Sweeping", async () => {
              await app.snapshots.sweep(ctx.signal);
              const report = await boxes.sweep(ctx.signal);
              if (options.json) return json(report);
              return out(
                [
                  `Boxes of ended threads released: ${report.released}`,
                  `Leftover guests removed: ${report.leftovers}`,
                  `Boxes restored from their guests: ${report.adopted}`,
                  `Guests kept until BB says whether their thread ended: ${report.kept}`,
                  `Boxes and guests kept until the next sweep, as BB says their thread ended only now: ${report.ending}`,
                  `Interrupted acquires and releases carried on: ${report.resumed}`,
                  `Guests kept for the snapshots they hold: ${report.guarded}`,
                ].join("\n"),
              );
            }),
        }),
      },
    }),
  );
}
