import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Badge, StatusDot, type Tone } from "@/src/app/common.tsx";
import { MonitorGlyph, ServerGlyph } from "@/src/app/glyphs.tsx";
import { THREADS, type FakeBox } from "./data";
import { go } from "./nav";
import { backendOf, boxesOnCard, capital, cardById, cardName, freeMiB, gib, gpuSizeWord, type World } from "./placement";
import { ResizeDialog } from "./resize";
import { useStore } from "./store";

export function TopRow({ trail }: { trail: readonly { words: string; go?: () => void }[] }) {
  return (
    <nav aria-label="Trail" className="flex items-center gap-1 text-xs text-muted-foreground">
      {trail.map((step, index) => (
        <span key={index} className="flex items-center gap-1">
          {step.go ? (
            <button type="button" className="cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={step.go}>
              {step.words}
            </button>
          ) : (
            <span className="text-foreground">{step.words}</span>
          )}
          {index < trail.length - 1 ? <Icon name="ChevronRight" className="size-3 text-subtle-foreground" aria-hidden /> : null}
        </span>
      ))}
    </nav>
  );
}

export function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export function gpuBadge(box: FakeBox): string | null {
  return box.gpu === "none" ? null : box.gpu === "whole" ? "Whole GPU" : "GPU";
}

export function sizeWords(box: FakeBox): string {
  return [`${box.cores} cores`, `${box.memoryGiB} GiB`, box.diskGiB !== null ? `${box.diskGiB} GiB disk` : null, gpuSizeWord(box.gpu)].filter(Boolean).join(" · ");
}

function stateOf(box: FakeBox, now: number): { tone: Tone; words: string } {
  if (box.state === "starting") return { tone: "busy", words: `Starting · ${box.step ?? ""}` };
  if (box.state === "restarting") return { tone: "busy", words: `Restarting · ${box.step ?? ""}` };
  if (box.state === "stopped") return { tone: "off", words: "Stopped" };
  return { tone: "ok", words: `Ready · up ${span(now - box.createdAt)}` };
}

function Fact({ label, children, second }: { label: string; children: ReactNode; second?: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5 px-4 py-3">
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">
        {children}
        {second ? <span className="block text-xs text-muted-foreground">{second}</span> : null}
      </dd>
    </div>
  );
}

function others(world: World, box: FakeBox): FakeBox[] {
  const card = cardById(world, box.card);
  return card ? boxesOnCard(world, card, box.id) : [];
}

function gpuFact(world: World, box: FakeBox): { first: string; second: string } {
  const card = cardById(world, box.card);
  const backend = backendOf(box.backend);
  if (!card) return { first: "None", second: backend.canChangeDevices ? "Resize to add one" : "Cannot be added on Docker" };
  const rest = others(world, box);
  return {
    first: `${capital(cardName(card))}, ${box.gpu === "whole" ? "whole" : "shared"}`,
    second: box.gpu === "whole" || !rest.length ? `${card.model} · ${gib(card.memoryMiB)}` : `with ${rest.map((each) => each.name).join(", ")}`,
  };
}

function boxMiB(box: FakeBox): number {
  return box.processes.reduce((sum, process) => sum + process.mib, 0);
}

function Chip({ box, onGo }: { box: FakeBox; onGo: () => void }) {
  return (
    <button type="button" onClick={onGo} className="inline-flex h-6 cursor-pointer items-center rounded-full border border-border bg-background px-2 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      {box.name}
      {box.state === "stopped" ? <span className="pl-1 text-muted-foreground">stopped</span> : null}
    </button>
  );
}

