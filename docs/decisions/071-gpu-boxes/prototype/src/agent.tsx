import { useState } from "react";
import { Button } from "@/components/ui/button";
import { BACKENDS, type FakeBox, type GpuPart } from "./data";
import { TopRow } from "./box-page";
import { go } from "./nav";
import { backendOf, boxesOnCard, capital, cardById, cardName, cardsOf, freeMiB, gib, listed, place, planGpu, type World } from "./placement";
import { gpuChangeWords } from "./resize";
import { useStore, type Made } from "./store";

interface Call {
  readonly id: string;
  readonly words: string;
  readonly answer: (world: World, act: Acts) => string;
}

interface Acts {
  create(gpu: GpuPart): Made;
  find(name: string): FakeBox | undefined;
}

function cardRoom(world: World, backend: (typeof BACKENDS)[number]["id"]): string {
  const cards = cardsOf(world, backend);
  const host = backendOf(backend).host;
  const most = world.settings[backend].boxesPerCard;
  const each = cards.map((card) => {
    const on = boxesOnCard(world, card);
    const whole = on.find((box) => box.gpu === "whole");
    if (whole) return `${cardName(card)} whole, ${whole.name}'s`;
    return `${cardName(card)} shared, ${on.length}${most > 0 ? ` of ${most}` : ""} boxes, ${gib(freeMiB(world, card))} free`;
  });
  return `${host}: ${cards.length} ${cards.length === 1 ? "card" : "cards"}; ${each.join("; ")}`;
}

export function statusLine(world: World, box: FakeBox): string {
  const card = cardById(world, box.card);
  if (!card) return `GPU: none.${backendOf(box.backend).canChangeDevices ? " box_resize with gpu shared or whole adds one, with a restart." : ""}`;
  const others = boxesOnCard(world, card, box.id);
  const company = box.gpu === "whole" ? "to itself" : others.length ? `with ${others.length === 1 ? "1 other box" : `${others.length} other boxes`} (${listed(others.map((each) => each.name))})` : "with no other box now";
  return `GPU: ${cardName(card)}, ${box.gpu === "whole" ? "whole" : "shared"}, ${card.model}, ${gib(card.memoryMiB)}, ${company}. Run nvidia-smi to see it.`;
}

const CALLS: readonly Call[] = [
  {
    id: "list",
    words: "box_list",
    answer: (world) =>
      [
        `linux: GPU none, shared or whole on ${BACKENDS.map((backend) => `${backend.label} (${cardRoom(world, backend.id)})`).join(" and ")}.`,
        "linux-desktop: the same; also linux-desktop-cpu, the same with no GPU. A desktop asked for with no gpu gets a shared one.",
        "linux-desktop-wayland-cpu: no GPU.",
      ].join("\n"),
  },
  {
    id: "acquire-whole",
    words: "box_acquire kind: linux, size: large, gpu: whole",
    answer: (world, act) => {
      const made = act.create("whole");
      if (!made.ok) return `Not made: ${made.why}`;
      return `Made ${made.box.name}, a linux box on ${backendOf(made.box.backend).host}, ${made.box.cores} cores, ${made.box.memoryGiB} GiB. ${statusLine({ ...world, boxes: [...world.boxes, made.box] }, made.box)}`;
    },
  },
  {
    id: "acquire-shared",
    words: "box_acquire kind: linux, gpu: shared",
    answer: (world, act) => {
      const made = act.create("shared");
      if (!made.ok) return `Not made: ${made.why}`;
      return `Made ${made.box.name}, a linux box on ${backendOf(made.box.backend).host}. ${statusLine({ ...world, boxes: [...world.boxes, made.box] }, made.box)}`;
    },
  },
  {
    id: "check",
    words: 'box_resize box: "amber-fox", gpu: whole, check: true',
    answer: (world, act) => {
      const box = act.find("amber-fox");
      if (!box) return "No box amber-fox: it was released.";
      const plan = planGpu(world, box, "whole");
      if (plan.way === "no") return `It would not change: ${plan.why}`;
      if (plan.way === "same") return "Nothing would change: amber-fox has a whole card.";
      const words = gpuChangeWords(world, box, plan);
      return `GPU: ${plan.from} → whole card ${plan.toCard!.index}, ${plan.way === "live" ? "live" : "with a restart"}. ${words}${plan.way === "restart" ? " Call box_resize with restart true to make it." : " Call box_resize without check to make it."}`;
    },
  },
  {
    id: "status",
    words: 'box_status box: "amber-fox"',
    answer: (world, act) => {
      const box = act.find("amber-fox");
      if (!box) return "No box amber-fox: it was released.";
      return `amber-fox: ${box.state}, a linux-desktop box on ${backendOf(box.backend).host}, ${box.cores} cores, ${box.memoryGiB} GiB. ${statusLine(world, box)}`;
    },
  },
];

export function AgentPage() {
  const store = useStore();
  const [said, setSaid] = useState<readonly { id: string; words: string; answer: string }[]>([]);
  const acts: Acts = {
    create(gpu) {
      const placed = BACKENDS.map((backend) => backend.id).find((id) => place(store, id, gpu, false).card);
      if (!placed) return { ok: false, why: BACKENDS.map((backend) => place(store, backend.id, gpu, false).why).filter(Boolean).join(" ") || "No card can take it." };
      return store.create({ backend: placed, desktop: false, cores: gpu === "whole" ? 16 : 4, memoryGiB: gpu === "whole" ? 64 : 16, gpu, thread: "train" });
    },
    find: (name) => store.boxes.find((box) => box.name === name),
  };
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "Thread" }, { words: "Train the ranking model" }]} />
      <p className="text-xs text-subtle-foreground">A stand-in for a thread, with what the tools answer an agent. Each call runs against the same cards as the pages.</p>
      <div className="flex flex-wrap gap-1.5">
        {CALLS.map((call) => (
          <Button key={call.id} type="button" variant="outline" size="sm" className="h-7 font-mono text-2xs" onClick={() => setSaid((all) => [...all, { id: `${call.id}-${all.length}`, words: call.words, answer: call.answer(store, acts) }])}>
            {call.words}
          </Button>
        ))}
      </div>
      <div className="space-y-2" aria-live="polite">
        {said.length ? (
          said.map((each) => (
            <div key={each.id} className="rounded-md border border-border px-3 py-2 text-xs">
              <p className="font-mono text-muted-foreground">{each.words}</p>
              <p className="mt-1 whitespace-pre-line leading-snug text-foreground">{each.answer}</p>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Choose a call above.</p>
        )}
      </div>
      <p className="text-xs text-subtle-foreground">
        A made box shows on{" "}
        <button type="button" className="cursor-pointer underline underline-offset-2 hover:text-foreground" onClick={() => go({ page: "boxes" })}>
          the Boxes page
        </button>
        . {capital("an agent never releases or resizes another thread's box to free a card.")}
      </p>
    </div>
  );
}
