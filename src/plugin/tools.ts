// The agent tools. Each result ends with "Next:" hints, and each refusal
// says what to do instead, so an agent never has to guess.

import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { BoxError, describeError, type BoxErrorCode, type BoxRecord } from "../core/boxes.ts";
import { describeSize } from "../core/sizes.ts";
import type { RunResult } from "../transports/types.ts";
import type { BbBox } from "./setup.ts";
import { adminText, boxDetail, boxLine, boxSize, next, type KindView } from "./views.ts";

/** Output kept per stream; beyond it, the head and tail are kept. */
export const RUN_OUTPUT_BYTES = 32 * 1024;
/** Largest file box_copy moves. */
export const COPY_MAX_BYTES = 16 * 1024 * 1024;
const RUN_TIMEOUT_S = 10 * 60;
const RUN_TIMEOUT_MAX_S = 60 * 60;

const HINTS: Record<BoxErrorCode, string> = {
  not_found: "Call box_list to see this thread's boxes.",
  unknown_kind: "Call box_list to see the kinds you can acquire.",
  invalid_size: "Pick a preset, or a custom size within the largest. box_list shows each kind's sizes.",
  limit_reached: "Release a box you no longer need with box_release, then try again.",
  no_capacity: "Try again later, release a box you no longer need, or pick another kind.",
  not_ready: "Call box_status to see its state. box_start starts a stopped box.",
  unsupported: "Call box_status to see what the box can do.",
  backend_off: "Ask the user to fix its backend's settings in bb-box's settings, or release the box.",
  released: "Acquire a new box with box_acquire.",
  unreachable: "Call box_status. If the box still does not answer, release it and acquire a new one.",
  in_use: "Leave the box while that thread works. Ask the user if it should go anyway: they can release it from bb-box's panel.",
};

export function failure(error: unknown, action: string): PluginAgentToolResult {
  const hint = error instanceof BoxError ? HINTS[error.code] : "Call box_status to see the box, or try again.";
  return { content: [{ type: "text", text: `${describeError(error, action)}${next(hint)}` }], isError: true };
}

export function thread(threadId: string | undefined): string {
  if (!threadId) throw new BoxError("unsupported", "bb-box tools work only inside a BB thread.");
  return threadId;
}

function using(box: BoxRecord): string[] {
  return [`Run commands with box_run (box "${box.name}").`, `Move files with box_copy.`, `Call box_release with box "${box.name}" when you are done.`];
}

