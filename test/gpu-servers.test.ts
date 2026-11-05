import assert from "node:assert/strict";
import { test } from "node:test";
import { cardFactWords, cardsSeenIn, judgeCardCheck } from "../src/backends/proxmox-lxc/gpu-servers.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type GpuPart } from "../src/backends/types.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { CARD_A, CARD_B, ClaimsBridge } from "./gpu-helper/claims-bridge.ts";
import { cardLines, marker } from "./gpu-helper/node.ts";
import { gpuPartsText } from "../src/plugin/tools.ts";
import type { KindView } from "../src/plugin/views.ts";

const A = CARD_A.uuid;
const B = CARD_B.uuid;
let counter = 0;

function box(kind: string, gpu: GpuPart): BoxIdentity {
  counter++;
  return { boxId: `bxsrv${counter}`, threadId: "thr_servers", name: `gpu-box-${counter}`, kind, createdAt: Date.UTC(2026, 10, 5), size: { cores: 2, memoryMiB: 4096, diskGiB: null, gpu } };
}

function hooks(): AcquireHooks {
  return { claim: async () => {}, starting: async () => {}, timing: () => {} };
}

const signal = () => new AbortController().signal;

function record(nvidia: string | null): string {
  return JSON.stringify({ contract: 1, image: "standard", kind: "linux", arch: "x86_64", build: "build.20261105-090000-1a2b", built: "2026-11-05T09:00:00Z", os: "Ubuntu 24.04.5 LTS", tools: {}, nvidia });
}

function withUserspace(bridge: ClaimsBridge, nvidia: string | null = "580.142", vmid = 9000): void {
  bridge.proxmox.guests.get(vmid)!.config.description = `bb-box linux template (NVIDIA ${nvidia}, no card), built 2026-11-05. See /usr/share/bb-box/template-release inside.\n${record(nvidia)}`;
}

function clones(bridge: ClaimsBridge): number {
  return bridge.proxmox.calls.filter((call) => call.path.endsWith("/clone")).length;
}

test("071 unit 7: nvidia-smi's answer in a box says whether it has its card, and why not", () => {
  const listed = `GPU-${A}, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 97887\ncuinit 0\nuserspace 580.142`;
  assert.deepEqual(judgeCardCheck(listed, A, "580.142"), { ok: true, card: { uuid: A, model: "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition", memoryMiB: 97887 } });
  assert.deepEqual(judgeCardCheck(`GPU-${B}, NVIDIA Fake Card, 97887\ncuinit 0\nuserspace 580.142`, A, "580.142"), { ok: false, why: `nvidia-smi in it listed card ${B}, not its card ${A}`, seen: [B], userspace: "580.142" });
  const failed = "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.\ncuinit 100\nuserspace 580.142";
  assert.equal(judgeCardCheck(failed, A, "580.142").ok, false);
  assert.match((judgeCardCheck(failed, A, "580.142") as { why: string }).why, /^nvidia-smi in it listed no card, not its card .* \(NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver\. Make sure that the latest NVIDIA driver is installed and running\)$/);
  const mismatch = "Failed to initialize NVML: Driver/library version mismatch\ncuinit 999\nuserspace 570.86";
  assert.deepEqual(judgeCardCheck(mismatch, A, "580.142"), { ok: false, why: "nvidia-smi in it fails: its NVIDIA userspace is 570.86 and the host's driver 580.142", seen: [], userspace: "570.86" });
  assert.deepEqual(judgeCardCheck(`GPU-${A}, NVIDIA Fake Card, 97887\ncuinit 3\nuserspace 580.142`, A, "580.142"), { ok: false, why: "CUDA's driver did not initialise in it: cuInit returned 3", seen: [A], userspace: "580.142" });
  assert.equal(judgeCardCheck(`GPU-${A}, NVIDIA Fake Card, 97887\ncuinit unknown\nuserspace 580.142`, A, "580.142").ok, true, "a box with no python3 is checked by nvidia-smi alone");
  assert.deepEqual(cardsSeenIn(`GPU-${A}\nGPU-${B}`), [A, B]);
  assert.deepEqual(cardsSeenIn("No devices were found"), []);
  assert.equal(cardsSeenIn("sh: nvidia-smi: not found"), null, "an answer that names no card is not a reading");
  assert.equal(cardFactWords("shared", 1, { uuid: A, model: "NVIDIA RTX PRO 6000", memoryMiB: 97887 }), "card 1, shared, NVIDIA RTX PRO 6000, 96 GiB");
  assert.equal(cardFactWords("shared", null, null), "a card, shared");
});

