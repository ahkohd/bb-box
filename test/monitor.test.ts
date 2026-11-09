import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import { calculateCpuUsage, calculateNetworkRates, createCollector, parseNetDev, parseNetstatLinks, parseProcStat, parseProcesses, parseVmStatUsedBytes, parseWindowsSubinterfaces, processArgs } from "../src/monitor/collector.ts";
import { containerCapacity, containerCpuPercent, containerMemory, inNamespacedCgroup, parseContainer, parseCpuList, parseCpuMax, parseStall, readContainer, type ContainerCounters } from "../src/monitor/container.ts";
import { assessHealth } from "../src/monitor/health.ts";
import { createRouteCollector, parseDfRoot, parseMacLoad, routeScript, routeSections } from "../src/monitor/route.ts";
import { snapshotSchema, type MonitorSnapshot } from "../src/monitor/snapshot.ts";
import { monitorHandlers } from "../src/host/monitor.ts";
import { MONITOR_DEFAULTS, monitorConfig, readDraft } from "../src/core/document.ts";
import { DRIVERS } from "../src/backends/index.ts";
import { BOX_MACHINE_PREFIX, MonitorOffError, SERVER_MACHINE, asSlotReading, createLightSampler, listMachines, monitorChecks, monitorRpcHandlers, offlineMachineWords, readableState, stillJoiningWords, unreadReason, unreadableWords, type MonitoredBox, type MonitorHost } from "../src/plugin/monitor.ts";
import { monitorSnapshotText } from "../src/plugin/monitor-cli.ts";
import { flush, startTestMonitor } from "./monitor-helpers.ts";

test("a box whose BB machine is known is not called no BB machine when that machine is offline, and one still joining is not called offline", () => {
  assert.equal(unreadReason("calm-otter", { state: "enrolled", hostId: "host_1" }), offlineMachineWords("calm-otter"));
  assert.equal(unreadReason("calm-otter", { state: "failed", hostId: "host_1" }), offlineMachineWords("calm-otter"));
  assert.equal(unreadReason("calm-otter", { state: "failed", hostId: null }), unreadableWords("calm-otter"));
  assert.equal(unreadReason("calm-otter", { state: "enrolling", hostId: "host_1" }), stillJoiningWords("calm-otter"));
  assert.equal(unreadReason("calm-otter", { state: "enrolling", hostId: null }), stillJoiningWords("calm-otter"));
  assert.equal(unreadReason("calm-otter", { state: "off", hostId: null }), unreadableWords("calm-otter"));
  assert.equal(stillJoiningWords("calm-otter").includes("is still joining BB"), true);
  assert.equal(stillJoiningWords("calm-otter").includes("not answering"), false);
  assert.equal(unreadableWords("calm-otter").includes("not a BB machine"), true);
  assert.equal(offlineMachineWords("calm-otter").includes("not a BB machine"), false);
  assert.equal(readableState("ready"), true);
});

test("CPU deltas handle warmup, idle, full utilization, and counter resets", () => {
  assert.equal(calculateCpuUsage(null, { idle: 0, total: 100 }), null);
  assert.equal(calculateCpuUsage({ idle: 50, total: 100 }, { idle: 100, total: 200 }), 50);
  assert.equal(calculateCpuUsage({ idle: 0, total: 100 }, { idle: 0, total: 200 }), 100);
  assert.equal(calculateCpuUsage({ idle: 0, total: 100 }, { idle: 100, total: 200 }), 0);
  for (const next of [{ idle: 20, total: 90 }, { idle: 20, total: 200 }, { idle: 500, total: 200 }, { idle: 50, total: 100 }]) {
    assert.equal(calculateCpuUsage({ idle: 50, total: 100 }, next), null);
  }
});

test("process parsing preserves spaced names and multi-core CPU and rejects malformed lines", () => {
  const result = parseProcesses(" 42 250.5 1.2 2048 Rl app with spaces\n 43 3.2 5.1 100 S node\n 44 1.0 0.0 100 R ps\n 0 1.0 0.0 20 S bad\ninvalid\n 45 ... 1 30 S bad");
  assert.equal(result.total, 2);
  assert.equal(result.running, 1);
  assert.equal(result.available, true);
  assert.deepEqual(result.top[0], { pid: 42, name: "app with spaces", cpuPercent: 250.5, memoryPercent: 1.2, rssBytes: 2097152 });
});

