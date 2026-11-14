import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedStorage } from "../src/backends/index.ts";
import { BackendError, ResizeHolds, ResizeLeftStopped, type Backend, type BoxKind, type GpuHandoff, type GpuPart, type GpuResize, type Guest, type ResizeOptions, type ResizePlan, type ResizeTarget, type Resizing } from "../src/backends/types.ts";
import { BY_COMMAND, byAgent } from "../src/core/box-log.ts";
import { BoxError, Boxes, type BoxRecord } from "../src/core/boxes.ts";
import type { GeneralConfig } from "../src/core/config.ts";
import { gpuPlanChangedWords, sameGpuPlan } from "../src/core/gpu.ts";
import { cannotInstallWords } from "../src/core/gpu-userspace.ts";
import { boxDetail, boxView, resizeText, userspaceFixLine } from "../src/plugin/views.ts";
import { FAKE_KINDS, FakeBackend } from "./fake-backend.ts";
import { fakeNvidia, updateCalls, withFakeNvidia, type FakeNvidia } from "./fake-nvidia.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";

const THREAD = "thr_add";
const CARD = { card: "GPU-3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00", index: 0, model: "Fake RTX", memoryMiB: 24_576 } as const;
const DRIVER = "580.142";
const GPU_WAYS: Resizing = { cores: "live", memory: "live", disk: "no", shrinks: true, gpu: { add: "restart", share: "live", move: "restart" } };

class InstallingCards extends FakeBackend {
  readonly kindsAsked: string[] = [];
  readonly order: string[] = [];
  readonly gpuDesktops: boolean;
  duringInstall: (() => Promise<void>) | null = null;
  atStop: (() => Promise<void>) | null = null;
  failsAfterInstall: BackendError | null = null;
  leaves: { readonly stopped: boolean; readonly gpu: GpuPart } | null = null;
  heldClaim: GpuHandoff | null = null;
  claimReadFails = 0;
  blockRestart = false;
  readonly #parts = new Map<string, GpuPart>();
  readonly #nvidia: FakeNvidia;

  constructor(options: ConstructorParameters<typeof FakeBackend>[0], nvidia: FakeNvidia, gpuDesktops = true) {
    super(options);
    this.#nvidia = nvidia;
    this.gpuDesktops = gpuDesktops;
  }

  async readGpuClaim(): Promise<GpuHandoff | null> {
    if (this.claimReadFails > 0) {
      this.claimReadFails--;
      throw new Error("The host's report could not be read.");
    }
    return this.heldClaim;
  }

  override resizing(kind: string): Resizing | null {
    if (kind === "linux-desktop-cpu") return { cores: "live", memory: "live", disk: "no", shrinks: true };
    if (kind === "linux-desktop" && !this.gpuDesktops) return null;
    return GPU_WAYS;
  }

