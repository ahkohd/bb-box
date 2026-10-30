import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { AlertDialogCancel, AlertDialogDescription } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Badge, StatusDot } from "@/src/app/common.tsx";
import { BoxGlyph, MonitorGlyph, PhoneGlyph, TerminalGlyph } from "@/src/app/glyphs.tsx";
import { BY_PERSON, type FakeBox } from "./data";
import { go, hrefOf } from "./nav";
import { Checkbox, Shell, SnapshotRow } from "./snapshot-row";
import { UNDOS_A_BOX, useStore } from "./store";
import { byWords, clockOf, holdsWords, seconds, sizeWords, span, when, whenInSentence } from "./words";

export function TopRow({ trail }: { trail: readonly { words: string; go?: () => void }[] }) {
  return (
    <nav aria-label="Trail" className="flex items-center gap-1 text-xs text-muted-foreground">
      {trail.map((step, index) => (
        <span key={index} className="flex items-center gap-1">
          {index === 0 ? <Icon name="ChevronLeft" className="size-3.5" aria-hidden /> : <Icon name="ChevronRight" className="size-3 text-subtle-foreground" aria-hidden />}
          {step.go ? (
            <button type="button" className="cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={step.go}>
              {step.words}
            </button>
          ) : (
            <span className="text-foreground">{step.words}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function Card({ title, aside, children, footer, label }: { title: ReactNode; aside?: ReactNode; children: ReactNode; footer?: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-sm text-foreground">{title}</div>
        {aside}
      </div>
      {children}
      {footer ? <p className="border-t border-border px-4 py-2.5 text-xs leading-snug text-subtle-foreground">{footer}</p> : null}
    </section>
  );
}

function stateLine(box: FakeBox, now: number): { tone: "ok" | "busy" | "off" | "warn"; words: string } {
  if (box.state === "restoring") return { tone: "busy", words: `Restoring · ${box.step ?? ""}` };
  if (box.state === "starting") return { tone: "busy", words: `Starting · ${box.step ?? ""}` };
  if (box.state === "unconfirmed") return { tone: box.step ? "busy" : "warn", words: box.step ? `Checking · ${box.step}` : "bb-box could not confirm the restore" };
  if (box.state === "released") return { tone: "off", words: `Released ${span(now - (box.releasedAt ?? now))} ago` };
  if (box.state === "stopped") return { tone: "off", words: "Stopped" };
  return { tone: "ok", words: `Ready · up ${span(now - box.createdAt)}` };
}

export function capabilityWords(box: FakeBox): string {
  const cap = box.snapshotting;
  if (!cap) return box.noSnapshotsWhy ?? "No snapshots.";
  const holds = cap.holds.length === 2 ? "Snapshots hold the disk, or the disk and memory when asked." : cap.holds[0] === "disk" ? "Snapshots hold the disk." : "Snapshots hold the disk and memory: the box suspends for each.";
  const storage = box.storage?.newestOnly ? ` ${box.host} uses ZFS: a restore goes to the newest snapshot only, with a held copy as its undo.` : "";
  const leaves = cap.excludes ? ` They leave out ${cap.excludes}.` : "";
  if (box.state === "released") return `${holds}${leaves} ${box.name} was released, so only kept ones are left, each until its date.`;
  return `${holds}${leaves}${storage} They go when ${box.name} is released, unless kept.`;
}

function TakeDialog({ box, onClose }: { box: FakeBox; onClose: () => void }) {
  const store = useStore();
  const cap = box.snapshotting!;
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [memory, setMemory] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const choice = cap.holds.length === 2;
  const memoryOnly = cap.holds.length === 1 && cap.holds[0] === "disk-and-memory";
  const held = store.counted(box.id).length;
  const blocked = store.whyNotTake(box.id, BY_PERSON, memory);
  const memoryMs = (cap.memorySecondsPerGiB ?? 0) * box.memoryGiB * 1000;
  const take = () => {
    const outcome = store.take(box.id, { name, note, memory }, BY_PERSON);
    if (!outcome.ok) return setRefused(outcome.why);
    onClose();
  };
  return (
    <Shell
      title={`Take a snapshot of ${box.name}`}
      onClose={onClose}
      footer={
        <>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button type="button" disabled={!!blocked} onClick={take}>
            Take snapshot
          </Button>
        </>
      }
    >
      <label className="block space-y-1">
        <span className="text-xs text-foreground">Name</span>
        <Input value={name} maxLength={60} placeholder={`Today ${clockOf(store.now)}`} onChange={(event) => setName(event.target.value)} className="h-8" autoFocus />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-foreground">Note</span>
        <Input value={note} placeholder="Optional" onChange={(event) => setNote(event.target.value)} className="h-8" />
      </label>
      {choice ? (
        <div className="space-y-1">
          <Checkbox checked={memory} onChange={setMemory} label="With its memory" />
          <p className="pl-5.5 text-xs leading-snug text-subtle-foreground">
            About {seconds(memoryMs)}, about 1 s for each GiB of its {box.memoryGiB} GiB. {box.name} pauses for a moment. Up to {box.memoryGiB} GiB more on {box.host}. A restore then brings back its running apps, and the credentials in them.
          </p>
        </div>
      ) : null}
      <AlertDialogDescription className="text-xs leading-snug text-muted-foreground">
        {memoryOnly
          ? `It holds its disk and memory: every snapshot on Tart's macOS does, as ${box.name} suspends and resumes, about ${seconds(cap.takesAboutMs)}. A restore brings back its running apps, and the credentials in them.`
          : memory
            ? "It holds the disk and the memory."
            : `It holds the disk: files, installed apps and settings. About ${seconds(cap.takesAboutMs)}; ${box.name} keeps running.`}
        {cap.excludes ? ` It leaves out ${cap.excludes}.` : ""} {held + 1} of {store.settings.perBox} for {box.name} after this.
        {box.screen !== "none" ? (store.settings.pictures ? " A picture of its screen around now is kept with it." : " Pictures are off in Settings.") : ""}
        {cap.price ? ` It costs $${cap.price.amount.toFixed(3)} a day on ${box.backend}, about $${(cap.price.amount * 30).toFixed(2)} a month, until it is deleted.` : ` No charge: it is on ${box.host}'s storage.`}
      </AlertDialogDescription>
      {refused ?? blocked ? (
        <p role="alert" className="text-xs text-destructive-text">
          {refused ?? blocked}
        </p>
      ) : null}
    </Shell>
  );
}

function SnapshotsCard({ box }: { box: FakeBox }) {
  const store = useStore();
  const [taking, setTaking] = useState(false);
  const snaps = store.snaps.filter((snap) => snap.boxId === box.id).sort((a, b) => b.takenAt - a.takenAt);
  const counted = store.counted(box.id).length;
  const undos = store.undos(box.id).length;
  if (!box.snapshotting) {
    return (
      <Card label="Snapshots" title={<span>Snapshots</span>}>
        <p className="px-4 py-3 text-xs leading-snug text-muted-foreground">{box.noSnapshotsWhy}</p>
      </Card>
    );
  }
  const known = snaps.filter((snap) => snap.state === "ready").reduce((sum, snap) => sum + (snap.heldCopyGB ?? snap.sizeGB ?? 0), 0);
  const released = box.state === "released";
  const blocked = store.whyNotTake(box.id, BY_PERSON, false);
  const warning = box.cannotTakeWhy ?? (box.locked ? `Proxmox left ${box.name} locked (${box.locked}). bb-box's token cannot unlock it: run \`pct unlock ${box.vmid}\` on ${box.host}.` : null) ?? ((box.storage?.full ?? 0) >= store.settings.roomPercent ? `${box.host}'s ${box.storage?.name} is ${box.storage?.full}% full: new snapshots are refused until it is under ${store.settings.roomPercent}%.` : null) ?? (box.state === "ready" ? blocked : null);
  return (
    <Card
      label="Snapshots"
      title={
        <>
          <span>Snapshots</span>
          <span className="text-xs text-subtle-foreground">
            {released ? `${counted} kept` : `${counted} of ${store.settings.perBox}${undos ? `, and ${undos === 1 ? "1 undo" : `${undos} undos`} (up to ${UNDOS_A_BOX})` : ""}`}
            {known ? ` · ${sizeWords(known)} on ${box.host}` : box.snapshotting.price ? ` · on ${box.backend}` : ""}
          </span>
        </>
      }
      aside={
        released ? null : (
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={!!blocked} onClick={() => setTaking(true)}>
            <Icon name="Camera" aria-hidden />
            Take snapshot
          </Button>
        )
      }
      footer={capabilityWords(box)}
    >
      {warning && !released ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface-warning px-4 py-2.5 text-xs text-foreground">
          <StatusDot tone="warn" />
          <span className="min-w-0 flex-1">{warning}</span>
          {box.cannotTakeWhy ? (
            <button type="button" className="cursor-pointer text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => go({ page: "settings", section: "snapshots" })}>
              Fix it in Settings
            </button>
          ) : box.locked ? (
            <button type="button" className="cursor-pointer text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => store.unlock(box.id)}>
              Check again
            </button>
          ) : null}
        </div>
      ) : null}
      {snaps.length ? (
        <div className="divide-y divide-border px-4">
          {snaps.map((snap) => (
            <SnapshotRow key={snap.id} snap={snap} box={box} byThread />
          ))}
        </div>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">{box.cannotTakeWhy ? "None yet." : `None yet. Take one before a risky change; ${box.threadId ? "the agent takes its own too." : "an agent on this machine can take one too."}`}</p>
      )}
      {taking ? <TakeDialog box={box} onClose={() => setTaking(false)} /> : null}
    </Card>
  );
}

function Notices({ box }: { box: FakeBox }) {
  const store = useStore();
  const notice = store.notices.find((each) => each.boxId === box.id);
  if (!notice || box.state === "restoring") return null;
  if (notice.kind === "unconfirmed") {
    return (
      <div role="status" className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-surface-warning-border bg-surface-warning px-4 py-3">
        <StatusDot tone="warn" className="text-sm" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="text-foreground">bb-box could not confirm the restore of {box.name} to "{notice.to}": it was rolling back when bb-box restarted.</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Its record of the restore is kept, with its undo. Check now reads Proxmox's task and the guest, then finishes the restore or says what it found.</p>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={!!box.step} onClick={() => store.checkNow(box.id)}>
          {box.step ? "Checking…" : "Check now"}
        </Button>
      </div>
    );
  }
  const undo = notice.undoId ? store.snaps.find((snap) => snap.id === notice.undoId) : null;
  const who = notice.consentIn ? `by you, with your yes in ${notice.consentIn}` : byWords(notice.by, store.threads, true);
  const words = notice.kind === "finished-after-restart" ? `bb-box finished the restore of ${box.name} to "${notice.to}" after its restart, from its record and Proxmox's task.` : `Restored at ${clockOf(notice.at)} to "${notice.to}", taken ${whenInSentence(notice.toAt, store.now)}, ${who}.`;
  return (
    <div role="status" className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-border bg-surface-raised px-4 py-3">
      <Icon name="ArrowTurnBackward" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-foreground">{words}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{undo ? `Undo restores "${undo.name}", taken just before.` : "It was restored without an undo."}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {undo ? (
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={undo.state !== "ready"} onClick={() => store.askUndo(undo.id)}>
            Undo…
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => store.dismissNotice(box.id)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function Facts({ box }: { box: FakeBox }) {
  const store = useStore();
  const cells: [string, ReactNode, ReactNode?][] = [
    ["Kind", box.kindLabel],
    ["Size", `${box.cores} cores, ${box.memoryGiB} GiB memory, ${box.diskGiB} GiB disk`],
    ["Runs on", box.backendLabel, box.storage ? `${box.storage.name} (${box.storage.type}), ${box.storage.full}% full` : null],
    ["Made", `${span(store.now - box.createdAt)} ago`],
  ];
  if (box.forkedFrom) cells.push(["Forked from", box.forkedFrom.box, `"${box.forkedFrom.snapshot}" (${when(box.forkedFrom.takenAt, store.now).toLowerCase()})`]);
  if (box.snapshotting) cells.push(["Snapshots", box.snapshotting.holds.map(holdsWords).join(", or "), box.snapshotting.price ? `$${box.snapshotting.price.amount.toFixed(3)} a day each` : "No charge, on its host"]);
  return (
    <section aria-label="Facts" className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-3 [&>*]:border-b [&>*]:border-r [&>*]:border-border">
      {cells.map(([label, first, second]) => (
        <div key={label} className="min-w-0 px-4 py-3 text-sm">
          <p className="text-xs text-subtle-foreground">{label}</p>
          <p className="text-foreground">{first}</p>
          {second ? <p className="text-xs text-muted-foreground">{second}</p> : null}
        </div>
      ))}
    </section>
  );
}

function BoxLog({ box }: { box: FakeBox }) {
  const store = useStore();
  const events = store.events.filter((event) => event.boxId === box.id).slice(0, 8);
  if (!events.length) return null;
  return (
    <Card label="Box log" title={<span>Box log</span>} aside={<span className="text-xs text-subtle-foreground">Newest first</span>}>
      <ul className="divide-y divide-border px-4 text-xs">
        {events.map((event, index) => (
          <li key={index} className="flex gap-3 py-2">
            <span className="w-12 shrink-0 tabular-nums text-subtle-foreground">{clockOf(event.at)}</span>
            <span className="min-w-0 text-foreground">
              {event.words} <span className="text-muted-foreground">{byWords(event.by, store.threads, true)}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function BoxPage({ id }: { id: string }) {
  const store = useStore();
  const box = store.boxes.find((each) => each.id === id);
  const [taking, setTaking] = useState(false);
  if (!box) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <TopRow trail={[{ words: "Boxes", go: () => go({ page: "list", tab: "snapshots" }) }, { words: "Not found" }]} />
        <p className="text-sm text-muted-foreground">This box is gone.</p>
      </div>
    );
  }
  const line = stateLine(box, store.now);
  const thread = box.threadId ? store.threads.find((each) => each.id === box.threadId) : null;
  const ready = box.state === "ready";
  const viewIcon = box.screen === "phone" ? <PhoneGlyph /> : <MonitorGlyph />;
  const onIt = box.threadId === null ? box.workspaces.map((threadId) => store.threads.find((each) => each.id === threadId)).filter((each) => !!each) : [];
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "Boxes", go: () => history.back() }, { words: box.name }]} />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised text-muted-foreground">
            <BoxGlyph />
          </span>
          <div className="min-w-0 flex-1">
            <h1 tabIndex={-1} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-lg font-normal leading-tight tracking-tight text-foreground outline-none">
              {box.name}
              <span className="text-sm text-muted-foreground">{box.os}</span>
              {box.badges.map((badge) => (
                <Badge key={badge}>{badge}</Badge>
              ))}
            </h1>
            <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground" aria-live="polite">
              <StatusDot tone={line.tone} />
              {line.words}
            </p>
            <p className="mt-1 font-mono text-xs text-subtle-foreground">{box.id}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {thread ? (
                <>
                  For{" "}
                  <a href={hrefOf({ page: "thread", id: thread.id })} className="rounded-full border border-border px-2 py-0.5 text-foreground hover:bg-state-hover">
                    {thread.title} ↗
                  </a>{" "}
                  {thread.running ? "working now" : "idle"}
                </>
              ) : box.state === "released" ? (
                "Released. Its kept snapshots stay until their date."
              ) : (
                <>
                  One of your machines.{" "}
                  {onIt.length ? (
                    <>
                      On it:{" "}
                      {onIt.map((each) => (
                        <a key={each!.id} href={hrefOf({ page: "thread", id: each!.id })} className="rounded-full border border-border px-2 py-0.5 text-foreground hover:bg-state-hover">
                          {each!.title} ↗
                        </a>
                      ))}{" "}
                      {onIt.some((each) => each!.running) ? "working now" : "idle"}
                    </>
                  ) : (
                    "Threads can run on it."
                  )}
                </>
              )}
            </p>
          </div>
        </div>
        {box.state !== "released" ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-12 sm:pl-0">
            {box.screen !== "none" ? (
              <Button type="button" variant="outline" size="sm" className="h-8" disabled={!ready} onClick={() => store.say("Opens the view, as 069.")}>
                {viewIcon}
                {box.screen === "phone" ? "Emulator" : "Desktop"}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" className="h-8" disabled={!ready} onClick={() => store.say("Opens the terminal, as 069.")}>
              <TerminalGlyph />
              Terminal
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="icon" className="size-8" aria-label={`${box.name} actions`}>
                  <Icon name="MoreHorizontal" className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max min-w-48">
                <DropdownMenuItem disabled={!!store.whyNotTake(box.id, BY_PERSON, false)} onSelect={() => setTaking(true)}>
                  <Icon name="Camera" aria-hidden />
                  Take snapshot…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => store.say("Copied the address.")}>
                  <Icon name="Copy" aria-hidden />
                  Copy address
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => store.say("Stop, Resize and Release are 069's.")}>
                  <Icon name="Square" aria-hidden />
                  Stop
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </header>
      <Notices box={box} />
      {box.state !== "released" ? <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-subtle-foreground">Activity and Top processes, as decision 069 has them, are here on the real page.</p> : null}
      <SnapshotsCard box={box} />
      <Facts box={box} />
      <BoxLog box={box} />
      {taking && box.snapshotting ? <TakeDialog box={box} onClose={() => setTaking(false)} /> : null}
    </div>
  );
}
