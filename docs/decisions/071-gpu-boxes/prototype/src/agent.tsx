import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AGENT_THREAD, BACKENDS, HOST_DRIVER, THREADS, type BackendId, type FakeBox, type GpuPart, type KindId } from "./data";
import { TopRow } from "./box-page";
import { go } from "./nav";
import { backendOf, cardById, cardName, cardsOf, freeMiB, gib, holders, listed, lowerFirst, place, planGpu, readAgo, type World } from "./placement";
import { gpuChangeWords } from "./resize";
import { useStore, type Made } from "./store";

const OWN_BOX = "lone-pine";

interface Call {
  readonly id: string;
  readonly words: string;
  readonly answer: (world: World, act: Acts) => string;
}

interface Acts {
  readonly kindGpu: Readonly<Record<KindId, GpuPart>>;
  create(kind: KindId, gpu: GpuPart, size: { cores: number; memoryGiB: number }): Made | { ok: false; why: string };
  find(name: string): FakeBox | undefined;
}

function cardRoom(world: World, backend: BackendId): string {
  const cards = cardsOf(world, backend);
  const host = backendOf(backend).host;
  const most = world.settings[backend].boxesPerCard;
  const each = cards.map((card) => {
    const on = holders(world, card);
    const whole = on.find((box) => box.gpu === "whole");
    if (whole) return `${cardName(card)} whole, ${whole.name}'s`;
    return `${cardName(card)} shared, ${on.length}${most > 0 ? ` of ${most}` : ""} boxes, ${gib(freeMiB(world, card))} free ${readAgo(backend)}`;
  });
  return `${host}: ${cards.length} ${cards.length === 1 ? "card" : "cards"}; ${each.join("; ")}`;
}

export function statusLine(world: World, box: FakeBox): string {
  const card = cardById(world, box.card);
  const backend = backendOf(box.backend);
  if (box.gpu === "none") return `GPU: none.${backend.canChangeDevices ? " box_resize with gpu shared or whole adds one, with a restart." : ""}`;
  if (!card) return `GPU: ${box.gpu}, placed when it starts.`;
  const others = holders(world, card, box.id);
  const company = box.gpu === "whole" ? "to itself" : others.length ? `with ${others.length === 1 ? "1 other box" : `${others.length} other boxes`} (${listed(others.map((each) => each.name))})` : "with no other box now";
  const see = backend.fencesWhole ? "Run nvidia-smi to see it." : `Run nvidia-smi -i ${card.id} to see it; every card on ${backend.host} is listed, and every box with Docker in it can open every card.`;
  const mismatch = box.userspace !== HOST_DRIVER && backend.canChangeDevices ? ` nvidia-smi in ${box.name} fails: its NVIDIA userspace is ${box.userspace} and the host's driver ${HOST_DRIVER}. Ask the user to update it.` : "";
  return `GPU: ${cardName(card)}, ${box.gpu}, ${card.model}, ${gib(card.memoryMiB)}, ${company}. ${see}${mismatch}`;
}

function madeWords(world: World, made: Made | { ok: false; why: string }, kind: KindId, verb = "Made"): string {
  if (!made.ok) return `Not ${verb === "Made" ? "made" : "forked"}: ${made.why}`;
  return `${verb} ${made.box.name}, a ${kind} box on ${backendOf(made.box.backend).host}, ${made.box.cores} cores, ${made.box.memoryGiB} GiB. ${statusLine({ ...world, boxes: [...world.boxes.filter((box) => box.id !== made.box.id), made.box] }, made.box)}`;
}