  #partOf(guest: Guest): GpuPart {
    return this.#parts.get(guest.ref) ?? guest.claim?.part ?? "none";
  }

  #change(guest: Guest, to: GpuPart, stopped: boolean, desktop: boolean): GpuResize {
    const from = this.#partOf(guest);
    const installs = from === "none" && to !== "none" && !stopped && this.#nvidia.library !== this.#nvidia.driver ? this.#nvidia.driver : null;
    const toCard = to === "none" ? null : CARD;
    const words = `GPU: ${from} → ${to}, card 0 · Restart. ${guest.ref} restarts${installs ? `, gets NVIDIA's userspace ${installs} and card 0` : ""}.${desktop ? " Its desktop is then drawn by the GPU." : ""}`;
    return { from, to, way: "restart", card: toCard, fromCard: from === "none" ? null : CARD, toCard, stopped, installs, others: [], words, refusal: null };
  }

  override async planResize(guest: Guest, kind: string, to: ResizeTarget, _pending?: unknown, _signal?: AbortSignal, agreed: GpuResize | null = null): Promise<ResizePlan> {
    this.kindsAsked.push(kind);
    const plan = await super.planResize(guest, kind, { cores: to.cores, memoryMiB: to.memoryMiB, diskGiB: to.diskGiB });
    if (to.gpu === undefined || to.gpu === this.#partOf(guest)) return plan;
    const change = this.#change(guest, to.gpu, (await this.power(guest)) === "stopped", kind === "linux-desktop");
    const changed = agreed && !sameGpuPlan(agreed, change) ? { changedSinceAgreed: gpuPlanChangedWords(guest.ref, agreed, change, null) } : {};
    return { ...plan, parts: plan.parts.map((part) => ({ ...part, way: "restart" as const })), downSeconds: 15, gpu: { ...change, ...changed } };
  }

  override async resize(guest: Guest, kind: string, to: ResizeTarget, options: ResizeOptions, signal?: AbortSignal): Promise<Guest> {
    if (to.gpu === undefined) return super.resize(guest, kind, to, options);
    const change = this.#change(guest, to.gpu, false, kind === "linux-desktop");
    if (change.installs) {
      if (!options.installUserspace) throw new BackendError("unsupported", "No way to install it.");
      await this.duringInstall?.();
      this.order.push("install");
      await options.installUserspace(change.installs, signal);
    }
    const failing = this.failsAfterInstall;
    if (failing) {
      this.failsAfterInstall = null;
      throw failing;
    }
    await options.restarting?.();
    if (this.blockRestart) {
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    await this.atStop?.();
    this.order.push("stop");
    await this.stop!(guest);
    const leaves = this.leaves;
    if (leaves) {
      this.leaves = null;
      const holding = leaves.gpu === "none" ? null : { card: CARD.card, part: leaves.gpu, generation: (guest.claim?.generation ?? 0) + 1, answer: "granted" as const };
      const left = { ...guest, claim: holding };
      if (leaves.stopped) throw new ResizeLeftStopped(`${guest.ref} holds a shared GPU now, but did not start.`, `Not resized as asked: ${guest.ref} holds a shared GPU now, but did not start. Ask the user.`, left, leaves.gpu);
      await this.start!(guest);
      throw new ResizeHolds(`Not resized: the helper refused the card. Its GPU is as it was: no GPU.`, `Not resized: the helper refused the card. Ask the user.`, left, leaves.gpu);
    }
    const resized = await super.resize(guest, kind, { cores: to.cores, memoryMiB: to.memoryMiB, diskGiB: to.diskGiB }, { restart: true });
    this.order.push("start");
    await this.start!(guest);
    this.#parts.set(guest.ref, to.gpu);
    this.#nvidia.card = to.gpu === "none" ? null : CARD.card.slice(4);
    const claim = to.gpu === "none" ? null : { card: CARD.card, part: to.gpu, generation: (guest.claim?.generation ?? 0) + 1, answer: "granted" as const };
    return { ...resized, claim, facts: claim ? [{ label: "GPU", value: "card 0, shared, Fake RTX, 24 GiB" }] : [] };
  }
}

function world(nvidia: FakeNvidia, gpuDesktops = true, events: { readonly kind: string; readonly words?: string | null }[] = []) {
  const root = tempDir("gpu-add");
  const kv = new MemoryStorage();
  const linux: BoxKind = { ...FAKE_KINDS[0]!, gpuParts: ["none", "shared", "whole"] };
  const desktop: BoxKind = { ...FAKE_KINDS[1]!, gpuParts: ["none", "shared", "whole"], capabilities: { ...FAKE_KINDS[1]!.capabilities, gpu: true } };
  const cpuDesktop: BoxKind = { ...FAKE_KINDS[1]!, id: "linux-desktop-cpu", label: "Linux desktop (CPU)" };
  const kinds = gpuDesktops ? [linux, desktop, cpuDesktop] : [linux, cpuDesktop];
  const backend = new InstallingCards({ root, storage: scopedStorage(kv, "backend/fake/"), kinds, cards: [CARD], boxesPerCard: 4 }, nvidia, gpuDesktops);
  withFakeNvidia(backend, nvidia, ["linux", "linux-desktop", "linux-desktop-cpu"]);
  const logs: string[] = [];
  const backends = {
    get: (id: string): Backend | null => (id === backend.id ? backend : null),
    active: (): Backend[] => [backend],
    on: (): Backend[] => [backend],
    kinds: () => backend.kinds().map((kind) => ({ kind, backend: backend as Backend })),
  };
  const build = () =>
    new Boxes({
      kv,
      backends,
      general: async () => ({ perThreadLimit: null, enrol: false, sizes: {}, spares: {}, wholeCards: true }) as unknown as GeneralConfig,
      notify: () => {},
      thread: async () => ({ state: "live", said: "live" }),
      logError: () => {},
      log: (message) => logs.push(message),
      events: { record: (event) => events.push(event), latest: () => null },
    });
  const state = {
    boxes: build(),
    backend,
    nvidia,
    logs,
    async restart() {
      await state.boxes.dispose();
      state.boxes = build();
    },
  };
  return state;
}

type World = ReturnType<typeof world>;

async function made(state: World, kind: string): Promise<BoxRecord> {
  const box = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind, gpu: "none", who: BY_COMMAND });
  const settled = await state.boxes.settled(box);
  assert.equal(settled?.state, "ready", settled?.error ?? "");
  state.nvidia.calls.length = 0;
  return settled!;
}

async function rejectionOf(work: Promise<unknown>): Promise<BoxError> {
  return work.then(
    () => assert.fail("it was not refused"),
    (error: unknown) => {
      assert.ok(error instanceof BoxError, String(error));
      return error;
    },
  );
}

const noUserspace = () => fakeNvidia({ file: "none", library: "none", card: null });

