import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Badge, IconButton, StatusDot } from "@/src/app/common.tsx";
import { BY_PERSON, DAY, type FakeBox, type FakeSnap, type FakeThread } from "./data";
import { go } from "./nav";
import { forkName, heldCopySeconds, undoWords, UNDOS_A_BOX, useStore } from "./store";
import { byWords, clockOf, day, holdsWords, lifeOf, priceWords, seconds, sizeWords, span, whenInSentence, when } from "./words";
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

function lifeItem(snap: FakeSnap, now: number): ReactNode {
  const life = lifeOf(snap, now);
  return (
    <span key="life" className={cn(life.warn && "text-warning-text")}>
      {life.words}
    </span>
  );
}

export function snapLine(snap: FakeSnap, box: FakeBox, now: number, byThread: boolean, threads: readonly FakeThread[]): ReactNode {
  const warn = lifeOf(snap, now).warn;
  const where = snap.heldCopyGB !== null && !snap.undoOf ? `held copy, ${sizeWords(snap.heldCopyGB)} on ${box.host}` : null;
  const released = box.state === "released";
  const holds = box.snapshotting?.scope === "device" ? "device" : released && snap.heldCopyGB !== null ? "disk" : holdsWords(snap.holds);
  return (
    <Line
      items={[
        snap.onEarlierGuest ? (
          <span key="earlier" className="text-warning-text">
            on {box.name}'s earlier guest: fork only
          </span>
        ) : null,
        warn ? lifeItem(snap, now) : null,
        when(snap.takenAt, now),
        byWords(snap.by, threads, byThread),
        holds,
        where ?? sizeWords(snap.sizeGB),
        priceWords(snap.price),
        warn ? null : lifeItem(snap, now),
      ]}
    />
  );
}

type Asking = null | "restore" | "fork" | "delete" | "rename" | "note" | "keep";

export function SnapshotRow({ snap, box, byThread, selecting, selected, onSelected }: { snap: FakeSnap; box: FakeBox; byThread: boolean; selecting?: boolean; selected?: boolean; onSelected?: (on: boolean) => void }) {
  const store = useStore();
  const { now } = store;
  const [asking, setAsking] = useState<Asking>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const released = box.state === "released";
  const settled = snap.state === "ready";
  const busy = box.state === "restoring" || box.state === "starting" || box.state === "unconfirmed";
  const kept = snap.keptUntil !== null;
  const busyWhy = busy ? `${box.name} is ${box.state === "starting" ? "starting" : "being restored"}` : null;
  const restoreOk = settled && !busy && !released && !snap.onEarlierGuest;
  const keepWhy = settled ? store.whyNotKeep(snap.id) : "it is not ready";
  const forkWhy = settled ? store.whyNotFork(snap.id) : "it is not ready";
  const deleteWhy = store.whyNotDelete(snap.id);
  const keepOk = !busy && !keepWhy;
  const forkOk = !busy && !forkWhy;
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
              <span>{snap.undoWay === "held-copy" ? "Copying…" : "Taking…"} · {byWords(snap.by, store.threads, byThread)}</span>
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
                <span className="text-destructive-text">Failed: {snap.error}</span> · {when(snap.takenAt, now)} · {byWords(snap.by, store.threads, byThread)}
              </span>
            </>
          ) : (
            <span className="line-clamp-2 min-w-0">{snapLine(snap, box, now, byThread, store.threads)}</span>
          )}
        </div>
        {snap.undoOf && settled ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">The undo of the restore to "{snap.undoOf.to}" at {clockOf(snap.undoOf.at)}{snap.undoWay === "held-copy" ? `: a held copy of ${box.name}, ${sizeWords(snap.heldCopyGB)}` : ""}.</p> : null}
        {snap.note ? <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-subtle-foreground">{snap.note}</p> : null}
      </div>
      <span className="flex shrink-0 items-center gap-0.5 self-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
        {!released ? <IconButton label={restoreOk ? `Restore ${box.name} to ${snap.name}` : `Restore: ${busyWhy ?? (snap.onEarlierGuest ? "on the earlier guest, fork only" : "not ready")}`} icon="ArrowTurnBackward" disabled={!restoreOk} onClick={() => setAsking("restore")} /> : null}
        <span className="max-sm:hidden">
          <IconButton label={forkOk ? `Fork ${snap.name} into a new box` : `Fork: ${busyWhy ?? forkWhy}`} icon="GitFork" disabled={!forkOk} onClick={() => setAsking("fork")} />
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={menuButton} type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`${snap.name} actions`}>
              <Icon name="MoreHorizontal" className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-48 max-w-72">
            <DropdownMenuItem className="sm:hidden" disabled={!forkOk} onSelect={() => setAsking("fork")}>
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
            <DropdownMenuItem disabled={!keepOk} onSelect={() => setAsking("keep")}>
              <Icon name="Calendar" aria-hidden />
              <span className="min-w-0">
                {kept ? "Keep longer…" : "Keep…"}
                {keepWhy && settled ? <span className="block max-w-60 whitespace-normal text-2xs text-subtle-foreground">{keepWhy}</span> : null}
              </span>
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
            <DropdownMenuItem variant="destructive" disabled={!!deleteWhy || busy} onSelect={() => setAsking("delete")}>
              <Icon name="Trash2" aria-hidden />
              <span className="min-w-0">
                Delete…
                {deleteWhy && snap.state === "ready" ? <span className="block text-2xs text-subtle-foreground">Not while {deleteWhy}</span> : null}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {asking === "restore" ? <RestoreDialog box={box} snap={snap} onClose={() => setAsking(null)} /> : null}
      {asking === "fork" ? <ForkDialog box={box} snap={snap} onClose={() => setAsking(null)} /> : null}
      {asking === "delete" ? <DeleteDialog boxes={[box]} snaps={[snap]} returnTo={menuButton} onClose={() => setAsking(null)} /> : null}
      {asking === "rename" ? <TextDialog title={`Rename "${snap.name}"`} label="Name" value={snap.name} returnTo={menuButton} onSave={(value) => store.rename(snap.id, value)} onClose={() => setAsking(null)} /> : null}
      {asking === "note" ? <TextDialog title={`A note on "${snap.name}"`} label="Note" value={snap.note ?? ""} long returnTo={menuButton} onSave={(value) => store.annotate(snap.id, value)} onClose={() => setAsking(null)} /> : null}
      {asking === "keep" ? <KeepDialog box={box} snaps={[snap]} returnTo={menuButton} onClose={() => setAsking(null)} /> : null}
    </div>
  );
}

