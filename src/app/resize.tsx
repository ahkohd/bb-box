// Resize, for a box in the Box panel and one of your machines in settings' Machines (061): a preset or cores, memory and disk
// within the kind's largest, each part's way as the box's backend changes it, and the room on its host, checked as the person
// chooses. Live parts change at once. A part that needs a restart asks first, in the record's words, and threads working on the
// box are named before it goes ahead anyway. Refusals show plainly, in bb-box's own words.

import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ResizeWay, Resizing, SizePart } from "../backends/types.ts";
import type { Contract, ResizeResult, ThreadOnBox } from "../plugin/contract.ts";
import type { BoxView, SizeView } from "../plugin/views.ts";
import { FormSection, OptionCard } from "./box-form.tsx";
import { message } from "./common.tsx";

/** How long the dialog waits after a change before it checks the size. */
export const RESIZE_CHECK_MS = 250;

const CUSTOM = "custom";
const PRESET_LABELS: Readonly<Record<string, string>> = { small: "Small", medium: "Medium", large: "Large" };
const PART_LABELS: Readonly<Record<SizePart, string>> = { cores: "Cores", memory: "Memory", disk: "Disk" };
const WAY_WORDS: Readonly<Record<ResizeWay, string>> = { live: "Live", restart: "Restart", no: "Cannot change" };

type Fields = { cores: string; memoryGiB: string; diskGiB: string };
type Request = { preset?: string; cores?: number; memoryGiB?: number; diskGiB?: number };

/** Whether a box can be resized at all: its backend changes a part of its kind's boxes, and it is ready or stopped. */
export function canResize(box: BoxView): boolean {
  const ways = box.resizing;
  return !!ways && (ways.cores !== "no" || ways.memory !== "no" || ways.disk !== "no") && (box.state === "ready" || box.state === "stopped");
}

/** "4 cores · 8 GiB · 24 GiB disk", or the base disk; no disk where the box has none of its own to change, as a Docker box. */
function words(size: SizeView, ways: Resizing | null): string {
  const disk = size.diskGiB !== null ? `${size.diskGiB} GiB disk` : ways?.disk === "no" ? null : "base disk";
  return [`${size.cores} ${size.cores === 1 ? "core" : "cores"}`, `${size.memoryGiB} GiB`, disk].filter(Boolean).join(" · ");
}

/** A part's value as the dialog shows it: memory and disk in GiB, a base disk as "base". */
function amount(part: SizePart, value: number | null): string {
  if (value === null) return "base";
  return part === "cores" ? String(value) : `${value} GiB`;
}

