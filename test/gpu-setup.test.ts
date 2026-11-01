import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CARD_A, FakeNode, REPORT_VMID, cardLines } from "./gpu-helper/node.ts";

const HOST = new URL("../setup/proxmox-lxc/host/", import.meta.url).pathname;
const SETUP_BIN = new URL("./gpu-helper/setup-bin", import.meta.url).pathname;
const FAKE_PVE = new URL("./gpu-helper", import.meta.url).pathname;
const AS_ROOT = process.getuid?.() === 0 ? false : "setup-gpu.sh runs as root, as CI's container does";

const STALE_REPORT = [
  "#bb-box%3A each GPU's memory and its claims, from bb-box-gpu on this host. Do not edit.",
  "#",
  "#    at 1000",
  "#    helper bb-box-gpu 0.1.0 protocol 1 writes off pve-container 6.1.14 tested",
].join("\n");

class Host {
  readonly node = new FakeNode({ writes: null });
  readonly env: NodeJS.ProcessEnv;

  constructor() {
    for (const dir of ["usr/local/sbin", "etc/systemd/system", "run/fake-systemd"]) mkdirSync(this.node.file(dir), { recursive: true });
    writeFileSync(this.node.file("bb-box.env"), "BBBOX_POOL=bbbox\n");
    this.env = {
      PATH: `${SETUP_BIN}:${this.node.file("bin")}:/usr/sbin:/usr/bin:/sbin:/bin`,
      PERL5LIB: FAKE_PVE,
      BBBOX_ROOT: this.node.root,
      BBBOX_GPU_ROOT: this.node.root,
      BBBOX_ENV: this.node.file("bb-box.env"),
      BBBOX_QEMU_CONFIGS: this.node.file("etc/pve/qemu-server"),
      BBBOX_GPU_REPORT_STATE: this.node.file("run/bb-box-gpu-memory"),
      BBBOX_GPU_REPORT_WAIT: "6",
    };
    this.node.guest(214, { box: "bx214", kind: "linux-desktop", lines: cardLines(CARD_A, "desktop") });
    copyFileSync(join(HOST, "bb-box-gpu-memory"), this.node.file("usr/local/sbin/bb-box-gpu-memory"));
    chmodSync(this.node.file("usr/local/sbin/bb-box-gpu-memory"), 0o755);
    for (const unit of ["bb-box-gpu-memory.service", "bb-box-gpu-memory.timer"]) copyFileSync(join(HOST, unit), this.node.file(`etc/systemd/system/${unit}`));
    for (const flag of ["bb-box-gpu-memory.timer.enabled", "bb-box-gpu-memory.timer.active"]) writeFileSync(this.state(flag), "");
  }

  state(name: string): string {
    return this.node.file(`run/fake-systemd/${name}`);
  }

