// The agent tools. Each result ends with "Next:" hints, and each refusal
// says what to do instead, so an agent never has to guess.

import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { BoxError, OPERATOR, SPARES, describeError, type BoxErrorCode, type BoxRecord } from "../core/boxes.ts";
import { SCAN_SCRIPT, draftImage } from "../core/draft.ts";
import { JOB_DAYS, JOB_ID, newJobId } from "../core/in-box.ts";
import { describeSize } from "../core/sizes.ts";
import type { RunResult } from "../transports/types.ts";
import { DRAIN_MS, Drain, Restarted } from "./drain.ts";
import type { BbBox } from "./setup.ts";
import { adminText, boxDetail, dockerText, boxLine, boxSize, draftText, idleWords, imagesText, next, tryText, type KindView } from "./views.ts";

/** Output kept per stream; beyond it, the head and tail are kept. */
export const RUN_OUTPUT_BYTES = 32 * 1024;
/** Largest file box_copy moves. */
export const COPY_MAX_BYTES = 16 * 1024 * 1024;
const RUN_TIMEOUT_S = 10 * 60;
const RUN_TIMEOUT_MAX_S = 60 * 60;

const HINTS: Record<BoxErrorCode, string> = {
  not_found: "Call box_list to see this thread's boxes.",
  unknown_kind: "Call box_list to see the kinds you can acquire.",
  unknown_provider: "Call box_list: each kind's line ends with its providers, in the words \"on\" takes, one or a list. Leave \"on\" out for the first with room.",
  invalid_size: "Pick a preset, or a custom size within the largest. box_list shows each kind's sizes.",
  limit_reached: "Release a box you no longer need with box_release, then try again.",
  no_capacity: "Try again later, release a box you no longer need, or pick another kind.",
  not_ready: "Call box_status to see its state. box_start starts a stopped box.",
  unsupported: "Call box_status to see what the box can do.",
  backend_off: "Ask the user to fix its backend's settings in bb-box's settings, or release the box.",
  released: "Acquire a new box with box_acquire.",
  unreachable: "Call box_status. If the box still does not answer, release it and acquire a new one.",
  invalid_name: "Pick another name: a lower-case letter first, then letters, digits and \"-\".",
  not_owner: "Keep using it with box_run, box_copy and the other box tools; its owner releases or stops it.",
  in_use: "Leave the box while that thread works. Ask the user if it should go anyway: they can release it from bb-box's panel.",
  restarting: "Run the command again in a minute, once bb-box is back.",
};

export function failure(error: unknown, action: string): PluginAgentToolResult {
  const hint = error instanceof BoxError ? HINTS[error.code] : "Call box_status to see the box, or try again.";
  return { content: [{ type: "text", text: `${describeError(error, action)}${next(hint)}` }], isError: true };
}

/** box_run's answer when bb-box restarted while its command ran: `sure` when bb-box stopped it itself (#405). */
function restarted(box: BoxRecord, job: string, sure: boolean): PluginAgentToolResult {
  const text =
    box.capabilities.os === "windows"
      ? `bb-box restarted, as for an update, while the command ran in box ${box.name}. On Windows a command ends with bb-box's connection, so it stopped.${next("Run it again.")}`
      : `bb-box restarted, as for an update, while the command ran in box ${box.name}. It ${sure ? "goes" : "may go"} on there as job ${job}.${next(`Call box_job with box "${box.name}" and job "${job}" for its exit code and output once it ends.`)}`;
  return { content: [{ type: "text", text }], isError: true };
}

export function thread(threadId: string | undefined): string {
  if (!threadId) throw new BoxError("unsupported", "bb-box tools work only inside a BB thread.");
  return threadId;
}

function using(box: BoxRecord): string[] {
  return [`Run commands with box_run (box "${box.name}").`, `Move files with box_copy.`, `Call box_release with box "${box.name}" when you are done.`];
}

function runText(box: BoxRecord, result: RunResult): string {
  return outputText(
    result.timedOut
      ? `Timed out in box ${box.name} after ${(result.durationMs / 1000).toFixed(1)} s.`
      : `Exit code ${result.exitCode ?? "none (killed)"} in box ${box.name}, after ${(result.durationMs / 1000).toFixed(1)} s.`,
    result,
  );
}

