import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parseLinuxBattery, parseMacBattery } from "../src/monitor/battery.ts";
import { MAC_SENSORS_BINARY, MAC_SENSORS_DIGEST } from "../src/monitor/mac-sensors-binary.ts";
import { parseSensorOutput, startHelper } from "../src/monitor/mac-sensors.ts";
import { createTailscaleReader, parseTailscaleStatus } from "../src/monitor/tailscale.ts";
import { pressureAlertCopy, TEST_ALERT_COPY } from "../src/monitor/alert-copy.ts";
import { loadErrorCopy } from "../src/app/monitor/load-error-copy.ts";
import { readPanelShape, rememberPanelShape } from "../src/app/monitor/panel-shape.ts";
import { fitMiddle, keptEnd, middleParts } from "../src/app/monitor/middle.ts";

const macIoreg = [
  '      "CurrentCapacity" = 23',
  '      "TimeRemaining" = 74',
  '      "Amperage" = 18446744073709549843',
  '      "AvgTimeToFull" = 65535',
  '      "ExternalConnected" = No',
  '      "NominalChargeCapacity" = 7612',
  '      "FullyCharged" = No',
  '      "MaxCapacity" = 100',
  '      "InstantAmperage" = 18446744073709549843',
  '      "Temperature" = 3076',
  '      "AvgTimeToEmpty" = 74',
  '      "IsCharging" = No',
  '      "DesignCapacity" = 8579',
  '      "Voltage" = 11149',
  '      "CycleCount" = 146',
].join("\n");

test("reads a discharging MacBook battery from ioreg", () => {
  assert.deepEqual(parseMacBattery(macIoreg), { percent: 23, state: "discharging", minutesRemaining: 74, healthPercent: 88.7, cycleCount: 146, watts: 19.8, temperatureC: 30.8 });
});

test("a charging Mac reports time to full, and an estimate still running reports none", () => {
  const charging = macIoreg.replace('"IsCharging" = No', '"IsCharging" = Yes').replace('"ExternalConnected" = No', '"ExternalConnected" = Yes');
  assert.equal(parseMacBattery(charging)?.state, "charging");
  assert.equal(parseMacBattery(charging)?.minutesRemaining, null);
  const full = macIoreg.replace('"FullyCharged" = No', '"FullyCharged" = Yes').replace('"ExternalConnected" = No', '"ExternalConnected" = Yes');
  assert.equal(parseMacBattery(full)?.state, "full");
});

test("a Mac without a battery reports none", () => {
  assert.equal(parseMacBattery(""), null);
});

test("reads a Linux laptop battery from sysfs", () => {
  assert.deepEqual(
    parseLinuxBattery({ type: "Battery\n", capacity: "64\n", status: "Discharging\n", power_now: "9500000\n", energy_now: "38000000\n", energy_full: "50000000\n", energy_full_design: "57000000\n", cycle_count: "212\n" }),
    { percent: 64, state: "discharging", minutesRemaining: 240, healthPercent: 87.7, cycleCount: 212, watts: 9.5, temperatureC: null },
  );
});

test("Linux batteries: signed current, missing capacity and peripheral batteries", () => {
  const discharging = parseLinuxBattery({ type: "Battery", status: "Discharging", current_now: "-1000000", voltage_now: "12000000", charge_now: "2000000", charge_full: "4000000" });
  assert.equal(discharging?.percent, 50, "percent comes from charge when capacity is missing");
  assert.equal(discharging?.watts, 12, "a negative discharge current still gives watts");
  assert.equal(discharging?.minutesRemaining, 120, "and time left");
  assert.equal(parseLinuxBattery({ type: "Battery", scope: "Device", capacity: "80" }), null, "a mouse battery is not the machine's");
  assert.equal(parseLinuxBattery({ type: "Mains", capacity: "80" }), null);
});

test("an Intel Mac's capacity in mAh becomes a percentage", () => {
  assert.equal(parseMacBattery(['"CurrentCapacity" = 2000', '"MaxCapacity" = 5000', '"ExternalConnected" = No'].join("\n"))?.percent, 40);
});

test("a desktop Mac's empty battery record is no battery", () => {
  assert.equal(parseMacBattery(['"CurrentCapacity" = 0', '"MaxCapacity" = 0', '"BatteryInstalled" = No', '"ExternalConnected" = Yes'].join("\n")), null);
});

