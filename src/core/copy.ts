// A box's end of a streamed copy (#492), over its command transport. A file
// coming in is written to a part file beside the target, whose size and
// SHA-256 the box then gives, and it replaces the target only once they
// match what was sent. A file going out is hashed first, then streamed.
// Paths are as box_copy gives them: relative ones are under the box user's
// home.

import type { GuestOs } from "../transports/types.ts";
import type { CommandTransport } from "../transports/types.ts";
import { quote } from "../transports/process.ts";
import { hashFileScript, readFileScript, settlePartScript, writePartScript } from "../transports/powershell.ts";

/** A file's size and SHA-256 in lower-case hex. */
export interface FileSum {
  readonly bytes: number;
  readonly sha256: string;
}

/** Prints "<sha256> <bytes>" for the file in $t, with sha256sum or, on a Mac, shasum. */
const PRINT_SUM = `n=$(wc -c < "$t" | tr -d ' ') && h=$( { sha256sum < "$t" 2>/dev/null || shasum -a 256 < "$t"; } | cut -d' ' -f1) && printf '%s %s' "$h" "$n"`;

export function hashScript(os: GuestOs, path: string): string {
  if (os === "windows") return hashFileScript(path);
  return `t=${quote(path)}; [ -f "$t" ] || { printf '%s is not a file.\\n' "$t" >&2; exit 1; }; ${PRINT_SUM}`;
}

export function writeScript(os: GuestOs, path: string): string {
  if (os === "windows") return writePartScript(path);
  return (
    `p=${quote(path)}; t="$p.bb-box-part"; [ ! -d "$p" ] || { printf '%s is a directory.\\n' "$p" >&2; exit 1; }; ` +
    `mkdir -p -- "$(dirname -- "$p")" && cat > "$t" || exit 1; ${PRINT_SUM}`
  );
}

export function settleScript(os: GuestOs, path: string, keep: boolean): string {
  if (os === "windows") return settlePartScript(path, keep);
  return keep ? `mv -f -- ${quote(`${path}.bb-box-part`)} ${quote(path)}` : `rm -f -- ${quote(`${path}.bb-box-part`)}`;
}

export function parseSum(text: string): FileSum | null {
  const match = /([0-9a-f]{64}) (\d+)\s*$/.exec(text);
  return match ? { sha256: match[1]!, bytes: Number(match[2]) } : null;
}

/** The size and SHA-256 of `path` in the box. */
export async function boxFileSum(transport: CommandTransport, os: GuestOs, path: string, signal?: AbortSignal): Promise<FileSum> {
  const result = await transport.run(hashScript(os, path), { timeoutMs: 10 * 60_000, signal });
  const sum = result.exitCode === 0 ? parseSum(result.stdout) : null;
  if (!sum) throw new Error(`Box could not read ${path}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
  return sum;
}

/** Writes what `source` gives to `path`'s part file in the box, and returns the part's size and SHA-256 there. */
export async function writePart(transport: CommandTransport, os: GuestOs, path: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<FileSum> {
  if (!transport.spawn) throw new Error("This box's transport cannot stream a file.");
  const channel = await transport.spawn(writeScript(os, path), signal);
  try {
    const output = new Response(channel.readable).text();
    output.catch(() => undefined);
    const writer = channel.writable.getWriter();
    for await (const chunk of source) await writer.write(chunk);
    await writer.close();
    const text = await output;
    const sum = parseSum(text);
    if (!sum) throw new Error(`The box did not give the size and SHA-256 of what it wrote to ${path}: ${text.trim() || "nothing"}`);
    return sum;
  } finally {
    await channel.close().catch(() => undefined);
  }
}

/** Puts `path`'s part file in its place, or removes it when not `keep`. */
export async function settlePart(transport: CommandTransport, os: GuestOs, path: string, keep: boolean, signal?: AbortSignal): Promise<void> {
  const result = await transport.run(settleScript(os, path, keep), { timeoutMs: 60_000, signal });
  if (result.exitCode !== 0 && keep) throw new Error(`The box could not put ${path} in its place: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

/** Streams `path` from the box to `sink`, which must take all of it. */
export async function readStream(transport: CommandTransport, os: GuestOs, path: string, sink: (data: ReadableStream<Uint8Array>) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!transport.spawn) throw new Error("This box's transport cannot stream a file.");
  const channel = await transport.spawn(os === "windows" ? readFileScript(path) : `cat -- ${quote(path)}`, signal);
  try {
    await channel.writable.close().catch(() => undefined);
    await sink(channel.readable);
  } finally {
    await channel.close().catch(() => undefined);
  }
}