function outputText(headline: string, result: { stdout: string; stderr: string; truncated?: boolean }): string {
  const parts = [headline];
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  if (!result.stdout && !result.stderr) parts.push("No output.");
  if (result.truncated) parts.push(`Output was cut to the first and last ${RUN_OUTPUT_BYTES / 1024} KiB of each stream. Redirect it to a file and copy that out with box_copy for the whole of it.`);
  return parts.join("\n\n");
}

/** Path rules for a workspace: Windows ones when its directory is a Windows path. */
function pathsOf(root: string | null): typeof posix {
  return root && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root) ? win32 : posix;
}

/** BB's file API takes absolute paths: a relative one is under the workspace's directory. */
export function workspacePath(root: string | null, path: string): string {
  const paths = pathsOf(root);
  if (paths.isAbsolute(path)) return paths.normalize(path);
  if (!root) throw new Error(`${path} is a relative path, and this thread's workspace has no directory. Give an absolute path.`);
  return paths.resolve(root, path);
}

/** How a path names the thread's storage folder: `$BB_THREAD_STORAGE` or `${BB_THREAD_STORAGE}` first, as an agent's shell would expand it. */
const STORAGE_PREFIX = /^\$(?:\{BB_THREAD_STORAGE\}|BB_THREAD_STORAGE)(?=$|[\\/])/;

/** A file of the thread's own, for BB's file API: its host, its absolute path and the folder BB keeps it within. */
export interface ThreadFile {
  readonly hostId: string;
  readonly path: string;
  readonly rootPath: string | undefined;
  /** In the thread's storage folder, not the workspace. */
  readonly stored: boolean;
}

/**
 * A path in the thread's storage folder (#482), named by its variable or by
 * its absolute path, or null when the path is not in it.
 */
export function storageFile(path: string, storage: { hostId: string; path: string } | null): ThreadFile | null {
  if (!storage) return null;
  const paths = pathsOf(storage.path);
  const named = STORAGE_PREFIX.test(path) ? paths.join(storage.path, path.replace(STORAGE_PREFIX, "")) : path;
  if (!paths.isAbsolute(named)) return null;
  const full = paths.normalize(named);
  const inside = paths.relative(storage.path, full);
  return inside.startsWith("..") || paths.isAbsolute(inside) ? null : { hostId: storage.hostId, path: full, rootPath: storage.path, stored: true };
}

/** The box's transport runs in the box user's home, so a relative path is under it; so is one that starts with ~/. */
export function boxPath(path: string): string {
  return path.startsWith("~/") ? path.slice(2) || "." : path;
}

function bytes(content: string, encoding: "base64" | "utf8"): Uint8Array {
  return encoding === "base64" ? Buffer.from(content, "base64") : new TextEncoder().encode(content);
}

/** Waits for an acquire to finish, up to the kind's ready timeout. Null when it has not finished. */
async function ready(app: BbBox, box: BoxRecord, signal: AbortSignal): Promise<BoxRecord | null> {
  const timeoutMs = app.boxes.kinds().find((kind) => kind.id === box.kind)?.readyTimeoutMs ?? 5 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  try {
    return await Promise.race([app.boxes.settled(box), waited]);
  } finally {
    clearTimeout(timer);
  }
}

/** A kind's presets and largest size in words, for box_list. */
function kindSizesText(kind: KindView): string {
  const presets = kind.presets.map((preset) => `${preset.name} (${preset.words}${preset.name === kind.defaultPreset ? ", the default" : ""})`);
  return `${presets.join(", ")}; custom up to ${kind.largest.words}`;
}

/** Why the box this thread runs on, but does not own, is not released or stopped from here (036). */
function runsOnRefusal(box: BoxRecord, action: "release" | "stop"): BoxError {
  // A spare a thread started on becomes your machine at the next spare upkeep (036).
  if (box.threadId === SPARES) return new BoxError("not_owner", `Box ${box.name} is a spare, which becomes your machine, and this thread runs on it. Remove or stop it in BB Box's settings once it is yours.`);
  if (box.threadId === OPERATOR) return new BoxError("not_owner", `Box ${box.name} is your machine, which this thread runs on. Remove or stop it in BB Box's settings.`);
  return new BoxError("not_owner", `Box ${box.name} is thread ${box.threadId}'s, and this thread runs on it. ${action === "release" ? "Release" : "Stop"} it from that thread.`);
}

