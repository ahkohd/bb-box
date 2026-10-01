// The Tart backend's warm pool on a fake Mac: suspended clones at a kind's
// default size, filled by maintain(), taken by a box of that size, and
// retired when their image, Tart or macOS changes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { TartBackend } from "../src/backends/tart/backend.ts";
import { ownerText } from "../src/backends/tart/host.ts";
import type { AcquireHooks, BoxIdentity, BoxSize, Guest, ReleaseHooks } from "../src/backends/types.ts";
import { FAKE_IMAGE, FAKE_MAC, addImage, fakeMacTools, tartConfig } from "./fake-mac.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const SMALL: BoxSize = { cores: 4, memoryMiB: 8192, diskGiB: null };
const MEDIUM: BoxSize = { cores: 6, memoryMiB: 16384, diskGiB: null };

const made: TartBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

function setup(warm: Record<string, number> = { macos: 1 }) {
  const ssh = fakeSsh();
  const mac = ssh.home(FAKE_MAC);
  fakeMacTools(mac);
  addImage(mac);
  const vmsDir = join(mac, ".tart", "vms");
  // The image's disk, whose file is its build.
  writeFileSync(join(vmsDir, FAKE_IMAGE, "disk.img"), "image");
  const config = tartConfig();
  const contexts: ReturnType<typeof testContext>[] = [];
  const make = (installId = "test", counts = warm) => {
    const context = testContext(new MemoryStorage(), installId, { warm: counts });
    contexts.push(context);
    const backend = new TartBackend(config, context, { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000 });
    made.push(backend);
    return backend;
  };
  const vms = () => readdirSync(vmsDir).filter((name) => !name.startsWith(".") && name !== FAKE_IMAGE);
  const warmVms = () => vms().filter((name) => name.startsWith("bb-box-warm-"));
  const owners = join(mac, ".bb-box", "tart", "owners");
  const owner = (vm: string) => readFileSync(join(owners, vm), "utf8");
  const suspended = (vm: string) => existsSync(join(vmsDir, vm, "state.vzvmsave")) && !existsSync(join(vmsDir, vm, "running"));
  /** The address the fake Mac gives the next VM to ask for one. */
  const nextAddress = () => {
    const counter = join(vmsDir, ".lease");
    return `192.168.64.${existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 2}`;
  };
  const up = (host: string) => rmSync(join(ssh.dir, "down", host), { force: true });
  return { ssh, mac, vmsDir, make, contexts, vms, warmVms, owners, owner, suspended, nextAddress, up };
}

