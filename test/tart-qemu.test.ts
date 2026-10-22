// The Tart backend's Windows boxes, whose VMs QEMU runs (046), and their warm
// pool: on a fake Mac with fake QEMU (fake-qemu.mjs), and a fake Windows
// guest that the fake ssh reaches at its port on the Mac's loopback.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { TartBackend, type TartBackendOptions } from "../src/backends/tart/backend.ts";
import { ownerText } from "../src/backends/tart/host.ts";
import { parseQemuState, qemuStartScript } from "../src/backends/tart/qemu.ts";
import type { AcquireHooks, BoxIdentity, BoxSize, Guest, ReleaseHooks } from "../src/backends/types.ts";
import { CUA_PIPE, NAME_WINDOWS_SCRIPT, parseNamed } from "../src/backends/windows.ts";
import { FAKE_DISK_GIB, FAKE_MAC, FAKE_WINDOWS_IMAGE, WINDOWS_TOOLS, addImage, addWindowsImage, fakeMacTools, fakeQemu, fakeSwift, imageRecord, tartConfig } from "./fake-mac.ts";
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

function setup(values: Record<string, unknown> = {}, options: TartBackendOptions = {}, warm: Record<string, number> = {}) {
  const ssh = fakeSsh();
  const mac = ssh.home(MAC);
  macs.push(mac);
  fakeMacTools(mac);
  fakeQemu(mac);
  addImage(mac);
  const build = addWindowsImage(mac);
  ssh.windows(GUEST);
  // A stand-in for PowerShell that keeps the clock script, counts the
  // extensions of C:, the looks at the desktop, which is up at the third
  // unless ~/no-desktop is there, and the display helper's compiles, and runs
  // the rest in sh.
  ssh.powershell(
    GUEST,
    [
      `case "$1" in`,
      `  *Set-Date*) printf "%s" "$1" > "$HOME/clock"; exit 0;;`,
      `  *Resize-Partition*) echo extended >> "$HOME/extend"; exit 0;;`,
      `  *"Get-Process explorer"*) n=$(cat "$HOME/desktop" 2>/dev/null || echo 0); echo $((n + 1)) > "$HOME/desktop"; [ ! -f "$HOME/no-desktop" ] && [ "$n" -ge 2 ];;`,
      `  *Add-Type*) echo compiled >> "$HOME/compiled"; exit 0;;`,
      // Whether the box has bb-box-stream.exe (060): where $HOME/stream is.
      `  *"Test-Path -LiteralPath"*bb-box-stream.exe*) [ -f "$HOME/stream" ] && exit 0; exit 3;;`,
      `  *) exec sh -c "$1";;`,
      `esac`,
      ``,
    ].join("\n"),
  );
  const config = tartConfig({ "tart-windows-image": FAKE_WINDOWS_IMAGE, "tart-reserve-disk-gib": 0, ...values });
  /** A backend on the Mac: another install's, or this one's after a restart. */
  // How often the backend said a kind changed by itself, so bb-box gives its boxes the change.
  const kindsChanged = { count: 0 };
  const make = (installId = "test", counts = warm) => {
    const context = { ...testContext(new MemoryStorage(), installId, { warm: counts }), kindsChanged: () => void kindsChanged.count++ };
    const backend = new TartBackend(config, context, { ...FAKES, ...options });
    made.push(backend);
    return { context, backend };
  };
  const { context, backend } = make();
  return {
    ssh,
    mac,
    build,
    context,
    backend,
    make,
    kindsChanged,
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
  const timings: Record<string, number> = {};
  const value: AcquireHooks = {
    claim: async (guest) => {
      events.push("claim");
      claimed.push(guest);
    },
    starting: async () => {
      events.push("starting");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { hooks: value, events, claimed, timings };
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
    // QEMU with lossy=on: quality 4, as 2 broke text up, and the viewer's refresh, as QEMU's kept some JPEG (056).
    displays: [{ id: "desktop", protocol: "rfb", resizable: true, clipboard: "commands", refresh: "viewer", quality: 4 }],
    computerUse: { driver: "cua", version: "0.30.4", socket: CUA_PIPE },
    enrol: true,
  });
  assert.equal(kind.readyTimeoutMs, 3 * 60_000);
  assert.match(kind.description, /x64 apps run under Windows' emulation, more slowly; x64 drivers do not/);
  // Its boxes join BB unless Tart's switch is set off, as on Proxmox QEMU (#539), and the macOS and Linux kinds as ever.
  const off = new TartBackend(tartConfig({ "tart-windows-image": FAKE_WINDOWS_IMAGE, "tart-windows-enrol": false }), testContext()).kinds();
  assert.equal(off.find((candidate) => candidate.id === KIND)?.capabilities.enrol, false);
  assert.ok(off.filter((candidate) => candidate.id !== KIND).every((candidate) => candidate.capabilities.enrol));
});

test("QEMU shows a Windows VM's desktop through its D-Bus display where it has one, and through VNC alone where it has none or is told so; a saved state restores under either (#885)", async () => {
  const { backend, mac } = setup();
  writeFileSync(join(mac, ".fake-qemu-no-dbus"), "");
  await backend.acquire(identity(), null, hooks().hooks, signal());
  const [run] = runs(mac);
  assert.ok(run!.join(" ").includes("-display none -vnc "), run!.join(" "));
  assert.doesNotMatch(qemuStartScript("vm", 60, "none"), /dbus/);
  assert.match(qemuStartScript("vm", 60), /-incoming defer/);
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
      "=bb-box-wx3",
      "image=bb-box-windows",
      "build=2",
      "ssh=42002",
      "vnc=42003",
      "cores=4",
      "memory=8192",
      "disk=72",
      "power=running",
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
      "2 read-only 68719476736",
    ].join("\n"),
  );
  assert.deepEqual(
    [...state.vms],
    [
      ["bb-box-wx1", { image: "bb-box-windows", build: "2", cores: 4, memoryMiB: 8192, ssh: 42000, vnc: 42001, diskGiB: null, power: "suspended" }],
      ["bb-box-wx3", { image: "bb-box-windows", build: "2", cores: 4, memoryMiB: 8192, ssh: 42002, vnc: 42003, diskGiB: 72, power: "running" }],
    ],
  );
  assert.deepEqual(
    { version: state.version, hvf: state.hvf, firmware: state.firmware, image: state.image },
    { version: "11.1.0", hvf: true, firmware: "/opt/qemu/share/qemu/edk2-aarch64-code.fd", image: { build: "2", readOnly: true, diskGiB: 64, record: null } },
  );
  assert.deepEqual(parseQemuState("@qemu-image\n2 writable\n").image, { build: "2", readOnly: false, diskGiB: null, record: null }, "a disk whose size qemu-img did not read");
  // The build's record (049), from image.json beside its disk.
  const recorded = parseQemuState('@qemu-image\n2 read-only 1024\n@qemu-record\n{"contract":1,"kind":"windows-arm64-desktop","build":"build.20261003-021500","built":"2026-10-03T02:15:00Z"}\n');
  assert.deepEqual([recorded.image?.record?.kind, recorded.image?.record?.build], ["windows-arm64-desktop", "build.20261003-021500"]);
  assert.deepEqual(parseQemuState("@owners\n"), { version: "", vms: new Map(), hvf: false, firmware: null, image: null });
});

