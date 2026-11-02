import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { parseGpuReport } from "../src/backends/proxmox-lxc/backend.ts";
import { CARD_A, CARD_B, FakeNode, INSTALL, REPORT_VMID, cardLines, exited, heldCopyLabels, helperConstant, marker, otherKeys, type FakeCard } from "./gpu-helper/node.ts";

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
  assert.deepEqual(lines(lost, "would"), ["would 241 lines none for copy of 240"]);
});

test("--help and --version say what the helper is, and an argument it cannot read is refused", () => {
  const node = new FakeNode();
  const help = node.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^bb-box-gpu 0\.2\.0, protocol 1: the host's GPU helper for bb-box\./);
  assert.match(help.stdout, /Writes are off\s+unless/);
  assert.equal(node.run(["--version"]).stdout, "bb-box-gpu 0.2.0 protocol 1\n");
  const wrong = node.run(["--writes-on"]);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /cannot read '--writes-on'/);
  assert.deepEqual(node.writes(), []);
});

test("it leaves alone every guest it must: outside its pools, privileged, a template, running, locked, with pending device changes, malformed or double markers, not bb-box's, unmarked with NVIDIA lines, and an unknown card (section 14)", () => {
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

test("a lost ledger is rebuilt from the guests: matching guests are granted, a running copy keeps its card and the stopped one loses its lines, and the rest wait for bb-box's next request", () => {
  const node = new FakeNode({ writes: "on", ledger: false });
  node.guest(900, { box: "bx900", name: "amber-fox", marker: marker("shared", CARD_A, 3), lines: cardLines(CARD_A, "server"), running: true });
  const copy = { box: "bx900", name: "amber-fox", hostname: "bb-box-copy-901", marker: marker("shared", CARD_A, 3), lines: cardLines(CARD_A, "server") };
  const yielding = { box: "bx903", marker: marker("shared", CARD_B, 1), lines: cardLines(CARD_B, "server") };
  node.guest(901, copy);
  node.guest(902, { box: "bx902", marker: marker("whole", CARD_B, 2), lines: cardLines(CARD_B, "server"), running: true });
  node.guest(903, yielding);
  node.guest(904, { box: "bx904", marker: marker("shared", CARD_B, 4), lines: cardLines(CARD_A, "server") });
  node.guest(905, { box: "bx905", marker: marker("none", null, 2) });
  ran(node);
  assert.deepEqual(node.guestWrites().sort(), ["lxc 901", "lxc 903"]);
  rmSync(node.ledgerPath());
  rmSync(node.file("run/fake-pve/writes.log"));
  node.guest(901, copy);
  node.guest(903, yielding);
  const stderr = ran(node);
  assert.match(stderr, /the ledger was rebuilt from the guests: 3 granted, 1 yielded, 1 refused as copies, 1 refused as their lines did not match their marker/);
  const ledger = node.ledger();
  assert.equal(ledger.guests["900"]!.claim!.answer, "granted");
  assert.equal(ledger.guests["902"]!.claim!.part, "whole");
  assert.equal(ledger.guests["903"]!.claim!.answer, "yielded");
  assert.equal(ledger.guests["905"]!.claim!.part, "none");
  assert.equal(ledger.guests["901"]!.strip!.why, "copy of 900");
  assert.deepEqual(node.lines(901), [], "the stopped copy loses its lines");
  assert.deepEqual(node.lines(903), [], "a stopped shared box on a running whole box's card yields");
  assert.deepEqual(node.lines(900), cardLines(CARD_A, "server"));
  assert.deepEqual(node.lines(904), cardLines(CARD_A, "server"), "a guest whose lines do not match its marker is not written");
  assert.ok(claims(node).includes(`claim 904 g4 refused ledger-lost ${B}`));
  ran(node);
  assert.deepEqual(node.lines(904), cardLines(CARD_A, "server"), "its generation is not answered again");
  node.mark(904, marker("shared", CARD_B, 5));
  ran(node);
  assert.ok(claims(node).includes(`claim 904 g5 refused whole-taken ${B} 902`), "bb-box's next request is answered");
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

test("the report: today's bb-box reads its at and gpu lines, it names the helper, the driver, each card, the holders and the answers, says when the card mapping moved since the last boot, and stays under 8,192 characters", () => {
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
    "helper bb-box-gpu 0.2.0 protocol 1 writes off pve-container 6.1.14 tested",
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
  assert.deepEqual(lines(crowded, "ledger").filter((line) => line.startsWith("ledger entries ")), ["ledger entries 120"], "the count of ledger entries is always there, so bb-box knows when some are left out");
  assert.deepEqual(parseGpuReport(text)!.gpus.length, 2);
});

test("when nvidia-smi fails, no card is listed and no claim is granted; the report says why, today's bb-box still reads it, and lines already written stay", () => {
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

test("the report lists each ledger entry: its box, the generation answered and the claim, so bb-box can ask above it and read a grant exactly (071 unit 4, Opus 1)", () => {
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

test("a ledger from a newer protocol: the helper acts on nothing and says so, and today's bb-box still reads the report", () => {
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
  assert.deepEqual(lines(node, "would"), ["would 2001 lines none for copy of 2000", "would 2003 lines none for yield to 2002 g1"]);
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