test("071 unit 10: none to shared on a linux box with no NVIDIA userspace: the check says the install, runs BB Box's check in the box and changes nothing; the resize installs it first, in the same restart, then checks the card, and says so for each audience", async () => {
  const events: { readonly kind: string; readonly words?: string | null }[] = [];
  const state = world(noUserspace(), true, events);
  const box = await made(state, "linux");
  const checked = await state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { check: true });
  assert.equal(checked.plan?.gpu?.installs, DRIVER);
  assert.deepEqual(updateCalls(state.nvidia), ["check"], "the check runs BB Box's check in the box, and installs nothing");
  const said = resizeText(checked, true);
  assert.match(said, /^GPU: none → shared, card 0 · Restart\. \S+ restarts, gets NVIDIA's userspace 580\.142 and card 0\.$/m);
  assert.match(said, /^It has no NVIDIA userspace for the host's driver 580\.142, which a card needs, so BB Box installs it first, while it runs with no GPU, then restarts it with the card: about 60 s more\. If the install fails, it goes on running with no GPU, as it was\.$/m);
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.userspaceUpdate ?? null, null, "a check records no install");
  assert.equal(after.nvidiaUserspace, "none", "it records the box's userspace as it read it");
  assert.equal(after.size?.gpu, "none");

  const refused = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, {}));
  assert.equal(refused.code, "needs_restart");
  assert.match(refused.message, /needs a restart for its GPU: the box shuts down and starts again, for about \d+ s, and installs NVIDIA's userspace 580\.142 in it first, which ends everything running in it\. BB Box changed nothing\.$/);
  assert.deepEqual(state.backend.order, []);

  const states: string[] = [];
  state.backend.duringInstall = async () => void states.push((await state.boxes.find(box.id))!.state);
  state.backend.atStop = async () => void states.push((await state.boxes.find(box.id))!.state);
  const asked: string[] = [];
  const answer = await state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true, who: byAgent(THREAD), beforeRestart: async (seen) => void asked.push(seen.state) });
  assert.deepEqual(state.backend.order, ["install", "stop", "start"], "the install comes first, then one restart");
  assert.deepEqual(states, ["ready", "starting"], "the box stays ready while the userspace is installed, as nothing in it changes, and is starting once its restart begins");
  assert.deepEqual(asked, ["ready", "ready"], "the restart's guard is asked before anything changes, and again just before the restart");
  assert.deepEqual(updateCalls(state.nvidia), ["check", "check", "check", "fetch", "install"], "unit 12's check, for the check, the call refused for want of restart true and the resize, then its download and install, in the box");
  const calls = state.nvidia.calls;
  assert.ok(calls.indexOf("card-check") > calls.indexOf("install"), "the card is checked after the restart");
  assert.ok(!calls.includes("desktop-check"), "a server's desktop is not checked");
  assert.equal(answer.changed, true);
  assert.deepEqual(answer.installed, { driver: DRIVER, from: "none", problem: null });
  const done = answer.box;
  assert.equal(done.state, "ready");
  assert.equal(done.kind, "linux");
  assert.equal(done.size?.gpu, "shared");
  assert.equal(done.guest?.claim?.card, CARD.card);
  assert.equal(done.nvidiaUserspace, DRIVER, "its userspace is recorded, as unit 12 does");
  assert.deepEqual([done.userspaceRead?.file, done.userspaceRead?.library, done.userspaceRead?.hostDriver], [DRIVER, DRIVER, DRIVER]);
  assert.equal(done.userspaceUpdate?.state, "done");
  assert.equal(done.userspaceUpdate?.from, "none");
  assert.equal(done.userspaceUpdate?.to, DRIVER);
  assert.equal(done.userspaceUpdate?.step, "check");
  for (const audience of ["person", "agent"] as const) {
    const text = resizeText(answer, false, audience);
    assert.match(text, /^BB Box installed NVIDIA's userspace 580\.142 in it, where it had none, before the restart\. nvidia-smi in it lists card 0, shared, Fake RTX, 24 GiB, and CUDA's driver initialises\.$/m, audience);
    assert.doesNotMatch(text, /GPU desktop/, "a server's kind does not change");
  }
  assert.ok(state.logs.some((line) => new RegExp(`^Installing NVIDIA's userspace 580\\.142 in box ${box.name} of thread ${THREAD}, over none, to add its GPU\\.$`).test(line)), state.logs.join("\n"));
  assert.ok(state.logs.some((line) => /^Installed NVIDIA's userspace 580\.142 in .+, over none, with its GPU, in \d+ ms\.$/.test(line)));
  assert.deepEqual(
    events.filter((event) => event.kind === "resize-asked" || event.kind === "resized").map((event) => event.words),
    ["From 2 cores, 4 GiB memory, GPU none to 2 cores, 4 GiB memory, GPU shared, with a restart.", "From 2 cores, 4 GiB memory, GPU none to 2 cores, 4 GiB memory, GPU shared, with NVIDIA's userspace 580.142 installed first."],
    "the box log says the install once it ran",
  );
});

test("071 unit 10: a box that has the userspace by the time the backend makes its plan again restarts with no install, and is starting from its stop", async () => {
  const state = world(noUserspace());
  const box = await made(state, "linux");
  const states: string[] = [];
  state.backend.atStop = async () => void states.push((await state.boxes.find(box.id))!.state);
  const answer = await state.boxes.resize(THREAD, box.id, { gpu: "shared" }, {
    restart: true,
    beforeRestart: async () => {
      state.nvidia.file = DRIVER;
      state.nvidia.library = DRIVER;
    },
  });
  assert.deepEqual(state.backend.order, ["stop", "start"], "nothing installed");
  assert.deepEqual(states, ["starting"]);
  assert.equal(answer.installed ?? null, null);
  assert.equal(answer.box.state, "ready");
  assert.equal(answer.box.nvidiaUserspace, DRIVER, "read after the restart");
});