test("071 unit 7: a server with a shared GPU is placed on a card, its marker goes in the same write as its labels, the helper writes the server set of lines into the stopped clone, and it starts on its card, as nvidia-smi in it shows", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const room = await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "shared" }, []);
  assert.equal(room.ok, true, room.message ?? "");
  const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  const vmid = Number(made.ref);
  const card = made.claim?.card === A ? CARD_A : CARD_B;
  assert.deepEqual(made.claim, { card: card.uuid, part: "shared", generation: 1, answer: "granted" });
  assert.equal(made.data?.template, 9000);
  assert.deepEqual(bridge.gpuTags(vmid), [marker("shared", card, 1)]);
  const tagged = bridge.proxmox.calls.filter((call) => call.method === "PUT" && call.path.endsWith(`/lxc/${vmid}/config`) && call.params.tags !== undefined);
  assert.ok(tagged[0]!.params.tags!.includes("box.") && tagged[0]!.params.tags!.includes(marker("shared", card, 1)), "one write gives the guest its labels and its marker");
  assert.deepEqual(bridge.lines(vmid), cardLines(card, "server"), "a server gets the card's nodes, nvidiactl and UVM, and no modeset or DRM nodes");
  assert.equal(bridge.proxmox.guests.get(vmid)!.status, "running");
  assert.deepEqual(made.facts?.find((fact) => fact.label === "GPU"), { label: "GPU", value: `card ${card.index}, shared, NVIDIA Fake Card, 96 GiB` });
  const writes = bridge.node.guestWrites();
  assert.ok(writes.length > 0 && writes.every((write) => write.split(" ")[1] === String(vmid)), `the helper wrote this guest alone: ${writes.join("; ")}`);
});

test("071 unit 7: a server with no GPU is made as before, warm or cloned, with no marker and no lines; a server with a GPU never takes a warm guest", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const made = await backend.acquire(box("linux", "none"), null, hooks(), signal());
  const vmid = Number(made.ref);
  assert.equal(made.claim, undefined);
  assert.deepEqual(bridge.gpuTags(vmid), []);
  assert.deepEqual(bridge.lines(vmid), []);
  assert.equal(made.facts?.some((fact) => fact.label === "GPU") ?? false, false);
});

