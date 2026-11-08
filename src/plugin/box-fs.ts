import { deviceDisplayOf } from "../backends/types.ts";
import { BoxError, OPERATOR, describeError, ownedByThread, type BoxRecord, type Boxes } from "../core/boxes.ts";
import {
  CorpusStore,
  createPath,
  deletePath,
  listDirectory,
  listNames,
  readFileAt,
  readFileRange,
  readHome,
  renamePath,
  searchDirectory,
  warmDirectory,
  writeFileAt,
  type FsBox,
  type FsRun,
  type SearchFlags,
} from "../core/box-fs.ts";

const corpora = new CorpusStore();
const warming = new Set<string>();

function asFs(box: BoxRecord): FsBox {
  return {
    id: box.id,
    os: box.capabilities.os,
    state: box.state,
    command: box.capabilities.command !== null,
    device: box.device != null || deviceDisplayOf(box.capabilities.displays) !== null,
  };
}

async function listedBox(boxes: Boxes, id: string): Promise<BoxRecord> {
  const found = await boxes.find(id);
  if (!found || !(ownedByThread(found.threadId) || found.threadId === OPERATOR)) throw new BoxError("not_found", "That box is gone.");
  return found;
}

function runOf(boxes: Boxes, box: BoxRecord): FsRun {
  return (script, options) => boxes.runOwn(box, script, options);
}

function failed(error: unknown): { error: string } {
  return { error: describeError(error, "Reading the box's files") };
}

export const FILES_FROM_PANEL = "Open the box's files from the panel. To read or change a file, use box_run.";

interface FilesCall {
  readonly experimental_caller?: { readonly kind: string };
}

function panelOnly(context?: FilesCall): { error: string } | null {
  if (context?.experimental_caller?.kind === "plugin") return { error: FILES_FROM_PANEL };
  return null;
}

function warmLater(boxes: Boxes, box: BoxRecord, root: string): void {
  const key = `${box.id}\0${root}`;
  if (warming.has(key)) return;
  warming.add(key);
  const corpus = corpora.of(box.id);
  void warmDirectory(asFs(box), root, runOf(boxes, box), corpus).finally(() => warming.delete(key));
}

export function filesHandlers(boxes: Boxes) {
  return {
    async "files.home"({ box }: { box: string }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        return await readHome(asFs(found), runOf(boxes, found));
      } catch (error) {
        return failed(error);
      }
    },
    async "files.list"({ box, path }: { box: string; path: string }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        return await listDirectory(asFs(found), path, runOf(boxes, found));
      } catch (error) {
        return failed(error);
      }
    },
    async "files.read"({ box, path }: { box: string; path: string }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        return await readFileAt(asFs(found), path, runOf(boxes, found));
      } catch (error) {
        return failed(error);
      }
    },
    async "files.readRange"({ box, path, start, length }: { box: string; path: string; start: number; length: number }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        return await readFileRange(asFs(found), path, start, length, runOf(boxes, found));
      } catch (error) {
        return failed(error);
      }
    },
    async "files.write"({ box, path, content, expectedSha256 }: { box: string; path: string; content: string; expectedSha256: string | null }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        const wrote = await writeFileAt(asFs(found), path, content, expectedSha256, runOf(boxes, found));
        if (wrote.error === null && wrote.outcome === "written") corpora.drop(found.id);
        return wrote;
      } catch (error) {
        return failed(error);
      }
    },
    async "files.create"({ box, path, kind }: { box: string; path: string; kind: "file" | "directory" }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        const made = await createPath(asFs(found), path, kind, runOf(boxes, found));
        if (made.error === null) corpora.drop(found.id);
        return made;
      } catch (error) {
        return failed(error);
      }
    },
    async "files.rename"({ box, from, to }: { box: string; from: string; to: string }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        const moved = await renamePath(asFs(found), from, to, runOf(boxes, found));
        if (moved.error === null) corpora.drop(found.id);
        return moved;
      } catch (error) {
        return failed(error);
      }
    },
    async "files.delete"({ box, path, home }: { box: string; path: string; home: string }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        const removed = await deletePath(asFs(found), path, home, runOf(boxes, found));
        if (removed.error === null) corpora.drop(found.id);
        return removed;
      } catch (error) {
        return failed(error);
      }
    },
    async "files.search"(
      { box, path, query, matchCase, wholeWord, regex, hidden }: { box: string; path: string; query: string; matchCase: boolean; wholeWord: boolean; regex: boolean; hidden: boolean },
      context?: FilesCall,
    ) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        const flags: SearchFlags = { matchCase, wholeWord, regex, hidden };
        return await searchDirectory(asFs(found), path, query, flags, runOf(boxes, found), corpora.of(found.id), (root) => warmLater(boxes, found, root));
      } catch (error) {
        return failed(error);
      }
    },
    async "files.names"({ box, path }: { box: string; path: string }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        return await listNames(asFs(found), path, runOf(boxes, found), corpora.of(found.id));
      } catch (error) {
        return failed(error);
      }
    },
  };
}
