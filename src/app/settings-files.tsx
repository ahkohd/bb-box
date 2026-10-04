// The files for every box (#455): each a path under the box user's home and
// its content, which is a secret. The page shows whether each content is
// set, and takes a new one or removes the file, but never shows a content.

import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import type { BoxFileSetting } from "../core/box-files.ts";
import type { Problem } from "../core/document.ts";
import { Section } from "./settings-fields.tsx";

function isSet(file: BoxFileSetting): boolean {
  return typeof file.content === "object" && file.content !== null && file.content.set;
}

export function BoxFilesSection({ files, problems, save }: { files: readonly BoxFileSetting[]; problems: readonly Problem[]; save: (files: BoxFileSetting[]) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  /** The file being added (index null) or given a new content. */
  const [editing, setEditing] = useState<{ index: number | null; path: string; content: string } | null>(null);
  // A file without a content in the draft keeps the one stored.
  const kept: BoxFileSetting[] = files.map(({ path }) => ({ path }));
  const commit = async (next: BoxFileSetting[]) => {
    setBusy(true);
    try {
      if (await save(next)) setEditing(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    // One line (the operator, 4 October 2026: "Can this be shortened?"); the details are in the docs. Add file sits in the
    // header as Machines' Add machine does, and the card shows only with something in it: no empty box with a lone button.
    <Section
      title="Files for every box"
      description="Copied into each Linux and macOS box's home. Contents are kept secret."
      action={
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy || editing !== null} onClick={() => setEditing({ index: null, path: "", content: "" })}>
          <Icon name="Plus" aria-hidden />
          Add file
        </Button>
      }
      plain={!files.length && !editing && !problems.length}
    >
      <>
        {files.map((file, index) => (
          <div key={file.path} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <code className="min-w-0 truncate text-xs text-foreground">{file.path}</code>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-xs text-subtle-foreground">{isSet(file) ? "Set" : "Not set"}</span>
              <Button type="button" variant="outline" size="sm" className="h-8" disabled={busy} onClick={() => setEditing({ index, path: file.path, content: "" })}>
                Replace
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-8" disabled={busy} onClick={() => void commit(kept.filter((_, at) => at !== index))}>
                Remove
              </Button>
            </div>
          </div>
        ))}
        {editing ? (
          <div className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
            <Input
              aria-label="Path under the box user's home"
              className="h-8 font-mono text-xs"
              placeholder=".pi/agent/models.json"
              value={editing.path}
              disabled={editing.index !== null}
              onChange={(event) => setEditing({ ...editing, path: event.target.value })}
            />
            <Textarea
              aria-label="The file's content"
              className="min-h-32 font-mono text-xs"
              placeholder="Paste the file's text"
              autoComplete="off"
              spellCheck={false}
              value={editing.content}
              onChange={(event) => setEditing({ ...editing, content: event.target.value })}
            />
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={busy || !editing.path.trim() || !editing.content}
                onClick={() =>
                  void commit(
                    editing.index === null
                      ? [...kept, { path: editing.path.trim(), content: editing.content }]
                      : kept.map((file, at) => (at === editing.index ? { path: file.path, content: editing.content } : file)),
                  )
                }
              >
                Save
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-8" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {problems.map((problem) => (
          <p key={problem.path} role="alert" className="py-2 text-xs text-destructive-text first:pt-0 last:pb-0">
            {problem.message}
          </p>
        ))}
      </>
    </Section>
  );
}
