// The agent tools. Each result ends with "Next:" hints, and each refusal
// says what to do instead, so an agent never has to guess.

import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { posix, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import { BoxError, OPERATOR, SPARES, describeError, isAcquiring, type BoxErrorCode, type BoxRecord } from "../core/boxes.ts";
import { boxFileSum, readStream, settlePart, writePart, type FileSum } from "../core/copy.ts";
import { SCAN_SCRIPT, draftImage } from "../core/draft.ts";
import { JOB_DAYS, JOB_ID, newJobId } from "../core/in-box.ts";
import { describeSize } from "../core/sizes.ts";
import { RECORD_DIR, RECORD_LIMIT_S, RECORD_START_EXITS, RECORD_STOP_EXITS, parseRecordResult, previewHeight, recordPage, recordStartScript, recordStopScript } from "../core/record.ts";
import { GRANT_PERMISSIONS, type BoxGrants } from "../backends/types.ts";
import type { RunResult } from "../transports/types.ts";
import { DRAIN_MS, Detached, Drain, Restarted } from "./drain.ts";
import type { BbBox } from "./setup.ts";
import { adminText, boxDetail, dockerText, boxLine, boxSize, draftText, idleWords, imagesText, next, startingWords, tryText, type KindView } from "./views.ts";

/** Output kept per stream; beyond it, the head and tail are kept. */
export const RUN_OUTPUT_BYTES = 32 * 1024;
/** Largest file box_copy moves through BB's file API; a larger one streams through the worker on the thread's machine (#492). */
export const COPY_MAX_BYTES = 16 * 1024 * 1024;
const RUN_TIMEOUT_S = 10 * 60;
/**
 * How long box_run waits for a command (#486). BB ends a tool call at about
 * five minutes with "terminated", without telling the plugin, so box_run
 * returns before then, and the command goes on as a job (#414). A Windows
 * command in the desktop session, which has no job yet, is stopped then.
 */
export const RUN_WAIT_MS = 270_000;
/** How long box_run waits, after a command lost its box, to see whether bb-box is stopping for a deploy (#415). */
const LOST_BOX_MS = 10_000;
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
  reconnecting: "Wait about 30 s and try again: bb-box is usually back within a minute. Do not release the box: it, and the commands and jobs in it, go on.",
};

export function failure(error: unknown, action: string): PluginAgentToolResult {
  const hint = error instanceof BoxError ? HINTS[error.code] : "Call box_status to see the box, or try again.";
  return { content: [{ type: "text", text: `${describeError(error, action)}${next(hint)}` }], isError: true };
}