export function Shell({ title, children, footer, onClose, returnTo }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !document.activeElement.closest("[role=menu]") ? document.activeElement : null);
  return (
    <AlertDialog open onOpenChange={(open) => (open ? null : onClose())}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (returnTo?.current ?? opener.current)?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="font-normal">{title}</AlertDialogTitle>
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
  const plan = store.plan(box.id, snap.id);
  const losses = store.losses(box.id, BY_PERSON);
  const [undo, setUndo] = useState(true);
  const [refused, setRefused] = useState<string | null>(null);
  const noteId = useId();
  const counted = store.counted(box.id).length;
  const undos = store.undos(box.id).length;
  const device = box.snapshotting?.scope === "device";
  const memory = snap.holds === "disk-and-memory" && !device;
  const excludes = box.snapshotting?.excludes;
  const onCurrent = store.snaps.filter((each) => each.boxId === box.id && each.state === "ready" && !each.onEarlierGuest && each.undoWay !== "held-copy").length;
  if (plan.refused) {
    return (
      <Shell title={`Restore ${box.name} to "${snap.name}"?`} onClose={onClose} footer={<AlertDialogCancel autoFocus>Close</AlertDialogCancel>}>
        <AlertDialogDescription asChild>
          <p className="rounded-md border border-surface-warning-border bg-surface-warning px-3 py-2 text-foreground">{plan.refused}</p>
        </AlertDialogDescription>
      </Shell>
    );
  }
  const go = () => {
    const outcome = store.restore(box.id, snap.id, { undo, anyway: true }, BY_PERSON);
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
            {!undo ? "Restore without undo" : losses.length ? `Restore ${box.name} anyway` : `Restore ${box.name}`}
          </Button>
        </>
      }
    >
      <AlertDialogDescription asChild>
        <div className="space-y-3">
          {device ? (
            <p>
              Its device goes back to {whenInSentence(snap.takenAt, now)}, {span(now - snap.takenAt)} ago, with the apps that were open then. Only the device: the rest of {box.name}'s disk stays as it is.
            </p>
          ) : (
            <p>
              It goes back to {whenInSentence(snap.takenAt, now)}, {span(now - snap.takenAt)} ago. Everything on its disk since then goes: files, installed apps and settings.{" "}
              {memory ? `${box.name} comes back running, as it was then, with the credentials its apps held then.` : `${box.name} restarts, so every process in it ends.`} What it did to the world since, a push or a message, stays done.
              {excludes ? ` The snapshot leaves out ${excludes}.` : ""}
            </p>
          )}
          {plan.swap ? <p>This makes a new guest from the copy, with {box.name}'s identity, so it stays the same BB machine. The {plan.leavesOnEarlierGuest} other snapshots stay on its earlier guest: they can be forked or kept, not restored.</p> : null}
          {plan.undoWay === "held-copy" && !plan.swap ? <p>Undoing this later would make a new guest from that copy; the {onCurrent} snapshots on its current guest would stay there, fork only.</p> : null}
          {losses.length ? (
            <div className="rounded-md border border-surface-warning-border bg-surface-warning px-3 py-2 text-foreground">
              <p>Also goes:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {losses.map((loss) => (
                  <li key={loss.words}>{loss.words}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {plan.sizeBack ? <p>{plan.sizeBack}</p> : null}
        </div>
      </AlertDialogDescription>
      <div className="space-y-1">
        <Checkbox checked={undo} onChange={setUndo} describedBy={noteId} label={undoWords(plan.undoWay, box, plan.undoAboutMs)} />
        <p id={noteId} className="pl-5.5 text-xs text-subtle-foreground">
          {`Named "before the restore at ${clockOf(now)}". Undos do not count against the ${store.settings.perBox} for ${box.name} (${counted} used); it keeps the last ${UNDOS_A_BOX}, now ${undos}.`}
          {memory && plan.undoWay !== "suspend-copy" ? " Undo brings back its files, not its running apps." : ""}
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
  const used = snap.heldCopyGB ?? box.usedGB;
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
        A new box with {box.name}'s files as they were {whenInSentence(snap.takenAt, store.now)}. It gets its own BB machine, address and keys, and never acts as {box.name}. Everything else on its disk comes with it: project secrets, signed-in browsers and keychains. It starts fresh: no apps are running{snap.holds === "disk-and-memory" ? ", as a fork never uses saved memory" : ""}.
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
        {snap.sizeThen ? `${snap.sizeThen.cores} cores, ${snap.sizeThen.memoryGiB} GiB memory, as ${box.name} had then.` : ""} {box.snapshotting?.forkWords}: about {seconds(heldCopySeconds(used) * 1000)}, and {used} GB on {box.host}.
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
  const known = snaps.filter((snap) => snap.sizeGB !== null || snap.heldCopyGB !== null);
  const paid = snaps.filter((snap) => snap.price);
  const parts: string[] = [];
  if (known.length) {
    const hosts = new Set(known.map((snap) => boxes.find((box) => box.id === snap.boxId)?.host));
    const total = known.reduce((sum, snap) => sum + (snap.heldCopyGB ?? snap.sizeGB ?? 0), 0);
    parts.push(`Frees ${sizeWords(total)} on ${[...hosts].join(" and ")}`);
  }
  if (paid.length) parts.push(`stops ${paid.length === 1 ? "its charge" : "their charges"} of ${priceWords(paid[0]!.price)}${paid.length > 1 ? " each" : ""}`);
  return parts.length ? `${parts.join(", and ")}.` : "";
}

function SkippedList({ skipped }: { skipped: readonly { name: string; why: string }[] }) {
  if (!skipped.length) return null;
  return (
    <div className="rounded-md border border-surface-warning-border bg-surface-warning px-3 py-2 text-foreground">
      <p>{skipped.length === 1 ? "Skipped:" : `${skipped.length} skipped:`}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {skipped.map((each) => (
          <li key={each.name}>
            "{each.name}": {each.why}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DeleteDialog({ boxes, snaps, onClose, onDone, returnTo }: { boxes: readonly FakeBox[]; snaps: readonly FakeSnap[]; onClose: () => void; onDone?: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const store = useStore();
  const skipped = snaps.flatMap((snap) => {
    const why = store.whyNotDelete(snap.id);
    return why ? [{ name: snap.name, why: `not while ${why}` }] : [];
  });
  const going = snaps.filter((snap) => !store.whyNotDelete(snap.id));
  const one = snaps.length === 1 ? snaps[0]! : null;
  const kept = going.filter((snap) => snap.keptUntil !== null);
  return (
    <Shell
      title={one ? `Delete "${one.name}"?` : `Delete ${snaps.length} snapshots?`}
      onClose={onClose}
      returnTo={returnTo}
      footer={
        <>
          <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!going.length}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              store.remove(going.map((snap) => snap.id), BY_PERSON);
              onDone?.();
            }}
          >
            {going.length === snaps.length ? "Delete" : `Delete ${going.length}`}
          </AlertDialogAction>
        </>
      }
    >
      <AlertDialogDescription asChild>
        <div className="space-y-2">
          {going.length ? <p>{freesWords(going, boxes) || "Its provider does not say how much it frees."} It cannot be undone.</p> : <p>Nothing can be deleted now.</p>}
          {kept.length ? <p>{one ? `You kept it until ${day(one.keptUntil!)}.` : `${kept.length} of them you kept.`}</p> : null}
          {one?.undoOf ? <p>It is the undo of the restore to "{one.undoOf.to}" at {clockOf(one.undoOf.at)}.</p> : null}
          <SkippedList skipped={skipped} />
        </div>
      </AlertDialogDescription>
    </Shell>
  );
}

function TextDialog({ title, label, value, long, onSave, onClose, returnTo }: { title: string; label: string; value: string; long?: boolean; onSave: (value: string) => void; onClose: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const [text, setText] = useState(value);
  return (
    <Shell
      title={title}
      onClose={onClose}
      returnTo={returnTo}
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

function keepCostWords(box: FakeBox, snap: FakeSnap, until: number, now: number): string {
  const cap = box.snapshotting;
  const days = Math.max(1, Math.ceil((until - now) / DAY));
  if (box.state === "released" || (snap.heldCopyGB !== null && !snap.undoOf)) return `It is a held copy, a template that cannot start, ${sizeWords(snap.heldCopyGB)} on ${box.host}, until ${day(until)}.`;
  if (cap?.keeps === "held-copy") {
    const memory = snap.holds === "disk-and-memory" ? " It holds the disk only, not the memory." : "";
    return `While ${box.name} lives, it stays as it is. If ${box.name} is released before ${day(until)}, bb-box first copies this snapshot in full into a template that cannot start: about ${seconds(heldCopySeconds(box.usedGB) * 1000)}, and ${box.usedGB} GB on ${box.host} until then. The release waits for the copy, and stops if there is no room.${memory} After the release it can be forked.`;
  }
  if (cap?.keeps === "as-is" && snap.price) return `It stays on ${box.backend} after the release, at ${priceWords(snap.price)}: about $${(days * snap.price.amount).toFixed(2)} until ${day(until)}, within your ceiling.`;
  if (cap?.keeps === "as-is") return `It stays on ${box.host} after the release; then it holds its whole size, up to ${box.diskGiB} GiB, as nothing shares its blocks.`;
  return cap?.keepsWhyNot ?? "This backend cannot keep a snapshot past the release.";
}

export function KeepDialog({ box, snaps, onClose, onDone, returnTo }: { box: FakeBox | null; snaps: readonly FakeSnap[]; onClose: () => void; onDone?: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const store = useStore();
  const one = snaps.length === 1 ? snaps[0]! : null;
  const [until, setUntil] = useState(() => isoDay(Math.max(one?.keptUntil ?? store.now, store.now) + store.settings.keepDays * DAY));
  const at = new Date(`${until}T23:59:00`).getTime();
  const valid = Number.isFinite(at) && at > store.now;
  const skipped = snaps.flatMap((snap) => {
    const why = store.whyNotKeep(snap.id);
    return why ? [{ name: snap.name, why }] : [];
  });
  const keeping = snaps.filter((snap) => !store.whyNotKeep(snap.id));
  const boxOf = (snap: FakeSnap) => box ?? store.boxes.find((each) => each.id === snap.boxId)!;
  return (
    <Shell
      title={one ? `Keep "${one.name}"` : `Keep ${snaps.length} snapshots`}
      onClose={onClose}
      returnTo={returnTo}
      footer={
        <>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!valid || !keeping.length}
            onClick={() => {
              store.keep(keeping.map((snap) => snap.id), at);
              onDone?.();
            }}
          >
            {keeping.length === snaps.length ? `Keep until ${valid ? day(at) : "…"}` : `Keep ${keeping.length} until ${valid ? day(at) : "…"}`}
          </AlertDialogAction>
        </>
      }
    >
      <AlertDialogDescription>A kept snapshot is yours: no agent can delete it. It stays after its box is released, and bb-box deletes it at the end of that day, warning you 3 days before.</AlertDialogDescription>
      {keeping.length ? (
        <label className="block space-y-1">
          <span className="text-xs text-foreground">Until</span>
          <Input type="date" value={until} min={isoDay(store.now + DAY)} onChange={(event) => setUntil(event.target.value)} className="h-8 w-44" autoFocus />
        </label>
      ) : null}
      {valid && keeping.length === 1 ? <p className="text-xs leading-snug text-subtle-foreground">{keepCostWords(boxOf(keeping[0]!), keeping[0]!, at, store.now)}</p> : null}
      {valid && keeping.length > 1 ? <p className="text-xs leading-snug text-subtle-foreground">On Proxmox each is copied in full into a template at its box's release: {keeping.reduce((sum, snap) => sum + boxOf(snap).usedGB, 0)} GB in all, at today's sizes.</p> : null}
      <SkippedList skipped={skipped} />
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