test("071 unit 7: a server's shared GPU is refused before any copy, with words for the person and for an agent, while the Linux template has no NVIDIA userspace for the host's driver, while the helper has writes off, and with no helper", async () => {
  const shared = { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "shared" as const };
  const bare = new ClaimsBridge();
  const backend = bare.backend();
  const room = await backend.capacity("linux", shared, []);
  assert.equal(room.ok, false);
  assert.equal(room.message, "pve cannot give a server a shared GPU now: no Linux template there has NVIDIA's userspace for its driver 580.142: template 9000 has none. Rebuild one with build.sh linux <vmid> --replace, as root on pve.");
  assert.equal(room.agentMessage, "Not made: pve cannot give a server a shared GPU now: no Linux template there has NVIDIA's userspace for its driver 580.142: template 9000 has none. Ask for gpu none, or ask the user. bb-box changed nothing.");
  assert.doesNotMatch(room.agentMessage!, /release|raise|settings|setup-gpu|build\.sh/i, "an agent is never told to release a box or change a setting");
  const before = clones(bare);
  await assert.rejects(backend.acquire(box("linux", "shared"), null, hooks(), signal()), (error: unknown) => error instanceof BackendError && error.code === "no_capacity" && /has NVIDIA's userspace/.test(error.message));
  assert.equal(clones(bare), before, "refused before any copy");
  assert.equal((await backend.capacity("linux", { ...shared, gpu: "none" }, [])).ok, true, "a server with no GPU still fits");

  const old = new ClaimsBridge();
  withUserspace(old, "570.86");
  assert.match((await old.backend().capacity("linux", shared, [])).message!, /template 9000 has 570\.86/);

  const off = new ClaimsBridge({ writes: "off" });
  withUserspace(off);
  const offRoom = await off.backend().capacity("linux", shared, []);
  assert.equal(offRoom.message, "pve cannot give a server a shared GPU now: its GPU helper has writes off, so it gives no box a card. Turn writes on with host/setup-gpu.sh --writes on --check, then --writes on, as root on pve.");
  assert.equal(offRoom.agentMessage, "Not made: pve cannot give a server a shared GPU now: its GPU helper has writes off, so it gives no box a card. Ask for gpu none, or ask the user. bb-box changed nothing.");
  assert.deepEqual(await off.backend().gpuRoom("linux"), { readings: [], fullUntil: null, parts: ["none"], withheld: "pve: its GPU helper has writes off, so it gives no box a card" });
});

test("071 unit 7: a server needs 1024 MiB free on its card, and a card at its limit or held whole takes none; the refusal names each card", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 1 });
  const desktop = await backend.acquire(box("linux-desktop", "shared"), null, hooks(), signal());
  const used = desktop.claim!.card;
  const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  assert.notEqual(made.claim!.card, used, "the server goes to the card the desktop left");
  const room = await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "shared" }, []);
  assert.equal(room.ok, false);
  assert.match(room.message!, /^No card on pve can take a shared GPU now: card 0 has 1 of this install's boxes, the most a card may have and card 1 has 1 of this install's boxes, the most a card may have\. Release a box on a card, ask for gpu none, or raise the boxes per card in BB Box's settings\.$/);
  assert.match(room.agentMessage!, /^Not made: no card on pve can take a shared GPU now: .* Ask for gpu none, or ask the user\. bb-box changed nothing\.$/);
  const room2 = await bridge.backend().gpuRoom("linux");
  assert.deepEqual(room2.parts, ["none", "shared"]);
  assert.deepEqual(room2.cards?.map((card) => [card.index, card.boxes, card.whole]), [[0, 1, false], [1, 1, false]]);
  assert.equal(room2.neededMiB, 1024);
});

test("071 unit 7: a fresh server whose nvidia-smi lists another card than its claim's is released and made again on the other card, and new boxes avoid the first card for a while", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ readyTimeoutMs: 60_000 });
  const errors = (backend as unknown as { errors: string[] }).errors;
  let first: number | null = null;
  bridge.proxmox.intercept = (call) => {
    const clone = /\/lxc\/9000\/clone$/.exec(call.path);
    if (clone && call.method === "POST" && first === null) {
      first = Number(call.params.newid);
      bridge.seenInBox.set(first, { shows: `GPU-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}, NVIDIA Fake Card, 97887` });
    }
    return undefined;
  };
  const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  assert.ok(first !== null);
  assert.notEqual(Number(made.ref), first, "the first guest was released");
  assert.equal(bridge.proxmox.guests.has(first!), false);
  const firstCard = errors.join("\n").match(/started without GPU GPU-([0-9a-f-]+)/)?.[1];
  assert.ok(firstCard, errors.join("\n"));
  assert.notEqual(made.claim!.card, firstCard, "made again on the other card");
  const next = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  assert.equal(next.claim!.card, made.claim!.card, "the card that failed is left out for now");
});

