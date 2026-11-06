import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OTHERS_ON_CARD_BYTES, countedGpuPercent, executableName, gpuReadingFromSections, gpuReadingOf, nvidiaScript, parseNvidiaCards, parseNvidiaProcesses } from "../src/monitor/nvidia.ts";
import { forgetQuietNvidia, readNvidiaHere } from "../src/monitor/nvidia-local.ts";
import { createRouteCollector, routeScript, routeSections } from "../src/monitor/route.ts";
import { parseProcesses } from "../src/monitor/collector.ts";
import { HIGH, gpuHigh, lightScript, lightSections, machinePoint, parseLightOutput, type Kept } from "../src/monitor/light.ts";
import { assessHealth } from "../src/monitor/health.ts";
import { busyOf, type BusyPoint } from "../src/monitor/busy.ts";
import { busyWords } from "../src/app/box-words.ts";
import { cardFoot, cardLabel, cardSlots, sharedCardWords } from "../src/app/gpu-words.ts";
import { tempDir } from "./helpers.ts";

const MiB = 1024 * 1024;
const BUS_0 = "00000000:D1:00.0";
const BUS_1 = "00000000:C1:00.0";

const UUID_0 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UUID_1 = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const CARD_0 = `0, GPU-${UUID_0}, ${BUS_0}, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 82, 13250, 97887, 69, 285.05, 300.00`;
const CARD_1 = `1, GPU-${UUID_1}, ${BUS_1}, NVIDIA GeForce RTX 4090, 3, 1024, 24564, 41, 31.20, 450.00`;
const TWO_CARDS = `${CARD_0}\n${CARD_1}`;

type Listed = readonly [pid: number, type: string, name: string, mib: number | null];