test("process results and names are bounded and ties have deterministic order", () => {
  const result = parseProcesses(Array.from({ length: 200 }, (_, i) => `${200 - i} 5.0 1.0 100 S ${"n".repeat(200)}`).join("\n"));
  assert.equal(result.total, 200);
  assert.equal(result.top.length, 6);
  assert.equal(result.top[0]?.pid, 1);
  assert.ok(result.top.every((process) => process.name.length === 128));
});

test("processes are read by name and pid only, and a shared slot lists only its own user's", () => {
  assert.deepEqual(processArgs("machine", 501), ["-eo", "pid=,%cpu=,%mem=,rss=,stat=,comm="]);
  assert.deepEqual(processArgs("user", 80007), ["-U", "80007", "-o", "pid=,%cpu=,%mem=,rss=,stat=,comm="]);
  for (const os of ["linux", "macos"] as const) {
    for (const scope of ["machine", "user"] as const) {
      const script = routeScript(os, scope);
      assert.doesNotMatch(script, /args|command=|cmdline|environ|ps e|-E\b/, `${os} ${scope} reads no argv or environment`);
      assert.equal(script.includes('ps -U "$(id -u)"'), scope === "user");
    }
  }
});

test("network rates use actual elapsed time and reject warmup, resets and interface changes", () => {
  const previous = { interface: "eth0", rxBytes: 100, txBytes: 200 };
  const current = { interface: "eth0", rxBytes: 110, txBytes: 230 };
  assert.deepEqual(calculateNetworkRates(previous, current, 5), { rxBytesPerSecond: 2, txBytesPerSecond: 6 });
  assert.deepEqual(calculateNetworkRates(previous, previous, 5), { rxBytesPerSecond: 0, txBytesPerSecond: 0 });
  const rejected: [typeof previous | null, typeof current, number | null][] = [[null, current, 5], [previous, current, null], [previous, current, 0], [previous, current, -5], [previous, current, NaN], [previous, { ...current, rxBytes: 1 }, 5], [previous, { ...current, txBytes: 1 }, 5], [previous, { ...current, interface: "eth1" }, 5]];
  for (const [prior, next, elapsed] of rejected) assert.deepEqual(calculateNetworkRates(prior, next, elapsed), { rxBytesPerSecond: null, txBytesPerSecond: null });
});

test("long macOS executable paths keep the executable's name", () => {
  const path = `/Applications/${"Nested.app/Contents/Frameworks/".repeat(6)}Helper (Renderer)`;
  assert.equal(parseProcesses(` 7 12.0 1.0 100 S ${path}`, basename).top[0]?.name, "Helper (Renderer)");
});

test("macOS used memory matches Activity Monitor: app memory without purgeable, plus wired and compressed", () => {
  const vmStat = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                  3234357.",
    "Pages inactive:                              2088625.",
    "Pages wired down:                             747197.",
    "Pages purgeable:                               92642.",
    "Anonymous pages:                             3107237.",
    "Pages occupied by compressor:                  83853.",
  ].join("\n");
  assert.equal(parseVmStatUsedBytes(vmStat), (3107237 - 92642 + 747197 + 83853) * 16384);
  assert.equal(parseVmStatUsedBytes("not vm_stat output"), null);
});

test("macOS netstat parsing picks the busiest link and skips loopback and per-address rows", () => {
  const source = [
    "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
    "lo0        16384 <Link#1>                      101130111     0 183408246752 101130111     0 183408246752     0",
    "lo0        16384 127           127.0.0.1       101130111     - 183408246752 101130111     - 183408246752     -",
    "gif0*      1280  <Link#2>                             0     0          0        0     0          0     0",
    "en0        1500  <Link#11>   a0:b1:c2:d3:e4:f5  9000000     0  8000000000  7000000     0  2000000000     0",
    "en0        1500  192.168.1     192.168.1.20     9000000     -  8000000000  7000000     -  2000000000     -",
    "utun3      1380  <Link#20>                       5000     0     400000     6000     0     500000     0",
  ].join("\n");
  assert.deepEqual(parseNetstatLinks(source), { interface: "en0", rxBytes: 8000000000, txBytes: 2000000000 });
  assert.equal(parseNetstatLinks("Name Mtu Network Address\n"), null);
});

test("WSL reads Windows' 64-bit network totals from netsh subinterfaces", () => {
  const output = [
    "",
    "       MTU  MediaSenseState      Bytes In     Bytes Out  Interface",
    "----------  ---------------  ------------  ------------  -------------",
    "4294967295                1             0          1400  Loopback Pseudo-Interface 1",
    "      1500                1    5062009579      33495802  Ethernet",
    "      1500                1        120000          8000  vEthernet (WSL)",
  ].join("\r\n");
  assert.deepEqual(parseWindowsSubinterfaces(output), { interface: "Windows", rxBytes: 5062129579, txBytes: 33503802 }, "64-bit totals past 4 GiB, summed without loopback");
  const german = output.replace("Bytes In     Bytes Out  Interface", "Bytes ein    Bytes aus  Schnittstelle");
  assert.equal(parseWindowsSubinterfaces(german)?.rxBytes, 5062129579, "rows are found without the English header");
  assert.equal(parseWindowsSubinterfaces("The system cannot find the path specified."), null);
});