const CALLS: readonly Call[] = [
  {
    id: "list",
    words: "box_list",
    answer: (world, act) =>
      [
        `linux: GPU none, shared or whole on ${BACKENDS.map((backend) => `${backend.label} (${cardRoom(world, backend.id)})`).join(" and ")}. On Docker, every box with Docker in it can open every card. Left out, gpu is ${act.kindGpu.linux}.`,
        `linux-desktop: the same; also linux-desktop-cpu, the same with no GPU. Left out, gpu is ${act.kindGpu["linux-desktop"]}.`,
        "linux-desktop-wayland-cpu: no GPU.",
      ].join("\n"),
  },
  {
    id: "acquire-whole",
    words: "box_acquire kind: linux, size: large, gpu: whole",
    answer: (world, act) => madeWords(world, act.create("linux", "whole", { cores: 16, memoryGiB: 64 }), "linux"),
  },
  {
    id: "acquire-shared",
    words: "box_acquire kind: linux, gpu: shared",
    answer: (world, act) => madeWords(world, act.create("linux", "shared", { cores: 4, memoryGiB: 16 }), "linux"),
  },
  {
    id: "acquire-desktop",
    words: "box_acquire kind: linux-desktop",
    answer: (world, act) => `gpu left out: ${act.kindGpu["linux-desktop"]}, the kind's default. ${madeWords(world, act.create("linux-desktop", act.kindGpu["linux-desktop"], { cores: 4, memoryGiB: 8 }), "linux-desktop")}`,
  },
  {
    id: "acquire-server",
    words: "box_acquire kind: linux",
    answer: (world, act) => `gpu left out: ${act.kindGpu.linux}, the kind's default. ${madeWords(world, act.create("linux", act.kindGpu.linux, { cores: 4, memoryGiB: 16 }), "linux")}`,
  },
  {
    id: "cpu-alias",
    words: "box_acquire kind: linux-desktop-cpu, gpu: shared",
    answer: () => "Not made: linux-desktop-cpu has no GPU. Ask for linux-desktop with gpu shared. bb-box changed nothing.",
  },
  {
    id: "check",
    words: `box_resize box: "${OWN_BOX}", gpu: whole, check: true`,
    answer: (world, act) => {
      const box = act.find(OWN_BOX);
      if (!box) return `No box ${OWN_BOX}: it was released.`;
      const plan = planGpu(world, box, "whole");
      if (plan.way === "no") return `It would not change: ${lowerFirst(plan.agent ?? "")}`;
      if (plan.way === "same") return `Nothing would change: ${OWN_BOX} has a whole card.`;
      const words = gpuChangeWords(world, box, plan);
      const target = plan.toCard ?? plan.fromCard;
      return `GPU: ${plan.from} → whole ${target ? cardName(target) : "card"}, ${plan.way === "live" ? "live" : plan.way === "stopped" ? "while stopped" : "with a restart"}. ${words}${plan.way === "restart" ? " Call box_resize with restart true to make it." : " Call box_resize without check to make it."}`;
    },
  },
  {
    id: "fork",
    words: `box_fork box: "${OWN_BOX}", snapshot: "before the eval"`,
    answer: (world, act) => {
      const box = act.find(OWN_BOX);
      if (!box) return `No box ${OWN_BOX}: it was released.`;
      return `gpu left out: none, as for every fork; the card stays with ${OWN_BOX}. ${madeWords(world, act.create("linux", "none", { cores: box.cores, memoryGiB: box.memoryGiB }), "linux", "Forked into")}`;
    },
  },
  {
    id: "fork-whole",
    words: `box_fork box: "${OWN_BOX}", snapshot: "before the eval", gpu: whole`,
    answer: (world, act) => {
      const box = act.find(OWN_BOX);
      if (!box) return `No box ${OWN_BOX}: it was released.`;
      const made = act.create("linux", "whole", { cores: box.cores, memoryGiB: box.memoryGiB });
      if (!made.ok) return `Not forked: ${made.why.replace("bb-box changed nothing.", "bb-box copied nothing.")}`;
      return madeWords(world, made, "linux", "Forked into");
    },
  },
  {
    id: "status",
    words: `box_status box: "${OWN_BOX}"`,
    answer: (world, act) => {
      const box = act.find(OWN_BOX);
      if (!box) return `No box ${OWN_BOX}: it was released.`;
      return `${OWN_BOX}: ${box.state}, a linux box on ${backendOf(box.backend).host}, ${box.cores} cores, ${box.memoryGiB} GiB. ${statusLine(world, box)}`;
    },
  },
];

export function AgentPage() {
  const store = useStore();
  const [said, setSaid] = useState<readonly { id: string; words: string; answer: string }[]>([]);
  const acts: Acts = {
    kindGpu: store.kindGpu,
    create(kind, gpu, size) {
      const desktop = kind === "linux-desktop";
      const backend = BACKENDS.map((each) => each.id).find((id) => gpu === "none" || place(store, id, gpu, desktop).card);
      if (!backend) {
        const refusals = BACKENDS.map((each) => ({ host: each.host, placed: place(store, each.id, gpu, desktop) }));
        const where = refusals.map((each) => `${each.host}: ${each.placed.states ?? "no card"}.`).join(" ");
        const fix = refusals.find((each) => each.placed.agentFix?.startsWith("Release"))?.placed.agentFix ?? refusals[0]?.placed.agentFix ?? "Ask the user.";
        return { ok: false, why: `no provider can take ${gpu === "whole" ? "a whole card" : "a shared GPU"} now. ${where} ${fix} bb-box changed nothing.` };
      }
      return store.create({ backend, desktop, cores: size.cores, memoryGiB: size.memoryGiB, gpu, thread: AGENT_THREAD });
    },
    find: (name) => store.boxes.find((box) => box.name === name),
  };
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "Thread" }, { words: THREADS[AGENT_THREAD]! }]} />
      <p className="text-xs text-subtle-foreground">
        A stand-in for a thread whose box is {OWN_BOX}, with what the tools answer its agent. Each call runs against the same cards as the pages. Other threads' boxes are named by their box names only, and the agent is never told to release them or to change settings.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {CALLS.map((call) => (
          <Button key={call.id} type="button" variant="outline" size="sm" className="h-7 font-mono text-2xs font-normal" onClick={() => setSaid((all) => [...all, { id: `${call.id}-${all.length}`, words: call.words, answer: call.answer(store, acts) }])}>
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
        . An agent never releases, stops or resizes another thread's box to free a card.
      </p>
    </div>
  );
}