function pidsReport(cards: Readonly<Record<string, readonly Listed[]>>): string {
  const lines = ["", "==============NVSMI LOG==============", "", "Timestamp                                 : Sat Oct 31 17:06:14 2026", "Driver Version                            : 580.142", "CUDA Version                              : 13.0", "", `Attached GPUs                             : ${Object.keys(cards).length}`];
  for (const [bus, processes] of Object.entries(cards)) {
    lines.push(`GPU ${bus}`);
    if (!processes.length) {
      lines.push("    Processes                             : None", "");
      continue;
    }
    lines.push("    Processes");
    for (const [pid, type, name, mib] of processes) {
      lines.push("        GPU instance ID                   : N/A", "        Compute instance ID               : N/A", `        Process ID                        : ${pid}`, `            Type                          : ${type}`, `            Name                          : ${name}`, `            Used GPU Memory               : ${mib === null ? "Not available in WDDM driver model" : `${mib} MiB`}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const bytes = (value: number) => `${Math.round(value / MiB)} MiB`;

test("nvidia-smi's card query is read per card, in MiB and W without units, and a field it cannot read is null", () => {
  const cards = parseNvidiaCards(`${TWO_CARDS}\n2, GPU-cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee, 00000000:41:00.0, Tesla T4, [N/A], [Not Supported], 15360, [N/A], [N/A], 70.00\n`)!;
  assert.equal(cards.length, 3);
  assert.deepEqual(cards[0], { index: 0, uuid: UUID_0, bus: "0000:d1:00.0", name: "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition", usagePercent: 82, memoryUsedBytes: 13250 * MiB, memoryTotalBytes: 97887 * MiB, temperatureC: 69, powerWatts: 285.05, powerLimitWatts: 300 });
  assert.equal(cards[1]!.name, "NVIDIA GeForce RTX 4090");
  assert.deepEqual([cards[2]!.usagePercent, cards[2]!.memoryUsedBytes, cards[2]!.memoryTotalBytes, cards[2]!.temperatureC, cards[2]!.powerWatts], [null, null, 15360 * MiB, null, null]);
});

test("no GPU, or nvidia-smi failing, reads as no card; one lost card keeps the others", () => {
  assert.equal(parseNvidiaCards(""), null);
  assert.equal(parseNvidiaCards(undefined), null);
  assert.equal(parseNvidiaCards("No devices were found\n"), null);
  assert.equal(parseNvidiaCards("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.\n"), null);
  assert.equal(gpuReadingOf(null, [], true), null);
  assert.equal(gpuReadingFromSections(new Map(), true), null, "a box with no nvidia-smi has no section at all");
  assert.equal(gpuReadingFromSections(new Map([["nvidia", "Failed to initialize NVML: Driver/library version mismatch"], ["nvidia-pids", "[failed]"]]), true), null);
  const lost = parseNvidiaCards(`${CARD_0}\nUnable to determine the device handle for GPU${BUS_1}: Unknown Error\n`)!;
  assert.deepEqual(lost.map((card) => card.index), [0]);
});

test("processes, compute and graphics, are read by name and PID, never arguments; unknown ones and a failed query are not this box's", () => {
  const apps = parseNvidiaProcesses(pidsReport({
    [BUS_0]: [[4242, "C", "/usr/bin/python3", 12000], [200, "G", "/usr/lib/xorg/Xorg", 63], [5150, "C", "[Not Found]", 9000], [0, "C", "python", 100]],
    [BUS_1]: [[77, "C+G", "/opt/chrome/chrome --type=gpu-process --secret=1", null]],
    "00000000:41:00.0": [],
  }))!;
  assert.deepEqual(apps, [
    { bus: "0000:d1:00.0", pid: 4242, name: "python3", memoryBytes: 12000 * MiB },
    { bus: "0000:d1:00.0", pid: 200, name: "Xorg", memoryBytes: 63 * MiB },
    { bus: "0000:c1:00.0", pid: 77, name: "chrome", memoryBytes: null },
  ]);
  assert.equal(executableName("/usr/bin/python3 train.py --data /mnt/secret"), "python3", "only the executable, never its arguments");
  assert.deepEqual(parseNvidiaProcesses(pidsReport({ [BUS_0]: [] })), []);
  assert.equal(parseNvidiaProcesses("[failed]\n"), null);
  assert.equal(parseNvidiaProcesses(undefined), null);
});

test("several cards: each card's own processes and memory, sorted by memory, and the busiest card for busy", () => {
  const reading = gpuReadingOf(parseNvidiaCards(TWO_CARDS), parseNvidiaProcesses(pidsReport({ [BUS_0]: [[4242, "C", "python3", 12900], [200, "G", "Xorg", 63]], [BUS_1]: [[9, "C", "train", 900]] })), false)!;
  assert.deepEqual(reading.cards.map((card) => [card.index, card.shared, card.ownProcesses, card.ownMemoryBytes]), [[0, false, 2, 12963 * MiB], [1, false, 1, 900 * MiB]]);
  assert.deepEqual(reading.processes!.map((process) => [process.pid, process.card]), [[4242, 0], [9, 1], [200, 0]]);
  assert.equal(countedGpuPercent(reading.cards), 82);
  assert.equal(Object.hasOwn(reading.cards[0]!, "bus"), false, "the bus ID stays in the reader");
});

test("a shared card: the whole card's numbers, never busy; a desktop alone on its card, with its own Xorg and browser, is not shared", () => {
  const cards = parseNvidiaCards(CARD_0);
  const idle = gpuReadingOf(cards, [], true)!;
  assert.equal(idle.cards[0]!.shared, true, "13 GiB on the card, none of it this box's");
  assert.equal(idle.cards[0]!.ownMemoryBytes, 0);
  assert.equal(countedGpuPercent(idle.cards), null, "another box's training never makes this box busy");
  const idleContext = gpuReadingOf(cards, parseNvidiaProcesses(pidsReport({ [BUS_0]: [[31, "C", "python", 180]] })), true)!;
  assert.equal(idleContext.cards[0]!.shared, true);
  assert.equal(countedGpuPercent(idleContext.cards), null, "an idle notebook kernel on a card another box trains on is not busy");
  const desktop = gpuReadingOf(parseNvidiaCards(`0, GPU-${UUID_0}, ${BUS_0}, NVIDIA RTX PRO 6000, 4, 900, 97887, 40, 60.00, 300.00`), parseNvidiaProcesses(pidsReport({ [BUS_0]: [[200, "G", "/usr/lib/xorg/Xorg", 63], [880, "G", "/opt/google/chrome/chrome", 837]] })), true)!;
  assert.equal(desktop.cards[0]!.shared, false, "its own Xorg and Chrome are its own");
  const alone = gpuReadingOf(cards, parseNvidiaProcesses(pidsReport({ [BUS_0]: [[31, "C", "python", 13250 - 300]] })), true)!;
  assert.equal(alone.cards[0]!.shared, false, "what is left is under the margin, so the card is this box's alone");
  assert.equal(countedGpuPercent(alone.cards), 82);
  assert.equal(gpuReadingOf(cards, [], false)!.cards[0]!.shared, false, "outside a container nvidia-smi sees every process, so nothing is hidden");
  assert.equal(gpuReadingOf(cards, null, true)!.cards[0]!.shared, false, "with no process list, it cannot say");
  assert.ok(OTHERS_ON_CARD_BYTES >= 384 * MiB);

  const card = idle.cards[0]!;
  assert.equal(cardLabel(card, 1), "GPU, whole card");
  assert.equal(cardLabel(card, 2), "GPU 0, whole card");
  assert.equal(cardFoot(card, bytes), "This box: 0 MiB of 13250 MiB");
  assert.equal(cardFoot(card, bytes, false), "13250 of 97887 MiB · 285 W");
  assert.equal(cardFoot({ ...card, ownMemoryBytes: null, ownProcesses: null }, bytes), "Whole card: 13250 MiB used");
  assert.equal(sharedCardWords(card, 1, bytes), "This box shares its GPU with other boxes or the host. Its numbers are the whole card's, every user's together. None of this box's processes use it now. bb-box cannot tell how much of the card's use is this box's, so a shared card never makes this box busy.");
  assert.match(sharedCardWords(idleContext.cards[0]!, 2, bytes), /^This box shares GPU 0 with .* This box's own process uses 180 MiB of its memory\./);
  assert.equal(cardFoot(gpuReadingOf(cards, [], false)!.cards[0]!, bytes), "13250 of 97887 MiB · 285 W");
});

test("the route and light scripts ask nvidia-smi only where its device and command are, each call bounded, the GPU last", () => {
  for (const script of [routeScript("linux", "machine"), lightScript("linux", { own: false, machine: true })]) {
    assert.match(script, /if \[ -e \/dev\/nvidiactl \] && command -v nvidia-smi >\/dev\/null 2>&1; then t=; command -v timeout >\/dev\/null 2>&1 && t="timeout -k 1 2"/);
    assert.equal(script.match(/\$t nvidia-smi --query-gpu=index,uuid,pci\.bus_id,name,utilization\.gpu,memory\.used,memory\.total,temperature\.gpu,power\.draw,power\.limit --format=csv,noheader,nounits/g)?.length, 1);
    assert.equal(script.match(/\$t nvidia-smi -q -d PIDS \|\| echo '\[failed\]'/g)?.length, 1);
    assert.match(script, /fi; true$/, "the GPU sections come last");
  }
  assert.doesNotMatch(routeScript("macos", "machine"), /nvidia/);
  assert.doesNotMatch(routeScript("linux", "user"), /nvidia/);
  assert.doesNotMatch(lightScript("macos", { own: true, machine: true }), /nvidia/);
});

function fakeFolder(name: string, script: string): { folder: string; device: string; env: NodeJS.ProcessEnv } {
  const folder = tempDir(name);
  const device = join(folder, "nvidiactl");
  writeFileSync(device, "");
  writeFileSync(join(folder, "nvidia-smi"), `#!/bin/sh\necho run >> ${join(folder, "calls")}\n${script}\n`);
  chmodSync(join(folder, "nvidia-smi"), 0o755);
  return { folder, device, env: { ...process.env, PATH: `${folder}:${process.env.PATH}` } };
}

const HANGS = "trap '' TERM\nexec sleep 30";

function boxScript(device: string): string {
  const part = (name: string, command: string) => `printf '@@${name}\\n'; ${command} 2>/dev/null`;
  return `${part("stat", "echo 'cpu  100 0 100 800 0 0 0 0 0 0'")}; ${part("df", "echo '/dev/root 100 50 50 50% /'")}; ${nvidiaScript(part, device)}; true`;
}

test("in a box, an nvidia-smi that ignores SIGTERM and hangs is killed within 3 s, the process query is skipped, and the rest of the reading is kept", { skip: platform() !== "linux" }, () => {
  const fake = fakeFolder("nvidia-box-hang", HANGS);
  const started = Date.now();
  const output = execFileSync("sh", ["-c", boxScript(fake.device)], { env: fake.env, encoding: "utf8", timeout: 20_000 });
  const took = Date.now() - started;
  assert.ok(took < 4500, `the script took ${took} ms`);
  const sections = lightSections(output);
  assert.ok(sections.has("stat") && sections.has("df"), "CPU and disk are still read");
  assert.equal(sections.has("nvidia-pids"), false, "a timed-out card query skips the process query");
  assert.equal(gpuReadingFromSections(sections, true), null);
  assert.equal(readFileSync(join(fake.folder, "calls"), "utf8").trim().split("\n").length, 1);

  const lost = fakeFolder("nvidia-box-lost", `case "$1" in --query-gpu=*) echo '${CARD_0}'; echo 'Unable to determine the device handle for GPU${BUS_1}: Unknown Error'; exit 15;; -q) printf '%s\\n' '${pidsReport({ [BUS_0]: [[31, "C", "python", 512]] }).replace(/'/g, "")}';; esac`);
  const kept = gpuReadingFromSections(lightSections(execFileSync("sh", ["-c", boxScript(lost.device)], { env: lost.env, encoding: "utf8" })), false)!;
  assert.deepEqual(kept.cards.map((card) => card.index), [0], "the lost card is left out, the other kept");
  assert.deepEqual(kept.processes, [{ pid: 31, name: "python", card: 0, memoryBytes: 512 * MiB }], "and its processes are still asked for");
});

test("on this machine, a hanging nvidia-smi is given up on at its time limit and killed, not asked again for 5 minutes, and a lost card keeps the others", { skip: platform() !== "linux" }, async () => {
  const signal = AbortSignal.timeout(20_000);
  const path = process.env.PATH;
  try {
    const hang = fakeFolder("nvidia-here-hang", HANGS);
    process.env.PATH = hang.env.PATH;
    const started = Date.now();
    assert.equal(await readNvidiaHere(signal, { inContainer: false, processes: true, device: hang.device, timeoutMs: 400 }), null);
    assert.ok(Date.now() - started < 1500, `it waited ${Date.now() - started} ms`);
    assert.equal(await readNvidiaHere(signal, { inContainer: false, processes: true, device: hang.device, timeoutMs: 400 }), null);
    assert.equal(readFileSync(join(hang.folder, "calls"), "utf8").trim().split("\n").length, 1, "a wedged driver gets no second stuck nvidia-smi");
    forgetQuietNvidia();

    const lost = fakeFolder("nvidia-here-lost", `case "$1" in --query-gpu=*) echo '${CARD_0}'; echo 'Unable to determine the device handle for GPU${BUS_1}: Unknown Error'; exit 15;; -q) printf '%s\\n' '${pidsReport({ [BUS_0]: [[4242, "C", "/usr/bin/python3", 12000]] }).replace(/'/g, "")}';; esac`);
    process.env.PATH = lost.env.PATH;
    const read = (await readNvidiaHere(signal, { inContainer: false, processes: true, device: lost.device }))!;
    assert.deepEqual(read.cards.map((card) => [card.index, card.usagePercent]), [[0, 82]]);
    assert.deepEqual(read.processes, [{ pid: 4242, name: "python3", card: 0, memoryBytes: 12000 * MiB }]);
    assert.equal(await readNvidiaHere(signal, { inContainer: false, processes: true, device: join(lost.folder, "absent") }), null, "no device, no nvidia-smi");

    const failing = fakeFolder("nvidia-here-failing", "echo 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.'\nexit 9");
    process.env.PATH = failing.env.PATH;
    assert.equal(await readNvidiaHere(signal, { inContainer: false, processes: true, device: failing.device }), null);

    process.env.PATH = join(lost.folder, "no-such-folder");
    assert.equal(await readNvidiaHere(signal, { inContainer: false, processes: true, device: lost.device }), null, "nvidia-smi is missing");
    process.env.PATH = lost.env.PATH;
    assert.equal(await readNvidiaHere(signal, { inContainer: false, processes: true, device: lost.device }), null, "and is not asked again at once");
    forgetQuietNvidia();
    assert.ok(await readNvidiaHere(signal, { inContainer: false, processes: true, device: lost.device }));
    assert.ok(existsSync(join(lost.folder, "calls")));
  } finally {
    process.env.PATH = path;
    forgetQuietNvidia();
  }
});

test("a box read through its route shows its cards, keeps processes on the GPU in its top processes, and the GPU never changes its health", () => {
  const ps = ["1 0.0 0.1 1000 Ss /sbin/init", "10 80.0 1.0 1000 R cc1", "11 70.0 1.0 1000 R cc1", "12 60.0 1.0 1000 R cc1", "13 50.0 1.0 1000 R cc1", "14 40.0 1.0 1000 R cc1", "15 30.0 1.0 1000 R cc1", "4242 2.0 9.0 90000 S /usr/bin/python3"].join("\n");
  const output = [
    "",
    "@@bb-box-monitor:uname",
    "Linux 6.17.13 x86_64",
    "@@bb-box-monitor:ps",
    ps,
    "@@bb-box-monitor:stat",
    "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0",
    "@@bb-box-monitor:meminfo",
    "MemTotal: 8388608 kB\nMemAvailable: 4194304 kB",
    "@@bb-box-monitor:nvidia",
    `0, GPU-${UUID_0}, ${BUS_0}, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 97, 40000, 97887, 80, 290.00, 300.00`,
    "@@bb-box-monitor:nvidia-pids",
    pidsReport({ [BUS_0]: [[4242, "C", "/usr/bin/python3", 39000]] }),
    "",
  ].join("\n");
  const collector = createRouteCollector({ os: "linux", scope: "machine", refreshIntervalMs: () => 5000 });
  const snapshot = collector.snapshot({ sections: routeSections(output), receivedAt: 0 });
  assert.equal(snapshot.gpus!.cards[0]!.usagePercent, 97);
  assert.equal(snapshot.gpus!.cards[0]!.shared, false);
  assert.deepEqual(snapshot.processes.top.map((process) => process.pid), [10, 11, 12, 13, 14, 4242], "the trainer is listed though six compilers use more CPU, in CPU order");
  assert.equal(snapshot.health.status, "healthy", "a card at full use is a training box doing its job, never a health issue");
  assert.deepEqual(snapshot.history.at(-1)!.gpus, [{ card: 0, usage: 97, memory: (40000 / 97887) * 100 }]);

  const plain = createRouteCollector({ os: "linux", scope: "machine", refreshIntervalMs: () => 5000 }).snapshot({ sections: routeSections(output.split("@@bb-box-monitor:nvidia\n")[0]!), receivedAt: 0 });
  assert.equal(plain.gpus, null, "a box with no GPU has none");
  assert.equal(plain.history.at(-1)!.gpus, undefined);
  assert.deepEqual(parseProcesses(ps).top.map((process) => process.pid), [10, 11, 12, 13, 14, 15], "nothing pinned, the top six by CPU");
});

function lightOutput(nvidia: string | null, pids: string | null, container: boolean): string {
  const lines = ["@@stat", "cpu  100 0 100 800 0 0 0 0 0 0", "2", "btime 1700000000", "@@meminfo", "MemTotal: 4194304 kB", "MemAvailable: 3145728 kB", "@@df", "/dev/root 33554432 8388608 25165824 25% /"];
  if (container) lines.push("@@cgroup:cpu.max", "max 100000", "@@cgroup:cpuset.cpus.effective", "0-1", "@@cgroup:memory.current", "1073741824", "@@cgroup:memory.max", "max", "@@cgroup:cpu.stat", "usage_usec 1000000", "@@cgroup:memory.stat", "inactive_file 0");
  if (nvidia !== null) lines.push("@@nvidia", nvidia);
  if (pids !== null) lines.push("@@nvidia-pids", pids);
  return `${lines.join("\n")}\n`;
}

test("box history's light reading keeps each card's use and memory at the minute's point; the GPU makes a point high from 85%, never on a shared card", () => {
  const card = `0, GPU-${UUID_0}, ${BUS_0}, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 96, 48943, 97886, 80, 290.00, 300.00`;
  const own = parseLightOutput("linux", lightOutput(card, pidsReport({ [BUS_0]: [[31, "C", "python", 48900]] }), true));
  assert.deepEqual(own.gpus, [{ index: 0, usagePercent: 96, memoryUsedBytes: 48943 * MiB, memoryTotalBytes: 97886 * MiB, shared: false, ownProcesses: 1 }]);
  const previous: Kept = { at: 0, tick: 0, reading: own };
  const point = machinePoint(previous, { at: 60_000, tick: 60_000, reading: own });
  assert.deepEqual(point.gpus, [{ card: 0, usage: 96, memory: 50, shared: false }]);
  assert.equal(point.gpu, 96);
  assert.equal(point.high, HIGH.gpu, "high for its GPU alone");

  const beside = parseLightOutput("linux", lightOutput(card, pidsReport({ [BUS_0]: [[31, "C", "python", 180]] }), true));
  const besidePoint = machinePoint({ at: 0, tick: 0, reading: beside }, { at: 60_000, tick: 60_000, reading: beside });
  assert.equal(besidePoint.gpus![0]!.shared, true);
  assert.equal(besidePoint.gpu, null);
  assert.equal(besidePoint.high & HIGH.gpu, 0, "a card another box keeps busy does not make this box busy, even with its own idle process on it");
  assert.equal(gpuHigh(84.9), 0);
  assert.equal(gpuHigh(85), HIGH.gpu);
  assert.equal(gpuHigh(null), 0);
  assert.deepEqual(assessHealth({ cpuPercent: 10, memoryPercent: 20, diskPercent: 30, load: null }), { status: "healthy", issues: [] });

  const none = parseLightOutput("linux", lightOutput(null, null, true));
  assert.equal(none.gpus, null);
  assert.equal(machinePoint({ at: 0, tick: 0, reading: none }, { at: 60_000, tick: 60_000, reading: none }).gpus, undefined);
});

test("busy for the GPU: five whole minutes of a high counted GPU, in its own words", () => {
  const T0 = 1_800_000_000_000;
  const points: BusyPoint[] = Array.from({ length: 6 }, (_, index) => ({ at: T0 + (index + 1) * 60_000, covered: 60, cpu: 12, memory: 40, disk: 20, load: null, cores: 4, gpu: 98, high: HIGH.gpu }));
  const busy = busyOf(points, T0 + 6 * 60_000 + 5_000, false)!;
  assert.equal(busy.reason, "gpu");
  assert.equal(busy.value, 98);
  assert.equal(busyWords(busy, (ms) => `${Math.round(ms / 60_000)} min`), "Busy: GPU 98% for 6 min");
  assert.equal(busyOf(points.slice(2), T0 + 6 * 60_000 + 5_000, false), null, "four minutes is not enough");
});

test("card slots keep every card a box has had, and add any read since", () => {
  assert.deepEqual(cardSlots([], 2), [0, 1], "a reading that missed both cards keeps both");
  assert.deepEqual(cardSlots([1], 2), [0, 1], "one missed keeps its place");
  assert.deepEqual(cardSlots([0, 1, 2], 1), [0, 1, 2]);
  assert.deepEqual(cardSlots([], 0), []);
});