test("/proc/stat and /proc/net/dev parse to totals and the busiest interface", () => {
  const stat = parseProcStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\ncpu1 50 0 25 400 25 0 0 0 0 0\nintr 1");
  assert.deepEqual(stat?.total, { idle: 850, total: 1000 });
  assert.equal(stat?.perCore.length, 2);
  const dev = "Inter-|   Receive\n face |bytes packets\n    lo: 999999 1 0 0 0 0 0 0 999999 1 0 0 0 0 0 0\n  eth0: 5000 10 0 0 0 0 0 0 7000 10 0 0 0 0 0 0\n";
  assert.deepEqual(parseNetDev(dev), { interface: "eth0", rxBytes: 5000, txBytes: 7000 });
});

const LXC_FILES = {
  "cpu.stat": "usage_usec 9211381\nuser_usec 7362058\nsystem_usec 1849323\nnr_throttled 0\n",
  "cpu.max": "max 100000\n",
  "cpuset.cpus.effective": "40-41\n",
  "memory.current": "2054852608\n",
  "memory.stat": "anon 708665344\nfile 1251098624\ninactive_file 835346432\nactive_file 415629312\n",
  "memory.max": "max\n",
  "memory.swap.current": "0\n",
  "memory.swap.max": "max\n",
  "cpu.pressure": "some avg10=0.17 avg60=0.35 avg300=0.10 total=463946\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=42432\n",
  "memory.pressure": "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
};

test("a container is a namespaced cgroup: its own files have limits, the host's root has none", () => {
  assert.equal(inNamespacedCgroup(LXC_FILES), true);
  assert.equal(inNamespacedCgroup({ "cpu.stat": "usage_usec 1\n", "memory.stat": "anon 1\n" }), false);
  assert.equal(parseContainer({ "cpu.stat": "usage_usec 1\n" }), null);
  assert.equal(parseCpuMax("max 100000"), null);
  assert.equal(parseCpuMax("150000 100000"), 1.5);
  assert.equal(parseCpuList("1,23,32,44-46,53,62"), 8);
  assert.equal(parseCpuList("0-"), null);
  assert.deepEqual(parseStall(LXC_FILES["cpu.pressure"]), [0.17, 0.35, 0.1]);
  assert.equal(parseStall("garbage"), null);
});

test("a Proxmox LXC box's cores come from its cpuset, its memory from its cgroup against LXCFS's total", () => {
  const counters = parseContainer(LXC_FILES)!;
  assert.equal(containerCapacity(counters, 2), 2);
  assert.equal(containerCapacity(counters, 64), 2, "without LXCFS the host's 64 CPUs show, but the cpuset holds 2");
  assert.equal(containerCapacity({ cpuCapacity: 1.5, cpusetCount: 4 }, 64), 1.5);
  const memory = containerMemory(counters, 8 * 1024 ** 3);
  assert.equal(memory.totalBytes, 8 * 1024 ** 3);
  assert.equal(memory.usedBytes, 2054852608 - 835346432, "inactive file cache is not counted as used");
  assert.equal(memory.cachedBytes, 1251098624);
  assert.equal(memory.swapTotalBytes, null);
  assert.equal(containerMemory({ ...counters, memoryLimitBytes: 4 * 1024 ** 3 }, 256 * 1024 ** 3).totalBytes, 4 * 1024 ** 3, "a limit the box can see wins over the host's memory");
});

test("container CPU is its cgroup's usage over the time between readings and its cores", () => {
  assert.equal(containerCpuPercent(null, { usageMicros: 1, at: 1 }, 2), null);
  assert.equal(containerCpuPercent({ usageMicros: 0, at: 0 }, { usageMicros: 2_000_000, at: 5000 }, 2), 20);
  assert.equal(containerCpuPercent({ usageMicros: 5, at: 0 }, { usageMicros: 1, at: 5000 }, 2), null);
  assert.equal(containerCpuPercent({ usageMicros: 0, at: 0 }, { usageMicros: 99_000_000, at: 5000 }, 2), 100);
});