test("071 unit 10: a restart that fails after the install leaves the install named as not finished at its restart, and the resize failed", async () => {
  const state = world(noUserspace());
  const box = await made(state, "linux");
  state.backend.failsAfterInstall = new BackendError("unsupported", "The host refused the stop.");
  const failed = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }).catch((error: unknown) => Promise.reject(error instanceof BackendError ? new BoxError("failed", error.message) : error)));
  assert.equal(failed.message, "The host refused the stop.");
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.resize?.state, "failed");
  assert.equal(after.userspaceUpdate?.state, "failed");
  assert.equal(after.userspaceUpdate?.step, "restart");
  assert.equal(after.userspaceUpdate?.error, "The host refused the stop.");
  assert.equal(after.state, "ready", "the box was not stopped, so it is ready");
  assert.equal(after.size?.gpu, "none");
});

test("071 unit 10: a desktop made from the CPU template, linux-desktop-cpu, resized to shared is resized as a linux-desktop and becomes a GPU desktop: the check and the result say so, its record becomes linux-desktop, and its display and video are checked on the GPU; back to none it stays linux-desktop", async () => {
  const state = world(noUserspace());
  const box = await made(state, "linux-desktop-cpu");
  assert.equal(box.kind, "linux-desktop-cpu");
  const checked = await state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { check: true });
  assert.deepEqual(state.backend.kindsAsked, ["linux-desktop"], "the plan is the linux-desktop offer's");
  assert.deepEqual(checked.becomes, { from: "linux-desktop-cpu", to: "linux-desktop" });
  const check = resizeText(checked, true, "agent");
  assert.match(check, /^It becomes a GPU desktop: a linux-desktop box with a shared GPU, no longer linux-desktop-cpu\.$/m);
  assert.match(check, /about 60 s more\. Its desktop is set to draw on the GPU\. If the install fails/);
  assert.equal((await state.boxes.find(box.id))!.kind, "linux-desktop-cpu", "a check changes nothing");

  const answer = await state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true });
  const done = answer.box;
  assert.equal(done.kind, "linux-desktop");
  assert.equal(done.kindLabel, "Linux desktop");
  assert.equal(done.capabilities.gpu, true, "with linux-desktop's capabilities");
  assert.equal(done.size?.gpu, "shared");
  assert.ok(state.nvidia.calls.includes("desktop-check"), "its display and video are checked on the GPU");
  assert.equal(answer.installed?.problem, null);
  for (const audience of ["person", "agent"] as const) {
    const text = resizeText(answer, false, audience);
    assert.match(text, /^It is now a GPU desktop: a linux-desktop box with a shared GPU, no longer linux-desktop-cpu\.$/m, audience);
    assert.match(text, /and CUDA's driver initialises\. Its desktop is drawn by the GPU, and its video encoded with NVENC\.$/m, audience);
  }

  const none = await state.boxes.resize(THREAD, box.id, { gpu: "none" }, { restart: true });
  assert.equal(none.box.kind, "linux-desktop", "back to none it stays a linux-desktop, with no GPU");
  assert.equal(none.box.size?.gpu, "none");
  assert.equal(none.becomes ?? null, null);
});

test("071 unit 10: a linux-desktop-cpu box whose resize is left stopped holding a card becomes a linux-desktop; one left with no card keeps its kind", async () => {
  const state = world(fakeNvidia({ file: DRIVER, library: DRIVER, card: null }));
  const box = await made(state, "linux-desktop-cpu");
  state.backend.leaves = { stopped: false, gpu: "none" };
  await assert.rejects(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }), ResizeHolds);
  let after = (await state.boxes.find(box.id))!;
  assert.equal(after.kind, "linux-desktop-cpu", "no card, so it is still a desktop drawn by the CPU");
  assert.equal(after.size?.gpu, "none");
  state.backend.leaves = { stopped: true, gpu: "shared" };
  await assert.rejects(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }), ResizeLeftStopped);
  after = (await state.boxes.find(box.id))!;
  assert.equal(after.state, "stopped");
  assert.equal(after.size?.gpu, "shared");
  assert.equal(after.kind, "linux-desktop", "it holds a card now, so it is a GPU desktop");
  assert.equal(after.capabilities.gpu, true);
});

test("071 unit 10: a GPU desktop whose display does not come up on the GPU after the install is named: the resize is done, its check failed, and the words say what to do for each audience", async () => {
  const state = world({ ...noUserspace(), display: "cpu" });
  const box = await made(state, "linux-desktop-cpu");
  const answer = await state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true });
  assert.equal(answer.box.kind, "linux-desktop");
  assert.equal(answer.box.size?.gpu, "shared");
  assert.equal(answer.installed?.problem, "its desktop came up on the CPU (no NVIDIA device nodes)");
  assert.equal(answer.box.userspaceUpdate?.state, "failed");
  assert.equal(answer.box.userspaceUpdate?.step, "check");
  assert.match(resizeText(answer, false, "person"), new RegExp(`^BB Box installed NVIDIA's userspace 580\\.142 in it, where it had none, before the restart, but its check after the restart failed: its desktop came up on the CPU \\(no NVIDIA device nodes\\)\\. Update it again: bb box gpu update ${box.name} --thread ${THREAD}$`, "m"));
  assert.match(resizeText(answer, false, "agent"), /but its check after the restart failed: its desktop came up on the CPU \(no NVIDIA device nodes\)\. Ask the user to update it again\.$/m);
});

