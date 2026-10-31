import { useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FormSection, MenuSelect, OptionCard, ProviderRow, TYPE_GLYPHS } from "@/src/app/box-form.tsx";
import type { OfferView } from "@/src/plugin/views.ts";
import { BACKENDS, type BackendId, type GpuPart, type KindId } from "./data";
import { go } from "./nav";
import { backendOf, cardName, capital, freeMiB, gib, GPU_WORDS, holders, listed, place, readAgo, type World } from "./placement";
import { useStore } from "./store";

type Preset = "small" | "medium" | "large";
const PRESETS: Readonly<Record<"server" | "desktop", Readonly<Record<Preset, { cores: number; memoryGiB: number }>>>> = {
  server: { small: { cores: 2, memoryGiB: 4 }, medium: { cores: 4, memoryGiB: 16 }, large: { cores: 16, memoryGiB: 64 } },
  desktop: { small: { cores: 2, memoryGiB: 4 }, medium: { cores: 4, memoryGiB: 8 }, large: { cores: 8, memoryGiB: 16 } },
};
const PRESET_LABELS: Readonly<Record<Preset, string>> = { small: "Small", medium: "Medium", large: "Large" };
const READING_MS = 700;
const DOCKER_REACH = "Boxes with Docker in them can still open every card.";

function offerOf(id: BackendId): OfferView {
  const backend = backendOf(id);
  return {
    backend: id,
    name: `${backend.label} on ${backend.host}`,
    type: id,
    label: backend.label,
    hosts: [backend.host],
    form: backend.form,
    ready: 0,
    free: null,
    admin: true,
    resizable: true,
    typicalReadyMs: backend.typicalReadyMs,
    docker: true,
    hostOs: "linux",
    gpuRoom: null,
  };
}

function rowClass(selected: boolean): string {
  return cn("block w-full rounded-md border px-3 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring", selected ? "border-transparent bg-state-active" : "border-input hover:bg-state-hover");
}

function listedLabels(ids: readonly BackendId[]): string {
  return listed(ids.map((id) => backendOf(id).label));
}

export interface GpuLine {
  readonly words: string;
  readonly blocked: boolean;
  readonly backend: BackendId | null;
}

export function gpuLine(world: World, backend: BackendId | null, gpu: GpuPart, desktop: boolean): GpuLine {
  const order = backend ? [backend] : BACKENDS.map((each) => each.id);
  if (gpu === "none") {
    const changing = order.filter((id) => backendOf(id).canChangeDevices);
    const docker = order.length === 1 && order[0] === "docker";
    const words = docker
      ? `No GPU, and none can be added later on Docker. ${DOCKER_REACH}`
      : changing.length === order.length
        ? "No GPU. You can add one later with Resize."
        : `No GPU. You can add one later with Resize on ${listedLabels(changing)}, not on ${listedLabels(order.filter((id) => !changing.includes(id)))}.`;
    return { words, blocked: false, backend: order[0] ?? null };
  }
  for (const id of order) {
    const placed = place(world, id, gpu, desktop);
    if (!placed.card) continue;
    const card = placed.card;
    const host = backendOf(id).host;
    const reach = backendOf(id).fencesWhole ? "" : ` ${DOCKER_REACH}`;
    if (gpu === "whole") {
      const outside = card.outsideMiB > 0 ? ` ${gib(card.outsideMiB)} of it is in use outside bb-box's boxes.` : " bb-box places no other box on it.";
      return { words: `${capital(cardName(card))} on ${host}, to itself.${outside}${reach}`, blocked: false, backend: id };
    }
    const others = holders(world, card).length;
    const company = others === 0 ? "no other box" : others === 1 ? "1 box" : `${others} boxes`;
    return { words: `${capital(cardName(card))} on ${host}, shared with ${company}; ${gib(freeMiB(world, card))} free ${readAgo(id)}. Boxes on a card share its memory.`, blocked: false, backend: id };
  }
  const what = gpu === "whole" ? "a free card" : "a card with room";
  return { words: order.length > 1 ? `No provider has ${what} now: see each below.` : `${backendOf(order[0]!).host} has no ${gpu === "whole" ? "free card" : "card with room"} now: see below.`, blocked: true, backend: null };
}

function readingWords(backend: BackendId | null): string {
  const hosts = backend ? [backendOf(backend).host] : BACKENDS.map((each) => each.host);
  return `Reading the cards on ${listed(hosts)}…`;
}

