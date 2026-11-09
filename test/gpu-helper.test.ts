import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { parseGpuReport } from "../src/backends/proxmox-lxc/backend.ts";
import { CARD_A, CARD_B, FakeNode, INSTALL, POOL, REPORT_VMID, boxLabels, cardLines, exited, heldCopyLabels, helperConstant, marker, otherKeys, pciOf, type FakeCard, type GuestSpec } from "./gpu-helper/node.ts";

const FAKETIME = ["/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1", "/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1", "/usr/lib/faketime/libfaketime.so.1"].find((path) => existsSync(path));

const A = CARD_A.uuid;
const B = CARD_B.uuid;
const TUN = "/dev/net/tun";

function claims(node: FakeNode): string[] {
  return node.reportLines().filter((line) => line.startsWith("claim "));
}

function lines(node: FakeNode, prefix: string): string[] {
  return node.reportLines().filter((line) => line.startsWith(`${prefix} `));
}

function ran(node: FakeNode, args: readonly string[] = ["--once"], env: Readonly<Record<string, string>> = {}): string {
  const result = node.run(args, env);
  assert.equal(result.status, 0, `bb-box-gpu ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stderr;
}

function snapshot(node: FakeNode, vmids: readonly number[]): Map<number, string> {
  return new Map(vmids.map((vmid) => [vmid, node.text(vmid)]));
}

function assertUnchanged(node: FakeNode, before: Map<number, string>): void {
  for (const [vmid, text] of before) assert.equal(node.text(vmid), text, `CT ${vmid}'s config changed`);
}

test("writes are off unless gpu.conf, owned by the helper's user alone, says on, and pve-container is a version the release was tested on", () => {
  const cases: { readonly name: string; readonly setup: (node: FakeNode) => void; readonly writes: "on" | "off"; readonly error: RegExp | null }[] = [
    { name: "no gpu.conf", setup: (node) => rmSync(node.file("etc/bb-box/gpu.conf")), writes: "off", error: /^error no \/etc\/bb-box\/gpu\.conf$/ },
    { name: "writes off", setup: (node) => node.setHelperConfig(["bbbox"], "off"), writes: "off", error: null },
    { name: "a gpu.conf others may write", setup: (node) => node.setHelperConfig(["bbbox"], "on", 0o666), writes: "off", error: /not owned by this user alone, so writes stay off/ },
    { name: "an untested pve-container", setup: (node) => (node.setHelperConfig(["bbbox"], "on"), node.write("pve-container-version", "6.2.1\n")), writes: "off", error: /pve-container 6\.2\.1 is not a version this release was tested on/ },
    { name: "a line it cannot read", setup: (node) => node.write("etc/bb-box/gpu.conf", "pools bbbox\nwrites maybe\n"), writes: "off", error: /has a line this release cannot read/ },
    { name: "writes on, tested", setup: (node) => node.setHelperConfig(["bbbox"], "on"), writes: "on", error: null },
  ];
  for (const { name, setup, writes, error } of cases) {
    const node = new FakeNode();
    if (name === "a line it cannot read") chmodSync(node.file("etc/bb-box/gpu.conf"), 0o600);
    setup(node);
    node.guest(200, { box: "bx200", marker: marker("shared", CARD_A, 1) });
    ran(node);
    const helper = lines(node, "helper")[0]!;
    assert.match(helper, new RegExp(`^helper bb-box-gpu \\S+ protocol 1 writes ${writes} pve-container \\S+ (?:tested|untested)$`), name);
    if (error) assert.ok(lines(node, "error").some((line) => error.test(line)), `${name}: ${lines(node, "error").join(" | ")}`);
    assert.deepEqual(node.guestWrites(), writes === "on" ? ["lxc 200"] : [], name);
  }
});

test("in a dry run the helper writes no guest: it logs and reports each write it would make, and grants only what needs no write", () => {
  const node = new FakeNode({ writes: "off" });
  node.guest(200, { box: "bx200", marker: marker("shared", CARD_A, 1), lines: [TUN] });
  node.guest(201, { box: "bx201", kind: "linux-desktop", marker: marker("none", null, 1), lines: [...cardLines(CARD_B, "desktop"), TUN] });
  node.guest(202, { box: "bx202", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: [...cardLines(CARD_B, "desktop"), TUN], running: true });
  node.guest(203, { box: "bx203", kind: "linux-desktop", lines: [...cardLines(CARD_A, "desktop"), TUN] });
  node.guest(204, { box: "bx204", marker: marker("whole", CARD_B, 1) });
  const before = snapshot(node, [200, 201, 202, 203, 204]);
  const first = ran(node);
  const second = ran(node);
  assertUnchanged(node, before);
  assert.deepEqual(node.guestWrites(), []);
  assert.ok(node.writes().every((write) => write === `qemu ${REPORT_VMID}`), "only the report VM is written");
  assert.match(first, /would write CT 200 for request g1: remove nothing; add \/dev\/nvidia1,mode=0666, \/dev\/nvidiactl,mode=0666, \/dev\/nvidia-uvm,mode=0666, \/dev\/nvidia-uvm-tools,mode=0666/);
  assert.match(first, /would write CT 201 for request g1: remove dev0 \/dev\/nvidia0,mode=0666, .*dev6 \/dev\/dri\/card1,mode=0666; add nothing/);
  assert.match(second, /would write CT 200 for request g1/, "each run of --once logs what it would write");
  assert.deepEqual(lines(node, "would"), [`would 200 lines ${A} server for request g1`, "would 201 lines none for request g1"]);
  assert.deepEqual(claims(node), [`claim 204 g1 refused card-held ${B} 201`, `claim 202 g1 granted shared ${B}`]);
  assert.deepEqual(lines(node, "holder"), [
    `holder ${A} 203 shared stopped install ${INSTALL} unmanaged`,
    `holder ${B} 201 shared stopped install ${INSTALL} unmanaged`,
    `holder ${B} 202 shared running install ${INSTALL} managed`,
  ]);
  const ledger = node.ledger();
  assert.deepEqual(ledger.guests["202"]!.claim, { ...ledger.guests["202"]!.claim, generation: 1, part: "shared", card: B, answer: "granted" });
  assert.equal(ledger.guests["200"]?.claim, undefined, "a request that needs a write is not answered while writes are off");
  assert.equal(ledger.guests["200"]?.answered ?? 0, 0);
});

test("with writes off, no path writes a guest: a request, a yield, a copy's lines, a rollback, a lost ledger's conflicts and the boot pass are each logged and reported as a write it would make", () => {
  const node = new FakeNode({ writes: "off" });
  node.guest(210, { box: "bx210", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "server") });
  node.guest(211, { box: "bx211", marker: marker("whole", CARD_A, 1) });
  node.guest(220, { box: "bx220", name: "calm-reef", marker: marker("shared", CARD_B, 2), lines: cardLines(CARD_B, "server") });
  node.guest(221, { box: "bx220", name: "calm-reef", hostname: "bb-box-copy-221", marker: marker("shared", CARD_B, 2), lines: cardLines(CARD_B, "server") });
  node.guest(230, { box: "bx230", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") });
  node.write("var/lib/bb-box-gpu/ledger", JSON.stringify({ protocol: 1, answers: [], guests: { "230": { box: `${INSTALL}/bx230`, answered: 2, claim: { generation: 2, part: "shared", card: A, answer: "granted", at: 1 } } } }));
  const vmids = [210, 211, 220, 221, 230];
  const before = snapshot(node, vmids);
  const stderr = ran(node) + ran(node) + ran(node, ["--boot"]);
  assertUnchanged(node, before);
  assert.deepEqual(node.guestWrites(), []);
  assert.deepEqual(lines(node, "would"), [
    `would 211 lines ${A} server for request g1`,
    "would 221 lines none for copy of 220",
    `would 230 lines ${A} server for claim g2`,
    "would 210 lines none for yield to 211 g1",
  ].sort());
  assert.match(stderr, /boot pass: 0 running guests on the wrong lines, writes off/);
  assert.match(stderr, /would write CT 230 for claim g2/);
  assert.ok(!/wrote CT/.test(stderr), stderr);
  assert.deepEqual(node.guestLocks(), [], "with writes off it takes no guest's config lock: it decides from a read");
  const stored = node.ledger().guests;
  assert.ok(Object.values(stored).every((entry) => !entry.strip && entry.claim?.answer !== "yielded"), "nothing it would carry out with writes on is stored");

  const lost = new FakeNode({ writes: "off", ledger: false });
  lost.guest(240, { box: "bx240", name: "tidy-glade", marker: marker("shared", CARD_A, 3), lines: cardLines(CARD_A, "server"), running: true });
  lost.guest(241, { box: "bx240", name: "tidy-glade", hostname: "bb-box-copy-241", marker: marker("shared", CARD_A, 3), lines: cardLines(CARD_A, "server") });
  const lostBefore = snapshot(lost, [240, 241]);
  ran(lost);
  ran(lost, ["--boot"]);
  assertUnchanged(lost, lostBefore);
  assert.deepEqual(lost.guestWrites(), []);
  assert.deepEqual(lost.guestLocks(), []);
  assert.deepEqual(lines(lost, "would"), [], "a rebuilt ledger refuses a stopped copy and leaves its lines");
  assert.ok(claims(lost).includes(`claim 241 g3 refused copy ${A} 240`), claims(lost).join("\n"));
});

test("--help and --version say what the helper is, and an argument it cannot read is refused", () => {
  const node = new FakeNode();
  const help = node.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^bb-box-gpu 0\.4\.3, protocol 1: the host's GPU helper for bb-box\./);
  assert.match(help.stdout, /Writes are off\s+unless/);
  assert.match(help.stdout, /bb-box-gpu --preview\n\s+one pass as writes on would make it, changing nothing/);
  assert.equal(node.run(["--version"]).stdout, "bb-box-gpu 0.4.3 protocol 1\n");
  const wrong = node.run(["--writes-on"]);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /cannot read '--writes-on'/);
  assert.deepEqual(node.writes(), []);
});

test("it leaves alone every guest it must: outside its pools, privileged, a template, running, locked, with pending device changes, malformed or double markers, not BB Box's, unmarked with NVIDIA lines, and an unknown card (section 14)", () => {
  const node = new FakeNode({ writes: "on" });
  const ask = marker("shared", CARD_A, 2);
  node.guest(300, { box: "bx300", marker: ask, pool: "elsewhere" });
  node.guest(301, { box: "bx301", marker: ask, unprivileged: false });
  node.guest(302, { box: "bx302", marker: ask, template: true, lines: cardLines(CARD_A, "desktop") });
  node.guest(303, { box: "bx303", marker: ask, running: true });
  node.guest(304, { box: "bx304", marker: ask, lock: "backup" });
  node.guest(305, { box: "bx305", marker: ask, pending: { dev3: "/dev/nvidia0,mode=0666" } });
  node.guest(306, { box: "bx306", marker: `gpu.shared.GPU-${A.toUpperCase()}.g2` });
  node.guest(307, { box: "bx307", marker: [marker("shared", CARD_A, 2), marker("none", null, 3)] });
  node.guest(308, { description: "Notes the operator wrote.", tags: ["training"], marker: ask });
  node.guest(309, { box: "bx309", kind: "linux-desktop", lines: [...cardLines(CARD_A, "desktop"), TUN] });
  node.guest(310, { box: "bx310", marker: "gpu.shared.00000000-1111-4222-8333-444444444444.g2" });
  node.guest(311, { box: "bx311", marker: "gpu.none.g01" });
  node.guest(312, { box: "bx312", marker: "gpu.none.g0" });
  node.guest(313, { box: "bx313", marker: "GPU.none.g2" });
  node.guest(314, { box: "bx314", marker: ask, pending: { delete: "dev2" } });
  const vmids = [300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314];
  const before = snapshot(node, vmids);
  ran(node);
  ran(node);
  assertUnchanged(node, before);
  assert.deepEqual(node.guestWrites(), []);
  assert.deepEqual(new Set(claims(node)), new Set([
    `claim 300 g2 refused not-served ${A}`,
    `claim 301 g2 refused privileged ${A}`,
    `claim 302 g2 refused template ${A}`,
    `claim 303 g2 refused running ${A}`,
    `claim 304 g2 refused locked ${A} backup`,
    `claim 305 g2 refused pending ${A}`,
    "claim 306 g0 refused malformed -",
    "claim 307 g0 refused malformed -",
    `claim 308 g2 refused not-bb-box ${A}`,
    "claim 310 g2 refused unknown-card 00000000-1111-4222-8333-444444444444",
    "claim 311 g0 refused malformed -",
    "claim 312 g0 refused malformed -",
    "claim 313 g0 refused malformed -",
    `claim 314 g2 refused pending ${A}`,
  ]));
  assert.equal(claims(node).length, 14, "each is answered once, though the helper ran twice");
  assert.ok(lines(node, "holder").includes(`holder ${A} 309 shared stopped install ${INSTALL} unmanaged`));
  assert.ok(!lines(node, "holder").some((line) => line.includes(" 302 ")), "a template holds no card");
});

test("a grant replaces only the current section's NVIDIA and DRM lines, worked out from the card's UUID now: index 0 is /dev/nvidia1 and card2", () => {
  const node = new FakeNode({ writes: "on" });
  const snapshotSection = { arch: "amd64", hostname: "box-400", dev0: "/dev/nvidia0,mode=0666", dev1: TUN, tags: `bb-box;${marker("shared", CARD_B, 1)}` };
  node.guest(400, {
    box: "bx400",
    kind: "linux-desktop",
    marker: marker("shared", CARD_A, 2),
    lines: [...cardLines(CARD_B, "desktop"), TUN, "/dev/null,mode=0600", "/dev/nvidia-caps/nvidia-cap1,mode=0444"],
    lxc: [["lxc.apparmor.profile", "generated"], ["lxc.mount.entry", "/dev/fuse dev/fuse none bind,create=file"]],
    pending: { memory: "4096" },
    snapshots: { before: snapshotSection },
  });
  node.guest(401, { box: "bx401", kind: "linux", marker: marker("shared", CARD_B, 1), lines: [TUN] });
  node.guest(402, { box: "bx402", kind: "linux", marker: marker("none", null, 3), lines: [`path=/dev/nvidia1,mode=0666`, "/dev/nvidiactl", TUN, "/dev/dri/renderD129,uid=1000"] });
  const before = node.config(400);
  ran(node);
  const after = node.config(400);
  assert.deepEqual(node.lines(400), cardLines(CARD_A, "desktop"));
  assert.deepEqual(Object.keys(after.keys).filter((key) => /^dev/.test(key)).sort(), ["dev0", "dev1", "dev2", "dev3", "dev4", "dev5", "dev6", "dev7", "dev8"]);
  assert.deepEqual(otherKeys(after.keys), { ...otherKeys(before.keys) }, "every other line of the section stays as it is");
  assert.equal(after.keys.dev7, TUN);
  assert.equal(after.keys.dev8, "/dev/null,mode=0600");
  assert.deepEqual(after.lxc, before.lxc, "raw lxc lines are never written");
  assert.deepEqual(after.sections, before.sections, "the pending section and the snapshots stay as they are");
  assert.equal(after.description, before.description);
  assert.deepEqual(node.lines(401), cardLines(CARD_B, "server"), "a server gets the card's NVIDIA nodes and no DRM nodes");
  assert.deepEqual(node.lines(402), [], "none takes out every NVIDIA and DRM line");
  assert.equal(node.config(402).keys.dev2, TUN);
  assert.deepEqual(node.guestWrites().sort(), ["lxc 400", "lxc 401", "lxc 402"]);
  assert.deepEqual(claims(node), [`claim 402 g3 granted none`, `claim 401 g1 granted shared ${B}`, `claim 400 g2 granted shared ${A}`]);
  ran(node);
  assert.equal(node.guestWrites().length, 3, "a granted claim whose lines match is not written again");
});

test("a change of GPU part alone on a running guest needs no write, and each generation is answered once", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(500, { box: "bx500", marker: marker("shared", CARD_A, 1), lines: [...cardLines(CARD_A, "server"), TUN], running: true });
  ran(node);
  node.mark(500, marker("whole", CARD_A, 2));
  ran(node);
  node.mark(500, marker("shared", CARD_A, 3));
  ran(node);
  assert.deepEqual(node.guestWrites(), []);
  assert.deepEqual(claims(node), [`claim 500 g3 granted shared ${A}`, `claim 500 g2 granted whole ${A}`, `claim 500 g1 granted shared ${A}`]);

  node.guest(600, { box: "bx600", marker: marker("shared", CARD_A, 1), running: true });
  ran(node);
  assert.ok(claims(node).includes(`claim 600 g1 refused running ${A}`));
  node.setRunning(600, false);
  ran(node);
  assert.deepEqual(node.lines(600), [], "a refused generation is not granted later, when the guest has stopped");
  assert.equal(claims(node).filter((line) => line.startsWith("claim 600 ")).length, 1);
  node.mark(600, marker("shared", CARD_A, 2));
  ran(node);
  assert.deepEqual(node.lines(600), cardLines(CARD_A, "server"));
  assert.ok(claims(node).includes(`claim 600 g2 granted shared ${A}`));
});

