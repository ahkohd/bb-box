import "./check-test-machine.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOwnUsage, developerToolsLook, MAC_OWN_READER, macOwnCommand, NATIVE_MARK, parseCpuTime, parseOwnReading, psOwnArgs, readMacOwn, RUSAGE_V2_BYTES, type OwnProcess, type OwnReading } from "../src/monitor/own-usage.ts";
import { createRouteCollector, routeScript, routeSections } from "../src/monitor/route.ts";
import { asSlotReading, slotShare } from "../src/plugin/monitor.ts";
import { snapshotSchema, type MonitorSnapshot } from "../src/monitor/snapshot.ts";

const proc = (pid: number, ppid: number | null, selfSeconds: number, childSeconds = 0, started = `s${pid}`): OwnProcess => ({ pid, started, ppid, selfSeconds, childSeconds, memoryBytes: 10 * 1024 ** 2 });
const native = (...rows: OwnProcess[]): OwnReading => ({ mode: "with-children", rows });
const selfOnly = (...rows: OwnProcess[]): OwnReading => ({ mode: "self-only", rows });

test("reads ps's CPU times in macOS's and Linux's forms", () => {
  assert.equal(parseCpuTime("0:01.23"), 1.23);
  assert.equal(parseCpuTime("12:34.50"), 754.5);
  assert.equal(parseCpuTime("1:02:03.00"), 3723);
  assert.equal(parseCpuTime("00:00:07"), 7);
  assert.equal(parseCpuTime("2-01:00:00"), 2 * 86_400 + 3600);
  assert.equal(parseCpuTime("garbage"), null);
});

test("a reading says which counters it has: the Mac reader's own time and its children's, or ps's own time alone, each process known by its PID and start", () => {
  assert.deepEqual(parseOwnReading(`${NATIVE_MARK}\n4867 1 12.500 3.000 124928 98765432100\n4868 -1 2.000 0.000 0 98765432200\nbad line`), {
    mode: "with-children",
    rows: [
      { pid: 4867, ppid: 1, selfSeconds: 12.5, childSeconds: 3, memoryBytes: 122 * 1024 ** 2, started: "98765432100" },
      { pid: 4868, ppid: null, selfSeconds: 2, childSeconds: 0, memoryBytes: 0, started: "98765432200" },
    ],
  });
  assert.deepEqual(parseOwnReading("  501     1   0:01.50  20480 Thu Oct 30 05:01:47 2026\nbad"), {
    mode: "self-only",
    rows: [{ pid: 501, ppid: 1, selfSeconds: 1.5, childSeconds: 0, memoryBytes: 20 * 1024 ** 2, started: "Thu Oct 30 05:01:47 2026" }],
  });
});

test("the Mac reader gives proc_pid_rusage the whole 160-byte rusage_info_v2, checks a canary after it, and prints nothing unless every read was whole", () => {
  assert.equal(RUSAGE_V2_BYTES, 160);
  const fields = /F = "([^"]+)"\.split\(\)/.exec(MAC_OWN_READER)?.[1]?.split(" ") ?? [];
  assert.equal(16 + fields.length * 8, RUSAGE_V2_BYTES, "a 16-byte UUID, then 18 64-bit counters");
  assert.deepEqual(fields.slice(-8), ["cuser", "csystem", "cidle", "cintr", "cpageins", "celapsed", "dread", "dwrite"]);
  assert.match(MAC_OWN_READER, /if ctypes\.sizeof\(R\) != 224 or R\.g\.offset != 160: raise SystemExit\(3\)/);
  assert.match(MAC_OWN_READER, /memset\(ctypes\.addressof\(r\) \+ 160, 165, 64\)/);
  assert.match(MAC_OWN_READER, /if bytes\(r\.g\) != bytes\(\[165\]\) \* 64: raise SystemExit\(4\)/);
  assert.ok(MAC_OWN_READER.indexOf("SystemExit(4)") < MAC_OWN_READER.indexOf("print("), "it prints once, at the end");
  assert.match(MAC_OWN_READER, /proc_pid_rusage\(pid, 2,/);
  assert.match(MAC_OWN_READER, /else -1/, "a zombie, which proc_pidinfo does not answer for, is kept with no parent");
  assert.match(MAC_OWN_READER, /r\.start\)\)$/m);
  assert.doesNotMatch(MAC_OWN_READER, /'/, "it sits in single quotes in the route's shell");
});