test("071 unit 10: a linux-desktop-cpu box is refused a GPU, with words for each audience, where its backend offers no GPU desktop", async () => {
  const state = world(noUserspace(), false);
  const box = await made(state, "linux-desktop-cpu");
  const refused = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }));
  assert.equal(refused.code, "unsupported");
  assert.equal(refused.message, `Not resized: Fake host offers no linux-desktop box with a GPU, so box ${box.name}, a desktop drawn by the CPU, cannot become a GPU desktop there. List a GPU desktop template in BB Box's settings, or make a new linux-desktop box with a GPU. BB Box changed nothing.`);
  assert.equal(refused.agentMessage, `Not resized: Fake host offers no linux-desktop box with a GPU, so box ${box.name}, a desktop drawn by the CPU, cannot become a GPU desktop there. Acquire a linux-desktop box with the GPU it needs, or ask the user. BB Box changed nothing.`);
  assert.deepEqual(state.backend.kindsAsked, [], "the backend is not asked");
  assert.equal((await state.boxes.find(box.id))!.kind, "linux-desktop-cpu");
});

test("071 unit 10, section 6: a box with NVIDIA or CUDA packages from apt is refused before it stops, in the check and the resize, for each audience; so is one with too little disk, and one still running an earlier update", async () => {
  const state = world({ ...noUserspace(), apt: ["nvidia-driver-570"] });
  const box = await made(state, "linux");
  for (const check of [true, false]) {
    const refused = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { check, restart: true }));
    assert.equal(refused.code, "unsupported");
    assert.equal(refused.message, `Not changed: ${box.name} has nvidia-driver-570 from apt, which NVIDIA's installer would conflict with. Remove it, or make a new box with a GPU.`);
    assert.equal(refused.agentMessage, `Not resized: ${box.name} has nvidia-driver-570 from apt, which NVIDIA's installer would conflict with. Remove it, or make a new box with a GPU. BB Box changed nothing.`);
  }
  assert.deepEqual(state.backend.order, [], "nothing stopped");
  assert.deepEqual(updateCalls(state.nvidia), ["check", "check"], "nothing downloaded or installed");
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.state, "ready");
  assert.equal(after.size?.gpu, "none");
  assert.equal(after.userspaceUpdate ?? null, null);

  state.nvidia.apt = [];
  state.nvidia.freeMiB = 1000;
  const small = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }));
  assert.equal(small.message, `Not changed: ${box.name} has 1000 MiB free in /var/tmp, and NVIDIA's installer and its files need 2 GiB. Make a new box with the GPU it needs.`);
  assert.equal(small.agentMessage, `Not resized: ${box.name} has 1000 MiB free in /var/tmp, and NVIDIA's installer and its files need 2 GiB. Acquire a new box with the GPU it needs, or ask the user. BB Box changed nothing.`);

  state.nvidia.freeMiB = 20_000;
  state.nvidia.running = true;
  const running = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }));
  assert.equal(running.code, "try_again");
  assert.equal(running.message, `Not changed: an earlier update of NVIDIA's userspace is still running in box ${box.name}: BB Box reads its userspace once it ends, and starts no other update until then. Resize it again once it has ended.`);
  assert.equal(running.agentMessage, `Not resized: an earlier update of NVIDIA's userspace is still running in box ${box.name}: BB Box reads its userspace once it ends, and starts no other update until then. Call box_resize again once it has ended, or ask the user. BB Box changed nothing.`);
  assert.deepEqual(state.backend.order, []);
});

test("071 unit 10, section 6: an install that fails leaves the box running with no GPU, as it was, and says why; a download that fails changes nothing", async () => {
  const state = world({ ...noUserspace(), install: "fails-before" });
  const box = await made(state, "linux");
  const failed = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }));
  assert.equal(failed.message, `Not resized: BB Box could not install NVIDIA's userspace 580.142 in box ${box.name}: nvidia-userspace: the NVIDIA installer failed before it changed anything. It has no NVIDIA userspace now. It goes on running with no GPU, as it was, and was not restarted. Resize it again to try once more.`);
  assert.match(failed.agentMessage ?? "", /It goes on running with no GPU, as it was, and was not restarted\. Ask the user\.$/);
  assert.deepEqual(state.backend.order, ["install"], "nothing stopped");
  let after = (await state.boxes.find(box.id))!;
  assert.equal(after.state, "ready");
  assert.equal(after.size?.gpu, "none");
  assert.equal(after.resize?.state, "failed");
  assert.equal(after.userspaceUpdate?.state, "failed");
  assert.equal(after.userspaceUpdate?.step, "install");

  state.nvidia.install = "works";
  state.nvidia.fetchFails = "could not download NVIDIA-Linux-x86_64-580.142.run";
  const fetch = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }));
  assert.equal(fetch.message, `Not resized: BB Box could not download NVIDIA's installer 580.142 into box ${box.name}: nvidia-userspace-update: could not download NVIDIA-Linux-x86_64-580.142.run. Nothing in it changed, and it keeps no GPU. Try again later.`);
  after = (await state.boxes.find(box.id))!;
  assert.equal(after.userspaceUpdate?.step, "fetch");
  assert.equal(after.size?.gpu, "none");
  assert.deepEqual(state.backend.order, ["install", "install"]);
});