function runText(box: BoxRecord, result: RunResult): string {
  const parts = [
    result.timedOut
      ? `Timed out in box ${box.name} after ${(result.durationMs / 1000).toFixed(1)} s.`
      : `Exit code ${result.exitCode ?? "none (killed)"} in box ${box.name}, after ${(result.durationMs / 1000).toFixed(1)} s.`,
  ];
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

export const boxParam = z.string().min(1).describe("The box's name or ID, from box_acquire or box_list.");

export function registerTools(bb: BbPluginApi, app: BbBox): void {
  const { boxes } = app;

  bb.agents.registerTool({
    name: "box_acquire",
    description:
      "Get a fresh Linux box (a small computer) for this thread, to run commands, builds, tests, servers or Docker away from the thread's own machine. Boxes start in seconds and are yours until you release them or the thread ends.",
    instructions:
      "bb-box: use box_acquire when you need a clean Linux machine, root-level installs (box_list shows which kinds give root), Docker, or to run something you would not run on the thread's machine. Release boxes you no longer need with box_release; the thread's boxes go when it is archived or deleted.",
    presentation: { label: { pending: "Acquiring a box", completed: "Acquired a box" } },
    parameters: z.object({
      kind: z
        .string()
        .min(1)
        .optional()
        .describe("The kind of box, for example linux, linux-docker or linux-desktop. Defaults to the user's default kind, linux unless they changed it. box_list shows every kind."),
      size: z
        .string()
        .min(1)
        .optional()
        .describe("A preset: small, medium or large. Defaults to the kind's default preset, small unless the user changed it. box_list shows each kind's sizes."),
      cores: z.number().int().positive().optional().describe("Cores, for a custom size. Parts you leave out come from the preset."),
      memory_gib: z.number().int().positive().optional().describe("Memory in GiB, for a custom size."),
      disk_gib: z.number().int().positive().optional().describe("Root disk in GiB, for a custom size. Presets keep the kind's own disk."),
      wait: z.boolean().optional().describe("Wait until the box answers, and up to 20 s more while it becomes a BB machine. Defaults to true."),
    }),
    async execute({ kind, size, cores, memory_gib, disk_gib, wait }, { threadId, projectId, signal }) {
      try {
        const box = await boxes.acquire({
          threadId: thread(threadId),
          projectId: projectId ?? null,
          kind: kind ?? (await app.general()).defaultKind,
          size: { preset: size, cores, memoryGiB: memory_gib, diskGiB: disk_gib },
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
        const list = await boxes.list(thread(threadId));
        const kinds = await app.kinds();
        const lines = [list.length ? `This thread's boxes:\n${list.map(boxLine).join("\n")}` : "This thread has no boxes."];
        lines.push(
          kinds.length
            ? `Kinds:\n${kinds.map((kind) => `- ${kind.id}: ${kind.label}. ${kind.description} Sizes: ${kindSizesText(kind)}. ${adminText(kind.admin)}`).join("\n")}`
            : "No backend is set up, so there are no kinds to acquire. Ask the user to set one up in bb-box's settings.",
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
        const id = thread(threadId);
        const box = await boxes.refresh(id, ref, signal).catch(async (error) => {
          if (error instanceof BoxError && error.code === "backend_off") return boxes.get(id, ref);
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
      command: z.string().min(1).describe("A shell script, run by the box user's shell (bash on Linux)."),
      cwd: z.string().optional().describe("Directory to run in. Defaults to the box user's home."),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(RUN_TIMEOUT_MAX_S)
        .optional()
        .describe(
          `Seconds before the command, and everything it started, is stopped. Defaults to ${RUN_TIMEOUT_S}. box_run returns when the script's shell exits. Start a server in the background with its output redirected, so it keeps working after that: nohup <cmd> >server.log 2>&1 &`,
        ),
      stdin: z.string().optional().describe("Text to send to the command's standard input."),
      desktop: z.boolean().optional().describe("Run in the box's desktop session so it can open windows. Desktop boxes only."),
    }),
    async execute({ box: ref, command, cwd, timeout_seconds, stdin, desktop }, { threadId, signal }) {
      try {
        const { box, result } = await boxes.run(thread(threadId), ref, command, {
          cwd,
          stdin,
          timeoutMs: (timeout_seconds ?? RUN_TIMEOUT_S) * 1000,
          session: desktop ? "desktop" : "default",
          signal,
          maxOutputBytes: RUN_OUTPUT_BYTES,
        });
        const text = runText(box, result);
        const hints = result.timedOut
          ? ["Give timeout_seconds more time, or start a long job in the background with nohup <cmd> >job.log 2>&1 & and check on it."]
          : [`Run more with box_run, or copy results out with box_copy (direction from_box).`];
        return result.exitCode === 0 && !result.timedOut
          ? `${text}${next(...hints)}`
          : { content: [{ type: "text", text: `${text}${next(...hints)}` }], isError: result.timedOut };
      } catch (error) {
        return failure(error, "Running the command");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_copy",
    description:
      "Copy one file between this thread's workspace and a box. A relative workspace path is under the workspace's directory. A relative box path, or one that starts with ~/, is under the box user's home. For a directory, tar it first with box_run or a shell command.",
    presentation: { label: { pending: "Copying a file", completed: "Copied a file" } },
    parameters: z.object({
      box: boxParam,
      direction: z.enum(["to_box", "from_box"]).describe("to_box copies from the workspace into the box; from_box copies from the box into the workspace."),
      from: z.string().min(1).describe("The file to copy."),
      to: z.string().min(1).optional().describe("Where to put it. Defaults to the file's own name, in the box user's home or in the workspace's directory."),
    }),
    async execute({ box: ref, direction, from, to }, { threadId, signal }) {
      try {
        const id = thread(threadId);
        const workspace = await app.workspace(id, signal);
        const rootPath = workspace.path ?? undefined;
        if (direction === "to_box") {
          const source = workspacePath(workspace.path, from);
          const target = boxPath(to ?? pathsOf(workspace.path).basename(source));
          const file = await bb.sdk.files.read({ hostId: workspace.hostId, path: source, rootPath, signal });
          if (!("content" in file)) throw new Error(`BB did not return the contents of ${source}.`);
          if (file.sizeBytes > COPY_MAX_BYTES) throw new Error(`${source} is ${file.sizeBytes} bytes; box_copy moves files up to ${COPY_MAX_BYTES / 1024 / 1024} MiB. Split or compress it first.`);
          const box = await boxes.writeFile(id, ref, target, bytes(file.content, file.contentEncoding), { signal });
          return `Copied ${source} (${file.sizeBytes} bytes) to ${target} in box ${box.name}.${next(`Use it with box_run (box "${box.name}").`)}`;
        }
        const target = workspacePath(workspace.path, to ?? posix.basename(from));
        const { box, data } = await boxes.readFile(id, ref, boxPath(from), { maxBytes: COPY_MAX_BYTES, signal });
        await bb.sdk.files.write({
          hostId: workspace.hostId,
          path: target,
          rootPath,
          content: Buffer.from(data).toString("base64"),
          contentEncoding: "base64",
          createParents: true,
        });
        return `Copied ${from} (${data.byteLength} bytes) from box ${box.name} to ${target} in the workspace.${next("Read it with your usual file tools.")}`;
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
        await app.refuseInUse(await boxes.get(id, ref), "Stopping");
        const box = await boxes.stop(id, ref, signal);
        return `Box ${box.name} is stopped.${next(`Call box_start with box "${box.name}" when you need it again, or box_release if you do not.`)}`;
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
        const box = await boxes.enrolled(await boxes.start(thread(threadId), ref, signal), signal);
        return `${boxDetail(box, app.control(box))}${next(...using(box))}`;
      } catch (error) {
        return failure(error, "Starting the box");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_thread",
    description:
      "Start a child thread that runs on a box, as a BB machine, with this thread's project. Give it the task as its prompt. It works in a worktree of the project's repository on the box, cloned there for the first thread, and is archived with this thread.",
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
        const box = await boxes.get(id, ref);
        await app.refuseInUse(box, "Releasing");
        const left = await boxes.release(id, box.id);
        if (left) {
          return `Box ${box.name} is still being released: ${left.error ?? "the backend has not finished"}. bb-box keeps trying in the background.${next("Carry on; nothing else is needed.")}`;
        }
        return `Released box ${box.name}.${next("Call box_acquire when you need another box.")}`;
      } catch (error) {
        return failure(error, "Releasing the box");
      }
    },
  });
}
