import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Actor } from "../core/box-log.ts";
import type { BoxSnapshotsView, Contract, RestorePreview, SnapshotChange, SnapshotRowView, TakeCheck } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { actorWords, type ThreadTitles } from "./box-words.ts";
import { Badge, IconButton, message, StatusDot } from "./common.tsx";
import { useThreadTitles } from "./desktop.tsx";
import { CameraGlyph } from "./glyphs.tsx";
import {
  aboutWords,
  agoWords,
  attentionWords,
  footerWords,
  freesWords,
  gibWords,
  headWords,
  otherLosses,
  requestId,
  restoreWhyNot,
  sizeBackWords,
  snapshotClock,
  snapshotDay,
  snapshotPriceWords,
  snapshotSizeWords,
  snapshotWhen,
  threadLosses,
  undoLabel,
  whenInSentence,
} from "./snapshot-words.ts";

const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const TILE = "relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-recessed max-sm:h-[30px] max-sm:w-12";
const DISMISSED_KEY = "bb-box:restored-notice-dismissed";

type SnapshotCall = <T>(method: string, input: unknown) => Promise<T>;

function useSnapshotCall(): SnapshotCall {
  const rpc = useRpc<Contract>();
  return rpc.call as unknown as SnapshotCall;
}

async function changed(call: SnapshotCall, method: string, input: unknown): Promise<SnapshotChange> {
  try {
    return await call<SnapshotChange>(method, input);
  } catch (error) {
    return { error: message(error), pending: false };
  }
}

function agentThreads(actors: readonly (Actor | null | undefined)[]): string[] {
  return [...new Set(actors.flatMap((actor) => (actor?.is === "agent" ? [actor.threadId] : [])))];
}

export function useSnapshotTitles(view: BoxSnapshotsView | null | undefined): ThreadTitles {
  return useThreadTitles(agentThreads([...(view?.records ?? []).map((row) => row.by), view?.restored?.by]));
}

function Shell({ title, children, footer, onClose, returnTo }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !document.activeElement.closest("[role=menu]") ? document.activeElement : null);
  return (
    <AlertDialog open onOpenChange={(open) => (open ? null : onClose())}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          const first = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-first-focus]");
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnTo?.current ?? (opener.current?.isConnected ? opener.current : null);
          window.setTimeout(() => target?.focus(), 0);
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

function Refused({ words }: { words: string | null }) {
  return words ? (
    <p role="alert" className="text-xs text-destructive-text">
      {words}
    </p>
  ) : null;
}