test("071 unit 7: a desktop with no GPU is cloned from the desktop template with no device lines, carries no marker and no card, and its display on the CPU is what it was asked for", async () => {
  const bridge = new ClaimsBridge();
  bridge.proxmox.addTemplate(9003, { cores: "4", memory: "8192", unprivileged: "1" });
  const backend = bridge.backend({ templates: `9003\n9001 GPU-${A}` });
  assert.deepEqual(backend.kinds().find((kind) => kind.id === "linux-desktop")?.gpuParts, ["none", "shared"]);
  const made = await backend.acquire(box("linux-desktop", "none"), null, hooks(), signal());
  const vmid = Number(made.ref);
  assert.equal(made.data?.template, 9003);
  assert.equal(made.claim, undefined);
  assert.deepEqual(bridge.gpuTags(vmid), []);
  assert.deepEqual(bridge.lines(vmid), []);
  const only = bridge.backend({ templates: `9001 GPU-${A}\n9002 GPU-${B}` });
  assert.deepEqual(only.kinds().find((kind) => kind.id === "linux-desktop")?.gpuParts, ["shared"], "with every template on a card, a desktop with no GPU is not offered");
  const forkRoom = await only.capacity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null, gpu: "none" }, []);
  assert.equal(forkRoom.ok, true, "a fork with gpu none copies its snapshot, so it needs no template with no card");
  await assert.rejects(only.acquire(box("linux-desktop", "none"), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.match(error.message, /^Every desktop template on pve carries a card's device lines/);
    assert.match(error.agentMessage!, /^Not made: every desktop template on pve carries a card\. Ask for linux-desktop-cpu, or ask the user\. bb-box changed nothing\.$/);
    return true;
  });
});

test("071 unit 7: a shared desktop from the desktop template with no device lines gets its card's desktop set from the helper while stopped, and its GPU fact names the card", async () => {
  const bridge = new ClaimsBridge();
  bridge.proxmox.addTemplate(9003, { cores: "4", memory: "8192", unprivileged: "1" });
  const backend = bridge.backend({ templates: "9003" });
  const one = await backend.acquire(box("linux-desktop", "shared"), null, hooks(), signal());
  const two = await backend.acquire(box("linux-desktop", "shared"), null, hooks(), signal());
  assert.deepEqual(new Set([one.claim!.card, two.claim!.card]), new Set([A, B]), "the template serves every card");
  for (const made of [one, two]) {
    const card = made.claim!.card === A ? CARD_A : CARD_B;
    assert.equal(made.data?.template, 9003);
    assert.deepEqual(bridge.lines(Number(made.ref)), cardLines(card, "desktop"));
    assert.equal(made.facts?.find((fact) => fact.label === "GPU")?.value, `card ${card.index}, shared, NVIDIA Fake Card, 96 GiB`);
  }
  const off = new ClaimsBridge({ writes: "off" });
  off.proxmox.addTemplate(9003, { cores: "4", memory: "8192", unprivileged: "1" });
  await assert.rejects(off.backend({ templates: "9003" }).acquire(box("linux-desktop", "shared"), null, hooks(), signal()), /the desktop templates carry no card's device lines, and the GPU helper has writes off/);
});

test("071 unit 7: a stopped server with a shared GPU starts on a card with room, checked by nvidia-smi; one that does not see its card is stopped, placed once on the other card and started there; with no other card it is left stopped with its disk", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  const vmid = Number(made.ref);
  const held = made.claim!.card;
  await backend.stop(made);
  bridge.pass();
  bridge.seenInBox.set(vmid, { onCard: held!, shows: "No devices were found" });
  const started = await backend.start(made, signal());
  bridge.seenInBox.delete(vmid);
  assert.ok(started && "claim" in started);
  const moved = (started as { claim: { card: string } }).claim.card;
  assert.notEqual(moved, held, "moved to the other card");
  assert.equal(bridge.proxmox.guests.get(vmid)!.status, "running");
  assert.deepEqual(parseTags(bridge.proxmox.guests.get(vmid)!.config.tags).filter((tag) => tag.startsWith("gpu.")), [marker("shared", moved === A ? CARD_A : CARD_B, 2)]);

  const lone = new ClaimsBridge();
  withUserspace(lone);
  const one = lone.backend({ perGpu: 1 });
  await one.acquire(box("linux-desktop", "shared"), null, hooks(), signal());
  const server = await one.acquire(box("linux", "shared"), null, hooks(), signal());
  const id = Number(server.ref);
  await one.stop(server);
  lone.pass();
  lone.seenInBox.set(id, { shows: "No devices were found" });
  await assert.rejects(one.start(server, signal()), (error: unknown) => {
    assert.ok(error instanceof Error, String(error));
    assert.match(error.message, /^The box did not get card \d: nvidia-smi in it listed no card, not its card [0-9a-f-]+ \(No devices were found\)\. .* It is stopped, with its disk as it was\. Start tries again; bb box doctor has more\.$/);
    return true;
  });
  assert.equal(lone.proxmox.guests.get(id)!.status, "stopped");
  assert.ok(lone.proxmox.guests.has(id), "never released: its disk is someone's work");
});

