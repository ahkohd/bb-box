// A file copy's end on the thread's machine, in bb-box's host entry (#492).
// BB's file API moves a file whole and refuses one over 25 MB, so box_copy
// streams a larger one through here instead. "file" opens a WebSocket out to
// bb-box's route, as the Docker relay does (042), and on the one channel
// bb-box opens sends the file, or writes what comes to a part file that it
// renames once all of it is there. The call answers with the bytes and
// their SHA-256, which bb-box compares with the box's.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import type { Channel, Mux } from "../relay/mux.ts";
import { dial, type RelayWebSocket } from "./relay.ts";

export interface FileOptions {
  /** Opens the WebSocket to `url`. The global WebSocket by default. */
  readonly connect?: (url: string) => RelayWebSocket;
  readonly pingMs?: number;
  readonly deadMs?: number;
}

export interface FileRequest {
  readonly secret: string;
  readonly path: string;
  /** The file, by its absolute path on this machine. */
  readonly file: string;
  /** The folder it must be within, as for BB's file API. */
  readonly root?: string;
  /** send: this machine's file goes to bb-box; receive: what bb-box sends becomes the file. */
  readonly direction: "send" | "receive";
  /** What a received file must be, from the box, before it replaces `file`. */
  readonly expect?: FileDone;
}

/** What went through: its size and SHA-256 in hex. */
export interface FileDone {
  readonly bytes: number;
  readonly sha256: string;
}

/** A stream that passes its bytes on and counts and hashes them. */
function tally(): { tap: Transform; done(): FileDone } {
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return { tap, done: () => ({ bytes, sha256: hash.digest("hex") }) };
}

async function send(file: string, channel: Channel): Promise<FileDone> {
  const found = await stat(file);
  if (!found.isFile()) throw new Error(`${file} is not a file.`);
  const { tap, done } = tally();
  await pipeline(createReadStream(file), tap, channel);
  return done();
}

async function receive(file: string, channel: Channel, expect: FileDone | undefined): Promise<FileDone> {
  if ((await stat(file).catch(() => null))?.isDirectory()) throw new Error(`${file} is a directory.`);
  await mkdir(dirname(file), { recursive: true });
  const part = `${file}.bb-box-part`;
  const { tap, done } = tally();
  try {
    await pipeline(channel, tap, createWriteStream(part));
    const got = done();
    if (expect && (got.bytes !== expect.bytes || got.sha256 !== expect.sha256)) {
      throw new Error(`What came was ${got.bytes} bytes with SHA-256 ${got.sha256}, not the box's ${expect.bytes} bytes with ${expect.sha256}: the file may have changed in the box while it was copied.`);
    }
    await rename(part, file);
    return got;
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

export function fileHandlers(options: FileOptions = {}) {
  const muxes = new Set<Mux>();
  return {
    handlers: {
      file: async ({ secret, path, file, root, direction, expect }: FileRequest, context: ExperimentalHostRpcContext): Promise<FileDone> => {
        const full = resolve(file);
        if (!isAbsolute(file)) throw new Error(`${file} is not an absolute path.`);
        if (root !== undefined) {
          const inside = relative(resolve(root), full);
          if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${file} is not within ${root}.`);
        }
        const lease = context.experimental_retainWorker();
        return new Promise<FileDone>((settle, fail) => {
          let mux!: Mux;
          // bb-box closes the link once it has read what was sent, or written all it had; the lease goes with it.
          try {
            mux = dial(path, secret, options.connect, {
              pingMs: options.pingMs,
              deadMs: options.deadMs,
              onOpen: (channel) => {
                // bb-box closing the link resets the channel once the copy is done with it.
                channel.on("error", () => undefined);
                (direction === "send" ? send(full, channel) : receive(full, channel, expect)).then(settle, (error: unknown) => {
                  channel.destroy(error instanceof Error ? error : new Error(String(error)));
                  fail(error);
                });
              },
              onClose: (reason) => {
                muxes.delete(mux);
                void lease.dispose();
                fail(new Error(`The link to bb-box closed before the copy ended: ${reason}.`));
              },
            });
          } catch (error) {
            void lease.dispose();
            fail(error);
            return;
          }
          muxes.add(mux);
        });
      },
    },
    async dispose() {
      for (const mux of muxes) mux.close("the worker stopped");
    },
  };
}
