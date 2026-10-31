import { useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FormSection, MenuSelect, OptionCard } from "@/src/app/box-form.tsx";
import { THREADS, type FakeBox, type GpuPart } from "./data";
import { go } from "./nav";
import { backendOf, boxesOnCard, capital, cardName, cardsOf, gib, GPU_WORDS, listed, planGpu, type GpuPlan, type GpuWay, type World } from "./placement";
import { useStore } from "./store";

type SizeChoice = "now" | "small" | "medium" | "large";
const SIZES: Readonly<Record<Exclude<SizeChoice, "now">, { cores: number; memoryGiB: number }>> = { small: { cores: 2, memoryGiB: 4 }, medium: { cores: 4, memoryGiB: 16 }, large: { cores: 16, memoryGiB: 64 } };
const SIZE_LABELS: Readonly<Record<SizeChoice, string>> = { now: "As now", small: "Small", medium: "Medium", large: "Large" };
const WAY_WORDS: Readonly<Record<Exclude<GpuWay, "same">, string>> = { live: "Live", restart: "Restart", no: "Cannot change" };

function gpuAmount(gpu: GpuPart, card: { index: number } | null): string {
  if (gpu === "none") return "none";
  return gpu === "whole" ? `whole card ${card?.index ?? "?"}` : `shared, card ${card?.index ?? "?"}`;
}

export function gpuWaysLine(box: FakeBox): string {
  return backendOf(box.backend).canChangeDevices
    ? "Shared and whole card switch at once where the card allows it. Adding, removing or moving a card restarts the box."
    : "Shared and whole card switch at once. On Docker a GPU cannot be added, removed or moved: a container's devices are fixed when it is made.";
}

export function gpuChangeWords(world: World, box: FakeBox, plan: GpuPlan): string | null {
  const backend = backendOf(box.backend);
  const about = `in about ${backend.restartSeconds} s`;
  if (plan.way === "same" || plan.way === "no") return null;
  if (plan.way === "live" && plan.to === "whole") {
    const fence = backend.fencesWhole ? "" : " On Docker this is a promise among bb-box's boxes: a box with Docker in it can still open the card.";
    return `${capital(cardName(plan.fromCard!))} becomes ${box.name}'s alone. No other box is placed on it while ${box.name} has it. Nothing in ${box.name} stops.${fence}`;
  }
  if (plan.way === "live") {
    const most = world.settings[box.backend].boxesPerCard;
    return `${capital(cardName(plan.fromCard!))} opens to other boxes${most > 0 ? `, up to ${most}` : ""}. They share its memory and its time. Nothing in ${box.name} stops.`;
  }
  if (plan.to === "none") {
    return `${box.name} stops, its card's devices are taken out, and it starts again, ${about}. Programs using the GPU stop.${box.desktop ? " Its desktop is then drawn by the CPU." : ""}`;
  }
  const card = plan.toCard!;
  const others = boxesOnCard(world, card, box.id);
  if (plan.from === "none") {
    const company = plan.to === "whole" ? "to itself" : others.length ? `shared with ${others.length === 1 ? "1 other box" : `${others.length} other boxes`}` : "shared, with no other box on it now";
    return `${box.name} stops, gets ${cardName(card)}, ${card.model} with ${gib(card.memoryMiB)}, ${company}, and starts again, ${about}.`;
  }
  return `${capital(cardName(plan.fromCard!))} has ${plan.others.length === 1 ? "another box" : `${plan.others.length} other boxes`}: ${listed(plan.others.map((other) => (other.state === "stopped" ? `${other.name} (stopped)` : other.name)))}. bb-box moves ${box.name} to ${cardName(card)}, which has none, ${about}. Programs using the GPU stop, and must be started again.`;
}

function namedIn(world: World, box: FakeBox): FakeBox[] {
  return cardsOf(world, box.backend).flatMap((card) => boxesOnCard(world, card, box.id));
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
      <span className={cn("text-right", way === "live" ? "text-muted-foreground" : way === "restart" ? "text-warning-text" : "text-destructive-text")}>{WAY_WORDS[way]}</span>
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
  const apply = () => {
    const done = store.resize(box.id, { ...size, gpu });
    if (!done.ok) {
      setRefusal(done.why);
      setStep("pick");
      return;
    }
    onClose();
  };
  const choices: SizeChoice[] = ["now", "small", "medium", "large"];
  let body: ReactNode = null;
  if (step === "pick") {
    body = (
      <div className="space-y-5">
        <FormSection title="Size" description="A preset sets cores and memory, and leaves the disk as it is.">
          <div role="radiogroup" aria-label="Size" className="flex flex-wrap gap-2">
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
              {size.cores !== box.cores ? <Row label="Cores" from={String(box.cores)} to={String(size.cores)} way="live" /> : null}
              {size.memoryGiB !== box.memoryGiB ? <Row label="Memory" from={`${box.memoryGiB} GiB`} to={`${size.memoryGiB} GiB`} way="live" /> : null}
              {plan.way !== "same" ? <Row label="GPU" from={gpuAmount(plan.from, plan.fromCard)} to={plan.way === "no" ? GPU_WORDS[plan.to].toLowerCase() : gpuAmount(plan.to, plan.toCard)} way={plan.way} /> : null}
            </ul>
          )}
          {words ? <p className={cn("text-xs leading-snug", restart ? "text-warning-text" : "text-muted-foreground")}>{words}</p> : null}
          {!nothing && plan.way === "same" ? <p className="text-xs leading-snug text-muted-foreground">Changes at once. Everything running in {box.name} carries on.</p> : null}
        </FormSection>
        {plan.way === "no" || refusal ? (
          <div role="alert" className="space-y-2 text-xs leading-snug">
            <p className="text-destructive-text">{refusal ?? plan.why}</p>
            {backendOf(box.backend).canChangeDevices ? <BoxLinks boxes={namedIn(store, box)} onGo={toBox} /> : null}
          </div>
        ) : null}
      </div>
    );
  }
  const title = step === "confirm" ? (moving ? `Move ${box.name} to ${cardName(plan.toCard!)}?` : `Restart ${box.name} to change its GPU?`) : `Resize ${box.name}`;
  const description =
    step === "confirm"
      ? `Everything running in it stops, and it is back in about ${backendOf(box.backend).restartSeconds} s.${thread ? ` "${thread}" works on it: its work stops while it restarts.` : ""}`
      : `Now ${box.cores} cores · ${box.memoryGiB} GiB${box.diskGiB !== null ? ` · ${box.diskGiB} GiB disk` : ""} · GPU ${gpuAmount(box.gpu, plan.fromCard)}.`;
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {body}
        <AlertDialogFooter>
          {step === "pick" ? (
            <>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button type="button" disabled={blocked} onClick={() => (restart ? setStep("confirm") : apply())}>
                {restart ? "Resize…" : "Resize"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("pick")}>
                Back
              </Button>
              <Button type="button" onClick={apply}>
                {moving ? "Move and restart" : "Restart and resize"}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
