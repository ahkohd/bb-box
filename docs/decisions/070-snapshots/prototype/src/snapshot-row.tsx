import { useEffect, useId, useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Badge, IconButton, StatusDot } from "@/src/app/common.tsx";
import { BY_PERSON, DAY, type FakeBox, type FakeSnap } from "./data";
import { go } from "./nav";
import { forkName, useStore } from "./store";
import { byWords, clockOf, day, holdsWords, lifeOf, priceWords, sizeWords, span, when } from "./words";
import { Thumbnail } from "./picture";

export function Checkbox({ checked, onChange, label, disabled, describedBy }: { checked: boolean; onChange: (on: boolean) => void; label: ReactNode; disabled?: boolean; describedBy?: string }) {
  const id = useId();
  return (
    <span className="flex items-start gap-2">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-describedby={describedBy} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-[var(--primary)] disabled:cursor-not-allowed" />
      <label htmlFor={id} className={cn("text-sm text-foreground", disabled && "text-muted-foreground")}>
        {label}
      </label>
    </span>
  );
}

function Line({ items }: { items: readonly (ReactNode | null | false)[] }) {
  const shown = items.filter(Boolean);
  return (
    <>
      {shown.map((item, index) => (
        <span key={index}>
          {index ? <span aria-hidden className="text-subtle-foreground">{" · "}</span> : null}
          {item}
        </span>
      ))}
    </>
  );
}

export function snapLine(snap: FakeSnap, now: number, byThread: boolean, threads: Parameters<typeof byWords>[1]): ReactNode {
  const life = lifeOf(snap, now);
  return (
    <Line
      items={[
        when(snap.takenAt, now),
        byWords(snap.by, threads, byThread),
        holdsWords(snap.holds),
        sizeWords(snap.sizeGB),
        priceWords(snap.price),
        <span key="life" className={cn(life.warn && "text-warning-text")}>
          {life.words}
        </span>,
      ]}
    />
  );
}

