import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_CHECK_COMMAND, cardFactWords, helperMismatches, judgeCardCheck, wrongCardSeen } from "../src/backends/proxmox-lxc/gpu-servers.ts";
import { AudienceError, BackendError, type AcquireHooks, type BoxIdentity, type GpuPart } from "../src/backends/types.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { CARD_A, CARD_B, ClaimsBridge, INSTALL, devices } from "./gpu-helper/claims-bridge.ts";
import { REPORT_VMID, cardLines, marker } from "./gpu-helper/node.ts";
import { gpuPartsText } from "../src/plugin/tools.ts";
import type { KindView } from "../src/plugin/views.ts";

const A = CARD_A.uuid;
const B = CARD_B.uuid;
let counter = 0;

function box(kind: string, gpu: GpuPart, threadId = "thr_servers"): BoxIdentity {
  counter++;
  return { boxId: `bxsrv${counter}`, threadId, name: `gpu-box-${counter}`, kind, createdAt: Date.UTC(2026, 10, 5), size: { cores: 2, memoryMiB: 4096, diskGiB: null, gpu } };
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

const DONE = "card check done";

function answer(...lines: string[]): string {
  return [...lines, DONE].join("\n");
}

test("071 unit 7: nvidia-smi's answer in a box says whether it has its card, and why not", () => {
  const listed = answer(`GPU-${A}, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 97887`, "cuinit 0", "userspace 580.142");
  assert.deepEqual(judgeCardCheck(listed, A, "580.142"), { ok: true, card: { uuid: A, model: "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition", memoryMiB: 97887 } });
  assert.deepEqual(judgeCardCheck(answer(`GPU-${B}, NVIDIA Fake Card, 97887`, "cuinit 0", "userspace 580.142"), A, "580.142"), {
    ok: false,
    why: `nvidia-smi in it listed card ${B}, not its card ${A}`,
    seen: [B],
    userspace: "580.142",
    reading: "cards",
    userspaceOff: false,
  });
  const failed = answer("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.", "cuinit 100", "userspace 580.142");
  const unreadable = judgeCardCheck(failed, A, "580.142");
  assert.ok(!unreadable.ok && unreadable.reading === "unreadable");
  assert.match(unreadable.why, /^nvidia-smi in it listed no card, not its card .* \(NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver\. Make sure that the latest NVIDIA driver is installed and running\)$/);
  const none = judgeCardCheck(answer("No devices were found", "cuinit 100", "userspace 580.142"), A, "580.142");
  assert.ok(!none.ok && none.reading === "none", "nvidia-smi's own answer that there is no card is a reading");
  const stale = judgeCardCheck(answer("Failed to initialize NVML: Driver/library version mismatch", "cuinit 999", "userspace 570.86"), A, "580.142");
  assert.deepEqual(stale, { ok: false, why: "nvidia-smi in it fails: its NVIDIA userspace is 570.86 and the host's driver 580.142", seen: [], userspace: "570.86", reading: "unreadable", userspaceOff: true });
  assert.deepEqual(cardFactWords("shared", 1, { uuid: A, model: "NVIDIA RTX PRO 6000", memoryMiB: 97887 }), "card 1, shared, NVIDIA RTX PRO 6000, 96 GiB");
  assert.equal(cardFactWords("shared", null, null), "a card, shared");
});

test("071 unit 7, Astra 7: CUDA's check is skipped only where the box has no Python; a library that does not load, a non-zero cuInit or a check that did not finish fails", () => {
  const card = `GPU-${A}, NVIDIA Fake Card, 97887`;
  assert.equal(judgeCardCheck(answer(card, "cuinit no-python", "userspace 580.142"), A, "580.142").ok, true, "a box with no python3 is checked by nvidia-smi alone");
  const missing = judgeCardCheck(answer(card, "cuinit OSError: libcuda.so.1: cannot open shared object file: No such file or directory", "userspace 580.142"), A, "580.142");
  assert.deepEqual(missing.ok ? null : missing.why, "CUDA's driver did not load in it: OSError: libcuda.so.1: cannot open shared object file: No such file or directory");
  const empty = judgeCardCheck(answer(card, "cuinit", "userspace 580.142"), A, "580.142");
  assert.equal(empty.ok, false, "Python that printed nothing fails");
  assert.deepEqual(judgeCardCheck(answer(card, "cuinit 3", "userspace 580.142"), A, "580.142").ok ? null : "failed", "failed");
  const cut = judgeCardCheck(`${card}\ncuinit 0`, A, "580.142");
  assert.deepEqual(cut.ok ? null : [cut.why, cut.reading], ["the check in it did not finish", "incomplete"], "a check cut short is no reading, though the card was listed");
  const noCuda = judgeCardCheck(answer(card, "userspace 580.142"), A, "580.142");
  assert.equal(noCuda.ok, false, "a check with no CUDA line fails");
  assert.equal(wrongCardSeen(cut, A), false, "a check cut short is not a wrong card");
  assert.equal(wrongCardSeen(judgeCardCheck(answer("sh: 1: nvidia-smi: not found", "cuinit no-python", "userspace none"), A, null), A), false, "an unreadable reading is not a wrong card");
  assert.equal(wrongCardSeen(judgeCardCheck(answer("No devices were found", "cuinit 100", "userspace 580.142"), A, "580.142"), A), true);
  assert.equal(wrongCardSeen(judgeCardCheck(answer(`GPU-${B}, NVIDIA Fake Card, 97887`, "cuinit 0", "userspace 580.142"), A, "580.142"), A), true);
  assert.equal(wrongCardSeen(judgeCardCheck(answer("Failed to initialize NVML: Driver/library version mismatch", "cuinit 999", "userspace 570.86"), A, "580.142"), A), false, "stale userspace is not a wrong card");
  assert.match(CARD_CHECK_COMMAND, /if command -v python3 >\/dev\/null 2>&1; then .* 2>&1 \| tail -1\)"; else echo 'cuinit no-python'; fi/);
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
  assert.equal(room.message, "pve cannot give a server a shared GPU now: no Linux template there has NVIDIA's userspace for its driver 580.142: template 9000 has none. Rebuild one with bb box images build proxmox-lxc/<vmid>, or with build.sh linux <vmid> --replace as root on pve.");
  assert.equal(room.agentMessage, "Not made: pve cannot give a server a shared GPU now: no Linux template there has NVIDIA's userspace for its driver 580.142: template 9000 has none. Ask for gpu none, or ask the user. BB Box changed nothing.");
  assert.doesNotMatch(room.agentMessage!, /release|raise|settings|setup-gpu|build\.sh/i, "an agent is never told to release a box or change a setting");
  const before = clones(bare);
  await assert.rejects(backend.acquire(box("linux", "shared"), null, hooks(), signal()), (error: unknown) => error instanceof BackendError && error.code === "no_capacity" && /has NVIDIA's userspace/.test(error.message));
  assert.equal(clones(bare), before, "refused before any copy");
  assert.equal((await backend.capacity("linux", { ...shared, gpu: "none" }, [])).ok, true, "a server with no GPU still fits");

  const old = new ClaimsBridge();
  withUserspace(old, "570.86");
  assert.match((await old.backend().capacity("linux", shared, [])).message!, /template 9000 has 570\.86/);
  const oldImage = (await old.backend().doctor()).checks.find((check) => check.id === "template.9000.image");
  assert.equal(oldImage?.status, "warn", JSON.stringify(oldImage));
  assert.match(oldImage?.detail ?? "", /The Linux template has NVIDIA's userspace 570\.86, and the host's driver is 580\.142\. New boxes with a GPU are not made from it until it is rebuilt, with bb box images build proxmox-lxc\/9000 or build\.sh linux\./);

  const off = new ClaimsBridge({ writes: "off" });
  withUserspace(off);
  const offRoom = await off.backend().capacity("linux", shared, []);
  assert.equal(offRoom.message, "pve cannot give a server a shared GPU now: its GPU helper has writes off, so it gives no box a card. Turn writes on with host/setup-gpu.sh --writes on --check, then --writes on, as root on pve.");
  assert.equal(offRoom.agentMessage, "Not made: pve cannot give a server a shared GPU now: its GPU helper has writes off, so it gives no box a card. Ask for gpu none, or ask the user. BB Box changed nothing.");
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
  assert.match(room.message!, /^No card on pve can take a shared GPU now: card 0 has 1 of this install's boxes, the most a card may have \(gpu-box-\d+\); card 1 has 1 of this install's boxes, the most a card may have \(gpu-box-\d+\)\. Release a box on a card, ask for gpu none, or raise the boxes per card in BB Box's settings\.$/);
  assert.match(room.agentMessage!, /^Not made: no card on pve can take a shared GPU now: .* Ask for gpu none, or ask the user\. BB Box changed nothing\.$/);
  const room2 = await bridge.backend().gpuRoom("linux");
  assert.deepEqual(room2.parts, ["none", "shared", "whole"]);
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
  assert.deepEqual(backend.kinds().find((kind) => kind.id === "linux-desktop")?.gpuParts, ["none", "shared", "whole"]);
  const made = await backend.acquire(box("linux-desktop", "none"), null, hooks(), signal());
  const vmid = Number(made.ref);
  assert.equal(made.data?.template, 9003);
  assert.equal(made.claim, undefined);
  assert.deepEqual(bridge.gpuTags(vmid), []);
  assert.deepEqual(bridge.lines(vmid), []);
  const only = bridge.backend({ templates: `9001 GPU-${A}\n9002 GPU-${B}` });
  assert.deepEqual(only.kinds().find((kind) => kind.id === "linux-desktop")?.gpuParts, ["shared", "whole"], "with every template on a card, a desktop with no GPU is not offered");
  const forkRoom = await only.capacity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null, gpu: "none" }, []);
  assert.equal(forkRoom.ok, true, "a fork with gpu none copies its snapshot, so it needs no template with no card");
  await assert.rejects(only.acquire(box("linux-desktop", "none"), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.match(error.message, /^Every desktop template on pve carries a card's device lines/);
    assert.match(error.agentMessage!, /^Not made: every desktop template on pve carries a card\. Ask for linux-desktop-cpu, or ask the user\. BB Box changed nothing\.$/);
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
  assert.match(cards!.detail, new RegExp(`^CT ${vmid} holds card \\d, and nvidia-smi in it listed card \\d, (just now|\\d+ \\w+ ago)\\. BB Box places no new box on those cards until it is put right, and does not stop the boxes\\.$`));
  await assert.rejects(backend.acquire(box("linux", "shared"), null, hooks(), signal()), /takes no new box while a box there is on another card's lines or lists another card/);
  assert.equal(bridge.proxmox.guests.get(vmid)!.status, "running", "BB Box never stops it by itself");
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

function imageTemplate(bridge: ClaimsBridge, vmid: number, kind: string, nvidia: string | null, lines: readonly string[] = []): void {
  const record = JSON.stringify({ contract: 1, image: "rust-tools", kind, arch: "x86_64", build: "build.20261105-100000-3c4d", built: "2026-11-05T10:00:00Z", os: "Ubuntu 24.04.5 LTS", tools: {}, nvidia });
  bridge.proxmox.addTemplate(vmid, { unprivileged: "1", description: `bb-box image rust-tools\n${record}`, ...devices(lines) });
}

function fromImage(kind: string, gpu: GpuPart, image: number): BoxIdentity {
  return { ...box(kind, gpu), from: String(image) };
}

test("071 unit 7, Astra 3 and Fable 2: the sweep skips a reading it cannot read and a box whose userspace is stale, so neither closes its card or fails the doctor", async () => {
  for (const shows of ["Failed to initialize NVML: Driver/library version mismatch", "sh: 1: nvidia-smi: not found", "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."]) {
    const bridge = new ClaimsBridge();
    withUserspace(bridge);
    const backend = bridge.backend();
    const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
    bridge.seenInBox.set(Number(made.ref), { shows });
    bridge.cudaInBox.set(Number(made.ref), "999");
    bridge.pass();
    await backend.maintain(signal());
    const cards = (await backend.doctor()).checks.find((check) => check.id === "proxmox.gpu-cards");
    assert.equal(cards?.status, "ok", `${shows}: ${cards?.detail}`);
  }
});

test("071 unit 7, Astra 4: a card the helper reports a running guest on the wrong lines of, and the card those lines name, take no new box", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const made = await bridge.backend().acquire(box("linux", "shared"), null, hooks(), signal());
  const vmid = Number(made.ref);
  const other = made.claim!.card === A ? CARD_B : CARD_A;
  const config = bridge.proxmox.guests.get(vmid)!.config;
  for (const key of Object.keys(config)) if (/^dev\d+$/.test(key) && /\/dev\/nvidia/.test(config[key]!)) delete config[key];
  Object.assign(config, devices(cardLines(other, "server")));
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line === `mismatch ${vmid} ${made.claim!.card}`), bridge.node.reportLines().join("\n"));
  await assert.rejects(bridge.backend().acquire(box("linux", "shared"), null, hooks(), signal()), /takes no new box while a box there is on another card's lines or lists another card/);
});

test("071 unit 7, Astra 5: a box the sweep found on the wrong card stops closing its cards once it is released, stopped, or checked again on its card", async () => {
  for (const end of ["release", "stop", "check"] as const) {
    const bridge = new ClaimsBridge();
    withUserspace(bridge);
    const backend = bridge.backend();
    const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
    const vmid = Number(made.ref);
    bridge.seenInBox.set(vmid, { shows: `GPU-${made.claim!.card === A ? B : A}` });
    bridge.pass();
    await backend.maintain(signal());
    await assert.rejects(backend.acquire(box("linux", "shared"), null, hooks(), signal()), /takes no new box while a box there is on another card's lines or lists another card/, `${end}: closed first`);
    bridge.seenInBox.delete(vmid);
    bridge.pass();
    if (end === "release") await backend.release(made, { resetting: async () => {}, timing: () => {} });
    if (end === "stop") await backend.stop(made);
    if (end === "check") await backend.start(made, signal());
    const next = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
    assert.ok(next.claim?.card, `${end}: a new server is placed`);
  }
});

test("071 unit 7, Astra 2 and Fable 3: a restore's start on the card it holds never moves the box when the check fails: it is left stopped on its card, with words", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  const vmid = Number(made.ref);
  const held = made.claim!.card!;
  await backend.stop(made);
  bridge.pass();
  await backend.holdGpuCard(made, { part: "shared", card: held, generation: made.claim!.generation, index: held === A ? 0 : 1 });
  bridge.seenInBox.set(vmid, { shows: "No devices were found" });
  const before = bridge.gpuTags(vmid);
  await assert.rejects(backend.start(made, signal()), (error: unknown) => {
    assert.ok(error instanceof AudienceError, String(error));
    assert.match(error.message, /^The box did not get card \d: nvidia-smi in it listed no card, .* A restore starts a box only on the card it holds, so BB Box did not move it\. It is stopped, with its disk as it was\. Start tries again; bb box doctor has more\.$/);
    assert.match(error.agentMessage, /It is stopped, with its disk as it was\. Start it again later, or ask the user\.$/);
    return true;
  });
  assert.equal(bridge.proxmox.guests.get(vmid)!.status, "stopped");
  assert.deepEqual(bridge.gpuTags(vmid), before, "its claim stays on the card it holds");
  assert.deepEqual(bridge.lines(vmid), cardLines(held === A ? CARD_A : CARD_B, "server"));
});

test("071 unit 7, Astra 1 and Fable 1: a server with a shared GPU from a project's image is placed and marked as a template's clone is, once the image has the host's userspace", async () => {
  const bridge = new ClaimsBridge();
  imageTemplate(bridge, 9050, "linux", "580.142");
  imageTemplate(bridge, 9051, "linux", null);
  const backend = bridge.backend();
  const made = await backend.acquire(fromImage("linux", "shared", 9050), null, hooks(), signal());
  const vmid = Number(made.ref);
  const card = made.claim?.card === A ? CARD_A : CARD_B;
  assert.equal(made.claim?.answer, "granted");
  assert.equal(made.data?.template, 9050);
  assert.deepEqual(bridge.gpuTags(vmid), [marker("shared", card, 1)]);
  assert.deepEqual(bridge.lines(vmid), cardLines(card, "server"));
  const before = clones(bridge);
  await assert.rejects(backend.acquire(fromImage("linux", "shared", 9051), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.match(error.message, /the image this box starts from has no NVIDIA userspace for its driver 580\.142: image build 9051 has none/);
    assert.match(error.agentMessage ?? "", /^Not made: .* Ask for gpu none, or ask the user\. BB Box changed nothing\.$/);
    return true;
  });
  assert.equal(clones(bridge), before, "refused before any copy");
});

test("071 unit 7, Fable 1: a desktop from an image takes a placed card's lines when shared, and loses the lines its image carries when it has no GPU; with the helper's writes off such an image is refused for gpu none", async () => {
  const bridge = new ClaimsBridge();
  imageTemplate(bridge, 9052, "linux-desktop", "580.142", cardLines(CARD_A, "desktop"));
  const backend = bridge.backend();
  const none = await backend.acquire(fromImage("linux-desktop", "none", 9052), null, hooks(), signal());
  assert.deepEqual(bridge.gpuTags(Number(none.ref)), ["gpu.none.g1"]);
  assert.deepEqual(bridge.lines(Number(none.ref)), [], "the helper took the image's lines out");
  const shared = await backend.acquire(fromImage("linux-desktop", "shared", 9052), null, hooks(), signal());
  const card = shared.claim?.card === A ? CARD_A : CARD_B;
  assert.deepEqual(bridge.gpuTags(Number(shared.ref)), [marker("shared", card, 1)]);
  assert.deepEqual(bridge.lines(Number(shared.ref)), cardLines(card, "desktop"));

  const off = new ClaimsBridge({ writes: "off" });
  imageTemplate(off, 9052, "linux-desktop", "580.142", cardLines(CARD_A, "desktop"));
  const before = clones(off);
  await assert.rejects(off.backend().acquire(fromImage("linux-desktop", "none", 9052), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.match(error.message, /carries a card's device lines, and the GPU helper on pve has writes off/);
    assert.match(error.agentMessage ?? "", /^Not made: .* Ask for gpu shared, or ask the user\. BB Box changed nothing\.$/);
    return true;
  });
  assert.equal(clones(off), before);
});

test("071 unit 7, Astra 8 and Fable 4: a refusal inside an acquire and a start carries an agent's words, which tell it neither to release a box nor to change a setting", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 1 });
  const server = await backend.acquire(box("linux", "shared", "thr_other"), null, hooks(), signal());
  await backend.acquire(box("linux-desktop", "shared", "thr_other"), null, hooks(), signal());
  await assert.rejects(backend.acquire(box("linux", "shared"), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.match(error.message, /Release a box on a card, ask for gpu none, or raise the boxes per card in BB Box's settings\.$/);
    assert.match(error.agentMessage ?? "", /^Not made: no card on pve can take a shared GPU now: .* Ask for gpu none, or ask the user\. BB Box changed nothing\.$/);
    assert.doesNotMatch(error.agentMessage!, /release|raise|settings/i);
    return true;
  });
  await backend.stop(server);
  bridge.pass();
  await backend.acquire(box("linux-desktop", "shared"), null, hooks(), signal());
  await assert.rejects(backend.start(server, signal()), (error: unknown) => {
    assert.ok(error instanceof AudienceError, String(error));
    assert.match(error.message, /Release another desktop box, or start it again later\./);
    assert.match(error.agentMessage, /Start it again later, or ask the user\. It is stopped, with its disk as it was\.$/);
    assert.doesNotMatch(error.agentMessage, /release|raise|settings/i);
    return true;
  });
});

function stoppedGuestOf(vmid: number, made: BoxIdentity, template: number) {
  return { ref: String(vmid), host: "pve", address: null, size: null, data: { template, box: made.boxId } };
}

test("071 unit 7 round 2, Astra 1: an acquire resumed after its clone and before its marker places, marks and lines a server as a fresh one, and takes the lines out of a desktop with no GPU; a guest found running is released", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const server = box("linux", "shared");
  bridge.plain(7003, server, INSTALL);
  const made = await backend.acquire(server, stoppedGuestOf(7003, server, 9000), hooks(), signal());
  assert.equal(made.ref, "7003", "the guest it had made is kept");
  assert.equal(made.claim?.answer, "granted");
  const card = made.claim?.card === A ? CARD_A : CARD_B;
  assert.deepEqual(bridge.gpuTags(7003), [marker("shared", card, 1)]);
  assert.deepEqual(bridge.lines(7003), cardLines(card, "server"));

  const desktop = box("linux-desktop", "none");
  bridge.desktop(7004, CARD_A, desktop, INSTALL);
  bridge.pass();
  const plain = await backend.acquire(desktop, stoppedGuestOf(7004, desktop, 9001), hooks(), signal());
  assert.equal(plain.ref, "7004");
  assert.deepEqual(bridge.gpuTags(7004), ["gpu.none.g1"]);
  assert.deepEqual(bridge.lines(7004), [], "the helper took out the card's lines the guest carried");

  const running = box("linux", "shared");
  bridge.plain(7005, running, INSTALL, { running: true });
  bridge.pass();
  await assert.rejects(backend.acquire(running, stoppedGuestOf(7005, running, 9000), hooks(), signal()), /was running before bb-box gave it its card, so BB Box released it/);
  assert.equal(bridge.proxmox.guests.has(7005), false);
});

test("071 unit 7 round 2, Astra 2: a desktop template listed without a GPU ID that carries a card's lines gives a desktop with no GPU no card: the helper takes them out, or it is refused before any copy", async () => {
  const bridge = new ClaimsBridge();
  const made = await bridge.backend({ templates: "9001" }).acquire(box("linux-desktop", "none"), null, hooks(), signal());
  assert.equal(made.data?.template, 9001);
  assert.deepEqual(bridge.gpuTags(Number(made.ref)), ["gpu.none.g1"]);
  assert.deepEqual(bridge.lines(Number(made.ref)), []);
  const off = new ClaimsBridge({ writes: "off" });
  const before = clones(off);
  await assert.rejects(off.backend({ templates: "9001" }).acquire(box("linux-desktop", "none"), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.match(error.message, /^Desktop template 9001 carries a card's device lines, and the GPU helper on pve has writes off/);
    assert.match(error.agentMessage ?? "", /^Not made: desktop template 9001 carries a card's device lines on pve, .* Ask for gpu shared, or ask the user\. BB Box changed nothing\.$/);
    return true;
  });
  assert.equal(clones(off), before);
});

test("071 unit 7 round 2, Astra 3: a server stopped after both its checks failed holds no reservation, so both cards take new boxes", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 1 });
  const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  await backend.stop(made);
  bridge.pass();
  bridge.seenInBox.set(Number(made.ref), { shows: "No devices were found" });
  await assert.rejects(backend.start(made, signal()), /it did not get that one either/);
  assert.equal(bridge.proxmox.guests.get(Number(made.ref))!.status, "stopped");
  bridge.pass();
  assert.deepEqual((await backend.gpuRoom("linux")).cards?.map((card) => card.boxes), [0, 0], "no card holds a place for the stopped server");
  const first = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  const second = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  assert.deepEqual(new Set([first.claim?.card, second.claim?.card]), new Set([A, B]));
});

test("071 unit 7 round 2, Astra 4: a start's move and a fork's placement keep the agent's words through their wrappers", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 1 });
  const server = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  await backend.acquire(box("linux-desktop", "shared"), null, hooks(), signal());
  await backend.stop(server);
  bridge.pass();
  bridge.seenInBox.set(Number(server.ref), { shows: "No devices were found" });
  await assert.rejects(backend.start(server, signal()), (error: unknown) => {
    assert.ok(error instanceof AudienceError, String(error));
    assert.match(error.message, /BB Box could not place it on another card: .*Release another desktop box/);
    assert.match(error.agentMessage, /BB Box could not place it on another card: .*Start it again later, or ask the user\./);
    assert.doesNotMatch(error.agentMessage, /release|raise|settings/i);
    return true;
  });
  bridge.seenInBox.delete(Number(server.ref));
  await backend.start(server, signal());
  await assert.rejects(backend.placeForkGpu(box("linux-desktop", "shared"), "shared", signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.match(error.message, /^Not forked: /);
    assert.match(error.agentMessage ?? "", /^Not forked: No card on pve can take another box now: .* Fork it with gpu none, or ask the user\. BB Box copied nothing\.$/);
    assert.doesNotMatch(error.agentMessage!, /release|raise|settings/i);
    return true;
  });
});