test("acquires a Windows box: an owner file, an overlay on the image's build, two ports, QEMU, SSH through the Mac, then the desktop", async () => {
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
  assert.deepEqual({ ...made, ssh: "", vnc: "" }, { image: FAKE_WINDOWS_IMAGE, build: "1", machine: "virt-11.1", ssh: "", vnc: "", cores: "4", memory: "8192" });
  assert.ok(sshPort >= 42000 && vncPort > sshPort && vncPort <= 42999, `${sshPort} ${vncPort}`);
  assert.equal(readFileSync(join(qemu, "vms", vm, "disk.qcow2"), "utf8"), `overlay on ${join(realpathSync(build), "disk.qcow2")}\n`);
  assert.equal(readFileSync(join(qemu, "vms", vm, "vars.fd"), "utf8"), "variables");

  const [run] = runs(mac);
  const line = run!.join(" ");
  assert.deepEqual(run!.slice(0, 2), ["-name", vm]);
  assert.ok(line.includes("-machine virt-11.1 -accel hvf -cpu host -smp 4 -m 8192"), line);
  assert.ok(line.includes(`-drive if=pflash,format=raw,readonly=on,file=${firmware}`), line);
  assert.ok(line.includes(`hostfwd=tcp:127.0.0.1:${sshPort}-:22`), line);
  // QEMU's D-Bus display, which the video reads, beside VNC (#885).
  assert.ok(line.includes(`-display dbus,p2p=yes -vnc 127.0.0.1:${vncPort - 5900},lossy=on`), line);
  assert.ok(!line.includes("-daemonize") && !line.includes("-incoming"), line);
  assert.equal(await backend.power(guest, signal()), "running");
  assert.equal(await backend.power({ ...guest, data: { ...guest.data, box: "another" } }, signal()), null, "another box's VM is not this one's");
  assert.equal(readFileSync(join(ssh.home(GUEST), "desktop"), "utf8"), "3\n", "ready once Windows' desktop is up");
  assert.equal(existsSync(join(ssh.home(GUEST), "extend")), false, "C: fills the image's disk already");

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

test("Windows on a Mac offers video by choice while every Mac's image records OpenH264 and every Mac has built bb-box-stream, and a box shows it where it has bb-box-stream.exe (060, #865)", async () => {
  const { backend, ssh, build, mac, qemu, kindsChanged } = setup({}, { qemuVideoSource: "// bb-box-stream, as a test gives it\n" });
  fakeSwift(mac);
  const kind = () => backend.kinds().find((candidate) => candidate.id === KIND)!;
  assert.equal(await backend.asOffered({ ref: "x", host: MAC, address: null, size: null }, KIND), false, "unknown until a Mac answers");
  await backend.capacity(KIND, SMALL, [], signal());
  assert.equal(await backend.asOffered({ ref: "x", host: MAC, address: null, size: null }, KIND), true);
  assert.equal(kind().capabilities.displays.length, 1, "an image without OpenH264 has no video");

  // The Mac's image now has the stream and the hardware cursor, as prepare-windows-image.sh records them. The Mac built
  // bb-box-stream as its state first said it had none, in the background, so the video comes once it has.
  writeFileSync(join(build, "image.json"), `${imageRecord(KIND, { tools: { ...WINDOWS_TOOLS, openh264: "2.6.0", "hardware-cursor": "1" } })}\n`);
  const bin = join(mac, ".bb-box", "qemu", "bin");
  // Until the build has its hash and its source has gone: the hash comes before the source goes.
  const built = () => readdirSync(bin).filter((name) => !name.endsWith(".lock"));
  await until(() => existsSync(bin) && built().some((name) => name.endsWith(".sha256")) && built().length === 2, "the build of bb-box-stream");
  assert.equal(statSync(bin).mode & 0o777, 0o700, "in a folder only the host user can open");
  assert.deepEqual(built().length, 2, "the build and its hash, the source gone");
  const before = kindsChanged.count;
  await backend.capacity(KIND, SMALL, [], signal());
  assert.deepEqual(kind().capabilities.displays[1], { id: "video", protocol: "selkies", resizable: true, cursor: "stream" }, "it opens as video (#865)");
  // So a box made before, as just after bb-box restarted while the Mac's video was not ready, gets it too.
  assert.equal(kindsChanged.count, before + 1, "the backend says the kind changed");
  await backend.capacity(KIND, SMALL, [], signal());
  assert.equal(kindsChanged.count, before + 1, "and only when it does");

  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const without = (await backend.transports(guest, KIND)).displays;
  assert.deepEqual(without.map((display) => display.protocol), ["rfb"], "a box without the program has none");
  assert.equal(without[0]!.followPointer, undefined, "nor where the pointer is");
  // Asked once a box, so another box with the program is asked afresh.
  writeFileSync(join(ssh.home(GUEST), "stream"), "");
  const other = { ...guest, data: { ...guest.data, box: "bx-another" } };
  const shown = (await backend.transports(other, KIND)).displays;
  // Where the pointer is, from bb-box-stream.exe, for people watching: neither the video nor QEMU's VNC has it (#865).
  assert.equal(typeof shown[0]!.followPointer, "function");
  assert.deepEqual(shown.map(({ open: _, openInput: __, resize: ___, pointer: ____, followPointer: _____, ...display }) => display), [
    { id: "desktop", label: "Desktop", protocol: "rfb", resizable: true, clipboard: "commands", refresh: "viewer", quality: 4, pointerWhile: "rfb", minSize: { width: 800, height: 600 } },
    { id: "video", label: "Desktop, as video", protocol: "selkies", resizable: true, cursor: "stream" },
  ]);
  // The input, the clipboard and the pointer's shape go through the guest's bb-box-stream.exe.
  const input = (await shown[1]!.openInput!()).route;
  assert.match(JSON.stringify(input), /NamedPipeClientStream/, "the pipe to the guest's server, through box's SSH");

  // The video comes from the Mac: its bridge starts for the VM once, and each viewer attaches to it.
  const route = (await shown[1]!.open()).route;
  assert.equal(route.type, "command");
  const run = () => execFileSync(route.argv[0]!, route.argv.slice(1), { encoding: "utf8", timeout: 20_000 });
  const vm = join(qemu, "vms", guest.ref);
  assert.match(run(), /^attached .*\/video\.sock\n$/, "the viewer's connection joins the VM's bridge");
  const pid = Number(readFileSync(join(vm, "video.pid"), "utf8"));
  assert.ok(alive(pid), "the bridge runs");
  assert.match(run(), /^attached /);
  assert.equal(Number(readFileSync(join(vm, "video.pid"), "utf8")), pid, "one bridge for the VM, however many viewers");
  // The bridge reads QEMU's D-Bus display, as the VM's QEMU runs one (#885); one that QEMU does not take gives way to VNC.
  const streams = () => readFileSync(join(mac, ".fake-stream-log"), "utf8").trim().split("\n");
  assert.deepEqual(streams().map((line) => line.split(" ").slice(2)), [[join(vm, "video.sock"), join(vm, "qmp")]]);
  process.kill(pid);
  await until(() => !alive(pid), "the bridge to end");
  writeFileSync(join(mac, ".fake-stream-no-dbus"), "");
  assert.match(run(), /^attached /);
  assert.deepEqual(streams().slice(1).map((line) => line.split(" ").slice(2)), [[join(vm, "video.sock"), join(vm, "qmp")], [join(vm, "video.sock")]]);
  assert.ok(existsSync(join(vm, "video-dbus.log")), "the D-Bus bridge's log is kept");
  rmSync(join(mac, ".fake-stream-no-dbus"));
  // A build that is not whole does not run.
  const binary = readdirSync(bin).find((name) => /^bb-box-stream-[0-9a-f]+$/.test(name))!;
  writeFileSync(join(bin, `${binary}.sha256`), "0\n");
  assert.throws(run, /not whole/);

  // An image that loses it again stops the video.
  writeFileSync(join(build, "image.json"), `${imageRecord(KIND, { tools: WINDOWS_TOOLS })}\n`);
  await backend.capacity(KIND, SMALL, [], signal());
  assert.equal(kind().capabilities.displays.length, 1);
  assert.equal(kindsChanged.count, before + 2, "the backend says so again");
  // The bridge goes with the box, by its PID.
  await backend.release(guest, releasing, signal());
  await until(() => !alive(pid), "the bridge to end");
});

test("Windows on a Mac shows over VNC only, and the doctor says why, while the Mac cannot build bb-box-stream (#865)", async () => {
  const { backend, build, mac } = setup({}, { qemuVideoSource: "// bb-box-stream, as a test gives it\n" });
  writeFileSync(join(build, "image.json"), `${imageRecord(KIND, { tools: { ...WINDOWS_TOOLS, openh264: "2.6.0" } })}\n`);
  const kind = () => backend.kinds().find((candidate) => candidate.id === KIND)!;
  const check = async () => (await backend.doctor(signal())).checks.find((each) => each.id === "qemu-video.mac1")!;

  // No Command Line Tools.
  await backend.capacity(KIND, SMALL, [], signal());
  assert.equal(kind().capabilities.displays.length, 1, "no video");
  let found = await check();
  assert.equal(found.status, "warn");
  assert.match(found.detail, /no swiftc from Xcode's Command Line Tools.*show over VNC only/);
  assert.equal(found.fix, "Install them on the Mac: xcode-select --install.");

  // swiftc fails: the doctor gives its error, and nothing half-built runs.
  fakeSwift(mac, { fails: true });
  await backend.capacity(KIND, SMALL, [], signal());
  const bin = join(mac, ".bb-box", "qemu", "bin");
  await until(() => existsSync(bin) && readdirSync(bin).some((name) => name.endsWith(".failed")), "the failed build");
  found = await check();
  assert.equal(found.status, "warn");
  assert.match(found.detail, /swiftc could not build bb-box-stream: mac-stream\.swift:12:3: error: cannot find 'SCStream' in scope/);
  assert.equal(kind().capabilities.displays.length, 1, "still no video");

  // Once it builds, the video comes.
  fakeSwift(mac);
  rmSync(bin, { recursive: true });
  await backend.capacity(KIND, SMALL, [], signal());
  await until(() => existsSync(bin) && readdirSync(bin).some((name) => name.endsWith(".sha256")), "the build");
  await backend.capacity(KIND, SMALL, [], signal());
  assert.equal(kind().capabilities.displays.length, 2);
  found = await check();
  assert.equal(found.status, "ok");
});

test("the desktop resizes to the listed mode that best covers the viewer, set by Windows in the box user's session, with one try at the viewer's size", async () => {
  const { backend, ssh } = setup();
  const home = ssh.home(GUEST);
  // A stand-in for PowerShell that keeps each desktop command, and exits as $HOME/exit says.
  // It compiles the display helper slowly, and a desktop command fails if that has not finished.
  ssh.powershell(
    GUEST,
    `case "$1" in\n  *Schedule.Service*) [ -f "$HOME/compiled" ] || exit 9; printf "%s" "$1" > "$HOME/resize"; [ -f "$HOME/exit" ] && . "$HOME/exit"; exit 0;;\n  *Add-Type*) sleep 0.5; printf "%s" "$1" > "$HOME/compiled";;\n  *"Get-Process explorer"*) exit 0;;\n  *) exec sh -c "$1";;\nesac\n`,
  );
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const { displays } = await backend.transports(guest, KIND);
  assert.deepEqual(
    displays.map(({ open: _, resize: __, pointer: ___, ...display }) => display),
    [{ id: "desktop", label: "Desktop", protocol: "rfb", resizable: true, clipboard: "commands", refresh: "viewer", quality: 4, pointerWhile: "rfb", minSize: { width: 800, height: 600 } }],
  );

  // The acquire compiles the helper, and the first resize waits for it.
  await displays[0]!.resize!({ width: 1500, height: 900 });
  const compiled = readFileSync(join(home, "compiled"), "utf8");
  const task = readFileSync(join(home, "resize"), "utf8");
  assert.match(task, /\$bbTask\.Principal\.LogonType = 3\n/, "a task in the box user's session");
  const run = Buffer.from(/FromBase64String\(''([A-Za-z0-9+\/=]+)''\)/.exec(task)![1]!, "base64").toString("utf8");
  assert.ok(run.startsWith(compiled), "loads the file the acquire compiled");
  assert.match(run, /\n\$bbRefused = \$bbDisplay::Fit\(1500, 900, 0\)\n/, "the driver takes a viewer's size only at its next boot");

  writeFileSync(join(home, "exit"), `echo "Windows refused 1500x900 and the modes it lists, with -2." >&2; exit 1\n`);
  await assert.rejects(displays[0]!.resize!({ width: 1500, height: 900 }), { message: "Windows could not set the desktop to 1500x900: Windows refused 1500x900 and the modes it lists, with -2." });
  await backend.release(guest, releasing, signal());
});

test("a Windows box with a disk larger than the image's has an overlay of that size, and Windows extends C: over it", async () => {
  const { backend, qemu, ssh, build } = setup();
  const size: BoxSize = { ...SMALL, diskGiB: 72 };
  const box = identity(size);
  const vm = `bb-box-${box.boxId}`;
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.deepEqual(guest.size, size);
  assert.equal(config(qemu, vm).disk, "72");
  assert.equal(readFileSync(join(qemu, "vms", vm, "disk.qcow2"), "utf8"), `overlay on ${join(realpathSync(build), "disk.qcow2")}\nsize 72G\n`);
  const extended = join(ssh.home(GUEST), "extend");
  assert.equal(readFileSync(extended, "utf8"), "extended\n");
  assert.deepEqual((await backend.held(signal())).find((candidate) => candidate.ref === vm)?.size, size);

  // A restarted acquire extends again, as it may have ended before C: was.
  const again = await backend.acquire(box, { ...guest, data: { box: box.boxId, os: "windows" } }, hooks().hooks, signal());
  assert.deepEqual(again, guest);
  assert.equal(readFileSync(extended, "utf8"), "extended\nextended\n");
  await backend.release(guest, releasing, signal());
});

test("a Windows VM resizes with a restart: Windows shuts down, its config and overlay take the new size, and it boots afresh and extends C: (061)", async () => {
  const { backend, mac, qemu, ssh, context } = setup({}, { windowsShutdownWaitS: 1 });
  assert.deepEqual(backend.resizing(KIND), { cores: "restart", memory: "restart", disk: "restart", shrinks: true });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const dir = join(qemu, "vms", guest.ref);
  // Windows, asked to shut down, ends its QEMU, as on the Mac.
  ssh.powershell(
    GUEST,
    [
      `case "$1" in`,
      `  *Stop-Computer*) echo off >> "$HOME/off"; kill "$(cat '${dir}/pid')"; echo "powering off";;`,
      `  *Resize-Partition*) echo extended >> "$HOME/extend"; exit 0;;`,
      `  *"Get-Process explorer"*|*Add-Type*|*Set-Date*) exit 0;;`,
      `  *) exec sh -c "$1";;`,
      `esac`,
      ``,
    ].join("\n"),
  );
  const to: BoxSize = { cores: 6, memoryMiB: 12288, diskGiB: 80 };

  const plan = await backend.planResize(guest, KIND, to, [], signal());
  assert.deepEqual(plan.parts, [
    { part: "cores", from: SMALL.cores, to: 6, way: "restart" },
    { part: "memory", from: SMALL.memoryMiB, to: 12288, way: "restart" },
    { part: "disk", from: 64, to: 80, way: "restart" },
  ]);
  assert.equal(plan.downSeconds, 40);
  await assert.rejects(backend.planResize(guest, KIND, { ...to, diskGiB: 40 }, [], signal()), /disk only grows, and this one's is 64 GiB/);

  const resized = await backend.resize(guest, KIND, to, { restart: true }, signal());
  assert.deepEqual(resized.size, to);
  assert.equal(readFileSync(join(ssh.home(GUEST), "off"), "utf8"), "off\n", "Windows was asked to shut down");
  assert.deepEqual([config(qemu, guest.ref).cores, config(qemu, guest.ref).memory, config(qemu, guest.ref).disk], ["6", "12288", "80"]);
  assert.match(readFileSync(join(dir, "disk.qcow2"), "utf8"), /\nsize 80G\n$/);
  const booted = runs(mac).at(-1)!;
  assert.ok(booted.join(" ").includes("-smp 6 -m 12288 "));
  assert.ok(!booted.includes("-incoming"), "booted afresh, not restored");
  assert.equal(existsSync(join(dir, "state")), false);
  assert.equal(readFileSync(join(ssh.home(GUEST), "extend"), "utf8"), "extended\n", "C: grows over the larger disk");
  assert.equal(await backend.power(guest, signal()), "running");

  // Windows that does not shut down has its QEMU ended, and takes the size all the same.
  const stuck = Number(readFileSync(join(dir, "pid"), "utf8"));
  ssh.powershell(GUEST, [`case "$1" in`, `  *Stop-Computer*) echo "powering off";;`, `  *"Get-Process explorer"*|*Add-Type*|*Set-Date*) exit 0;;`, `  *) exec sh -c "$1";;`, `esac`, ``].join("\n"));
  const back = await backend.resize(guest, KIND, { ...to, cores: 4 }, { restart: true }, signal());
  assert.equal(back.size?.cores, 4);
  assert.equal(alive(stuck), false);
  assert.ok(runs(mac).at(-1)!.join(" ").includes("-smp 4 "));
  assert.deepEqual(context.errors, []);
  await backend.release(guest, releasing, signal());
});

test("a Windows box that asks for a disk no larger than the image's keeps the image's", async () => {
  const { backend, qemu, ssh } = setup();
  for (const diskGiB of [32, 64]) {
    const box = identity({ ...SMALL, diskGiB });
    const guest = await backend.acquire(box, null, hooks().hooks, signal());
    assert.equal(guest.size?.diskGiB, null, `${diskGiB} GiB`);
    assert.equal(config(qemu, guest.ref).disk, undefined);
    assert.doesNotMatch(readFileSync(join(qemu, "vms", guest.ref, "disk.qcow2"), "utf8"), /size/);
    await backend.release(guest, releasing, signal());
  }
  assert.equal(existsSync(join(ssh.home(GUEST), "extend")), false);
});

test("a Windows box's disk may grow by what the Mac has free beyond the disk kept free; a macOS box keeps its image's", async () => {
  const { context } = setup();
  // 4 GiB above what is kept free.
  const reserve = FAKE_DISK_GIB.free - 4;
  const backend = new TartBackend(tartConfig({ "tart-windows-image": FAKE_WINDOWS_IMAGE, "tart-reserve-disk-gib": reserve }), context, FAKES);
  made.push(backend);
  const disk = (diskGiB: number | null): BoxSize => ({ ...SMALL, diskGiB });
  for (const diskGiB of [null, 32, 64, 66]) assert.equal((await backend.capacity(KIND, disk(diskGiB), [], signal())).ok, true, `${diskGiB} GiB`);
  const refused = await backend.capacity(KIND, disk(72), [], signal());
  assert.equal(refused.ok, false);
  assert.match(
    refused.message!,
    new RegExp(`mac1 has [\\d.]+ GiB of disk free and keeps ${reserve} GiB free, so a 72 GiB disk, 8 GiB more than the Windows image's, does not fit\\. Ask for a smaller disk`),
  );
  assert.match((await backend.capacity("macos", disk(66), [], signal())).message!, /a Tart box keeps its image's disk/);
});

test("a Windows fill needs its memory free on disk beyond the disk kept free, for its save; a box does not", async () => {
  const { qemu, context } = setup({}, {}, WARM);
  const free = FAKE_DISK_GIB.free;
  const reserving = (gib: number) => {
    const backend = new TartBackend(tartConfig({ "tart-windows-image": FAKE_WINDOWS_IMAGE, "tart-reserve-disk-gib": gib }), context, FAKES);
    made.push(backend);
    return backend;
  };
  // 4 GiB above what is kept free, less than the 8 GiB a small VM saves.
  const short = reserving(free - 4);
  await short.maintain();
  assert.deepEqual(warmVms(qemu), []);
  assert.equal((await short.capacity(KIND, SMALL, [], signal())).ok, true, "a box still fits");
  await reserving(free - 12).maintain();
  assert.equal(warmVms(qemu).length, 1);
});

test("a VM whose QEMU does not say what virt stands for runs on virt", async () => {
  const { backend, mac, qemu } = setup();
  writeFileSync(join(mac, ".fake-qemu-virt"), "");
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(config(qemu, guest.ref).machine, "virt");
  assert.ok(runs(mac).at(-1)!.join(" ").includes("-machine virt -accel hvf"));
  await backend.release(guest, releasing, signal());
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
  // QEMU was updated while the VM was stopped.
  writeFileSync(join(mac, ".fake-qemu-virt"), "virt-11.2");
  const restoring = qmp(mac).length;
  await backend.start(guest, signal());
  assert.equal(await backend.power(guest, signal()), "running");
  assert.deepEqual(runs(mac).at(-1)!.slice(-2), ["-incoming", "defer"]);
  assert.ok(runs(mac).at(-1)!.join(" ").includes("-machine virt-11.1 "), "restored on the machine it was saved on");
  assert.deepEqual(qmp(mac, restoring).map((command) => command.execute).filter((execute) => execute !== "query-status"), ["qmp_capabilities", "migrate-incoming", "cont"]);
  assert.equal(existsSync(join(dir, "state")), false, "a saved state no longer matches the disk once the VM runs on");
  assert.match(readFileSync(join(ssh.home(GUEST), "clock"), "utf8"), /Set-Date/);
  assert.deepEqual(context.errors, []);
  await backend.release(guest, releasing, signal());
});

test("a Windows VM whose QEMU crashed says so, and its start keeps the run before (#406)", async () => {
  const { backend, qemu } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const dir = join(qemu, "vms", guest.ref);
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  assert.match(readFileSync(join(dir, "exit"), "utf8"), new RegExp(`^pid=${pid}\n`), "QEMU's own process, which a failed restore kills");
  process.kill(pid, "SIGSEGV");
  for (let i = 0; !readFileSync(join(dir, "exit"), "utf8").includes("status="); i++) {
    assert.ok(i < 200, "its exit was not recorded within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await backend.power(guest, signal()), "stopped");
  const why = await backend.stopped(guest, signal());
  assert.equal(why?.crashed, true);
  assert.match(why!.reason, /^QEMU ended on signal 11 \(SIGSEGV\)\./);
  await backend.start(guest, signal());
  assert.match(readFileSync(join(dir, "exit.last"), "utf8"), /status=139/);
  await backend.release(guest, releasing, signal());
});

test("a stop whose save is cancelled fails at once, and the VM runs on", async () => {
  const { backend, mac, qemu } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const dir = join(qemu, "vms", guest.ref);
  writeFileSync(join(mac, ".fake-qemu-cancel"), "");
  const sent = qmp(mac).length;
  await assert.rejects(backend.stop(guest, AbortSignal.timeout(10_000)), { message: new RegExp(`QEMU could not save ${guest.ref}: .*"cancelled"`) });
  assert.deepEqual(
    qmp(mac, sent).map((command) => command.execute),
    ["qmp_capabilities", "stop", "migrate-set-parameters", "migrate", "query-migrate", "cont"],
  );
  assert.equal(await backend.power(guest, signal()), "running");
  assert.equal(existsSync(join(dir, "state.part")), false);
  assert.equal(existsSync(join(dir, "state")), false);
  rmSync(join(mac, ".fake-qemu-cancel"));
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

test("an acquire whose Windows desktop does not come up removes its VM, and says why", async () => {
  const { backend, qemu, owners, ssh } = setup({}, { readyTimeoutMs: 3_000 });
  mkdirSync(ssh.home(GUEST), { recursive: true });
  writeFileSync(join(ssh.home(GUEST), "no-desktop"), "");
  const box = identity();
  const vm = `bb-box-${box.boxId}`;
  await assert.rejects(backend.acquire(box, null, hooks().hooks, signal()), {
    message: new RegExp(`^Windows' desktop in ${vm} on mac1 was not up within \\d+ s: Explorer did not run in a desktop session, or Cua's daemon did not listen on`),
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
  assert.match(full.message!, /mac1 has 118 GiB of memory free and keeps 16 GiB free, so a box with 101 GiB, and 2 GiB for QEMU, does not fit/);

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
  assert.equal(check(`image.mac1.${KIND}`)?.status, "ok");
  assert.match(check(`image.mac1.${KIND}`)!.detail, /^bb-box-windows, build 1\. Standard image build\.20261003-021500, built \d+ \w+ \(today\): fake OS, node 24\.21\.0, /);

  // The build's record (049), beside its disk: older than twice the month Windows images are rebuilt in.
  const day = 24 * 60 * 60 * 1000;
  writeFileSync(join(build, "image.json"), imageRecord(KIND, { built: new Date(Date.now() - 61 * day).toISOString(), tools: WINDOWS_TOOLS }));
  report = await backend.doctor(signal());
  assert.equal(check(`image.mac1.${KIND}`)?.status, "warn");
  assert.match(check(`image.mac1.${KIND}`)!.detail, / It is 61 days old, more than 60, so its tools and packages are behind\.$/);
  // Its boxes join BB, so an image without Node.js and an agent CLI is behind too (#539).
  writeFileSync(join(build, "image.json"), imageRecord(KIND));
  report = await backend.doctor(signal());
  assert.match(check(`image.mac1.${KIND}`)!.detail, /It has no Node\.js, and BB's installer needs 22\.19\.0 or later, .* It has none of the agent CLIs BB runs threads with, Claude Code, Codex, Pi, so box_thread refuses its boxes \(#561\)\.$/);
  writeFileSync(join(build, "image.json"), imageRecord(KIND, { built: new Date(Date.now() - 61 * day).toISOString(), tools: WINDOWS_TOOLS }));
  assert.equal(
    check(`image.mac1.${KIND}`)?.fix,
    "Build it again on mac1 with setup/tart/prepare-windows-image.sh --iso <ISO> --iso-sha256 <its SHA-256> --key '<bb-box's public key>' --name bb-box-windows --replace.",
  );
  writeFileSync(join(build, "image.json"), imageRecord(KIND, { contract: 0 }));
  report = await backend.doctor(signal());
  assert.deepEqual([report.ok, check(`image.mac1.${KIND}`)?.status], [false, "fail"]);
  rmSync(join(build, "image.json"));
  report = await backend.doctor(signal());
  assert.equal(check(`image.mac1.${KIND}`)?.status, "warn");
  assert.match(check(`image.mac1.${KIND}`)!.detail, /^bb-box-windows, build 1\. It has no image record/);
  writeFileSync(join(build, "image.json"), imageRecord(KIND));

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

test("the doctor counts the memory a Windows VM's QEMU takes against the Mac (#74)", async () => {
  // 128 GiB less 119 GiB kept free leaves 9 GiB: a small macOS box, but not a small Windows one and QEMU's 2 GiB.
  const { backend } = setup({ "tart-reserve-memory-mib": 119 * 1024 });
  const sizes = (await backend.doctor(signal())).checks.find((check) => check.id === "sizes.mac1")!;
  assert.equal(sizes.status, "warn");
  assert.equal(
    sizes.detail,
    "mac1 has 16 cores and 128 GiB memory, and keeps 119 GiB free. It cannot hold a windows-arm64-desktop box at any of its presets, the smallest 4 cores, 8 GiB memory.",
  );
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

// The warm pool's Windows VMs: filled at the default size, saved by QEMU.

/** The warm VMs on the Mac. */
function warmVms(qemu: string): string[] {
  const vms = join(qemu, "vms");
  return existsSync(vms) ? readdirSync(vms).filter((name) => name.startsWith("bb-box-warm-")) : [];
}

/** Whether QEMU saved the VM to a file and quit. */
function saved(qemu: string, vm: string): boolean {
  const pid = join(qemu, "vms", vm, "pid");
  return existsSync(join(qemu, "vms", vm, "state")) && !(existsSync(pid) && alive(Number(readFileSync(pid, "utf8"))));
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const WARM = { [KIND]: 1 };

test("maintain fills a Windows pool with VMs QEMU saved at the default size, the display helper compiled first, which held() and capacity count as warm", async () => {
  const { backend, mac, qemu, owners, ssh } = setup({}, {}, WARM);
  await backend.maintain();
  const [warm, ...more] = warmVms(qemu);
  assert.ok(warm && !more.length);
  assert.ok(saved(qemu, warm), "saved, and QEMU quit");
  assert.deepEqual(
    qmp(mac).map((command) => command.execute),
    ["qmp_capabilities", "stop", "migrate-set-parameters", "migrate", "query-migrate", "quit"],
  );
  const owner = readFileSync(join(owners, warm), "utf8");
  for (const line of ["state=warm", "engine=qemu", `image=${FAKE_WINDOWS_IMAGE}`, "build=1", "qemu=11.1.0", "macos=27A1"]) {
    assert.match(owner, new RegExp(`^${line}$`, "m"));
  }
  assert.doesNotMatch(owner, /^box=/m);
  assert.equal(readFileSync(join(ssh.home(GUEST), "compiled"), "utf8"), "compiled\n", "the display helper, before the save");
  assert.deepEqual(await backend.held(signal()), [], "warm VMs are no box's, so the sweep keeps them");
  const capacity = await backend.capacity(KIND, SMALL, [], signal());
  assert.deepEqual(capacity.warm, { ready: 1, target: 1 });
  assert.equal(capacity.hosts[0]!.limits.find((limit) => limit.resource === "memory")!.used, 0, "a saved VM takes no memory");
  await backend.maintain();
  assert.deepEqual(warmVms(qemu), [warm], "a full pool stays as it is");
});

test("a Windows box at the default size takes a warm VM, which QEMU restores, has its clock set, and the pool fills again", async () => {
  const { backend, mac, qemu, owners, ssh, context } = setup({}, {}, WARM);
  await backend.maintain();
  const [warm] = warmVms(qemu);
  rmSync(join(ssh.home(GUEST), "clock"), { force: true });
  const box = identity();
  const recorded = hooks();
  const guest = await backend.acquire(box, null, recorded.hooks, signal());
  assert.equal(guest.ref, warm);
  assert.deepEqual(guest.size, SMALL);
  const made = config(qemu, warm!);
  assert.deepEqual(guest.data, { box: box.boxId, os: "windows", ssh: Number(made.ssh), vnc: Number(made.vnc) });
  assert.ok("warm" in recorded.timings && "clock" in recorded.timings && !("clone" in recorded.timings), JSON.stringify(recorded.timings));
  const owner = readFileSync(join(owners, warm!), "utf8");
  assert.match(owner, new RegExp(`^box=${box.boxId}$`, "m"));
  assert.match(owner, /^engine=qemu$/m);
  assert.doesNotMatch(owner, /^state=/m);
  const own = runs(mac).filter((args) => args[args.indexOf("-name") + 1] === warm);
  assert.deepEqual(own.at(-1)!.slice(-2), ["-incoming", "defer"], "restored");
  assert.equal(await backend.power(guest, signal()), "running");
  assert.match(readFileSync(join(ssh.home(GUEST), "clock"), "utf8"), /Set-Date/);
  assert.equal((await backend.held(signal())).find((held) => held.ref === warm)?.owner?.boxId, box.boxId);
  await backend.maintain();
  const [next, ...more] = warmVms(qemu).filter((vm) => vm !== warm);
  assert.ok(next && !more.length && saved(qemu, next), "the pool fills again");
  assert.deepEqual(context.errors, []);
  await backend.release(guest, releasing, signal());
});

test("a Windows box at another size clones, and leaves the warm VM", async () => {
  const { backend, qemu } = setup({}, {}, WARM);
  await backend.maintain();
  const [warm] = warmVms(qemu);
  const box = identity(sized(6));
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  assert.ok(saved(qemu, warm!));
  await backend.release(guest, releasing, signal());
});

test("a Windows warm VM that does not restore gives way to a clone, and goes", async () => {
  const { backend, qemu, context } = setup({}, {}, WARM);
  await backend.maintain();
  const [warm] = warmVms(qemu);
  writeFileSync(join(qemu, "vms", warm!, "state"), "corrupt");
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  assert.ok(!existsSync(join(qemu, "vms", warm!)), "the warm VM that failed is deleted");
  assert.ok(context.errors.some((error) => /could not use VM [\s\S]*failed to restore/.test(error)), context.errors.join("\n"));
  await backend.maintain();
  await backend.release(guest, releasing, signal());
});

test("a restarted acquire resumes the Windows warm VM it held", async () => {
  const { backend, qemu, owners, make } = setup({}, {}, WARM);
  await backend.maintain();
  const [warm] = warmVms(qemu);
  // Held before the restart: the owner file names the box.
  const box = identity();
  writeFileSync(
    join(owners, warm!),
    ownerText({ install: "test", kind: box.kind, box: box.boxId, thread: box.threadId, name: box.name, created: box.createdAt, engine: "qemu" }),
  );
  const recorded = hooks();
  const { backend: restarted } = make();
  const guest = await restarted.acquire(box, { ref: warm!, host: "mac1", address: null, size: null, data: { box: box.boxId, os: "windows" } }, recorded.hooks, signal());
  assert.equal(guest.ref, warm);
  assert.ok(!("place" in recorded.timings) && !("warm" in recorded.timings) && "clock" in recorded.timings, JSON.stringify(recorded.timings));
  assert.equal(await restarted.power(guest, signal()), "running");
  await restarted.release(guest, releasing, signal());
});

test("an acquire that meets a Windows fill holding the last memory takes it over at the fill's size, and stops it at any other", async () => {
  for (const size of [SMALL, sized(6)]) {
    const { ssh, backend, qemu, owners } = setup({}, {}, WARM);
    // A box of 100 GiB runs, so a fill takes the last memory.
    const running = await backend.acquire(identity(sized(100)), null, hooks().hooks, signal());
    // The fill's VM does not answer until the acquire has made its choice.
    ssh.down(GUEST);
    const up = () => rmSync(join(ssh.dir, "down", GUEST), { force: true });
    const filling = backend.maintain().catch((error: unknown) => error);
    await until(() => warmVms(qemu).length === 1 && existsSync(join(qemu, "vms", warmVms(qemu)[0]!, "pid")), "the fill to wait for its VM");
    const [fill] = warmVms(qemu);
    assert.equal((await backend.capacity(KIND, size, [], signal())).ok, true, "the fill gives its memory to a box (#145)");
    const box = identity(size);
    const recorded = hooks();
    const acquiring = backend.acquire(box, null, recorded.hooks, signal());
    let settled = false;
    void acquiring.then(
      () => (settled = true),
      () => (settled = true),
    );
    if (size === SMALL) {
      await until(() => recorded.claimed.length > 0, "the acquire to take the fill over");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(settled, false, "the box waits for the fill's VM to be ready");
      up();
      const guest = await acquiring;
      assert.equal(guest.ref, fill, "the box takes the fill's VM over");
      assert.match(readFileSync(join(owners, fill!), "utf8"), new RegExp(`^box=${box.boxId}$`, "m"));
      assert.equal(await backend.power(guest, signal()), "running", "and it is never saved");
      assert.ok(!existsSync(join(qemu, "vms", fill!, "state")));
      await backend.release(guest, releasing, signal());
    } else {
      await until(() => !warmVms(qemu).includes(fill!), "the fill to be stopped");
      up();
      const guest = await acquiring;
      assert.equal(guest.ref, `bb-box-${box.boxId}`, "a box of another size clones");
      await backend.release(guest, releasing, signal());
    }
    assert.equal(await filling, undefined);
    await backend.release(running, releasing, signal());
  }
});

test("Windows warm VMs are retired and replaced when the image is built again, QEMU or macOS is updated, or the saved state is gone", async () => {
  const { backend, mac, qemu, owners } = setup({}, {}, WARM);
  await backend.maintain();
  let [warm] = warmVms(qemu);
  const retires = async (what: string, change: () => void) => {
    change();
    await backend.maintain();
    const [next, ...more] = warmVms(qemu);
    assert.ok(next && next !== warm && !more.length && !existsSync(join(qemu, "vms", warm!)), what);
    warm = next;
  };
  await retires("an image built again", () => addWindowsImage(mac, "2"));
  assert.match(readFileSync(join(owners, warm!), "utf8"), /^build=2$/m);
  await retires("an update of QEMU", () => writeFileSync(join(mac, ".fake-qemu-version"), "11.2.0\n"));
  assert.match(readFileSync(join(owners, warm!), "utf8"), /^qemu=11\.2\.0$/m);
  await retires("an update of macOS", () => writeFileSync(join(mac, ".fake-macos-build"), "27A2\n"));
  await retires("a saved state that is gone", () => rmSync(join(qemu, "vms", warm!, "state")));
});

test("a Windows fill cut short by a restart is listed with no owner, so the sweep releases it", async () => {
  const { backend, qemu, owners } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const pid = Number(readFileSync(join(qemu, "vms", guest.ref, "pid"), "utf8"));
  // As a fill leaves its VM: running, its owner file naming no box.
  writeFileSync(
    join(owners, guest.ref),
    ownerText({ install: "test", state: "filling", image: FAKE_WINDOWS_IMAGE, build: "1", qemu: "11.1.0", macos: "27A1", engine: "qemu" }),
  );
  const held = (await backend.held(signal())).find((other) => other.ref === guest.ref);
  assert.ok(held, "the leftover fill is listed");
  assert.equal(held.owner, null);
  assert.deepEqual(held.data, { os: "windows" });
  await backend.release(held, releasing, signal());
  assert.ok(!existsSync(join(qemu, "vms", guest.ref)) && !existsSync(join(owners, guest.ref)));
  assert.equal(alive(pid), false);
});

test("the window namer titles only visible, unowned, top-level windows with no title, and says which (#365)", () => {
  assert.deepEqual(parseNamed("328276\tgpui-example (untitled)\r\n\n262514\tpwsh (untitled)\n"), [
    { id: 328276, title: "gpui-example (untitled)" },
    { id: 262514, title: "pwsh (untitled)" },
  ]);
  assert.deepEqual(parseNamed(""), []);
  // A title the app set, even of spaces, has a length: only an empty one is named.
  assert.match(NAME_WINDOWS_SCRIPT, /!IsWindowVisible\(window\) \|\| GetWindow\(window, 4\) != IntPtr\.Zero \|\| GetWindowTextLength\(window\) != 0/);
  assert.match(NAME_WINDOWS_SCRIPT, /\$bbDll = .*'windows-[0-9a-f]{12}\.dll'/, "compiled once, and kept, as the display helper is");
});

test("a Windows image's operations on a Mac (#450): a box of its build, a capture as a build of its own, a trial box, and the build made current", async () => {
  const { ssh, backend, qemu, owners } = setup();
  const images = backend.images;
  assert.equal(images.windows, true, "the nightly refresh takes in its Windows images");
  const record = JSON.stringify({ contract: 1, image: "standard", kind: KIND, arch: "arm64", build: "build.20261007-020000-abcd", built: "2026-10-07T02:00:00Z", os: "Windows 11", tools: { pwsh: "7.6.0" } });
  // The guest's record, as a refresh leaves it in C:\bb-box\image.json.
  ssh.powershell(GUEST, ['case "$1" in', `  *image.json*) echo '${record}';;`, '  *) exec sh -c "$1";;', "esac", ""].join("\n"));
  const dir = join(qemu, "images", FAKE_WINDOWS_IMAGE);

  const current = (await images.list()).builds.find((build) => build.kind === KIND)!;
  assert.deepEqual([current.ref, current.image, current.current], [`mac1/${FAKE_WINDOWS_IMAGE}`, "standard", true]);
  // The shared check.ps1 (054), with the clock's check in place of the SMBIOS address's, which a Mac's QEMU has not.
  assert.equal(images.check?.(KIND), "", "no check of Tart's own: the shared one runs");
  const setupDir = fileURLToPath(new URL("../setup/", import.meta.url));
  const shared = readFileSync(join(setupDir, "windows", "check.ps1"), "utf8");
  const adapted = images.adaptCheck!(KIND, shared, setupDir);
  assert.ok(shared.includes("address from the SMBIOS serial") && !adapted.includes("address from the SMBIOS serial"));
  assert.ok(adapted.includes(readFileSync(join(setupDir, "tart", "windows", "check-clock.ps1"), "utf8").trim().split("\n")[0]!));
  assert.throws(() => images.adaptCheck!(KIND, "Check 'something else' {\n}\n", setupDir), /setup\/windows\/check\.ps1 has changed/);

  // An image box: an overlay on the current build, marked as one.
  const box = await images.box(current, "refresh of the image", AbortSignal.timeout(30_000));
  const vm = box.ref.slice("mac1/".length);
  assert.match(readFileSync(join(qemu, "vms", vm, "config"), "utf8"), /^image=bb-box-windows\nbuild=1\n/);
  assert.match(readFileSync(join(owners, vm), "utf8"), /\nimage-box=refresh of the image\n/);
  assert.deepEqual((await images.list()).boxes, [box.ref]);

  // Its capture: powered down, its disk and its base flattened into a build of its own, read-only, beside the image's others.
  const captured = await images.capture(box, current, "standard", AbortSignal.timeout(30_000));
  assert.deepEqual([captured.ref, captured.build, captured.current], [`mac1/${FAKE_WINDOWS_IMAGE}@build.20261007-020000-abcd`, "build.20261007-020000-abcd", false]);
  const built = join(dir, "build.20261007-020000-abcd");
  assert.match(readFileSync(join(built, "disk.qcow2"), "utf8"), /^flattened from overlay on .*\/1\/disk\.qcow2/);
  assert.equal(statSync(join(built, "disk.qcow2")).mode & 0o222, 0, "read-only");
  assert.equal(JSON.parse(readFileSync(join(built, "image.json"), "utf8")).build, "build.20261007-020000-abcd");
  assert.ok(existsSync(join(built, "vars.fd")));
  assert.ok(!existsSync(join(qemu, "vms", vm)) && !existsSync(join(owners, vm)), "the box is the build now");
  const listed = await images.list();
  assert.deepEqual(listed.builds.filter((build) => build.kind === KIND).map((build) => [build.ref, build.current]), [[`mac1/${FAKE_WINDOWS_IMAGE}`, true], [captured.ref, false]]);

  // A trial box of the build, then removed.
  const trial = await images.box(captured, "trial", AbortSignal.timeout(30_000));
  assert.match(readFileSync(join(qemu, "vms", trial.ref.slice("mac1/".length), "config"), "utf8"), /\nbuild=build\.20261007-020000-abcd\n/);
  await images.remove(trial.ref, AbortSignal.timeout(30_000));

  // The replace: current names the build, which is no refresh's any more, and the build before stays as the rollback, though no VM uses it.
  const replaced = await images.replace(captured, current, AbortSignal.timeout(30_000));
  assert.deepEqual([replaced.ref, replaced.current, replaced.build], [`mac1/${FAKE_WINDOWS_IMAGE}`, true, "build.20261007-020000-abcd"]);
  assert.equal(realpathSync(join(dir, "current")), realpathSync(built));
  assert.ok(!existsSync(join(built, "owner")));
  assert.equal(realpathSync(join(dir, "rollback")), realpathSync(join(dir, "1")), "the build before is the rollback");
  assert.ok(existsSync(join(dir, "1", "disk.qcow2")));
  await assert.rejects(images.remove(`mac1/${FAKE_WINDOWS_IMAGE}@build.20261007-020000-abcd`, AbortSignal.timeout(30_000)), /is not a refresh's build of this install's/);
  // A VM made from the image's current build now is an overlay on the new build.
  const next = await images.box(replaced, "after the replace", AbortSignal.timeout(30_000));
  assert.match(readFileSync(join(qemu, "vms", next.ref.slice("mac1/".length), "config"), "utf8"), /^image=bb-box-windows\nbuild=build\.20261007-020000-abcd\n/);
  await images.remove(next.ref, AbortSignal.timeout(30_000));

  // The next replace: the build it replaces is the rollback now, and the rollback before, which no VM uses, goes.
  const later = join(dir, "build.20261108-020000-abcd");
  mkdirSync(later);
  for (const file of ["disk.qcow2", "vars.fd", "image.json"]) writeFileSync(join(later, file), "later");
  await images.replace({ ...captured, ref: `mac1/${FAKE_WINDOWS_IMAGE}@build.20261108-020000-abcd`, build: "build.20261108-020000-abcd" }, replaced, AbortSignal.timeout(30_000));
  assert.equal(realpathSync(join(dir, "current")), realpathSync(later));
  assert.equal(realpathSync(join(dir, "rollback")), realpathSync(built), "the build it replaced is the rollback");
  assert.ok(!existsSync(join(dir, "1")), "the rollback before goes");
});