export function SnapshotRow({ snap, box, byThread, selecting, selected, onSelected }: { snap: FakeSnap; box: FakeBox; byThread: boolean; selecting?: boolean; selected?: boolean; onSelected?: (on: boolean) => void }) {
  const store = useStore();
  const { now } = store;
  const [asking, setAsking] = useState<null | "restore" | "fork" | "delete" | "rename" | "note" | "keep">(null);
  const released = box.state === "released";
  const settled = snap.state === "ready";
  const busy = box.state === "restoring" || box.state === "starting";
  const kept = snap.keptUntil !== null;
  return (
    <div data-snapshot-row={snap.id} className={cn("group flex min-w-0 items-start gap-3 py-3", snap.state === "deleting" && "opacity-50")}>
      {selecting ? (
        <span className="flex h-10 items-center">
          <input type="checkbox" aria-label={`Select ${snap.name}`} checked={!!selected} disabled={!settled} onChange={(event) => onSelected?.(event.target.checked)} className="size-3.5 cursor-pointer accent-[var(--primary)]" />
        </span>
      ) : null}
      <Thumbnail snap={snap} box={box} now={now} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="min-w-0 truncate text-sm text-foreground">{snap.name}</span>
          {snap.holds === "disk-and-memory" ? <Badge>Memory</Badge> : null}
          {kept ? <Badge>Kept</Badge> : null}
          {snap.undoOf ? <Badge>Undo</Badge> : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
          {snap.state === "taking" ? (
            <>
              <StatusDot tone="busy" />
              <span>Taking… · {byWords(snap.by, store.threads, byThread)}</span>
            </>
          ) : snap.state === "deleting" ? (
            <>
              <StatusDot tone="busy" />
              <span>Deleting…</span>
            </>
          ) : snap.state === "failed" ? (
            <>
              <StatusDot tone="bad" />
              <span>
                <span className="text-destructive-text">Failed</span> · {when(snap.takenAt, now)} · {byWords(snap.by, store.threads, byThread)}
              </span>
            </>
          ) : (
            <span className="line-clamp-2 min-w-0">{snapLine(snap, now, byThread, store.threads)}</span>
          )}
        </div>
        {snap.state === "failed" && snap.error ? <p className="mt-0.5 text-xs leading-snug text-destructive-text">{snap.error} It is removed after 24 hours.</p> : null}
        {snap.undoOf && settled ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">The undo of the restore to "{snap.undoOf.to}" at {clockOf(snap.undoOf.at)}.</p> : null}
        {snap.note ? <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-subtle-foreground">{snap.note}</p> : null}
      </div>
      <span className="flex shrink-0 items-center gap-0.5 self-center">
        {!released ? <IconButton label={`Restore ${box.name} to ${snap.name}`} icon="ArrowTurnBackward" disabled={!settled || busy} onClick={() => setAsking("restore")} /> : null}
        <span className="max-sm:hidden">
          <IconButton label={`Fork ${snap.name} into a new box`} icon="GitFork" disabled={!settled || box.snapshotting?.fork === "none"} onClick={() => setAsking("fork")} />
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`${snap.name} actions`}>
              <Icon name="MoreHorizontal" className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-48 max-w-72">
            <DropdownMenuItem className="sm:hidden" disabled={!settled} onSelect={() => setAsking("fork")}>
              <Icon name="GitFork" aria-hidden />
              Fork…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={snap.state === "failed"} onSelect={() => setAsking("rename")}>
              <Icon name="Pencil" aria-hidden />
              Rename…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={snap.state === "failed"} onSelect={() => setAsking("note")}>
              <Icon name="Pencil" aria-hidden />
              {snap.note ? "Edit note…" : "Add a note…"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!settled} onSelect={() => store.keep([snap.id], Math.max(snap.keptUntil ?? now, now) + store.settings.keepDays * DAY)}>
              <Icon name="Calendar" aria-hidden />
              {kept ? `Keep ${store.settings.keepDays} more days` : `Keep ${store.settings.keepDays} days`}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!settled} onSelect={() => setAsking("keep")}>
              <Icon name="Calendar" aria-hidden />
              Keep until…
            </DropdownMenuItem>
            {kept && !released ? (
              <DropdownMenuItem onSelect={() => store.keep([snap.id], null)}>
                <Icon name="X" aria-hidden />
                Stop keeping
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => store.say(`Copied ${snap.id}`)}>
              <Icon name="Copy" aria-hidden />
              Copy ID
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={snap.state === "taking" || snap.state === "deleting"} onSelect={() => setAsking("delete")}>
              <Icon name="Trash2" aria-hidden />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {asking === "restore" ? <RestoreDialog box={box} snap={snap} onClose={() => setAsking(null)} /> : null}
      {asking === "fork" ? <ForkDialog box={box} snap={snap} onClose={() => setAsking(null)} /> : null}
      {asking === "delete" ? <DeleteDialog boxes={[box]} snaps={[snap]} onClose={() => setAsking(null)} /> : null}
      {asking === "rename" ? <TextDialog title={`Rename "${snap.name}"`} label="Name" value={snap.name} onSave={(value) => store.rename(snap.id, value)} onClose={() => setAsking(null)} /> : null}
      {asking === "note" ? <TextDialog title={`A note on "${snap.name}"`} label="Note" value={snap.note ?? ""} long onSave={(value) => store.annotate(snap.id, value)} onClose={() => setAsking(null)} /> : null}
      {asking === "keep" ? <KeepUntilDialog snap={snap} onClose={() => setAsking(null)} /> : null}
    </div>
  );
}

function Shell({ title, children, footer, onClose }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void }) {
  return (
    <AlertDialog open onOpenChange={(open) => (open ? null : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
        <AlertDialogFooter>{footer}</AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RestoreDialog({ box, snap, onClose }: { box: FakeBox; snap: FakeSnap; onClose: () => void }) {
  const store = useStore();
  const { now } = store;
  const undoBlocked = store.whyNotTake(box.id, BY_PERSON, false);
  const [undo, setUndo] = useState(!undoBlocked);
  const [refused, setRefused] = useState<string | null>(null);
  const thread = box.threadId ? store.threads.find((each) => each.id === box.threadId) : null;
  const held = store.snaps.filter((each) => each.boxId === box.id && each.state !== "failed").length;
  const noteId = useId();
  const go = () => {
    const outcome = store.restore(box.id, snap.id, undo, BY_PERSON);
    if (!outcome.ok) setRefused(outcome.why);
    else onClose();
  };
  return (
    <Shell
      title={`Restore ${box.name} to "${snap.name}"?`}
      onClose={onClose}
      footer={
        <>
          <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          <Button type="button" variant={undo ? "default" : "destructive"} onClick={go}>
            {undo ? `Restore ${box.name}` : "Restore without undo"}
          </Button>
        </>
      }
    >
      <AlertDialogDescription asChild>
        <div className="space-y-3">
          <p>
            It goes back to {when(snap.takenAt, now).replace(/^Today/, "today at").replace(/^Yesterday/, "yesterday at")}, {span(now - snap.takenAt)} ago. What changed since then goes: files, installed apps and settings.{" "}
            {snap.holds === "disk-and-memory" ? `${box.name} comes back running, as it was then.` : `${box.name} restarts, so every process in it ends.`}
          </p>
          {thread?.running ? (
            <p className="rounded-md border border-surface-warning-border bg-surface-warning px-3 py-2 text-foreground">
              {thread.title} is working on {box.name} now. Its commands in the box end.
            </p>
          ) : null}
        </div>
      </AlertDialogDescription>
      <div className="space-y-1">
        <Checkbox checked={undo} disabled={!!undoBlocked} onChange={setUndo} describedBy={noteId} label={<>Take a snapshot first, "before restoring to {clockOf(snap.takenAt)}", so you can undo this.</>} />
        <p id={noteId} className={cn("pl-5.5 text-xs", undoBlocked ? "text-warning-text" : "text-subtle-foreground")}>
          {undoBlocked ? `No undo can be taken: ${undoBlocked}` : `${held + (undo ? 1 : 0)} of ${store.settings.perBox} for ${box.name} after this.`}
        </p>
      </div>
      {refused ? (
        <p role="alert" className="text-xs text-destructive-text">
          {refused}
        </p>
      ) : null}
    </Shell>
  );
}

export function ForkDialog({ box, snap, onClose }: { box: FakeBox; snap: FakeSnap; onClose: () => void }) {
  const store = useStore();
  const released = box.state === "released";
  const [name, setName] = useState(() => forkName(store.boxes.map((each) => each.name)));
  const [into, setInto] = useState<"thread" | "machine">(released || !box.threadId ? "machine" : "thread");
  const [refused, setRefused] = useState<string | null>(null);
  const thread = box.threadId ? store.threads.find((each) => each.id === box.threadId) : null;
  const fork = () => {
    const outcome = store.fork(snap.id, into, name.trim() || "new-box");
    if (!outcome.ok) return setRefused(outcome.why);
    onClose();
    go({ page: "box", id: outcome.id });
  };
  const copyWords = box.snapshotting?.forkWords ?? "A copy";
  const space = snap.sizeGB !== null ? `, and about ${Math.round((snap.sizeGB + 9) * 10) / 10} GB on ${box.host}` : "";
  return (
    <Shell
      title={`Fork "${snap.name}" into a new box`}
      onClose={onClose}
      footer={
        <>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button type="button" onClick={fork}>
            Fork
          </Button>
        </>
      }
    >
      <AlertDialogDescription>
        A new box with {box.name}'s files as they were {when(snap.takenAt, store.now).toLowerCase()}. It gets its own BB machine, address and keys, and never acts as {box.name}. It starts fresh: no apps are running.
      </AlertDialogDescription>
      <label className="block space-y-1">
        <span className="text-xs text-foreground">Name</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} className="h-8" autoFocus />
      </label>
      <fieldset className="space-y-1.5">
        <legend className="text-xs text-foreground">Where it goes</legend>
        {thread && !released ? (
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="radio" name="fork-into" checked={into === "thread"} onChange={() => setInto("thread")} className="mt-1 accent-[var(--primary)]" />
            <span>
              In {thread.title}
              <span className="block text-xs text-subtle-foreground">Its agent can use it. It goes when the thread ends.</span>
            </span>
          </label>
        ) : null}
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="radio" name="fork-into" checked={into === "machine"} onChange={() => setInto("machine")} className="mt-1 accent-[var(--primary)]" />
          <span>
            As a machine of yours
            <span className="block text-xs text-subtle-foreground">It shows in BB's machine list, with your access, until you remove it.</span>
          </span>
        </label>
      </fieldset>
      <p className="text-xs text-subtle-foreground">
        {box.sizeWords}, as {box.name}. {copyWords}
        {space}.
      </p>
      {refused ? (
        <p role="alert" className="text-xs text-destructive-text">
          The fork could not start: {refused}
        </p>
      ) : null}
    </Shell>
  );
}

export function freesWords(snaps: readonly FakeSnap[], boxes: readonly FakeBox[]): string {
  const known = snaps.filter((snap) => snap.sizeGB !== null);
  const paid = snaps.filter((snap) => snap.price);
  const parts: string[] = [];
  if (known.length) {
    const hosts = new Set(known.map((snap) => boxes.find((box) => box.id === snap.boxId)?.host));
    const total = known.reduce((sum, snap) => sum + (snap.sizeGB ?? 0), 0);
    parts.push(`Frees ${sizeWords(total)} on ${[...hosts].join(" and ")}`);
  }
  if (paid.length) parts.push(`stops ${paid.length === 1 ? "its charge" : "their charges"} of ${priceWords(paid[0]!.price)}${paid.length > 1 ? " each" : ""}`);
  return parts.length ? `${parts.join(", and ")}.` : "";
}

export function DeleteDialog({ boxes, snaps, onClose, onDone }: { boxes: readonly FakeBox[]; snaps: readonly FakeSnap[]; onClose: () => void; onDone?: () => void }) {
  const store = useStore();
  const one = snaps.length === 1 ? snaps[0]! : null;
  const kept = snaps.filter((snap) => snap.keptUntil !== null);
  return (
    <Shell
      title={one ? `Delete "${one.name}"?` : `Delete ${snaps.length} snapshots?`}
      onClose={onClose}
      footer={
        <>
          <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              store.remove(snaps.map((snap) => snap.id), BY_PERSON);
              onDone?.();
            }}
          >
            Delete
          </AlertDialogAction>
        </>
      }
    >
      <AlertDialogDescription asChild>
        <div className="space-y-2">
          <p>{freesWords(snaps, boxes) || "Its provider does not say how much it frees."} It cannot be undone.</p>
          {kept.length ? <p>{one ? `You kept it until ${day(one.keptUntil!)}.` : `${kept.length} of them you kept.`}</p> : null}
          {one?.undoOf ? <p>It is the undo of the restore to "{one.undoOf.to}" at {clockOf(one.undoOf.at)}.</p> : null}
        </div>
      </AlertDialogDescription>
    </Shell>
  );
}

function TextDialog({ title, label, value, long, onSave, onClose }: { title: string; label: string; value: string; long?: boolean; onSave: (value: string) => void; onClose: () => void }) {
  const [text, setText] = useState(value);
  return (
    <Shell
      title={title}
      onClose={onClose}
      footer={
        <>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!long && !text.trim()} onClick={() => onSave(text.slice(0, long ? 1024 : 60))}>
            Save
          </AlertDialogAction>
        </>
      }
    >
      <label className="block space-y-1">
        <span className="text-xs text-foreground">{label}</span>
        {long ? <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} autoFocus /> : <Input value={text} maxLength={60} onChange={(event) => setText(event.target.value)} className="h-8" autoFocus />}
      </label>
    </Shell>
  );
}

function isoDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function KeepUntilDialog({ snap, onClose }: { snap: FakeSnap; onClose: () => void }) {
  const store = useStore();
  const [until, setUntil] = useState(() => isoDay((snap.keptUntil ?? store.now) + store.settings.keepDays * DAY));
  const at = new Date(`${until}T23:59:00`).getTime();
  const valid = Number.isFinite(at) && at > store.now;
  return (
    <Shell
      title={`Keep "${snap.name}" until…`}
      onClose={onClose}
      footer={
        <>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!valid} onClick={() => store.keep([snap.id], at)}>
            Keep
          </AlertDialogAction>
        </>
      }
    >
      <AlertDialogDescription>A kept snapshot stays after its box is released, and bb-box deletes it at the end of that day. It warns you 3 days before.</AlertDialogDescription>
      <label className="block space-y-1">
        <span className="text-xs text-foreground">Until</span>
        <Input type="date" value={until} min={isoDay(store.now + DAY)} onChange={(event) => setUntil(event.target.value)} className="h-8 w-44" autoFocus />
      </label>
      {snap.price && valid ? <p className="text-xs text-subtle-foreground">At {priceWords(snap.price)}, about ${(((at - store.now) / DAY) * snap.price.amount).toFixed(2)} until then.</p> : null}
    </Shell>
  );
}

export function useUndoDialog(): ReactNode {
  const store = useStore();
  const snap = store.undoOpen ? store.snaps.find((each) => each.id === store.undoOpen) : null;
  const box = snap ? store.boxes.find((each) => each.id === snap.boxId) : null;
  useEffect(() => {
    if (store.undoOpen && !snap) store.askUndo(null);
  }, [store, snap]);
  return snap && box ? <RestoreDialog box={box} snap={snap} onClose={() => store.askUndo(null)} /> : null;
}