let counter = 0;
function identity(kind = "macos", size = SMALL): BoxIdentity {
  counter++;
  return { boxId: `bxw${counter}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size };
}

function hooks() {
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  const value: AcquireHooks = {
    claim: async (guest) => {
      claimed.push(guest);
    },
    starting: async () => {},
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { hooks: value, claimed, timings };
}

const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(60_000);

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("maintain fills a pool with suspended clones at the default size, which held() and capacity count as warm", async () => {
  const { make, warmVms, owner, suspended } = setup({ macos: 1, "macos-desktop": 1 });
  const backend = make();
  await backend.maintain();
  // macos and macos-desktop share the image and the default size, so one pool of 1 + 1.
  assert.equal(warmVms().length, 2);
  for (const vm of warmVms()) {
    assert.ok(suspended(vm), `${vm} is suspended`);
    assert.match(owner(vm), /^state=warm$/m);
    assert.match(owner(vm), new RegExp(`^image=${FAKE_IMAGE}$`, "m"));
    assert.doesNotMatch(owner(vm), /^box=/m);
  }
  assert.deepEqual(await backend.held(), [], "warm VMs are no box's, so the sweep keeps them");
  const capacity = await backend.capacity("macos-desktop", SMALL, []);
  assert.deepEqual(capacity.warm, { ready: 2, target: 2 });
  assert.equal(capacity.hosts[0]!.limits.find((limit) => limit.resource === "guests")!.used, 0, "a suspended VM holds no slot");
  await backend.maintain();
  assert.equal(warmVms().length, 2, "a full pool stays as it is");
});

test("a box at the default size takes a warm VM, and the pool fills again", async () => {
  const { make, warmVms, owner } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  const box = identity();
  const recorded = hooks();
  const guest = await backend.acquire(box, null, recorded.hooks, signal());
  assert.equal(guest.ref, warm);
  assert.deepEqual(guest.size, SMALL);
  assert.ok("warm" in recorded.timings && !("clone" in recorded.timings), JSON.stringify(recorded.timings));
  assert.match(owner(warm!), new RegExp(`^box=${box.boxId}$`, "m"));
  assert.doesNotMatch(owner(warm!), /^state=/m);
  assert.equal(await backend.power(guest), "running");
  assert.equal((await backend.held()).find((held) => held.ref === warm)?.owner?.boxId, box.boxId);
  await backend.maintain();
  assert.equal(warmVms().filter((vm) => vm !== warm).length, 1, "the pool fills again");
  await backend.release(guest, releasing);
});

test("a box at another size clones, and leaves the warm VM", async () => {
  const { make, warmVms, suspended } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  const box = identity("macos", MEDIUM);
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  assert.deepEqual(guest.size, MEDIUM);
  assert.ok(suspended(warm!));
  await backend.release(guest, releasing);
});

test("a warm VM that does not restore gives way to a clone, and goes", async () => {
  const { make, warmVms, vmsDir, contexts } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  writeFileSync(join(vmsDir, warm!, "state.vzvmsave"), "corrupt");
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  assert.ok(!existsSync(join(vmsDir, warm!)), "the warm VM that failed is deleted");
  assert.ok(contexts[0]!.errors.some((error) => /could not use VM [\s\S]*failed to restore/.test(error)), contexts[0]!.errors.join("\n"));
  await backend.maintain();
  await backend.release(guest, releasing);
});

test("a box whose saved state does not restore boots afresh from its disk", async () => {
  const { make, vmsDir } = setup({});
  const backend = make();
  const guest = await backend.acquire(identity("macos", MEDIUM), null, hooks().hooks, signal());
  await backend.stop(guest);
  writeFileSync(join(vmsDir, guest.ref, "state.vzvmsave"), "corrupt");
  await backend.start(guest);
  assert.equal(await backend.power(guest), "running");
  await backend.release(guest, releasing);
});

test("a fill cut short by a restart is listed with no owner, so the sweep releases it", async () => {
  const { make, vmsDir, owners } = setup({});
  const backend = make();
  const vm = "bb-box-warm-0123456789ab";
  mkdirSync(join(vmsDir, vm), { recursive: true });
  writeFileSync(join(vmsDir, vm, "config.json"), JSON.stringify({ os: "darwin", cpuCount: 4, memorySize: 8 * 2 ** 30 }));
  mkdirSync(owners, { recursive: true });
  writeFileSync(join(owners, vm), ownerText({ install: "test", state: "filling", image: FAKE_IMAGE, build: "1", tart: "2.30.0", macos: "27A1" }));
  const held = (await backend.held()).find((guest) => guest.ref === vm);
  assert.ok(held, "the leftover fill is listed");
  assert.equal(held.owner, null);
  await backend.release(held, releasing);
  assert.ok(!existsSync(join(vmsDir, vm)) && !existsSync(join(owners, vm)));
});

test("a restarted acquire resumes the warm VM it held, and starts over when it had not", async () => {
  const { make, warmVms, owners, owner } = setup({ macos: 2 });
  const backend = make();
  await backend.maintain();
  const [first, second] = warmVms();
  // Held before the restart: the owner file names the box.
  const box = identity();
  writeFileSync(
    join(owners, first!),
    ownerText({ install: "test", kind: box.kind, box: box.boxId, thread: box.threadId, name: box.name, created: box.createdAt }),
  );
  const recorded = hooks();
  const restarted = make();
  const guest = await restarted.acquire(box, { ref: first!, host: "mac1", address: null, size: null, data: { box: box.boxId } }, recorded.hooks, signal());
  assert.equal(guest.ref, first);
  assert.ok(!("place" in recorded.timings) && !("warm" in recorded.timings), JSON.stringify(recorded.timings));
  // Not held yet: the warm VM is still free, and the acquire takes one afresh.
  const other = identity();
  const again = await restarted.acquire(other, { ref: second!, host: "mac1", address: null, size: null, data: { box: other.boxId } }, hooks().hooks, signal());
  assert.equal(again.ref, second);
  assert.match(owner(second!), new RegExp(`^box=${other.boxId}$`, "m"));
  await restarted.maintain();
  await backend.release(guest, releasing);
  await backend.release(again, releasing);
});

test("an acquire that meets a fill holding the last slot takes it over at the fill's size, and stops it at any other", async () => {
  for (const size of [SMALL, MEDIUM]) {
    const { ssh, vmsDir, make, warmVms, owner, nextAddress, up } = setup();
    const backend = make();
    // One box runs, so a fill takes the second, last slot.
    const running = await backend.acquire(identity("macos", MEDIUM), null, hooks().hooks, signal());
    // The fill's VM does not answer until the acquire has made its choice.
    const address = nextAddress();
    ssh.down(address);
    const filling = backend.maintain().catch((error: unknown) => error);
    // The fill has its address, and waits for SSH there.
    await until(() => warmVms().length === 1 && existsSync(join(vmsDir, warmVms()[0]!, "lease")), "the fill to wait for its VM");
    const [fill] = warmVms();
    const box = identity("macos", size);
    const recorded = hooks();
    const acquiring = backend.acquire(box, null, recorded.hooks, signal());
    if (size === SMALL) {
      await until(() => recorded.claimed.length > 0, "the acquire to take the fill over");
      up(address);
      const guest = await acquiring;
      assert.equal(guest.ref, fill, "the box takes the fill's VM over");
      assert.match(owner(fill!), new RegExp(`^box=${box.boxId}$`, "m"));
      assert.equal(await backend.power(guest), "running", "and it is never suspended");
      await backend.release(guest, releasing);
    } else {
      const guest = await acquiring;
      up(address);
      assert.equal(guest.ref, `bb-box-${box.boxId}`, "a box of another size clones");
      assert.ok(!warmVms().includes(fill!), "the fill was stopped and its VM deleted");
      await backend.release(guest, releasing);
    }
    await filling;
    await backend.maintain();
    await backend.release(running, releasing);
  }
});

test("a VM that answers as another is refused", async () => {
  const { ssh, make } = setup({});
  const backend = make();
  const guest = await backend.acquire(identity("macos", MEDIUM), null, hooks().hooks, signal());
  await backend.stop(guest);
  // Another VM has the address now.
  const marker = join(ssh.home(guest.address!), ".config", "bb-box", "vm");
  assert.equal(readFileSync(marker, "utf8").trim(), guest.ref, "the VM keeps its own name");
  writeFileSync(marker, "bb-box-someone-else\n");
  await assert.rejects(backend.start(guest), /The VM that answers is bb-box-someone-else, not bb-box-/);
  await backend.release(guest, releasing);
});

test("warm VMs of an image built again, or saved under another macOS build, are retired and replaced", async () => {
  const { mac, vmsDir, make, warmVms } = setup();
  const backend = make();
  await backend.maintain();
  const [first] = warmVms();
  // The image built again: a new disk file.
  const disk = join(vmsDir, FAKE_IMAGE, "disk.img");
  writeFileSync(`${disk}.new`, "image again");
  renameSync(`${disk}.new`, disk);
  await backend.maintain();
  const [second] = warmVms();
  assert.ok(second && second !== first && !existsSync(join(vmsDir, first!)), "the old warm VM is retired, and a new one made");
  writeFileSync(join(mac, ".fake-macos-build"), "27A2\n");
  await backend.maintain();
  const [third] = warmVms();
  assert.ok(third && third !== second && !existsSync(join(vmsDir, second!)), "a macOS update retires it too");
});

test("two installs never share warm VMs", async () => {
  const { make, warmVms, suspended } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  const other = make("other", {});
  assert.deepEqual((await other.capacity("macos", SMALL, [])).warm, { ready: 0, target: 0 });
  const box = identity();
  const guest = await other.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  assert.ok(suspended(warm!));
  await other.release(guest, releasing);
});
