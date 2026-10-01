// The Tart backend's Windows boxes, whose VMs QEMU runs (046): on a fake Mac
// with fake QEMU (fake-qemu.mjs), and a fake Windows guest that the fake ssh
// reaches at its port on the Mac's loopback.

import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { TartBackend, type TartBackendOptions } from "../src/backends/tart/backend.ts";
import { parseQemuState } from "../src/backends/tart/qemu.ts";
import type { AcquireHooks, BoxIdentity, BoxSize, Guest, ReleaseHooks } from "../src/backends/types.ts";
import { CUA_PIPE } from "../src/backends/windows.ts";
import { FAKE_MAC, FAKE_WINDOWS_IMAGE, addImage, addWindowsImage, fakeMacTools, fakeQemu, tartConfig } from "./fake-mac.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const MAC = FAKE_MAC;
/** Where the fake ssh runs what bb-box sends a Windows VM, which it reaches at 127.0.0.1 through the Mac. */
const GUEST = "127.0.0.1";
const KIND = "windows-arm64-desktop";
const SMALL: BoxSize = { cores: 4, memoryMiB: 8192, diskGiB: null };
const GiB = 1024;

const FAKES: TartBackendOptions = { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000 };

const made: TartBackend[] = [];
const macs: string[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
  // Ends any fake QEMU a failed test left running.
  for (const mac of macs) {
    const vms = join(mac, ".bb-box", "qemu", "vms");
    for (const vm of existsSync(vms) ? readdirSync(vms) : []) {
      const pid = join(vms, vm, "pid");
      if (existsSync(pid)) rmSync(pid);
    }
  }
});

function setup(values: Record<string, unknown> = {}) {
  const ssh = fakeSsh();
  const mac = ssh.home(MAC);
  macs.push(mac);
  fakeMacTools(mac);
  fakeQemu(mac);
  addImage(mac);
  const build = addWindowsImage(mac);
  ssh.windows(GUEST);
  // A stand-in for PowerShell that keeps the clock script and runs the rest in sh.
  ssh.powershell(GUEST, `case "$1" in\n  *Set-Date*) printf "%s" "$1" > "$HOME/clock"; exit 0;;\n  *) exec sh -c "$1";;\nesac\n`);
  const context = testContext(new MemoryStorage());
  const backend = new TartBackend(tartConfig({ "tart-windows-image": FAKE_WINDOWS_IMAGE, "tart-reserve-disk-gib": 0, ...values }), context, FAKES);
  made.push(backend);
  return {
    ssh,
    mac,
    build,
    context,
    backend,
    qemu: join(mac, ".bb-box", "qemu"),
    owners: join(mac, ".bb-box", "tart", "owners"),
    firmware: join(mac, ".nix-profile", "share", "qemu", "edk2-aarch64-code.fd"),
  };
}

let counter = 0;
function identity(size = SMALL): BoxIdentity {
  counter++;
  return { boxId: `wx${counter}`, threadId: "thr_abc123", name: `brave-otter-${counter}`, kind: KIND, createdAt: 1_790_000_000_000, size };
}

function hooks() {
  const events: string[] = [];
  const claimed: Guest[] = [];
  const value: AcquireHooks = {
    claim: async (guest) => {
      events.push("claim");
      claimed.push(guest);
    },
    starting: async () => {
      events.push("starting");
    },
    timing: () => {},
  };
  return { hooks: value, events, claimed };
}

const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(30_000);
const sized = (memoryGiB: number): BoxSize => ({ cores: 4, memoryMiB: memoryGiB * GiB, diskGiB: null });

/** The VM's config, as the clone script wrote it. */
function config(qemu: string, vm: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(qemu, "vms", vm, "config"), "utf8")
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