test("two requests racing for one card: one is granted and the other refused, with one helper or two at once", async () => {
  for (const [first, second] of [["whole", "whole"], ["whole", "shared"]] as const) {
    const node = new FakeNode({ writes: "on" });
    node.guest(700, { box: "bx700", marker: marker(first, CARD_A, 1) });
    node.guest(701, { box: "bx701", marker: marker(second, CARD_A, 1) });
    const helpers = [node.start(["--once"]), node.start(["--once"])];
    assert.deepEqual(await Promise.all(helpers.map(exited)), [0, 0], helpers.map((helper) => helper.output()).join("\n"));
    const answers = claims(node);
    assert.equal(answers.filter((line) => / granted /.test(line)).length, 1, `${first} and ${second}: ${answers.join(" | ")}`);
    assert.equal(answers.filter((line) => / refused (?:whole-taken|card-held) /.test(line)).length, 1, `${first} and ${second}: ${answers.join(" | ")}`);
    assert.equal(answers.length, 2, "each request is answered once");
    assert.equal(node.guestWrites().length, 1, "only the winner's lines are written");
  }
});

test("the check that a guest is stopped is inside its config lock: a start that holds the lock wins, and nothing is written", async () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(710, { box: "bx710", marker: marker("shared", CARD_A, 1) });
  const before = node.text(710);
  const start = node.holdLock(710, 0.6, "start");
  await start.locked;
  ran(node);
  await exited(start);
  assert.equal(node.text(710), before);
  assert.deepEqual(node.guestWrites(), []);
  assert.deepEqual(claims(node), [`claim 710 g1 refused running ${A}`]);
});

test("whole: refused while another guest has the card's devices or holds it whole; stopped shared boxes the helper manages yield, unless one starts first", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(800, { description: "A guest of another tool", lxc: [["lxc.mount.entry", "/dev/nvidia1 dev/nvidia1 none bind,optional,create=file"], ["lxc.cgroup2.devices.allow", "c 195:1 rwm"]], running: true, pool: "other" });
  node.guest(801, { box: "bx801", marker: marker("whole", CARD_A, 1) });
  ran(node);
  assert.deepEqual(claims(node), [`claim 801 g1 refused card-held ${A} 800`]);
  assert.ok(lines(node, "holder").includes(`holder ${A} 800 shared running other unmanaged`));

  node.remove(800);
  node.guest(802, { box: "bx802", marker: marker("shared", CARD_A, 1), lines: [...cardLines(CARD_A, "server"), TUN] });
  node.guest(803, { box: "bx803", marker: marker("whole", CARD_A, 1) });
  ran(node);
  assert.deepEqual(node.lines(802), [], "the stopped shared box gives up the card's devices");
  assert.ok(Object.values(node.config(802).keys).includes(TUN), "its other lines stay");
  assert.deepEqual(node.lines(803), cardLines(CARD_A, "server"));
  assert.ok(claims(node).includes(`claim 802 g1 yielded ${A} 803`));
  assert.ok(claims(node).includes(`claim 803 g1 granted whole ${A}`));
  assert.ok(lines(node, "holder").includes(`holder ${A} 803 whole stopped install ${INSTALL} managed`));
  ran(node);
  assert.deepEqual(node.lines(802), [], "a yielded box is not given its lines back");

  node.guest(804, { box: "bx804", marker: marker("shared", CARD_A, 1) });
  ran(node);
  assert.ok(claims(node).includes(`claim 804 g1 refused whole-taken ${A} 803`));
  assert.deepEqual(node.lines(804), []);

  node.guest(805, { box: "bx805", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") });
  ran(node);
  node.setRunning(805, true);
  node.guest(806, { box: "bx806", marker: marker("whole", CARD_B, 1) });
  ran(node);
  assert.ok(claims(node).includes(`claim 806 g1 refused card-held ${B} 805`), "a running shared box does not yield");
  assert.deepEqual(node.lines(805), cardLines(CARD_B, "server"));
});

test("071 unit 8b: a whole claim yields only the asking install's own stopped shared boxes in its own pool; another install's, or this install's in another pool, keeps its lines, and the claim is refused", () => {
  const node = new FakeNode({ writes: "on", pools: [POOL, "team"] });
  node.guest(820, { box: "bx820", install: "9zz2", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "server") });
  node.guest(822, { box: "bx822", pool: "team", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") });
  ran(node);
  assert.ok(claims(node).includes(`claim 820 g1 granted shared ${A}`) && claims(node).includes(`claim 822 g1 granted shared ${B}`), claims(node).join("\n"));
  const before = snapshot(node, [820, 822]);
  node.guest(821, { box: "bx821", marker: marker("whole", CARD_A, 1) });
  node.guest(823, { box: "bx823", marker: marker("whole", CARD_B, 1) });
  ran(node);
  assert.ok(claims(node).includes(`claim 821 g1 refused card-held ${A} 820`), "another install's stopped shared box blocks the card");
  assert.ok(claims(node).includes(`claim 823 g1 refused card-held ${B} 822`), "this install's stopped shared box in another pool blocks the card");
  assertUnchanged(node, before);
  assert.ok(!claims(node).some((line) => / yielded /.test(line)), "nothing yielded");
  assert.deepEqual(node.lines(821), []);
  assert.deepEqual(node.lines(823), []);

  node.remove(822);
  node.guest(824, { box: "bx824", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") });
  ran(node);
  node.guest(825, { box: "bx825", marker: marker("whole", CARD_B, 1) });
  ran(node);
  assert.ok(claims(node).includes(`claim 824 g1 yielded ${B} 825`), "this install's own stopped shared box in its pool still yields");
  assert.ok(claims(node).includes(`claim 825 g1 granted whole ${B}`));
  assert.deepEqual(node.lines(824), []);
});

test("a lost ledger is rebuilt from the guests: matching guests are granted; a stopped copy, a guest whose lines do not match and a whole box whose card a stopped box still has are refused and keep their lines, and BB Box's next request decides them (re-review R3)", () => {
  const node = new FakeNode({ writes: "on", ledger: false });
  node.guest(900, { box: "bx900", name: "amber-fox", marker: marker("shared", CARD_A, 3), lines: cardLines(CARD_A, "server"), running: true });
  const copy = { box: "bx900", name: "amber-fox", hostname: "bb-box-copy-901", marker: marker("shared", CARD_A, 3), lines: cardLines(CARD_A, "server") };
  const yielding = { box: "bx903", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") };
  node.guest(901, copy);
  node.guest(902, { box: "bx902", marker: marker("whole", CARD_B, 2), lines: cardLines(CARD_B, "server"), running: true });
  node.guest(903, yielding);
  node.guest(904, { box: "bx904", marker: marker("shared", CARD_B, 4), lines: cardLines(CARD_A, "server") });
  node.guest(905, { box: "bx905", marker: marker("none", null, 2) });
  const before = snapshot(node, [900, 901, 902, 903, 904, 905]);
  const stderr = ran(node);
  assert.match(stderr, /the ledger was rebuilt from the guests: 3 granted, 0 yielded, 1 refused as copies, 1 refused as their lines did not match their marker/);
  assertUnchanged(node, before);
  assert.deepEqual(node.guestWrites(), [], "recovery writes no guest");
  const ledger = node.ledger();
  assert.equal(ledger.guests["900"]!.claim!.answer, "granted");
  assert.equal(ledger.guests["903"]!.claim!.answer, "granted");
  assert.equal(ledger.guests["905"]!.claim!.part, "none");
  assert.equal(ledger.guests["902"]!.claim, undefined, "no whole grant while a stopped box still has the card's lines");
  assert.ok(Object.values(ledger.guests).every((entry) => !entry.strip && !entry.proposed_strip), JSON.stringify(ledger.guests));
  assert.ok(claims(node).includes(`claim 901 g3 refused copy ${A} 900`), claims(node).join("\n"));
  assert.ok(claims(node).includes(`claim 902 g2 refused ledger-lost ${B} 903`));
  assert.ok(claims(node).includes(`claim 904 g4 refused ledger-lost ${B}`));
  ran(node);
  ran(node, ["--boot"]);
  assertUnchanged(node, before);
  assert.deepEqual(node.guestWrites(), [], "nor does a later pass, or the boot pass");
  node.mark(902, marker("whole", CARD_B, 3));
  ran(node);
  assert.ok(claims(node).includes(`claim 902 g3 granted whole ${B}`), "BB Box's next request for the whole box is answered");
  assert.deepEqual(node.lines(903), [], "and the stopped shared box yields to it then");
  assert.deepEqual(node.lines(901), cardLines(CARD_A, "server"), "the copy keeps its lines until it asks");
  node.mark(904, marker("shared", CARD_B, 5));
  ran(node);
  assert.ok(claims(node).includes(`claim 904 g5 refused whole-taken ${B} 902`), "BB Box's next request is answered");
  assert.deepEqual(node.lines(904), cardLines(CARD_A, "server"), "a refusal changes nothing");
});

test("an unreadable ledger is set aside and rebuilt, and a ledger.new left by a cut-short write is ignored", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(910, { box: "bx910", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "server") });
  ran(node);
  const good = readFileSync(node.ledgerPath(), "utf8");
  writeFileSync(`${node.ledgerPath()}.new`, good.slice(0, 40));
  ran(node);
  assert.equal(node.ledger().guests["910"]!.claim!.answer, "granted");
  writeFileSync(node.ledgerPath(), good.slice(0, good.length / 2));
  const stderr = ran(node);
  assert.match(stderr, /the ledger could not be read, so it was moved to .*ledger\.unreadable-\d+ and is rebuilt from the guests/);
  assert.equal(node.ledger().guests["910"]!.claim!.answer, "granted");
  assert.deepEqual(node.guestWrites(), []);
});

test("a write cut short between the guest's config and the ledger is put right from the guest, with no second write", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(1000, { box: "bx1000", marker: marker("shared", CARD_A, 1) });
  const cut = node.run(["--once"], { FAKE_PVE_DIE_AFTER_WRITE: "lxc 1000" });
  assert.equal(cut.status, 137);
  assert.deepEqual(node.lines(1000), cardLines(CARD_A, "server"));
  assert.equal(existsSync(node.ledgerPath()) ? node.ledger().guests["1000"]?.claim : undefined, undefined, "the ledger was not written");
  ran(node);
  assert.equal(node.ledger().guests["1000"]!.claim!.answer, "granted");
  assert.deepEqual(claims(node), [`claim 1000 g1 granted shared ${A}`]);
  assert.deepEqual(node.guestWrites(), ["lxc 1000"]);
});

test("a rollback brings back an older marker and another card's lines: the ledger holds, and the claimed card's lines are put back before any start", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(1100, { box: "bx1100", marker: marker("shared", CARD_B, 1), lines: [TUN] });
  ran(node);
  const rolledBack = node.text(1100);
  node.mark(1100, marker("shared", CARD_A, 2));
  ran(node);
  assert.deepEqual(node.lines(1100), cardLines(CARD_A, "server"));
  writeFileSync(node.configPath(1100), rolledBack.replace(/^unprivileged: 1$/m, "lock: rollback\nunprivileged: 1"));
  ran(node);
  assert.deepEqual(node.lines(1100), cardLines(CARD_B, "server"), "a locked guest is left alone");
  writeFileSync(node.configPath(1100), rolledBack);
  ran(node);
  assert.deepEqual(node.lines(1100), cardLines(CARD_A, "server"));
  assert.deepEqual(claims(node), [`claim 1100 g2 granted shared ${A}`, `claim 1100 g1 granted shared ${B}`], "the old generation is not answered again");
  writeFileSync(node.configPath(1100), rolledBack.replace(/;gpu\.[^\n]*/, ""));
  assert.deepEqual(node.lines(1100), cardLines(CARD_B, "server"));
  ran(node);
  assert.deepEqual(node.lines(1100), cardLines(CARD_A, "server"), "a rollback to a config with no marker gets the claim's lines too");
  node.setRunning(1100, true);
  writeFileSync(node.configPath(1100), rolledBack);
  ran(node);
  assert.deepEqual(node.lines(1100), cardLines(CARD_B, "server"), "a running guest is never written");
  assert.ok(lines(node, "mismatch").includes(`mismatch 1100 ${A}`));
});

test("a copy naming another box gets no claim and loses its lines; a swap that sets the old guest to none first moves the claim", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(1200, { box: "bx1200", name: "lone-pine", marker: marker("shared", CARD_A, 4), lines: cardLines(CARD_A, "server") });
  ran(node);
  node.guest(1201, { box: "bx1200", name: "lone-pine", hostname: "bb-box-copy-1201", marker: marker("shared", CARD_A, 4), lines: [...cardLines(CARD_A, "server"), TUN] });
  node.guest(1202, { box: "bx1200", name: "lone-pine", hostname: "bb-box-copy-1202", marker: marker("shared", CARD_A, 5), lines: cardLines(CARD_A, "server"), running: true });
  const source = node.text(1200);
  ran(node);
  assert.equal(node.text(1200), source, "the box it names is left as it is");
  assert.deepEqual(node.lines(1201), []);
  assert.ok(Object.values(node.config(1201).keys).includes(TUN), "its other lines stay");
  assert.ok(claims(node).includes(`claim 1201 g4 refused copy ${A} 1200`));
  assert.ok(claims(node).includes(`claim 1202 g5 refused copy ${A} 1200`));
  assert.deepEqual(node.lines(1202), cardLines(CARD_A, "server"), "a running copy is not written");
  assert.ok(lines(node, "mismatch").includes("mismatch 1202 none"));

  node.guest(1201, { box: "bx1250", name: "new-fork", hostname: "new-fork", marker: marker("shared", CARD_B, 1) });
  ran(node);
  assert.deepEqual(node.lines(1201), cardLines(CARD_B, "server"), "once re-armed as its own box, the fork is placed");

  const held = heldCopyLabels("bx1200");
  node.guest(1203, { ...held, marker: marker("none", null, 1), lines: cardLines(CARD_A, "server") });
  ran(node);
  assert.deepEqual(node.lines(1203), [], "a held copy's gpu.none takes its lines out");
  assert.ok(!lines(node, "holder").some((line) => line.includes(" 1203 ")));

  node.guest(1300, { box: "bx1300", marker: marker("shared", CARD_B, 4), lines: cardLines(CARD_B, "server") });
  ran(node);
  node.mark(1300, marker("none", null, 5));
  ran(node);
  node.guest(1301, { box: "bx1300", marker: marker("shared", CARD_B, 6) });
  ran(node);
  assert.deepEqual(node.lines(1300), []);
  assert.deepEqual(node.lines(1301), cardLines(CARD_B, "server"));
  assert.ok(claims(node).includes(`claim 1301 g6 granted shared ${B}`));
});