export function NewBoxPage() {
  const store = useStore();
  const [desktop, setDesktop] = useState(false);
  const kind: KindId = desktop ? "linux-desktop" : "linux";
  const [preset, setPreset] = useState<Preset>("medium");
  const gpu = store.formGpu[kind] ?? store.kindGpu[kind];
  const [on, setOn] = useState<BackendId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const readingKey = `${kind}|${on ?? "first"}`;
  const [readFor, setReadFor] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setReadFor(readingKey), READING_MS);
    return () => clearTimeout(timer);
  }, [readingKey]);
  const reading = readFor !== readingKey;
  const size = PRESETS[desktop ? "desktop" : "server"][preset];
  const wholeOffered = BACKENDS.some((backend) => store.settings[backend.id].wholeCards);
  const chosenGpu: GpuPart = gpu === "whole" && !wholeOffered ? "shared" : gpu;
  const line = gpuLine(store, on, chosenGpu, desktop);
  const blockedWhy = (id: BackendId) => (chosenGpu === "none" ? null : place(store, id, chosenGpu, desktop).short);
  const takers = BACKENDS.filter((backend) => blockedWhy(backend.id) === null);
  const arrows = (event: KeyboardEvent<HTMLElement>, count: number, index: number, choose: (position: number) => void) => {
    const move = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!move) return;
    event.preventDefault();
    choose((index + move + count) % count);
  };
  const presets: Preset[] = ["small", "medium", "large"];
  const submit = () => {
    const backend = on ?? line.backend;
    if (!backend) return setProblem(line.words);
    const made = store.create({ backend, desktop, cores: size.cores, memoryGiB: size.memoryGiB, gpu: chosenGpu });
    if (!made.ok) return setProblem(made.why);
    go({ page: "box", id: made.id });
  };
  return (
    <div className="mx-auto w-full max-w-[600px] px-4 pb-6 pt-3 md:pt-4">
      <p className="pb-3 text-xs text-subtle-foreground">BB's New box popover, opened from the plus in the Boxes header.</p>
      <form
        aria-label="New box"
        className="space-y-5 rounded-lg border border-border bg-popover p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FormSection title="System">
          <div role="radiogroup" aria-label="System" className="flex flex-wrap gap-2">
            <OptionCard title="Linux" words="pve-1, docker-1" selected onClick={() => undefined} />
          </div>
        </FormSection>
        <FormSection title="Architecture">
          <div role="radiogroup" aria-label="Architecture" className="flex flex-wrap gap-2">
            <OptionCard title="x86_64" words="64-bit Intel / AMD" selected onClick={() => undefined} />
            <OptionCard title="arm64" words="64-bit ARM" selected={false} available={false} onClick={() => undefined} />
          </div>
        </FormSection>
        <FormSection title="Type">
          <div role="radiogroup" aria-label="Type" className="flex flex-wrap gap-2" onKeyDown={(event) => arrows(event, 2, desktop ? 1 : 0, (position) => setDesktop(position === 1))}>
            <OptionCard title="Server" words="Terminal" glyph={TYPE_GLYPHS.server} selected={!desktop} onClick={() => setDesktop(false)} />
            <OptionCard title="Desktop" words="Screen · Terminal · Computer use" glyph={TYPE_GLYPHS.desktop} selected={desktop} onClick={() => setDesktop(true)} />
          </div>
        </FormSection>
        <FormSection title="Resources" description="Configure the box's cores, memory, disk and GPU: pick a size, or Custom to set your own.">
          <div role="radiogroup" aria-label="Size" className="flex flex-wrap gap-2" onKeyDown={(event) => arrows(event, 3, presets.indexOf(preset), (position) => setPreset(presets[position]!))}>
            {presets.map((name) => {
              const each = PRESETS[desktop ? "desktop" : "server"][name];
              return <OptionCard key={name} title={PRESET_LABELS[name]} words={`${each.cores} cores · ${each.memoryGiB} GiB`} selected={name === preset} onClick={() => setPreset(name)} />;
            })}
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">GPU</p>
            <MenuSelect
              label="GPU"
              value={chosenGpu}
              options={(["none", "shared", "whole"] as const).filter((value) => value !== "whole" || wholeOffered).map((value) => ({ value, label: GPU_WORDS[value] }))}
              onChange={(value) => {
                store.rememberFormGpu(kind, value as GpuPart);
                setProblem(null);
              }}
            />
            <p data-gpu-line aria-live="polite" className={cn("h-[3lh] text-xs leading-snug sm:h-[2lh]", !reading && line.blocked ? "text-warning-text" : "text-muted-foreground")}>
              {reading ? readingWords(on) : line.words}
            </p>
          </div>
        </FormSection>
        <FormSection title="Provider" description="Where the box goes: the first with room for it, in this order, unless you choose one.">
          <div role="radiogroup" aria-label="Provider" className="space-y-2">
            <button type="button" role="radio" aria-checked={on === null} onClick={() => setOn(null)} className={rowClass(on === null)}>
              <span className="block text-xs text-foreground">First with room</span>
              <span className="mt-0.5 block text-2xs text-muted-foreground">{takers.length === 0 ? "None below can take it now" : takers.length === 1 ? "The one below" : `Any of the ${takers.length} below, in order`}</span>
            </button>
            {BACKENDS.map((backend) => (
              <ProviderRow
                key={backend.id}
                offer={offerOf(backend.id)}
                selected={on === backend.id}
                unavailable={reading ? "Reading its cards…" : blockedWhy(backend.id)}
                onClick={() => {
                  setOn(backend.id);
                  setProblem(null);
                }}
              />
            ))}
          </div>
        </FormSection>
        <div className="flex items-center justify-between gap-3 pt-1">
          <p role={problem ? "alert" : undefined} className={cn("min-w-0 text-xs leading-snug", problem ? "text-destructive-text" : "text-muted-foreground")}>
            {problem ?? ""}
          </p>
          <Button type="submit" size="sm" className="shrink-0 font-normal" disabled={reading || line.blocked}>
            Create box
          </Button>
        </div>
      </form>
    </div>
  );
}
