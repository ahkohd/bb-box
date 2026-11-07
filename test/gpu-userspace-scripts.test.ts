import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  UPDATE_DIR,
  UPDATE_LOCK,
  USERSPACE_READ,
  agentUserspaceWords,
  asRoot,
  judgeAnyCard,
  judgeDesktopCheck,
  DESKTOP_GPU_CHECK,
  SELKIES_PROCESS,
  judgeReading,
  judgeUpdateCheck,
  planWords,
  settledUpdate,
  UPDATE_CHECK,
  fetchCommand,
  updateScriptText,
  updateFilesCommand,
  updateRunning,
  userspaceState,
  type UserspaceReading,
  type UserspaceUpdate,
} from "../src/core/gpu-userspace.ts";
import { tempDir } from "./helpers.ts";

const SCRIPT = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/nvidia-userspace-update.sh", import.meta.url));
const GUEST = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/", import.meta.url));
const SETUP = fileURLToPath(new URL("../setup/", import.meta.url));
const RUN = (driver: string) => `NVIDIA-Linux-x86_64-${driver}.run`;

function fakeRoot(options: { driver?: string | null; os?: string | null; image?: boolean; desktop?: string | null } = {}): string {
  const root = tempDir("nvidia-update-root");
  const file = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  if (options.driver !== null) file("sys/module/nvidia/version", `${options.driver ?? "580.142"}\n`);
  if (options.os !== null) file("etc/os-release", options.os ?? 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n');
  if (options.image !== false) file("usr/share/bb-box/image.json", "{}\n");
  if (options.desktop) file("etc/bb-box/desktop.env", options.desktop);
  mkdirSync(join(root, "run"), { recursive: true });
  return root;
}

function fakeDpkg(listing: string): string {
  const bin = tempDir("nvidia-update-bin");
  writeFileSync(join(bin, "dpkg-query"), `#!/bin/sh\nprintf '%s' '${listing}'\n`);
  chmodSync(join(bin, "dpkg-query"), 0o755);
  return bin;
}

function run(root: string, args: readonly string[], env: Record<string, string> = {}, bin: string | null = null) {
  const path = bin ? `${bin}:${process.env.PATH}` : process.env.PATH!;
  const result = spawnSync("bash", [SCRIPT, ...args], { env: { ...process.env, ...env, BB_BOX_ROOT: root, PATH: path }, encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr.trim() };
}

function mirror(driver: string, body = "a fake NVIDIA installer\n", sha?: string): string {
  const base = tempDir("nvidia-mirror");
  mkdirSync(join(base, driver), { recursive: true });
  writeFileSync(join(base, driver, RUN(driver)), body);
  writeFileSync(join(base, driver, `${RUN(driver)}.sha256sum`), `${sha ?? createHash("sha256").update(body).digest("hex")}  ${RUN(driver)}\n`);
  return `file://${base}`;
}

test("071 unit 12: the update script's check reads the box's architecture, system, bb-box's image, free space, the driver it sees and NVIDIA packages from apt, and bb-box judges it", () => {
  const root = fakeRoot();
  const clean = run(root, ["check"], {}, fakeDpkg("libnvidia-egl-wayland1 deinstall ok config-files\n"));
  assert.equal(clean.status, 0, clean.err);
  const lines = clean.out.trim().split("\n");
  assert.equal(lines.at(-1), "check done");
  for (const line of ["os ubuntu 24.04", "image bb-box", "kernel-driver 580.142", "apt none"]) assert.ok(lines.includes(line), `${line} in ${clean.out}`);
  assert.match(clean.out, /^free-mib \d+$/m);
  assert.match(clean.out, /^arch \S+$/m);

  const apt = run(root, ["check"], {}, fakeDpkg("nvidia-driver-570 install ok installed\nlibnvidia-compute-570 install ok installed\ncuda-drivers-570 deinstall ok config-files\nlibc6 install ok installed\n"));
  assert.match(apt.out, /^apt nvidia-driver-570 libnvidia-compute-570 $/m);
  const judged = judgeUpdateCheck(apt.out.replace(/^arch .*$/m, "arch x86_64").replace(/^free-mib .*$/m, "free-mib 9000"), "580.142");
  assert.deepEqual(judged, { ok: false, why: "has nvidia-driver-570, libnvidia-compute-570 from apt, which NVIDIA's installer would conflict with. Remove them, or make a new box with a GPU" });

  const partial = run(root, ["check"], {}, fakeDpkg("nvidia-driver-570 hold ok installed\nlibnvidia-gl-570 install ok unpacked\nlibnvidia-extra-570 install reinstreq half-installed\nnvidia-firmware-570 purge ok not-installed\n"));
  assert.match(partial.out, /^apt nvidia-driver-570 libnvidia-gl-570:unpacked libnvidia-extra-570:half-installed,reinstreq $/m, "held, unpacked and half-installed packages all count");
  assert.deepEqual(judgeUpdateCheck(partial.out.replace(/^arch .*$/m, "arch x86_64").replace(/^free-mib .*$/m, "free-mib 9000"), "580.142"), {
    ok: false,
    why: "has nvidia-driver-570, libnvidia-gl-570 (unpacked), libnvidia-extra-570 (half-installed, reinstreq) from apt, which NVIDIA's installer would conflict with. Remove them, or make a new box with a GPU",
  });

  const failingBin = tempDir("nvidia-update-bin");
  writeFileSync(join(failingBin, "dpkg-query"), "#!/bin/sh\necho 'dpkg-query: error: parsing file /var/lib/dpkg/status' >&2\nexit 2\n");
  chmodSync(join(failingBin, "dpkg-query"), 0o755);
  const unreadable = run(root, ["check"], {}, failingBin);
  assert.equal(unreadable.status, 0, unreadable.err);
  assert.match(unreadable.out, /^apt unreadable$/m);
  assert.deepEqual(judgeUpdateCheck(unreadable.out.replace(/^arch .*$/m, "arch x86_64").replace(/^free-mib .*$/m, "free-mib 9000"), "580.142"), {
    ok: false,
    why: "did not let bb-box list its packages from apt, so bb-box cannot tell whether NVIDIA's installer would conflict with them",
  });

  const other = run(fakeRoot({ os: 'ID=debian\nVERSION_ID="12"\n', image: false, driver: null }), ["check"], {}, fakeDpkg(""));
  for (const line of ["os debian 12", "image other", "kernel-driver none"]) assert.ok(other.out.split("\n").includes(line), `${line} in ${other.out}`);
  const bare = run(fakeRoot({ os: null }), ["check"], {}, fakeDpkg(""));
  assert.equal(bare.status, 0, bare.err);
  assert.ok(bare.out.split("\n").includes("os unknown unknown"), bare.out);
  assert.ok(bare.out.trim().endsWith("check done"));
});

test("071 unit 12: the update script fetches NVIDIA's installer for exactly the driver the box sees, checks it against NVIDIA's SHA-256, keeps a good one, and refuses a mismatch or another driver", () => {
  const root = fakeRoot();
  const dir = tempDir("nvidia-update-dir");
  const base = mirror("580.142");
  const fetched = run(root, ["fetch", dir, "580.142"], { BBBOX_NVIDIA_BASE: base });
  assert.equal(fetched.status, 0, fetched.err);
  assert.equal(fetched.out, `fetched ${RUN("580.142")}\n`);
  assert.equal(readFileSync(join(dir, "artifacts", RUN("580.142")), "utf8"), "a fake NVIDIA installer\n");
  assert.equal(run(root, ["fetch", dir, "580.142"], { BBBOX_NVIDIA_BASE: base }).out, `kept ${RUN("580.142")}\n`);

  const bad = tempDir("nvidia-update-dir");
  const wrong = run(root, ["fetch", bad, "580.142"], { BBBOX_NVIDIA_BASE: mirror("580.142", "tampered\n", "0".repeat(64)) });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.err, /NVIDIA-Linux-x86_64-580\.142\.run from NVIDIA does not match NVIDIA's SHA-256/);
  assert.equal(existsSync(join(bad, "artifacts", RUN("580.142"))), false);
  assert.equal(existsSync(join(bad, "artifacts", `${RUN("580.142")}.part`)), false);

  const other = run(root, ["fetch", tempDir("nvidia-update-dir"), "590.10"], { BBBOX_NVIDIA_BASE: mirror("590.10") });
  assert.notEqual(other.status, 0);
  assert.match(other.err, /the box sees the host's driver 580\.142, not 590\.10/);
  assert.match(run(fakeRoot({ driver: null }), ["fetch", tempDir("nvidia-update-dir"), "580.142"]).err, /the box sees no NVIDIA driver on its host/);
  assert.match(run(root, ["fetch", tempDir("nvidia-update-dir"), "580.142;rm"]).err, /580\.142;rm is not a driver version/);
});

test("071 unit 12: the update script installs with nvidia-userspace.sh, sets a desktop's display to auto, removes its files, and on a failed install changes no setting and keeps them", () => {
  const install = (status: number) => {
    const dir = tempDir("nvidia-update-dir");
    mkdirSync(join(dir, "guest"), { recursive: true });
    writeFileSync(join(dir, "guest", "nvidia-userspace.sh"), `echo "installer ran with $1" >&2\n${status ? `exit ${status}` : "echo 580.142"}\n`);
    return dir;
  };
  const desktop = fakeRoot({ desktop: "VNC_AUTH=password\nDISPLAY_MODE=cpu\n" });
  const dir = install(0);
  const done = run(desktop, ["install", dir]);
  assert.equal(done.status, 0, done.err);
  assert.equal(done.out, "display-mode auto\ninstalled 580.142\n");
  assert.equal(readFileSync(join(desktop, "etc/bb-box/desktop.env"), "utf8"), "VNC_AUTH=password\nDISPLAY_MODE=auto\n");
  assert.equal(existsSync(dir), false, "the installer and its files are removed once installed");

  const server = fakeRoot();
  assert.equal(run(server, ["install", install(0)]).out, "installed 580.142\n");
  assert.equal(existsSync(join(server, "etc/bb-box/desktop.env")), false);

  const failing = install(3);
  const failed = run(desktop, ["install", failing]);
  assert.notEqual(failed.status, 0);
  assert.equal(existsSync(failing), true, "kept for Update again");
  const unchanged = fakeRoot({ desktop: "DISPLAY_MODE=cpu\n" });
  run(unchanged, ["install", install(3)]);
  assert.equal(readFileSync(join(unchanged, "etc/bb-box/desktop.env"), "utf8"), "DISPLAY_MODE=cpu\n");
});

test("071 unit 12: bb-box puts the update script and the installer's two scripts in the box as they are in setup/", () => {
  const into = tempDir("nvidia-update-into");
  const command = updateFilesCommand(SETUP).replaceAll(UPDATE_DIR, into);
  const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(into, "nvidia-userspace-update.sh"), "utf8"), readFileSync(SCRIPT, "utf8"));
  assert.equal(readFileSync(join(into, "guest", "nvidia-userspace.sh"), "utf8"), readFileSync(join(GUEST, "nvidia-userspace.sh"), "utf8"));
  assert.equal(readFileSync(join(into, "guest", "bb-box-nvidia-drivers.sh"), "utf8"), readFileSync(join(GUEST, "bb-box-nvidia-drivers.sh"), "utf8"));
  assert.ok(fetchCommand("580.142", SETUP).includes(readFileSync(SCRIPT).toString("base64")), "they go in with the download, the first step that changes the box");
  assert.equal(updateScriptText(SETUP), readFileSync(SCRIPT, "utf8"));
});

const reading = (file: string, library: string, at = 2): UserspaceReading => ({ file, library, hostDriver: "580.142", at }) as UserspaceReading;
const update = (state: UserspaceUpdate["state"], step: UserspaceUpdate["step"]): UserspaceUpdate => ({ from: "570.86", to: "580.142", at: 1, state, step, ms: null, error: "cut" });

test("071 unit 12: a reading of the version file and libnvidia-ml's version, which disagree when the userspace is half-installed", () => {
  assert.deepEqual(judgeReading("file 570.86\nlibrary /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.570.86\nuserspace read\n", "580.142", 5), reading("570.86", "570.86", 5));
  assert.deepEqual(judgeReading("file 570.86\nlibrary none\nuserspace read\n", null, 5), { ...reading("570.86", "none", 5), hostDriver: null });
  assert.deepEqual(judgeReading("file none\nlibrary none\nuserspace read\n", null, 5), { ...reading("none", "none", 5), hostDriver: null });
  assert.deepEqual(judgeReading("file garbage\nlibrary /usr/lib/libnvidia-ml.so.1\nuserspace read\n", null, 5), { ...reading("none", "none", 5), hostDriver: null });
  assert.equal(judgeReading("file 570.86\nlibrary none\n", null, 5), null, "a reading that did not finish is none");
});

test("071 unit 12: bb-box's check of a box refuses, before anything changes, another architecture, another image, too little space, another driver, and a check it could not run as root", () => {
  const check = (changes: Record<string, string>) =>
    judgeUpdateCheck(
      Object.entries({ arch: "x86_64", os: "ubuntu 24.04", image: "bb-box", "free-mib": "9000", "kernel-driver": "580.142", apt: "none", ...changes })
        .map(([key, value]) => `${key} ${value}`)
        .concat("check done")
        .join("\n"),
      "580.142",
    );
  assert.deepEqual(check({}), { ok: true, processes: [] });
  assert.deepEqual(check({ arch: "aarch64" }), { ok: false, why: "runs on aarch64, and NVIDIA's userspace is for x86_64 boxes only" });
  for (const changes of [{ os: "debian 12" }, { image: "other" }] as Record<string, string>[]) {
    assert.deepEqual(check(changes), { ok: false, why: "is not on bb-box's own Linux image (Ubuntu 24.04 on x86_64), where bb-box knows NVIDIA's installer works" });
  }
  assert.deepEqual(check({ "free-mib": "900" }), { ok: false, why: "has 900 MiB free in /var/tmp, and NVIDIA's installer and its files need 2 GiB" });
  assert.deepEqual(check({ "kernel-driver": "570.86" }), { ok: false, why: "sees the host's NVIDIA driver as 570.86, not 580.142 as the host reports it" });
  assert.deepEqual(judgeUpdateCheck("sudo: a password is required\n", "580.142"), { ok: false, why: "lets bb-box run nothing as root (sudo: a password is required)" });
  assert.deepEqual(judgeUpdateCheck("arch x86_64\n", "580.142"), { ok: false, why: "did not finish bb-box's check", transient: true });
  const busy = judgeUpdateCheck("arch x86_64\nos ubuntu 24.04\nimage bb-box\nfree-mib 9000\nkernel-driver 580.142\napt none\ngpu-process 3310 python3\ngpu-process 812 Xorg\ncheck done\n", "580.142");
  assert.deepEqual(busy, { ok: true, processes: [{ pid: 3310, name: "python3" }, { pid: 812, name: "Xorg" }] });
});

test("071 unit 12: what an update says first names the versions and the programs that have the GPU open", () => {
  const processes = [3310, 3311, 3312, 3313, 3314].map((pid) => ({ pid, name: "python3" }));
  assert.equal(planWords("lone-pine", reading("none", "none"), "580.142", []), "bb-box installs NVIDIA's userspace 580.142 in lone-pine, where it has none, then restarts it. Everything running in it stops.");
  assert.equal(
    planWords("lone-pine", reading("570.86", "none"), "580.142", processes),
    "bb-box installs NVIDIA's userspace 580.142 in lone-pine, over its half-installed userspace (libraries none, version file 570.86), then restarts it. Everything running in it stops: python3 (3310), python3 (3311), python3 (3312) and python3 (3313), and 1 more have the GPU open.",
  );
});

test("071 unit 12: a box's userspace state: updating, half-installed, an update that did not finish, another version, the host's, not checked and a host driver not known", () => {
  assert.equal(userspaceState(reading("570.86", "570.86"), update("updating", "fetch"), "580.142").is, "updating");
  assert.equal(userspaceState(reading("580.142", "580.142"), update("unknown", "install"), "580.142").is, "unfinished");
  assert.equal(userspaceState(reading("570.86", "none"), update("failed", "install"), "580.142").is, "half");
  assert.equal(userspaceState(reading("570.86", "none"), null, "580.142").is, "half", "named whoever half-installed it");
  assert.equal(userspaceState(reading("580.142", "580.142"), update("failed", "restart"), "580.142").is, "unfinished");
  assert.equal(userspaceState(reading("580.142", "580.142"), update("failed", "check"), "580.142").is, "unfinished");
  assert.equal(userspaceState(reading("570.86", "570.86"), update("failed", "fetch"), "580.142").is, "unfinished", "a failed download is named until an update finishes");
  assert.equal(userspaceState(reading("570.86", "570.86"), update("failed", "install"), "580.142").is, "unfinished", "so is an install cut short before it changed anything");
  assert.deepEqual(userspaceState(reading("570.86", "570.86"), null, "580.142"), { is: "differs", version: "570.86", driver: "580.142" });
  assert.deepEqual(userspaceState(reading("580.142", "580.142"), update("done", "check"), "580.142"), { is: "matches", version: "580.142" });
  assert.deepEqual(userspaceState(null, null, "580.142"), { is: "not-checked" });
  assert.deepEqual(userspaceState(reading("570.86", "570.86"), null, null), { is: "driver-unknown", version: "570.86" });
  assert.equal(
    agentUserspaceWords("swift-owl", { is: "differs", version: "none", driver: "580.142" }),
    "nvidia-smi in swift-owl fails: it has no NVIDIA userspace, and the host's driver is 580.142. Ask the user to update it.",
  );
  assert.equal(agentUserspaceWords("swift-owl", { is: "matches", version: "580.142" }), null);
});

test("071 unit 12: an update cut short is settled by the next reading: failed, at the restart where its install had finished", () => {
  assert.deepEqual(settledUpdate(update("updating", "install"), reading("580.142", "580.142")), {});
  assert.deepEqual(settledUpdate(update("unknown", "install"), reading("580.142", "580.142")).userspaceUpdate && { state: "failed", step: "restart" }, { state: "failed", step: "restart" });
  const half = settledUpdate(update("unknown", "install"), reading("570.86", "none")).userspaceUpdate!;
  assert.equal(half.step, "install");
  assert.equal(half.error, "cut When bb-box read the box again, it had a half-installed NVIDIA userspace: no NVIDIA libraries and a version file that says 570.86.");
});

test("071 unit 12: the checks after an update's restart: a card listed with CUDA working, and a desktop drawing and encoding on the GPU", () => {
  assert.deepEqual(judgeAnyCard("GPU-3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00, Fake RTX, 24576\ncuinit 0\nuserspace 580.142\ncard check done\n"), { ok: true });
  assert.deepEqual(judgeAnyCard("Failed to initialize NVML: Driver/library version mismatch\ncuinit 999\n"), { ok: false, why: "nvidia-smi in it listed no card (Failed to initialize NVML: Driver/library version mismatch / cuinit 999)" });
  const desktop = (changes: Record<string, string>) =>
    judgeDesktopCheck(
      Object.entries({ "ready-wait": "30", "display-mode": "gpu", "display-reason": "DISPLAY_MODE=auto", "selkies-http": "200", video: '{"frames":12}', nvenc: "yes", "nvenc-sessions": "0 1", ...changes })
        .map(([key, value]) => `${key} ${value}`)
        .concat("desktop check done")
        .join("\n"),
    );
  assert.equal(desktop({}), null);
  assert.equal(desktop({ "display-mode": "cpu", "display-reason": "host NVIDIA driver '580.142' does not match the template's '570.86'" }), "its desktop came up on the CPU (host NVIDIA driver '580.142' does not match the template's '570.86')");
  assert.equal(desktop({ video: '{"frames":0}' }), 'its desktop\'s video sent no frames 30 s after its start: Selkies answered on 127.0.0.1:5980, but its stream sent bb-box\'s probe no video ({"frames":0})');
  assert.equal(desktop({ nvenc: "no" }), "its desktop's video is not encoded with NVENC");
  assert.equal(judgeDesktopCheck("display-mode gpu\n"), "the desktop's check did not finish");
  assert.equal(desktop({ "display-mode": "none" }), "its display had not started 30 s after its start");
  assert.equal(desktop({ "selkies-http": "000" }), "its desktop's video was not ready 30 s after its start: Selkies on 127.0.0.1:5980 did not answer");
  assert.equal(desktop({ "selkies-http": "502" }), "its desktop's video was not ready 30 s after its start: Selkies on 127.0.0.1:5980 answered HTTP 502");
  assert.equal(desktop({ "nvenc-sessions": "1 1" }), "its desktop's video is not encoded with NVENC: its card's encoder sessions did not rise while bb-box's probe watched it (1 before, 1 during)");
  assert.equal(desktop({ "nvenc-sessions": "none none" }), "bb-box could not read its card's encoder sessions in the box, so it cannot tell that its video is encoded with NVENC");
});

function desktopBin(curlAnswersFrom: number | null): { readonly bin: string; readonly pgrepArgs: string } {
  const bin = tempDir("desktop-check-bin");
  const calls = join(bin, "curl-calls");
  const pgrepArgs = join(bin, "pgrep-args");
  const answer = curlAnswersFrom === null ? 'printf 000; exit 7' : `n=$(( $(cat "${calls}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${calls}"; if [ "$n" -ge ${curlAnswersFrom} ]; then printf 200; else printf 000; exit 7; fi`;
  writeFileSync(join(bin, "curl"), `#!/bin/sh\n${answer}\n`);
  const sessions = join(bin, "sessions");
  const probes = join(bin, "probes");
  writeFileSync(join(bin, "node"), `#!/bin/sh\necho 1 > "${sessions}"\nsleep 2\necho 0 > "${sessions}"\nn=$(( $(cat "${probes}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${probes}"\nif [ "$n" -ge 2 ]; then echo '{"frames":7,"keys":1,"kbytes":10}'; else echo '{"frames":0,"keys":0,"kbytes":0}'; fi\n`);
  writeFileSync(join(bin, "nvidia-smi"), `#!/bin/sh\ncat "${sessions}" 2>/dev/null || echo 0\n`);
  writeFileSync(join(bin, "pgrep"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${pgrepArgs}"\n`);
  for (const name of ["curl", "node", "nvidia-smi", "pgrep"]) chmodSync(join(bin, name), 0o755);
  return { bin, pgrepArgs };
}

function desktopCheck(root: string, bin: string, waitS: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", DESKTOP_GPU_CHECK], { env: { ...process.env, BB_BOX_ROOT: root, BB_BOX_READY_WAIT_S: String(waitS), PATH: `${bin}:${process.env.PATH}` } });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

test("071 unit 10, the gate's finding: the desktop's check after a restart waits, up to its bound, for the display and for Selkies to answer, then judges its video; and it reads NVENC only in Selkies' own process", async () => {
  const root = tempDir("desktop-check-root");
  mkdirSync(join(root, "run", "bb-box"), { recursive: true });
  const late = desktopBin(2);
  const checking = desktopCheck(root, late.bin, 20);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  writeFileSync(join(root, "run", "bb-box", "display-mode"), "gpu\n");
  const out = await checking;
  assert.match(out, /^display-mode gpu$/m, "it waited for the display to start");
  assert.match(out, /^selkies-http 200$/m, "and for Selkies, which answered on its second try");
  assert.equal(judgeDesktopCheck(out), "its desktop's video is not encoded with NVENC", "then it judged the video");
  assert.match(out, /^nvenc-sessions 0 1$/m, "and read the card's encoder sessions before and while its probe streamed");
  assert.match(out, /^video \{"frames":7,/m, "its first probe got no frames, as from a stream not yet flowing, so it probed again");
  const asked = readFileSync(late.pgrepArgs, "utf8").split("\n");
  assert.ok(asked.includes("-f") && asked.includes(SELKIES_PROCESS), `NVENC is looked for in Selkies' own process: ${asked.join(" ")}`);
  assert.ok(!asked.includes("python3"), "not in any python3");

  const never = desktopBin(null);
  assert.equal(judgeDesktopCheck(await desktopCheck(root, never.bin, 1)), "its desktop's video was not ready 1 s after its start: Selkies on 127.0.0.1:5980 did not answer");
  const empty = tempDir("desktop-check-empty");
  assert.equal(judgeDesktopCheck(await desktopCheck(empty, desktopBin(1).bin, 1)), "its display had not started 1 s after its start");
});

test("071 unit 12: bb-box's commands run as root through one wrapper, its quoting kept, and its check runs whole from its script on stdin, writing nothing in the box", { skip: process.getuid?.() !== 0 ? "needs root, as bb-box's commands in a box do" : false }, () => {
  const quoted = spawnSync("bash", ["-c", asRoot(`printf '%s|%s\\n' "it's" "$(id -u)"`)], { encoding: "utf8" });
  assert.equal(quoted.status, 0, quoted.stderr);
  assert.equal(quoted.stdout, "it's|0\n");
  assert.equal(UPDATE_CHECK.includes(UPDATE_DIR), false, "the check writes nothing in the box: its script comes on stdin");
  const check = spawnSync("bash", ["-c", UPDATE_CHECK], { input: updateScriptText(SETUP), encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /^arch \S+\nos .+\nimage (bb-box|other)\nfree-mib \d+\nkernel-driver \S+\napt .+\n(gpu-process \d+ .+\n)*check done\n$/);
});

function lockedRoot(): { readonly root: string; readonly lock: string } {
  const root = fakeRoot();
  return { root, lock: join(root, "run", "bb-box-nvidia-update.lock") };
}

function readingWithLock(lock: string): string {
  const result = spawnSync("bash", ["-c", USERSPACE_READ.replaceAll(UPDATE_LOCK, lock)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("071 unit 12: the update holds a lock in the box while it fetches and installs, which the installer's own processes keep while they run, so a second update is refused and a reading says one is still running", async () => {
  const { root, lock } = lockedRoot();
  const dir = tempDir("nvidia-update-dir");
  const pidFile = join(tempDir("nvidia-update-orphan"), "orphan.pid");
  mkdirSync(join(dir, "guest"), { recursive: true });
  writeFileSync(join(dir, "guest", "nvidia-userspace.sh"), `setsid sleep 30 < /dev/null > /dev/null 2>&1 &\necho $! > ${pidFile}\necho 580.142\n`);
  const first = run(root, ["install", dir]);
  assert.equal(first.status, 0, first.err);
  const orphan = Number(readFileSync(pidFile, "utf8"));
  try {
    assert.equal(updateRunning(readingWithLock(lock)), true, "an installer left running, as one bb-box's restart did not stop, keeps the lock");
    const again = run(root, ["install", tempDir("nvidia-update-dir")]);
    assert.notEqual(again.status, 0);
    assert.match(again.err, /an earlier update of NVIDIA's userspace is still running in this box/);
    const fetch = run(root, ["fetch", tempDir("nvidia-update-dir"), "580.142"], { BBBOX_NVIDIA_BASE: mirror("580.142") });
    assert.notEqual(fetch.status, 0);
    assert.match(fetch.err, /still running in this box/);
  } finally {
    process.kill(orphan, "SIGKILL");
  }
  for (let i = 0; i < 100 && updateRunning(readingWithLock(lock)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(lock), true, "the lock file stays behind");
  assert.equal(updateRunning(readingWithLock(lock)), false, "a lock whose last holder died is no lock: the kernel drops it with its holder");
  const later = run(root, ["fetch", tempDir("nvidia-update-dir"), "580.142"], { BBBOX_NVIDIA_BASE: mirror("580.142") });
  assert.equal(later.status, 0, later.err);
});

test("071 unit 12: a reading reports no update running where there is no lock file, or one no process holds", () => {
  const { lock } = lockedRoot();
  assert.equal(updateRunning(readingWithLock(lock)), false);
  writeFileSync(lock, "");
  assert.equal(updateRunning(readingWithLock(lock)), false);
  assert.match(readingWithLock(lock), /^file \S+\nlibrary \S+\nuserspace read\n$/);
});

test("071 unit 12: the update's check reports an earlier update still running, and bb-box refuses on it", async () => {
  const { root, lock } = lockedRoot();
  writeFileSync(lock, "");
  const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 100 && !updateRunning(readingWithLock(lock)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const held = run(root, ["check"], {}, fakeDpkg(""));
    assert.equal(held.status, 0, held.err);
    assert.match(held.out, /^update running$/m);
    assert.deepEqual(judgeUpdateCheck(held.out.replace(/^arch .*$/m, "arch x86_64").replace(/^free-mib .*$/m, "free-mib 9000"), "580.142"), {
      ok: false,
      why: "is still running an earlier update of NVIDIA's userspace, which must end before bb-box starts another",
      transient: true,
    });
  } finally {
    process.kill(-holder.pid!, "SIGKILL");
  }
  for (let i = 0; i < 100 && updateRunning(readingWithLock(lock)); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotMatch(run(root, ["check"], {}, fakeDpkg("")).out, /update running/);
});