function WarnPanel({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-surface-warning-border bg-surface-warning px-3 py-2 text-foreground">{children}</div>;
}

function Checkbox({ checked, onChange, label, disabled, describedBy }: { checked: boolean; onChange: (on: boolean) => void; label: ReactNode; disabled?: boolean; describedBy?: string }) {
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

const pictures = new Map<string, Promise<string | null>>();

function usePicture(boxId: string, row: SnapshotRowView): string | null {
  const call = useSnapshotCall();
  const [source, setSource] = useState<string | null>(null);
  const wanted = row.picture === "taken";
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    let loading = pictures.get(row.id);
    if (!loading) {
      loading = call<{ jpeg: string } | null>("snapshot.picture", { box: boxId, snapshot: row.id }).then(
        (picture) => (picture ? `data:image/jpeg;base64,${picture.jpeg}` : null),
        () => {
          pictures.delete(row.id);
          return null;
        },
      );
      pictures.set(row.id, loading);
    }
    void loading.then((loaded) => {
      if (!cancelled) setSource(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [boxId, row.id, wanted, call]);
  return wanted ? source : null;
}

function Thumbnail({ box, row, now }: { box: BoxView; row: SnapshotRowView; now: number }) {
  const source = usePicture(box.id, row);
  const [open, setOpen] = useState(false);
  const label = `${box.name}'s screen around ${whenInSentence(row.takenAt, now).replace(/^today at /, "")}`;
  if (row.picture !== "taken") return <span className={TILE} aria-hidden />;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Show ${label}`} className={cn(TILE, "cursor-zoom-in", FOCUS)}>
          {source ? <img src={source} alt="" className="size-full object-cover" /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <figure className="space-y-1.5">
          <div className="w-[320px] max-w-[80vw] overflow-hidden rounded-md border border-border bg-surface-recessed">{source ? <img src={source} alt={label} className="block w-full" /> : <div className="aspect-[16/10] w-full" />}</div>
          <figcaption className="px-0.5 text-xs text-muted-foreground">
            <span className="text-foreground">{row.name}</span> · the screen around {snapshotClock(row.takenAt)}
          </figcaption>
        </figure>
      </PopoverContent>
    </Popover>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-subtle-foreground">
      {" · "}
    </span>
  );
}

function rowLine(row: SnapshotRowView, boxName: string, now: number, titles: ThreadTitles): { attention: string | null; rest: string[] } {
  const ending = row.keptUntil !== null ? `kept until ${snapshotDay(row.keptUntil)}` : null;
  return {
    attention: attentionWords(row, boxName),
    rest: [ending, snapshotWhen(row.takenAt, now), actorWords(row.by, titles), row.state === "failed" ? null : snapshotSizeWords(row.size), snapshotPriceWords(row.price)].filter((part): part is string => !!part),
  };
}

type Asking = null | "restore" | "delete" | "rename" | "note";

function SnapshotRow({ box, view, row, now, titles, onChanged, onDeleted }: { box: BoxView; view: BoxSnapshotsView; row: SnapshotRowView; now: number; titles: ThreadTitles; onChanged: () => void; onDeleted: (id: string) => void }) {
  const [asking, setAsking] = useState<Asking>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const fromMenu = useRef(false);
  const dialogFromMenuOpening = useRef(false);
  const ask = (next: Asking, menu: boolean) => {
    fromMenu.current = menu;
    dialogFromMenuOpening.current = menu;
    setAsking(next);
  };
  const close = () => setAsking(null);
  const returnTo = fromMenu.current ? menuButton : undefined;
  const restoreWhy = restoreWhyNot(row, view, box.name, box.state);
  const line = rowLine(row, box.name, now, titles);
  const busy = row.state === "taking" || row.state === "deleting";
  const changeWhy = row.state === "deleting" ? "it is being deleted" : row.busyWhy && row.state !== "taking" ? row.busyWhy : null;
  return (
    <li data-snapshot-row={row.id} className="group flex min-w-0 items-start gap-3 py-3">
      {view.screen ? <Thumbnail box={box} row={row} now={now} /> : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="min-w-0 truncate text-sm text-foreground">{row.name}</span>
          {row.holds === "disk-and-memory" && row.scope === "box" ? <Badge>Memory</Badge> : null}
          {row.keptUntil !== null ? <Badge>Kept</Badge> : null}
          {row.undoOf ? <Badge>Undo</Badge> : null}
        </div>
        <p className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
          {busy ? <StatusDot tone="busy" className="motion-reduce:[&_*]:animate-none" /> : line.attention ? <StatusDot tone={row.state === "failed" ? "bad" : "warn"} /> : null}
          <span className="min-w-0">
            {busy ? <span>{row.state === "taking" ? "Taking…" : "Deleting…"}</span> : line.attention ? <span className={row.state === "failed" ? "text-destructive-text" : "text-warning-text"}>{line.attention}</span> : null}
            {line.rest.map((part, index) => (
              <span key={part}>
                {index || busy || line.attention ? <Dot /> : null}
                {part}
              </span>
            ))}
          </span>
        </p>
        {row.undoOf ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">The undo of the restore{row.undoOf.to ? ` to "${row.undoOf.to}"` : ""} at {snapshotClock(row.undoOf.at)}.</p> : null}
        {row.note ? <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs leading-snug text-subtle-foreground">{row.note}</p> : null}
      </div>
      <span className="flex shrink-0 items-center gap-0.5 self-center sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
        {view.offer?.restore !== "none" ? <IconButton label={restoreWhy ? `Restore: not now, as ${restoreWhy}` : `Restore ${box.name} to ${row.name}`} icon="ArrowTurnBackward" disabled={!!restoreWhy} onClick={() => ask("restore", false)} /> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={menuButton} type="button" variant="ghost" size="icon" data-row-menu className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`${row.name} actions`}>
              <Icon name="MoreHorizontal" className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-max min-w-44 max-w-72"
            mobileTitle={row.name}
            onCloseAutoFocus={(event) => {
              if (!dialogFromMenuOpening.current) return;
              dialogFromMenuOpening.current = false;
              event.preventDefault();
            }}
          >
            <DropdownMenuItem disabled={!!changeWhy || row.state === "failed"} onSelect={() => ask("rename", true)}>
              <Icon name="Pencil" aria-hidden />
              Rename…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!!changeWhy || row.state === "failed"} onSelect={() => ask("note", true)}>
              <Icon name="Pencil" aria-hidden />
              {row.note ? "Edit note…" : "Note…"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(row.id)}>
              <Icon name="Copy" aria-hidden />
              Copy ID
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={!!row.busyWhy && row.state !== "failed"} onSelect={() => ask("delete", true)}>
              <Icon name="Trash2" aria-hidden />
              <span className="min-w-0">
                <span className="block">Delete…</span>
                {row.busyWhy && row.state !== "failed" ? <span className="block whitespace-normal text-xs text-muted-foreground">{row.busyWhy}</span> : null}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {asking === "restore" ? <RestoreDialog box={box} snapshotId={row.id} perBox={view.perBox} now={now} returnTo={returnTo} onClose={close} onChanged={onChanged} /> : null}
      {asking === "delete" ? <DeleteDialog box={box} row={row} returnTo={returnTo} onClose={close} onChanged={onChanged} onDeleted={() => onDeleted(row.id)} /> : null}
      {asking === "rename" ? <TextDialog box={box} row={row} kind="rename" returnTo={returnTo} onClose={close} onChanged={onChanged} /> : null}
      {asking === "note" ? <TextDialog box={box} row={row} kind="note" returnTo={returnTo} onClose={close} onChanged={onChanged} /> : null}
    </li>
  );
}

export function TakeSnapshotDialog({ box, view, now, onClose, onChanged, returnTo }: { box: BoxView; view: BoxSnapshotsView; now: number; onClose: () => void; onChanged: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const call = useSnapshotCall();
  const offer = view.offer!;
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [memory, setMemory] = useState(offer.holds.length === 1 && offer.holds[0] === "disk-and-memory");
  const [plan, setPlan] = useState<{ readonly memory: boolean; readonly check: TakeCheck | null; readonly refusal: string | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const request = useRef(requestId());
  const describedBy = useId();
  const choice = offer.holds.length === 2;
  useEffect(() => {
    let cancelled = false;
    void call<{ check: TakeCheck | null; refusal: string | null }>("snapshot.takeCheck", { box: box.id, memory })
      .then((answer) => {
        if (!cancelled) setPlan({ memory, ...answer });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPlan({ memory, check: null, refusal: message(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [call, box.id, memory]);
  const current = plan?.memory === memory ? plan : null;
  const check = current?.check ?? null;
  const take = async () => {
    setSending(true);
    setRefused(null);
    const answer = await changed(call, "snapshot.take", { box: box.id, ...(name.trim() ? { name: name.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}), memory, request: request.current });
    setSending(false);
    onChanged();
    if (answer.error) setRefused(answer.error);
    else onClose();
  };
  const where = check ? `${check.host ? `${check.host}'s ` : ""}${check.storage}` : null;
  const holdsLine =
    offer.scope === "device"
      ? `It holds the device: its disk and memory, with the apps open on it. The rest of ${box.name} is not in it.`
      : memory
        ? `It holds the disk and the memory: a restore brings back its running apps, and the credentials in them.${check?.memory ? ` Up to ${gibWords(check.memory.addsBytes)} more on ${where}.` : ""}`
        : "It holds the disk: files, installed apps and settings.";
  const timing = check ? ` About ${aboutWords(check.aboutMs)}; ${offer.whileRunning === "live" ? `${box.name} keeps running` : offer.whileRunning === "pauses" ? `${box.name} pauses for a moment` : offer.whileRunning === "suspends" ? `${box.name} suspends for a few seconds` : `${box.name} must be stopped`}.` : "";
  const picture = view.screen ? (view.pictures ? " A picture of its screen around now is kept with it." : " Pictures are off in Settings, Snapshots.") : "";
  const price = offer.price ? ` It costs ${snapshotPriceWords(offer.price)} until it is deleted.` : " No charge: it is on the host's own storage.";
  return (
    <Shell
      title={`Take a snapshot of ${box.name}`}
      onClose={onClose}
      returnTo={returnTo}
      footer={
        <>
          <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
          <Button type="button" disabled={sending || !check} onClick={() => void take()}>
            {sending ? "Taking…" : "Take snapshot"}
          </Button>
        </>
      }
    >
      <label className="block space-y-1">
        <span className="text-xs text-foreground">Name</span>
        <Input value={name} maxLength={60} placeholder={`${new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(now)} ${snapshotClock(now)}`} onChange={(event) => setName(event.target.value)} className="h-8" data-first-focus aria-describedby={describedBy} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-foreground">Note</span>
        <Textarea value={note} placeholder="Optional" rows={2} onChange={(event) => setNote(event.target.value)} />
      </label>
      {choice ? (
        <div className="space-y-1">
          <Checkbox checked={memory} onChange={setMemory} label="With its memory" disabled={sending} />
          <p className="pl-5.5 text-xs leading-snug text-subtle-foreground">Slower, and it holds the running apps with the credentials in them. Without it, a restore starts the box afresh.</p>
        </div>
      ) : null}
      <AlertDialogDescription id={describedBy} className="text-xs leading-snug text-muted-foreground">
        {current ? (current.refusal ? null : `${holdsLine}${offer.excludes ? ` It leaves out ${offer.excludes}.` : ""}${timing} ${view.counted + 1} of ${view.perBox} for ${box.name} after this.${picture}${price}`) : "Reading what the backend plans…"}
      </AlertDialogDescription>
      <Refused words={refused ?? current?.refusal ?? null} />
    </Shell>
  );
}

export function RestoreDialog({ box, snapshotId, perBox, now, onClose, onChanged, returnTo }: { box: BoxView; snapshotId: string; perBox: number; now: number; onClose: () => void; onChanged: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const call = useSnapshotCall();
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [undo, setUndo] = useState(true);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [unflushed, setUnflushed] = useState<string | null>(null);
  const request = useRef(requestId());
  const noteId = useId();
  const show = (next: RestorePreview) => {
    setPreview(next);
    setUndo(!next.check?.undoRefused);
    setUnflushed(null);
    request.current = requestId();
  };
  useEffect(() => {
    let cancelled = false;
    void call<RestorePreview>("snapshot.restoreCheck", { box: box.id, snapshot: snapshotId })
      .then((answer) => {
        if (!cancelled) show(answer);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPreview({ refusal: message(error), threads: [], threadsUnread: null, control: false, terminals: 0, check: null, snapshot: null, token: "", undoUnflushed: null });
      });
    return () => {
      cancelled = true;
    };
  }, [call, box.id, snapshotId]);
  const row = preview?.snapshot ?? null;
  const title = `Restore ${box.name}${row ? ` to "${row.name}"` : ""}?`;
  if (!preview) {
    return (
      <Shell title={title} onClose={onClose} returnTo={returnTo} footer={<AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>}>
        <AlertDialogDescription role="status">Reading what the restore would do and end…</AlertDialogDescription>
      </Shell>
    );
  }
  const threads = threadLosses(preview, box.name);
  const others = otherLosses(preview);
  const check = preview.check;
  if (preview.refusal || !check) {
    return (
      <Shell title={title} onClose={onClose} returnTo={returnTo} footer={<AlertDialogCancel autoFocus>Close</AlertDialogCancel>}>
        <AlertDialogDescription asChild>
          <div className="space-y-3">
            <WarnPanel>
              <p>{preview.refusal ?? "bb-box cannot restore it now."}</p>
              {threads.length || others.length ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-5">
                  {[...threads, ...others].map((loss) => (
                    <li key={loss.key}>{loss.words}</li>
                  ))}
                </ul>
              ) : null}
            </WarnPanel>
          </div>
        </AlertDialogDescription>
      </Shell>
    );
  }
  const memory = row?.holds === "disk-and-memory";
  const device = row?.scope === "device";
  const sizeBack = sizeBackWords(box.name, check.from, check.to);
  const button = !undo ? "Restore without undo" : unflushed ? "Restore anyway, its undo may miss the last writes" : others.length ? `Restore ${box.name} anyway` : `Restore ${box.name}`;
  const restore = async () => {
    setSending(true);
    setRefused(null);
    const answer = await changed(call, "snapshot.restore", { box: box.id, snapshot: snapshotId, undo, accept: check.anyway, token: preview.token, ...(unflushed && undo ? { unflushed: true } : {}), request: request.current });
    setSending(false);
    onChanged();
    if (answer.preview) {
      show(answer.preview);
      setRefused(answer.error);
    } else if (answer.unflushed) {
      setUnflushed(answer.unflushed);
      request.current = requestId();
    } else if (answer.error) {
      setRefused(answer.error);
      request.current = requestId();
    } else onClose();
  };
  return (
    <Shell
      title={title}
      onClose={onClose}
      returnTo={returnTo}
      footer={
        <>
          <AlertDialogCancel autoFocus disabled={sending}>
            Cancel
          </AlertDialogCancel>
          <Button type="button" variant={undo ? "default" : "destructive"} disabled={sending} onClick={() => void restore()}>
            {sending ? "Restoring…" : button}
          </Button>
        </>
      }
    >
      <AlertDialogDescription asChild>
        <div className="space-y-3">
          {row && device ? (
            <p>
              Its device goes back to {whenInSentence(row.takenAt, now)}, {agoWords(now - row.takenAt)} ago, with the apps that were open then. Only the device: the rest of {box.name}'s disk stays as it is.
            </p>
          ) : row ? (
            <p>
              It goes back to {whenInSentence(row.takenAt, now)}, {agoWords(now - row.takenAt)} ago. Everything on its disk since then goes: files, installed apps and settings.{" "}
              {memory ? `${box.name} comes back running, as it was then, with the credentials its apps held then.` : `${box.name} restarts, so every process in it ends.`} What it did to the world since stays done.
            </p>
          ) : null}
          {others.length ? (
            <WarnPanel>
              <p>Also goes:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {others.map((loss) => (
                  <li key={loss.key}>{loss.words}</li>
                ))}
              </ul>
            </WarnPanel>
          ) : null}
          {sizeBack ? <p>{sizeBack}</p> : null}
          {preview.undoUnflushed ? <p className="text-warning-text">This undo may miss what was written in the last seconds before its restore: bb-box could not flush the box's writes to its disk then ({preview.undoUnflushed.replace(/\.$/, "")}).</p> : null}
          {check.swap && check.leavesOnEarlierGuest ? <p>{check.leavesOnEarlierGuest === 1 ? "1 snapshot stays" : `${check.leavesOnEarlierGuest} snapshots stay`} on its earlier guest: fork only.</p> : null}
        </div>
      </AlertDialogDescription>
      <div className="space-y-1">
        <Checkbox checked={undo} disabled={sending || !!check.undoRefused} onChange={setUndo} describedBy={noteId} label={undoLabel(preview)} />
        {check.undoRefused ? <p className="pl-5.5 text-xs text-warning-text">No undo can be taken: {check.undoRefused}</p> : null}
        <p id={noteId} className="pl-5.5 text-xs text-subtle-foreground">
          {check.undo ? `Named "${check.undo.name}". Undos do not count against the ${perBox} for ${box.name}.` : "Without an undo, this cannot be undone."}
          {check.replaces && undo ? ` It replaces the oldest undo, "${check.replaces}".` : ""}
          {memory && undo ? " Undo brings back its files, not its running apps." : ""}
        </p>
      </div>
      {unflushed && undo ? (
        <WarnPanel>
          <p role="alert">{unflushed}</p>
          <p className="mt-1 text-xs text-muted-foreground">Nothing changed. Restore anyway to go on with an undo that may miss those writes, or untick the undo, or cancel.</p>
        </WarnPanel>
      ) : null}
      <Refused words={refused} />
    </Shell>
  );
}

function DeleteDialog({ box, row, onClose, onChanged, onDeleted, returnTo }: { box: BoxView; row: SnapshotRowView; onClose: () => void; onChanged: () => void; onDeleted: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const call = useSnapshotCall();
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const request = useRef(requestId());
  const remove = async () => {
    setSending(true);
    setRefused(null);
    const answer = await changed(call, "snapshot.delete", { box: box.id, snapshot: row.id, request: request.current });
    setSending(false);
    if (!answer.error) onDeleted();
    onChanged();
    if (answer.error) setRefused(answer.error);
    else onClose();
  };
  return (
    <Shell
      title={`Delete "${row.name}"?`}
      onClose={onClose}
      returnTo={returnTo}
      footer={
        <>
          <AlertDialogCancel autoFocus disabled={sending}>
            Cancel
          </AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={sending} onClick={() => void remove()}>
            {sending ? "Deleting…" : "Delete"}
          </Button>
        </>
      }
    >
      <AlertDialogDescription asChild>
        <div className="space-y-2">
          <p>{freesWords(row, box.name)} It cannot be undone.</p>
          {row.keptUntil !== null ? <p>You kept it until {snapshotDay(row.keptUntil)}.</p> : null}
          {row.undoOf ? <p>It is the undo of the restore at {snapshotClock(row.undoOf.at)}.</p> : null}
        </div>
      </AlertDialogDescription>
      <Refused words={refused} />
    </Shell>
  );
}

function TextDialog({ box, row, kind, onClose, onChanged, returnTo }: { box: BoxView; row: SnapshotRowView; kind: "rename" | "note"; onClose: () => void; onChanged: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const call = useSnapshotCall();
  const [text, setText] = useState(kind === "rename" ? row.name : (row.note ?? ""));
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const save = async () => {
    setSending(true);
    setRefused(null);
    const answer = await changed(call, kind === "rename" ? "snapshot.rename" : "snapshot.note", { box: box.id, snapshot: row.id, ...(kind === "rename" ? { name: text.trim() } : { note: text }) });
    setSending(false);
    onChanged();
    if (answer.error) setRefused(answer.error);
    else onClose();
  };
  return (
    <Shell
      title={kind === "rename" ? `Rename "${row.name}"` : `A note on "${row.name}"`}
      onClose={onClose}
      returnTo={returnTo}
      footer={
        <>
          <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
          <Button type="button" disabled={sending || (kind === "rename" && !text.trim())} onClick={() => void save()}>
            {sending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <label className="block space-y-1">
        <span className="text-xs text-foreground">{kind === "rename" ? "Name" : "Note"}</span>
        {kind === "rename" ? (
          <Input
            value={text}
            maxLength={60}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && text.trim() && !sending) void save();
            }}
            className="h-8"
            data-first-focus
          />
        ) : (
          <Textarea value={text} rows={3} onChange={(event) => setText(event.target.value)} data-first-focus />
        )}
      </label>
      <AlertDialogDescription className="text-xs text-subtle-foreground">{kind === "rename" ? `At most 60 characters, and not the name of another snapshot of ${box.name}.` : "At most 1 KB. Only you see it, and agents of the box's thread."}</AlertDialogDescription>
      <Refused words={refused} />
    </Shell>
  );
}

export function SnapshotsCard({ box, view, now, titles, onChanged }: { box: BoxView; view: BoxSnapshotsView; now: number; titles: ThreadTitles; onChanged: () => void }) {
  const [taking, setTaking] = useState(false);
  const headingId = useId();
  const takeButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterDelete = useRef<{ readonly id: string; readonly next: string | null } | null>(null);
  const takeWhy = view.restoring || view.unconfirmed ? null : view.takeWhy;
  useEffect(() => {
    const pending = focusAfterDelete.current;
    if (!pending || view.records.some((row) => row.id === pending.id)) return;
    focusAfterDelete.current = null;
    const timer = window.setTimeout(() => {
      const next = pending.next ? document.querySelector<HTMLElement>(`[data-snapshot-row="${pending.next}"] [data-row-menu]`) : null;
      const take = takeButton.current && !takeButton.current.disabled ? takeButton.current : null;
      (next ?? take ?? heading.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [view.records]);
  const onDeleted = (id: string) => {
    const at = view.records.findIndex((row) => row.id === id);
    const next = view.records[at + 1] ?? view.records[at - 1] ?? null;
    focusAfterDelete.current = { id, next: next?.id ?? null };
  };
  if (!view.offer) {
    return (
      <section aria-labelledby={headingId} className="rounded-lg border border-border bg-card">
        <h2 id={headingId} className="px-4 py-2.5 text-sm font-normal text-foreground">
          Snapshots
        </h2>
        <p className="border-t border-border px-4 py-2.5 text-xs leading-snug text-muted-foreground">{view.noneWhy}</p>
      </section>
    );
  }
  const takeOff = !!takeWhy || !!view.restoring || !!view.unconfirmed;
  return (
    <section aria-labelledby={headingId} data-snapshots-card className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <h2 id={headingId} ref={heading} tabIndex={-1} className="text-sm font-normal text-foreground focus:outline-none">
            Snapshots
          </h2>
          <span className="text-xs text-subtle-foreground">{headWords(view)}</span>
        </div>
        <Button ref={takeButton} type="button" variant="outline" size="sm" className="h-7" disabled={takeOff} onClick={() => setTaking(true)}>
          <CameraGlyph />
          Take snapshot
        </Button>
      </div>
      {takeWhy ? (
        <p className="flex items-start gap-2 border-t border-border bg-surface-warning px-4 py-2.5 text-xs leading-snug text-foreground">
          <StatusDot tone="warn" />
          <span className="min-w-0">{takeWhy}</span>
        </p>
      ) : null}
      {view.records.length ? (
        <ul className="divide-y divide-border border-t border-border px-4">
          {view.records.map((row) => (
            <SnapshotRow key={row.id} box={box} view={view} row={row} now={now} titles={titles} onChanged={onChanged} onDeleted={onDeleted} />
          ))}
        </ul>
      ) : (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">None yet. Take one before a risky change.</p>
      )}
      <p className="border-t border-border px-4 py-2.5 text-xs leading-snug text-subtle-foreground">{footerWords(view, box.name)}</p>
      {taking ? <TakeSnapshotDialog box={box} view={view} now={now} onClose={() => setTaking(false)} onChanged={onChanged} /> : null}
    </section>
  );
}

function dismissed(): ReadonlySet<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function dismiss(operation: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed(), operation].slice(-50)));
  } catch {
    return;
  }
}

export function SnapshotNotices({ box, view, now, titles, onChanged }: { box: BoxView; view: BoxSnapshotsView; now: number; titles: ThreadTitles; onChanged: () => void }) {
  const call = useSnapshotCall();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(dismissed);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const undoButton = useRef<HTMLButtonElement>(null);
  const restored = view.restored && !hidden.has(view.restored.operation) ? view.restored : null;
  const failed = view.failed && !hidden.has(view.failed.operation) ? view.failed : null;
  const said = view.restoring
    ? `Restoring ${box.name} to "${view.restoring.to}"${view.restoring.step ? `: ${view.restoring.step}` : ""}.`
    : restored
      ? `${box.name} was restored to "${restored.to ?? "a snapshot since deleted"}".${restored.unflushed ? " Its undo may miss the last writes before it." : ""}`
      : failed
        ? `The restore of ${box.name} failed: ${failed.error}`
        : "";
  return (
    <>
      <p aria-live="polite" className="sr-only" data-snapshot-announcer>
        {said}
      </p>
      {view.restoring ? (
        <section data-notice="restoring" className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <StatusDot tone="busy" className="text-sm motion-reduce:[&_*]:animate-none" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="text-foreground">
              Restoring {box.name} to "{view.restoring.to}"
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{view.restoring.step ? `Now: ${view.restoring.step}.` : "Starting."} This page follows it.</p>
          </div>
        </section>
      ) : null}
      {view.unconfirmed ? (
        <section data-notice="warn" className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
          <div className="min-w-0 flex-1 text-sm">
            <h2 className="font-normal text-warning-text">
              bb-box could not confirm the restore of {box.name} to "{view.unconfirmed.to}"
            </h2>
            <p className="mt-1 text-foreground">{view.unconfirmed.words}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Its record of the restore is kept, with its undo. Check now reads the provider's task and the guest, then finishes the restore or says what it found.</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void changed(call, "snapshot.settle", { box: box.id }).finally(() => {
                setChecking(false);
                onChanged();
              });
            }}
          >
            {checking ? "Checking…" : "Check now"}
          </Button>
        </section>
      ) : null}
      {restored && !view.restoring ? (
        <section data-notice="restored" className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-4 py-3">
          <Icon name="ArrowTurnBackward" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 text-sm">
            <p className="text-foreground">
              Restored at {snapshotClock(restored.at)} to {restored.to ? `"${restored.to}"` : "a snapshot since deleted"}
              {restored.toTakenAt !== null ? `, taken ${whenInSentence(restored.toTakenAt, now)}` : ""}
              {actorWords(restored.by, titles) ? `, ${actorWords(restored.by, titles)}` : ""}.
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{restored.undo ? `Undo restores "${restored.undo.name}".` : "It was restored without an undo."}</p>
            {restored.unflushed ? (
              <p className="mt-0.5 text-xs text-warning-text">Its undo may miss what was written in the last seconds before the restore: bb-box could not flush the box's writes to its disk before stopping it ({restored.unflushed.replace(/\.$/, "")}).</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {restored.undo ? (
              <Button ref={undoButton} type="button" variant="outline" size="sm" className="h-7" disabled={!restored.undo.ready} onClick={() => setUndoing(restored.undo!.id)}>
                Undo…
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => {
                dismiss(restored.operation);
                setHidden(dismissed());
              }}
            >
              Dismiss
            </Button>
          </div>
        </section>
      ) : null}
      {failed && !view.restoring ? (
        <section data-notice="bad" className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-surface-destructive-border bg-surface-destructive px-4 py-3">
          <div className="min-w-0 flex-1 text-sm">
            <h2 className="font-normal text-destructive-text">
              The restore of {box.name}
              {failed.to ? ` to "${failed.to}"` : ""} failed at {snapshotClock(failed.at)}
            </h2>
            <p className="mt-1 text-foreground">{failed.error}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => {
              dismiss(failed.operation);
              setHidden(dismissed());
            }}
          >
            Dismiss
          </Button>
        </section>
      ) : null}
      {undoing ? <RestoreDialog box={box} snapshotId={undoing} perBox={view.perBox} now={now} returnTo={undoButton} onClose={() => setUndoing(null)} onChanged={onChanged} /> : null}
    </>
  );
}

