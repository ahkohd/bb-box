import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { parseArgs } from "node:util";
import { GrpcClient } from "../../../src/device/grpc.ts";
import { streamOutput } from "../../../src/device/idb.ts";
import { encode } from "../../../src/device/protobuf.ts";
import { GRPC_METHODS, IDB_SCHEMA } from "../../../src/device/schemas.ts";

const { values } = parseArgs({
  options: {
    targets: { type: "string" },
    seconds: { type: "string", default: "30" },
    gap: { type: "string", default: "1000" },
    warm: { type: "string", default: "4" },
    point: { type: "string", default: "201,600" },
    "start-at": { type: "string" },
    sample: { type: "boolean", default: false },
    label: { type: "string", default: "run" },
    out: { type: "string", default: "/tmp/multi.json" },
    raw: { type: "string" },
    scale: { type: "string", default: "1" },
  },
});

interface Target {
  readonly name: string;
  readonly udid: string;
  readonly socket: string;
}

interface Frame {
  readonly at: number;
  readonly bytes: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = Number(values.seconds);
const gapMs = Number(values.gap);
const [pointX, pointY] = values.point!.split(",").map(Number) as [number, number];
const targets: Target[] = values.targets ? JSON.parse(readFileSync(values.targets, "utf8")) : [];

function run(program: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => execFile(program, args, { maxBuffer: 64 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout))));
}

function cpuSeconds(text: string): number {
  const parts = text.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly user: string;
  readonly cpu: number;
  readonly rssKiB: number;
  readonly command: string;
}

async function processes(): Promise<Map<number, Proc>> {
  const text = await run("ps", ["-A", "-o", "pid=,ppid=,user=,time=,rss=,command="]);
  const table = new Map<number, Proc>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    table.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), user: match[3]!, cpu: cpuSeconds(match[4]!), rssKiB: Number(match[5]), command: match[6]! });
  }
  return table;
}

function deviceTrees(table: Map<number, Proc>): Map<string, Set<number>> {
  const children = new Map<number, number[]>();
  for (const proc of table.values()) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid]);
  const trees = new Map<string, Set<number>>();
  for (const proc of table.values()) {
    const udid = proc.command.startsWith("launchd_sim") ? proc.command.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/)?.[0] : undefined;
    if (!udid) continue;
    const members = new Set<number>();
    const stack = [proc.pid];
    while (stack.length) {
      const pid = stack.pop()!;
      members.add(pid);
      stack.push(...(children.get(pid) ?? []));
    }
    trees.set(udid, members);
  }
  return trees;
}

function shortName(command: string): string {
  const program = command.split(" ")[0]!;
  return program.split("/").pop()!;
}

async function memory(): Promise<Record<string, unknown>> {
  const [pressure, swap, vmStat] = await Promise.all([run("memory_pressure", ["-Q"]), run("sysctl", ["-n", "vm.swapusage"]), run("vm_stat", [])]);
  const page = Number(vmStat.match(/page size of (\d+)/)?.[1] ?? 16384);
  const pages = (name: string) => Number(vmStat.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? 0);
  const gib = (count: number) => Math.round(((count * page) / 2 ** 30) * 100) / 100;
  return {
    freePercent: Number(pressure.match(/free percentage: (\d+)%/)?.[1] ?? NaN),
    swapUsedMiB: Number(swap.match(/used = ([\d.]+)M/)?.[1] ?? NaN),
    freeGiB: gib(pages("Pages free")),
    activeGiB: gib(pages("Pages active")),
    inactiveGiB: gib(pages("Pages inactive")),
    wiredGiB: gib(pages("Pages wired down")),
    compressorGiB: gib(pages("Pages occupied by compressor")),
    swapins: pages("Swapins"),
    swapouts: pages("Swapouts"),
  };
}