/** "cores", "cores and memory", "cores, memory and disk". */
function listed(parts: readonly string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The ways a box's backend changes each part, in a line, before a size is chosen: "Cores and memory change live; disk with a restart." */
export function waysLine(ways: Resizing): string {
  const all: SizePart[] = ["cores", "memory", "disk"];
  const by = (way: ResizeWay) => all.filter((part) => ways[part] === way);
  const said = [
    by("live").length ? `${listed(by("live"))} live` : "",
    by("restart").length ? `${listed(by("restart"))} with a restart` : "",
  ].filter(Boolean);
  const cannot = by("no");
  const text = `${said.join("; ")}${cannot.length ? `${said.length ? "; " : ""}${listed(cannot)} cannot change` : ""}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.${ways.disk !== "no" ? " The disk only grows." : ""}`;
}

/** A refusal while the person chooses: nothing was tried, so it does not say that nothing changed. */
export function checkWords(text: string): string {
  return text.replace(/\s*bb-box changed nothing\.\s*$/, "");
}

function whole(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 ? value : undefined;
}

function fieldsOf(size: SizeView | null | undefined): Fields {
  return { cores: size ? String(size.cores) : "", memoryGiB: size ? String(Math.round(size.memoryGiB)) : "", diskGiB: size?.diskGiB != null ? String(size.diskGiB) : "" };
}

/**
 * The request for a choice: a preset, or the parts typed. A part as the box has it is left out, so the box keeps it exactly, as
 * memory read back from a guest may not be a whole number of GiB; an empty disk leaves the disk as it is. Null when a part typed
 * is not a whole number.
 */
function requestOf(choice: string, fields: Fields, now: Fields): Request | null {
  if (choice !== CUSTOM) return { preset: choice };
  const request: { -readonly [K in keyof Request]: Request[K] } = {};
  for (const name of ["cores", "memoryGiB", "diskGiB"] as const) {
    const text = fields[name].trim();
    if (text === now[name] || (name === "diskGiB" && text === "")) continue;
    const value = whole(text);
    if (value === undefined) return null;
    request[name] = value;
  }
  return request;
}

type Step = { readonly at: "pick" } | { readonly at: "confirm"; readonly down: number | null } | { readonly at: "threads"; readonly threads: readonly ThreadOnBox[] } | { readonly at: "done"; readonly answer: ResizeResult };

/**
 * The Resize dialog for `box`, open while it is not null: a thread's box, by `threadId`, or one of your machines without it.
 * `onResized` runs after a resize changed the box.
 */
export function ResizeDialog({ box, threadId, onClose, onResized }: { box: BoxView | null; threadId?: string; onClose: () => void; onResized?: () => void }) {
  const rpc = useRpc<Contract>();
  const [choice, setChoice] = useState<string>(CUSTOM);
  const [fields, setFields] = useState<Fields>(fieldsOf(box?.sizeNow));
  const [answer, setAnswer] = useState<ResizeResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ at: "pick" });
  const asked = useRef(0);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const call = (input: Request & { check?: boolean; restart?: boolean; force?: boolean }) => {
    const { check, restart, force, ...size } = input;
    const flags = { ...(check ? { check: true } : {}), ...(restart ? { restart: true } : {}), ...(force ? { force: true } : {}) };
    return threadId !== undefined ? rpc.call("resize", { threadId, box: box!.id, size, ...flags }) : rpc.call("machines.resize", { box: box!.id, size, ...flags });
  };

  // A new box to resize starts from its own size, as Custom, or as the preset it has.
  const open = box?.id ?? null;
  useEffect(() => {
    if (!box) return;
    setChoice(CUSTOM);
    setFields(fieldsOf(box.sizeNow));
    setAnswer(null);
    setRefusal(null);
    setStep({ at: "pick" });
  }, [open]);

  const request = requestOf(choice, fields, fieldsOf(box?.sizeNow));
  const key = JSON.stringify(request);
  // Checks the size chosen, a moment after the last change; an answer to an older choice is dropped.
  useEffect(() => {
    if (!box || !request) return;
    const id = ++asked.current;
    setChecking(true);
    const timer = setTimeout(() => {
      call({ ...request, check: true })
        .catch((error: unknown): ResizeResult => ({ box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null, error: message(error) }))
        .then((checked) => {
          if (asked.current !== id) return;
          setAnswer((last) => ({ ...checked, presets: checked.presets.length ? checked.presets : (last?.presets ?? []), largest: checked.largest ?? last?.largest ?? null }));
          setChecking(false);
        });
    }, RESIZE_CHECK_MS);
    return () => clearTimeout(timer);
  }, [open, key]);

  if (!box) return <AlertDialog open={false} />;
  const presets = answer?.presets ?? [];
  const largest = answer?.largest ?? null;
  const ways = box.resizing ?? null;
  const plan = answer?.error ? null : (answer?.plan ?? null);
  const restart = !!plan?.parts.some((part) => part.way === "restart");
  /** Nothing asked yet: the box's own size, as the dialog opens. */
  const untouched = !!request && Object.keys(request).length === 0;
  const unchanged = !!answer && !answer.error && answer.plan === null && !checking;
  const blocked = !request || checking || !answer || !!answer.error || !plan || !plan.room.ok || refusal !== null;
  const grows = !!plan?.parts.some((part) => part.from === null || part.to > part.from);
  const choices = [...presets.map((preset) => preset.name), CUSTOM];
  const index = Math.max(0, choices.indexOf(choice));
  const pickChoice = (next: string, focus = false) => {
    setChoice(next);
    setRefusal(null);
    if (next === CUSTOM && choice !== CUSTOM) {
      const preset = presets.find((candidate) => candidate.name === choice);
      if (preset) setFields({ ...fieldsOf(preset), diskGiB: fields.diskGiB });
    }
    if (focus) options.current[choices.indexOf(next)]?.focus();
  };
  const arrows = (event: KeyboardEvent<HTMLElement>) => {
    const move = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!move) return;
    event.preventDefault();
    pickChoice(choices[(index + move + choices.length) % choices.length]!, true);
  };

  /** Makes the change: live at once, or after the person said yes to a restart, or to threads stopping. */
  const apply = async (allow: { restart?: boolean; force?: boolean } = {}) => {
    if (!request) return;
    setApplying(true);
    setRefusal(null);
    try {
      const done = await call({ ...request, ...allow }).catch((error: unknown): ResizeResult => ({ box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null, error: message(error) }));
      if (done.threads?.length) setStep({ at: "threads", threads: done.threads });
      else if (done.needsRestart) setStep({ at: "confirm", down: plan?.downSeconds ?? null });
      else if (done.error) {
        setRefusal(done.error);
        setStep({ at: "pick" });
      } else {
        setStep({ at: "done", answer: done });
        if (done.changed) onResized?.();
      }
    } finally {
      setApplying(false);
    }
  };
  const back = (seconds: number | null) => (seconds !== null ? `it is back in about ${seconds} s` : "it is back once it has started again");

  const field = (name: keyof Fields, part: SizePart, label: string, limit: number | null) => {
    const way = ways?.[part] ?? "no";
    const now = box.sizeNow;
    const floor = part === "disk" && now?.diskGiB != null ? now.diskGiB : null;
    return (
      <label className="flex min-w-0 flex-col gap-1 text-xs leading-snug text-subtle-foreground">
        <span>{label}</span>
        <Input
          inputMode="numeric"
          aria-label={label}
          className="h-7 px-2 text-xs"
          value={fields[name]}
          placeholder={part === "disk" ? "as now" : ""}
          disabled={way === "no"}
          aria-invalid={(fields[name].trim() !== "" || part !== "disk") && whole(fields[name]) === undefined ? true : undefined}
          onChange={(event) => {
            setFields((current) => ({ ...current, [name]: event.target.value }));
            setRefusal(null);
          }}
        />
        <span>{way === "no" ? "Cannot change" : floor !== null && limit !== null ? `${floor} to ${limit}` : limit !== null ? `up to ${limit}` : ""}</span>
      </label>
    );
  };

  const close = () => {
    if (!applying) onClose();
  };
  const title =
    step.at === "confirm" ? `Restart ${box.name} to resize it?` : step.at === "threads" ? `Restart ${box.name} anyway?` : step.at === "done" ? `Resized ${box.name}` : `Resize ${box.name}`;

  return (
    <AlertDialog open onOpenChange={(next) => !next && close()}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {step.at === "confirm"
              ? `Everything running in it stops, and ${back(step.down)}.`
              : step.at === "threads"
                ? `${step.threads.map((thread) => thread.title ?? thread.id).join(", ")} ${step.threads.length === 1 ? "is" : "are"} working on it, and ${step.threads.length === 1 ? "its" : "their"} work stops while it restarts.`
                : step.at === "done"
                  ? `It has ${words(step.answer.to ?? step.answer.from!, box.resizing ?? null)} now${step.answer.changed ? (step.answer.box?.lastResize?.restart ? ", after a restart" : ", changed live") : ""}.`
                  : `Now ${box.sizeNow ? words(box.sizeNow, box.resizing ?? null) : "of unknown size"}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {step.at === "pick" ? (
          <div className="space-y-5">
            <FormSection title="Size" description={presets.length ? "A preset sets cores and memory, and leaves the disk as it is." : undefined}>
              <div role="radiogroup" aria-label="Size" className="flex flex-wrap gap-2" onKeyDown={arrows}>
                {choices.map((candidate, position) => {
                  const preset = presets.find((item) => item.name === candidate) ?? null;
                  return (
                    <OptionCard
                      key={candidate}
                      optionRef={(element) => {
                        options.current[position] = element;
                      }}
                      title={PRESET_LABELS[candidate] ?? (candidate === CUSTOM ? "Custom" : candidate)}
                      words={preset ? `${preset.cores} cores · ${preset.memoryGiB} GiB` : largest ? `up to ${largest.cores} cores` : null}
                      selected={candidate === choice}
                      onClick={() => pickChoice(candidate)}
                    />
                  );
                })}
              </div>
              {choice === CUSTOM ? (
                <div className="grid grid-cols-3 gap-3">
                  {field("cores", "cores", "Cores", largest?.cores ?? null)}
                  {field("memoryGiB", "memory", "Memory, GiB", largest?.memoryGiB ?? null)}
                  {field("diskGiB", "disk", "Disk, GiB", largest?.diskGiB ?? null)}
                </div>
              ) : null}
            </FormSection>

            <FormSection title="What changes">
              {plan ? (
                <ul aria-label="What changes" className="space-y-1 text-xs">
                  {plan.parts.map((part) => (
                    <li key={part.part} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-2">
                      <span className="text-muted-foreground">{PART_LABELS[part.part]}</span>
                      <span className="min-w-0 truncate text-foreground">
                        {amount(part.part, part.from)} → {amount(part.part, part.to)}
                      </span>
                      <span className={cn("text-right", part.way === "live" ? "text-muted-foreground" : "text-warning-text")}>{WAY_WORDS[part.way]}</span>
                    </li>
                  ))}
                </ul>
              ) : unchanged && !untouched ? (
                <p className="text-xs text-muted-foreground">Nothing: the box has this size.</p>
              ) : ways ? (
                <p className="text-xs text-muted-foreground">{waysLine(ways)}</p>
              ) : null}
              {refusal !== null ? null : plan && restart ? (
                <p className="text-xs leading-snug text-warning-text">
                  Needs a restart: everything running in {box.name} stops{plan.downSeconds !== null ? `, for about ${plan.downSeconds} s` : ""}.
                </p>
              ) : plan ? (
                <p className="text-xs leading-snug text-muted-foreground">Changes at once. Everything running in {box.name} carries on.</p>
              ) : null}
              {refusal === null && plan?.room.ok && grows ? <p className="text-xs leading-snug text-muted-foreground">Its host has room for it to grow.</p> : null}
            </FormSection>

            {refusal !== null ? (
              // The answer to Resize: nothing changed, and why, in bb-box's words.
              <div role="alert" className="space-y-0.5 text-xs leading-snug">
                <p className="font-medium text-destructive-text">Not resized</p>
                <p className="text-destructive-text">{refusal}</p>
              </div>
            ) : answer?.error || (plan && !plan.room.ok) ? (
              // What stands in the way of the size chosen, before anything is tried.
              <p role="alert" className="text-xs leading-snug text-destructive-text">
                {checkWords(answer?.error ?? plan?.room.message ?? `There is no room for ${box.name} to grow.`)}
              </p>
            ) : null}
          </div>
        ) : step.at === "done" && step.answer.machine ? (
          <p className="text-xs leading-snug text-muted-foreground">{step.answer.machine}</p>
        ) : null}

        <AlertDialogFooter>
          {step.at === "pick" ? (
            <>
              <AlertDialogCancel disabled={applying}>Cancel</AlertDialogCancel>
              <Button
                type="button"
                disabled={blocked || applying || unchanged}
                onClick={() => (restart ? setStep({ at: "confirm", down: plan?.downSeconds ?? null }) : void apply())}
              >
                {applying ? "Resizing…" : restart ? "Resize…" : "Resize"}
              </Button>
            </>
          ) : step.at === "confirm" ? (
            <>
              <Button type="button" variant="outline" disabled={applying} onClick={() => setStep({ at: "pick" })}>
                Back
              </Button>
              <Button type="button" disabled={applying} onClick={() => void apply({ restart: true })}>
                {applying ? "Restarting…" : "Restart and resize"}
              </Button>
            </>
          ) : step.at === "threads" ? (
            <>
              <Button type="button" variant="outline" disabled={applying} onClick={() => setStep({ at: "pick" })}>
                Back
              </Button>
              <Button type="button" className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={applying} onClick={() => void apply({ restart: true, force: true })}>
                {applying ? "Restarting…" : "Restart anyway"}
              </Button>
            </>
          ) : (
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
