// Resize, for a box in the Box panel and one of your machines in settings' Machines (061): a preset or cores, memory and disk
// within the kind's largest, each part's way as the box's backend changes it, and the room on its host, checked as the person
// chooses. Live parts change at once. A part that needs a restart asks first, in the record's words, and threads working on the
// box are named before it goes ahead anyway. Refusals show plainly, in bb-box's own words.

import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { GpuPart, ResizeWay, Resizing, SizePart } from "../backends/types.ts";
import type { Contract, GpuChangeView, ResizeResult, ThreadOnBox } from "../plugin/contract.ts";
import type { BoxView, ResizeView, SizeView } from "../plugin/views.ts";
import { gpuProgramsWords } from "../plugin/gpu-page.ts";
import { FormSection, MenuSelect, OptionCard } from "./box-form.tsx";
import { useBoxesNav } from "./box-nav.tsx";
import { boxPage } from "./box-route.ts";
import { gpuAmount, gpuExplanation, gpuWaysLine, GPU_MENU_LABELS, withGpuPrograms } from "./gpu-choice.ts";
import { useMonitorSnapshot } from "./monitor/use-snapshot.ts";
import { message } from "./common.tsx";
import { ThreadChips, workingOnWords } from "./thread-chips.tsx";
import { LargestLine, type AskedParts } from "./largest-line.tsx";
import { withoutRaiseLargest } from "../core/largest-words.ts";

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
  return withoutRaiseLargest(text.replace(/\s*bb-box changed nothing\.\s*$/, ""));
}

function whole(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 ? value : undefined;
}

function askedParts(fields: Fields, ways: Resizing | null): AskedParts {
  const changeable = (part: SizePart, text: string) => ((ways?.[part] ?? "no") === "no" ? undefined : whole(text));
  return { cores: changeable("cores", fields.cores), memoryGiB: changeable("memory", fields.memoryGiB), diskGiB: changeable("disk", fields.diskGiB) };
}

function fieldsOf(size: SizeView | null | undefined): Fields {
  return { cores: size ? String(size.cores) : "", memoryGiB: size ? String(Math.round(size.memoryGiB)) : "", diskGiB: size?.diskGiB != null ? String(size.diskGiB) : "" };
}

/**
 * The request for a choice: a preset, or the parts typed. A part as the box has it is left out, so the box keeps it exactly, as
 * memory read back from a guest may not be a whole number of GiB; an empty disk leaves the disk as it is. Null when a part typed
 * is not a whole number.
 */
function requestOf(choice: string, fields: Fields, now: Fields, held: string | null): Request | null {
  if (held !== null && choice === held) return {};
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

/** The preset whose cores and memory are exactly the box's, if one is. */
function presetOfSize(presets: ResizeResult["presets"], size: SizeView | null | undefined): string | null {
  if (!size) return null;
  return presets.find((preset) => preset.cores === size.cores && preset.memoryGiB === size.memoryGiB)?.name ?? null;
}

/** How long after a resize ends its row still says how it went, for a panel that reloaded while it ran. */
export const RESIZE_NOTE_MS = 2 * 60_000;

/** How long a resize asked for in this page's dialog keeps its row quiet, for a refusal that never began one. */
const ASKED_QUIET_MS = 15 * 60_000;

/** The boxes whose dialog asked for a resize in this page: their last resize's start then, and when it asked. The dialog says how a later one went. */
const askedInThisPage = new Map<string, { readonly before: number; readonly askedAt: number }>();

/** For tests: forgets the resizes this page asked for. */
export function forgetResizesAsked(): void {
  askedInThisPage.clear();
}

function endOf(resize: ResizeView): number {
  return resize.at + (resize.ms ?? 0);
}

function tookWords(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 120 ? `, in ${seconds} s` : `, in ${Math.round(seconds / 60)} min`;
}

/** "Resized to 4 cores · 8 GiB · 64 GiB disk after a restart, in 15 s.", or why it was not. */
export function resizeNoteWords(resize: ResizeView, ways: Resizing | null): { readonly text: string; readonly failed: boolean } {
  const to = words(resize.to, ways);
  if (resize.state === "failed") return { text: `Not resized to ${to}${resize.error ? `: ${checkWords(resize.error)}` : "."}`, failed: true };
  return { text: `Resized to ${to} ${resize.restart ? "after a restart" : "live"}${tookWords(resize.ms)}.`, failed: false };
}

/** Whether this page's dialog asked for `resize`, and so said how it went. */
function askedHere(boxId: string, resize: ResizeView): boolean {
  const asked = askedInThisPage.get(boxId);
  if (!asked) return false;
  if (Date.now() - asked.askedAt > ASKED_QUIET_MS) {
    askedInThisPage.delete(boxId);
    return false;
  }
  return resize.at > asked.before;
}

/**
 * How a box's last resize went, on its row, until two minutes after it ended: for a panel that reloaded while the dialog
 * waited, as for a deploy, or a resize an agent made. Quiet while `dialogOpen`, and for a resize this page's dialog asked for,
 * which said how it went. BB's panel can mount a row more than once, so each mount says it again within those minutes.
 */
export function useResizeNote(box: BoxView, dialogOpen: boolean): { readonly text: string; readonly failed: boolean } | null {
  const last = box.lastResize ?? null;
  const ended = last && last.state !== "resizing" ? last : null;
  const left = ended ? endOf(ended) + RESIZE_NOTE_MS - Date.now() : 0;
  const [, expire] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => expire((count) => count + 1), left);
    return () => clearTimeout(timer);
  }, [ended?.at, ended?.state, left > 0]);
  if (!ended || left <= 0 || dialogOpen || askedHere(box.id, ended)) return null;
  return resizeNoteWords(ended, box.resizing ?? null);
}

