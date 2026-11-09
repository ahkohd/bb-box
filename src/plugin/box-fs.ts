import { readTree, type FilesTree } from "../core/files-tree.ts";
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
  if (context?.experimental_caller?.kind === "client") return null;
  return { error: FILES_FROM_PANEL };
}

function warmLater(boxes: Boxes, box: BoxRecord, root: string): void {
  const key = `${box.id}\0${root}`;
  if (warming.has(key)) return;
  warming.add(key);
  const corpus = corpora.of(box.id);
  void warmDirectory(asFs(box), root, runOf(boxes, box), corpus).finally(() => warming.delete(key));
}

export function filesHandlers(boxes: Boxes) {
  const trees = new Map<string, { value: FilesTree; bytes: number }>();
  let treeBytes = 0;
  const remember = (key: string, value: FilesTree) => {
    if (value.error !== null) return;
    const old = trees.get(key);
    treeBytes -= old?.bytes ?? 0;
    trees.delete(key);
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (bytes > 8 * 1024 * 1024) return;
    trees.set(key, { value, bytes });
    treeBytes += bytes;
    while (treeBytes > 8 * 1024 * 1024) {
      const first = trees.entries().next().value;
      if (!first) break;
      trees.delete(first[0]);
      treeBytes -= first[1].bytes;
    }
  };
  return {
    async "files.tree"({ box, path = null, hidden = false, recursive = false, refresh = false }: { box: string; path?: string | null; hidden?: boolean; recursive?: boolean; refresh?: boolean }, context?: FilesCall) {
      const blocked = panelOnly(context);
      if (blocked) return blocked;
      try {
        const found = await listedBox(boxes, box);
        const key = JSON.stringify([box, path, hidden, recursive]);
        const cached = trees.get(key);
        if (cached && !refresh && found.state === "ready" && found.capabilities.command !== null) {
          trees.delete(key);
          trees.set(key, cached);
          return cached.value.error === null ? { ...cached.value, cached: true } : cached.value;
        }
        const value = await readTree(asFs(found), path, recursive, hidden, runOf(boxes, found));
        remember(key, value);
        return value;
      } catch (error) { return failed(error); }
    },
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
        if (wrote.error === null && wrote.outcome === "written") { corpora.drop(found.id); trees.clear(); treeBytes = 0; }
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
        if (made.error === null) { corpora.drop(found.id); trees.clear(); treeBytes = 0; }
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
        if (moved.error === null) { corpora.drop(found.id); trees.clear(); treeBytes = 0; }
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
        if (removed.error === null) { corpora.drop(found.id); trees.clear(); treeBytes = 0; }
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