test("reads the sensor helper's output and rejects nonsense", () => {
  assert.deepEqual(parseSensorOutput('{"cpuTempC":51.76,"gpuTempC":45.68,"cpuWatts":1.10,"gpuWatts":null,"gpuPercent":41.00}'), { cpuTempC: 51.76, gpuTempC: 45.68, cpuWatts: 1.1, gpuWatts: null, gpuPercent: 41 });
  assert.equal(parseSensorOutput('{"gpuPercent":140}')?.gpuPercent, null);
  assert.equal(parseSensorOutput("Killed: 9"), null);
  assert.equal(parseSensorOutput('{"cpuTempC":999}')?.cpuTempC, null);
});

test("the embedded helper matches its recorded digest, and is built from BB Box's source", () => {
  assert.equal(createHash("sha256").update(Buffer.from(MAC_SENSORS_BINARY, "base64")).digest("hex"), MAC_SENSORS_DIGEST);
  assert.ok(readFileSync(new URL("../setup/monitor/bb-box-sensors.c", import.meta.url), "utf8").includes("IOReportCopyChannelsInGroup"));
  assert.match(readFileSync(new URL("../setup/monitor/build-sensors.sh", import.meta.url), "utf8"), /src\/monitor\/mac-sensors-binary\.ts/);
});

test("the helper is written under BB Box's own cache folder, under a name with its digest", () => {
  const source = readFileSync(new URL("../src/monitor/mac-sensors.ts", import.meta.url), "utf8");
  assert.match(source, /"Library", "Caches", "bb-box"/);
  assert.match(source, /`bb-box-sensors-\$\{MAC_SENSORS_DIGEST\.slice\(0, 16\)\}`/);
});

async function fakeHelper(t: TestContext, body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-box-fake-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "helper");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

test("the sensor helper answers one line per request, in order", async (t) => {
  const helper = startHelper(await fakeHelper(t, `n=0; while read line; do n=$((n+1)); echo "{\\"cpuTempC\\":$n}"; done`));
  t.after(() => helper.stop());
  assert.equal(await helper.request(2000), '{"cpuTempC":1}');
  assert.equal(await helper.request(2000), '{"cpuTempC":2}');
});

test("a hung, crashed or missing helper gives null and reports its exit", async (t) => {
  for (const [name, body] of [["hung", "while read line; do sleep 30; done"], ["crashed", "read line; exit 1"]] as const) {
    let exits = 0;
    const helper = startHelper(await fakeHelper(t, body), () => {
      exits += 1;
    });
    assert.equal(await helper.request(300), null, `${name} helper gives no reading`);
    assert.equal(await helper.request(300), null, `${name} helper is not reused`);
    assert.equal(exits, 1, `${name} helper reports one exit`);
  }
  let missingExits = 0;
  const missing = startHelper("/nonexistent/bb-box-sensors", () => {
    missingExits += 1;
  });
  assert.equal(await missing.request(300), null);
  assert.equal(missingExits, 1);
});

const running = (self: unknown) => JSON.stringify({ BackendState: "Running", Self: self, Peer: { a: { DNSName: "peer.example.ts.net." } } });

test("reads this machine's Tailscale name, addresses and tags, not its peers", () => {
  assert.deepEqual(parseTailscaleStatus(running({ DNSName: "studio.example-net.ts.net.", TailscaleIPs: ["100.64.0.7", "fd7a:115c:a1e0::7"], Tags: ["tag:server"] })), {
    dnsName: "studio.example-net.ts.net",
    ipv4: "100.64.0.7",
    ipv6: "fd7a:115c:a1e0::7",
    tags: ["tag:server"],
  });
});

test("treats missing tags and IPv6 as empty", () => {
  assert.deepEqual(parseTailscaleStatus(running({ DNSName: "laptop.example-net.ts.net.", TailscaleIPs: ["100.64.0.8"], Tags: null })), { dnsName: "laptop.example-net.ts.net", ipv4: "100.64.0.8", ipv6: null, tags: [] });
});

test("shows nothing when Tailscale is stopped, logged out or the output is not JSON", () => {
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "x.ts.net." } })), null);
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin" })), null);
  assert.equal(parseTailscaleStatus("failed to connect to local tailscaled"), null);
  assert.equal(parseTailscaleStatus(running({ DNSName: "" })), null);
});

test("the Tailscale reader reuses one reading for a minute", async () => {
  let clock = 0;
  const read = createTailscaleReader(() => clock);
  const signal = new AbortController().signal;
  const first = await read(signal);
  clock = 30_000;
  assert.equal(await read(signal), first);
});