test("071 unit 10: the restart's guard asked again after the install can stop the restart; the box goes on running with no GPU and the new userspace, and its next resize is a plain restart that settles the install", async () => {
  const state = world(noUserspace());
  const box = await made(state, "linux");
  let guard = 0;
  const refused = await rejectionOf(
    state.boxes.resize(THREAD, box.id, { gpu: "shared" }, {
      restart: true,
      beforeRestart: async () => {
        guard++;
        if (guard === 2) throw new BoxError("in_use", "thread thr_other began working on it");
      },
    }),
  );
  assert.equal(refused.code, "in_use");
  assert.equal(refused.message, `Not resized: BB Box installed NVIDIA's userspace 580.142 in box ${box.name}, but did not restart it to add its GPU: thread thr_other began working on it. It goes on running with no GPU. Resize it again once it can restart.`);
  assert.deepEqual(state.backend.order, ["install"]);
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.state, "ready");
  assert.equal(after.size?.gpu, "none");
  assert.equal(after.userspaceUpdate?.state, "failed");
  assert.equal(after.userspaceUpdate?.step, "restart");

  const again = await state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true });
  assert.equal(again.plan?.gpu?.installs, null, "the userspace is there now");
  assert.equal(again.installed ?? null, null);
  assert.deepEqual(state.backend.order, ["install", "stop", "start"]);
  assert.equal(again.box.userspaceUpdate?.state, "done", "the start BB Box made, and a reading of the host's driver, settle the install");
  assert.equal(again.box.nvidiaUserspace, DRIVER);
});

test("071 unit 10: a plan compared with the one agreed to counts an install the agreed plan did not have, and not one it no longer needs", () => {
  const base: GpuResize = { from: "none", to: "shared", way: "restart", card: CARD, fromCard: null, toCard: CARD, stopped: false, installs: null, others: [], words: "", refusal: null };
  const installing = { ...base, installs: DRIVER };
  assert.equal(sameGpuPlan(base, installing), false, "an install not agreed to is a change");
  assert.equal(sameGpuPlan(installing, base), true, "an install no longer needed is not");
  assert.equal(sameGpuPlan(installing, installing), true);
  assert.equal(sameGpuPlan(installing, { ...installing, installs: "590.1" }), false, "another version is a change");
});

test("071 unit 10, Astra 1: a GPU restart of a running box is refused while an earlier install or update still runs in it, also when no install is needed, and nothing stops", async () => {
  const state = world(fakeNvidia({ file: DRIVER, library: DRIVER, card: null, running: true }));
  const box = await made(state, "linux");
  for (const check of [true, false]) {
    const refused = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { check, restart: true }));
    assert.equal(refused.code, "try_again");
    assert.equal(refused.message, `Not changed: an earlier update of NVIDIA's userspace is still running in box ${box.name}: BB Box reads its userspace once it ends, and starts no other update until then. Resize it again once it has ended.`);
  }
  assert.deepEqual(state.backend.order, [], "nothing stopped");
  assert.equal((await state.boxes.find(box.id))!.size?.gpu, "none");
  state.nvidia.running = false;
  const done = await state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true });
  assert.deepEqual(state.backend.order, ["stop", "start"], "once it has ended, a plain restart");
  assert.equal(done.installed ?? null, null);
});

test("071 unit 10, Astra 2: a resize cut short by BB Box stopping takes the claim its backend holds and the kind that goes with it, so a later resize to none takes the card away", async () => {
  const state = world(fakeNvidia({ file: DRIVER, library: DRIVER, card: null }));
  const box = await made(state, "linux-desktop-cpu");
  const ref = { threadId: THREAD, id: box.id };
  await state.boxes.update(ref, (current) => ({ resize: { from: { ...current.size!, gpu: "none" }, to: { ...current.size!, gpu: "shared" }, at: Date.now(), state: "resizing", ms: null, restart: true, error: null } }));
  state.backend.heldClaim = { part: "shared", card: CARD.card, generation: 1, index: 0 };
  await state.boxes.sweep();
  const recovered = (await state.boxes.find(box.id))!;
  assert.equal(recovered.resize?.state, "failed");
  assert.equal(recovered.size?.gpu, "shared", "the GPU part its backend holds");
  assert.deepEqual(recovered.guest?.claim, { card: CARD.card, part: "shared", generation: 1, answer: "granted" });
  assert.equal(recovered.kind, "linux-desktop", "and the kind that holds a card");
  assert.equal(recovered.capabilities.gpu, true);
  const none = await state.boxes.resize(THREAD, box.id, { gpu: "none" }, { restart: true });
  assert.equal(none.changed, true, "a resize to none changes it");
  assert.deepEqual(state.backend.order, ["stop", "start"]);
  assert.equal(none.box.size?.gpu, "none");
});