test("the Mac reader runs only behind xcode-select -p, and ps, with each process's start, is the fallback", () => {
  assert.match(macOwnCommand(), /^\{ xcode-select -p >\/dev\/null 2>&1 && \/usr\/bin\/python3 -c '.*' 2>\/dev\/null; \} \|\| LC_ALL=C ps -U "\$\(id -u\)" -o pid=,ppid=,time=,rss=,lstart=$/s);
  assert.deepEqual(psOwnArgs(1000), ["-U", "1000", "-o", "pid=,ppid=,time=,rss=,lstart="]);
  assert.match(routeScript("macos", "user"), /proc_pid_rusage/);
  assert.match(routeScript("linux", "user"), /ps -U "\$\(id -u\)" -o pid=,ppid=,time=,rss=,lstart=/);
  assert.doesNotMatch(routeScript("macos", "machine"), /proc_pid_rusage/);
});

test("on a Mac without the command line tools, /usr/bin/python3 is never run, as its shim would ask on the Mac's screen to install them; ps is read instead", async () => {
  const ran: string[] = [];
  const run = (there: boolean) => async (file: string, args: readonly string[]) => {
    ran.push(`${file} ${args[0] ?? ""}`);
    if (file === "xcode-select" && !there) throw new Error("exit code 2");
    return file === "ps" ? "ps" : file === "xcode-select" ? "/Library/Developer/CommandLineTools" : "python";
  };
  let clock = 0;
  const without = run(false);
  const toolsMissing = developerToolsLook(without, () => clock);
  assert.equal(await readMacOwn(without, 501, toolsMissing), "ps");
  assert.equal(await readMacOwn(without, 501, toolsMissing), "ps");
  assert.deepEqual(ran, ["xcode-select -p", "ps -U", "ps -U"], "the tools are looked for once, and python3 never runs");
  ran.length = 0;
  clock = 11 * 60_000;
  await readMacOwn(without, 501, toolsMissing);
  assert.deepEqual(ran, ["xcode-select -p", "ps -U"], "looked for again after 10 minutes");
  ran.length = 0;
  const withTools = run(true);
  assert.equal(await readMacOwn(withTools, 501, developerToolsLook(withTools)), "python");
  assert.deepEqual(ran, ["xcode-select -p", "/usr/bin/python3 -c"]);
});

test("a slot's CPU is the CPU time its own processes used between two readings, over the time between them", () => {
  const meter = createOwnUsage();
  assert.deepEqual(meter.take(native(proc(10, 1, 100), proc(11, 10, 5)), 0), { cpuCores: null, memoryBytes: 20 * 1024 ** 2, processes: 2 });
  assert.equal(meter.take(native(proc(10, 1, 104), proc(11, 10, 11)), 5000).cpuCores, 2);
});

test("a build's compilers that exit between readings count once: their time before is taken from what their parent's children's time grew by", () => {
  const meter = createOwnUsage();
  meter.take(native(proc(10, 1, 50), proc(20, 10, 1), proc(30, 20, 2), proc(31, 20, 3)), 0);
  assert.equal(meter.take(native(proc(10, 1, 50), proc(20, 10, 2, 4 + 6)), 2000).cpuCores, (1 + 2 + 3) / 2);
  assert.equal(meter.take(native(proc(10, 1, 50, 12)), 4000).cpuCores, 0);
});