  run(script: string, args: readonly string[] = [], env: Readonly<Record<string, string>> = {}) {
    const result = spawnSync("bash", [join(HOST, script), ...args], { encoding: "utf8", env: { ...this.env, ...env }, timeout: 90_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  setup(args: readonly string[] = [], env: Readonly<Record<string, string>> = {}) {
    return this.run("setup-gpu.sh", args, env);
  }

  calls(): string[] {
    const file = this.state("calls");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  }

  enabled(unit: string): boolean {
    return existsSync(this.state(`${unit}.enabled`));
  }

  active(unit: string): boolean {
    if (unit.endsWith(".timer")) return existsSync(this.state(`${unit}.active`));
    const pid = existsSync(this.state(`${unit}.pid`)) ? Number(readFileSync(this.state(`${unit}.pid`), "utf8")) : 0;
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  timerInstalled(): boolean {
    return ["usr/local/sbin/bb-box-gpu-memory", "etc/systemd/system/bb-box-gpu-memory.timer", "etc/systemd/system/bb-box-gpu-memory.service"].every((path) => existsSync(this.node.file(path)));
  }

  staleReport(): void {
    const file = this.node.file(`etc/pve/nodes/pve/qemu-server/${REPORT_VMID}.conf`);
    writeFileSync(file, `${STALE_REPORT}\n${readFileSync(file, "utf8")}`);
  }

  helperAt(): number {
    const text = readFileSync(this.node.file(`etc/pve/nodes/pve/qemu-server/${REPORT_VMID}.conf`), "utf8");
    return /^#\s*helper bb-box-gpu /m.test(text) ? Number(/^#\s*at (\d+)$/m.exec(text)?.[1] ?? 0) : 0;
  }

  stop(): void {
    for (const file of readdirSync(this.node.file("run/fake-systemd")).filter((name) => name.endsWith(".pid"))) {
      try {
        process.kill(Number(readFileSync(this.state(file), "utf8")), "SIGKILL");
      } catch {}
    }
  }
}

test("setup-gpu.sh starts the helper and retires the timer only once the helper has written a fresh report; a second run changes nothing; the pools already there are kept and this install's added (Astra 2, Opus 1, Opus 10)", { skip: AS_ROOT }, () => {
  const host = new Host();
  try {
    host.node.write("etc/bb-box/gpu.conf", "pools other\nwrites on\n");
    chmodSync(host.node.file("etc/bb-box/gpu.conf"), 0o600);
    host.staleReport();
    const started = Math.floor(Date.now() / 1000);
    const first = host.setup();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const calls = host.calls();
    const restart = calls.indexOf("restart bb-box-gpu.service");
    const retire = calls.findIndex((call) => /^disable --now --quiet bb-box-gpu-memory\.timer$/.test(call));
    assert.ok(restart >= 0 && retire > restart, `the helper starts before the timer is retired: ${calls.join(" | ")}`);
    assert.ok(host.helperAt() >= started, "the report the handover waited for is this install's, not the stale one");
    assert.match(first.stdout, /setup-gpu\.sh: VM 9190's report: helper bb-box-gpu 0\.1\.0 protocol 1 writes off pve-container 6\.1\.14 tested/);
    assert.equal(readFileSync(host.node.file("etc/bb-box/gpu.conf"), "utf8"), "pools other bbbox\nwrites off\n");
    assert.equal(host.timerInstalled(), false);
    assert.ok(host.active("bb-box-gpu.service") && host.enabled("bb-box-gpu.service") && host.enabled("bb-box-gpu-boot.service"));
    assert.match(readFileSync(host.state("bb-box-gpu.service.log"), "utf8"), /with writes off whatever the settings say \(--dry-run\)/);

    const second = host.setup();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /setup-gpu\.sh: nothing changed\n$/);
  } finally {
    host.stop();
  }
});

test("when the helper writes no fresh report, setup-gpu.sh stops it, keeps the timer and exits 1; an earlier install's helper line does not count (Astra 2, Opus 1)", { skip: AS_ROOT }, () => {
  const host = new Host();
  try {
    host.staleReport();
    const result = host.setup([], { FAKE_PVE_REFUSE_WRITE: `qemu ${REPORT_VMID}` });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /bb-box-gpu wrote no fresh report with writes off in VM 9190 within 6 s, so bb-box-gpu is stopped and disabled, and bb-box-gpu-memory\.timer writes the report/);
    assert.ok(host.timerInstalled(), "the timer's files stay");
    assert.ok(host.enabled("bb-box-gpu-memory.timer") && host.active("bb-box-gpu-memory.timer"));
    assert.equal(host.active("bb-box-gpu.service"), false);
    assert.equal(host.enabled("bb-box-gpu.service"), false);
  } finally {
    host.stop();
  }
});

test("a timer that cannot be stopped during the handover stops the helper, and setup-gpu.sh exits 1 (Astra 2)", { skip: AS_ROOT }, () => {
  const host = new Host();
  try {
    const result = host.setup([], { FAKE_SYSTEMCTL_FAIL: "disable bb-box-gpu-memory.timer" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /bb-box-gpu-memory\.timer could not be stopped, so bb-box-gpu is stopped and disabled/);
    assert.ok(host.timerInstalled());
    assert.equal(host.active("bb-box-gpu.service"), false);
  } finally {
    host.stop();
  }
});

test("--remove puts the timer back whether the driver is loaded or not, and setup-gpu-report.sh does not put it back beside the helper (Astra 3, Opus 10)", { skip: AS_ROOT }, () => {
  const host = new Host();
  try {
    assert.equal(host.setup().status, 0);
    const report = host.run("setup-gpu-report.sh");
    assert.equal(report.status, 0, report.stdout + report.stderr);
    assert.match(report.stdout, /bb-box-gpu writes it on this host \(setup-gpu\.sh\), so bb-box-gpu-memory\.timer is not put back/);
    assert.equal(host.timerInstalled(), false);

    rmSync(host.node.file("proc/driver/nvidia"), { recursive: true, force: true });
    const removed = host.setup(["--remove"]);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.match(removed.stdout, /put back bb-box-gpu-memory\.timer/);
    assert.ok(host.timerInstalled());
    assert.ok(host.enabled("bb-box-gpu-memory.timer") && host.active("bb-box-gpu-memory.timer"));
    assert.equal(existsSync(host.node.file("usr/local/sbin/bb-box-gpu")), false);
    assert.equal(host.active("bb-box-gpu.service"), false);
    assert.match(removed.stdout, /no guest's device lines or tags were changed/);
    const again = host.setup(["--remove"]);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /nothing changed/);
  } finally {
    host.stop();
  }
});