/** The arguments of each QEMU run on the Mac, oldest first. */
function runs(mac: string): string[][] {
  return readFileSync(join(mac, ".fake-qemu-log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

/** The QMP commands QEMU was sent, oldest first, from the line after `from`. */
function qmp(mac: string, from = 0): { execute: string; arguments?: Record<string, unknown> }[] {
  const file = join(mac, ".fake-qmp-log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .slice(from)
    .map((line) => JSON.parse(line) as { execute: string; arguments?: Record<string, unknown> });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("offers windows-arm64-desktop only with a Windows image, as a Windows desktop on arm64", () => {
  assert.ok(!new TartBackend(tartConfig(), testContext()).kinds().some((kind) => kind.id === KIND));
  const kind = new TartBackend(tartConfig({ "tart-windows-image": FAKE_WINDOWS_IMAGE }), testContext()).kinds().find((candidate) => candidate.id === KIND);
  assert.ok(kind);
  assert.deepEqual(kind.capabilities, {
    os: "windows",
    arch: "arm64",
    gpu: false,
    features: [],
    command: { transport: "ssh", shell: "powershell", admin: true, inDesktopSession: false, streaming: true },
    displays: [{ id: "desktop", protocol: "rfb", resizable: false }],
    computerUse: { driver: "cua", version: "0.30.4", socket: CUA_PIPE },
    enrol: false,
  });
  assert.equal(kind.readyTimeoutMs, 3 * 60_000);
  assert.match(kind.description, /x64 apps run under Windows' emulation, more slowly; x64 drivers do not/);
});

test("reads QEMU's VMs and its checks from the state script", () => {
  const state = parseQemuState(
    [
      "@qemu",
      "=bb-box-wx1",
      "image=bb-box-windows",
      "build=2",
      "ssh=42000",
      "vnc=42001",
      "cores=4",
      "memory=8192",
      "power=suspended",
      "=bb-box-wx2",
      "image=bb-box-windows",
      "power=stopped",
      "@qemu-version",
      "QEMU emulator version 11.1.0",
      "@hvf",
      "1",
      "@qemu-firmware",
      "/opt/qemu/share/qemu/edk2-aarch64-code.fd",
      "@qemu-image",
      "2 read-only",
    ].join("\n"),
  );
  assert.deepEqual([...state.vms], [["bb-box-wx1", { image: "bb-box-windows", build: "2", cores: 4, memoryMiB: 8192, ssh: 42000, vnc: 42001, power: "suspended" }]]);
  assert.deepEqual(
    { version: state.version, hvf: state.hvf, firmware: state.firmware, image: state.image },
    { version: "11.1.0", hvf: true, firmware: "/opt/qemu/share/qemu/edk2-aarch64-code.fd", image: { build: "2", readOnly: true } },
  );
  assert.deepEqual(parseQemuState("@owners\n"), { version: "", vms: new Map(), hvf: false, firmware: null, image: null });
});

test("acquires a Windows box: an owner file, an overlay on the image's build, two ports, QEMU, then SSH through the Mac", async () => {
  const { backend, mac, qemu, owners, ssh, build, firmware } = setup();
  const box = identity();
  const vm = `bb-box-${box.boxId}`;
  const { hooks: value, events, claimed } = hooks();
  const guest = await backend.acquire(box, null, value, signal());

  const made = config(qemu, vm);
  const [sshPort, vncPort] = [Number(made.ssh), Number(made.vnc)];
  assert.deepEqual(guest, { ref: vm, host: "mac1", address: null, size: SMALL, data: { box: box.boxId, os: "windows", ssh: sshPort, vnc: vncPort } });
  assert.deepEqual(events, ["claim", "starting", "claim"]);
  assert.deepEqual(claimed[0]!.data, { box: box.boxId, os: "windows" }, "claimed before anything is made");
  assert.equal(
    readFileSync(join(owners, vm), "utf8"),
    `install=test\nkind=${KIND}\nbox=${box.boxId}\nthread=thr_abc123\nname=${box.name}\ncreated=1790000000000\nengine=qemu\n`,
  );
  assert.deepEqual({ ...made, ssh: "", vnc: "" }, { image: FAKE_WINDOWS_IMAGE, build: "1", ssh: "", vnc: "", cores: "4", memory: "8192" });
  assert.ok(sshPort >= 42000 && vncPort > sshPort && vncPort <= 42999, `${sshPort} ${vncPort}`);
  assert.equal(readFileSync(join(qemu, "vms", vm, "disk.qcow2"), "utf8"), `overlay on ${join(realpathSync(build), "disk.qcow2")}\n`);
  assert.equal(readFileSync(join(qemu, "vms", vm, "vars.fd"), "utf8"), "variables");

  const [run] = runs(mac);
  const line = run!.join(" ");
  assert.deepEqual(run!.slice(0, 2), ["-name", vm]);
  assert.ok(line.includes("-machine virt -accel hvf -cpu host -smp 4 -m 8192"), line);
  assert.ok(line.includes(`-drive if=pflash,format=raw,readonly=on,file=${firmware}`), line);
  assert.ok(line.includes(`hostfwd=tcp:127.0.0.1:${sshPort}-:22`), line);
  assert.ok(line.includes(`-display none -vnc 127.0.0.1:${vncPort - 5900}`), line);
  assert.ok(!line.includes("-daemonize") && !line.includes("-incoming"), line);
  assert.equal(await backend.power(guest, signal()), "running");
  assert.equal(await backend.power({ ...guest, data: { ...guest.data, box: "another" } }, signal()), null, "another box's VM is not this one's");

  const dials = ssh.log().filter((entry) => entry.target === `box@${GUEST}`);
  assert.ok(dials.length > 0, "SSH to the guest");
  for (const dial of dials) {
    assert.equal(dial.args[dial.args.indexOf("-p") + 1], String(sshPort));
    assert.ok(dial.args.some((arg) => arg.startsWith("ProxyCommand=") && arg.endsWith(`bbbox-admin@${MAC}'`)), JSON.stringify(dial.args));
  }

  const transports = await backend.transports(guest, KIND);
  const access = transports.access!.ssh!;
  assert.deepEqual([access.host, access.port, access.user, access.jump?.host], [GUEST, sshPort, "box", MAC]);
  const claimedFirst = await backend.transports(claimed[0]!, KIND);
  assert.equal(claimedFirst.access?.ssh?.port, sshPort, "a guest claimed before it had ports finds them on the Mac");
  assert.equal(transports.displays[0]!.label, "Desktop");
  const { route, auth } = await transports.displays[0]!.open(signal());
  assert.deepEqual(auth, { type: "none" }, "QEMU's VNC server listens on the Mac's loopback only");
  assert.ok(route.type === "command" && route.argv.includes(`127.0.0.1:${vncPort}`) && route.argv.at(-1) === `bbbox-admin@${MAC}`);

  const held = (await backend.held(signal())).find((candidate) => candidate.ref === vm);
  assert.deepEqual(held, {
    ref: vm,
    host: "mac1",
    address: null,
    size: SMALL,
    data: guest.data,
    owner: { boxId: box.boxId, threadId: "thr_abc123", name: box.name, kind: KIND, createdAt: 1_790_000_000_000 },
    power: "running",
  });

  const pid = Number(readFileSync(join(qemu, "vms", vm, "pid"), "utf8"));
  await backend.release(guest, releasing, signal());
  assert.equal(alive(pid), false, "QEMU ended");
  assert.equal(existsSync(join(qemu, "vms", vm)), false);
  assert.equal(existsSync(join(owners, vm)), false);
  assert.equal(await backend.power(guest, signal()), null);
});

test("an acquire that starts again goes on with its VM, at the same ports, though the VM fills the Mac", async () => {
  const { backend, mac } = setup();
  const box = identity(sized(100));
  const first = await backend.acquire(box, null, hooks().hooks, signal());
  const again = await backend.acquire(box, { ...first, data: { box: box.boxId, os: "windows" } }, hooks().hooks, signal());
  assert.deepEqual(again, first);
  assert.equal(runs(mac).length, 1, "QEMU already ran it");
  await backend.release(again, releasing, signal());
});

test("a stop saves a Windows VM to a file and QEMU quits; a start restores it, drops the file and sets Windows' clock", async () => {
  const { backend, mac, qemu, ssh, context } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const dir = join(qemu, "vms", guest.ref);
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  const sent = qmp(mac).length;

  await backend.stop(guest, signal());
  assert.equal(alive(pid), false, "QEMU quit");
  assert.equal(readFileSync(join(dir, "state"), "utf8"), "saved paused\n", "saved while the guest was stopped");
  assert.deepEqual(
    qmp(mac, sent).map((command) => command.execute),
    ["qmp_capabilities", "stop", "migrate-set-parameters", "migrate", "query-migrate", "quit"],
  );
  assert.deepEqual(qmp(mac, sent)[2]!.arguments, { "max-bandwidth": 107374182400 }, "at full speed");
  assert.deepEqual(qmp(mac, sent)[3]!.arguments, { uri: `file:${dir}/state.part` });
  assert.equal(await backend.power(guest, signal()), "stopped");
  await backend.stop(guest, signal());
  assert.equal(runs(mac).length, 1, "a stopped VM is left as it is");

  rmSync(join(ssh.home(GUEST), "clock"), { force: true });
  const restoring = qmp(mac).length;
  await backend.start(guest, signal());
  assert.equal(await backend.power(guest, signal()), "running");
  assert.deepEqual(runs(mac).at(-1)!.slice(-2), ["-incoming", "defer"]);
  assert.deepEqual(qmp(mac, restoring).map((command) => command.execute).filter((execute) => execute !== "query-status"), ["qmp_capabilities", "migrate-incoming", "cont"]);
  assert.equal(existsSync(join(dir, "state")), false, "a saved state no longer matches the disk once the VM runs on");
  assert.match(readFileSync(join(ssh.home(GUEST), "clock"), "utf8"), /Set-Date/);
  assert.deepEqual(context.errors, []);
  await backend.release(guest, releasing, signal());
});

test("a Windows VM whose saved state does not restore boots afresh from its disk, with a warning", async () => {
  const { backend, mac, qemu, context } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  await backend.stop(guest, signal());
  const dir = join(qemu, "vms", guest.ref);
  writeFileSync(join(dir, "state"), "corrupt");
  await backend.start(guest, signal());
  assert.equal(await backend.power(guest, signal()), "running");
  assert.equal(existsSync(join(dir, "state")), false);
  assert.deepEqual(runs(mac).at(-2)!.slice(-2), ["-incoming", "defer"]);
  assert.ok(!runs(mac).at(-1)!.includes("-incoming"), "booted afresh");
  assert.equal(context.errors.length, 1);
  assert.match(context.errors[0]!, /did not restore, so it boots afresh from its disk.*After an update of macOS or QEMU.*QEMU failed to restore/s);
  await backend.release(guest, releasing, signal());
});

test("an acquire whose QEMU does not start removes its VM and owner file, and says why", async () => {
  const { backend, qemu, owners, firmware } = setup();
  rmSync(firmware);
  const box = identity();
  const vm = `bb-box-${box.boxId}`;
  await assert.rejects(backend.acquire(box, null, hooks().hooks, signal()), {
    message: `QEMU could not start ${vm} on mac1: QEMU's firmware ${firmware} is missing.`,
  });
  assert.equal(existsSync(join(qemu, "vms", vm)), false);
  assert.equal(existsSync(join(owners, vm)), false);
});

test("a running Windows VM counts its memory and 2 GiB for QEMU, and not against the two macOS VMs", async () => {
  const { backend } = setup();
  const memory = (capacity: { hosts: readonly { limits: readonly { resource: string; used: number }[] }[] }, resource = "memory") =>
    capacity.hosts[0]!.limits.find((limit) => limit.resource === resource)!.used;
  // 128 GiB, less 16 GiB kept free: with a 102 GiB box pending, a 10 GiB one and QEMU's 2 GiB do not fit.
  assert.equal((await backend.capacity(KIND, sized(10), [{ kind: KIND, size: sized(100) }], signal())).ok, false);
  assert.equal((await backend.capacity(KIND, sized(10), [{ kind: "macos", size: sized(100) }], signal())).ok, true);

  // While it is acquired, a box counts once, both before and after its VM runs.
  const { hooks: counting } = hooks();
  const seen: number[] = [];
  const claim = counting.claim;
  const guest = await backend.acquire(
    identity(),
    null,
    {
      ...counting,
      claim: async (guest) => {
        await claim(guest);
        seen.push(memory(await backend.capacity(KIND, sized(1), [], signal())));
      },
    },
    signal(),
  );
  assert.deepEqual(seen, [10 * GiB, 10 * GiB]);
  const fits = await backend.capacity(KIND, sized(100), [], signal());
  assert.equal(fits.ok, true);
  assert.equal(memory(fits), 10 * GiB);
  assert.equal(memory(fits, "guests"), 0);
  const full = await backend.capacity(KIND, sized(101), [], signal());
  assert.equal(full.ok, false);
  assert.match(full.message!, /mac1 has 118 GiB of memory free, and a box with 101 GiB, and 2 GiB for QEMU, would leave less than the 16 GiB kept free/);

  await backend.stop(guest, signal());
  assert.equal(memory(await backend.capacity(KIND, sized(101), [], signal())), 0, "a saved VM takes no memory");
  await backend.release(guest, releasing, signal());
});

test("a Mac without QEMU or without the Windows image takes no Windows box, and says why", async () => {
  const { backend, mac, qemu } = setup();
  rmSync(join(qemu, "images"), { recursive: true });
  let capacity = await backend.capacity(KIND, SMALL, [], signal());
  assert.match(capacity.message!, /mac1 has no Windows image bb-box-windows in ~\/\.bb-box\/qemu\/images\. Prepare it there/);
  rmSync(join(mac, ".nix-profile", "bin", "qemu-system-aarch64"));
  capacity = await backend.capacity(KIND, SMALL, [], signal());
  assert.match(capacity.message!, /mac1 has no QEMU on the PATH of bbbox-admin's SSH sessions, which Windows boxes need/);
  assert.equal((await backend.capacity("macos", SMALL, [], signal())).ok, true, "macOS boxes do not need QEMU");
});

test("the doctor checks QEMU, the Hypervisor framework, the firmware and the Windows image's build on each Mac", async () => {
  const { backend, mac, build, firmware } = setup();
  let report = await backend.doctor(signal());
  const check = (id: string) => report.checks.find((candidate) => candidate.id === id);
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.summary, "Tart 2.30.0 and QEMU 11.1.0 on mac1");
  assert.equal(check("host.mac1")?.detail, "macOS 27.0 on Apple silicon, Tart 2.30.0.");
  assert.deepEqual([check("qemu.mac1")?.status, check("qemu.mac1")?.detail], ["ok", "QEMU 11.1.0, with the Hypervisor framework and its UEFI firmware."]);
  assert.deepEqual([check(`image.mac1.${KIND}`)?.status, check(`image.mac1.${KIND}`)?.detail], ["ok", "bb-box-windows, build 1."]);

  chmodSync(join(build, "disk.qcow2"), 0o644);
  report = await backend.doctor(signal());
  assert.equal(check(`image.mac1.${KIND}`)?.status, "warn");
  assert.equal(check(`image.mac1.${KIND}`)?.fix, "Make it read-only: chmod a-w ~/.bb-box/qemu/images/bb-box-windows/1/disk.qcow2");

  rmSync(firmware);
  report = await backend.doctor(signal());
  assert.deepEqual([report.ok, check("qemu.mac1")?.status], [false, "fail"]);
  assert.match(check("qemu.mac1")!.detail, /no UEFI firmware/);

  writeFileSync(join(mac, ".fake-no-hvf"), "");
  report = await backend.doctor(signal());
  assert.match(check("qemu.mac1")!.detail, /mac1 has no Hypervisor framework/);

  rmSync(join(mac, ".nix-profile", "bin", "qemu-system-aarch64"));
  report = await backend.doctor(signal());
  assert.equal(check("qemu.mac1")?.detail, "mac1 has no qemu-system-aarch64 on the PATH of bbbox-admin's SSH sessions.");
});

test("a Mac that serves only Windows boxes needs no Tart", async () => {
  const { backend, mac } = setup({ "tart-macos-image": "", "tart-macos-desktop-image": "" });
  rmSync(join(mac, ".nix-profile", "bin", "tart"));
  assert.deepEqual(
    backend.kinds().map((kind) => kind.id),
    [KIND],
  );
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const report = await backend.doctor(signal());
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.summary, "QEMU 11.1.0 on mac1");
  assert.equal(report.checks.find((check) => check.id === "host.mac1")?.detail, "macOS 27.0 on Apple silicon.");
  await backend.release(guest, releasing, signal());
});
