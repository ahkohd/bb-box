// "New box" in BB's new-thread screen (033): the kind and size of the box a
// new thread starts on. BB saves the choice with the thread's machine and
// passes it to bb-box's "bb-box-new" machine provider.

import { experimental_Icon as Icon, useRpc, type PluginMachineProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Contract } from "../plugin/contract.ts";
import type { KindView } from "../plugin/views.ts";

type Preset = KindView["defaultPreset"];

interface Choice {
  readonly kind: string;
  readonly size?: Preset;
}

function chosen(value: unknown): Choice | null {
  if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string") return null;
  const { kind, size } = value as { kind: string; size?: unknown };
  return { kind, ...(typeof size === "string" ? { size: size as Preset } : {}) };
}

export function NewBoxInputs({ value, onChange }: PluginMachineProviderInputsProps) {
  const rpc = useRpc<Contract>();
  const [kinds, setKinds] = useState<KindView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("kinds", null).then(
      (all) => live && setKinds(all.filter((kind) => kind.enrol)),
      (error: unknown) => live && setProblem(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  const current = chosen(value);
  const kind = kinds?.find((candidate) => candidate.id === current?.kind) ?? kinds?.[0] ?? null;
  const size = current?.kind === kind?.id ? (current?.size ?? kind?.defaultPreset) : kind?.defaultPreset;
  useEffect(() => {
    if (problem) onChange({ status: "blocked", reason: problem });
    else if (!kinds) onChange({ status: "blocked", reason: "Loading BB Box's kinds…" });
    else if (!kind) onChange({ status: "blocked", reason: "BB Box offers no kind that a thread can run on. Set a backend up in BB Box's settings and turn it on." });
    else onChange({ status: "ready", value: { kind: kind.id, ...(size ? { size } : {}) } });
  }, [onChange, problem, kinds, kind, size]);

  const choose = (next: Choice) => onChange({ status: "ready", value: { kind: next.kind, ...(next.size ? { size: next.size } : {}) } });
  const preset = kind?.presets.find((candidate) => candidate.name === size);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="New box options" className="h-7 gap-1 px-2 text-xs text-muted-foreground" disabled={!kind}>
          <span className="min-w-0 truncate">{kind ? `${kind.label}${preset ? ` · ${preset.words}` : ""}` : problem ? "bb-box is unavailable" : "Loading…"}</span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        <DropdownMenuLabel>Kind</DropdownMenuLabel>
        {(kinds ?? []).map((candidate) => (
          <DropdownMenuItem key={candidate.id} onSelect={() => choose({ kind: candidate.id })}>
            {candidate.id === kind?.id ? <Icon name="Check" aria-hidden /> : <span className="size-4" aria-hidden />}
            {candidate.label}
          </DropdownMenuItem>
        ))}
        {kind ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Size</DropdownMenuLabel>
            {kind.presets.map((candidate) => (
              <DropdownMenuItem key={candidate.name} onSelect={() => choose({ kind: kind.id, size: candidate.name })}>
                {candidate.name === size ? <Icon name="Check" aria-hidden /> : <span className="size-4" aria-hidden />}
                {candidate.name[0]!.toUpperCase() + candidate.name.slice(1)} · {candidate.words}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
