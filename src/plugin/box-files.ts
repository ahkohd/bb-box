// Writes the files for every box (#455, core/box-files.ts) into each Linux
// and macOS box that is running and a BB machine and has not had them as
// they are now: as it joins BB, as it starts again after missing a change,
// and when the list or a content changes. Windows boxes later. Each file is
// the box user's, mode 600, its folders made. Nothing here logs or returns a
// content: a failed write says the box and what the box said, which never
// holds the content, as it goes in on stdin.

import type { BoxRecord, Boxes } from "../core/boxes.ts";
import type { BoxFile } from "../core/box-files.ts";
import type { DoctorCheck } from "../backends/types.ts";
import { createHash } from "node:crypto";

export interface BoxFilesDeps {
  readonly boxes: Boxes;
  /** The files whose content is set, as the settings have them now. */
  files(): readonly BoxFile[];
  logError(operation: string, error: unknown): void;
  readonly now?: () => number;
}

/** The last write, for the doctor. */
interface LastWrite {
  readonly at: number;
  readonly box: string;
  readonly files: number;
  readonly error: string | null;
}

export class BoxFiles {
  readonly #deps: BoxFilesDeps;
  #last: LastWrite | null = null;
  /** A digest of the files as the settings have them, to tell a change; never shown. */
  #digest: string;
  /** Each running box's digest of the files last written into it, or on their way; forgotten as it stops or goes. */
  readonly #had = new Map<string, string>();
  /** Each box's writes, one after another, so that the last to land has the latest files. */
  readonly #queues = new Map<string, Promise<void>>();

  constructor(deps: BoxFilesDeps) {
    this.#deps = deps;
    this.#digest = digest(deps.files());
  }

  /**
   * Takes the boxes running as bb-box starts as having the files: they had
   * them when it stopped, as only bb-box changes them. One that is stopped
   * gets them when it runs again.
   */
  async started(): Promise<void> {
    for (const box of await this.#deps.boxes.all()) {
      if (current(box) && !this.#had.has(box.id)) this.#had.set(box.id, this.#digest);
    }
  }

  /** A box's record changed: one that stopped or went is forgotten, and a running BB machine without the files as they are now gets them. */
  recorded(box: BoxRecord, deleted: boolean): void {
    if (deleted || !current(box)) {
      this.#had.delete(box.id);
      return;
    }
    if (this.#had.get(box.id) !== this.#digest) void this.write(box);
  }

  /** After the settings changed: when the files or their contents did, writes them into each running Linux and macOS box that is a BB machine. */
  async settingsChanged(): Promise<void> {
    const now = digest(this.#deps.files());
    if (now === this.#digest) return;
    this.#digest = now;
    for (const box of await this.#deps.boxes.all()) this.recorded(box, false);
  }

  /** Writes every set file into a box, after any write into it still going. */
  write(box: BoxRecord): Promise<void> {
    this.#had.set(box.id, this.#digest);
    const queued = (this.#queues.get(box.id) ?? Promise.resolve()).then(() => this.#write(box));
    this.#queues.set(box.id, queued);
    void queued.finally(() => {
      if (this.#queues.get(box.id) === queued) this.#queues.delete(box.id);
    });
    return queued;
  }

  async #write(box: BoxRecord): Promise<void> {
    // As they are when the write starts, which a change since has queued another write after.
    const files = this.#deps.files();
    if (!files.length) return;
    try {
      for (const file of files) {
        await this.#deps.boxes.writeFile(box.threadId, box.id, file.path, new TextEncoder().encode(file.content), { mode: "600" });
      }
      this.#last = { at: this.#now(), box: box.name, files: files.length, error: null };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.#last = { at: this.#now(), box: box.name, files: files.length, error: why };
      this.#deps.logError("write the files for every box", new Error(`Box ${box.name}: ${why}`));
    }
  }

  /** The doctor's word: how many files are set, and whether the last write worked. */
  checks(): DoctorCheck[] {
    const count = this.#deps.files().length;
    if (!count && !this.#last) return [];
    const files = `${count} file${count === 1 ? "" : "s"} set`;
    if (!this.#last) {
      return [{ id: "box-files", name: "Files for every box", status: "ok", detail: `${files}; none written yet. bb-box writes them into each Linux and macOS box as it joins BB.`, fix: null }];
    }
    const when = new Date(this.#last.at).toISOString().slice(0, 16).replace("T", " ");
    return this.#last.error
      ? [
          {
            id: "box-files",
            name: "Files for every box",
            status: "warn",
            detail: `${files}; the last write, into box ${this.#last.box} at ${when} UTC, failed: ${this.#last.error}`,
            fix: "Check that the box answers and that its user can write its home; bb-box writes the files again when the box next starts, and into every running box when the settings change.",
          },
        ]
      : [{ id: "box-files", name: "Files for every box", status: "ok", detail: `${files}; the last write, into box ${this.#last.box} at ${when} UTC, worked.`, fix: null }];
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}

/** Whether a box is one to have the files: running, a BB machine, and not Windows, which gets none yet. */
function current(box: BoxRecord): boolean {
  return box.state === "ready" && box.enrol.state === "enrolled" && box.capabilities.os !== "windows";
}

function digest(files: readonly BoxFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.content}\0`);
  return hash.digest("hex");
}