test("a build service its tool did not wait for leaves with its time; it takes no more than what its waiter's children's time grew by, and only for one reading (G2)", () => {
  const meter = createOwnUsage();
  meter.take(native(proc(10, 1, 5), proc(20, 10, 0.5), proc(30, 20, 5, 15)), 0);
  assert.equal(meter.take(native(proc(10, 1, 7, 1), proc(40, 10, 2)), 5000).cpuCores, (2 + 2) / 5, "the tool's last half second is lost with the service's 20 s, never more");
  assert.equal(meter.take(native(proc(10, 1, 7, 2), proc(40, 10, 3)), 10_000).cpuCores, 1 / 5, "what is still owed takes a second child's time once");
  assert.equal(meter.take(native(proc(10, 1, 7, 7), proc(40, 10, 4)), 15_000).cpuCores, (5 + 1) / 5, "then it lapses");
});

test("a zombie waited for late counts its time once, and so does one never seen alive", () => {
  const meter = createOwnUsage();
  meter.take(native(proc(10, 1, 1), proc(20, 10, 10)), 0);
  assert.equal(meter.take(native(proc(10, 1, 1), proc(20, null, 12)), 5000).cpuCores, 2 / 5, "a zombie answers proc_pid_rusage but not proc_pidinfo, and keeps the parent it had");
  assert.equal(meter.take(native(proc(10, 1, 1)), 10_000).cpuCores, 0, "its parent has not waited yet: nothing is owed twice");
  assert.equal(meter.take(native(proc(10, 1, 1, 12)), 15_000).cpuCores, 0, "the wait comes a reading late and settles what it owed");
  const unseen = createOwnUsage();
  unseen.take(native(proc(10, 1, 1)), 0);
  assert.equal(unseen.take(native(proc(10, 1, 1), proc(21, null, 3)), 5000).cpuCores, 0, "a zombie with no known parent waits to be counted with its parent");
  assert.equal(unseen.take(native(proc(10, 1, 1, 3)), 10_000).cpuCores, 3 / 5);
});

test("a reused PID is a new process, whether its counter is lower or higher than the old one's", () => {
  const lower = createOwnUsage();
  lower.take(native(proc(10, 1, 1), proc(20, 10, 10, 0, "early")), 0);
  assert.equal(lower.take(native(proc(10, 1, 1, 10), proc(20, 10, 1, 0, "later")), 5000).cpuCores, 0.2);
  const higher = createOwnUsage();
  higher.take(native(proc(10, 1, 1), proc(20, 10, 10, 0, "early")), 0);
  assert.equal(higher.take(native(proc(10, 1, 1, 10), proc(20, 10, 12, 0, "later")), 5000).cpuCores, 12 / 5);
});

test("a debt nobody settles lapses after two readings, so a parent's later children count", () => {
  const meter = createOwnUsage();
  meter.take(native(proc(10, 1, 1), proc(20, 10, 30)), 0);
  assert.equal(meter.take(native(proc(10, 1, 1)), 5000).cpuCores, 0);
  assert.equal(meter.take(native(proc(10, 1, 1)), 10_000).cpuCores, 0);
  assert.equal(meter.take(native(proc(10, 1, 1, 5)), 15_000).cpuCores, 1);
});

test("with ps's own times alone, an exited child takes nothing from its parent's new time", () => {
  const meter = createOwnUsage();
  meter.take(selfOnly(proc(10, 1, 10), proc(20, 10, 50)), 0);
  assert.equal(meter.take(selfOnly(proc(10, 1, 15)), 5000).cpuCores, 1);
});

test("a change between the Mac reader and ps starts a new baseline, never a spike", () => {
  const meter = createOwnUsage();
  meter.take(native(proc(10, 1, 10, 100)), 0);
  assert.equal(meter.take(selfOnly(proc(10, 1, 11)), 5000).cpuCores, null);
  assert.equal(meter.take(selfOnly(proc(10, 1, 12)), 10_000).cpuCores, 0.2);
  assert.equal(meter.take(native(proc(10, 1, 13, 100)), 15_000).cpuCores, null);
  assert.equal(meter.take(native(proc(10, 1, 14, 100)), 20_000).cpuCores, 0.2);
  meter.reset();
  assert.equal(meter.take(native(proc(10, 1, 15, 100)), 25_000).cpuCores, null);
});

function macOutput(sections: Record<string, string>): string {
  return Object.entries(sections).map(([name, text]) => `\n@@bb-box-monitor:${name}\n${text}`).join("");
}