type Step = { readonly at: "pick" } | { readonly at: "confirm"; readonly down: number | null } | { readonly at: "threads"; readonly threads: readonly ThreadOnBox[] } | { readonly at: "done"; readonly answer: ResizeResult };

/**
 * The Resize dialog for `box`, open while it is not null: a thread's box, by `threadId`, or one of your machines without it.
 * `onResized` runs after a resize changed the box.
 */
export function ResizeDialog({ box, threadId, at = "size", monitorId = null, onClose, onResized }: { box: BoxView | null; threadId?: string; at?: "size" | "gpu"; monitorId?: string | null; onClose: () => void; onResized?: () => void }) {
  const rpc = useRpc<Contract>();
  const [choice, setChoice] = useState<string>(CUSTOM);
  const [fields, setFields] = useState<Fields>(fieldsOf(box?.sizeNow));
  const [answer, setAnswer] = useState<ResizeResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [presetAtOpen, setPresetAtOpen] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ at: "pick" });
  const [gpu, setGpu] = useState<GpuPart>(box?.gpuPart ?? (box?.gpu ? "shared" : "none"));
  const nav = useBoxesNav();
  const monitor = useMonitorSnapshot(monitorId || box?.enrol.hostId || "resize-gpu");
  const asked = useRef(0);
  const firstAnswered = useRef(false);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const call = (input: Request & { gpu?: GpuPart; check?: boolean; restart?: boolean; force?: boolean }) => {
    const { check, restart, force, gpu: askedGpu, ...size } = input;
    const flags = { ...(check ? { check: true } : {}), ...(restart ? { restart: true } : {}), ...(force ? { force: true } : {}) };
    const asked = { ...size, ...(askedGpu ? { gpu: askedGpu } : {}) };
    return threadId !== undefined ? rpc.call("resize", { threadId, box: box!.id, size: asked, ...flags }) : rpc.call("machines.resize", { box: box!.id, size: asked, ...flags });
  };

  // A new box to resize starts from its own size, as Custom, or as the preset it has.
  const open = box?.id ?? null;
  useEffect(() => {
    if (!box) return;
    setChoice(CUSTOM);
    setPresetAtOpen(null);
    firstAnswered.current = false;
    setFields(fieldsOf(box.sizeNow));
    setGpu(box.gpuPart ?? (box.gpu ? "shared" : "none"));
    setAnswer(null);
    setRefusal(null);
    setStep({ at: "pick" });
  }, [open]);

  const request = requestOf(choice, fields, fieldsOf(box?.sizeNow), presetAtOpen);
  const gpuNow: GpuPart = box?.gpuPart ?? (box?.gpu ? "shared" : "none");
  const gpuSent = gpu !== gpuNow ? gpu : undefined;
  const key = JSON.stringify({ request, gpu: gpuSent ?? null });
  // Checks the size chosen, a moment after the last change; an answer to an older choice is dropped.
  useEffect(() => {
    if (!box || !request) return;
    const id = ++asked.current;
    const asOpened = Object.keys(request).length === 0 && !firstAnswered.current;
    setChecking(true);
    const timer = setTimeout(() => {
      call({ ...request, ...(gpuSent ? { gpu: gpuSent } : {}), check: true })
        .catch((error: unknown): ResizeResult => ({ box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null, error: message(error) }))
        .then((checked) => {
          if (asked.current !== id) return;
          setAnswer((last) => ({ ...checked, presets: checked.presets.length ? checked.presets : (last?.presets ?? []), largest: checked.largest ?? last?.largest ?? null }));
          setChecking(false);
          firstAnswered.current = true;
          const same = asOpened ? presetOfSize(checked.presets, box.sizeNow) : null;
          if (same) {
            setPresetAtOpen(same);
            setChoice(same);
          }
        });
    }, RESIZE_CHECK_MS);
    return () => clearTimeout(timer);
  }, [open, key]);

  if (!box) return <AlertDialog open={false} />;
  const presets = answer?.presets ?? [];
  const largest = answer?.largest ?? null;
  const ways = box.resizing ?? null;
  const plan = answer?.error ? null : (answer?.plan ?? null);
  const gpuChange = plan?.gpu && plan.gpu.from !== plan.gpu.to ? plan.gpu : null;
  const gpuRestarts = !!gpuChange && gpuChange.way === "restart" && !gpuChange.stopped && !gpuChange.refusal;
  const restart = !!plan?.parts.some((part) => part.way === "restart") || gpuRestarts;
  /** Nothing asked yet: the box's own size, as the dialog opens. */
  const untouched = (!!request && Object.keys(request).length === 0) || (presetAtOpen !== null && choice === presetAtOpen);
  const unchanged = !!answer && !answer.error && answer.plan === null && !checking && !gpuSent;
  const gpuBlocked = !!gpuChange && (gpuChange.refusal !== null || gpuChange.way === "no");
  const blocked = !request || checking || !answer || !!answer.error || !plan || !plan.room.ok || refusal !== null || gpuBlocked;
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
    askedInThisPage.set(box!.id, { before: box!.lastResize?.at ?? 0, askedAt: Date.now() });
    try {
      const done = await call({ ...request, ...(gpuSent ? { gpu: gpuSent } : {}), ...allow }).catch((error: unknown): ResizeResult => ({ box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null, error: message(error) }));
      if (done.plan?.gpu?.changed && !done.changed) {
        setAnswer(done);
        setStep({ at: "pick" });
        return;
      }
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
  const moving = !!gpuChange && gpuRestarts && gpuChange.from !== "none" && gpuChange.to !== "none" && gpuChange.fromIndex !== gpuChange.toIndex;
  const programs = gpuProgramsWords((monitor.snapshot?.gpus?.processes ?? []).filter((process) => gpuChange?.fromIndex === null || process.card === gpuChange?.fromIndex));
  const gpuWords = gpuChange && !gpuChange.refusal ? withGpuPrograms(gpuExplanation(gpuChange.words), programs) : null;
  const title =
    step.at === "confirm"
      ? moving
        ? `Move ${box.name} to card ${gpuChange?.toIndex ?? "another"}?`
        : gpuRestarts && !plan?.parts.some((part) => part.way === "restart")
          ? `Restart ${box.name} to change its GPU?`
          : `Restart ${box.name} to resize it?`
      : step.at === "threads"
        ? `Restart ${box.name} anyway?`
        : step.at === "done"
          ? `Resized ${box.name}`
          : `Resize ${box.name}`;

  return (
    <AlertDialog open onOpenChange={(next) => !next && close()}>
      <AlertDialogContent
        className="max-h-[90vh] overflow-y-auto shadow-none"
        data-resize-at={at}
        onOpenAutoFocus={(event) => {
          if (at !== "gpu") return;
          const gpu = (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-gpu-section]");
          if (!gpu) return;
          event.preventDefault();
          gpu.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="font-normal">{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {step.at === "confirm"
              ? gpuWords
                ? gpuWords
                : `Everything running in it stops, and ${back(step.down)}.`
              : step.at === "threads"
                ? `${workingOnWords(step.threads, box.name)}. ${step.threads.length === 1 ? "Its" : "Their"} work stops while it restarts.`
                : step.at === "done"
                  ? `It has ${words(step.answer.to ?? step.answer.from!, box.resizing ?? null)} now${step.answer.changed ? (step.answer.box?.lastResize?.restart ? ", after a restart" : ", changed live") : ""}.`
                  : `Now ${box.sizeNow ? words(box.sizeNow, box.resizing ?? null) : "of unknown size"}.`}
          </AlertDialogDescription>
          {step.at === "threads" ? <ThreadChips threads={step.threads} /> : null}
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
              {choice === CUSTOM && largest ? <LargestLine kind={box.kind} largest={largest} asked={askedParts(fields, ways)} onFollow={onClose} /> : null}
            </FormSection>

            {box.gpu || box.resizing?.gpu ? (
              <section data-gpu-section tabIndex={-1} aria-label="GPU" className="space-y-3 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <h3 className="text-xs text-foreground">GPU</h3>
                <MenuSelect
                  label="GPU"
                  value={gpu}
                  options={(["none", "shared", "whole"] as const).filter((part) => part !== "whole" || !box.resizing?.gpu || box.resizing.gpu.share !== "no" || gpuNow === "whole").map((part) => ({ value: part, label: GPU_MENU_LABELS[part] }))}
                  onChange={(value) => {
                    setGpu(value as GpuPart);
                    setRefusal(null);
                  }}
                />
                <p className="min-h-[2lh] text-xs leading-snug text-muted-foreground">{box.resizing?.gpu ? gpuWaysLine(box.resizing.gpu, box.form) : "This box's backend does not change its GPU."}</p>
              </section>
            ) : null}

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
                  {gpuChange ? <GpuRow change={gpuChange} /> : null}
                </ul>
              ) : unchanged && !untouched ? (
                <p className="text-xs text-muted-foreground">Nothing: the box has this size.</p>
              ) : ways ? (
                <p className="text-xs text-muted-foreground">{waysLine(ways)}</p>
              ) : null}
              {gpuChange?.changed ? <p className="text-xs leading-snug text-warning-text">{gpuChange.changed}</p> : null}
              {gpuWords ? <p className={cn("text-xs leading-snug", gpuRestarts ? "text-warning-text" : "text-muted-foreground")}>{gpuWords}</p> : null}
              {refusal !== null || gpuWords ? null : plan && restart ? (
                <p className="text-xs leading-snug text-warning-text">
                  Needs a restart: everything running in {box.name} stops{plan.downSeconds !== null ? `, for about ${plan.downSeconds} s` : ""}.
                </p>
              ) : plan && !gpuChange ? (
                <p className="text-xs leading-snug text-muted-foreground">Changes at once. Everything running in {box.name} carries on.</p>
              ) : null}
              {refusal === null && plan?.room.ok && grows ? <p className="text-xs leading-snug text-muted-foreground">Its host has room for it to grow.</p> : null}
            </FormSection>

            {gpuChange?.refusal ? (
              <div role="alert" className="space-y-2 text-xs leading-snug">
                <p className="text-destructive-text">{gpuChange.refusal}</p>
                <GpuLinks others={gpuChange.others} href={(id) => nav.href(boxPage(id))} onClick={(id) => nav.onLink(boxPage(id))} />
              </div>
            ) : null}
            {refusal !== null ? (
              // The answer to Resize: nothing changed, and why, in bb-box's words.
              <div role="alert" className="space-y-0.5 text-xs leading-snug">
                <p className="text-destructive-text">Not resized</p>
                <p className="text-foreground">{withoutRaiseLargest(refusal)}</p>
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
              <AlertDialogCancel className="font-normal" disabled={applying}>Cancel</AlertDialogCancel>
              <Button
                type="button"
                className="font-normal"
                disabled={blocked || applying || unchanged}
                onClick={() => (restart ? setStep({ at: "confirm", down: plan?.downSeconds ?? null }) : void apply())}
              >
                {applying ? "Resizing…" : restart ? "Resize…" : "Resize"}
              </Button>
            </>
          ) : step.at === "confirm" ? (
            <>
              <Button type="button" variant="outline" className="font-normal" disabled={applying} onClick={() => setStep({ at: "pick" })}>
                Back
              </Button>
              <Button type="button" className="font-normal" disabled={applying} onClick={() => void apply({ restart: true })}>
                {applying ? "Restarting…" : moving ? "Move and restart" : gpuChange?.installs ? "Install and restart" : "Restart and resize"}
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

function GpuRow({ change }: { readonly change: GpuChangeView }) {
  const way = change.stopped && change.way === "live" ? "While stopped" : change.way === "no" ? "Cannot change" : WAY_WORDS[change.way];
  const quiet = way === "Live" || way === "While stopped";
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-2">
      <span className="text-muted-foreground">GPU</span>
      <span className="min-w-0 truncate text-foreground">
        {gpuAmount(change.from, change.fromIndex)} → {gpuAmount(change.to, change.toIndex)}
      </span>
      <span className={cn("text-right", quiet ? "text-muted-foreground" : "text-warning-text")}>{way}</span>
    </li>
  );
}

function GpuLinks({ others, href, onClick }: { readonly others: GpuChangeView["others"]; readonly href: (id: string) => string; readonly onClick: (id: string) => (event: MouseEvent<HTMLAnchorElement>) => void }) {
  if (!others.length) return null;
  return (
    <ul className="space-y-1">
      {others.map((other) => (
        <li key={other.box ?? other.name}>
          {other.box ? (
            <a className="text-foreground underline" href={href(other.box)} onClick={onClick(other.box)}>
              {other.name}
            </a>
          ) : (
            <span>{other.name}</span>
          )}
          {other.stopped ? ", stopped" : ""}
        </li>
      ))}
    </ul>
  );
}
