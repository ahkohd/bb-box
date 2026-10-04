// The files for every box (#455): each a path under the box user's home and
// its content, which is a secret. The page shows whether each content is
// set, and takes a new one or removes the file, but never shows a content.

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
    <Section
      title="Files for every box"
      description="bb-box writes each into the home of every Linux and macOS box as it joins BB, and into running boxes when you change them, readable by the box user only: for example pi's .pi/agent/models.json. A content can hold an API key, so it is kept as a secret and never shown again."
    >
      <div className="flex flex-col gap-2">
        {files.map((file, index) => (
          <div key={file.path} className="flex items-center justify-between gap-3">
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
          <div className="flex flex-col gap-1.5">
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
        ) : (
          <div>
            <Button type="button" variant="outline" size="sm" className="h-8" disabled={busy} onClick={() => setEditing({ index: null, path: "", content: "" })}>
              Add a file
            </Button>
          </div>
        )}
        {problems.map((problem) => (
          <p key={problem.path} role="alert" className="text-xs text-destructive-text">
            {problem.message}
          </p>
        ))}
      </div>
    </Section>
  );
}