for (const [metric, name, threshold] of [["cpu", "CPU", 95], ["memory", "Memory", 90]] as const) {
  test(`${name} alert uses a plain title and an inclusive threshold`, () => {
    assert.deepEqual(pressureAlertCopy({ metric, type: "incident", threshold, value: 99 }), {
      title: `High ${metric === "cpu" ? "CPU" : "memory"} usage`,
      description: `${name} usage stayed at ${threshold}% or higher for at least one minute.`,
    });
  });
  test(`${name} recovery describes the recorded value, not a live reading`, () => {
    assert.deepEqual(pressureAlertCopy({ metric, type: "recovery", threshold, value: 40 }), { title: `${name} usage back to normal`, description: `${name} usage dropped to 40%.` });
    assert.equal(pressureAlertCopy({ metric, type: "recovery", threshold, value: 40.26 }).description, `${name} usage dropped to 40.3%.`);
  });
}

test("test copy clearly identifies a preview without inventing a CPU reading", () => {
  assert.deepEqual(TEST_ALERT_COPY, { title: "Test notification", description: "This is a preview. No overload was triggered." });
});

test("load errors read as plain messages without transport details", () => {
  assert.equal(loadErrorCopy('rpc "monitor.machine" failed (HTTP 502)', "lively-summit"), "Can't reach lively-summit.");
  assert.equal(loadErrorCopy("Host request timed out", "laptop"), "Can't reach laptop.");
  assert.equal(loadErrorCopy("Unexpected snapshot shape", "laptop"), "Couldn't get stats from laptop.");
  assert.equal(loadErrorCopy("The Monitor is off. Turn it on under Monitor in BB Box's settings.", "laptop"), "The Monitor is off. Turn it on under Monitor in BB Box's settings.");
});

test("the remembered panel layout survives bad storage and clamps tailscale rows", () => {
  const store = new Map<string, string>();
  const global = globalThis as { localStorage?: unknown };
  global.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) };
  try {
    assert.deepEqual(readPanelShape("host_mac"), { gpu: false, gpuCards: 0, battery: false, tailscaleRows: 0 });
    rememberPanelShape("host_mac", { gpu: true, gpuCards: 0, battery: true, tailscaleRows: 3 });
    assert.deepEqual(readPanelShape("host_mac"), { gpu: true, gpuCards: 0, battery: true, tailscaleRows: 3 });
    rememberPanelShape("host_gpus", { gpu: true, gpuCards: 2, battery: false, tailscaleRows: 0 });
    assert.deepEqual(readPanelShape("host_gpus"), { gpu: true, gpuCards: 2, battery: false, tailscaleRows: 0 });
    store.set("bb-box:monitor:shape:host_box", JSON.stringify({ gpu: "yes", gpuCards: 99, tailscaleRows: 40 }));
    assert.deepEqual(readPanelShape("host_box"), { gpu: false, gpuCards: 16, battery: false, tailscaleRows: 4 });
    store.set("bb-box:monitor:shape:host_box", "{not json");
    assert.deepEqual(readPanelShape("host_box"), { gpu: false, gpuCards: 0, battery: false, tailscaleRows: 0 });
  } finally {
    delete global.localStorage;
  }
});

test("middle truncation keeps the last few characters, so an address keeps both ends", () => {
  const ipv6 = "fd7a:115c:a1e0::403a:fd53";
  assert.deepEqual(middleParts(ipv6), { head: "fd7a:115c:a1e0::", tail: "403a:fd53" });
  assert.equal(keptEnd("bb"), 1);
  assert.equal(keptEnd(""), 0);
});

test("middle truncation keeps as much of the start as fits, with the ellipsis right against the kept end", () => {
  const room = (characters: number) => (candidate: string) => candidate.length <= characters;
  const ipv6 = "fd7a:115c:a1e0::403a:fd53";
  assert.equal(fitMiddle(ipv6, room(40)), ipv6, "a value that fits is shown whole");
  assert.equal(fitMiddle(ipv6, room(19)), "fd7a:115c…403a:fd53", "the owner's example");
  assert.equal(fitMiddle(ipv6, room(15)), "fd7a:…403a:fd53");
  assert.equal(fitMiddle(ipv6, room(3)), "…403a:fd53", "with no room for the start, the end stays");
  let measured = 0;
  fitMiddle("x".repeat(4096), (candidate) => {
    measured++;
    return candidate.length <= 100;
  });
  assert.ok(measured <= 14, `a long value is fitted in a few measurements, not one per character: ${measured}`);
});