test("the lead's case: a 2-core LXC box at 20% CPU with its host at load 9.22 is healthy, not critical", () => {
  const beacon = assessHealth({ cpuPercent: 20, memoryPercent: 15, diskPercent: 40, load: { fiveMinutes: 9.22, cores: 2 } });
  assert.equal(beacon.status, "critical", "judged by the host's load average, as Beacon did");
  const own = assessHealth({ cpuPercent: 20, memoryPercent: 15, diskPercent: 40, load: null, cpuStall: [0.17, 0.35, 0.1], memoryStall: [0, 0, 0] });
  assert.deepEqual(own, { status: "healthy", issues: [] });
});

test("a container under real pressure says so from its own cgroup", () => {
  const starved = assessHealth({ cpuPercent: 60, memoryPercent: 40, diskPercent: 10, load: null, cpuStall: [70, 55, 30], memoryStall: [12, 11, 4] });
  assert.equal(starved.status, "critical");
  assert.deepEqual(starved.issues.map((issue) => issue.label), ["CPU pressure", "Memory pressure"]);
  assert.match(starved.issues[0]!.message, /Tasks waited for CPU 55\.0% of the last minute/);
});

function cgroupReader(sequence: ContainerCounters[]) {
  let index = 0;
  return async () => sequence[Math.min(index++, sequence.length - 1)]!;
}

test("in a container the collector shows no load average, the cpuset's cores and the cgroup's pressure", async () => {
  const first = parseContainer(LXC_FILES)!;
  const later = { ...first, usageMicros: first.usageMicros + 400_000 };
  const collector = createCollector({ refreshIntervalMs: () => 5000, readContainer: cgroupReader([first, first, later]) });
  const snapshot = snapshotSchema.parse(await collector.collect(new AbortController().signal));
  assert.equal(snapshot.cpu.loadAverage, null);
  assert.equal(snapshot.host.container, true);
  assert.equal(snapshot.cpu.cores, 2);
  assert.deepEqual(snapshot.cpu.stallPercent, [0.17, 0.35, 0.1]);
  assert.ok(!snapshot.health.issues.some((issue) => issue.label === "System load"));
  assert.match(monitorSnapshotText(snapshot), /not shown, as this is a container/);
});

test("outside a container the collector keeps the load average and judges it", async () => {
  const collector = createCollector({ refreshIntervalMs: () => 5000, readContainer: async () => null });
  const snapshot = snapshotSchema.parse(await collector.collect(new AbortController().signal));
  assert.equal(snapshot.cpu.loadAverage?.length, 3);
  assert.equal(snapshot.host.container, undefined);
  assert.equal(snapshot.cpu.stallPercent, null);
  assert.equal(typeof snapshot.cpu.usagePercent, "number", "a fresh baseline measures CPU on the first reading");
});

test("this machine's own cgroup reads, and agrees with what a container should see", async () => {
  const counters = await readContainer(new AbortController().signal);
  if (counters) {
    assert.ok(counters.usageMicros > 0);
    assert.ok(counters.memoryCurrentBytes > 0);
  }
});

test("the background monitor's light sample in a container leaves out the host's load", async () => {
  const first = parseContainer(LXC_FILES)!;
  const sampler = createLightSampler(cgroupReader([first, { ...first, usageMicros: first.usageMicros + 100_000 }]));
  const signal = new AbortController().signal;
  const cold = await sampler.read(signal);
  assert.equal(cold.cpu, null);
  assert.equal(cold.load1, null);
  const warm = await sampler.read(signal);
  assert.equal(typeof warm.cpu, "number");
  assert.ok((warm.memory ?? 0) > 0);
});

function routeOutput(sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([name, body]) => `\n@@bb-box-monitor:${name}\n${body}`)
    .join("");
}

function lxcOutput(uptime: number, usage: number): string {
  return routeOutput({
    uname: "Linux 6.17.13-2-pve x86_64",
    hostname: "glad-coral",
    df: "/dev/loop0 16337788 4000000 11500000 26% /",
    ps: " 1 0.0 0.1 9000 Ss systemd\n 77 12.5 1.0 120000 R node",
    uptime: `${uptime.toFixed(2)} 1.00`,
    stat: "cpu  100 0 50 800 50 0 0 0\ncpu0 50 0 25 400 25 0 0 0\ncpu1 50 0 25 400 25 0 0 0",
    meminfo: "MemTotal:        4194304 kB\nMemFree:         3000000 kB\nMemAvailable:    3500000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB",
    loadavg: "9.22 9.10 8.95 13/8251 1321365",
    netdev: "Inter-|\n face |\n  eth0: 5000 10 0 0 0 0 0 0 7000 10 0 0 0 0 0 0",
    cpuinfo: "model name\t: AMD EPYC 9654",
    ...Object.fromEntries(Object.entries({ ...LXC_FILES, "cpu.stat": `usage_usec ${usage}\n` }).map(([name, body]) => [`cgroup:${name}`, body])),
  });
}