/** Whose the box a thread runs on is, for box_list. */
function ownerWords(box: BoxRecord): string {
  if (box.threadId === OPERATOR) return "yours";
  if (box.threadId === SPARES) return "a spare, which becomes your machine";
  return `thread ${box.threadId}'s`;
}

export const boxParam = z.string().min(1).describe("The box's name or ID, from box_acquire or box_list.");

export function registerTools(bb: BbPluginApi, app: BbBox, options: { drainMs?: number } = {}): void {
  const { boxes } = app;
  // Registered after the core's hooks, so it runs first, while boxes and
  // backends still work (#405).
  const drain = new Drain();
  bb.onDispose(() => drain.close(options.drainMs ?? DRAIN_MS));

  bb.agents.registerTool({
    name: "box_acquire",
    description:
      "Get a fresh box for this thread: a Linux or macOS computer for commands, builds, tests, servers or Docker, away from the thread's own machine. It starts in seconds and stays until you release it or the thread ends.",
    instructions:
      "bb-box: use box_acquire when you need a clean machine, root (box_list says which kinds give it), Docker, or to run what you would not run on the thread's machine. Release a box with box_release when you are done; a thread's boxes go when it is archived or deleted.",
    presentation: { label: { pending: "Acquiring a box", completed: "Acquired a box" } },
    parameters: z.object({
      kind: z
        .string()
        .min(1)
        .optional()
        .describe("The kind, from box_list: linux, linux-desktop and the rest, or linux-docker for a linux box that must have Docker. Defaults to the user's default kind."),
      size: z
        .string()
        .min(1)
        .optional()
        .describe("small, medium or large. Defaults to the kind's default preset; box_list shows each kind's sizes."),
      cores: z.number().int().positive().optional().describe("Cores, for a custom size. Parts you leave out come from the preset."),
      memory_gib: z.number().int().positive().optional().describe("Memory in GiB, for a custom size: at least 2 for a Linux box."),
      disk_gib: z.number().int().positive().optional().describe("Root disk in GiB, for a custom size. Presets keep the kind's own disk."),
      wait: z.boolean().optional().describe("Wait until the box answers, and up to 20 s more while it becomes a BB machine. Defaults to true."),
      on: z
        .union([z.string().min(1), z.array(z.string().min(1))])
        .optional()
        .describe("Where the box goes, from box_list: a provider such as Docker on devpc, or a list of them for the first with room among them. Leave it out for the first with room."),
      image: z
        .string()
        .min(1)
        .optional()
        .describe('The image the box starts from, from box_list: a project\'s image by name, or "standard" for bb-box\'s own. Leave it out for this project\'s image for the kind, or the standard one.'),
    }),
    async execute({ kind, size, cores, memory_gib, disk_gib, wait, on, image }, { threadId, projectId, signal }) {
      try {
        const box = await boxes.acquire({
          threadId: thread(threadId),
          projectId: projectId ?? null,
          kind: kind ?? (await app.general()).defaultKind,
          size: { preset: size, cores, memoryGiB: memory_gib, diskGiB: disk_gib },
          ...(on !== undefined ? { on } : {}),
          ...(image !== undefined ? { image } : {}),
        });
        if (wait === false) {
          const asked = boxSize(box);
          return `Acquiring box ${box.name} (${box.kind}${asked ? `, ${describeSize(asked)}` : ""}).${next(`Call box_status with box "${box.name}" to see when it is ready.`)}`;
        }
        const settled = await ready(app, box, signal);
        if (!settled) {
          return `Box ${box.name} is still starting.${next(`Call box_status with box "${box.name}" to see when it is ready.`)}`;
        }
        if (settled.state === "failed") {
          return {
            content: [{ type: "text", text: `Box ${settled.name} failed: ${settled.error ?? "no reason given"}${next("Try box_acquire again, or pick another kind from box_list.")}` }],
            isError: true,
          };
        }
        // box_run would wait for enrolment anyway, so the result can say how it went.
        const enrolled = await boxes.enrolled(settled, signal);
        return `${boxDetail(enrolled, app.control(enrolled))}${next(...using(enrolled))}`;
      } catch (error) {
        return failure(error, "Acquiring a box");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_list",
    description: "List this thread's boxes and the kinds of box you can acquire.",
    presentation: { label: { pending: "Listing boxes", completed: "Listed boxes" } },
    parameters: z.object({}),
    async execute(_params, { threadId }) {
      try {
        const id = thread(threadId);
        const [list, kinds, machine, images] = await Promise.all([boxes.list(id), app.kinds(), app.runsOn(id), app.projectOf(id).catch(() => null).then((project) => app.imageOptions(project))]);
        const lines: string[] = [];
        // The box this thread runs on comes first, unless it is the thread's own and listed below (036).
        if (machine && !list.some((box) => box.id === machine.id)) {
          lines.push(`The machine this thread runs on:\n${boxLine(machine)}; ${ownerWords(machine)}`);
        }
        lines.push(list.length ? `This thread's boxes:\n${list.map(boxLine).join("\n")}` : "This thread has no boxes.");
        lines.push(
          kinds.length
            ? `Kinds:\n${kinds.map((kind) => `- ${kind.id}: ${kind.label}${kind.gpu ? " (GPU)" : ""}. ${kind.description} Sizes: ${kindSizesText(kind)}. ${[adminText(kind), dockerText(kind)].filter(Boolean).join(" ")} On: ${kind.offers.map((offer) => offer.name).join(", ")}.${imagesText(images, kind.id)}`).join("\n")}`
            : "No backend is set up, so there are no kinds. Ask the user to set one up in BB Box's settings in BB.",
        );
        const hints = list.length
          ? ["Call box_status for a box's details.", "box_acquire gets another box, at a preset or a custom size."]
          : ["Call box_acquire to get a box, at a preset or a custom size."];
        return `${lines.join("\n\n")}${next(...hints)}`;
      } catch (error) {
        return failure(error, "Listing boxes");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_status",
    description: "Show one box: its state, kind, address, whether it is a BB machine, and how long it took to start and to become one.",
    presentation: { label: { pending: "Checking a box", completed: "Checked a box" } },
    parameters: z.object({ box: boxParam }),
    async execute({ box: ref }, { threadId, signal }) {
      try {
        const { owner, box: found } = await app.resolve(thread(threadId), ref, signal);
        const box = await boxes.refresh(owner, found.id, signal).catch(async (error) => {
          if (error instanceof BoxError && error.code === "backend_off") return boxes.get(owner, found.id);
          throw error;
        });
        const hints: Record<string, string[]> = {
          ready: using(box),
          acquiring: [`Call box_status again in a few seconds.`],
          starting: [`Call box_status again in a few seconds.`],
          stopped: [`Call box_start with box "${box.name}" to start it.`],
          failed: [`Release it with box_release, then box_acquire another.`],
          gone: [`Release it with box_release, then box_acquire another.`],
        };
        return `${boxDetail(box, app.control(box))}${next(...(hints[box.state] ?? []))}`;
      } catch (error) {
        return failure(error, "Checking the box");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_run",
    description:
      "Run a shell script in a box, as its user, and wait for it. You get the exit code, stdout and stderr. box_status says whether the box user can use sudo.",
    presentation: { label: { pending: "Running in a box", completed: "Ran in a box" } },
    parameters: z.object({
      box: boxParam,
      command: z.string().min(1).describe("A shell script, run by the box user's shell (bash on Linux, PowerShell 7 on Windows)."),
      cwd: z.string().optional().describe("Directory to run in. Defaults to the box user's home."),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(RUN_TIMEOUT_MAX_S)
        .optional()
        .describe(
          `Seconds before the command, and everything it started, is stopped. Defaults to ${RUN_TIMEOUT_S}. box_run returns when the script's shell exits. Start a server in the background with its output redirected, so it keeps working after that: nohup <cmd> >server.log 2>&1 &, or on Windows Start-Detached { <cmd> } server.log`,
        ),
      stdin: z.string().optional().describe("Text to send to the command's standard input."),
      desktop: z.boolean().optional().describe("Run in the box's desktop session so it can open windows. Desktop boxes only."),
    }),
    async execute({ box: ref, command, cwd, timeout_seconds, stdin, desktop }, { threadId, signal }) {
      const job = newJobId();
      let target: BoxRecord | undefined;
      try {
        const { owner, box: found } = await app.resolve(thread(threadId), ref, signal);
        target = found;
        const { box, result } = await drain.run(signal, (signal) =>
          boxes.run(owner, found.id, command, {
            cwd,
            stdin,
            timeoutMs: (timeout_seconds ?? RUN_TIMEOUT_S) * 1000,
            session: desktop ? "desktop" : "default",
            signal,
            maxOutputBytes: RUN_OUTPUT_BYTES,
            job,
          }),
        );
        const text = runText(box, result);
        const background = box.capabilities.os === "windows" ? "Start-Detached { <cmd> } job.log" : "nohup <cmd> >job.log 2>&1 &";
        const hints = result.timedOut
          ? [`Give timeout_seconds more time, or start a long job in the background with ${background} and check on it.`]
          : [`Run more with box_run, or copy results out with box_copy (direction from_box).`];
        return result.exitCode === 0 && !result.timedOut
          ? `${text}${next(...hints)}`
          : { content: [{ type: "text", text: `${text}${next(...hints)}` }], isError: result.timedOut };
      } catch (error) {
        // A command that fails while bb-box stops may go on too.
        const stopping = drain.closed && !(error instanceof BoxError && error.code === "restarting");
        if (target && (error instanceof Restarted || stopping)) return restarted(target, job, error instanceof Restarted);
        return failure(error, "Running the command");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_job",
    description:
      "Get the exit code and output of a box_run command that went on in its box as a job when bb-box restarted, as for an update. box_run's error names the job.",
    presentation: { label: { pending: "Reading a job", completed: "Read a job" } },
    parameters: z.object({
      box: boxParam,
      job: z.string().regex(JOB_ID).describe("The job's ID, from box_run's error."),
    }),
    async execute({ box: ref, job }, { threadId, signal }) {
      try {
        const { owner, box: found } = await app.resolve(thread(threadId), ref, signal);
        const { box, job: result } = await boxes.job(owner, found.id, job, { signal, maxOutputBytes: RUN_OUTPUT_BYTES });
        if (!result) {
          const text = `Box ${box.name} has no job ${job}: its result was read already, or it ended more than ${JOB_DAYS} days ago.`;
          return { content: [{ type: "text", text: `${text}${next("Check the box's state with box_run.")}` }], isError: true };
        }
        if (result.state === "running") {
          return `${outputText(`Job ${job} is still running in box ${box.name}. The end of its output so far:`, result)}${next(`Call box_job again later.`)}`;
        }
        return `${outputText(`Job ${job} ended with exit code ${result.exitCode} in box ${box.name}.`, result)}${next(`Run more with box_run.`)}`;
      } catch (error) {
        return failure(error, "Reading the job");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_copy",
    description:
      "Copy one file between this thread's workspace or its storage folder ($BB_THREAD_STORAGE) and a box. A relative path on this side is under the workspace; a path under the storage folder, absolute or starting with $BB_THREAD_STORAGE/, is there. A relative box path, or one starting with ~/, is under the box user's home. Tar a directory first.",
    presentation: { label: { pending: "Copying a file", completed: "Copied a file" } },
    parameters: z.object({
      box: boxParam,
      direction: z.enum(["to_box", "from_box"]).describe("to_box copies from the workspace or storage folder into the box; from_box copies from the box into the workspace or storage folder."),
      from: z.string().min(1).describe("The file to copy."),
      to: z.string().min(1).optional().describe("Where to put it. Defaults to the file's own name, in the box user's home or in the workspace's directory."),
    }),
    async execute({ box: ref, direction, from, to }, { threadId, signal }) {
      try {
        const id = thread(threadId);
        const { owner, box: found } = await app.resolve(id, ref, signal);
        // A file in the thread's storage folder (#482), else in the workspace. BB is asked for the folder only for a path that may be in it.
        const local = async (path: string): Promise<ThreadFile> => {
          const mayBeStored = STORAGE_PREFIX.test(path) || posix.isAbsolute(path) || win32.isAbsolute(path);
          const stored = mayBeStored ? storageFile(path, await app.threadStorage(id, signal)) : null;
          if (stored) return stored;
          if (STORAGE_PREFIX.test(path)) throw new Error(`BB gives no storage folder for this thread, so ${path} is nowhere. Give a path in the workspace.`);
          const workspace = await app.workspace(id, signal);
          return { hostId: workspace.hostId, path: workspacePath(workspace.path, path), rootPath: workspace.path ?? undefined, stored: false };
        };
        if (direction === "to_box") {
          const source = await local(from);
          const target = boxPath(to ?? pathsOf(source.rootPath ?? null).basename(source.path));
          const file = await bb.sdk.files.read({ hostId: source.hostId, path: source.path, rootPath: source.rootPath, signal });
          if (!("content" in file)) throw new Error(`BB did not return the contents of ${source.path}.`);
          if (file.sizeBytes > COPY_MAX_BYTES) throw new Error(`${source.path} is ${file.sizeBytes} bytes; box_copy moves files up to ${COPY_MAX_BYTES / 1024 / 1024} MiB. Split or compress it first.`);
          const box = await boxes.writeFile(owner, found.id, target, bytes(file.content, file.contentEncoding), { signal });
          return `Copied ${source.path} (${file.sizeBytes} bytes) to ${target} in box ${box.name}.${next(`Use it with box_run (box "${box.name}").`)}`;
        }
        const target = await local(to ?? (found.capabilities.os === "windows" ? win32 : posix).basename(from));
        const { box, data } = await boxes.readFile(owner, found.id, boxPath(from), { maxBytes: COPY_MAX_BYTES, signal });
        await bb.sdk.files.write({
          hostId: target.hostId,
          path: target.path,
          rootPath: target.rootPath,
          content: Buffer.from(data).toString("base64"),
          contentEncoding: "base64",
          createParents: true,
        });
        return `Copied ${from} (${data.byteLength} bytes) from box ${box.name} to ${target.path} in ${target.stored ? "this thread's storage folder" : "the workspace"}.${next("Read it with your usual file tools.")}`;
      } catch (error) {
        return failure(error, "Copying the file");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_stop",
    description: "Stop a box to free its memory and CPU while keeping its disk. box_start starts it again.",
    presentation: { label: { pending: "Stopping a box", completed: "Stopped a box" } },
    parameters: z.object({ box: boxParam }),
    async execute({ box: ref }, { threadId, signal }) {
      try {
        const id = thread(threadId);
        const { box: found, runsOn } = await app.resolve(id, ref, signal);
        if (runsOn) throw runsOnRefusal(found, "stop");
        const idle = await app.checkInUse(found, "Stopping");
        const box = await boxes.stop(id, found.id, signal);
        return `Box ${box.name} is stopped.${idleWords(idle, true)}${next(`Call box_start with box "${box.name}" when you need it again, or box_release if you do not.`)}`;
      } catch (error) {
        return failure(error, "Stopping the box");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_start",
    description: "Start a stopped box again, with its disk as it was, and wait up to 20 s more while it reconnects as a BB machine.",
    presentation: { label: { pending: "Starting a box", completed: "Started a box" } },
    parameters: z.object({ box: boxParam }),
    async execute({ box: ref }, { threadId, signal }) {
      try {
        // Its BB machine reconnects after the start; box_run would wait for that anyway.
        const { owner, box: found } = await app.resolve(thread(threadId), ref, signal);
        const box = await boxes.enrolled(await boxes.start(owner, found.id, signal), signal);
        return `${boxDetail(box, app.control(box))}${next(...using(box))}`;
      } catch (error) {
        return failure(error, "Starting the box");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_thread",
    description:
      "Start a child thread on a box, as a BB machine, in this thread's project, with the task as its prompt. It works in a worktree of the project's repository on the box, cloned there once, and is archived with this thread.",
    presentation: { label: { pending: "Starting a thread on a box", completed: "Started a thread on a box" } },
    parameters: z.object({
      box: boxParam,
      prompt: z.string().min(1).describe("The child thread's first message: the task it should do on the box."),
      title: z.string().min(1).max(120).optional().describe('A title for the child thread. Defaults to "On box <name>".'),
    }),
    async execute({ box: ref, prompt, title }, { threadId, signal }) {
      try {
        const id = thread(threadId);
        const box = await boxes.get(id, ref);
        const child = await app.startThread({ threadId: id, box: box.id, prompt, title, signal });
        return `Started thread ${child} on box ${box.name}.${next(`It reports back like any child thread; bb thread show ${child} shows its progress.`)}`;
      } catch (error) {
        return failure(error, "Starting a thread on the box");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_release",
    description: "Release a box you no longer need. Its disk and everything on it are deleted. Copy out anything you want to keep first.",
    presentation: { label: { pending: "Releasing a box", completed: "Released a box" } },
    parameters: z.object({ box: boxParam }),
    async execute({ box: ref }, { threadId }) {
      try {
        const id = thread(threadId);
        const { box, runsOn } = await app.resolve(id, ref);
        if (runsOn) throw runsOnRefusal(box, "release");
        const idle = await app.checkInUse(box, "Releasing");
        const left = await boxes.release(id, box.id, "its thread released it with box_release");
        if (left) {
          return `Box ${box.name} is still being released: ${left.error ?? "the backend has not finished"}. bb-box keeps trying in the background.${next("Carry on; nothing else is needed.")}`;
        }
        return `Released box ${box.name}.${idleWords(idle, false)}${next("Call box_acquire when you need another box.")}`;
      } catch (error) {
        return failure(error, "Releasing the box");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_image_draft",
    description:
      "Draft a project image's script (049) from the project's own files, for you to finish, try with box_image_try and register with box_image_set. Read these from the repository and pass each one's path and text: " +
      ".devcontainer/devcontainer.json (or .devcontainer.json, or one in a subfolder of .devcontainer) and the Dockerfile it names; a Dockerfile; .tool-versions; mise.toml; .nvmrc or .node-version; .python-version; rust-toolchain.toml or rust-toolchain; flake.nix with flake.lock, or shell.nix. " +
      "It returns a script for .bb/box-setup.sh, each part commented with the file it came from, a check for .bb/box-check.sh, and what it could not translate. The script runs as root on bb-box's standard Ubuntu 24.04 image, with no checkout of the repository: what needs one, such as npm ci, stays in the thread. " +
      "With `box`, it also reads what a Linux box of this thread has that its image had not, for a box someone set up by hand: packages, package sources, npm globals, mise's tools, the Rust toolchain, uv tools, and what is new in /usr/local, /opt and ~/.local/bin.",
    presentation: { label: { pending: "Drafting the image's script", completed: "Drafted the image's script" } },
    parameters: z.object({
      files: z
        .array(z.object({ path: z.string().min(1).describe("The file's path in the repository, such as .devcontainer/devcontainer.json."), text: z.string().describe("The file's text.") }))
        .max(20)
        .describe("The project's files the draft reads. An empty list gives a template."),
      box: z.string().optional().describe("A Linux box of this thread to read what was set up in it by hand, by name or ID."),
    }),
    async execute({ files, box: ref }, { threadId, signal }) {
      try {
        let scan: { name: string; scan: string } | undefined;
        if (ref) {
          const { owner, box: found } = await app.resolve(thread(threadId), ref, signal);
          if (found.capabilities.os !== "linux") throw new BoxError("unsupported", `Box ${found.name} is not a Linux box, and an image's script is Linux's.`);
          const { result } = await boxes.run(owner, found.id, SCAN_SCRIPT, { timeoutMs: 60_000, signal, maxOutputBytes: 256 * 1024, waitForEnrolment: false });
          if (result.exitCode !== 0) throw new BoxError("unreachable", `Reading box ${found.name} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
          scan = { name: found.name, scan: result.stdout };
        }
        const draft = draftImage(files, scan);
        const hint = draft.gaps.length
          ? "Settle what it left to you, write the files, then try them with box_image_try."
          : "Write the files, then try them with box_image_try.";
        return `${draftText(draft)}${next(hint)}`;
      } catch (error) {
        return failure(error, "Drafting the script");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_image_try",
    description:
      "Try a project image's script as a build runs it (049), before box_image_set: in a new box of the kind's current standard image, on a backend that builds images, the script runs as root with BB_BOX_IMAGE, BB_BOX_KIND, BB_BOX_BACKEND and BB_BOX_ARCH, then the check as the box user, then finalizing, which empties /tmp, /var/tmp and the caches. " +
      "A box of the build then runs the check again and the kind's own check. It returns each check's result, the time and the build's last 200 lines, and removes the boxes and the build. " +
      "Each try starts from a clean standard image, as a build does, so fix the script and try again until every check passes. It can take as long as the script, plus about a minute.",
    presentation: { label: { pending: "Trying the image's script", completed: "Tried the image's script" } },
    parameters: z.object({
      kind: z.string().min(1).describe('The Linux kind to try it on, such as "linux". box_list shows the kinds.'),
      script: z.string().min(1).describe("The script's text, run as root, as in .bb/box-setup.sh."),
      check: z.string().optional().describe("The check's text, run as the box user, as in .bb/box-check.sh: it should fail when the script did not do its work."),
      name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional().describe('The image\'s name, which the script reads as BB_BOX_IMAGE. "try" when left out.'),
      on: z.string().optional().describe("A backend's ID from box_list, such as proxmox-lxc. The first that builds the kind's images when left out."),
    }),
    async execute({ kind, script, check, name, on }, { signal }) {
      try {
        const result = await app.imageBakes.try({ name: name ?? "try", kind, script, ...(check?.trim() ? { check } : {}), ...(on ? { on } : {}) }, signal);
        const hint = result.ok
          ? "Commit the files, then register them with box_image_set; ask the user first unless they asked for the image."
          : result.reason
            ? "Try again; if it fails the same way, tell the user."
            : "Fix the script or the check from the lines above, then call box_image_try again.";
        return { content: [{ type: "text", text: `${tryText(result)}${next(hint)}` }], ...(result.ok ? {} : { isError: true }) };
      } catch (error) {
        return failure(error, "Trying the script");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_image_set",
    description:
      "Set this thread's project's image (049): a shell script run as root on the standard image of its kinds, so the project's boxes start with what it needs, such as a language's toolchain. " +
      "Pass the files' text: commit them in the repository as .bb/box-setup.sh and .bb/box-check.sh, and give their paths. The script runs in a booted box with the network, on any Linux backend, and reads BB_BOX_IMAGE, BB_BOX_KIND, BB_BOX_BACKEND and BB_BOX_ARCH where it must differ. It gets none of the project's secrets. " +
      "Setting it changes every new box of those kinds in the project, so ask the user first unless they asked for it.",
    presentation: { label: { pending: "Setting the project's image", completed: "Set the project's image" } },
    parameters: z.object({
      name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).describe('The image\'s name, such as "rust-tools": a lower-case letter first, then letters, digits and "-".'),
      kinds: z.array(z.string().min(1)).min(1).describe('The Linux kinds it builds on, such as ["linux", "linux-desktop-cpu"]. box_list shows the kinds.'),
      script: z.string().min(1).describe("The script's text, run as root."),
      check: z.string().optional().describe("A check's text, run as the box user after the script, such as `cargo --version`: the image fails when it fails."),
      bake: z.enum(["auto", "always", "never"]).optional().describe("auto (the default) builds it ahead once two boxes started within 14 days; always keeps a build; never runs the script at each start."),
      script_path: z.string().optional().describe("The script's path in the repository, such as .bb/box-setup.sh."),
      check_path: z.string().optional().describe("The check's path in the repository, such as .bb/box-check.sh."),
    }),
    async execute({ name, kinds, script, check, bake, script_path: scriptPath, check_path: checkPath }, { threadId }) {
      try {
        const project = await app.projectOf(thread(threadId));
        if (!project) throw new BoxError("unsupported", "This thread has no BB project, so it has no project's image to set.");
        // Another project's image of the name is theirs to change.
        const current = app.configuration.exported().images?.[name];
        if (current && !current.projects.includes(project)) {
          throw new BoxError("in_use", `Image ${name} belongs to ${current.projects.join(", ")}, not this thread's project. Pick another name.`);
        }
        const result = await app.setImage(name, {
          kinds,
          script,
          ...(check?.trim() ? { check } : {}),
          ...(bake ? { bake } : {}),
          projects: current ? current.projects : [project],
          ...(scriptPath || checkPath ? { source: { ...(scriptPath ? { script: scriptPath } : {}), ...(checkPath ? { check: checkPath } : {}) } } : {}),
          updated: new Date().toISOString(),
        });
        if (!result.ok) {
          const why = result.reason === "problems" ? result.problems.map((problem) => problem.message).join(" ") : "The configuration kept changing.";
          return { content: [{ type: "text", text: `The image was not saved: ${why}${next("Fix what it says and call box_image_set again.")}` }], isError: true };
        }
        return `Set image ${name} for ${kinds.join(", ")} boxes in this thread's project.${next("Tell the user what changed. bb box image list shows the project's images, and bb box image remove removes one.")}`;
      } catch (error) {
        return failure(error, "Setting the project's image");
      }
    },
  });
}