/** box_run's answer when bb-box restarted while its command ran: `sure` when bb-box stopped it itself (#405). */
function restarted(box: BoxRecord, job: string, sure: boolean, jobless: boolean): PluginAgentToolResult {
  const text =
    jobless
      ? `bb-box restarted, as for an update, while the command ran in box ${box.name}. A Windows command in the desktop session ends with bb-box's connection, so it stopped.${next("Run it again.")}`
      : `bb-box restarted, as for an update, while the command ran in box ${box.name}. It ${sure ? "goes" : "may go"} on there as job ${job}.${next(`Call box_job with box "${box.name}" and job "${job}" for its exit code and output once it ends. bb-box is back within a minute; until then the box may not answer.`)}`;
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

/** Whether BB's file API refused a file for its size: it takes a file whole, up to 25 MB (#485, BB request 20). */
function refusedForSize(error: unknown): boolean {
  return /\b413\b|exceeds the \d+ ?MB limit/.test(error instanceof Error ? error.message : String(error));
}

/** The words for a copy's bytes and SHA-256. */
function summed(sum: FileSum): string {
  return `${sum.bytes} bytes, SHA-256 ${sum.sha256}`;
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
/** Each form's words for box_list, where a kind's providers make it differently. */
const FORM_PLURAL: Record<string, string> = { VM: "VMs", LXC: "LXC containers", Docker: "Docker containers", Physical: "physical machines" };

/** A kind's providers, in acquire order: each with what its boxes are, where that differs between them or the provider says more. */
export function offersText(kind: KindView): string {
  const differ = new Set(kind.offers.map((offer) => offer.form)).size > 1;
  return kind.offers
    .map((offer) => {
      const what = offer.note ?? (differ && offer.form ? FORM_PLURAL[offer.form] : null);
      return what ? `${offer.name} (${what})` : offer.name;
    })
    .join(", ");
}

function kindSizesText(kind: KindView): string {
  const presets = kind.presets.map((preset) => `${preset.name} (${preset.words}${preset.name === kind.defaultPreset ? ", the default" : ""})`);
  return `${presets.join(", ")}; custom up to ${kind.largest.words}`;
}

/** "just now", "1 minute ago", "3 hours ago", "2 days ago". */
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const [count, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 1440 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  return count ? `${count} ${unit}${count === 1 ? "" : "s"} ago` : "just now";
}

/**
 * A GPU desktop kind's room as each provider last read it (#603), for
 * box_list: each GPU's free memory, or that no GPU has room and what to do
 * instead. Empty when no provider has read a GPU.
 */
export function gpuRoomText(kind: KindView, kinds: readonly KindView[], now = Date.now()): string {
  const cpu = kinds.find((other) => other.desktop && !other.gpu && other.os === kind.os && other.arch === kind.arch && other.windowing === kind.windowing);
  return kind.offers
    .flatMap((offer) => {
      const room = offer.gpuRoom;
      if (!room?.readings.length) return [];
      const on = kind.offers.length > 1 ? ` on ${offer.name}` : "";
      const needs = `a desktop needs ${room.readings[0]!.neededMiB} MiB`;
      if (room.fullUntil !== null && room.fullUntil > now) {
        const minutes = Math.max(1, Math.ceil((room.fullUntil - now) / 60_000));
        const later = `try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
        const each = room.readings.map((gpu) => `${gpu.id} ${gpu.freeMiB} MiB free, ${ago(now - gpu.at)}`).join("; ");
        return [` No GPU${on} has room for a desktop now (${each}; ${needs}). ${cpu ? `Acquire ${cpu.id} instead, or ${later}.` : `${later[0]!.toUpperCase()}${later.slice(1)}.`}`];
      }
      const each = room.readings.map((gpu) => `${gpu.id} ${gpu.freeMiB}${gpu.totalMiB === null ? "" : ` of ${gpu.totalMiB}`} MiB free, ${ago(now - gpu.at)}`).join("; ");
      return [` GPU memory${on}: ${each}; ${needs}.`];
    })
    .join("");
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

/** A Mac box's grants, for box_status (058). */
export function grantsText(grants: BoxGrants): string {
  const listed = grants.grants.map((grant) => `${grant.permission} to ${grant.client}${grant.target ? ` (for ${grant.target})` : ""}`);
  const signing =
    grants.signingIdentity === false
      ? '\nSigning identity: missing, so codesign -s "bb-box local code signing" fails in this box. Tell the Mac\'s operator: its helper could not make it.'
      : "";
  if (!grants.canGrant) return `\nmacOS permissions: box_grant cannot grant them on this Mac, as System Integrity Protection is on.${signing}`;
  return `\nmacOS permissions granted with box_grant: ${listed.length ? listed.join(", ") : "none"}.${signing}`;
}

export function registerTools(bb: BbPluginApi, app: BbBox, options: { drainMs?: number; runWaitMs?: number } = {}): void {
  const runWaitMs = options.runWaitMs ?? RUN_WAIT_MS;
  const { boxes } = app;

  /**
   * Copies a file from a box to the thread's workspace or storage folder:
   * whole through BB's file API up to COPY_MAX_BYTES, else streamed through
   * the thread's machine, which keeps it only if its size and SHA-256 match
   * the box's (#492).
   */
  const fromBox = async (owner: string, boxId: string, from: string, target: ThreadFile, signal: AbortSignal): Promise<{ box: BoxRecord; bytes: number; sum: FileSum | null }> => {
    const small = await boxes.readFile(owner, boxId, from, { maxBytes: COPY_MAX_BYTES, signal }).catch((error: unknown) => {
      if (error instanceof Error && /is larger than \d+ bytes/.test(error.message)) return null;
      throw error;
    });
    if (!small) {
      const { box, result } = await boxes.reach(
        owner,
        boxId,
        async (transport, box) => {
          const os = box.capabilities.os;
          const sum = await boxFileSum(transport, os, from, signal);
          const send = (channel: NodeJS.WritableStream) =>
            readStream(transport, os, from, (data) => pipeline(Readable.fromWeb(data as NodeReadableStream<Uint8Array>), channel), signal);
          await app.files.copy(target.hostId, { file: target.path, root: target.rootPath, direction: "receive", expect: sum }, send, signal);
          return sum;
        },
        signal,
      );
      return { box, bytes: result.bytes, sum: result };
    }
    await bb.sdk.files.write({
      hostId: target.hostId,
      path: target.path,
      rootPath: target.rootPath,
      content: Buffer.from(small.data).toString("base64"),
      contentEncoding: "base64",
      createParents: true,
    });
    return { box: small.box, bytes: small.data.byteLength, sum: null };
  };
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
        // Not ready when the kind's wait ran out, or bb-box restarted first.
        if (!settled || isAcquiring(settled)) {
          return `${startingWords(box, !!settled && boxes.stopping)}${next(`Call box_status with box "${box.name}" to see when it is ready.`)}`;
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
            ? `Kinds:\n${kinds.map((kind) => `- ${kind.id}: ${kind.label}${kind.gpu ? " (GPU)" : ""}. ${kind.description} Sizes: ${kindSizesText(kind)}. ${[adminText(kind), dockerText(kind)].filter(Boolean).join(" ")} On: ${offersText(kind)}.${gpuRoomText(kind, kinds)}${imagesText(images, kind.id)}`).join("\n")}`
            : "No backend is set up, so there are no kinds. With the user's go-ahead, bb box setup docker sets up Docker on the machine that runs BB, as the Box panel's first run does; or the user sets a backend up in BB Box's settings.",
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
        const grants = await boxes.grants(box, signal);
        return `${boxDetail(box, app.control(box))}${grants ? grantsText(grants) : ""}${next(...(hints[box.state] ?? []))}`;
      } catch (error) {
        return failure(error, "Checking the box");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_grant",
    description:
      "Grant a program in a macOS box macOS permissions, such as Accessibility or Screen Recording, with no prompt. On Tart's macOS boxes, and on Macs of the SSH host pool with SIP off; Linux and Windows boxes refuse. The program must be the box user's, or an app in /Applications, and signed: sign it with the box's identity, codesign -s \"bb-box local code signing\", so a rebuild keeps the grant. Commands box_run runs have the microphone and camera already.",
    presentation: { label: { pending: "Granting permissions", completed: "Granted permissions" } },
    parameters: z.object({
      box: boxParam,
      program: z.string().min(1).describe("The app's path, such as /Users/bbx-3/Applications/Probe.app, or a program's full path in the box."),
      permissions: z.array(z.enum(GRANT_PERMISSIONS)).min(1).describe("The permissions to grant."),
      target: z.string().optional().describe("For automation: the bundle ID of the app the program sends Apple events to, such as com.apple.finder."),
    }),
    async execute({ box: ref, program, permissions, target }, { threadId, signal }) {
      try {
        const { owner, box: found } = await app.resolve(thread(threadId), ref, signal);
        const { box, answer } = await boxes.grant(owner, found.id, { program, permissions, ...(target ? { target } : {}) }, signal);
        const lines = [
          ...(answer.granted.length ? [`Granted ${answer.granted.join(", ")} to ${answer.client} in box ${box.name}.`] : []),
          ...answer.refused.map((refusal) => `Refused ${refusal.permission}: ${refusal.reason}`),
        ];
        const isApp = /\.app\/?$/.test(program);
        const hints = answer.granted.length
          ? [
              "Start the program again if it is running: macOS reads some permissions only at launch.",
              isApp
                ? "Open the app with open, so that it is its own responsible process and its grants apply."
                : `Run it through bb-box-own, as bb-box-own ${program} <arguments>, so that it is its own responsible process and its grants apply.`,
            ]
          : ["Fix what the refusals say, then call box_grant again."];
        const text = `${lines.join("\n")}${next(...hints)}`;
        return answer.granted.length ? text : { content: [{ type: "text", text }], isError: true };
      } catch (error) {
        return failure(error, "Granting permissions");
      }
    },
  });

  /** A command still running when box_run stopped waiting (#486): it goes on as a job, with its output so far. */
  const detached = async (owner: string, box: BoxRecord, job: string, signal: AbortSignal): Promise<PluginAgentToolResult> => {
    const head = `The command still runs in box ${box.name} after ${Math.round(runWaitMs / 1000)} s, and goes on there as job ${job}: BB ends a tool call at about five minutes, so box_run returns before then.`;
    const so = await boxes.job(owner, box.id, job, { signal, maxOutputBytes: RUN_OUTPUT_BYTES }).catch(() => null);
    // It may have ended as box_run stopped waiting: then that is its result.
    if (so?.job?.state === "ended") return `${outputText(`Exit code ${so.job.exitCode} in box ${box.name}, as job ${job}.`, so.job)}${next("Run more with box_run.")}`;
    const text = so?.job?.state === "running" ? outputText(`${head} The end of its output so far:`, so.job) : head;
    return `${text}${next(`Call box_job with box "${box.name}" and job "${job}" for its exit code and output once it ends.`)}`;
  };

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
          `Seconds before the command, and everything it started, is stopped. Defaults to ${RUN_TIMEOUT_S}. box_run returns when the script's shell exits, or after ${RUN_WAIT_MS / 1000} s, as BB ends a tool call at about five minutes: a command still running then goes on as a job for box_job, except a Windows one in the desktop session, which is stopped then. Start a server in the background with its output redirected, so it keeps working after that: nohup <cmd> >server.log 2>&1 &, or on Windows Start-Detached { <cmd> } server.log`,
        ),
      stdin: z.string().optional().describe("Text to send to the command's standard input."),
      desktop: z.boolean().optional().describe("Run in the box's desktop session so it can open windows. Desktop boxes only."),
    }),
    async execute({ box: ref, command, cwd, timeout_seconds, stdin, desktop }, { threadId, signal }) {
      const job = newJobId();
      let target: { owner: string; box: BoxRecord; jobless?: boolean } | undefined;
      try {
        const { owner, box: found } = await app.resolve(thread(threadId), ref, signal);
        target = { owner, box: found };
        // A Windows command in the desktop session has no job (#414): it is stopped at the wait's end, with its output so far.
        const jobless = found.capabilities.os === "windows" && !!desktop;
        target.jobless = jobless;
        const asked = (timeout_seconds ?? RUN_TIMEOUT_S) * 1000;
        const cut = jobless && asked > runWaitMs;
        const { box, result } = await drain.run(
          signal,
          (signal) =>
            boxes.run(owner, found.id, command, {
              cwd,
              stdin,
              timeoutMs: cut ? runWaitMs : asked,
              session: desktop ? "desktop" : "default",
              signal,
              maxOutputBytes: RUN_OUTPUT_BYTES,
              job,
            }),
          { detachMs: jobless ? undefined : runWaitMs },
        );
        const text = runText(box, result);
        const background = found.capabilities.os === "windows" ? "Start-Detached { <cmd> } job.log" : "nohup <cmd> >job.log 2>&1 &";
        const hints = !result.timedOut
          ? [`Run more with box_run, or copy results out with box_copy (direction from_box).`]
          : cut
            ? [`BB ends a tool call at about five minutes, so box_run stops a Windows command in the desktop session after ${Math.round(runWaitMs / 1000)} s, as it has no job. Start a long one with Start-Detached { <cmd> } job.log, then read job.log with box_run.`]
            : [`Give timeout_seconds more time, or start a long job in the background with ${background} and check on it.`];
        return result.exitCode === 0 && !result.timedOut
          ? `${text}${next(...hints)}`
          : { content: [{ type: "text", text: `${text}${next(...hints)}` }], isError: result.timedOut };
      } catch (error) {
        // A box that stops answering as bb-box starts stopping, as a Docker box on a BB machine does at a deploy, when BB stops
        // bb-box's worker and the relay before it aborts the call (#415): the command may go on there as a job.
        if (target && !target.jobless && error instanceof BoxError && error.code === "unreachable" && (await drain.stoppingWithin(signal, LOST_BOX_MS))) {
          return restarted(target.box, job, false, false);
        }
        // A command that fails while bb-box stops may go on too.
        const stopping = drain.closed && !(error instanceof BoxError && error.code === "restarting");
        if (target && error instanceof Detached) return detached(target.owner, target.box, job, signal);
        if (target && (error instanceof Restarted || stopping)) return restarted(target.box, job, error instanceof Restarted, !!target.jobless);
        return failure(error, "Running the command");
      }
    },
  });

  bb.agents.registerTool({
    name: "box_job",
    description:
      "Get the exit code and output of a box_run command that went on in its box as a job: one still running after 270 s, or when bb-box restarted, as for an update. box_run's answer names the job.",
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
      "Copy one file, of any size, between this thread's workspace or its storage folder ($BB_THREAD_STORAGE) and a box. A file over 16 MiB streams through bb-box's worker on the thread's machine, and its SHA-256 is checked at both ends. A relative path on this side is under the workspace; a path under the storage folder, absolute or starting with $BB_THREAD_STORAGE/, is there. A relative box path, or one starting with ~/, is under the box user's home. Tar a directory first.",
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
          const file = await bb.sdk.files.read({ hostId: source.hostId, path: source.path, rootPath: source.rootPath, signal }).catch((error: unknown) => {
            if (refusedForSize(error)) return null;
            throw error;
          });
          if (file) {
            if (!("content" in file)) throw new Error(`BB did not return the contents of ${source.path}.`);
            const box = await boxes.writeFile(owner, found.id, target, bytes(file.content, file.contentEncoding), { signal });
            return `Copied ${source.path} (${file.sizeBytes} bytes) to ${target} in box ${box.name}.${next(`Use it with box_run (box "${box.name}").`)}`;
          }
          // Too large for BB's file API: the worker on the file's machine streams it to a part file in the box, which replaces the target once the two SHA-256s match (#492).
          const { box, result } = await boxes.reach(
            owner,
            found.id,
            async (transport, box) => {
              const os = box.capabilities.os;
              try {
                const { done, result: written } = await app.files.copy(source.hostId, { file: source.path, root: source.rootPath, direction: "send" }, (channel) => writePart(transport, os, target, channel.iterator({ destroyOnReturn: false }), signal), signal);
                if (done.bytes !== written.bytes || done.sha256 !== written.sha256) {
                  throw new Error(`The copy of ${source.path} did not arrive whole: ${summed(done)} went, and the box has ${summed(written)}. Try again.`);
                }
                await settlePart(transport, os, target, true, signal);
                return written;
              } catch (error) {
                await settlePart(transport, os, target, false).catch(() => undefined);
                throw error;
              }
            },
            signal,
          );
          return `Copied ${source.path} (${summed(result)}) to ${target} in box ${box.name}, streamed through the thread's machine.${next(`Use it with box_run (box "${box.name}").`)}`;
        }
        const target = await local(to ?? (found.capabilities.os === "windows" ? win32 : posix).basename(from));
        const { box, bytes: size, sum } = await fromBox(owner, found.id, boxPath(from), target, signal);
        const folder = target.stored ? "this thread's storage folder" : "the workspace";
        return sum
          ? `Copied ${from} (${summed(sum)}) from box ${box.name} to ${target.path} in ${folder}, streamed through the thread's machine.${next("Read it with your usual file tools.")}`
          : `Copied ${from} (${size} bytes) from box ${box.name} to ${target.path} in ${folder}.${next("Read it with your usual file tools.")}`;
      } catch (error) {
        return failure(error, "Copying the file");
      }
    },
  });

  /** How many parent threads up a recording is copied, so each can show it in a report it passes on. */
  const RECORD_PARENTS = 5;

  bb.agents.registerTool({
    name: "box_record",
    description:
      `Record a desktop box's screen, to show your work in the thread as a short video (059). start begins recording and returns at once: then do what the video should show, with the computer tools and box_run. stop ends it and makes the clip in this thread's storage folder, with a page that plays it in the thread. Still stretches are cut to half a second unless stills is "keep". A recording ends by itself after ${RECORD_LIMIT_S / 60} minutes, and stop still gives its clip. Linux desktops, on X11 and Wayland, macOS and Windows desktops.`,
    presentation: { label: { pending: "Recording the desktop", completed: "Recorded the desktop" } },
    parameters: z.object({
      box: boxParam,
      action: z.enum(["start", "stop"]).describe("start begins recording; stop ends it and makes the clip."),
      speed: z
        .union([z.literal(1), z.literal(2), z.literal(4)])
        .optional()
        .describe("With stop: the clip plays this many times faster. Defaults to 1."),
      stills: z.enum(["cut", "keep"]).optional().describe("With stop: cut each still stretch to half a second (the default), or keep it."),
    }),
    async execute({ box: ref, action, speed, stills }, { threadId, signal }) {
      try {
        const id = thread(threadId);
        const { owner, box: found } = await app.resolve(id, ref, signal);
        if (!found.capabilities.displays.length) throw new BoxError("unsupported", `Box ${found.name} has no desktop to record.`);
        // On Windows both run in the desktop session: gdigrab reads the desktop it runs in, and the stop closes its window.
        const os = found.capabilities.os;
        const session = os === "windows" ? ("desktop" as const) : undefined;
        if (action === "start") {
          const { result } = await boxes.run(owner, found.id, recordStartScript(os), { timeoutMs: 30_000, signal, session, waitForEnrolment: false });
          const refused: Partial<Record<number, string>> = {
            [RECORD_START_EXITS.running]: `Box ${found.name} is recording already.${next(`Call box_record with box "${found.name}" and action "stop" for its clip.`)}`,
            [RECORD_START_EXITS.noRecorder]: `Box ${found.name} has no ${result.stderr.trim() || "recorder"} yet, which box_record needs there. It comes with the image's next rebuild, or on a Mac of the SSH host pool when its owner runs setup-mac.sh again.`,
            [RECORD_START_EXITS.noDisplay]: `Box ${found.name}'s desktop is not running.${next(`Call box_status with box "${found.name}" to see why.`)}`,
          };
          const said = refused[result.exitCode ?? -1];
          if (said) return { content: [{ type: "text", text: said }], isError: true };
          if (result.exitCode !== 0) throw new BoxError("unreachable", `Recording box ${found.name} did not start: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
          return `Recording box ${found.name}'s desktop, for at most ${RECORD_LIMIT_S / 60} minutes.${next(`Do what the video should show, then call box_record with box "${found.name}" and action "stop".`)}`;
        }
        const storage = await app.threadStorage(id, signal);
        if (!storage) throw new BoxError("unsupported", "BB gives no storage folder for this thread, so there is nowhere to put the clip.");
        const times = speed ?? 1;
        const { result } = await boxes.run(owner, found.id, recordStopScript({ speed: times, stills: stills ?? "cut", os }), {
          timeoutMs: 240_000,
          signal,
          session,
          maxOutputBytes: 64 * 1024,
          waitForEnrolment: false,
        });
        if (result.exitCode === RECORD_STOP_EXITS.none) {
          return { content: [{ type: "text", text: `Box ${found.name} has no recording.${next(`Call box_record with box "${found.name}" and action "start" to begin one.`)}` }], isError: true };
        }
        const made = result.exitCode === 0 ? parseRecordResult(result.stdout) : null;
        if (!made) throw new BoxError("unreachable", `Making the clip in box ${found.name} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const name = `recordings/${found.name}-${stamp}`;
        const html = recordPage(`Box ${found.name}`, pathsOf(storage.path).basename(`${name}.mp4`));
        // The clip and its page in a storage folder: the page loads the clip beside it, so a clip of any size plays.
        const put = async (folder: { hostId: string; path: string }) => {
          const paths = pathsOf(folder.path);
          const file = (path: string): ThreadFile => ({ hostId: folder.hostId, path: paths.join(folder.path, path), rootPath: folder.path, stored: true });
          await fromBox(owner, found.id, `${RECORD_DIR}/clip.mp4`, file(`${name}.mp4`), signal);
          const page = file(`${name}.html`);
          await bb.sdk.files.write({ hostId: page.hostId, path: page.path, rootPath: page.rootPath, content: Buffer.from(html).toString("base64"), contentEncoding: "base64", createParents: true });
        };
        await put(storage);
        // A thread's line resolves in the storage folder of the thread it is in: a parent that passes on its child's
        // report shows the clip only with a copy in its own (the owner's note of 19 October 2026).
        const parents = await app.ancestorStorages(id, RECORD_PARENTS, signal).catch(() => []);
        let copied = 0;
        for (const parent of parents) {
          try {
            await put(parent);
            copied += 1;
          } catch {
            // The line still shows the clip in this thread.
          }
        }
        const cut = stills === "keep" ? 0 : Math.max(0, made.recorded - made.clip * times);
        const parts = [
          `a ${made.clip.toFixed(1)} s clip of ${made.recorded.toFixed(1)} s recorded`,
          ...(cut >= 0.5 ? [`${cut.toFixed(1)} s of still stretches cut`] : []),
          ...(times > 1 ? [`played ${times}x`] : []),
          `${made.size}, ${Math.max(1, Math.round(made.bytes / 1024))} KB`,
        ];
        const limit = made.ended === "limit" ? ` It reached the ${RECORD_LIMIT_S / 60}-minute limit and ended by itself.` : "";
        const where = `The MP4 is in this thread's storage folder: $BB_THREAD_STORAGE/${name}.mp4${copied ? `, and in the storage folder of its parent thread${copied === 1 ? "" : `s, ${copied} of them`}` : ""}.`;
        const directive = `::inline-vis{source="thread-storage" file="${name}.html" height="${previewHeight(made.size)}"}`;
        const shows = copied ? "this thread and in its parent threads, which have a copy, so a parent can pass the line on" : "this thread only";
        return `Recorded box ${found.name}: ${parts.join(", ")}.${limit} ${where}${next(`To show it in the thread, put this line on its own in your reply, outside any code block. It shows the clip in ${shows}:\n${directive}`)}`;
      } catch (error) {
        return failure(error, "Recording the desktop");
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
      "A box of the build then runs the check again and the kind's own check. It returns each check's result, the time and the build's last 200 lines, and removes the boxes and the build, unless keep is true, when a box of it stays for you to look inside. " +
      "Each try starts from a clean standard image, as a build does, so fix the script and try again until every check passes. It can take as long as the script, plus about a minute.",
    presentation: { label: { pending: "Trying the image's script", completed: "Tried the image's script" } },
    parameters: z.object({
      kind: z.string().min(1).describe('The Linux kind to try it on, such as "linux". box_list shows the kinds.'),
      script: z.string().min(1).describe("The script's text, run as root, as in .bb/box-setup.sh."),
      check: z.string().optional().describe("The check's text, run as the box user, as in .bb/box-check.sh: it should fail when the script did not do its work."),
      name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional().describe('The image\'s name, which the script reads as BB_BOX_IMAGE. "try" when left out.'),
      on: z.string().optional().describe("A backend's ID from box_list, such as proxmox-lxc. The first that builds the kind's images when left out."),
      keep: z.boolean().optional().describe("Keep a box of what it built, to look inside with box_run: of the build, or of the build box as a failing script left it. It is this thread's box until you release it."),
    }),
    async execute({ kind, script, check, name, on, keep }, { signal, threadId, projectId }) {
      try {
        const result = await app.imageBakes.try(
          { name: name ?? "try", kind, script, ...(check?.trim() ? { check } : {}), ...(on ? { on } : {}), ...(keep ? { keep: { threadId: thread(threadId), projectId: projectId ?? null } } : {}) },
          signal,
        );
        const look = result.kept?.box ? `Look inside box "${result.kept.box}" with box_run, and release it when you are done. ` : "";
        const hint =
          look +
          (result.ok
            ? "Commit the files, then register them with box_image_set; ask the user first unless they asked for the image."
            : result.reason
              ? "Try again; if it fails the same way, tell the user."
              : "Fix the script or the check from the lines above, then call box_image_try again.");
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