test("a box read through BB Box's route: an LXC box's own CPU, cores and memory, and no host load", () => {
  const collector = createRouteCollector({ os: "linux", scope: "machine", refreshIntervalMs: () => 5000 });
  const first = collector.snapshot({ sections: routeSections(lxcOutput(1000, 9_000_000)), receivedAt: 0 });
  assert.equal(first.cpu.usagePercent, null);
  const second = snapshotSchema.parse(collector.snapshot({ sections: routeSections(lxcOutput(1005, 11_000_000)), receivedAt: 5000 }));
  assert.equal(second.cpu.usagePercent, 20);
  assert.equal(second.cpu.cores, 2);
  assert.equal(second.cpu.loadAverage, null);
  assert.equal(second.host.container, true);
  assert.equal(second.health.status, "healthy");
  assert.equal(second.memory.totalBytes, 4194304 * 1024);
  assert.equal(second.processes.top[0]?.name, "node");
  assert.equal(second.runtime, null);
  assert.equal(second.network?.txBytesPerSecond, 0);
});

test("a Linux VM read through the route keeps its own load average", () => {
  const vm = (idle: number, total: number) => routeOutput({ uname: "Linux 6.8.0 x86_64", hostname: "vm", uptime: "50.00 1.00", stat: `cpu  ${total - idle} 0 0 ${idle} 0 0 0 0\ncpu0 ${total - idle} 0 0 ${idle} 0 0 0 0`, meminfo: "MemTotal: 1000 kB\nMemAvailable: 500 kB", loadavg: "0.50 0.40 0.30 1/2 3", df: "/dev/sda 100 50 50 50% /" });
  const collector = createRouteCollector({ os: "linux", scope: "machine", refreshIntervalMs: () => 5000 });
  collector.snapshot({ sections: routeSections(vm(800, 1000)), receivedAt: 0 });
  const second = collector.snapshot({ sections: routeSections(vm(1600, 2000)), receivedAt: 5000 });
  assert.deepEqual(second.cpu.loadAverage, [0.5, 0.4, 0.3]);
  assert.equal(second.cpu.usagePercent, 20);
  assert.equal(second.memory.usagePercent, 50);
  assert.equal(second.host.container, undefined);
});

test("a shared ios slot read through the route: its own processes, its host's load and memory", () => {
  const output = routeOutput({
    uname: "Darwin 25.1.0 arm64",
    hostname: "slot-host",
    df: "/dev/disk3s1 488245288 300000000 188245288 62% /",
    ps: " 501 30.0 2.0 400000 S /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator\n 502 1.0 0.5 10000 S bb-box-device",
    ncpu: "8",
    memsize: String(32 * 1024 ** 3),
    loadavg: "{ 3.10 2.80 2.50 }",
    boottime: "{ sec = 1790000000, usec = 0 } Mon Oct 26 10:00:00 2026",
    now: "1790003600",
    brand: "Apple M4 Pro",
    vmstat: "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages wired down: 100000.\nPages purgeable: 0.\nAnonymous pages: 400000.\nPages occupied by compressor: 0.",
  });
  const collector = createRouteCollector({ os: "macos", scope: "user", refreshIntervalMs: () => 5000 });
  const snapshot = asSlotReading(collector.snapshot({ sections: routeSections(output), receivedAt: 0 }), { host: "ios-host-1", most: 4, encoder: { usedPercent: 40, words: "On this Mac: 2 of about 5 full-size streams' room in use." } });
  const parsed = snapshotSchema.parse(snapshot);
  assert.deepEqual(parsed.cpu.loadAverage, [3.1, 2.8, 2.5]);
  assert.equal(parsed.cpu.cores, 8);
  assert.equal(parsed.host.uptimeSeconds, 3600);
  assert.equal(parsed.processes.top[0]?.name, "Simulator");
  assert.equal(parsed.processes.total, 2);
  assert.equal(parsed.slot?.host, "ios-host-1");
  assert.equal(parsed.slot?.encoder?.usedPercent, 40);
  assert.deepEqual(parsed.slot?.share, { slots: 4, cores: 2, memoryBytes: 8 * 1024 ** 3 });
  assert.deepEqual(parseMacLoad("{ 1.00 2.00 3.00 }"), [1, 2, 3]);
  assert.equal(parseDfRoot("garbage"), null);
});