test("the boot pass puts each claimed guest's lines right from its card's UUID, takes out the lines of a card it cannot find, and answers nothing", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(1400, { box: "bx1400", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: [...cardLines(CARD_A, "desktop"), TUN] });
  node.guest(1401, { box: "bx1401", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") });
  node.guest(1402, { box: "bx1402", kind: "linux-desktop", lines: cardLines(CARD_A, "desktop") });
  ran(node);
  const report = node.report();
  rmSync(node.file("run/fake-pve/writes.log"), { force: true });
  node.setBoot("boot-2");
  const movedA: FakeCard = { ...CARD_A, minor: 0, card: "card1", render: "renderD128" };
  node.setCards([movedA]);
  node.guest(1403, { box: "bx1403", marker: marker("shared", movedA, 1) });
  const unmarked = node.text(1402);
  node.setHelperConfig(["bbbox"], "off");
  const dryRun = ran(node, ["--boot"]);
  assert.deepEqual(node.guestWrites(), [], "a dry boot pass writes nothing");
  assert.match(dryRun, /would write CT 1400 for claim g1/);
  node.setHelperConfig(["bbbox"], "on");
  ran(node, ["--boot"]);
  assert.deepEqual(node.lines(1400), cardLines(movedA, "desktop"));
  assert.equal(node.config(1400).keys.dev7, TUN);
  assert.deepEqual(node.lines(1401), [], "a guest whose card is not listed starts with no card rather than the wrong one");
  assert.equal(node.text(1402), unmarked, "an unmarked guest is never written");
  assert.deepEqual(node.lines(1403), [], "the boot pass answers no request");
  assert.equal(node.ledger().guests["1403"], undefined);
  assert.equal(node.report(), report, "the boot pass leaves the report to the service");
});

test("the report: today's BB Box reads its at and gpu lines, it names the helper, the driver, each card, the holders and the answers, says when the card mapping moved since the last boot, and stays under 8,192 characters", () => {
  const node = new FakeNode({ writes: "off" });
  node.guest(214, { box: "bx214", marker: marker("shared", CARD_A, 8), lines: cardLines(CARD_A, "server"), running: true });
  ran(node);
  const report = node.report();
  assert.match(report, /^bb-box: each GPU's memory and its claims, from bb-box-gpu on this host\. Do not edit\.\n\n {4}at \d+\n {4}gpu GPU-/);
  const read = parseGpuReport(report)!;
  assert.deepEqual(read.gpus, [
    { uuid: `GPU-${A}`, bus: CARD_A.bus, index: "0", freeMiB: CARD_A.freeMiB, totalMiB: CARD_A.totalMiB },
    { uuid: `GPU-${B}`, bus: CARD_B.bus, index: "1", freeMiB: CARD_B.freeMiB, totalMiB: CARD_B.totalMiB },
  ]);
  assert.ok(Math.abs(read.at - Date.now()) < 60_000);
  const body = node.reportLines();
  assert.deepEqual(body.slice(3, 8), [
    "helper bb-box-gpu 0.4.3 protocol 1 writes off pve-container 6.1.14 tested",
    "serves bbbox",
    body.find((line) => line.startsWith("driver "))!,
    `card ${A} pci 0000:21:00.0 minor 1 drm card2 renderD129`,
    `card ${B} pci 0000:d1:00.0 minor 0 drm card1 renderD128`,
  ]);
  assert.match(body.find((line) => line.startsWith("driver "))!, /^driver 580\.142 since \d+$/);
  assert.deepEqual(lines(node, "remapped"), []);
  assert.deepEqual(lines(node, "holder"), [`holder ${A} 214 shared running install ${INSTALL} managed`], "a marked guest whose lines match is granted with no write, even in a dry run");

  node.setBoot("boot-2");
  node.setCards([{ ...CARD_A, minor: 0, card: "card1", render: "renderD128" }, { ...CARD_B, minor: 1, card: "card2", render: "renderD129" }]);
  ran(node);
  assert.deepEqual(lines(node, "remapped"), [`remapped ${A} was minor 1 drm card2 renderD129`, `remapped ${B} was minor 0 drm card1 renderD128`]);
  assert.deepEqual(lines(node, "holder"), [`holder ${B} 214 shared running install ${INSTALL} managed`], "after the move, its lines name the other card");
  assert.deepEqual(lines(node, "mismatch"), [`mismatch 214 ${A}`], "a running guest whose lines no longer name its claim's card");

  const crowded = new FakeNode({ writes: "on" });
  for (let vmid = 3000; vmid < 3060; vmid++) crowded.guest(vmid, { box: `bx${vmid}`, kind: "linux-desktop", lines: cardLines(vmid % 2 ? CARD_A : CARD_B, "desktop"), running: true });
  for (let vmid = 4000; vmid < 4120; vmid++) crowded.guest(vmid, { box: `bx${vmid}`, marker: marker("whole", CARD_A, 7), running: vmid % 3 === 0 });
  ran(crowded);
  const text = crowded.report();
  assert.ok(text.length < 8192, `the report is ${text.length} characters`);
  assert.equal(lines(crowded, "holder").length, 60, "every holder is listed");
  assert.match(crowded.reportLines().at(-1)!, /^omitted \d+ (?:ledger lines|refusals in force|answers)/);
  assert.deepEqual(lines(crowded, "ledger").filter((line) => line.startsWith("ledger entries ")), ["ledger entries 120"], "the count of ledger entries is always there, so BB Box knows when some are left out");
  assert.deepEqual(parseGpuReport(text)!.gpus.length, 2);
});

test("when nvidia-smi fails, no card is listed and no claim is granted; the report says why, today's BB Box still reads it, and lines already written stay", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(1500, { box: "bx1500", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "server") });
  ran(node);
  node.smiFails(true);
  node.guest(1501, { box: "bx1501", marker: marker("shared", CARD_A, 1) });
  node.guest(1502, { box: "bx1502", marker: marker("none", null, 1), lines: cardLines(CARD_B, "server") });
  ran(node);
  assert.deepEqual(node.lines(1500), cardLines(CARD_A, "server"));
  assert.deepEqual(node.lines(1501), []);
  assert.deepEqual(node.lines(1502), [], "gpu none needs no card");
  assert.ok(claims(node).includes(`claim 1501 g1 refused no-cards ${A}`));
  assert.ok(lines(node, "error").some((line) => /nvidia-smi/.test(line)), node.reportLines().join("\n"));
  assert.deepEqual(lines(node, "card"), []);
  const read = parseGpuReport(node.report())!;
  assert.deepEqual(read.gpus, []);
  assert.ok(Math.abs(read.at - Date.now()) < 60_000);
});

test("when the node's configs cannot be read, as with pve-cluster stopped, the helper drops no claim and decides nothing, and answers nothing again once they are back", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(1650, { box: "bx1650", marker: marker("shared", CARD_A, 2), lines: cardLines(CARD_A, "server") });
  node.guest(1651, { box: "bx1651", marker: marker("shared", CARD_A, 1), running: true });
  ran(node);
  const ledger = readFileSync(node.ledgerPath(), "utf8");
  const answers = claims(node);
  const report = node.report();
  const dir = node.file("etc/pve/nodes/pve/lxc");
  const away = node.file("etc/pve/nodes/pve/lxc-away");
  renameSync(dir, away);
  node.setRunning(1651, false);
  const blind = node.run();
  assert.equal(blind.status, 1, "a one-off pass that could decide nothing says so");
  const stderr = blind.stderr;
  assert.match(stderr, /the node's container configs cannot be read, so the pass decides nothing, drops no claim and leaves the report to go stale/);
  assert.equal(readFileSync(node.ledgerPath(), "utf8"), ledger, "the ledger is as it was");
  assert.equal(node.report(), report, "a report with no holders is not written, so it goes stale instead");
  renameSync(away, dir);
  ran(node);
  assert.deepEqual(claims(node), answers, "no generation is answered again");
  assert.deepEqual(node.lines(1651), [], "a refused generation stays refused");
  assert.deepEqual(node.guestWrites(), []);
});