test("071 unit 10, Astra 3: an install cut short on a box that has no GPU yet stays named: the sweep reads it, and the doctor, status and an agent say to resize it again", async () => {
  const state = world({ ...noUserspace(), install: "hangs-half" });
  const box = await made(state, "linux");
  const resizing = state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }).catch((error: unknown) => error);
  for (let i = 0; i < 400 && !state.nvidia.calls.includes("install"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(state.nvidia.calls.includes("install"), "the install began");
  await state.restart();
  assert.ok((await resizing) instanceof Error);
  const cut = (await state.boxes.find(box.id))!;
  assert.equal(cut.size?.gpu, "none");
  assert.equal(cut.userspaceUpdate?.state, "unknown");
  assert.equal(boxView(cut, true, { owner: "agent", holder: null }).userspaceNotice?.action ?? null, null, "while it may still run, no action");
  await state.boxes.sweep();
  const read = (await state.boxes.find(box.id))!;
  assert.equal(read.userspaceUpdate?.state, "failed", "the sweep read the box, though it has no GPU");
  assert.match(read.userspaceUpdate?.error ?? "", /When BB Box read the box again, it had no NVIDIA userspace\.$/);
  assert.equal(boxView(read, true, { owner: "agent", holder: null }).userspaceNotice?.action, "resize-again");
  assert.match(userspaceFixLine(read) ?? "", new RegExp(`Its GPU was not added\\. Resize it again: bb box resize ${box.name} --gpu shared --restart --thread ${THREAD}$`));
  assert.match(boxDetail(read), /^GPU: .*Its GPU was not added\. Call box_resize with gpu shared and restart true to try again, or ask the user\.$/m);
  const checks = await state.boxes.userspaceChecks();
  const named = checks.find((check) => check.id === `gpu-userspace.${box.name}`);
  assert.equal(named?.status, "warn");
  assert.match(named?.detail ?? "", /Its GPU was not added\.$/);
  assert.equal(named?.fix, `Resize it again: bb box resize ${box.name} --gpu shared --restart --thread ${THREAD}`);
  assert.match(checks[0]?.detail ?? "", /^0 boxes with a GPU have/, "a box with no GPU is not counted as one with the host's userspace");
});

test("071 unit 10, Astra 3: the doctor counts only boxes with a GPU as having the host's userspace, though it reads a box with no GPU whose install had not finished", async () => {
  const state = world(fakeNvidia({ file: DRIVER, library: DRIVER, card: null }));
  const box = await made(state, "linux");
  await state.boxes.update({ threadId: THREAD, id: box.id }, () => ({ userspaceUpdate: { from: "none", to: DRIVER, at: Date.now(), state: "failed", step: "fetch", ms: 10, error: "the download failed" } }));
  const checks = await state.boxes.userspaceChecks();
  assert.ok(state.nvidia.calls.includes("read"), "it read the box");
  assert.equal((await state.boxes.find(box.id))!.userspaceUpdate?.state, "done", "a reading of the host's driver settles a failed download");
  assert.match(checks[0]?.detail ?? "", /^0 boxes with a GPU have NVIDIA's userspace/);
});

test("071 unit 10, Fable 1: a check in the box that does not finish, or finds an update started meanwhile, asks to try again, not for a new box", async () => {
  const state = world({ ...noUserspace(), checkFinishes: false });
  const box = await made(state, "linux");
  const refused = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }));
  assert.equal(refused.code, "try_again");
  assert.equal(refused.message, `Not changed: ${box.name} did not finish BB Box's check. Try again in a minute.`);
  assert.equal(refused.agentMessage, `Not resized: ${box.name} did not finish BB Box's check. Try again in a minute, or ask the user. BB Box changed nothing.`);
  assert.deepEqual(state.backend.order, []);
  assert.deepEqual(cannotInstallWords("amber-fox", "is still running an earlier update of NVIDIA's userspace, which must end before BB Box starts another", true).person, "Not changed: amber-fox is still running an earlier update of NVIDIA's userspace, which must end before BB Box starts another. Try again in a minute.");
});

test("071 unit 10, Fable 3: a stopped box whose own last reading is not the host's driver is told to start first before its backend plans, whatever its template has", async () => {
  const state = world(noUserspace());
  const box = await made(state, "linux");
  await state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { check: true });
  assert.equal((await state.boxes.find(box.id))!.userspaceRead?.library, "none");
  await state.boxes.stop(THREAD, box.id);
  state.backend.kindsAsked.length = 0;
  const refused = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }));
  assert.equal(refused.message, `Start ${box.name} first: NVIDIA's userspace 580.142, which a card needs, is installed in a running box. Nothing changes.`);
  assert.equal(refused.agentMessage, `Not resized: ${box.name} is stopped, and a card needs NVIDIA's userspace 580.142 in it, which BB Box installs only in a running box. Start it with box_start, then resize it again, or ask the user. BB Box changed nothing.`);
  assert.deepEqual(state.backend.kindsAsked, [], "its backend was not asked to plan");
  assert.equal((await state.boxes.find(box.id))!.state, "stopped");
});

function cutShort(state: World, box: BoxRecord) {
  return state.boxes.update({ threadId: THREAD, id: box.id }, (current) => ({ resize: { from: { ...current.size!, gpu: "none" }, to: { ...current.size!, gpu: "shared" }, at: Date.now(), state: "resizing", ms: null, restart: true, error: null } }));
}

