import { useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FormSection, MenuSelect, OptionCard } from "@/src/app/box-form.tsx";
import { THREADS, type FakeBox, type GpuPart } from "./data";
import { go } from "./nav";
import { backendOf, capital, cardName, cardsOf, gib, GPU_WORDS, holders, listed, planGpu, waitingFor, type GpuPlan, type GpuWay, type World } from "./placement";
import { useStore } from "./store";

type SizeChoice = "now" | "small" | "medium" | "large";
const SIZES: Readonly<Record<Exclude<SizeChoice, "now">, { cores: number; memoryGiB: number }>> = { small: { cores: 2, memoryGiB: 4 }, medium: { cores: 4, memoryGiB: 16 }, large: { cores: 16, memoryGiB: 64 } };
const SIZE_LABELS: Readonly<Record<SizeChoice, string>> = { now: "As now", small: "Small", medium: "Medium", large: "Large" };
const WAY_WORDS: Readonly<Record<Exclude<GpuWay, "same">, string>> = { live: "Live", restart: "Restart", stopped: "While stopped", no: "Cannot change" };
const INSTALL_SECONDS = 60;

function gpuAmount(gpu: GpuPart, card: { index: number } | null): string {
  if (gpu === "none") return "none";
  if (!card) return gpu === "whole" ? "whole card" : "shared";
  return gpu === "whole" ? `whole card ${card.index}` : `shared, card ${card.index}`;
}

export function gpuWaysLine(box: FakeBox): string {
  return backendOf(box.backend).canChangeDevices
    ? "Shared and whole card switch at once where the card allows it. Adding, removing or moving a card restarts the box; a stopped box stays stopped."
    : "Shared and whole card switch at once. On Docker a GPU cannot be added, removed or moved, and every box with Docker in it can open every card.";
}

export function gpuProgramsWords(box: FakeBox): string {
  const open = box.processes.map((process) => `${process.name} (${process.pid})`);
  if (!open.length) return "";
  return `: ${listed(open)} ${open.length === 1 ? "has" : "have"} the GPU open`;
}

function andThey(boxes: readonly FakeBox[]): string {
  return boxes.length === 1 ? `${boxes[0]!.name} (stopped) is` : `${listed(boxes.map((each) => each.name))} (stopped) are`;
}

export function gpuChangeWords(world: World, box: FakeBox, plan: GpuPlan): string | null {
  const backend = backendOf(box.backend);
  const seconds = backend.restartSeconds + (plan.installs ? INSTALL_SECONDS : 0);
  const about = `in about ${seconds} s`;
  const yielded = plan.yields.length ? ` ${capital(andThey(plan.yields))} placed on another card when ${plan.yields.length === 1 ? "it next starts" : "they next start"}.` : "";
  if (plan.way === "same" || plan.way === "no") return null;
  if (plan.way === "stopped") {
    if (plan.to === "none") return `${box.name} is stopped: it has no GPU from its next start. Nothing starts now.`;
    if (plan.to === "whole") return `${box.name} is stopped: ${plan.toCard ? cardName(plan.toCard) : "its card"} is its own from now, and it has it when it next starts.${yielded} Nothing starts now.`;
    return `${box.name} is stopped: it goes on a card with room when it next starts. Nothing starts now.`;
  }
  if (plan.way === "live" && plan.to === "whole") {
    const fence = backend.fencesWhole ? "" : " On Docker every box with Docker in it can still open the card.";
    return `${capital(cardName(plan.fromCard!))} becomes ${box.name}'s alone. No other box is placed on it while ${box.name} holds it. Nothing in ${box.name} stops.${yielded}${fence}`;
  }
  if (plan.way === "live") {
    const most = world.settings[box.backend].boxesPerCard;
    return `${capital(cardName(plan.fromCard!))} opens to other boxes${most > 0 ? `, up to ${most}` : ""}. They share its memory and its time. Nothing in ${box.name} stops.`;
  }
  if (plan.to === "none") {
    return `${box.name} restarts without ${cardName(plan.fromCard!)}, ${about}. Everything running in it stops${gpuProgramsWords(box)}.${box.desktop ? " Its desktop is then drawn by the CPU." : ""}`;
  }
  const card = plan.toCard!;
  if (plan.from === "none") {
    const others = holders(world, card, box.id);
    const company = plan.to === "whole" ? "to itself" : others.length ? `shared with ${others.length === 1 ? "1 other box" : `${others.length} other boxes`}` : "shared, with no other box on it now";
    const install = plan.installs ? `, gets NVIDIA's userspace ${plan.installs}` : "";
    const drawn = plan.installs && box.desktop ? " Its desktop is then drawn by the GPU." : "";
    return `${box.name} restarts${install} and gets ${cardName(card)}, ${card.model} with ${gib(card.memoryMiB)}, ${company}, ${about}. Everything running in it stops.${drawn}`;
  }
  return `${capital(cardName(plan.fromCard!))} has ${listed(plan.others.map((other) => other.name))} running. bb-box moves ${box.name} to ${cardName(card)}, which has none, ${about}. Everything running in ${box.name} stops${gpuProgramsWords(box)}.${yielded}`;
}