test("071 unit 7 round 2, Fable 1: a check that does not finish is run once more, and a box whose check still does not finish is kept on its card, with the fact on its page", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ readyTimeoutMs: 60_000 });
  let cut: number | null = null;
  bridge.proxmox.intercept = (call) => {
    if (cut === null && call.method === "POST" && /\/lxc\/9000\/clone$/.test(call.path)) {
      cut = Number(call.params.newid);
      bridge.cutInBox.add(cut);
    }
    return undefined;
  };
  const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  assert.equal(Number(made.ref), cut, "the box is kept, not made again");
  assert.equal(bridge.checksCutIn(cut!), 2, "the check ran once more");
  assert.match(made.facts?.find((fact) => fact.label === "GPU")?.value ?? "", /^card \d, shared: the check in it did not finish$/);
  const held = made.claim!.card;
  await backend.stop(made);
  bridge.pass();
  const started = await backend.start(made, signal());
  assert.equal((started as { claim: { card: string } }).claim.card, held, "a start whose check does not finish moves nothing");
  assert.equal(bridge.proxmox.guests.get(cut!)!.status, "running");
});

test("071 unit 7 round 2, Fable 2 and 3: Python that prints nothing says so, and a helper's mismatch of a guest whose claim is none closes only the card its lines name and reads as such", async () => {
  const card = `GPU-${A}, NVIDIA Fake Card, 97887`;
  const quiet = judgeCardCheck([card, "cuinit", "userspace 580.142", "card check done"].join("\n"), A, "580.142");
  assert.deepEqual(quiet.ok ? null : [quiet.why, quiet.reading], ["CUDA's driver did not load in it: Python gave no answer", "cards"]);
  assert.deepEqual(helperMismatches(`    mismatch 7001 none\n    mismatch 7002 ${A}`), [{ vmid: 7001, card: null }, { vmid: 7002, card: A }]);
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const made = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  const report = bridge.proxmox.guests.get(REPORT_VMID)!;
  report.config.description = `${report.config.description}\n    mismatch ${made.ref} none`;
  const cards = (await backend.doctor()).checks.find((check) => check.id === "proxmox.gpu-cards");
  assert.match(cards?.detail ?? "", new RegExp(`^CT ${made.ref} runs with a card's lines while its claim is none, as the GPU helper reports`));
  assert.doesNotMatch(cards!.detail, /claim's card none/);
});
