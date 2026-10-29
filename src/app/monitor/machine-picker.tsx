import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Machine } from "../../plugin/contract.ts";
import { SERVER_MACHINE } from "./use-snapshot.ts";
import { machineKey } from "./use-machines.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { MiddleTruncate } from "./middle-truncate.tsx";
import { cn } from "@/lib/utils";
import { screenGlyph } from "../box-opens.tsx";
import type { LookOf } from "./box-screens.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import { CrownIcon, ServerIcon } from "@hugeicons/core-free-icons";

type MachineKind = "server" | "machine" | "box" | "device" | "desktop";

const KIND_ICONS = { server: CrownIcon, machine: ServerIcon } as const;
const BB_BOX_ICON = "bb-box/box";

const KIND_LABELS: Record<MachineKind, string> = {
  server: "bb server",
  machine: "Machine",
  box: "Box",
  device: "Device box",
  desktop: "Desktop box",
};

function kindOf(machine: Machine, lookOf?: LookOf): MachineKind {
  if (machine.isServer) return "server";
  if (!machine.isBox) return "machine";
  return lookOf?.(machine) ?? "box";
}

function KindIcon({ kind, className }: { kind: MachineKind; className?: string }) {
  if (kind === "device" || kind === "desktop") {
    return (
      <span role="img" aria-label={KIND_LABELS[kind]} className={cn("inline-flex shrink-0", className)}>
        {screenGlyph(kind, "size-3.5")}
      </span>
    );
  }
  if (kind === "box") {
    return (
      <span role="img" aria-label={KIND_LABELS.box} className={cn("inline-flex shrink-0", className)}>
        <Icon name={BB_BOX_ICON} className="size-3.5" aria-hidden />
      </span>
    );
  }
  return (
    <HugeiconsIcon
      icon={KIND_ICONS[kind]}
      className={cn("size-3.5 shrink-0", className)}
      aria-label={KIND_LABELS[kind]}
      role="img"
    />
  );
}

function matchesQuery(machine: Machine, query: string): boolean {
  return machine.name.toLowerCase().includes(query.trim().toLowerCase());
}

export function selectedMachine(machines: Machine[] | null, selected: string, lookOf?: LookOf): { name: string; kind: MachineKind } {
  const machine = machines?.find((candidate) => machineKey(candidate) === selected);
  if (machine) return { name: machine.name, kind: kindOf(machine, lookOf) };
  return selected === SERVER_MACHINE
    ? { name: "This bb server", kind: "server" }
    : { name: "Machine", kind: "machine" };
}

export function MachinePicker({
  machines,
  selected,
  onSelect,
  onOpen,
  lookOf,
}: {
  machines: Machine[] | null;
  selected: string;
  onSelect: (machineId: string) => void;
  onOpen: () => void;
  lookOf?: LookOf;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const flat = useMemo(
    () => (machines ?? []).filter((machine) => matchesQuery(machine, query)),
    [machines, query],
  );
  const current = selectedMachine(machines, selected, lookOf);

  const activeIndex = Math.min(highlighted, Math.max(0, flat.length - 1));

  const choose = (machine: Machine) => {
    onSelect(machineKey(machine));
    setOpen(false);
  };

  const moveHighlight = (next: number) => {
    const bounded = Math.max(0, Math.min(flat.length - 1, next));
    setHighlighted(bounded);
    listRef.current
      ?.querySelector(`[data-machine-index="${bounded}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(activeIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const machine = flat[activeIndex];
      if (machine) choose(machine);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          onOpen();
          setQuery("");
          setHighlighted(Math.max(0, (machines ?? []).findIndex((machine) => machineKey(machine) === selected)));
        }
      }}
    >
      <PopoverTrigger
        aria-label="Machine"
        className="flex h-6 min-w-0 max-w-full shrink items-center gap-1 rounded-md px-1.5 text-xs font-medium text-sidebar-foreground hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50 data-[state=open]:bg-sidebar-accent"
      >
        <KindIcon kind={current.kind} className="text-muted-foreground" />
        <MiddleTruncate text={current.name} />
        <Icon name="ChevronDown" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" side="bottom" onEscapeKeyDown={(event) => event.stopPropagation()}>
        <div className="border-b border-border p-1">
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlighted(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search machines"
            aria-label="Search machines"
            aria-controls="bb-box-monitor-machine-list"
            className="h-7 w-full rounded-sm bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
          />
        </div>
        <div
          id="bb-box-monitor-machine-list"
          ref={listRef}
          role="listbox"
          aria-label="Machines"
          className="max-h-56 overflow-y-auto p-1"
        >
          {machines === null ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading machines</p>
          ) : flat.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No machines match.</p>
          ) : (
            flat.map((machine, itemIndex) => {
              const isSelected = machineKey(machine) === selected;
              return (
                <button
                  key={machine.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-machine-index={itemIndex}
                  onMouseMove={() => setHighlighted(itemIndex)}
                  onClick={() => choose(machine)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground outline-none",
                    itemIndex === activeIndex && "bg-state-hover",
                  )}
                >
                  <KindIcon kind={kindOf(machine, lookOf)} className="text-muted-foreground" />
                  <span className="flex min-w-0 flex-1"><MiddleTruncate text={machine.name} /></span>
                  {isSelected ? <Icon name="Check" className="size-3.5 shrink-0" aria-hidden /> : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