test("071 unit 7: the sweep's nvidia-smi in each running box with a GPU finds a box on the wrong card: the doctor fails naming it, and new boxes go to neither card", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  const vmid = Number(made.ref);
  const other = made.claim!.card === A ? B : A;
  bridge.seenInBox.set(vmid, { shows: `GPU-${other}` });
  bridge.pass();
  await backend.maintain(signal());
  const report = await backend.doctor();
  const cards = report.checks.find((check) => check.id === "proxmox.gpu-cards");
  assert.equal(cards?.status, "fail", JSON.stringify(cards));
  assert.match(cards!.detail, new RegExp(`^CT ${vmid} holds card \\d, and nvidia-smi in it listed card \\d, (just now|\\d+ \\w+ ago)\\. bb-box places no new box on those cards until it is put right, and does not stop the boxes\\.$`));
  await assert.rejects(backend.acquire(box("linux", "shared"), null, hooks(), signal()), /left out for now/);
  assert.equal(bridge.proxmox.guests.get(vmid)!.status, "running", "bb-box never stops it by itself");
  bridge.seenInBox.delete(vmid);
  bridge.pass();
});

test("071 unit 7: box_list says per kind which providers give a GPU, the room on each card with the reading's age, why one gives none now, and that a desktop with gpu none draws on the CPU", () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const offer = (gpuRoom: object | null, gpuParts: readonly GpuPart[]) => ({ name: "Proxmox LXC on pve", gpuRoom, gpuParts });
  const linux = {
    desktop: false,
    offers: [
      offer(
        {
          readings: [],
          fullUntil: null,
          parts: ["none", "shared"],
          withheld: null,
          host: "pve",
          limit: 4,
          at: now - 20_000,
          neededMiB: 1024,
          cards: [
            { index: 0, boxes: 1, whole: false, freeMiB: 96_000, totalMiB: 97_887 },
            { index: 1, boxes: 0, whole: true, freeMiB: 90_000, totalMiB: 97_887 },
          ],
        },
        ["none", "shared"],
      ),
    ],
  } as unknown as KindView;
  assert.equal(
    gpuPartsText(linux, now),
    " GPU on Proxmox LXC on pve: none or shared; ask with gpu shared (pve: 2 cards; card 0, shared, 1 of 4 boxes, 93.8 GiB free; card 1 held whole, when read just now; a new box needs 1024 MiB free on its card).",
  );
  const withheld = { desktop: false, offers: [offer({ readings: [], fullUntil: null, parts: ["none"], withheld: "pve: its GPU helper has writes off, so it gives no box a card" }, ["none", "shared"])] } as unknown as KindView;
  assert.equal(gpuPartsText(withheld, now), " No GPU on Proxmox LXC on pve now: pve: its GPU helper has writes off, so it gives no box a card.");
  const docker = { desktop: false, offers: [{ name: "Docker on devpc", gpuRoom: null, gpuParts: ["none"] }] } as unknown as KindView;
  assert.equal(gpuPartsText(docker, now), "", "a provider with no GPU part says nothing");
  const desktop = { desktop: true, offers: [offer(null, ["none", "shared"])] } as unknown as KindView;
  assert.equal(gpuPartsText(desktop, now), " gpu none gives a desktop drawn by the CPU, from the same image.");
});