async function gpuUtilisation(): Promise<number | null> {
  const text = await run("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]);
  const found = text.match(/"Device Utilization %"=(\d+)/) ?? text.match(/"In use system memory"=(\d+)/);
  if (!found) return null;
  return found[0].includes("Utilization") ? Number(found[1]) : Math.round(Number(found[1]) / 2 ** 20);
}

function topCpu(text: string): Record<string, number> | null {
  const lines = [...text.matchAll(/CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/g)];
  const last = lines.at(-1);
  return last ? { user: Number(last[1]), sys: Number(last[2]), idle: Number(last[3]) } : null;
}

function median(list: readonly number[]): number {
  if (!list.length) return NaN;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

function percentile(list: readonly number[], share: number): number {
  if (!list.length) return NaN;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]!;
}

async function* videoStream(client: GrpcClient, stopped: Promise<void>, signal: AbortSignal) {
  async function* requests() {
    yield encode(IDB_SCHEMA, "idb.VideoStreamRequest", { start: { format: 0, compression_quality: 0.2, scale_factor: Number(values.scale) } });
    await stopped;
    yield encode(IDB_SCHEMA, "idb.VideoStreamRequest", { stop: {} });
  }
  for await (const message of client.call(GRPC_METHODS.idb.videoStream, requests(), { signal })) yield streamOutput(message);
}

const press = (direction: number) => encode(IDB_SCHEMA, "idb.HIDEvent", { press: { action: { touch: { point: { x: pointX, y: pointY } } }, direction } });

async function tap(client: GrpcClient): Promise<void> {
  for await (const _ of client.call(GRPC_METHODS.idb.hid, [press(0), press(1)])) void _;
}

interface Watch {
  readonly target: Target;
  readonly client: GrpcClient;
  readonly frames: Frame[];
  readonly taps: number[];
  readonly errors: string[];
  stop: () => void;
  ended: Promise<void>;
}

function watch(target: Target): Watch {
  const client = new GrpcClient({ socket: target.socket });
  const frames: Frame[] = [];
  const errors: string[] = [];
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const controller = new AbortController();
  let file: WriteStream | null = null;
  if (values.raw) {
    mkdirSync(values.raw, { recursive: true });
    file = createWriteStream(`${values.raw}/${target.name}.h264`);
  }
  const ended = (async () => {
    try {
      for await (const output of videoStream(client, stopped, controller.signal)) {
        if (!output.data) continue;
        frames.push({ at: performance.now(), bytes: output.data.byteLength });
        file?.write(output.data);
      }
    } catch (error) {
      errors.push(`stream: ${(error as Error).message}`);
    }
    file?.end();
  })();
  return { target, client, frames, taps: [], errors, stop: () => { stop(); setTimeout(() => controller.abort(), 1000); }, ended };
}

function tapResults(frames: readonly Frame[], taps: readonly number[]) {
  const delays: number[] = [];
  let missed = 0;
  for (const sent of taps) {
    const before = frames.filter((frame) => frame.at < sent && frame.at > sent - 2000).map((frame) => frame.bytes);
    const threshold = Math.max(4 * median(before.length ? before : [10_000]), 60_000);
    const changed = frames.find((frame) => frame.at >= sent && frame.bytes >= threshold && frame.at - sent < 3000);
    if (changed) delays.push(changed.at - sent);
    else missed++;
  }
  const around = taps.slice(0, 6).map((sent) => frames.filter((frame) => frame.at >= sent - 50 && frame.at < sent + 400).map((frame) => `${Math.round(frame.at - sent)}:${Math.round(frame.bytes / 1000)}k`).join(" "));
  return { around, taps: taps.length, missed, medianMs: Math.round(median(delays)), p95Ms: Math.round(percentile(delays, 0.95)), worstMs: Math.round(Math.max(...delays)), delaysMs: delays.map(Math.round) };
}

function frameResults(frames: readonly Frame[], from: number, to: number) {
  const inside = frames.filter((frame) => frame.at >= from && frame.at < to);
  const gaps = inside.slice(1).map((frame, index) => frame.at - inside[index]!.at);
  const bytes = inside.reduce((total, frame) => total + frame.bytes, 0);
  return { fps: Math.round((inside.length / ((to - from) / 1000)) * 10) / 10, gapP95Ms: Math.round(percentile(gaps, 0.95)), gapWorstMs: Math.round(Math.max(...gaps)), mbitPerSecond: Math.round(((bytes * 8) / ((to - from) / 1000) / 1e6) * 10) / 10 };
}

async function main(): Promise<void> {
  if (values["start-at"]) await wait(Math.max(0, Number(values["start-at"]) - Date.now()));
  const watches = targets.map(watch);
  const firstFrameBy = performance.now() + 15_000;
  for (const each of watches) while (!each.frames.length && performance.now() < firstFrameBy) await wait(10);
  for (const each of watches) for (let index = 0; index < 2; index++) {
    await tap(each.client).catch((error) => each.errors.push(`warm tap: ${error.message}`));
    await wait(300);
  }
  await wait(Number(values.warm) * 1000);

  const sampling = values.sample;
  const before = sampling ? await processes() : null;
  const memoryBefore = sampling ? await memory() : null;
  const top = sampling ? new Promise<string>((resolve) => {
    const child = spawn("top", ["-l", "2", "-s", String(seconds), "-n", "0"]);
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("close", () => resolve(text));
  }) : Promise.resolve("");
  const gpu: number[] = [];
  const from = performance.now();
  const until = from + seconds * 1000;
  const gpuSampler = sampling ? (async () => {
    while (performance.now() < until) {
      const value = await gpuUtilisation();
      if (value !== null) gpu.push(value);
      await wait(2000);
    }
  })() : Promise.resolve();

  const tappers = watches.map(async (each, index) => {
    await wait((gapMs / Math.max(1, watches.length)) * index);
    while (performance.now() + gapMs < until) {
      const sent = performance.now();
      try {
        await tap(each.client);
        each.taps.push(sent);
      } catch (error) {
        each.errors.push(`tap: ${(error as Error).message}`);
      }
      await wait(Math.max(0, gapMs - (performance.now() - sent)));
    }
  });
  await Promise.all(tappers);
  while (performance.now() < until) await wait(20);
  const to = performance.now();
  await gpuSampler;
  const after = sampling ? await processes() : null;
  const memoryAfter = sampling ? await memory() : null;
  const topText = await top;

  const devices = watches.map((each) => ({ name: each.target.name, udid: each.target.udid, ...frameResults(each.frames, from, to), tap: tapResults(each.frames, each.taps), errors: each.errors }));

  let processesSummary: Record<string, unknown> | null = null;
  if (before && after) {
    const window = (to - from) / 1000;
    const used = (pid: number) => {
      const end = after.get(pid);
      const start = before.get(pid);
      return end ? Math.max(0, end.cpu - (start?.cpu ?? 0)) : 0;
    };
    const trees = deviceTrees(after);
    const inTree = new Set<number>();
    const perDevice: Record<string, unknown> = {};
    for (const [udid, members] of trees) {
      let cpu = 0;
      let rss = 0;
      for (const pid of members) {
        inTree.add(pid);
        cpu += used(pid);
        rss += after.get(pid)?.rssKiB ?? 0;
      }
      const companion = [...after.values()].find((proc) => proc.command.includes("idb_companion") && proc.command.includes(udid));
      perDevice[udid] = {
        processes: members.size,
        cores: Math.round((cpu / window) * 1000) / 1000,
        rssMiB: Math.round(rss / 1024),
        companionCores: companion ? Math.round((used(companion.pid) / window) * 1000) / 1000 : null,
        companionRssMiB: companion ? Math.round(companion.rssKiB / 1024) : null,
        user: after.get([...members][0]!)?.user,
      };
    }
    const others = new Map<string, { cores: number; rssMiB: number; count: number }>();
    let totalCpu = 0;
    for (const proc of after.values()) {
      const cpu = used(proc.pid);
      totalCpu += cpu;
      if (inTree.has(proc.pid)) continue;
      const name = shortName(proc.command);
      const entry = others.get(name) ?? { cores: 0, rssMiB: 0, count: 0 };
      entry.cores += cpu / window;
      entry.rssMiB += proc.rssKiB / 1024;
      entry.count += 1;
      others.set(name, entry);
    }
    const busiest = [...others.entries()].sort((a, b) => b[1].cores - a[1].cores).slice(0, 15).map(([name, entry]) => ({ name, cores: Math.round(entry.cores * 1000) / 1000, rssMiB: Math.round(entry.rssMiB), count: entry.count }));
    processesSummary = { windowSeconds: Math.round(window * 10) / 10, summedCores: Math.round((totalCpu / window) * 100) / 100, perDevice, busiest };
  }

  const result = {
    label: values.label,
    at: new Date().toISOString(),
    seconds,
    gapMs,
    devices,
    vm: sampling ? { top: topCpu(topText), gpuUtilisation: gpu, memoryBefore, memoryAfter, processes: processesSummary } : null,
  };
  for (const each of watches) each.stop();
  await Promise.race([Promise.all(watches.map((each) => each.ended)), wait(3000)]);
  for (const each of watches) each.client.close();
  if (values.raw) for (const each of watches) writeFileSync(`${values.raw}/${each.target.name}.times.json`, JSON.stringify({ scale: Number(values.scale), epochAtZero: Date.now() - performance.now(), from, to, frames: each.frames.map((frame) => Math.round(frame.at * 10) / 10), taps: each.taps.map((at) => Math.round(at * 10) / 10) }));
  writeFileSync(values.out!, `${JSON.stringify(result, null, 1)}\n`);
  for (const device of devices) console.log(`${values.label} ${device.name}: ${device.fps} fps, ${device.mbitPerSecond} Mbit/s, gap p95 ${device.gapP95Ms} ms worst ${device.gapWorstMs} ms, ${device.tap.taps} taps${device.errors.length ? `, errors ${device.errors.join("; ")}` : ""}`);
  if (result.vm) {
    const top = result.vm.top;
    console.log(`${values.label} vm: cpu ${top ? `${top.user}% user ${top.sys}% sys ${top.idle}% idle` : "?"}, summed ${processesSummary?.summedCores} cores, gpu ${gpu.join(",")}, free ${(result.vm.memoryAfter as { freePercent: number }).freePercent}%, swap ${(result.vm.memoryAfter as { swapUsedMiB: number }).swapUsedMiB} MiB`);
  }
  process.exit(0);
}

await main();