test("the service writes the report on its first pass after a start, though nothing is new, so an installer waiting for it need not wait for the heartbeat (071 unit 4)", async () => {
  const node = new FakeNode({ writes: "off" });
  node.guest(1750, { box: "bx1750", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
  ran(node);
  const before = node.report();
  const written = Number(/^\s*at (\d+)$/m.exec(before)![1]);
  await sleep(1_100);
  const service = node.start(["--dry-run"]);
  const began = Date.now();
  try {
    while (Number(/^\s*at (\d+)$/m.exec(node.report())![1]) === written) {
      assert.ok(Date.now() - began < helperConstant("REPORT_BEAT_SECONDS") * 1000 / 4, `no report within a quarter of the heartbeat:\n${service.output()}`);
      await sleep(50);
    }
    const unnamed = (report: string) => report.replace(/^\s*at \d+$/m, "").replace(/^\s*process \d+ started [\d.]+$/m, "");
    assert.equal(unnamed(node.report()), unnamed(before), "nothing but its time and the process that wrote it is new");
    assert.ok(node.reportLines().includes(`process ${service.pid} started ${/^\s*process \d+ started ([\d.]+)$/m.exec(node.report())![1]}`), "the report names the process that wrote it");
    assert.deepEqual(node.guestWrites(), []);
  } finally {
    service.kill("SIGTERM");
    assert.equal(await exited(service), 0);
  }
  assert.match(service.output(), /the report written 1 times \(1 on start, 0 for a change, 0 for memory alone, 0 as a heartbeat, 0 after a clock step\)/);
});

test("the report lists each ledger entry: its box, the generation answered and the claim, so BB Box can ask above it and read a grant exactly (071 unit 4, Opus 1)", () => {
  const node = new FakeNode({ writes: "off" });
  node.guest(1800, { box: "bx1800", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  node.guest(1801, { box: "bx1801", marker: marker("shared", CARD_B, 3), lock: "backup" });
  node.guest(1802, { box: "bx1802" });
  ran(node);
  assert.deepEqual(lines(node, "ledger"), [
    "ledger entries 2",
    `ledger 1800 box ${INSTALL}/bx1800 answered g1 claim g1 shared ${A} granted`,
    `ledger 1801 box ${INSTALL}/bx1801 answered g3 claim none`,
  ]);
  node.write("var/lib/bb-box-gpu/ledger", JSON.stringify({ protocol: 2, guests: {}, answers: [] }));
  ran(node);
  assert.deepEqual(lines(node, "ledger"), ["ledger unknown"], "with a ledger it cannot read, it says so, rather than list none");
});

test("a ledger from a newer protocol: the helper acts on nothing and says so, and today's BB Box still reads the report", () => {
  const node = new FakeNode({ writes: "on" });
  node.write("var/lib/bb-box-gpu/ledger", JSON.stringify({ protocol: 2, guests: {}, answers: [] }));
  node.guest(1600, { box: "bx1600", marker: marker("shared", CARD_A, 1) });
  ran(node);
  assert.deepEqual(node.guestWrites(), []);
  assert.deepEqual(claims(node), []);
  assert.ok(lines(node, "error").includes("error the ledger is protocol 2, newer than this helper's 1, so it acts on nothing"));
  assert.match(lines(node, "helper")[0]!, / writes off /);
  assert.equal(parseGpuReport(node.report())!.gpus.length, 2);
  assert.equal(JSON.parse(readFileSync(node.ledgerPath(), "utf8")).protocol, 2, "the newer ledger is left as it is");
});

test("the service answers a marker within about a second, logs each write it would make once, writes the report as the cards' memory moves, and stops cleanly", async () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(1700, { box: "bx1700", marker: marker("shared", CARD_A, 1) });
  const service = node.start();
  try {
    const deadline = Date.now() + 10_000;
    while (!claims(node).includes(`claim 1700 g1 granted shared ${A}`)) {
      assert.ok(Date.now() < deadline, `no answer in 10 s:\n${service.output()}`);
      await sleep(50);
    }
    const asked = Date.now();
    node.mark(1700, marker("none", null, 2));
    while (!existsSync(node.file("var/lib/bb-box-gpu/ledger")) || node.ledger().guests["1700"]?.claim?.generation !== 2) {
      assert.ok(Date.now() - asked < 5_000, `no answer to g2 in 5 s:\n${service.output()}`);
      await sleep(20);
    }
    const answeredMs = Date.now() - asked;
    assert.ok(answeredMs < 2_500, `answered in ${answeredMs} ms`);
    assert.deepEqual(node.lines(1700), []);

    node.setHelperConfig(["bbbox"], "off");
    node.guest(1701, { box: "bx1701", marker: marker("shared", CARD_B, 1) });
    await sleep(2_500);
    assert.equal(service.output().match(/would write CT 1701 for request g1/g)?.length, 1, "logged once, though seen on every pass");
    assert.ok(lines(node, "would").includes(`would 1701 lines ${B} server for request g1`));

    node.setMemory([{ ...CARD_A, freeMiB: 1_000 }, CARD_B]);
    const moved = Date.now();
    while (parseGpuReport(node.report())!.gpus[0]!.freeMiB !== 1_000) {
      assert.ok(Date.now() - moved < 20_000, "the report follows a 64 MiB step within 15 s of its last write");
      await sleep(100);
    }
  } finally {
    const pid = Number(readFileSync(node.file("smi.pid"), "utf8"));
    service.kill("SIGTERM");
    assert.equal(await exited(service), 0);
    assert.match(service.output(), /in the last 0 min: \d+ passes, [\d.]+ ms each on average, [\d.]+ ms at most; the report written \d+ times \(\d+ on start, \d+ for a change, \d+ for memory alone, \d+ as a heartbeat, \d+ after a clock step\); this process [\d.]+ s of CPU in all, nvidia-smi [\d.]+ s, started 1 times\nstopped\n$/);
    await sleep(300);
    assert.throws(() => process.kill(pid, 0), "nvidia-smi is stopped with the helper");
  }
});

function reportWrites(node: FakeNode): number {
  return node.writes().filter((write) => write === `qemu ${REPORT_VMID}`).length;
}

function ageReport(node: FakeNode, seconds: number): void {
  const file = node.file(`etc/pve/nodes/pve/qemu-server/${REPORT_VMID}.conf`);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^# {4}at (\d+)$/m, (_, at: string) => `#    at ${Number(at) - seconds}`));
}

async function until(what: string, check: () => boolean, ms: number, output: () => string = () => ""): Promise<number> {
  const started = Date.now();
  while (!check()) {
    assert.ok(Date.now() - started < ms, `${what}: not within ${ms} ms\n${output()}`);
    await sleep(100);
  }
  return Date.now() - started;
}

test("with writes off the helper takes no guest's config lock, so another's lock never delays it; with writes on it logs nothing while it holds a lock (Astra 1)", async () => {
  const dry = new FakeNode({ writes: "off" });
  dry.guest(1800, { box: "bx1800", marker: marker("shared", CARD_A, 1) });
  const hold = dry.holdLock(1800, 3);
  await hold.locked;
  const started = Date.now();
  const stderr = ran(dry);
  const took = Date.now() - started;
  await exited(hold);
  assert.ok(took < 1_500, `a dry pass took ${took} ms while another process held CT 1800's config lock`);
  assert.match(stderr, /would write CT 1800 for request g1/);
  assert.ok(lines(dry, "would").includes(`would 1800 lines ${A} server for request g1`));
  assert.deepEqual(dry.guestLocks(), ["lxc 1800"], "the only lock taken is the other process's");

  const node = new FakeNode({ writes: "on" });
  node.guest(1810, { box: "bx1810", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "server") });
  node.guest(1811, { box: "bx1811", marker: marker("whole", CARD_A, 1) });
  node.guest(1812, { box: "bx1812", marker: marker("shared", CARD_B, 1) });
  const result = node.run(["--once"], { FAKE_PVE_TRACE_LOCKS: "1" });
  assert.equal(result.status, 0, result.stderr);
  let held = 0;
  const logged: string[] = [];
  for (const line of result.stderr.split("\n")) {
    if (line.startsWith("fake-pve: locked ")) held++;
    else if (line.startsWith("fake-pve: unlocked ")) held--;
    else if (held > 0 && line) logged.push(line);
  }
  assert.deepEqual(logged, [], "nothing is logged while a config lock is held");
  assert.match(result.stderr, /wrote CT 1810 for yield to 1811 g1[^\n]*\n(?:.*\n)*wrote CT 1811 for request g1/);
  assert.deepEqual([...new Set(node.guestLocks())].sort(), ["lxc 1810", "lxc 1811", "lxc 1812"], "with writes on, each write is made under the guest's lock");
});

test("a silent nvidia-smi that ignores TERM is killed: a one-off pass ends as the reading's wait and the wait to kill it say, and leaves nothing holding its output (Astra 4, Opus 3)", async (t) => {
  const readingMs = helperConstant("ONE_READING_TIMEOUT_SECONDS") * 1000;
  const killMs = helperConstant("SMI_KILL_WAIT_SECONDS") * 1000;
  const marginMs = 1_500;
  const node = new FakeNode({ writes: "off" });
  node.smiMode("silent");
  const started = Date.now();
  const helper = node.start(["--once"]);
  const exiting = new Promise<number>((resolve) => helper.once("exit", () => resolve(Date.now())));
  const closing = new Promise<number>((resolve) => helper.once("close", () => resolve(Date.now())));
  const [exitAt, closeAt] = await Promise.all([exiting, closing]);
  assert.equal(helper.exitCode, 0, helper.output());
  const fromReading = exitAt - node.smiStartedAt();
  t.diagnostic(`the helper started nvidia-smi ${Math.round(node.smiStartedAt() - started)} ms after it was started, exited ${Math.round(fromReading)} ms after that, and its output closed ${closeAt - exitAt} ms after it exited`);
  assert.ok(fromReading >= readingMs, `it gave up on the reading after ${Math.round(fromReading)} ms, before its ${readingMs} ms`);
  assert.ok(fromReading < readingMs + killMs + marginMs, `it exited ${Math.round(fromReading)} ms after the reading began: the reading's ${readingMs} ms, ${killMs} ms to kill nvidia-smi, and ${marginMs} ms to spare`);
  assert.ok(closeAt - exitAt < 500, `its output stayed open ${closeAt - exitAt} ms after it exited`);
  assert.ok(closeAt - started < 30_000, "a pass never hangs");
  assert.ok(lines(node, "error").some((line) => new RegExp(`nvidia-smi did not answer within ${readingMs / 1000} s, so it was stopped`).test(line)), node.reportLines().join("\n"));
  assert.deepEqual(parseGpuReport(node.report())!.gpus, []);
  assert.throws(() => process.kill(Number(readFileSync(node.file("smi.pid"), "utf8")), 0), "nvidia-smi was killed and reaped");
});

test("the four service probes: a stalled nvidia-smi is started again after 30 s and the helper still stops at once, memory moving about a step writes the report at most every 15 s, an unsaved ledger still leaves a report, and a quiet node writes once a minute (Opus A to D)", async (t) => {
  const stalled = new FakeNode({ writes: "off" });
  stalled.smiMode("stall");
  const moving = new FakeNode({ writes: "off" });
  const unsaved = new FakeNode({ writes: "on" });
  unsaved.guest(1900, { box: "bx1900", marker: marker("shared", CARD_A, 1) });
  mkdirSync(unsaved.file("var/lib/bb-box-gpu/ledger.new"));
  const quiet = new FakeNode({ writes: "off" });
  const services = [stalled.start(["--dry-run"]), moving.start(["--dry-run"]), unsaved.start(), quiet.start(["--dry-run"])];
  const begun = Date.now();
  try {
    const unsavedMs = await until("C: a report naming the unsaved ledger", () => lines(unsaved, "error").some((line) => /^error the pass could not finish, so what is left waits for the next one: cannot write .*ledger\.new/.test(line)), 5_000, services[2]!.output);
    assert.equal(parseGpuReport(unsaved.report())!.gpus.length, 2);

    await until("B: the first report", () => reportWrites(moving) > 0, 5_000, services[1]!.output);
    const before = reportWrites(moving);
    for (let step = 0; step < 18; step++) {
      moving.setMemory([{ ...CARD_A, freeMiB: step % 2 ? 64_004 : 63_996 }, CARD_B]);
      await sleep(1_100);
    }
    const memoryWrites = reportWrites(moving) - before;
    assert.ok(memoryWrites <= 2, `B: ${memoryWrites} report writes in 20 s of memory moving about a 64 MiB step`);

    await until("A: nvidia-smi started again", () => stalled.smiStarts() >= 2, 40_000 - (Date.now() - begun), services[0]!.output);
    const restartedAfter = Date.now() - begun;
    assert.match(services[0]!.output(), /nvidia-smi gave no line for 30 s, so it is stopped and started again/);

    await sleep(Math.max(0, 65_000 - (Date.now() - begun)));
    const quietWrites = reportWrites(quiet);
    assert.ok(quietWrites >= 1 && quietWrites <= 2, `D: ${quietWrites} report writes in 65 s with nothing changing`);
    t.diagnostic(`A: nvidia-smi started again ${restartedAfter} ms after the service; B: ${memoryWrites} report writes in 19.8 s of memory moving; C: a report naming the ledger in ${unsavedMs} ms; D: ${quietWrites} report writes in 65 s`);
  } finally {
    for (const service of services) service.kill("SIGTERM");
    const stopped = Date.now();
    assert.deepEqual(await Promise.all(services.map(exited)), [0, 0, 0, 0]);
    assert.ok(Date.now() - stopped < 6_000, "each stops within seconds, the one with a stuck nvidia-smi too");
    t.diagnostic(`all four stopped within ${Date.now() - stopped} ms of SIGTERM`);
  }
});

test("a change of free memory alone writes the report at most every 15 s; a change of anything else, at once (Opus 2)", () => {
  const node = new FakeNode({ writes: "off" });
  ran(node);
  assert.equal(reportWrites(node), 1);
  node.setMemory([{ ...CARD_A, freeMiB: 50_000 }, CARD_B]);
  ran(node);
  assert.equal(reportWrites(node), 1, "memory alone, within 15 s of the last write");
  node.guest(1960, { box: "bx1960", marker: marker("shared", CARD_B, 1) });
  ran(node);
  assert.equal(reportWrites(node), 2, "a new would line is written at once");
  assert.equal(parseGpuReport(node.report())!.gpus[0]!.freeMiB, 50_000, "with the memory as read now");
  node.setMemory([{ ...CARD_A, freeMiB: 40_000 }, CARD_B]);
  ran(node);
  assert.equal(reportWrites(node), 2);
  ageReport(node, 16);
  ran(node);
  assert.equal(reportWrites(node), 3, "memory alone, 15 s after the last write");
  assert.equal(parseGpuReport(node.report())!.gpus[0]!.freeMiB, 40_000);
});

test("when the ledger cannot be saved, the report is still written, naming why (Opus 4)", () => {
  const node = new FakeNode({ writes: "on" });
  ran(node);
  const before = node.report();
  mkdirSync(node.file("var/lib/bb-box-gpu/ledger.new"));
  node.guest(1950, { box: "bx1950", marker: marker("shared", CARD_A, 1) });
  const result = node.run();
  assert.equal(result.status, 1, "a one-off pass that could not finish says so");
  assert.notEqual(node.report(), before);
  assert.ok(lines(node, "error").some((line) => /^error the pass could not finish, so what is left waits for the next one: cannot write .*ledger\.new/.test(line)), node.reportLines().join("\n"));
  assert.equal(parseGpuReport(node.report())!.gpus.length, 2);
});

test("with writes off, recovery stores no strip, yield or whole grant; once writes are on, the helper decides afresh, so a copy whose source has gone keeps its card (Astra 5, Opus 6)", () => {
  const node = new FakeNode({ writes: "off", ledger: false });
  node.guest(2000, { box: "bx2000", name: "amber-fox", marker: marker("shared", CARD_A, 2), lines: cardLines(CARD_A, "server"), running: true });
  node.guest(2001, { box: "bx2000", name: "amber-fox", hostname: "bb-box-copy-2001", marker: marker("shared", CARD_A, 2), lines: cardLines(CARD_A, "server") });
  node.guest(2002, { box: "bx2002", marker: marker("whole", CARD_B, 1), lines: cardLines(CARD_B, "server"), running: true });
  node.guest(2003, { box: "bx2003", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") });
  ran(node);
  ran(node);
  const stored = node.ledger().guests;
  assert.ok(Object.values(stored).every((entry) => !entry.strip && entry.claim?.answer !== "yielded"), JSON.stringify(stored));
  assert.equal(stored["2002"]?.claim, undefined, "no whole grant while another box still has the card's devices");
  assert.deepEqual(lines(node, "would"), [], "the stopped copy and the whole box are refused, and every guest keeps its lines");
  assert.ok(claims(node).includes(`claim 2002 g1 refused ledger-lost ${B} 2003`), claims(node).join("\n"));
  assert.ok(claims(node).includes(`claim 2001 g2 refused copy ${A} 2000`), claims(node).join("\n"));
  assert.deepEqual(node.guestWrites(), []);

  node.remove(2000);
  node.setHelperConfig(["bbbox"], "on");
  const stderr = ran(node);
  assert.match(stderr, /writes are on: the claims granted with writes off stand \(\d+\), and every request refused or left waiting with writes off is decided again \(\d+\)/);
  assert.deepEqual(node.lines(2001), cardLines(CARD_A, "server"), "the copy's source has gone, so it is decided afresh and keeps its card");
  assert.ok(claims(node).includes(`claim 2001 g2 granted shared ${A}`));
  assert.deepEqual(node.lines(2003), [], "the stopped shared box yields now");
  assert.ok(claims(node).includes(`claim 2002 g1 granted whole ${B}`));
});

test("the report stays under 8,192 characters whatever gpu.conf's pools and the errors say (Astra 6)", () => {
  const node = new FakeNode({ writes: "off" });
  const pools = Array.from({ length: 400 }, (_, index) => `a-pool-with-a-long-name-number-${index}`);
  node.write("etc/bb-box/gpu.conf", `pools ${pools.join(" ")}\nwrites off\n${"a line it cannot read\n".repeat(50)}`);
  chmodSync(node.file("etc/bb-box/gpu.conf"), 0o600);
  ran(node);
  const text = node.report();
  assert.ok(text.length < 8_192, `the report is ${text.length} characters`);
  assert.match(lines(node, "serves")[0]!, /^serves a-pool-with-a-long-name-number-0 .* and \d+ more$/);
  assert.ok(lines(node, "serves")[0]!.length <= 300);
  assert.equal(lines(node, "error").length, 7);
  assert.equal(lines(node, "error").at(-1), "error and 44 more");
  assert.equal(parseGpuReport(text)!.gpus.length, 2);
});

test("--dry-run keeps writes off whatever gpu.conf says, and the units setup-gpu.sh installs run the helper with it (Opus 5)", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(2100, { box: "bx2100", marker: marker("shared", CARD_A, 1) });
  ran(node, ["--once", "--dry-run"]);
  assert.deepEqual(node.guestWrites(), []);
  assert.match(lines(node, "helper")[0]!, / writes off /);
  assert.ok(lines(node, "error").includes("error writes are on in /etc/bb-box/gpu.conf, but this install runs with --dry-run, so writes stay off"));
  assert.ok(lines(node, "would").includes(`would 2100 lines ${A} server for request g1`));
  const unit = (name: string) => readFileSync(new URL(`../setup/proxmox-lxc/host/${name}`, import.meta.url), "utf8");
  assert.match(unit("bb-box-gpu.service"), /^ExecStart=\/usr\/local\/sbin\/bb-box-gpu --dry-run$/m);
  assert.match(unit("bb-box-gpu-boot.service"), /^ExecStart=\/usr\/local\/sbin\/bb-box-gpu --boot --dry-run$/m);
  assert.match(unit("bb-box-gpu-boot.service"), /^TimeoutStartSec=45$/m, "the boot pass holds guest autostart for at most 45 s");
});

test("a copy of a box whose own request was refused is still a copy: it gets no claim (Opus 7)", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(2200, { box: "bx2200", name: "lone-pine", marker: marker("whole", CARD_A, 3), running: true });
  ran(node);
  assert.ok(claims(node).includes(`claim 2200 g3 refused running ${A}`));
  node.guest(2201, { box: "bx2200", name: "lone-pine", hostname: "lone-pine", marker: marker("whole", CARD_A, 3) });
  ran(node);
  assert.deepEqual(node.lines(2201), []);
  assert.ok(claims(node).includes(`claim 2201 g3 refused copy ${A} 2200`));
  assert.deepEqual(node.guestWrites(), []);
});

test("a clock stepped back an hour stops neither the passes nor the report (Opus 8)", { skip: !FAKETIME && "needs libfaketime, which CI installs" }, async () => {
  const node = new FakeNode({ writes: "on" });
  writeFileSync(node.file("faketime"), "+0\n");
  const service = node.start([], { LD_PRELOAD: FAKETIME!, FAKETIME_TIMESTAMP_FILE: node.file("faketime"), FAKETIME_NO_CACHE: "1", FAKETIME_DONT_FAKE_MONOTONIC: "1" });
  try {
    await until("the first report", () => lines(node, "helper").length > 0, 10_000, service.output);
    writeFileSync(node.file("faketime"), "-1h\n");
    await sleep(1_500);
    node.guest(2300, { box: "bx2300", marker: marker("shared", CARD_A, 1) });
    await until("an answer after the step", () => claims(node).includes(`claim 2300 g1 granted shared ${A}`), 5_000, service.output);
    const at = parseGpuReport(node.report())!.at;
    assert.ok(Date.now() - at > 3_000_000, `the report's at follows the clock back: ${Date.now() - at} ms behind`);
  } finally {
    service.kill("SIGTERM");
    assert.equal(await exited(service), 0);
  }
});

test("071 unit 5: a release marker clears a guest's claim and leaves its lines, running or stopped, with writes on or off; the guest then holds its card unmanaged and is never written; an ineligible guest's release is refused", () => {
  for (const writes of ["on", "off"] as const) {
    const node = new FakeNode({ writes });
    node.guest(2200, { box: "bx2200", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
    node.guest(2201, { box: "bx2201", kind: "linux-desktop", marker: marker("whole", CARD_B, 2), lines: cardLines(CARD_B, "desktop") });
    node.guest(2202, { box: "bx2202", kind: "linux-desktop", marker: "gpu.release.g1", lines: cardLines(CARD_A, "desktop"), unprivileged: false });
    ran(node);
    assert.deepEqual(claims(node).sort(), [`claim 2200 g1 granted shared ${A}`, `claim 2201 g2 granted whole ${B}`, `claim 2202 g1 refused privileged -`], writes);
    const before = snapshot(node, [2200, 2201, 2202]);
    node.mark(2200, "gpu.release.g2");
    node.mark(2201, "gpu.release.g3");
    const after = snapshot(node, [2200, 2201, 2202]);
    ran(node);
    assert.ok(claims(node).includes("claim 2200 g2 released"), claims(node).join("\n"));
    assert.ok(claims(node).includes("claim 2201 g3 released"));
    assert.ok(lines(node, "ledger").includes(`ledger 2200 box ${INSTALL}/bx2200 answered g2 claim none`));
    assert.ok(lines(node, "ledger").includes(`ledger 2201 box ${INSTALL}/bx2201 answered g3 claim none`));
    assert.ok(lines(node, "holder").includes(`holder ${A} 2200 shared running install ${INSTALL} unmanaged`), lines(node, "holder").join("\n"));
    assert.ok(lines(node, "holder").includes(`holder ${B} 2201 shared stopped install ${INSTALL} unmanaged`), "a released whole box no longer holds its card whole");
    assertUnchanged(node, after);
    assert.equal(node.text(2200).replace(/^tags: .*$/m, ""), before.get(2200)!.replace(/^tags: .*$/m, ""), "only the tags moved");
    node.mark(2200);
    node.mark(2201);
    node.setRunning(2200, false);
    const unmarked = snapshot(node, [2200, 2201]);
    ran(node);
    ran(node, ["--boot"]);
    assertUnchanged(node, unmarked);
    assert.deepEqual(node.guestWrites(), [], `${writes}: no guest was written`);
    assert.deepEqual(lines(node, "would"), []);
    node.mark(2200, marker("shared", CARD_A, 3));
    ran(node);
    assert.ok(claims(node).includes(`claim 2200 g3 granted shared ${A}`), "marked again above the release, it is granted");
  }
  const lost = new FakeNode({ writes: "on", ledger: false });
  lost.guest(2210, { box: "bx2210", kind: "linux-desktop", marker: "gpu.release.g4", lines: cardLines(CARD_A, "desktop") });
  ran(lost);
  assert.deepEqual(lines(lost, "ledger").filter((line) => line.startsWith("ledger 2210 ")), ["ledger 2210 box 4kq7/bx2210 answered g4 claim none"], "a rebuilt ledger takes a release marker for no claim");
  assert.deepEqual(lost.guestWrites(), []);
});

test("071 unit 5: --preview shows what the first pass with writes on would do, and changes nothing: no guest is written or locked, and the ledger, the report and the helper's state stay as they were", () => {
  const node = new FakeNode({ writes: "off" });
  node.guest(2300, { box: "bx2300", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
  node.guest(2301, { box: "bx2301", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_A, "desktop") });
  node.guest(2302, { box: "bx2302", kind: "linux-desktop", lines: cardLines(CARD_B, "desktop") });
  ran(node);
  assert.deepEqual(lines(node, "would"), [`would 2301 lines ${B} desktop for request g1`]);
  const guests = snapshot(node, [2300, 2301, 2302]);
  const ledger = readFileSync(node.ledgerPath(), "utf8");
  const report = node.report();
  const state = readFileSync(node.file("var/lib/bb-box-gpu/host"), "utf8");
  const writesBefore = node.writes().length;
  const preview = node.run(["--preview"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /^preview: bb-box-gpu 0\.4\.3 on pve-container 6\.1\.14, as its first pass with writes on would go; nothing was written\n/);
  assert.match(preview.stdout, /^would write CT 2301 for request g1: remove dev0 \/dev\/nvidia1,mode=0666, .*; add \/dev\/nvidia0,mode=0666, .*$/m);
  assert.match(preview.stdout, new RegExp(`^would answer: claim 2301 g1 granted shared ${B}$`, "m"));
  assert.match(preview.stdout, /^preview: writes on would write 1 guest$/m);
  assert.doesNotMatch(preview.stdout, /CT 2300|CT 2302/, "a running guest and an unmarked one are not written");
  assertUnchanged(node, guests);
  assert.equal(readFileSync(node.ledgerPath(), "utf8"), ledger);
  assert.equal(node.report(), report);
  assert.equal(readFileSync(node.file("var/lib/bb-box-gpu/host"), "utf8"), state);
  assert.equal(node.writes().length, writesBefore, "nothing was written, the report VM included");
  assert.deepEqual(node.guestLocks(), [], "no guest's config lock was taken");

  node.mark(2301, marker("shared", CARD_A, 2));
  ran(node);
  const clean = node.run(["--preview"]);
  assert.match(clean.stdout, /^preview: writes on would write no guest$/m);
  assert.doesNotMatch(clean.stdout, /^would write /m);
  node.write("pve-container-version", "6.2.1\n");
  assert.match(node.run(["--preview"]).stdout, /^preview: pve-container 6\.2\.1 is not a version this release was tested on, so with writes on it would still write no guest$/m);
});

function configOf(node: FakeNode, spec: GuestSpec): string {
  node.guest(9998, spec);
  const text = node.text(9998);
  node.remove(9998);
  return text;
}

test("071 unit 5, Astra 1: after waiting for a guest's config lock, the helper writes or grants only if it is still the same box asking the same thing", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(2500, { box: "bx2500", kind: "linux-desktop", marker: marker("shared", CARD_A, 1) });
  const none = node.file("swap-2500.conf");
  writeFileSync(none, configOf(node, { box: "bx2500", kind: "linux-desktop", marker: marker("none", null, 1) }));
  ran(node, ["--once"], { FAKE_PVE_SWAP_ON_LOCK: `lxc 2500=${none}` });
  assert.deepEqual(node.lines(2500), [], "a guest that came to ask for no card while the helper waited gets none");
  assert.ok(!claims(node).some((line) => line.startsWith("claim 2500 g1 granted shared")), claims(node).join("\n"));
  ran(node);
  assert.ok(claims(node).includes("claim 2500 g1 granted none"), "the request as it stands is answered on the next pass");

  node.guest(2501, { box: "bx2501", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  ran(node);
  assert.ok(claims(node).includes(`claim 2501 g1 granted shared ${A}`));
  node.guest(2501, { box: "bx2501", kind: "linux-desktop", marker: marker("shared", CARD_A, 1) });
  const replacement = node.file("swap-2501.conf");
  writeFileSync(replacement, configOf(node, boxLabels("bx9901", "someone-else", "linux-desktop", "zz99")));
  ran(node, ["--once"], { FAKE_PVE_SWAP_ON_LOCK: `lxc 2501=${replacement}` });
  assert.deepEqual(node.lines(2501), [], "another install's guest that took the VMID is not given the old box's card");

  node.guest(2510, { box: "bx2510", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop") });
  ran(node);
  node.guest(2511, { box: "bx2511", kind: "linux", marker: marker("whole", CARD_B, 1) });
  const takenOver = node.file("swap-2510.conf");
  writeFileSync(takenOver, configOf(node, { ...boxLabels("bx9902", "taken-over", "linux-desktop", "zz99"), lines: cardLines(CARD_B, "desktop") }));
  ran(node, ["--once"], { FAKE_PVE_SWAP_ON_LOCK: `lxc 2510=${takenOver}` });
  assert.deepEqual(node.lines(2510), cardLines(CARD_B, "desktop"), "a guest that is no longer the box that would yield keeps its lines");
  assert.ok(!claims(node).some((line) => line.startsWith("claim 2511 g1 granted")), "and the whole request waits for the next pass");
  assert.deepEqual(node.guestWrites(), [], "nothing was written");
});

function fakeLog(node: FakeNode, name: string): string[] {
  const path = node.file(`run/fake-pve/${name}`);
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

test("071 unit 8b, review: a whole request whose requester changed install under its own lock before the yield yields nothing: the stopped shared box keeps its lines and nothing is granted", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(840, { box: "bx840", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "server") });
  ran(node);
  node.guest(841, { box: "bx841", marker: marker("whole", CARD_A, 1) });
  const moved = node.file("swap-841.conf");
  writeFileSync(moved, configOf(node, { ...boxLabels("bx841", "whole-841", "linux", "zz99"), marker: marker("whole", CARD_A, 1) }));
  ran(node, ["--once"], { FAKE_PVE_SWAP_ON_LOCK: `lxc 841=${moved}` });
  assert.deepEqual(node.lines(840), cardLines(CARD_A, "server"), "the stopped shared box keeps its lines");
  assert.ok(!claims(node).some((line) => line.startsWith("claim 840 g1 yielded")), claims(node).join("\n"));
  assert.ok(!claims(node).some((line) => line.startsWith("claim 841 g1 granted")));
  assert.deepEqual(node.lines(841), []);
});

test("071 unit 8b, review: while the helper yields a card, the requester is held under its own config lock, so another actor cannot change it in between; the yield and the grant agree", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(850, { box: "bx850", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "server") });
  ran(node);
  node.guest(851, { box: "bx851", marker: marker("whole", CARD_A, 1) });
  const other = node.file("change-851.conf");
  writeFileSync(other, configOf(node, { ...boxLabels("bx851", "whole-851", "linux", "zz99"), marker: marker("whole", CARD_A, 1) }));
  ran(node, ["--once"], { FAKE_PVE_CHANGE_ON_LOCK: `lxc 850=lxc 851=${other}` });
  assert.deepEqual(fakeLog(node, "changes.log"), ["lxc 851 blocked"], "the change to the requester could not take its lock");
  assert.ok(claims(node).includes(`claim 850 g1 yielded ${A} 851`));
  assert.ok(claims(node).includes(`claim 851 g1 granted whole ${A}`));
  assert.deepEqual(node.lines(851), cardLines(CARD_A, "server"));
  assert.match(node.text(851), /install 4kq7|install\.4kq7/, "the requester is the install that asked");
});

test("071 unit 8b, review: a requester moved to another pool while the helper holds the yielding box's lock gets no yield and no grant", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(860, { box: "bx860", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") });
  ran(node);
  node.guest(861, { box: "bx861", marker: marker("whole", CARD_B, 1) });
  ran(node, ["--once"], { FAKE_PVE_POOL_ON_LOCK: "lxc 860=861:elsewhere" });
  assert.deepEqual(fakeLog(node, "pools.log"), ["861 elsewhere"], "the requester was moved while the yielder's lock was held");
  assert.deepEqual(node.lines(860), cardLines(CARD_B, "server"), "the stopped shared box keeps its lines");
  assert.ok(!claims(node).some((line) => line.startsWith("claim 860 g1 yielded")), claims(node).join("\n"));
  assert.ok(!claims(node).some((line) => line.startsWith("claim 861 g1 granted")));
  assert.deepEqual(node.lines(861), []);
});

test("071 unit 8b, review: a requester moved to another pool after a box yielded to it, and before its own write, is not written or granted", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(870, { box: "bx870", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") });
  ran(node);
  node.guest(871, { box: "bx871", marker: marker("whole", CARD_B, 1) });
  ran(node, ["--once"], { FAKE_PVE_POOL_ON_WRITE: "lxc 870=871:elsewhere" });
  assert.deepEqual(fakeLog(node, "pools.log"), ["871 elsewhere"], "the requester was moved once the yielding box was written");
  assert.ok(!claims(node).some((line) => line.startsWith("claim 871 g1 granted")), claims(node).join("\n"));
  assert.deepEqual(node.lines(871), [], "the requester is not written");
});

test("071 unit 5, Astra 3: a guest whose config cannot be read blocks every decision on the cards it may hold, is named, and fails the preview", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(2520, { box: "bx2520", kind: "linux-desktop", lines: cardLines(CARD_A, "desktop"), running: true });
  node.guest(2521, { box: "bx2521", kind: "linux", marker: marker("whole", CARD_A, 1) });
  node.guest(2522, { box: "bx2522", kind: "linux", marker: marker("shared", CARD_B, 1) });
  node.guest(2523, { box: "bx2523", kind: "linux", marker: marker("none", null, 1) });
  writeFileSync(node.configPath(2520), `${node.text(2520)}this is not a config line\n`);
  ran(node);
  assert.ok(!claims(node).some((line) => /^claim 252[12] g1 /.test(line)), `no request on a card CT 2520 may hold is decided: ${claims(node).join(" | ")}`);
  assert.ok(claims(node).includes("claim 2523 g1 granted none"), "a request for no card is");
  assert.ok(lines(node, "error").some((line) => /^error CT 2520's config cannot be read, so no card it may hold is given or claimed until it can be$/.test(line)), lines(node, "error").join("\n"));
  assert.ok(lines(node, "holder").includes(`holder ${A} 2520 shared running other unmanaged`), "it still holds the cards it may hold");
  assert.ok(lines(node, "holder").includes(`holder ${B} 2520 shared running other unmanaged`));
  assert.deepEqual(node.guestWrites(), []);
  const preview = node.run(["--preview"]);
  assert.equal(preview.status, 1, preview.stdout);
  assert.match(preview.stdout, /^error: CT 2520's config cannot be read/m);
  assert.match(preview.stdout, /^preview: incomplete, as 1 error line, so it cannot show what writes on would do$/m);
  node.guest(2520, { box: "bx2520", kind: "linux-desktop", lines: cardLines(CARD_A, "desktop"), running: true });
  ran(node);
  assert.ok(claims(node).includes(`claim 2521 g1 refused card-held ${A} 2520`), claims(node).join("\n"));
  assert.ok(claims(node).includes(`claim 2522 g1 granted shared ${B}`));
});

test("071 unit 5, Astra 4 and Opus 2: the preview fails, and says why, when it read no card or has any error line", () => {
  const node = new FakeNode({ writes: "off" });
  node.guest(2530, { box: "bx2530", kind: "linux-desktop", marker: marker("shared", CARD_A, 1) });
  ran(node);
  node.smiFails(true);
  const failing = node.run(["--preview"]);
  assert.equal(failing.status, 1, failing.stdout);
  assert.match(failing.stdout, /^error: nvidia-smi /m);
  assert.match(failing.stdout, /^preview: incomplete, as it read no card, and 1 error line, so it cannot show what writes on would do$/m);
  node.smiFails(false);
  const reading = node.run(["--preview"]);
  assert.equal(reading.status, 0, reading.stdout);
  assert.match(reading.stdout, /^would write CT 2530 for request g1: /m, "with the cards read, the write it would make shows");
});

test("071 unit 5, re-review R1: a reading that leaves out a card, has a row it cannot read or ends in an error decides nothing on a card it did not read, writes no guest for one, and fails the preview", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(2540, { box: "bx2540", kind: "linux-desktop", marker: marker("shared", CARD_A, 1) });
  node.guest(2541, { box: "bx2541", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_A, "desktop") });
  node.guest(2542, { box: "bx2542", kind: "linux-desktop", lines: cardLines(CARD_B, "desktop"), running: true });
  const guests = snapshot(node, [2540, 2541, 2542]);
  const partials: readonly { readonly name: string; readonly rows: readonly string[]; readonly ending?: { readonly exit?: number; readonly stderr?: string }; readonly read: "A" | "none"; readonly error: RegExp }[] = [
    { name: "B's memory unknown, an error and exit 9", rows: [node.smiRow(CARD_A), `GPU-${CARD_B.uuid}, ${CARD_B.bus}, ${CARD_B.index}, [N/A], [N/A]`], ending: { exit: 9, stderr: "Unable to determine the device handle for GPU 00000000:D1:00.0: Unknown Error" }, read: "none", error: /^error nvidia-smi's reading was incomplete \(nvidia-smi gave no GPU memory: GPU-8c41d7b2.*\), so no request on any card is decided and no guest's lines are changed$/ },
    { name: "every row, then exit 9", rows: [node.smiRow(CARD_A), node.smiRow(CARD_B)], ending: { exit: 9 }, read: "none", error: /^error nvidia-smi's reading was incomplete \(nvidia-smi exited with status 9\), so no request on any card is decided and no guest's lines are changed$/ },
    { name: "B left out", rows: [node.smiRow(CARD_A)], read: "A", error: new RegExp(`^error nvidia-smi gave no reading of the card at ${pciOf(CARD_B).replace(/\./g, "\\.")}, so no request on it is decided and no guest's lines for it are changed$`) },
  ];
  for (const partial of partials) {
    node.smiReading(partial.rows, partial.ending);
    const preview = node.run(["--preview"]);
    assert.equal(preview.status, 1, `${partial.name}: ${preview.stdout}`);
    assert.match(preview.stdout, /^preview: incomplete, as .*nvidia-smi gave no full reading of every card.*, so it cannot show what writes on would do$/m, partial.name);
    assert.doesNotMatch(preview.stdout, /^would write CT 2541 /m, `${partial.name}: no write for a card it did not read`);
    ran(node);
    assert.ok(lines(node, "error").some((line) => partial.error.test(line)), `${partial.name}: ${lines(node, "error").join(" | ")}`);
    assert.ok(!claims(node).some((line) => line.startsWith("claim 2541 ")), `${partial.name}: the request on B waits: ${claims(node).join(" | ")}`);
    assert.equal(claims(node).some((line) => line.startsWith(`claim 2540 g1 granted shared ${A}`)), partial.read === "A", `${partial.name}: the request on A is decided only when A's reading is whole`);
    assert.deepEqual(node.lines(2541), cardLines(CARD_A, "desktop"), `${partial.name}: CT 2541 keeps its lines`);
  }
  assertUnchanged(node, new Map([...guests].filter(([vmid]) => vmid !== 2540)));
  node.smiReading([node.smiRow(CARD_A), node.smiRow(CARD_B)]);
  const whole = node.run(["--preview"]);
  assert.equal(whole.status, 0, whole.stdout);
  assert.match(whole.stdout, /^would write CT 2541 for request g1: /m, "with every card read, the write it would make shows");
  ran(node);
  assert.ok(claims(node).includes(`claim 2541 g1 granted shared ${B}`), claims(node).join("\n"));
  assert.deepEqual(lines(node, "error"), []);
});

test("071 unit 5, re-review R3: a lost ledger is rebuilt on no card that a guest whose config cannot be read may hold, and recovery strips no stopped box's lines, at boot or after: it refuses, and the box asks again", () => {
  const node = new FakeNode({ writes: "on", ledger: false });
  node.guest(2550, { box: "bx2550", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  node.guest(2551, { box: "bx2551", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop") });
  node.guest(2552, { box: "bx2552", kind: "linux-desktop", lines: cardLines(CARD_B, "desktop") });
  writeFileSync(node.configPath(2552), `${node.text(2552)}this is not a config line\n`);
  const before = snapshot(node, [2550, 2551]);
  for (const args of [["--boot"], ["--once"]]) {
    ran(node, args);
    assertUnchanged(node, before);
    assert.deepEqual(node.guestWrites(), [], `${args[0]}: recovery writes no guest`);
  }
  assert.ok(!claims(node).some((line) => /^claim 255[01] /.test(line)), `no claim on a card CT 2552 may hold is granted or refused: ${claims(node).join(" | ")}`);
  assert.ok(lines(node, "error").some((line) => line.startsWith("error CT 2552's config cannot be read")), lines(node, "error").join("\n"));
  assert.ok(!existsSync(node.ledgerPath()) || Object.keys(node.ledger().guests).every((vmid) => !["2550", "2551"].includes(vmid) || !node.ledger().guests[vmid]!.claim), "no claim is stored for them");
  node.guest(2552, { box: "bx2552", kind: "linux-desktop", lines: cardLines(CARD_B, "desktop") });
  ran(node);
  assert.ok(claims(node).includes(`claim 2550 g1 granted whole ${A}`), claims(node).join("\n"));
  assert.ok(claims(node).includes(`claim 2551 g1 granted shared ${B}`));
  assertUnchanged(node, before);

  const boot = new FakeNode({ writes: "on", ledger: false });
  boot.guest(2560, { box: "bx2560", kind: "linux-desktop", marker: marker("shared", CARD_B, 2), lines: cardLines(CARD_A, "desktop") });
  boot.guest(2561, { box: "bx2561", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  boot.guest(2562, { box: "bx2561", kind: "linux-desktop", hostname: "bb-box-copy-2562", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  const stopped = snapshot(boot, [2560, 2561, 2562]);
  ran(boot, ["--boot"]);
  ran(boot);
  assertUnchanged(boot, stopped);
  assert.deepEqual(boot.guestWrites(), [], "a lost ledger at boot strips no stopped box");
  assert.ok(claims(boot).includes(`claim 2560 g2 refused ledger-lost ${B}`), claims(boot).join("\n"));
  assert.ok(claims(boot).includes(`claim 2561 g1 refused ledger-lost ${A} 2560`), `a stopped whole box whose card other stopped boxes still have is refused, and keeps its lines: ${claims(boot).join(" | ")}`);
  assert.ok(claims(boot).includes(`claim 2562 g1 refused copy ${A} 2561`));
  boot.mark(2560, marker("shared", CARD_B, 3));
  ran(boot);
  assert.ok(claims(boot).includes(`claim 2560 g3 granted shared ${B}`), "asked again, it is decided");
  assert.deepEqual(boot.lines(2560), cardLines(CARD_B, "desktop"));
});

test("071 unit 5, lost ledger: a card that a guest the rebuild left unresolved may hold takes no new guest and no whole claim until that guest has asked again and been answered", () => {
  const node = new FakeNode({ writes: "on", ledger: false });
  node.guest(2570, { box: "bx2570", kind: "linux-desktop", marker: marker("whole", CARD_B, 2), lines: cardLines(CARD_B, "desktop"), running: true });
  node.guest(2571, { box: "bx2571", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop") });
  node.guest(2572, { box: "bx2572", kind: "linux-desktop", marker: marker("shared", CARD_B, 3), lines: cardLines(CARD_A, "desktop") });
  ran(node);
  assert.ok(claims(node).includes(`claim 2570 g2 refused ledger-lost ${B} 2571`), claims(node).join("\n"));
  assert.ok(claims(node).includes(`claim 2572 g3 refused ledger-lost ${B}`));

  node.guest(2573, { box: "bx2573", kind: "linux", marker: marker("shared", CARD_B, 1) });
  node.guest(2574, { box: "bx2574", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  node.guest(2575, { box: "bx2575", kind: "linux", marker: marker("whole", CARD_A, 1) });
  ran(node);
  ran(node);
  assert.ok(claims(node).includes(`claim 2573 g1 refused unsettled ${B} 2570`), `a new guest is not placed on the running whole box's card: ${claims(node).join(" | ")}`);
  assert.ok(claims(node).includes(`claim 2574 g1 refused unsettled ${A} 2572`), "nor on a card a refused guest still has the lines of");
  assert.ok(claims(node).includes(`claim 2575 g1 refused unsettled ${A} 2572`), "and no whole claim is granted there");
  assert.ok(lines(node, "ledger").includes(`ledger 2571 box ${INSTALL}/bx2571 answered g1 claim g1 shared ${B} granted`), "a claim the rebuild granted stands");
  assert.deepEqual(lines(node, "unsettled"), [`unsettled 2570 ${B} g2`, `unsettled 2572 ${A} g3`], "the report names them, and the ledger keeps them across passes");

  node.mark(2572, marker("shared", CARD_A, 4));
  ran(node);
  assert.ok(claims(node).includes(`claim 2572 g4 granted shared ${A}`), "asked again on the card it holds, it is answered");
  assert.deepEqual(lines(node, "unsettled"), [`unsettled 2570 ${B} g2`], "and card 0 opens");
  node.mark(2574, marker("shared", CARD_A, 2));
  ran(node);
  assert.ok(claims(node).includes(`claim 2574 g2 granted shared ${A}`), "a new guest is placed on it again");

  node.mark(2570, marker("whole", CARD_B, 3));
  ran(node);
  assert.ok(claims(node).includes(`claim 2570 g3 granted whole ${B}`), claims(node).join("\n"));
  assert.deepEqual(lines(node, "unsettled"), []);
  node.mark(2573, marker("shared", CARD_B, 2));
  ran(node);
  assert.ok(claims(node).includes(`claim 2573 g2 refused whole-taken ${B} 2570`), "card 1 is the whole box's again");

  const dry = new FakeNode({ writes: "off", ledger: false });
  dry.guest(2580, { box: "bx2580", kind: "linux-desktop", marker: marker("whole", CARD_B, 2), lines: cardLines(CARD_B, "desktop"), running: true });
  dry.guest(2581, { box: "bx2581", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop") });
  ran(dry);
  dry.guest(2582, { box: "bx2582", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop") });
  ran(dry);
  assert.ok(claims(dry).includes(`claim 2582 g1 refused unsettled ${B} 2580`), `with writes off too: ${claims(dry).join(" | ")}`);
  assert.deepEqual(dry.guestWrites(), []);

  const gone = new FakeNode({ writes: "on", ledger: false });
  gone.guest(2590, { box: "bx2590", kind: "linux-desktop", marker: marker("shared", CARD_B, 3), lines: cardLines(CARD_A, "desktop") });
  ran(gone);
  gone.guest(2591, { box: "bx2591", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  ran(gone);
  assert.ok(claims(gone).includes(`claim 2591 g1 refused unsettled ${A} 2590`), claims(gone).join("\n"));
  assert.deepEqual(lines(gone, "unsettled"), [`unsettled 2590 ${A} g3`]);
  gone.remove(2590);
  ran(gone);
  assert.deepEqual(lines(gone, "unsettled"), [], "a guest that has gone holds no card closed");
  gone.mark(2591, marker("shared", CARD_A, 2));
  ran(gone);
  assert.ok(claims(gone).includes(`claim 2591 g2 granted shared ${A}`));
});

test("071 unit 5, final review F2: a lost ledger is rebuilt only from a full reading of every card, and a guest it left unresolved keeps its card closed through any reading that is not full", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(2600, { box: "bx2600", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
  ran(node);
  assert.ok(claims(node).includes(`claim 2600 g1 granted whole ${A}`));
  rmSync(node.ledgerPath());
  node.guest(2601, { box: "bx2601", kind: "linux", marker: marker("shared", CARD_A, 1) });
  for (const [name, fail] of [["no reading", () => node.smiFails(true)], ["card 1 left out", () => (node.smiFails(false), node.smiReading([node.smiRow(CARD_A)]))]] as const) {
    fail();
    ran(node);
    assert.ok(!existsSync(node.ledgerPath()), `${name}: no ledger is rebuilt`);
    assert.ok(node.reportLines().includes("ledger unknown"), name);
    assert.ok(lines(node, "error").includes("error the ledger is lost, and is rebuilt only from a full reading of every card, which nvidia-smi has not given, so nothing is decided until it does"), `${name}: ${lines(node, "error").join(" | ")}`);
    assert.ok(!claims(node).some((line) => line.startsWith("claim 2601 ")), `${name}: nothing is decided`);
  }
  node.smiReading([node.smiRow(CARD_A), node.smiRow(CARD_B)]);
  ran(node);
  assert.ok(claims(node).includes(`claim 2600 g1 granted whole ${A}`), `rebuilt from a full reading, the running whole box holds its card: ${claims(node).join(" | ")}`);
  node.mark(2601, marker("shared", CARD_A, 2));
  ran(node);
  assert.ok(claims(node).includes(`claim 2601 g2 refused whole-taken ${A} 2600`));
  assert.deepEqual(node.guestWrites(), []);

  const held = new FakeNode({ writes: "on", ledger: false });
  held.guest(2610, { box: "bx2610", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
  held.guest(2611, { box: "bx2611", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  ran(held);
  assert.deepEqual(lines(held, "unsettled"), [`unsettled 2610 ${A} g1`]);
  held.smiFails(true);
  ran(held);
  held.mark(2610, marker("whole", CARD_A, 2));
  ran(held);
  assert.ok(claims(held).includes(`claim 2610 g2 refused no-cards ${A}`), claims(held).join("\n"));
  assert.deepEqual(Object.keys(held.ledger().unsettled ?? {}), ["2610"], "a reading that failed lets no guest go, nor does a refusal for want of one");
  held.smiFails(false);
  ran(held);
  assert.deepEqual(lines(held, "unsettled"), [`unsettled 2610 ${A} g1`], "and the card is closed once the reading is back");
  held.guest(2612, { box: "bx2612", kind: "linux", marker: marker("shared", CARD_A, 1) });
  ran(held);
  assert.ok(claims(held).includes(`claim 2612 g1 refused unsettled ${A} 2610`));
  held.mark(2610, marker("whole", CARD_A, 3));
  ran(held);
  assert.ok(claims(held).includes(`claim 2610 g3 granted whole ${A}`), claims(held).join("\n"));
  assert.deepEqual(lines(held, "unsettled"), []);

  const gone = new FakeNode({ writes: "on", ledger: false });
  gone.guest(2620, { box: "bx2620", kind: "linux-desktop", marker: marker("shared", CARD_B, 3), lines: cardLines(CARD_A, "desktop") });
  ran(gone);
  assert.deepEqual(lines(gone, "unsettled"), [`unsettled 2620 ${A} g3`]);
  gone.smiReading([gone.smiRow(CARD_B)]);
  gone.guest(2620, { box: "bx2620", kind: "linux-desktop", marker: marker("shared", CARD_B, 3) });
  ran(gone);
  assert.deepEqual(Object.keys(gone.ledger().unsettled ?? {}), ["2620"], "its lines gone while card 0 is unread, it still closes card 0");
  gone.smiReading([gone.smiRow(CARD_A), gone.smiRow(CARD_B)]);
  ran(gone);
  assert.deepEqual(Object.keys(gone.ledger().unsettled ?? {}), [], "a full reading that shows it holds no card lets it go");
});

test("071 unit 5, final review F3: an nvidia-smi query killed by a signal after every row is an incomplete reading: an error line, nothing decided, and the preview fails", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(2630, { box: "bx2630", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  node.smiKilled(true);
  const preview = node.run(["--preview"]);
  assert.equal(preview.status, 1, preview.stdout);
  assert.match(preview.stdout, /^error: nvidia-smi's reading was incomplete \(nvidia-smi was killed by signal 9\), so no request on any card is decided and no guest's lines are changed$/m);
  assert.match(preview.stdout, /^preview: incomplete, as .*nvidia-smi gave no full reading of every card/m);
  ran(node);
  assert.ok(!claims(node).some((line) => line.startsWith("claim 2630 ")), claims(node).join("\n"));
  assert.ok(lines(node, "error").includes("error nvidia-smi's reading was incomplete (nvidia-smi was killed by signal 9), so no request on any card is decided and no guest's lines are changed"));
  node.smiKilled(false);
  assert.equal(node.run(["--preview"]).status, 0);
  ran(node);
  assert.ok(claims(node).includes(`claim 2630 g1 granted shared ${A}`));
});

function loseMapping(node: FakeNode, card: FakeCard, parts: readonly ("minor" | "drm")[]): void {
  if (parts.includes("minor")) rmSync(node.file(`proc/driver/nvidia/gpus/${pciOf(card)}/information`));
  if (parts.includes("drm")) for (const type of ["card", "render"]) rmSync(node.file(`dev/dri/by-path/pci-${pciOf(card)}-${type}`));
}

test("071 unit 5, go review N2: a card the helper cannot map to its device nodes is an error line that blocks every decision on every card, fails the preview, and keeps a lost ledger from being rebuilt", () => {
  for (const parts of [["minor"], ["drm"], ["minor", "drm"]] as const) {
    const node = new FakeNode({ writes: "off" });
    node.guest(2640, { box: "bx2640", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
    ran(node);
    node.guest(2640, { box: "bx2640", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_B, "desktop") });
    node.guest(2641, { box: "bx2641", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop") });
    loseMapping(node, CARD_A, parts);
    const preview = node.run(["--preview"]);
    assert.equal(preview.status, 1, `${parts.join(" and ")}: ${preview.stdout}`);
    assert.match(preview.stdout, new RegExp(`^error: the helper cannot map card ${A} at ${pciOf(CARD_A).replace(/\./g, "\\.")} to its device nodes \\(.*unknown\\), so it cannot tell which guests hold it: no request on any card is decided and no guest's lines are changed$`, "m"), parts.join(" and "));
    assert.match(preview.stdout, /^preview: incomplete, as .*it could not map every card to its device nodes/m);
    assert.doesNotMatch(preview.stdout, /^would write CT /m, `${parts.join(" and ")}: no write is shown, nor made`);
    ran(node);
    assert.ok(!claims(node).some((line) => /^claim 2641 /.test(line)), `${parts.join(" and ")}: no request on card 1 is decided: ${claims(node).join(" | ")}`);
    assert.deepEqual(lines(node, "would"), []);
  }

  const lost = new FakeNode({ writes: "on" });
  lost.guest(2650, { box: "bx2650", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
  ran(lost);
  rmSync(lost.ledgerPath());
  loseMapping(lost, CARD_A, ["minor", "drm"]);
  ran(lost);
  assert.ok(!existsSync(lost.ledgerPath()), "no ledger is rebuilt while a card cannot be mapped");
  assert.ok(lost.reportLines().includes("ledger unknown"));
  lost.setCards([CARD_A, CARD_B]);
  ran(lost);
  assert.ok(claims(lost).includes(`claim 2650 g1 granted whole ${A}`), claims(lost).join("\n"));
  lost.guest(2651, { box: "bx2651", kind: "linux", marker: marker("shared", CARD_A, 1) });
  ran(lost);
  assert.ok(claims(lost).includes(`claim 2651 g1 refused whole-taken ${A} 2650`));
  assert.deepEqual(lost.guestWrites(), []);

  const held = new FakeNode({ writes: "on", ledger: false });
  held.guest(2660, { box: "bx2660", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
  held.guest(2661, { box: "bx2661", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  ran(held);
  assert.deepEqual(lines(held, "unsettled"), [`unsettled 2660 ${A} g1`]);
  loseMapping(held, CARD_A, ["minor"]);
  ran(held);
  assert.deepEqual(Object.keys(held.ledger().unsettled ?? {}), ["2660"], "an unmapped card lets no unresolved guest go");
  held.setCards([CARD_A, CARD_B]);
  ran(held);
  assert.deepEqual(lines(held, "unsettled"), [`unsettled 2660 ${A} g1`]);
});

test("071 unit 5, go review 2 G2: a device node a guest of a card needs that is missing, as /dev/nvidia1, its render node or /dev/nvidia-uvm, is an error line that blocks every decision and every repair, and fails the preview", () => {
  for (const path of [`dev/nvidia${CARD_A.minor}`, `dev/dri/${CARD_A.render}`, "dev/nvidia-uvm"]) {
    const node = new FakeNode({ writes: "off" });
    node.guest(2670, { box: "bx2670", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
    ran(node);
    node.guest(2670, { box: "bx2670", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_B, "desktop") });
    node.guest(2671, { box: "bx2671", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop") });
    rmSync(node.file(path));
    const preview = node.run(["--preview"]);
    assert.equal(preview.status, 1, `${path}: ${preview.stdout}`);
    assert.match(preview.stdout, new RegExp(`^error: card [0-9a-f-]+ at \\S+ lacks device nodes a guest of it needs \\(.*/${path}.* missing\\), so the helper can neither give nor check its lines: no request on any card is decided and no guest's lines are changed$`, "m"), path);
    assert.match(preview.stdout, /^preview: incomplete, as .*it could not map every card to its device nodes/m, path);
    assert.doesNotMatch(preview.stdout, /^would write CT /m, `${path}: the repair CT 2670 needs is neither shown nor made`);
    ran(node);
    assert.ok(!claims(node).some((line) => line.startsWith("claim 2671 ")), `${path}: no request is decided: ${claims(node).join(" | ")}`);
    assert.deepEqual(lines(node, "would"), [], path);
    writeFileSync(node.file(path), "");
    const back = node.run(["--preview"]);
    assert.match(back.stdout, /^would write CT 2670 for claim g1: /m, `${path}: with the node back, the repair shows`);
  }
});

function asked(action: "start" | "stop" | "shutdown" | "delete", box: string | null, generation: number, nonce: string, install = INSTALL): string {
  return `bb-power.${action}.${install}.${box ?? "-"}.g${generation}.n${nonce}`;
}

function powered(node: FakeNode): string[] {
  return lines(node, "power");
}

test("071 unit 5, go review 3 H1: the helper starts, stops, shuts down and deletes a guest BB Box asks it to, under the guest's config lock, with writes on or off, and acts on each request once", () => {
  for (const writes of ["off", "on"] as const) {
    const node = new FakeNode({ writes });
    node.guest(2700, { box: "bx2700", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
    ran(node);
    assert.ok(claims(node).includes(`claim 2700 g1 granted shared ${A}`), `${writes}: ${claims(node).join(" | ")}`);
    const before = node.guestWrites().length;

    node.ask(2700, asked("start", "bx2700", 1, "0a0a0a0a"));
    ran(node);
    assert.deepEqual(node.powerLog(), ["start 2700"], writes);
    assert.ok(node.isRunning(2700));
    assert.deepEqual(powered(node), ["power 2700 n0a0a0a0a start done"], writes);
    assert.ok(node.guestLocks().includes("lxc 2700"), `${writes}: the start took the guest's lock`);

    node.setRunning(2700, false);
    ran(node);
    assert.deepEqual(node.powerLog(), ["start 2700"], `${writes}: a request answered is not acted on again`);
    assert.ok(!node.isRunning(2700));

    node.setRunning(2700, true);
    node.ask(2700, asked("shutdown", "bx2700", 1, "0b0b0b0b"));
    ran(node);
    node.ask(2700, asked("start", "bx2700", 1, "0c0c0c0c"));
    ran(node);
    node.ask(2700, asked("stop", "bx2700", 1, "0d0d0d0d"));
    ran(node);
    assert.deepEqual(node.powerLog(), ["start 2700", "shutdown 2700", "start 2700", "stop 2700"], writes);
    assert.deepEqual(powered(node), ["power 2700 n0d0d0d0d stop done"]);

    node.ask(2700, asked("delete", "bx2700", 1, "0e0e0e0e"));
    ran(node);
    assert.deepEqual(node.powerLog().slice(-2), ["destroy 2700", "removed 2700"], writes);
    assert.ok(!node.exists(2700));
    assert.deepEqual(powered(node), ["power 2700 n0e0e0e0e delete done"], "the answer outlives the guest, for BB Box to read");
    assert.equal(node.guestWrites().length, before, `${writes}: no config is written for a power request`);
  }
});

test("071 unit 5, go review 3 H1: the helper refuses a request for another box, another install or another marker generation, a start its claim does not cover, and a delete of a running, protected, locked or HA guest", () => {
  const node = new FakeNode({ writes: "off" });
  node.guest(2710, { box: "bx2710", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
  ran(node);
  node.guest(2711, { box: "bx2711", kind: "linux-desktop", marker: marker("shared", CARD_B, 2), lines: cardLines(CARD_B, "desktop") });
  node.guest(2712, { box: "bx2712", kind: "linux-desktop", lines: cardLines(CARD_A, "desktop") });
  node.guest(2713, { box: "bx2713", kind: "linux-desktop", marker: marker("none", null, 1) });
  node.guest(2714, { box: "bx2714", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  ran(node);
  assert.ok(claims(node).includes(`claim 2714 g1 refused whole-taken ${A} 2710`), claims(node).join(" | "));
  const cases: { readonly vmid: number; readonly request: string; readonly answer: string; readonly env?: Record<string, string>; readonly setup?: () => void }[] = [
    { vmid: 2711, request: asked("start", "bx2799", 2, "1a1a1a1a"), answer: `refused not-the-box ${INSTALL}/bx2711` },
    { vmid: 2711, request: asked("start", "bx2711", 2, "1b1b1b1b", "zz99"), answer: `refused not-the-box ${INSTALL}/bx2711` },
    { vmid: 2711, request: asked("start", "bx2711", 1, "1c1c1c1c"), answer: "refused generation 2" },
    { vmid: 2714, request: asked("start", "bx2714", 1, "1d1d1d1d"), answer: "refused no-claim" },
    { vmid: 2712, request: asked("start", "bx2712", 0, "1e1e1e1e"), answer: "refused whole-taken 2710" },
    { vmid: 2710, request: asked("delete", "bx2710", 1, "1f1f1f1f"), answer: "refused running" },
    { vmid: 2711, request: asked("delete", "bx2711", 2, "2a2a2a2a"), answer: "refused failed can't remove CT 2711 - protection mode enabled", setup: () => node.write(`etc/pve/nodes/pve/lxc/2711.conf`, node.text(2711).replace(/^(unprivileged: .*)$/m, "$1\nprotection: 1")) },
    { vmid: 2711, request: asked("start", "bx2711", 2, "2b2b2b2b"), answer: "refused failed CT is locked (backup)", setup: () => node.write(`etc/pve/nodes/pve/lxc/2711.conf`, node.text(2711).replace(/^protection: 1\n/m, "lock: backup\n")) },
    { vmid: 2711, request: asked("delete", "bx2711", 2, "2c2c2c2c"), answer: "refused failed CT 2711 is an HA resource", env: { FAKE_PVE_HA: "ct:2711" }, setup: () => node.write(`etc/pve/nodes/pve/lxc/2711.conf`, node.text(2711).replace(/^lock: backup\n/m, "")) },
  ];
  for (const each of cases) {
    each.setup?.();
    node.ask(each.vmid, each.request);
    ran(node, ["--once"], each.env ?? {});
    const nonce = /\.n([0-9a-f]+)$/.exec(each.request)![1];
    assert.ok(powered(node).includes(`power ${each.vmid} n${nonce} ${each.request.split(".")[1]} ${each.answer}`), `${each.request}: ${powered(node).join(" | ")}`);
  }
  assert.deepEqual(node.powerLog(), [], "nothing was started, stopped or deleted");
  assert.ok(node.exists(2710) && node.exists(2711));

  node.guest(2713, { box: "bx2713", kind: "linux-desktop", marker: marker("none", null, 1), lines: cardLines(CARD_B, "server") });
  node.ask(2713, asked("start", "bx2713", 1, "3a3a3a3a"));
  ran(node);
  assert.ok(powered(node).includes("power 2713 n3a3a3a3a start refused lines"), "a box that gave its card up may not start with a card's lines");
  node.guest(2715, { box: "bx2715", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop") });
  ran(node);
  node.guest(2715, { box: "bx2715", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop"), pending: { dev7: `/dev/nvidia${CARD_A.minor},mode=0666` } });
  node.ask(2715, asked("start", "bx2715", 1, "3b3b3b3b"));
  ran(node);
  assert.ok(powered(node).includes("power 2715 n3b3b3b3b start refused pending"), "a pending device change, which a start would apply, blocks it");
  node.ask(2711, "bb-power.start.4kq7.bx2711.g2");
  ran(node);
  assert.ok(!powered(node).some((line) => line.startsWith("power 2711 n") && line.includes(" start done")), "a request not in BB Box's form is not acted on");
  assert.deepEqual(node.powerLog(), []);

  node.guest(9100, { box: "bx9100", kind: "linux-desktop", template: true, lines: cardLines(CARD_A, "desktop") });
  node.ask(9100, asked("start", "bx9100", 0, "3c3c3c3c"));
  node.guest(2716, { tags: ["bb-box", `install.${INSTALL}`], description: "bb-box someone\ninstall zz99\nbox bx2716\n", lines: cardLines(CARD_B, "server"), pool: "team" });
  node.ask(2716, asked("start", "bx2716", 0, "3d3d3d3d", "zz99"));
  ran(node);
  assert.ok(powered(node).includes("power 9100 n3c3c3c3c start refused template"));
  assert.ok(powered(node).includes("power 2716 n3d3d3d3d start refused not-served"));
  assert.deepEqual(node.powerLog(), []);
});

test("071 unit 5, go review 3 H1: a guest replaced at its VMID while BB Box's request waits for the config lock, by another box of the same install carrying the request, is not started, stopped or deleted", async () => {
  for (const action of ["start", "stop", "delete"] as const) {
    for (const writes of ["off", "on"] as const) {
      const node = new FakeNode({ writes });
      const running = action === "stop";
      node.guest(2721, { box: "bx2721", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
      node.guest(2720, { box: "bx2720", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop"), running });
      ran(node);
      assert.ok(claims(node).includes(`claim 2720 g1 granted shared ${B}`), claims(node).join(" | "));
      const request = asked(action, "bx2720", 1, "4a4a4a4a");
      node.ask(2720, request);
      node.replacementOnUnlock(2720, { box: "bx2799", kind: "linux-desktop", marker: [marker("shared", CARD_B, 1), request], lines: cardLines(CARD_A, "desktop"), running });
      const hold = node.holdLock(2720, 1.5, "replace");
      await hold.locked;
      const began = Date.now();
      ran(node);
      const took = Date.now() - began;
      await exited(hold);
      assert.ok(took >= 1_000, `${action}, writes ${writes}: the helper waited ${took} ms for the lock`);
      assert.match(node.text(2720), /^#box bx2799$/m, "the replacement is in place");
      assert.deepEqual(node.powerLog(), [], `${action}, writes ${writes}: nothing was started, stopped or deleted`);
      assert.ok(node.exists(2720));
      assert.equal(node.isRunning(2720), running);
      assert.deepEqual(powered(node), [`power 2720 n4a4a4a4a ${action} refused not-the-box ${INSTALL}/bx2799`], `${action}, writes ${writes}`);
      assert.ok(claims(node).includes(`claim 2721 g1 granted whole ${A}`));
    }
  }
});

test("071 unit 5, go review 3 H1: a preview and the boot pass act on no power request", () => {
  const node = new FakeNode({ writes: "on" });
  node.guest(2730, { box: "bx2730", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  ran(node);
  node.ask(2730, asked("start", "bx2730", 1, "5a5a5a5a"));
  assert.equal(node.run(["--preview"]).status, 0);
  assert.equal(node.run(["--boot"]).status, 0);
  assert.deepEqual(node.powerLog(), []);
  assert.ok(!node.isRunning(2730));
  ran(node);
  assert.deepEqual(node.powerLog(), ["start 2730"]);
});

test("071 unit 5, go review 4 N1: the helper starts, stops and deletes a box with no card once it is still that install's box with no card's lines, and a GPU desktop that takes its VMID while the request waits for the lock is not acted on", async () => {
  for (const writes of ["off", "on"] as const) {
    const node = new FakeNode({ writes });
    node.guest(2740, { box: "bx2740", kind: "linux" });
    node.guest(2742, { box: "bx2742", kind: "linux-desktop", marker: marker("whole", CARD_B, 1), lines: cardLines(CARD_B, "desktop"), running: true });
    ran(node);
    node.ask(2740, asked("start", "bx2740", 0, "6a6a6a6a"));
    ran(node);
    node.ask(2740, asked("stop", "bx2740", 0, "6b6b6b6b"));
    ran(node);
    node.ask(2740, asked("delete", "bx2740", 0, "6c6c6c6c"));
    ran(node);
    assert.deepEqual(node.powerLog(), ["start 2740", "stop 2740", "destroy 2740", "removed 2740"], writes);
    assert.ok(powered(node).includes("power 2740 n6c6c6c6c delete done"));

    for (const action of ["start", "stop", "delete"] as const) {
      const running = action === "stop";
      node.guest(2741, { box: "bx2741", kind: "linux", running });
      ran(node);
      const nonce = { start: "7a7a7a7a", stop: "7b7b7b7b", delete: "7c7c7c7c" }[action];
      const request = asked(action, "bx2741", 0, nonce);
      node.ask(2741, request);
      node.replacementOnUnlock(2741, { box: "bx2799", kind: "linux-desktop", marker: request, lines: cardLines(CARD_B, "desktop"), running });
      const hold = node.holdLock(2741, 1.5, "replace");
      await hold.locked;
      ran(node);
      await exited(hold);
      assert.match(node.text(2741), /^#box bx2799$/m, `${action}, writes ${writes}: the replacement is in place`);
      assert.equal(node.powerLog().length, 4, `${action}, writes ${writes}: the GPU desktop is not started, stopped or deleted: ${node.powerLog().join(" | ")}`);
      assert.equal(node.isRunning(2741), running);
      assert.ok(powered(node).includes(`power 2741 n${nonce} ${action} refused not-the-box ${INSTALL}/bx2799`), `${action}, writes ${writes}: ${powered(node).join(" | ")}`);
    }
  }

  const node = new FakeNode({ writes: "off" });
  node.guest(2743, { box: "bx2743", kind: "linux", pending: { dev0: `/dev/nvidia${CARD_A.minor},mode=0666` } });
  node.guest(2744, { template: true, tags: ["bb-box", `install.${INSTALL}`, "image.daily"], description: "bb-box daily image of linux, built 2026-11-03 from template 9000.\n{}" });
  ran(node);
  node.ask(2743, asked("start", "bx2743", 0, "8a8a8a8a"));
  node.ask(2744, asked("start", null, 0, "8b8b8b8b"));
  ran(node);
  assert.ok(powered(node).includes("power 2743 n8a8a8a8a start refused pending"), "a box that would start with a card's lines it has no claim for is not started");
  assert.ok(powered(node).includes("power 2744 n8b8b8b8b start refused template"));
  node.ask(2744, asked("delete", null, 0, "8c8c8c8c"));
  ran(node);
  assert.ok(powered(node).includes("power 2744 n8c8c8c8c delete done"), "a captured build of this install, named by its install tag, is deleted");
  assert.deepEqual(node.powerLog(), ["destroy 2744", "removed 2744"]);
});

test("071 unit 5, go review 4 N4: on a pve-container the helper was not tested on, it stops a guest, and refuses to start, shut down or delete one", () => {
  for (const writes of ["off", "on"] as const) {
    const node = new FakeNode({ writes, pveContainer: "6.2.3" });
    node.guest(2745, { box: "bx2745", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
    node.guest(2746, { box: "bx2746", kind: "linux" });
    ran(node);
    node.ask(2745, asked("shutdown", "bx2745", 1, "9a9a9a9a"));
    node.ask(2746, asked("start", "bx2746", 0, "9b9b9b9b"));
    ran(node);
    assert.ok(powered(node).includes("power 2745 n9a9a9a9a shutdown refused untested 6.2.3"), `${writes}: ${powered(node).join(" | ")}`);
    assert.ok(powered(node).includes("power 2746 n9b9b9b9b start refused untested 6.2.3"));
    node.ask(2746, asked("delete", "bx2746", 0, "9c9c9c9c"));
    node.ask(2745, asked("stop", "bx2745", 1, "9d9d9d9d"));
    ran(node);
    assert.ok(powered(node).includes("power 2746 n9c9c9c9c delete refused untested 6.2.3"));
    assert.ok(powered(node).includes("power 2745 n9d9d9d9d stop done"));
    assert.deepEqual(node.powerLog(), ["stop 2745"], writes);
  }
});

test("071 unit 5, go review 4 N5: a start is refused beside a guest running on its card when either holds or claims the card whole, and on a card a guest the lost ledger left unresolved may hold", () => {
  const node = new FakeNode({ writes: "off" });
  node.guest(2750, { box: "bx2750", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  node.guest(2753, { box: "bx2753", kind: "linux-desktop", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "desktop") });
  ran(node);
  assert.ok(claims(node).includes(`claim 2750 g1 granted whole ${A}`) && claims(node).includes(`claim 2753 g1 granted shared ${B}`), claims(node).join(" | "));
  node.guest(2751, { box: "bx2751", kind: "linux-desktop", lines: cardLines(CARD_A, "desktop"), running: true });
  node.guest(2754, { box: "bx2754", kind: "linux-desktop", marker: marker("whole", CARD_B, 1), lines: cardLines(CARD_B, "desktop"), running: true });
  ran(node);
  node.ask(2750, asked("start", "bx2750", 1, "aaaa0001"));
  node.ask(2753, asked("start", "bx2753", 1, "aaaa0002"));
  ran(node);
  assert.ok(powered(node).includes("power 2750 naaaa0001 start refused card-busy 2751"), `a whole box beside an unmarked guest running on its card: ${powered(node).join(" | ")}`);
  assert.ok(powered(node).includes("power 2753 naaaa0002 start refused card-busy 2754"), "a shared box beside a running guest that claims its card whole");
  node.remove(2751);
  node.guest(2752, { box: "bx2752", kind: "linux-desktop", install: "zz99", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
  ran(node);
  node.ask(2750, asked("start", "bx2750", 1, "aaaa0003"));
  ran(node);
  assert.ok(powered(node).includes("power 2750 naaaa0003 start refused card-busy 2752"), "beside another install's shared guest running on its card");
  assert.deepEqual(node.powerLog(), []);

  const held = new FakeNode({ writes: "on", ledger: false });
  held.guest(2760, { box: "bx2760", kind: "linux-desktop", marker: marker("whole", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
  held.guest(2761, { box: "bx2761", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  held.guest(2762, { box: "bx2762", kind: "linux-desktop", lines: cardLines(CARD_A, "desktop") });
  ran(held);
  assert.deepEqual(lines(held, "unsettled"), [`unsettled 2760 ${A} g1`]);
  held.ask(2762, asked("start", "bx2762", 0, "bbbb0001"));
  ran(held);
  assert.ok(powered(held).includes("power 2762 nbbbb0001 start refused unsettled 2760"), `an unmarked guest on a card a guest the lost ledger left unresolved may hold: ${powered(held).join(" | ")}`);
  assert.deepEqual(held.powerLog(), []);
});

test("071 unit 5, go review 4 N6: a warm guest's request names its own warm token, so another warm guest of the install carrying it is not acted on", async () => {
  const warm = (token: string): GuestSpec => ({ description: `bb-box warm desktop\ninstall ${INSTALL}\nwarm ${token}`, tags: ["bb-box", `install.${INSTALL}`, "warm", "template.9001"], marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop") });
  const node = new FakeNode({ writes: "off" });
  node.guest(2770, warm("0123456789ab"));
  ran(node);
  assert.ok(claims(node).includes(`claim 2770 g1 granted shared ${A}`), claims(node).join(" | "));
  node.ask(2770, asked("start", null, 1, "cccc0001"));
  ran(node);
  assert.ok(powered(node).includes(`power 2770 ncccc0001 start refused not-the-box ${INSTALL}/warm-0123456789ab`), "a request naming no warm token does not reach a warm guest");
  node.ask(2770, asked("start", "warm-0123456789ab", 1, "cccc0002"));
  ran(node);
  assert.deepEqual(node.powerLog(), ["start 2770"]);

  const request = asked("stop", "warm-0123456789ab", 1, "cccc0003");
  node.ask(2770, request);
  node.replacementOnUnlock(2770, { ...warm("fedcba987654"), marker: [marker("shared", CARD_A, 1), request], running: true });
  const hold = node.holdLock(2770, 1.5, "replace");
  await hold.locked;
  ran(node);
  await exited(hold);
  assert.deepEqual(node.powerLog(), ["start 2770"], "the other warm guest is not stopped");
  assert.ok(powered(node).includes(`power 2770 ncccc0003 stop refused not-the-box ${INSTALL}/warm-fedcba987654`), powered(node).join(" | "));
});

test("071 unit 6: an unrearmed fork, a held copy with a card marker, and a newer gpu.none lose their lines, on a service pass and on boot, and a rebuild grants none of them", () => {
  const source = boxLabels("bxsrc", "source-pine");
  const fork = boxLabels("bxfork", "fork-pine");
  const node = new FakeNode({ writes: "on" });
  node.guest(1610, { description: source.description, tags: source.tags, marker: marker("shared", CARD_A, 4), lines: cardLines(CARD_A, "server") });
  ran(node);
  const kept = node.text(1610);
  node.guest(1611, { description: fork.description, tags: source.tags, marker: marker("shared", CARD_A, 4), lines: [...cardLines(CARD_A, "server"), TUN] });
  ran(node);
  assert.equal(node.text(1610), kept);
  assert.deepEqual(node.lines(1611), []);
  assert.ok(Object.values(node.config(1611).keys).includes(TUN));
  assert.ok(claims(node).includes(`claim 1611 g4 refused copy ${A} unrearmed`), claims(node).join("\n"));

  const boot = new FakeNode({ writes: "on" });
  boot.guest(1612, { description: fork.description, tags: source.tags, marker: marker("shared", CARD_A, 4), lines: cardLines(CARD_A, "server") });
  const bootErr = ran(boot, ["--boot"]);
  assert.deepEqual(boot.lines(1612), []);
  assert.match(bootErr, /refused CT 1612 g4: copy unrearmed/);
  assert.ok(boot.ledger().answers.some((answer) => answer.vmid === 1612 && answer.answer === "refused" && answer.reason === "copy"));

  node.guest(1613, { ...heldCopyLabels("bxsrc"), marker: marker("shared", CARD_A, 3), lines: cardLines(CARD_A, "server") });
  ran(node);
  assert.deepEqual(node.lines(1613), []);
  assert.ok(!lines(node, "holder").some((line) => line.includes(" 1613 ")));
  assert.ok(claims(node).some((line) => line.startsWith("claim 1613 g3 refused held")));

  node.guest(1614, { box: "bx1614", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") });
  ran(node);
  node.mark(1614, marker("none", null, 2));
  const noneBoot = ran(node, ["--boot"]);
  assert.deepEqual(node.lines(1614), []);
  assert.match(noneBoot, /granted CT 1614 g2: none/);
  assert.equal(node.ledger().guests["1614"]?.claim?.part, "none");

  node.guest(1615, { box: "bx1615", marker: marker("shared", CARD_A, 2), lines: [TUN] });
  ran(node);
  const rolled = node.text(1615);
  node.mark(1615, marker("shared", CARD_B, 3));
  ran(node);
  writeFileSync(node.configPath(1615), rolled);
  ran(node, ["--boot"]);
  assert.deepEqual(node.lines(1615), cardLines(CARD_B, "server"), "boot puts the ledger's card back when the marker is older");

  const rebuilt = new FakeNode({ writes: "on", ledger: false });
  rebuilt.guest(1616, { description: fork.description, tags: source.tags, marker: marker("shared", CARD_A, 4), lines: cardLines(CARD_A, "server") });
  ran(rebuilt);
  assert.deepEqual(rebuilt.lines(1616), []);
  assert.ok(!claims(rebuilt).some((line) => line.includes("1616") && line.includes("granted")));
});

test("071 unit 6 round 2, Astra 1: a fork's copy cut short before its re-arm, from a snapshot with no GPU marker, and a held copy's clone cut short before its labels lose their lines and their start at boot on a service pass and on the boot pass; an ordinary unmarked guest keeps both", () => {
  const source = boxLabels("bxsrc", "source-pine");
  const fork = boxLabels("bxfork", "fork-pine");
  const held = heldCopyLabels("bxsrc");
  const copies = (node: FakeNode) => {
    node.guest(1620, { description: source.description, tags: source.tags, marker: marker("shared", CARD_B, 5), lines: cardLines(CARD_B, "server"), keys: { onboot: "1" } });
    node.guest(1621, { description: fork.description, tags: source.tags, lines: [...cardLines(CARD_A, "server"), TUN], keys: { onboot: "1" } });
    node.guest(1622, { description: held.description, tags: source.tags, lines: cardLines(CARD_A, "server"), keys: { onboot: "1" } });
    node.guest(1623, { box: "bxplain", lines: cardLines(CARD_A, "server"), keys: { onboot: "1" } });
    node.guest(1624, { description: fork.description, tags: source.tags, marker: marker("shared", CARD_A, 4), lines: cardLines(CARD_A, "server"), keys: { onboot: "1" } });
    node.guest(1625, { description: fork.description, tags: held.tags, lines: cardLines(CARD_A, "server") });
    node.guest(1626, { description: fork.description, tags: source.tags, marker: marker("none", null, 3), keys: { onboot: "1" } });
    node.guest(1627, { description: fork.description, tags: source.tags, keys: { onboot: "1" } });
    node.guest(1628, { box: "bxplainer", marker: marker("none", null, 1), keys: { onboot: "1" } });
  };
  for (const args of [["--once"], ["--boot"]]) {
    const node = new FakeNode({ writes: "on" });
    copies(node);
    const kept = snapshot(node, [1620, 1623, 1628]);
    const said = ran(node, args);
    assertUnchanged(node, kept);
    for (const vmid of [1621, 1622, 1624, 1626, 1627]) {
      assert.deepEqual(node.lines(vmid), [], `${args[0]}: CT ${vmid}'s lines`);
      assert.equal(node.config(vmid).keys.onboot, "0", `${args[0]}: CT ${vmid} does not start with the node`);
    }
    assert.ok(Object.values(node.config(1621).keys).includes(TUN), "its other devices stay");
    assert.match(said, /wrote CT 1621 for not re-armed: remove dev0 \/dev\/nvidia1,mode=0666, .*; add nothing; start at boot off/);
    assert.match(said, /wrote CT 1622 for held copy not labelled: remove .*; add nothing; start at boot off/);
    assert.match(said, /refused CT 1624 g4: copy unrearmed/);
    assert.deepEqual(node.lines(1625), [], `${args[0]}: a fork's copy of a legacy held copy loses the copy's lines`);
    assert.match(said, /wrote CT 1625 for not re-armed: remove .*; add nothing\n/);
    assert.match(said, /wrote CT 1626 for not re-armed: remove nothing; add nothing; start at boot off/, "a copy with no card still does not start with the node");
    assert.match(said, /wrote CT 1627 for not re-armed: remove nothing; add nothing; start at boot off/);
    assert.ok(!lines(node, "holder").some((line) => / 162[124] /.test(line)), lines(node, "holder").join("\n"));
    const again = snapshot(node, [1620, 1621, 1622, 1623, 1624, 1625, 1626, 1627, 1628]);
    ran(node, args);
    assertUnchanged(node, again);
  }

  const dry = new FakeNode({ writes: "off" });
  copies(dry);
  const before = snapshot(dry, [1620, 1621, 1622, 1623, 1624]);
  const said = ran(dry);
  assertUnchanged(dry, before);
  assert.match(said, /would write CT 1621 for not re-armed: remove .*; add nothing; start at boot off/);
});