const MAC = {
  uname: "Darwin 25.1.0 arm64",
  hostname: "slot-host",
  df: "/dev/disk3s1 488245288 300000000 188245288 62% /",
  ps: " 501 30.0 2.0 400000 S /Applications/Simulator.app/Contents/MacOS/Simulator",
  ncpu: "12",
  memsize: String(36 * 1024 ** 3),
  loadavg: "{ 9.10 8.80 8.50 }",
  boottime: "{ sec = 1790000000, usec = 0 }",
  now: "1790003600",
  brand: "Apple M4 Pro",
  vmstat: "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages wired down: 100000.\nAnonymous pages: 400000.\nPages occupied by compressor: 0.",
};

test("G1: a slot read through its route uses 2 of its 4 cores' share of a 12-core Mac with 3 slots: about 50%, not 17%", () => {
  const collector = createRouteCollector({ os: "macos", scope: "user", refreshIntervalMs: () => 5000 });
  collector.snapshot({ sections: routeSections(macOutput({ ...MAC, own: `${NATIVE_MARK}\n600 1 10.000 0.000 1572864 7001\n601 600 0.000 0.000 0 7002` })), receivedAt: 0 });
  const read = collector.snapshot({ sections: routeSections(macOutput({ ...MAC, own: `${NATIVE_MARK}\n600 1 15.000 0.000 1572864 7001\n601 600 5.000 0.000 0 7002` })), receivedAt: 5000 });
  const slot = snapshotSchema.parse(asSlotReading(read, { host: "mac-1", most: 3, encoder: null }));
  assert.deepEqual(slot.slot?.share, { slots: 3, cores: 4, memoryBytes: 12 * 1024 ** 3 });
  assert.equal(slot.own?.cpuCores, 2);
  assert.equal(slot.own?.memoryBytes, 1.5 * 1024 ** 3);
  assert.equal(slot.history.at(-1)?.ownCpuCores, 2);
  assert.equal(((slot.own!.cpuCores! / slot.slot!.share!.cores) * 100).toFixed(0), "50");
});

const BUSY_MAC = { cpu: { cores: 12, usagePercent: 90, loadAverage: [14, 13, 12] }, memory: { totalBytes: 36 * 1024 ** 3, usagePercent: 92 }, disk: { usagePercent: 40 }, health: { status: "critical", issues: [{ severity: "critical", label: "System load", message: "Five-minute load is 13.00 across 12 cores." }] } };

test("G1: the Mac busy from other slots leaves a calm slot healthy; a slot over its share is judged by its own numbers", () => {
  const calm = asSlotReading({ ...BUSY_MAC, own: { cpuCores: 0.2, memoryBytes: 1024 ** 3, processes: 4 } } as unknown as MonitorSnapshot, { host: "mac-1", most: 3, encoder: null });
  assert.equal(calm.health.status, "healthy");
  const busy = asSlotReading({ ...BUSY_MAC, own: { cpuCores: 3.9, memoryBytes: 1024 ** 3, processes: 4 } } as unknown as MonitorSnapshot, { host: "mac-1", most: 3, encoder: null });
  assert.equal(busy.health.status, "critical");
  assert.equal(busy.health.issues[0]?.label, "CPU");
  assert.deepEqual(slotShare(BUSY_MAC as unknown as MonitorSnapshot, 0), { slots: 1, cores: 12, memoryBytes: 36 * 1024 ** 3 });
});

test("a slot whose own reading failed is not judged on the busy Mac: its CPU and memory are unread, and only the disk it shares can warn", () => {
  const unread = asSlotReading({ ...BUSY_MAC, own: null } as unknown as MonitorSnapshot, { host: "mac-1", most: 3, encoder: null });
  assert.deepEqual(unread.health, { status: "healthy", issues: [] });
  const fullDisk = asSlotReading({ ...BUSY_MAC, disk: { usagePercent: 97 } } as unknown as MonitorSnapshot, { host: "mac-1", most: 3, encoder: null });
  assert.deepEqual(fullDisk.health.issues.map((issue) => issue.label), ["Disk"]);
});
