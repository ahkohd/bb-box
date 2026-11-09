import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { BackendError, GpuPlanChanged, type AcquireHooks, type BoxIdentity, type GpuPart, type Guest, type ResizeTarget } from "../src/backends/types.ts";
import type { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { CARD_A, CARD_B, ClaimsBridge } from "./gpu-helper/claims-bridge.ts";
import { cardLines, marker } from "./gpu-helper/node.ts";

const A = CARD_A.uuid;
const B = CARD_B.uuid;
const DRIVER = "580.142";
const CPU_DESKTOP_TEMPLATE = 9003;
let counter = 0;

function box(kind: string, gpu: GpuPart, name?: string): BoxIdentity {
  counter++;
  return { boxId: `bxadd${counter}`, threadId: "thr_add", name: name ?? `add-box-${counter}`, kind, createdAt: Date.UTC(2026, 10, 7), size: { cores: 2, memoryMiB: 4096, diskGiB: null, gpu } };
}

function hooks(): AcquireHooks {
  return { claim: async () => {}, starting: async () => {}, timing: () => {} };
}

const signal = () => new AbortController().signal;

function record(kind: string, nvidia: string | null): string {
  return JSON.stringify({ contract: 1, image: "standard", kind, arch: "x86_64", build: "build.20261107-090000-1a2b", built: "2026-11-07T09:00:00Z", os: "Ubuntu 24.04.5 LTS", tools: {}, nvidia });
}

function linuxTemplateWith(bridge: ClaimsBridge, nvidia: string | null): void {
  bridge.proxmox.guests.get(9000)!.config.description = `bb-box linux template (NVIDIA ${nvidia}, no card), built 2026-11-07.\n${record("linux", nvidia)}`;
}

function size(gpu: GpuPart, cores = 2): ResizeTarget {
  return { cores, memoryMiB: 4096, diskGiB: null, gpu };
}

function powerOf(bridge: ClaimsBridge, vmid: number): string[] {
  return bridge.node.powerLog().filter((line) => line.endsWith(` ${vmid}`));
}

async function serverWithout(bridge: ClaimsBridge, backend: ProxmoxLxcBackend, name: string): Promise<{ readonly guest: Guest; readonly vmid: number }> {
  const guest = await backend.acquire(box("linux", "none", name), null, hooks(), signal());
  const vmid = Number(guest.ref);
  bridge.userspaceIn(vmid, null);
  bridge.pass();
  return { guest, vmid };
}

function cpuDesktops(bridge: ClaimsBridge, perGpu?: number): ProxmoxLxcBackend {
  bridge.proxmox.addTemplate(CPU_DESKTOP_TEMPLATE, { cores: "4", memory: "8192", unprivileged: "1", description: `bb-box desktop template (CPU, no NVIDIA), built 2026-11-07.\n${record("linux-desktop-cpu", null)}` });
  bridge.pass();
  return bridge.backend({ settings: { "proxmox-lxc-desktop-cpu-templates": String(CPU_DESKTOP_TEMPLATE) }, ...(perGpu !== undefined ? { perGpu } : {}) });
}

test("071 unit 10, section 6: none to shared on a running server with no NVIDIA userspace plans one restart that installs the host's driver's userspace first, in words, about 60 s more in all, with the same time down", async () => {
  const bridge = new ClaimsBridge();
  linuxTemplateWith(bridge, DRIVER);
  const backend = bridge.backend();
  const { guest } = await serverWithout(bridge, backend, "calm-reef");
  const plan = await backend.planResize(guest, "linux", size("shared", 4), [], signal());
  assert.equal(plan.gpu?.refusal, null);
  assert.equal(plan.gpu?.way, "restart");
  assert.equal(plan.gpu?.installs, DRIVER);
  assert.equal(plan.gpu?.toCard?.card, A);
  assert.equal(plan.gpu?.words, "GPU: none → shared, card 0 · Restart. Calm-reef restarts, gets NVIDIA's userspace 580.142 and card 0 (96 GiB), with no other box on it now, in about 75 s. Everything running in it stops.");
  assert.equal(plan.downSeconds, 15, "the box is down only for its restart: it runs during the install");
  assert.deepEqual(plan.parts, [{ part: "cores", from: 2, to: 4, way: "restart" }]);
  bridge.userspaceIn(Number(guest.ref), DRIVER);
  const matching = await backend.planResize(guest, "linux", size("shared"), [], signal());
  assert.equal(matching.gpu?.installs, null, "a box with the host's driver's userspace gets a plain restart");
  assert.equal(matching.downSeconds, 15);
  bridge.userspaceIn(Number(guest.ref), "570.86");
  assert.equal((await backend.planResize(guest, "linux", size("shared"), [], signal())).gpu?.installs, DRIVER, "another version is installed over too");
});

test("071 unit 10, section 6's order: the userspace is installed in the running box, with no card's lines and nothing stopped, while its card is held for it; then one stop, the card's lines and one start", async () => {
  const bridge = new ClaimsBridge();
  linuxTemplateWith(bridge, DRIVER);
  const backend = bridge.backend({ perGpu: 1 });
  const { guest, vmid } = await serverWithout(bridge, backend, "amber-fox");
  const plan = await backend.planResize(guest, "linux", size("shared", 4), [], signal());
  assert.equal(plan.gpu?.toCard?.card, A);
  const before = bridge.node.powerLog().length;
  const seen: { power: string[]; lines: string[]; running: boolean; other: string | null; driver: string }[] = [];
  const order: string[] = [];
  const resized = await backend.resize(
    guest,
    "linux",
    size("shared", 4),
    {
      restart: true,
      agreed: plan.gpu!,
      installUserspace: async (driver) => {
        order.push("install");
        const other = await backend.acquire(box("linux", "shared", "lone-pine"), null, hooks(), signal());
        seen.push({ power: bridge.node.powerLog().slice(before), lines: bridge.lines(vmid), running: bridge.node.isRunning(vmid), other: other.claim?.card ?? null, driver });
        bridge.userspaceIn(vmid, driver);
      },
      restarting: async () => {
        order.push(`restarting, ${bridge.node.powerLog().slice(before).filter((line) => line.endsWith(` ${vmid}`)).length} power actions`);
      },
    },
    signal(),
  );
  assert.deepEqual(order, ["install", "restarting, 0 power actions"], "the install, then the restart is said to begin, before its stop");
  assert.equal(seen.length, 1, "the install is asked once");
  assert.equal(seen[0]!.driver, DRIVER);
  assert.ok(seen[0]!.running, "the box runs during the install");
  assert.deepEqual(seen[0]!.lines, [], "with no card's lines yet, so nothing in it changes");
  assert.deepEqual(seen[0]!.power.filter((line) => line.endsWith(` ${vmid}`)), [], "and nothing stopped before it");
  assert.equal(seen[0]!.other, B, "its card is held for it during the install: a box made meanwhile goes to the other card");
  assert.deepEqual(powerOf(bridge, vmid).slice(-2), [`stop ${vmid}`, `start ${vmid}`]);
  assert.equal(bridge.node.powerLog().slice(before).filter((line) => line.endsWith(` ${vmid}`)).length, 2, "one restart, cores and GPU together");
  assert.deepEqual(resized.claim, { card: A, part: "shared", generation: 1, answer: "granted" });
  assert.equal(resized.size?.cores, 4);
  assert.deepEqual(bridge.gpuTags(vmid), [marker("shared", CARD_A, 1)]);
  assert.deepEqual(bridge.lines(vmid), cardLines(CARD_A, "server"));
});

test("071 unit 10, section 6: an install that fails leaves the box running with no GPU, as it was: nothing stopped, no marker, no lines, and its card no longer held; the words are the install's", async () => {
  const bridge = new ClaimsBridge();
  linuxTemplateWith(bridge, DRIVER);
  const backend = bridge.backend({ perGpu: 1 });
  const { guest, vmid } = await serverWithout(bridge, backend, "pale-moss");
  const plan = await backend.planResize(guest, "linux", size("shared", 4), [], signal());
  const before = bridge.node.powerLog().length;
  const failed = new BackendError("unsupported", "Not resized: the install failed.", "Not resized: the install failed. Ask the user.");
  await assert.rejects(
    backend.resize(guest, "linux", size("shared", 4), { restart: true, agreed: plan.gpu!, installUserspace: async () => Promise.reject(failed) }, signal()),
    (error: unknown) => error === failed,
  );
  assert.deepEqual(bridge.node.powerLog().slice(before), [], "nothing stopped or started");
  assert.ok(bridge.node.isRunning(vmid));
  assert.deepEqual(bridge.gpuTags(vmid), []);
  assert.deepEqual(bridge.lines(vmid), []);
  assert.equal(bridge.proxmox.guests.get(vmid)!.config.cores, "2", "its cores are as they were");
  const other = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  assert.equal(other.claim?.card, A, "the card is no longer held for it");
});

test("071 unit 10: a resize that would install the userspace, called with no way to install it, is refused before anything changes, for each audience", async () => {
  const bridge = new ClaimsBridge();
  linuxTemplateWith(bridge, DRIVER);
  const backend = bridge.backend();
  const { guest, vmid } = await serverWithout(bridge, backend, "swift-owl");
  const before = bridge.node.powerLog().length;
  await assert.rejects(backend.resize(guest, "linux", size("shared"), { restart: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError && error.code === "unsupported");
    assert.equal(error.message, "Swift-owl has no NVIDIA userspace for the host's driver 580.142, which a card needs, and this resize cannot install it. BB Box changed nothing.");
    assert.equal(error.agentMessage, "Not resized: swift-owl has no NVIDIA userspace for the host's driver 580.142, which a card needs. Ask the user. BB Box changed nothing.");
    return true;
  });
  assert.deepEqual(bridge.node.powerLog().slice(before), []);
  assert.deepEqual(bridge.gpuTags(vmid), []);
});

test("071 unit 10, section 6: a stopped box whose template has no userspace for the host's driver, or another version, is told to start first; nothing changes", async () => {
  const bridge = new ClaimsBridge();
  linuxTemplateWith(bridge, DRIVER);
  const backend = bridge.backend();
  const { guest, vmid } = await serverWithout(bridge, backend, "swift-owl");
  await backend.stop(guest, signal());
  bridge.pass();
  const startFirst = {
    person: "Start swift-owl first: NVIDIA's userspace 580.142, which a card needs, is installed in a running box. Nothing changes.",
    agent: "Not resized: swift-owl is stopped, and a card needs NVIDIA's userspace 580.142 in it, which BB Box installs only in a running box. Start it with box_start, then resize it again, or ask the user. BB Box changed nothing.",
  };
  for (const nvidia of [null, "570.86"]) {
    linuxTemplateWith(bridge, nvidia);
    const plan = await backend.planResize(guest, "linux", size("shared"), [], signal());
    assert.deepEqual(plan.gpu?.refusal, startFirst, `a template with ${nvidia ?? "none"}`);
    assert.equal(plan.gpu?.way, "no");
    await assert.rejects(backend.resize(guest, "linux", size("shared"), { restart: true, installUserspace: async () => assert.fail("nothing is installed in a stopped box") }, signal()), { message: startFirst.person });
  }
  assert.deepEqual(bridge.gpuTags(vmid), [], "no marker");
  assert.equal(bridge.node.isRunning(vmid), false, "and nothing started");
  linuxTemplateWith(bridge, DRIVER);
  const plain = await backend.planResize(guest, "linux", size("shared"), [], signal());
  assert.equal(plain.gpu?.refusal, null, "a stopped box from a template with the host's driver's userspace changes while stopped, as unit 9 has it");
  assert.equal(plain.gpu?.installs, null);
});

test("071 unit 10: a host whose GPU helper reports no NVIDIA driver is refused before anything changes, for each audience, rather than an install of no version", async () => {
  const bridge = new ClaimsBridge();
  linuxTemplateWith(bridge, DRIVER);
  const backend = bridge.backend();
  const { guest } = await serverWithout(bridge, backend, "quiet-elm");
  rmSync(bridge.node.file("sys/module/nvidia/version"));
  bridge.pass();
  const plan = await backend.planResize(guest, "linux", size("shared"), [], signal());
  assert.deepEqual(plan.gpu?.refusal, {
    person: "pve cannot change quiet-elm's GPU now: its GPU helper reports no NVIDIA driver, so BB Box cannot tell which userspace a card needs. Run bb box doctor.",
    agent: "Not resized: pve cannot change quiet-elm's GPU now: its GPU helper reports no NVIDIA driver, so BB Box cannot tell which userspace a card needs. Keep its GPU as it is, or ask the user. BB Box changed nothing.",
  });
  assert.equal(plan.gpu?.installs, null);
});

test("071 unit 10, section 6: a desktop made from the CPU template, resized as a linux-desktop, plans the install and the GPU's drawing, and gets the desktop set of a card's lines", async () => {
  const bridge = new ClaimsBridge();
  const backend = cpuDesktops(bridge);
  const desk = await backend.acquire(box("linux-desktop-cpu", "none", "pale-moss"), null, hooks(), signal());
  const vmid = Number(desk.ref);
  bridge.userspaceIn(vmid, null);
  bridge.pass();
  assert.equal(desk.data?.template, CPU_DESKTOP_TEMPLATE, "made from the CPU template");
  assert.equal(backend.resizing("linux-desktop-cpu")?.gpu, undefined, "the CPU desktop's own offer resizes no GPU");
  const plan = await backend.planResize(desk, "linux-desktop", { ...size("shared"), cores: 4, memoryMiB: 8192 }, [], signal());
  assert.equal(plan.gpu?.installs, DRIVER);
  assert.equal(plan.gpu?.words, "GPU: none → shared, card 0 · Restart. Pale-moss restarts, gets NVIDIA's userspace 580.142 and card 0 (96 GiB), with no other box on it now, in about 75 s. Everything running in it stops. Its desktop is then drawn by the GPU.");
  let installed = 0;
  const shared = await backend.resize(
    desk,
    "linux-desktop",
    { ...size("shared"), cores: 4, memoryMiB: 8192 },
    {
      restart: true,
      agreed: plan.gpu!,
      installUserspace: async (driver) => {
        installed++;
        bridge.userspaceIn(vmid, driver);
      },
    },
    signal(),
  );
  assert.equal(installed, 1);
  assert.equal(shared.claim?.card, A);
  assert.deepEqual(bridge.lines(vmid), cardLines(CARD_A, "desktop"), "a desktop's set");
  assert.ok(bridge.tags(vmid).includes("kind.linux-desktop"), "the guest's kind tag says linux-desktop, written with its marker");
  assert.ok(!bridge.tags(vmid).includes("kind.linux-desktop-cpu"));
  assert.equal((await backend.held(signal())).find((held) => held.ref === desk.ref)?.owner?.kind, "linux-desktop", "a record restored from the guest's tags reads linux-desktop");
  const none = await backend.resize(shared, "linux-desktop", { ...size("none"), cores: 4, memoryMiB: 8192 }, { restart: true }, signal());
  assert.equal(none.claim, null);
  assert.ok(bridge.tags(vmid).includes("kind.linux-desktop"), "back to none it stays linux-desktop");
  assert.equal((await backend.held(signal())).find((held) => held.ref === desk.ref)?.owner?.kind, "linux-desktop");
});

test("071 unit 10: a CPU-template desktop whose new claim is not granted has its old marker and its linux-desktop-cpu kind tag asked back; the tag changed only in the marker's write", async () => {
  const bridge = new ClaimsBridge();
  let watched: number | null = null;
  const seen: string[][] = [];
  bridge.proxmox.addTemplate(CPU_DESKTOP_TEMPLATE, { cores: "4", memory: "8192", unprivileged: "1", description: `bb-box desktop template (CPU, no NVIDIA), built 2026-11-07.\n${record("linux-desktop-cpu", null)}` });
  bridge.pass();
  const backend = bridge.backend({
    settings: { "proxmox-lxc-desktop-cpu-templates": String(CPU_DESKTOP_TEMPLATE) },
    onSleep: () => {
      if (watched === null) return;
      const tags = bridge.tags(watched);
      if (tags.some((tag) => tag.startsWith("gpu.shared."))) {
        seen.push(tags.filter((tag) => tag.startsWith("kind.")));
        bridge.answering = false;
      }
    },
  });
  const desk = await backend.acquire(box("linux-desktop-cpu", "none", "swift-owl"), null, hooks(), signal());
  const vmid = Number(desk.ref);
  bridge.userspaceIn(vmid, null);
  bridge.pass();
  watched = vmid;
  await assert.rejects(backend.resize(desk, "linux-desktop", { ...size("shared"), cores: 4, memoryMiB: 8192 }, { restart: true, installUserspace: async (driver) => bridge.userspaceIn(vmid, driver) }, signal()));
  watched = null;
  bridge.answering = true;
  bridge.pass();
  assert.ok(seen.length > 0, "the shared marker was written");
  assert.deepEqual(seen[0], ["kind.linux-desktop"], "the kind tag changed in the same write as the marker");
  assert.equal(bridge.gpuTags(vmid)[0]?.startsWith("gpu.none."), true, "its marker asks for no card again");
  assert.ok(bridge.tags(vmid).includes("kind.linux-desktop-cpu"), "and its kind tag is linux-desktop-cpu again");
  assert.ok(!bridge.tags(vmid).includes("kind.linux-desktop"));
});

test("071 unit 10: a restore that brings back a linux-desktop-cpu kind tag, from before a GPU was added, gets linux-desktop again with the claim it keeps", async () => {
  const bridge = new ClaimsBridge();
  const backend = cpuDesktops(bridge);
  const desk = await backend.acquire(box("linux-desktop-cpu", "none", "lone-pine"), null, hooks(), signal());
  const vmid = Number(desk.ref);
  bridge.userspaceIn(vmid, null);
  bridge.pass();
  const before = bridge.tags(vmid);
  const shared = await backend.resize(desk, "linux-desktop", { ...size("shared"), cores: 4, memoryMiB: 8192 }, { restart: true, installUserspace: async (driver) => bridge.userspaceIn(vmid, driver) }, signal());
  await backend.stop(shared, signal());
  bridge.pass();
  const held = await backend.readGpuClaim(shared, signal());
  assert.equal(held?.part, "shared");
  const rolled = bridge.proxmox.guests.get(vmid)!;
  rolled.config.tags = before.join(";");
  for (const key of Object.keys(rolled.config)) if (/^dev\d+$/.test(key)) delete rolled.config[key];
  assert.ok(bridge.tags(vmid).includes("kind.linux-desktop-cpu"), "the rollback brought back the old kind tag");
  await backend.keepGpuClaim(shared, held!, signal());
  bridge.pass();
  assert.ok(bridge.tags(vmid).includes("kind.linux-desktop"));
  assert.ok(!bridge.tags(vmid).includes("kind.linux-desktop-cpu"));
  assert.equal((await backend.held(signal())).find((guest) => guest.ref === desk.ref)?.owner?.kind, "linux-desktop", "a record restored from its tags reads linux-desktop");
});

test("071 unit 10, the plan made again: a check that needed no install is asked again when the box has lost the userspace since; one that needed it goes ahead without when the box has it now", async () => {
  const bridge = new ClaimsBridge();
  linuxTemplateWith(bridge, DRIVER);
  const backend = bridge.backend();
  const { guest, vmid } = await serverWithout(bridge, backend, "lone-pine");
  bridge.userspaceIn(vmid, DRIVER);
  const plain = await backend.planResize(guest, "linux", size("shared"), [], signal());
  assert.equal(plain.gpu?.installs, null);
  bridge.userspaceIn(vmid, null);
  const asked = await backend.planResize(guest, "linux", size("shared"), [], signal(), plain.gpu!);
  assert.equal(asked.gpu?.changedSinceAgreed?.agent, "Not resized: when you checked, lone-pine would get card 0 with a restart; now it would get NVIDIA's userspace 580.142 and card 0 with a restart. Call box_resize with restart true to do that, or ask the user. BB Box changed nothing.");
  const before = bridge.node.powerLog().length;
  await assert.rejects(
    backend.resize(guest, "linux", size("shared"), { restart: true, agreed: plain.gpu!, installUserspace: async () => assert.fail("not installed: the plan changed") }, signal()),
    (error: unknown) => error instanceof GpuPlanChanged,
  );
  assert.deepEqual(bridge.node.powerLog().slice(before), []);

  const installing = await backend.planResize(guest, "linux", size("shared"), [], signal());
  assert.equal(installing.gpu?.installs, DRIVER);
  bridge.userspaceIn(vmid, DRIVER);
  const resized = await backend.resize(guest, "linux", size("shared"), { restart: true, agreed: installing.gpu!, installUserspace: async () => assert.fail("nothing to install now") }, signal());
  assert.equal(resized.claim?.card, A);
});