test("a shared slot never takes the shared host's load as its own issue, even when its reading has no numbers of its own", () => {
  const snapshot = { cpu: { cores: 8 }, memory: { totalBytes: 32 * 1024 ** 3 }, disk: null, health: { status: "critical", issues: [{ severity: "critical", label: "System load", message: "Five-minute load is 20.00 across 8 cores." }] } } as unknown as MonitorSnapshot;
  const slot = asSlotReading(snapshot, { host: "ios-host-1", most: 4, encoder: null });
  assert.deepEqual(slot.health, { status: "healthy", issues: [] });
});

const SERVER_HOST = "host_server";
const HOSTS: MonitorHost[] = [
  { id: "host_box", name: "glad-coral", connected: true, machineProviderId: "bb-box" },
  { id: "host_mac", name: "laptop", connected: true, machineProviderId: "manual" },
  { id: SERVER_HOST, name: "bb", connected: true, machineProviderId: null },
  { id: "host_gone", name: "old-laptop", connected: false, machineProviderId: "manual" },
  { id: "host_build", name: "build-server", connected: true, machineProviderId: "manual" },
  { id: "host_slot", name: "keen-iris", connected: true, machineProviderId: "bb-box" },
];

const box = (patch: Partial<MonitoredBox> & Pick<MonitoredBox, "id" | "name">): MonitoredBox => ({ ready: true, hostId: null, os: "linux", commands: true, slot: null, ...patch });

const BOXES: MonitoredBox[] = [
  box({ id: "bx_lxc", name: "glad-coral", hostId: "host_box" }),
  box({ id: "bx_docker", name: "calm-reed" }),
  box({ id: "bx_slot", name: "keen-iris", hostId: "host_slot", os: "macos", slot: { host: "ios-host-1", most: 4 } }),
  box({ id: "bx_offline_slot", name: "bold-fern", hostId: "host_away", os: "macos", slot: { host: "ios-host-1", most: 4 } }),
  box({ id: "bx_windows", name: "wide-oak", os: "windows" }),
  box({ id: "bx_stopped", name: "deep-elm", ready: false }),
];

test("lists the server first, then own machines, then boxes, and hides offline machines", () => {
  assert.deepEqual(
    listMachines(HOSTS, SERVER_HOST, BOXES).map(({ id, name, isServer, isBox }) => ({ id, name, isServer, isBox })),
    [
      { id: SERVER_HOST, name: "bb", isServer: true, isBox: false },
      { id: "host_build", name: "build-server", isServer: false, isBox: false },
      { id: "host_mac", name: "laptop", isServer: false, isBox: false },
      { id: "box:bx_offline_slot", name: "bold-fern", isServer: false, isBox: true },
      { id: "box:bx_docker", name: "calm-reed", isServer: false, isBox: true },
      { id: "host_box", name: "glad-coral", isServer: false, isBox: true },
      { id: "host_slot", name: "keen-iris", isServer: false, isBox: true },
    ],
  );
});

test("each machine that is a box names its box, whether it is a BB machine or read through the route; other machines name none", () => {
  assert.deepEqual(
    Object.fromEntries(listMachines(HOSTS, SERVER_HOST, BOXES).map(({ id, boxId }) => [id, boxId])),
    {
      [SERVER_HOST]: null,
      host_build: null,
      host_mac: null,
      "box:bx_offline_slot": "bx_offline_slot",
      "box:bx_docker": "bx_docker",
      host_box: "bx_lxc",
      host_slot: "bx_slot",
    },
  );
});

