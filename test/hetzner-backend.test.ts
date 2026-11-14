import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcquireHooks, BoxIdentity, MachineSize, Guest, ReleaseHooks } from "../src/backends/types.ts";
import { billedThisMonth, nextHourOf, spentThisMonth } from "../src/backends/hetzner/spend.ts";
import { FAKE_HETZNER_TOKEN } from "./fake-hetzner.ts";
import { hetznerConfig, hetznerWorld } from "./fake-hetzner-world.ts";

const GiB = 1024;
const box4: MachineSize = { cores: 2, memoryMiB: 4 * GiB, diskGiB: null };
const box4half: MachineSize = { cores: 2, memoryMiB: 4.5 * GiB, diskGiB: null };
const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(30_000);

function hooks() {
  const timings: Record<string, number> = {};
  const claimed: Guest[] = [];
  const value: AcquireHooks = { claim: async (guest) => void claimed.push(guest), starting: async () => {}, timing: (step, ms) => void (timings[step] = ms) };
  return { value, timings, claimed };
}

let counter = 0;
function identity(size: MachineSize = box4, kind = "linux"): BoxIdentity {
  counter++;
  return { boxId: `bxhz${String(counter).padStart(10, "0")}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size: { ...size, gpu: "none" } };
}

async function until(done: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("it never happened");
}

test("with no host, an offer says a new host will take the box, and the first acquire makes one and puts the box on it", async () => {
  const { api, dockerHosts, backend } = hetznerWorld();
  const hetzner = backend();
  const offer = await hetzner.capacity("linux", box4, [], signal());
  assert.equal(offer.ok, true);
  assert.deepEqual(offer.hosts.map((each) => each.host), ["a new cpx42 host"]);
  const { value, timings, claimed } = hooks();
  const guest = await hetzner.acquire(identity(), null, value, signal());
  const [record] = await hetzner.hostRecords.records();
  assert.equal(record!.state, "ready");
  assert.equal(guest.host, record!.serverName);
  assert.equal(guest.data?.hetznerHost, record!.hostId);
  assert.ok(claimed.every((each) => each.data?.hetznerHost === record!.hostId), "every claim names the host, so a restart finds it");
  assert.ok(timings["make a host"] !== undefined);
  assert.deepEqual(dockerHosts.get(record!.hostId)!.containers(), [guest.ref]);
  assert.equal([...api.servers.values()][0]!.status, "running");
  assert.equal(hetzner.label, "Hetzner Cloud", "the provider's name, which on takes, does not change as hosts come and go");
  assert.equal("hosts" in hetzner, false);
  assert.equal(hetzner.kinds().some((kind) => kind.id === "linux-desktop"), false, "a cloud host has no GPU");
});

test("boxes fill the host with the most room before another host is made", async () => {
  const { api, backend } = hetznerWorld();
  const hetzner = backend();
  const first = await hetzner.acquire(identity(), null, hooks().value, signal());
  const second = await hetzner.acquire(identity(), null, hooks().value, signal());
  assert.equal(second.host, first.host);
  assert.equal(api.servers.size, 1);
  const third = await hetzner.acquire(identity(), null, hooks().value, signal());
  assert.equal(third.host, first.host, "16 GiB less 2 kept free holds three 4 GiB boxes");
  const fourth = await hetzner.acquire(identity(), null, hooks().value, signal());
  assert.notEqual(fourth.host, first.host);
  assert.equal(api.servers.size, 2);
});

test("a host more than three quarters full makes the next host ahead, so the next acquire does not wait", async () => {
  const { api, backend } = hetznerWorld();
  const hetzner = backend();
  for (let i = 0; i < 2; i++) await hetzner.acquire(identity(box4half), null, hooks().value, signal());
  assert.equal(api.servers.size, 1, "at 56% no host is made ahead");
  await hetzner.acquire(identity(box4half), null, hooks().value, signal());
  await until(async () => (await hetzner.hostRecords.records()).filter((each) => each.state === "ready").length === 2);
  const { value, timings } = hooks();
  await hetzner.acquire(identity(box4half), null, value, signal());
  assert.equal(timings["make a host"], undefined, "the host made ahead took it");
});

test("at the most hosts, an offer says why and an acquire is refused, and no server is asked for", async () => {
  const { api, backend } = hetznerWorld();
  const hetzner = backend(hetznerConfig({ mostHosts: 1 }));
  for (let i = 0; i < 3; i++) await hetzner.acquire(identity(), null, hooks().value, signal());
  const offer = await hetzner.capacity("linux", box4, [], signal());
  assert.equal(offer.ok, false);
  assert.match(offer.message!, /has the 1 host it may have at once/);
  const error = await hetzner.acquire(identity(), null, hooks().value, signal()).catch((e) => e);
  assert.equal(error.code, "no_capacity");
  assert.equal(api.calls.filter((call) => call.method === "POST" && call.path === "/servers").length, 1);
});

test("a box bigger than a host of the type can hold is refused with the reason", async () => {
  const { backend } = hetznerWorld();
  const offer = await backend().capacity("linux", { cores: 4, memoryMiB: 32 * GiB, diskGiB: null }, [], signal());
  assert.equal(offer.ok, false);
  assert.match(offer.message!, /a cpx42 host has room for at most 13 GiB of boxes/);
  const cores = await backend().capacity("linux", { cores: 12, memoryMiB: 4 * GiB, diskGiB: null }, [], signal());
  assert.match(cores.message!, /has 8 cores, fewer than the 12 asked for/);
});

test("the monthly limit refuses a host when the month's spend so far, and an hour more of every host with it, would pass the limit", async () => {
  const { api, backend } = hetznerWorld();
  const low = await backend(hetznerConfig({ monthlyLimitEurosBeforeVat: 0.1 })).capacity("linux", box4, [], signal());
  assert.equal(low.ok, false);
  assert.match(low.message!, /another host would take this month's spend from EUR 0\.00 to EUR 0\.11 within the hour, past the EUR 0\.10 limit/);
  const ten = backend(hetznerConfig({ monthlyLimitEurosBeforeVat: 10, mostHosts: 2 }));
  assert.equal((await ten.capacity("linux", box4, [], signal())).ok, true, "a low limit still lets a host be made, as hosts go when idle");
  for (let i = 0; i < 4; i++) await ten.acquire(identity(), null, hooks().value, signal());
  assert.equal(api.servers.size, 2);
  const tight = backend(hetznerConfig({ monthlyLimitEurosBeforeVat: 0.3, mostHosts: 3 }));
  for (let i = 0; i < 3; i++) await tight.acquire(identity(), null, hooks().value, signal());
  const refused = await tight.capacity("linux", box4, [], signal());
  assert.equal(refused.ok, false, "the first host's started hour, and an hour more of it and of a second, pass EUR 0.30");
  assert.match(refused.message!, /from EUR 0\.11 to EUR 0\.34 within the hour, past the EUR 0\.30 limit/);
});

test("Hetzner's project limit refuses a host with its reason, and leaves no record", async () => {
  const { api, backend } = hetznerWorld();
  api.projectServerLimit = 0;
  const hetzner = backend();
  const error = await hetzner.acquire(identity(), null, hooks().value, signal()).catch((e) => e);
  assert.equal(error.code, "no_capacity", "a box refused for room goes to the next backend");
  assert.match(error.message, /could not make a cpx42 host: the account is at Hetzner's limit \(\(403 resource_limit_exceeded\): server limit exceeded\)\. Hetzner limits the shared vCPUs of the whole account, 20 for a new one, across all its projects: free some, or ask Hetzner for more on the account's Limits page in the Console\./);
  assert.deepEqual(await hetzner.hostRecords.records(), []);
});

test("a host with no box for the idle time is deleted, a busy one and a recently busy one are kept", async () => {
  const { api, backend } = hetznerWorld();
  const hetzner = backend(hetznerConfig({ mostHosts: 2 }));
  const kept = await hetzner.acquire(identity(), null, hooks().value, signal());
  for (let i = 0; i < 3; i++) await hetzner.acquire(identity(), null, hooks().value, signal());
  const records = await hetzner.hostRecords.records();
  assert.equal(records.length, 2);
  const other = records.find((each) => each.serverName !== kept.host)!;
  const onOther = (await hetzner.held(signal())).filter((each) => each.host === other.serverName);
  for (const guest of onOther) await hetzner.release(guest, releasing, signal());
  api.advanceClock(29 * 60_000);
  await hetzner.maintain(signal());
  assert.equal(api.servers.size, 2, "29 minutes idle is not yet idle");
  api.advanceClock(2 * 60_000);
  await hetzner.maintain(signal());
  assert.deepEqual([...api.servers.values()].map((each) => each.name), [kept.host], "the idle host went; the one with boxes stays, however long ago it was last busy");
});

test("held lists every host's boxes with their host, and leaves out only a host that does not answer", async () => {
  const { dockerHosts, backend } = hetznerWorld();
  const hetzner = backend();
  const guests = [];
  for (let i = 0; i < 4; i++) guests.push(await hetzner.acquire(identity(), null, hooks().value, signal()));
  const held = await hetzner.held(signal());
  assert.deepEqual(held.map((each) => each.ref).sort(), guests.map((each) => each.ref).sort());
  assert.ok(held.every((each) => typeof each.data?.hetznerHost === "string" && each.host?.startsWith("bb-box-hz-test-")));
  const lastHost = guests[3]!.data!.hetznerHost as string;
  dockerHosts.get(lastHost)!.set({ down: true });
  const answering = await hetzner.held(signal());
  assert.deepEqual(answering.map((each) => each.ref).sort(), guests.slice(0, 3).map((each) => each.ref).sort());
  assert.equal(await hetzner.power(guests[3]!, signal()), "unknown", "a box on a host that does not answer is not taken for gone");
});

test("a resumed acquire stays on its host, and a box whose host is gone is released as gone", async () => {
  const { api, backend } = hetznerWorld();
  const hetzner = backend();
  const { value, claimed } = hooks();
  const box = identity();
  const guest = await hetzner.acquire(box, null, value, signal());
  await hetzner.release(guest, releasing, signal());
  const again = await hetzner.acquire(box, claimed[0]!, hooks().value, signal());
  assert.equal(again.host, guest.host);
  const record = (await hetzner.hostRecords.records())[0]!;
  api.servers.delete(record.serverId!);
  await hetzner.maintain(signal());
  assert.equal(await hetzner.power(again, signal()), null);
  await hetzner.release(again, releasing, signal());
});

test("a restart finds its hosts and boxes from storage", async () => {
  const { backend } = hetznerWorld();
  const { MemoryStorage } = await import("./helpers.ts");
  const storage = new MemoryStorage();
  const before = backend(hetznerConfig(), storage);
  const guest = await before.acquire(identity(), null, hooks().value, signal());
  const after = backend(hetznerConfig(), storage);
  assert.deepEqual((await after.held(signal())).map((each) => each.ref), [guest.ref]);
  assert.equal(await after.power(guest, signal()), "running");
  await after.release(guest, releasing, signal());
});

test("the doctor lists each host with its age, boxes and cost, the month's spend, and warns of a server no host claims, never showing the token", async () => {
  const { api, backend } = hetznerWorld();
  const hetzner = backend(hetznerConfig({ monthlyLimitEurosBeforeVat: 100 }));
  await hetzner.acquire(identity(), null, hooks().value, signal());
  api.advanceClock(90 * 60_000);
  const raw = await import("../src/backends/hetzner/api.ts");
  await new raw.Hetzner({ token: FAKE_HETZNER_TOKEN, fetch: api.fetch, sleep: async () => {} }).createServer({
    name: "bb-box-test-stray0001",
    serverType: "cpx42",
    location: "nbg1",
    imageNameOrSnapshotId: "ubuntu-24.04",
    labels: { "bbbox-install": "test", "bbbox-host": "stray0001", "bbbox-role": "host" },
  });
  const report = await hetzner.doctor(signal());
  const byId = new Map(report.checks.map((each) => [each.id, each]));
  assert.equal(byId.get("hetzner.api")!.status, "ok");
  assert.match(byId.get("hetzner.hosts")!.detail, /bb-box-hz-test-[a-z0-9]{8} \(cpx42\): ready, 90 minutes old, 1 box, EUR 0\.\d\d this month/);
  assert.equal(byId.get("hetzner.unclaimed")!.status, "warn");
  assert.match(byId.get("hetzner.unclaimed")!.detail, /bb-box-test-stray0001/);
  assert.match(byId.get("hetzner.spend")!.detail, /EUR 0\.\d\d before VAT so far this month of the EUR 100\.00 limit\. An hour more of the 1 host and a new one would take it to EUR 0\.\d\d\./);
  assert.match(byId.get("hetzner.type")!.detail, /8 cores, 16 GB memory, 320 GB disk in nbg1, EUR 0\.11 an hour and at most EUR 69\.99 a month with its IPv4, before VAT/);
  assert.ok([...byId.keys()].some((id) => id.startsWith("hetzner.host.bb-box-hz-test-")));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(FAKE_HETZNER_TOKEN));
});

test("the doctor fails the API check with what to do when the token is refused, and never shows it", async () => {
  const { backend } = hetznerWorld();
  const report = await backend(hetznerConfig({ token: `${FAKE_HETZNER_TOKEN}-wrong` })).doctor(signal());
  const api = report.checks.find((each) => each.id === "hetzner.api")!;
  assert.equal(api.status, "fail");
  assert.match(api.fix!, /Read & Write API token/);
  assert.equal(report.ok, false);
  assert.doesNotMatch(JSON.stringify(report), /hcloud-fake-token/);
});

test("the month's spend counts each server's started hours at its hourly price, capped at its monthly one", () => {
  const price = { hourly: 0.1122, monthly: 69.99 };
  const now = Date.UTC(2026, 9, 22, 12);
  assert.equal(billedThisMonth({ hostId: "a", startedAtMs: now - 90 * 60_000, endedAtMs: null }, price, now), 2 * 0.1122);
  assert.equal(billedThisMonth({ hostId: "b", startedAtMs: Date.UTC(2026, 8, 1), endedAtMs: null }, price, Date.UTC(2026, 9, 30, 12)), 69.99, "capped at the month's price");
  assert.ok(Math.abs(billedThisMonth({ hostId: "b", startedAtMs: Date.UTC(2026, 8, 1), endedAtMs: null }, price, now) - 516 * 0.1122) < 1e-9, "from the month's start, not the server's");
  assert.equal(billedThisMonth({ hostId: "c", startedAtMs: Date.UTC(2026, 8, 1), endedAtMs: Date.UTC(2026, 8, 30) }, price, now), 0, "last month's server costs nothing this month");
  assert.equal(billedThisMonth({ hostId: "d", startedAtMs: Date.UTC(2026, 8, 30, 23), endedAtMs: Date.UTC(2026, 9, 1, 2) }, price, now), 2 * 0.1122, "only this month's hours");
  assert.ok(Math.abs(spentThisMonth([{ hostId: "a", startedAtMs: now - 90 * 60_000, endedAtMs: null }, { hostId: "e", startedAtMs: now - 30 * 60_000, endedAtMs: now - 10 * 60_000 }], price, now) - 3 * 0.1122) < 1e-9);
  assert.equal(nextHourOf(2, price), 2 * 0.1122);
  assert.equal(billedThisMonth({ hostId: "f", startedAtMs: now, endedAtMs: null }, price, now), 0.1122, "a server just made has its first hour billed");
});

test("a host that never answers is deleted after the idle time; one that answered and went quiet is kept for a day", async () => {
  const { api, dockerHosts, silentFromTheStart, backend } = hetznerWorld();
  const hetzner = backend();
  silentFromTheStart.add("silent01");
  const raw = await import("../src/backends/hetzner/api.ts");
  await new raw.Hetzner({ token: FAKE_HETZNER_TOKEN, fetch: api.fetch, sleep: async () => {} }).createServer({
    name: "bb-box-test-silent01",
    serverType: "cpx42",
    location: "nbg1",
    imageNameOrSnapshotId: "ubuntu-24.04",
    labels: { "bbbox-install": "test", "bbbox-host": "silent01", "bbbox-role": "host" },
  });
  await hetzner.acquire(identity(), null, hooks().value, signal());
  await hetzner.held(signal());
  const answered = (await hetzner.hostRecords.records()).find((each) => each.hostId !== "silent01")!;
  dockerHosts.get(answered.hostId)!.set({ down: true });
  api.advanceClock(31 * 60_000);
  await hetzner.maintain(signal());
  assert.deepEqual([...api.servers.values()].map((each) => each.name), [answered.serverName]);
  api.advanceClock(24 * 3_600_000);
  await hetzner.maintain(signal());
  assert.equal(api.servers.size, 0);
});

test("a box with a disk of its own is refused, as a Docker box shares its host's disk", async () => {
  const { backend } = hetznerWorld();
  const offer = await backend().capacity("linux", { ...box4, diskGiB: 32 }, [], signal());
  assert.equal(offer.ok, false);
  assert.match(offer.message!, /shares its host's disk/);
});

test("two installs on one project make hosts of their own and leave each other's boxes alone", async () => {
  const { backend } = hetznerWorld();
  const mine = backend(hetznerConfig(), undefined, "test");
  const other = backend(hetznerConfig(), undefined, "test-other");
  const my = await mine.acquire(identity(), null, hooks().value, signal());
  const theirs = await other.acquire(identity(), null, hooks().value, signal());
  assert.notEqual(my.host, theirs.host);
  assert.equal((await other.held(signal())).find((guest) => guest.ref === my.ref), undefined);
  assert.equal((await mine.held(signal())).find((guest) => guest.ref === theirs.ref), undefined);
  assert.equal(await other.power(my, signal()), null);
  await assert.rejects(other.stop(my, signal()), (error: { code?: string }) => error.code === "gone");
  await other.release(my, releasing, signal());
  await other.maintain(signal());
  assert.equal(await mine.power(my, signal()), "running");
  assert.equal(await other.power(theirs, signal()), "running");
  await other.release(theirs, releasing, signal());
  await mine.release(my, releasing, signal());
});