function namedIn(world: World, box: FakeBox): FakeBox[] {
  return cardsOf(world, box.backend).flatMap((card) => holders(world, card, box.id));
}

function BoxLinks({ boxes, onGo }: { boxes: readonly FakeBox[]; onGo: (id: string) => void }) {
  if (!boxes.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {boxes.map((other) => (
        <button key={other.id} type="button" onClick={() => onGo(other.id)} className="inline-flex h-6 cursor-pointer items-center rounded-full border border-border bg-background px-2 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {other.name}
          {other.state === "stopped" ? <span className="pl-1 text-muted-foreground">stopped</span> : null}
        </button>
      ))}
    </div>
  );
}

function Row({ label, from, to, way }: { label: string; from: string; to: string; way: Exclude<GpuWay, "same"> }) {
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-foreground">
        {from} → {to}
      </span>
      <span className={cn("text-right", way === "restart" ? "text-warning-text" : way === "no" ? "text-destructive-text" : "text-muted-foreground")}>{WAY_WORDS[way]}</span>
    </li>
  );
}

type Step = "pick" | "confirm";

export function ResizeDialog({ box, onClose }: { box: FakeBox; onClose: () => void }) {
  const store = useStore();
  const [choice, setChoice] = useState<SizeChoice>("now");
  const [gpu, setGpu] = useState<GpuPart>(box.gpu);
  const [step, setStep] = useState<Step>("pick");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [shown, setShown] = useState<{ way: GpuWay; toCard: string | null } | null>(null);
  const size = choice === "now" ? { cores: box.cores, memoryGiB: box.memoryGiB } : SIZES[choice];
  const plan = planGpu(store, box, gpu);
  const wholeOffered = store.settings[box.backend].wholeCards || box.gpu === "whole";
  const sizeChanges = size.cores !== box.cores || size.memoryGiB !== box.memoryGiB;
  const nothing = !sizeChanges && plan.way === "same";
  const restart = plan.way === "restart";
  const blocked = plan.way === "no" || nothing;
  const words = gpuChangeWords(store, box, plan);
  const moving = restart && plan.from !== "none" && plan.to !== "none";
  const thread = box.thread !== "you" ? THREADS[box.thread] : null;
  const toBox = (id: string) => {
    onClose();
    go({ page: "box", id });
  };
  const apply = (expect: { way: GpuWay; toCard: string | null }) => {
    const done = store.resize(box.id, { ...size, gpu, expect });
    if (!done.ok) {
      setRefusal(done.why);
      setStep("pick");
      return;
    }
    onClose();
  };
  const choices: SizeChoice[] = ["now", "small", "medium", "large"];
  const yielding = plan.toCard ? waitingFor(store, plan.toCard, box.id) : [];
  let body: ReactNode = null;
  if (step === "pick") {
    body = (
      <div className="space-y-5">
        <FormSection title="Size" description="A preset sets cores and memory, and leaves the disk as it is.">
          <div role="radiogroup" aria-label="Size" className="grid grid-cols-2 gap-2">
            {choices.map((name) => {
              const each = name === "now" ? { cores: box.cores, memoryGiB: box.memoryGiB } : SIZES[name];
              return <OptionCard key={name} title={SIZE_LABELS[name]} words={`${each.cores} cores · ${each.memoryGiB} GiB`} selected={name === choice} onClick={() => setChoice(name)} />;
            })}
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">GPU</p>
            <MenuSelect
              label="GPU"
              value={gpu}
              options={(["none", "shared", "whole"] as const).filter((value) => value !== "whole" || wholeOffered).map((value) => ({ value, label: GPU_WORDS[value] }))}
              onChange={(value) => {
                setGpu(value as GpuPart);
                setRefusal(null);
              }}
            />
            <p className="text-xs leading-snug text-subtle-foreground">{gpuWaysLine(box)}</p>
          </div>
        </FormSection>
        <FormSection title="What changes">
          {nothing ? (
            <p className="text-xs text-muted-foreground">Nothing: the box has this size.</p>
          ) : (
            <ul aria-label="What changes" className="space-y-1 text-xs">
              {size.cores !== box.cores ? <Row label="Cores" from={String(box.cores)} to={String(size.cores)} way={box.state === "stopped" ? "stopped" : "live"} /> : null}
              {size.memoryGiB !== box.memoryGiB ? <Row label="Memory" from={`${box.memoryGiB} GiB`} to={`${size.memoryGiB} GiB`} way={box.state === "stopped" ? "stopped" : "live"} /> : null}
              {plan.way !== "same" ? <Row label="GPU" from={gpuAmount(plan.from, plan.fromCard)} to={plan.way === "no" ? GPU_WORDS[plan.to].toLowerCase() : gpuAmount(plan.to, plan.toCard)} way={plan.way} /> : null}
            </ul>
          )}
          {words ? <p className={cn("text-xs leading-snug", restart ? "text-warning-text" : "text-muted-foreground")}>{words}</p> : null}
          {!nothing && plan.way === "same" ? <p className="text-xs leading-snug text-muted-foreground">{box.state === "stopped" ? `${box.name} stays stopped.` : `Changes at once. Everything running in ${box.name} carries on.`}</p> : null}
        </FormSection>
        {plan.way === "no" || refusal ? (
          <div role="alert" className="space-y-2 text-xs leading-snug">
            <p className={refusal && plan.way !== "no" ? "text-warning-text" : "text-destructive-text"}>{refusal ?? plan.person}</p>
            {plan.way === "no" && backendOf(box.backend).canChangeDevices ? <BoxLinks boxes={namedIn(store, box)} onGo={toBox} /> : null}
          </div>
        ) : null}
      </div>
    );
  }
  const title = step === "confirm" ? (moving ? `Move ${box.name} to ${plan.toCard ? cardName(plan.toCard) : "another card"}?` : `Restart ${box.name} to change its GPU?`) : `Resize ${box.name}`;
  const description =
    step === "confirm"
      ? `Everything running in it stops${gpuProgramsWords(box)}, and it is back in about ${backendOf(box.backend).restartSeconds + (plan.installs ? INSTALL_SECONDS : 0)} s.${thread ? ` "${thread}" works on it: its work stops while it restarts.` : ""}${yielding.length ? ` ${capital(andThey(yielding))} placed on another card when ${yielding.length === 1 ? "it next starts" : "they next start"}.` : ""}`
      : `Now ${box.cores} cores · ${box.memoryGiB} GiB${box.diskGiB !== null ? ` · ${box.diskGiB} GiB disk` : ""} · GPU ${gpuAmount(box.gpu, plan.fromCard)}${box.state === "stopped" ? " · stopped" : ""}.`;
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto shadow-none">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base font-normal">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {body}
        <AlertDialogFooter>
          {step === "pick" ? (
            <>
              <AlertDialogCancel className="font-normal">Cancel</AlertDialogCancel>
              <Button
                type="button"
                className="font-normal"
                disabled={blocked}
                onClick={() => {
                  const expect = { way: plan.way, toCard: plan.toCard?.id ?? null };
                  setRefusal(null);
                  if (restart) {
                    setShown(expect);
                    setStep("confirm");
                  } else apply(expect);
                }}
              >
                {restart ? "Resize…" : "Resize"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" className="font-normal" onClick={() => setStep("pick")}>
                Back
              </Button>
              <Button type="button" className="font-normal" onClick={() => apply(shown ?? { way: plan.way, toCard: plan.toCard?.id ?? null })}>
                {moving ? "Move and restart" : plan.installs ? "Install and restart" : "Restart and resize"}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