test("each kind of box takes its path: a BB machine through the host entry, a slot's as its own user, the rest through BB Box's route", async (t) => {
  const hostCalls: { hostId: string; scope: string }[] = [];
  const ranIn: string[] = [];
  const hostEntry = monitorHandlers();
  t.after(() => hostEntry.dispose());
  const reading = await hostEntry.handlers.monitor({ refreshIntervalMs: 5000, force: true });
  const { monitor } = await startTestMonitor(t, {
    deps: {
      hosts: async () => HOSTS,
      serverHostId: async () => SERVER_HOST,
      boxes: async () => BOXES,
      hostSnapshot: async (hostId, input) => {
        hostCalls.push({ hostId, scope: input.scope });
        return reading;
      },
      runInBox: async (boxId) => {
        ranIn.push(boxId);
        return { exitCode: 0, stdout: lxcOutput(1000 + ranIn.length, 9_000_000 + ranIn.length * 100_000) };
      },
      encoderRoom: async (boxId) => (boxId === "bx_slot" ? { usedPercent: 25, words: "On this Mac: 1 of about 4 full-size streams' room in use." } : null),
    },
  });
  await monitor.machine("host_box", false);
  const slot = await monitor.machine("host_slot", false);
  assert.deepEqual(hostCalls, [{ hostId: "host_box", scope: "machine" }, { hostId: "host_slot", scope: "user" }]);
  assert.equal(slot.slot?.host, "ios-host-1");
  assert.equal(slot.slot?.encoder?.usedPercent, 25);
  const routed = await monitor.machine(`${BOX_MACHINE_PREFIX}bx_docker`, false);
  assert.deepEqual(ranIn, ["bx_docker", "bx_docker"], "a cold route reading takes a baseline first");
  assert.equal(routed.cpu.loadAverage, null);
  assert.equal(typeof routed.cpu.usagePercent, "number");
  await monitor.machine(`${BOX_MACHINE_PREFIX}bx_docker`, false);
  assert.equal(ranIn.length, 2, "readers within the interval share the cached reading");
  await assert.rejects(monitor.machine(`${BOX_MACHINE_PREFIX}bx_windows`, false), /cannot read box wide-oak/);
  await assert.rejects(monitor.machine(`${BOX_MACHINE_PREFIX}bx_stopped`, false), /not running/);
});

test("the server reads in process; settings changes reach clients even while a reading is cached", async (t) => {
  const { monitor, setConfig } = await startTestMonitor(t);
  const initial = await monitor.machine(SERVER_MACHINE, false);
  setConfig({ refreshIntervalSeconds: 60 });
  const changed = await monitor.server();
  assert.equal(changed.timestamp, initial.timestamp);
  assert.equal(changed.refreshIntervalMs, 60_000);
  const refreshed = await monitor.server(true);
  assert.equal(refreshed.history.length, 2, "a manual refresh bypasses the shared cache");
});

test("concurrent readers share a bounded snapshot, and the CLI reads the same one", async (t) => {
  const { harness, monitor } = await startTestMonitor(t);
  assert.equal(harness.registrations.services.length, 1);
  assert.equal(monitor.status().enabled, false, "background monitoring is off by default");
  const results = await Promise.all(Array.from({ length: 20 }, () => monitor.server()));
  const snapshot = snapshotSchema.parse(results[0]);
  assert.ok(results.every((result) => result.timestamp === snapshot.timestamp));
  assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.refreshIntervalMs, 5000);
  assert.ok(snapshot.processes.top.length <= 6);
  assert.equal(snapshot.memory.usedBytes + snapshot.memory.availableBytes, snapshot.memory.totalBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 128 * 1024);
  const cli = await harness.behavior.runCli(["monitor", "snapshot", "--json"]);
  assert.equal(cli.exitCode, 0);
  assert.equal(JSON.parse(cli.stdout).timestamp, snapshot.timestamp);
  const health = await harness.behavior.runCli(["monitor", "health", "--json"]);
  assert.equal(health.exitCode, 0);
  assert.ok(["healthy", "warning", "critical"].includes(JSON.parse(health.stdout).status));
  assert.equal(harness.realtimeSignals.length, 0);
});

test("the host entry returns a valid reading, keeps CPU history between calls, and reports a new interval from its cache", async () => {
  const { handlers, dispose } = monitorHandlers();
  try {
    const first = snapshotSchema.parse(await handlers.monitor({ refreshIntervalMs: 5000, force: true }));
    const second = await handlers.monitor({ refreshIntervalMs: 5000, force: true });
    assert.equal(first.refreshIntervalMs, 5000);
    assert.ok(second.history.length >= 2);
    const cached = await handlers.monitor({ refreshIntervalMs: 60_000, force: false });
    assert.equal(cached.refreshIntervalMs, 60_000);
    const own = snapshotSchema.parse(await handlers.monitor({ refreshIntervalMs: 5000, force: true, scope: "user" }));
    assert.equal(own.processes.available, true);
    assert.equal(own.battery, null, "a shared slot's reading starts no battery or sensors read");
    assert.equal(own.sensors, null);
  } finally {
    await dispose();
  }
});

test("the bb server's host ID is looked up once, not on every poll", async (t) => {
  let lookups = 0;
  const { monitor } = await startTestMonitor(t, {
    deps: {
      hosts: async () => HOSTS,
      serverHostId: (() => {
        let found: Promise<string> | null = null;
        return () => {
          if (!found) {
            lookups++;
            found = Promise.resolve(SERVER_HOST);
          }
          return found;
        };
      })(),
    },
  });
  await monitor.machines();
  await monitor.machines();
  assert.equal(lookups, 1);
});