function GpuCard({ box, busy, onChange }: { box: FakeBox; busy: boolean; onChange: () => void }) {
  const store = useStore();
  const card = cardById(store, box.card)!;
  const backend = backendOf(box.backend);
  const rest = others(store, box);
  const mine = box.state === "stopped" ? 0 : boxMiB(box);
  const theirs = rest.reduce((sum, each) => sum + (each.state === "stopped" ? 0 : boxMiB(each)), 0);
  const outside = card.outsideMiB;
  const free = freeMiB(store, card);
  const total = card.memoryMiB;
  const use = Math.min(100, [box, ...rest].reduce((sum, each) => sum + (each.state === "stopped" ? 0 : each.gpuPercent), 0));
  const pct = (mib: number) => `${(mib / total) * 100}%`;
  const footer =
    box.state === "stopped"
      ? `Stopped: it takes ${cardName(card)} again when it starts.`
      : box.gpu === "shared"
        ? "Boxes on a card share its memory and its time: one box can take all of its memory. The figures are the whole card's, from the Monitor."
        : backend.fencesWhole
          ? "No other box can open this card: on Proxmox LXC a whole card is fenced. The host, and machines that are not bb-box's, can still use it."
          : "No other box is placed on this card. On Docker a box with Docker in it can still open it: a whole card here is a promise, not a fence.";
  return (
    <section aria-labelledby="gpu-heading" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
        <h2 id="gpu-heading" className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-sm font-normal text-foreground">
          GPU
          <span className="text-xs text-muted-foreground">
            {capital(cardName(card))} · {card.model} · {gib(total)} · {box.gpu === "whole" ? "whole card" : "shared"}
          </span>
        </h2>
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy} onClick={onChange}>
          Change…
        </Button>
      </div>
      <div className="space-y-3 px-4 py-3">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Memory on the card</span>
            <span className="tabular-nums text-foreground">
              {gib(total - free)} of {gib(total)} used
            </span>
          </div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-recessed" role="img" aria-label={`This box ${gib(mine)}, other boxes ${gib(theirs)}, outside boxes ${gib(outside)}, free ${gib(free)}`}>
            <span className="h-full bg-foreground" style={{ width: pct(mine) }} />
            <span className="h-full border-l border-card bg-foreground/45" style={{ width: pct(theirs) }} />
            <span className="h-full border-l border-card bg-foreground/20" style={{ width: pct(outside) }} />
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {[
              ["This box", mine, "bg-foreground"],
              ["Other boxes", theirs, "bg-foreground/45"],
              ["Outside boxes", outside, "bg-foreground/20"],
              ["Free", free, "border border-border bg-surface-recessed"],
            ].map(([label, mib, swatch]) => (
              <div key={label as string} className="flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2 rounded-sm", swatch as string)} />
                <dt className="text-muted-foreground">{label as string}</dt>
                <dd className="tabular-nums text-foreground">{gib(mib as number)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Card use</dt>
            <dd className="tabular-nums text-foreground">{use}%</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Boxes on it</dt>
            <dd className="tabular-nums text-foreground">{rest.length + 1}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Index on {backend.host}</dt>
            <dd className="tabular-nums text-foreground">{card.index}</dd>
          </div>
        </dl>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Its processes on the card</p>
          {box.processes.length && box.state !== "stopped" ? (
            <ul className="space-y-0.5 text-xs">
              {box.processes.map((process) => (
                <li key={process.pid} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3">
                  <span className="truncate text-foreground">{process.name}</span>
                  <span className="tabular-nums text-muted-foreground">{process.pid}</span>
                  <span className="w-16 text-right tabular-nums text-foreground">{gib(process.mib)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-subtle-foreground">None now.</p>
          )}
        </div>
        {box.gpu === "shared" ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Other boxes on {cardName(card)}</p>
            {rest.length ? (
              <div className="flex flex-wrap gap-1.5">
                {rest.map((each) => (
                  <Chip key={each.id} box={each} onGo={() => go({ page: "box", id: each.id })} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-subtle-foreground">None now.</p>
            )}
          </div>
        ) : null}
      </div>
      <p className="border-t border-border px-4 py-2.5 text-xs leading-snug text-subtle-foreground">{footer}</p>
    </section>
  );
}

export function BoxPage({ id, resize }: { id: string; resize: boolean }) {
  const store = useStore();
  const box = store.boxes.find((each) => each.id === id);
  const [open, setOpen] = useState(resize);
  if (!box) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <TopRow trail={[{ words: "Boxes", go: () => go({ page: "boxes" }) }, { words: "Gone" }]} />
        <p className="text-sm text-muted-foreground">This box was released.</p>
      </div>
    );
  }
  const state = stateOf(box, store.now);
  const backend = backendOf(box.backend);
  const fact = gpuFact(store, box);
  const busy = box.state === "starting" || box.state === "restarting";
  const badge = gpuBadge(box);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "Boxes", go: () => go({ page: "boxes" }) }, { words: box.name }]} />
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised text-muted-foreground">{box.desktop ? <MonitorGlyph /> : <ServerGlyph />}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="flex flex-wrap items-center gap-1.5 text-base font-normal text-foreground">
            {box.name}
            {badge ? <Badge>{badge}</Badge> : null}
          </h1>
          <p className="flex min-h-[1.375em] items-start gap-1.5 text-xs text-muted-foreground">
            <StatusDot tone={state.tone} />
            <span>{state.words}</span>
            <span className="text-subtle-foreground">· {box.thread === "you" ? "Made by you" : THREADS[box.thread]}</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => setOpen(true)}>
            Resize…
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-7 w-7 px-0" aria-label={`More for ${box.name}`}>
                <Icon name="MoreHorizontal" className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={busy} onSelect={() => setOpen(true)}>
                Resize…
              </DropdownMenuItem>
              {box.state === "stopped" ? <DropdownMenuItem onSelect={() => store.power(box.id, true)}>Start</DropdownMenuItem> : <DropdownMenuItem disabled={busy} onSelect={() => store.power(box.id, false)}>Stop</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive-text"
                onSelect={() => {
                  store.release(box.id);
                  go({ page: "boxes" });
                }}
              >
                Release
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <section aria-label="Facts" className="overflow-hidden rounded-lg border border-border bg-card">
        <dl className="-mb-px -mr-px grid grid-cols-2 lg:grid-cols-3 [&>*]:border-b [&>*]:border-r [&>*]:border-border">
          <Fact label="Kind">{box.desktop ? "Linux desktop" : "Linux"}</Fact>
          <Fact label="Size">{sizeWords(box)}</Fact>
          <Fact label="Runs on" second={backend.label}>
            Container on {backend.host}
          </Fact>
          <Fact label="GPU" second={fact.second}>
            {fact.first}
          </Fact>
          <Fact label="System">Linux x86_64, with Docker</Fact>
          <Fact label="Made" second={`${span(store.now - box.createdAt)} ago`}>
            {box.thread === "you" ? "By you" : "By its thread"}
          </Fact>
        </dl>
      </section>
      {box.gpu !== "none" ? <GpuCard box={box} busy={busy} onChange={() => setOpen(true)} /> : null}
      {open ? <ResizeDialog box={box} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