test("071 unit 10, Astra's final check 1: a claim that cannot be read keeps a cut-short GPU resize pending: the next sweep reads it again, and a resize first settles it, or says to try again", async () => {
  const state = world(fakeNvidia({ file: DRIVER, library: DRIVER, card: null }));
  const box = await made(state, "linux-desktop-cpu");
  await cutShort(state, box);
  state.backend.heldClaim = { part: "shared", card: CARD.card, generation: 1, index: 0 };
  state.backend.claimReadFails = 2;
  await state.boxes.sweep();
  let after = (await state.boxes.find(box.id))!;
  assert.equal(after.resize?.state, "resizing", "still pending: its claim was not read");
  assert.equal(after.kind, "linux-desktop-cpu");
  const refused = await rejectionOf(state.boxes.resize(THREAD, box.id, { gpu: "none" }, { restart: true }));
  assert.equal(refused.code, "try_again");
  assert.equal(refused.message, `Not changed: BB Box could not yet read which GPU box ${box.name} holds after its last resize, which was cut short. Try again in a minute.`);
  assert.deepEqual(state.backend.order, []);
  const none = await state.boxes.resize(THREAD, box.id, { gpu: "none" }, { restart: true });
  assert.equal(none.changed, true, "the resize read the claim first, so it knew the box held a card");
  assert.deepEqual(state.backend.order, ["stop", "start"]);
  after = (await state.boxes.find(box.id))!;
  assert.equal(after.kind, "linux-desktop");
  assert.equal(after.size?.gpu, "none");

  const other = await made(state, "linux-desktop-cpu");
  await cutShort(state, other);
  state.backend.claimReadFails = 1;
  await state.boxes.sweep();
  assert.equal((await state.boxes.find(other.id))!.resize?.state, "resizing");
  await state.boxes.sweep();
  const swept = (await state.boxes.find(other.id))!;
  assert.equal(swept.resize?.state, "failed", "the next sweep read it");
  assert.equal(swept.kind, "linux-desktop");
  assert.equal(swept.size?.gpu, "shared");
});

async function released(work: Promise<unknown>, withinMs: number): Promise<boolean> {
  return Promise.race([work.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), withinMs))]);
}

test("071 unit 10, Astra's final check 4: a release does not wait behind a resize that is installing or restarting: it cancels it, and the box is released", async () => {
  const state = world({ ...noUserspace(), install: "hangs-half" });
  const box = await made(state, "linux");
  const installing = state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }).catch((error: unknown) => error);
  for (let i = 0; i < 400 && !state.nvidia.calls.includes("install"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(state.nvidia.calls.includes("install"), "the install began");
  assert.ok(await released(state.boxes.release(THREAD, box.id, "the gate's deadline"), 5000), "released within 5 s, not after the install");
  assert.ok((await installing) instanceof Error);
  assert.equal(await state.boxes.find(box.id), null);

  state.nvidia.install = "works";
  state.nvidia.file = "none";
  state.nvidia.library = "none";
  state.backend.blockRestart = true;
  const second = await made(state, "linux");
  const restarting = state.boxes.resize(THREAD, second.id, { gpu: "shared" }, { restart: true }).catch((error: unknown) => error);
  for (let i = 0; i < 400 && !state.backend.order.includes("install"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(await released(state.boxes.release(THREAD, second.id, "the gate's deadline"), 5000), "released within 5 s, not after the restart");
  assert.ok((await restarting) instanceof Error);
  assert.equal(await state.boxes.find(second.id), null);
});

test("071 unit 10, Astra's last check: a release asked while a resize waits on its restart's guard cancels it there: no install and no restart start, before or after the install", async () => {
  for (const which of ["first guard, installing", "first guard, no install", "second guard, after the install"] as const) {
    const state = world(which === "first guard, no install" ? fakeNvidia({ file: DRIVER, library: DRIVER, card: null }) : noUserspace());
    const box = await made(state, "linux");
    let guards = 0;
    let open: () => void = () => {};
    const waiting = new Promise<void>((resolve) => (open = resolve));
    const held = which === "second guard, after the install" ? 2 : 1;
    let reached = false;
    const resizing = state.boxes
      .resize(THREAD, box.id, { gpu: "shared" }, {
        restart: true,
        beforeRestart: async () => {
          guards++;
          if (guards === held) {
            reached = true;
            await waiting;
          }
        },
      })
      .catch((error: unknown) => error);
    for (let i = 0; i < 400 && !reached; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(reached, `${which}: the guard was reached`);
    const calls = updateCalls(state.nvidia).length;
    const releasing = state.boxes.release(THREAD, box.id, "the gate's deadline");
    for (let i = 0; i < 400 && (await state.boxes.find(box.id))?.state !== "releasing"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    assert.ok(await released(releasing, 5000), `${which}: released within 5 s`);
    assert.ok((await resizing) instanceof Error, `${which}: the resize ended`);
    assert.deepEqual(state.backend.order.filter((step) => step === "stop" || step === "start"), [], `${which}: no restart`);
    assert.equal(updateCalls(state.nvidia).length, calls, `${which}: nothing more ran in the box after the release was asked`);
    assert.equal(await state.boxes.find(box.id), null);
  }
});

test("071 unit 10, Astra's last check: a release asked after the guards, while the backend makes its plan again, stops the install before it downloads anything", async () => {
  const state = world(noUserspace());
  const box = await made(state, "linux");
  let releasing: Promise<unknown> = Promise.resolve();
  state.backend.duringInstall = async () => {
    releasing = state.boxes.release(THREAD, box.id, "the gate's deadline");
    for (let i = 0; i < 400 && (await state.boxes.find(box.id))?.state !== "releasing"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const resizing = state.boxes.resize(THREAD, box.id, { gpu: "shared" }, { restart: true }).catch((error: unknown) => error);
  assert.ok((await resizing) instanceof Error);
  assert.ok(await released(releasing, 5000));
  assert.deepEqual(updateCalls(state.nvidia), ["check"], "no download and no install began");
  assert.deepEqual(state.backend.order.filter((step) => step === "stop"), []);
});