test("off, nothing of the Monitor runs: no readings, no machines, no background monitoring, and the CLI says so", async (t) => {
  const reads: number[] = [];
  const { harness, monitor, setConfig } = await startTestMonitor(t, {
    config: { enabled: false, backgroundMonitoring: true },
    deps: {
      hosts: async () => HOSTS,
      lightSampler: {
        read: async () => {
          reads.push(Date.now());
          return { cpu: 1, memory: 1, load1: 0, rssBytes: 1, heapUsedBytes: 1, availableBytes: 1, totalBytes: 2 };
        },
        reset: () => undefined,
      },
    },
  });
  const service = harness.behavior.runService("monitor");
  t.after(async () => {
    service.controller.abort();
    await service.done;
  });
  await flush();
  await assert.rejects(monitor.server(), MonitorOffError);
  await assert.rejects(monitor.machine("host_mac", false), MonitorOffError);
  assert.deepEqual(await monitor.machines(), []);
  assert.equal(monitor.status().enabled, false);
  assert.deepEqual(reads, [], "the background monitor never sampled");
  assert.equal((await harness.behavior.runCli(["monitor", "snapshot"])).exitCode, 1);
  assert.equal((await harness.behavior.runCli(["monitor", "health"])).exitCode, 1);
  const handlers = monitorRpcHandlers(monitor);
  assert.deepEqual(await handlers["monitor.state"](), { enabled: false, backgroundMonitoring: true, pressureNotifications: true, boxHistory: true, historyFull: null });
  setConfig({ enabled: true });
  await flush();
  assert.equal(reads.length, 1, "turning it on starts background monitoring, which was asked for");
  assert.equal(monitor.status().enabled, true);
  setConfig({ enabled: false });
  assert.equal(monitor.status().enabled, false);
});

test("the Monitor's settings live in the configuration document, with Beacon's defaults and bounds", () => {
  assert.deepEqual(monitorConfig({}), { enabled: true, refreshIntervalSeconds: 5, backgroundMonitoring: false, pressureNotifications: true, boxHistory: true });
  assert.deepEqual(MONITOR_DEFAULTS, { enabled: true, refreshIntervalSeconds: 5, backgroundMonitoring: false, pressureNotifications: true, boxHistory: true });
  const ok = readDraft({ monitor: { enabled: false, refreshIntervalSeconds: 2, backgroundMonitoring: true, pressureNotifications: false, boxHistory: false } }, DRIVERS);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.document.monitor, { enabled: false, refreshIntervalSeconds: 2, backgroundMonitoring: true, pressureNotifications: false, boxHistory: false });
  for (const [monitor, path] of [[{ refreshIntervalSeconds: 1 }, "monitor.refreshIntervalSeconds"], [{ refreshIntervalSeconds: 61 }, "monitor.refreshIntervalSeconds"], [{ refreshIntervalSeconds: 2.5 }, "monitor.refreshIntervalSeconds"], [{ enabled: "yes" }, "monitor.enabled"], [{ boxHistory: "on" }, "monitor.boxHistory"], [{ colour: true }, "monitor.colour"], ["on", "monitor"]] as const) {
    assert.deepEqual(readDraft({ monitor }, DRIVERS).problems.map((problem) => problem.path), [path]);
  }
  assert.equal(readDraft({}, DRIVERS).document.monitor, undefined);
});

test("the doctor shows the Monitor's settings, and warns when background monitoring has stopped writing", () => {
  const now = 10_000_000;
  assert.match(monitorChecks({ ...MONITOR_DEFAULTS }, [], now)[0]!.detail, /^On\. Machine status reads every 5 s while it is open\. Background monitoring is off\. Box history is on\.$/);
  assert.match(monitorChecks({ ...MONITOR_DEFAULTS, enabled: false }, [], now)[0]!.detail, /^Off: /);
  const on = { ...MONITOR_DEFAULTS, backgroundMonitoring: true };
  assert.equal(monitorChecks(on, [{ type: "summary", timestamp: now - 60_000 }], now)[1]?.status, "ok");
  assert.equal(monitorChecks(on, [{ type: "summary", timestamp: now - 600_000 }], now)[1]?.status, "warn");
  assert.equal(monitorChecks(on, [{ type: "summary", timestamp: now - 60_000 }, { type: "error", timestamp: now - 30_000 }], now)[1]?.status, "warn");
  assert.equal(monitorChecks(on, [], now)[1]?.status, "warn");
});
