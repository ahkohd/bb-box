import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FormSection, MenuSelect, OptionCard, ProviderRow, TYPE_GLYPHS } from "@/src/app/box-form.tsx";
import type { OfferView } from "@/src/plugin/views.ts";
import { BACKENDS, type BackendId, type GpuPart } from "./data";
import { go } from "./nav";
import { backendOf, boxesOnCard, freeMiB, gib, GPU_WORDS, listed, place, type World } from "./placement";
import { useStore } from "./store";

type Preset = "small" | "medium" | "large";
const PRESETS: Readonly<Record<"server" | "desktop", Readonly<Record<Preset, { cores: number; memoryGiB: number }>>>> = {
  server: { small: { cores: 2, memoryGiB: 4 }, medium: { cores: 4, memoryGiB: 16 }, large: { cores: 16, memoryGiB: 64 } },
  desktop: { small: { cores: 2, memoryGiB: 4 }, medium: { cores: 4, memoryGiB: 8 }, large: { cores: 8, memoryGiB: 16 } },
};
const PRESET_LABELS: Readonly<Record<Preset, string>> = { small: "Small", medium: "Medium", large: "Large" };

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

export function gpuLine(world: World, backend: BackendId | null, gpu: GpuPart, desktop: boolean): { readonly words: string; readonly blocked: boolean; readonly backend: BackendId | null } {
  const order = backend ? [backend] : BACKENDS.map((each) => each.id);
  if (gpu === "none") {
    const changing = order.filter((id) => backendOf(id).canChangeDevices);
    const words =
      changing.length === order.length
        ? "No GPU. You can add one later with Resize."
        : changing.length === 0
          ? "No GPU. On Docker one cannot be added later: a container's devices are fixed when it is made."
          : `No GPU. You can add one later with Resize on ${listedLabels(changing)}, not on ${listedLabels(order.filter((id) => !changing.includes(id)))}.`;
    return { words, blocked: false, backend: order[0] ?? null };
  }
  for (const id of order) {
    const placed = place(world, id, gpu, desktop);
    if (!placed.card) continue;
    const card = placed.card;
    const host = backendOf(id).host;
    const others = boxesOnCard(world, card).length;
    const where = `Card ${card.index} on ${host}, ${card.model}, ${gib(card.memoryMiB)}`;
    if (gpu === "whole") {
      const fence = backendOf(id).fencesWhole ? "" : " On Docker this is a promise among bb-box's boxes, not a fence.";
      return { words: `${where}, to itself: no other box is placed on it while this box has it.${fence}`, blocked: false, backend: id };
    }
    return { words: `${where}: ${others === 0 ? "no other box" : others === 1 ? "1 other box" : `${others} other boxes`}, ${gib(freeMiB(world, card))} free now. Boxes on a card share its memory and time.`, blocked: false, backend: id };
  }
  const whys = order.map((id) => place(world, id, gpu, desktop).why ?? `No card on ${backendOf(id).host} can take it now.`);
  return { words: order.length > 1 ? `No provider has a card for it now. ${whys.join(" ")}` : whys[0]!, blocked: true, backend: null };
}

export function NewBoxPage() {
  const store = useStore();
  const [desktop, setDesktop] = useState(false);
  const [preset, setPreset] = useState<Preset>("medium");
  const [gpu, setGpu] = useState<GpuPart>("shared");
  const [on, setOn] = useState<BackendId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const size = PRESETS[desktop ? "desktop" : "server"][preset];
  const wholeOffered = BACKENDS.some((backend) => store.settings[backend.id].wholeCards);
  const chosenGpu: GpuPart = gpu === "whole" && !wholeOffered ? "shared" : gpu;
  const line = gpuLine(store, on, chosenGpu, desktop);
  const blockedWhy = (id: BackendId) => (chosenGpu === "none" || place(store, id, chosenGpu, desktop).card ? null : "No card can take it now");
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
        className="space-y-5 rounded-lg border border-border bg-popover p-4 shadow-lg sm:p-5"
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
                setGpu(value as GpuPart);
                setProblem(null);
              }}
            />
            <p data-gpu-line className={cn("min-h-[2lh] text-xs leading-snug", line.blocked ? "text-warning-text" : "text-muted-foreground")}>
              {line.words}
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
                unavailable={blockedWhy(backend.id)}
                onClick={() => {
                  setOn(backend.id);
                  setProblem(null);
                }}
              />
            ))}
          </div>
        </FormSection>
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <p role={problem ? "alert" : undefined} className={cn("min-w-0 text-xs leading-snug", problem ? "text-destructive-text" : "text-muted-foreground")}>
            {problem ?? ""}
          </p>
          <Button type="submit" size="sm" className="shrink-0" disabled={line.blocked}>
            Create box
          </Button>
        </div>
      </form>
    </div>
  );
}
