// "New box" in BB's new-thread screen (033): the kind, size and image of the
// box a new thread starts on. BB saves the choice with the thread's machine
// and passes it to bb-box's "bb-box-new" machine provider.

import { experimental_Icon as Icon, useBbContext, useRpc, type PluginMachineProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Contract } from "../plugin/contract.ts";
import type { ImageOptionView, KindView } from "../plugin/views.ts";
import { PRODUCT } from "./product.ts";

const NO_KIND = `${PRODUCT} offers no kind that a thread can run on. Set a backend up in ${PRODUCT}'s settings and turn it on.`;

type Preset = KindView["defaultPreset"];

interface Choice {
  readonly kind: string;
  readonly size?: Preset;
  /** An image's name or "standard" (049); left out, the provider gives the thread's project's image for the kind. */
  readonly image?: string;
}

function chosen(value: unknown): Choice | null {
  if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string") return null;
  const { kind, size, image } = value as { kind: string; size?: unknown; image?: unknown };
  return { kind, ...(typeof size === "string" ? { size: size as Preset } : {}), ...(typeof image === "string" ? { image } : {}) };
}

export function NewBoxInputs({ value, onChange }: PluginMachineProviderInputsProps) {
  const rpc = useRpc<Contract>();
  const { projectId } = useBbContext();
  const [kinds, setKinds] = useState<KindView[] | null>(null);
  const [images, setImages] = useState<ImageOptionView[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("kinds", null).then(
      // A Windows box cannot be a thread's new box: BB adds its machine with its installer for Linux and macOS only (#539).
      (all) => live && setKinds(all.filter((kind) => kind.enrol && kind.os !== "windows")),
      (error: unknown) => live && setProblem(error instanceof Error ? error.message : String(error)),
    );
    // The images a box of this project can choose (049); without a project, none is marked as its own.
    rpc.call("images", projectId ? { projectId } : {}).then(
      (all) => live && setImages(all),
      () => live && setImages([]),
    );
    return () => {
      live = false;
    };
  }, [rpc, projectId]);

  const current = chosen(value);
  const kind = kinds?.find((candidate) => candidate.id === current?.kind) ?? kinds?.[0] ?? null;
  const size = current?.kind === kind?.id ? (current?.size ?? kind?.defaultPreset) : kind?.defaultPreset;
  // The images covering the kind, this project's first. With a project, its image is the choice at first, else Standard;
  // without one (the composer outside a project), nothing is chosen and nothing is sent until the person picks, so the
  // provider's own default, the new thread's project's image, still applies.
  const covering = kind ? images.filter((candidate) => candidate.kinds.includes(kind.id)) : [];
  const imageOptions = [
    ...covering.filter((candidate) => candidate.mine).map((candidate) => ({ value: candidate.name, label: candidate.name })),
    { value: "standard", label: "Standard" },
    ...covering.filter((candidate) => !candidate.mine).map((candidate) => ({ value: candidate.name, label: `${candidate.name} · ${candidate.projects.map((project) => project.name).join(", ")}` })),
  ];
  const kept = current?.kind === kind?.id && current?.image && imageOptions.some((option) => option.value === current.image) ? current.image : undefined;
  const image = covering.length ? (kept ?? (projectId ? (covering.find((candidate) => candidate.mine)?.name ?? "standard") : undefined)) : undefined;
  useEffect(() => {
    if (problem) onChange({ status: "blocked", reason: problem });
    else if (!kinds) onChange({ status: "blocked", reason: `Loading ${PRODUCT}'s kinds…` });
    else if (!kind) onChange({ status: "blocked", reason: NO_KIND });
    else onChange({ status: "ready", value: { kind: kind.id, ...(size ? { size } : {}), ...(image ? { image } : {}) } });
  }, [onChange, problem, kinds, kind, size, image]);

  const choose = (next: Choice) => onChange({ status: "ready", value: { kind: next.kind, ...(next.size ? { size: next.size } : {}), ...(next.image ? { image: next.image } : {}) } });
  const preset = kind?.presets.find((candidate) => candidate.name === size);
  const imageWords = image ? (imageOptions.find((option) => option.value === image)?.label.replace(/ · .*$/, "") ?? image) : null;
  const waiting = kind ? `${kind.label}${preset ? ` · ${preset.words}` : ""}${imageWords ? ` · ${imageWords}` : ""}` : problem ? `${PRODUCT} is unavailable.` : kinds && kinds.length === 0 ? NO_KIND : "Loading…";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="New box options" className="h-7 gap-1 px-2 text-xs text-muted-foreground" disabled={!kind}>
          <span className="min-w-0 truncate">{waiting}</span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        <DropdownMenuLabel>Kind</DropdownMenuLabel>
        {(kinds ?? []).map((candidate) => (
          <DropdownMenuItem key={candidate.id} role="menuitemradio" aria-checked={candidate.id === kind?.id} onSelect={() => choose({ kind: candidate.id })}>
            {candidate.id === kind?.id ? <Icon name="Check" aria-hidden /> : <span className="size-4" aria-hidden />}
            {candidate.label}
          </DropdownMenuItem>
        ))}
        {kind ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Size</DropdownMenuLabel>
            {kind.presets.map((candidate) => (
              <DropdownMenuItem key={candidate.name} role="menuitemradio" aria-checked={candidate.name === size} onSelect={() => choose({ kind: kind.id, size: candidate.name, ...(image ? { image } : {}) })}>
                {candidate.name === size ? <Icon name="Check" aria-hidden /> : <span className="size-4" aria-hidden />}
                {candidate.name[0]!.toUpperCase() + candidate.name.slice(1)} · {candidate.words}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {kind && covering.length ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Image</DropdownMenuLabel>
            {imageOptions.map((option) => (
              <DropdownMenuItem key={option.value} role="menuitemradio" aria-checked={option.value === image} onSelect={() => choose({ kind: kind.id, ...(size ? { size } : {}), image: option.value })}>
                {option.value === image ? <Icon name="Check" aria-hidden /> : <span className="size-4" aria-hidden />}
                {option.label}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
