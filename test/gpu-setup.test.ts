import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CARD_A, CARD_B, FakeNode, REPORT_VMID, cardLines, marker } from "./gpu-helper/node.ts";
import { tempDir } from "./helpers.ts";

const HOST = new URL("../setup/proxmox-lxc/host/", import.meta.url).pathname;
const SETUP_BIN = new URL("./gpu-helper/setup-bin", import.meta.url).pathname;
const FAKE_PVE = new URL("./gpu-helper", import.meta.url).pathname;
const AS_ROOT = process.getuid?.() === 0 ? false : "setup-gpu.sh runs as root, as CI's container does";
const RELEASED_VERSION = "use constant VERSION => '0.1.0';";

const STALE_REPORT = [
  "#bb-box%3A each GPU's memory and its claims, from bb-box-gpu on this host. Do not edit.",
  "#",
  "#    at 1000",
  "#    helper bb-box-gpu 0.1.0 protocol 1 writes off pve-container 6.1.14 tested",
].join("\n");

function releaseWith(name: string, edits: readonly (readonly [from: string, to: string])[]): string {
  const dir = tempDir(`gpu-release-${name}`);
  for (const file of readdirSync(HOST)) {
    copyFileSync(join(HOST, file), join(dir, file));
    chmodSync(join(dir, file), statSync(join(HOST, file)).mode);
  }
  let program = readFileSync(join(dir, "bb-box-gpu"), "utf8");
  for (const [from, to] of edits) {
    assert.ok(program.includes(from), `bb-box-gpu has ${from}`);
    program = program.replace(from, to);
  }
  writeFileSync(join(dir, "bb-box-gpu"), program);
  return dir;
}

function versioned(version: string, protocol = 1): (readonly [string, string])[] {
  return [
    [RELEASED_VERSION, `use constant VERSION => '${version}';`],
    ["use constant PROTOCOL => 1;", `use constant PROTOCOL => ${protocol};`],
  ];
}

const QUICK_HEARTBEAT: readonly [string, string] = ["use constant REPORT_BEAT_SECONDS => 60;", "use constant REPORT_BEAT_SECONDS => 2;"];
const WRITES_NO_REPORT: readonly [string, string] = ["use constant REPORT_VM_NAME => 'bb-box-gpu-memory';", "use constant REPORT_VM_NAME => 'no-such-vm';"];

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
    this.node.guest(214, { box: "bx214", kind: "linux-desktop", marker: marker("shared", CARD_A, 1), lines: cardLines(CARD_A, "desktop"), running: true });
    this.node.guest(215, { box: "bx215", kind: "linux-desktop", lines: cardLines(CARD_B, "desktop") });
    this.node.guest(216, { box: "bx216", marker: marker("shared", CARD_B, 2) });
    copyFileSync(join(HOST, "bb-box-gpu-memory"), this.node.file("usr/local/sbin/bb-box-gpu-memory"));
    chmodSync(this.node.file("usr/local/sbin/bb-box-gpu-memory"), 0o755);
    for (const unit of ["bb-box-gpu-memory.service", "bb-box-gpu-memory.timer"]) copyFileSync(join(HOST, unit), this.node.file(`etc/systemd/system/${unit}`));
    for (const flag of ["bb-box-gpu-memory.timer.enabled", "bb-box-gpu-memory.timer.active"]) writeFileSync(this.state(flag), "");
  }

  state(name: string): string {
    return this.node.file(`run/fake-systemd/${name}`);
  }

  run(script: string, args: readonly string[] = [], env: Readonly<Record<string, string | null>> = {}, release = HOST) {
    const merged = Object.fromEntries(Object.entries({ ...this.env, ...env }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const result = spawnSync("bash", [join(release, script), ...args], { encoding: "utf8", env: merged, timeout: 90_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  setup(args: readonly string[] = [], env: Readonly<Record<string, string | null>> = {}, release = HOST) {
    return this.run("setup-gpu.sh", args, env, release);
  }

  setupLater(args: readonly string[] = [], env: Readonly<Record<string, string>> = {}, release = HOST): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const child = spawn("bash", [join(release, "setup-gpu.sh"), ...args], { env: { ...this.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
  }

  writers(): string[] {
    return [...(this.active("bb-box-gpu.service") ? ["bb-box-gpu"] : []), ...(this.active("bb-box-gpu-memory.timer") ? ["bb-box-gpu-memory.timer"] : [])];
  }

  backupKept(): boolean {
    return existsSync(this.node.file("var/lib/bb-box-gpu/setup-backup"));
  }

  systemctl(...args: string[]): number | null {
    return spawnSync("bash", [join(SETUP_BIN, "systemctl"), ...args], { env: this.env, timeout: 30_000 }).status;
  }

  calls(): string[] {
    const file = this.state("calls");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  }

  forgetCalls(): void {
    rmSync(this.state("calls"), { force: true });
    rmSync(this.state("calls-made"), { force: true });
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

  reportFile(): string {
    return this.node.file(`etc/pve/nodes/pve/qemu-server/${REPORT_VMID}.conf`);
  }

  staleReport(): void {
    writeFileSync(this.reportFile(), `${STALE_REPORT}\n${readFileSync(this.reportFile(), "utf8")}`);
  }

  helperAt(): number {
    const text = readFileSync(this.reportFile(), "utf8");
    return /^#\s*helper bb-box-gpu /m.test(text) ? Number(/^#\s*at (\d+)$/m.exec(text)?.[1] ?? 0) : 0;
  }

  helperLine(): string | null {
    return /^#\s*(helper bb-box-gpu .*)$/m.exec(readFileSync(this.reportFile(), "utf8"))?.[1] ?? null;
  }

  installedVersion(): string | null {
    const file = this.node.file("usr/local/sbin/bb-box-gpu");
    return existsSync(file) ? (/^use constant VERSION => '([^']+)';$/m.exec(readFileSync(file, "utf8"))?.[1] ?? null) : null;
  }

  guests(): Record<string, string> {
    const dir = this.node.file("etc/pve/nodes/pve/lxc");
    return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]));
  }

  conf(): string {
    return readFileSync(this.node.file("etc/bb-box/gpu.conf"), "utf8");
  }

  touchedNoGuest(before: Record<string, string>): void {
    assert.deepEqual(this.guests(), before, "every guest's config is as it was");
    assert.deepEqual(this.node.guestWrites(), [], "no guest was written");
    assert.deepEqual(this.node.guestLocks(), [], "no guest's config lock was taken");
  }

  stop(): void {
    for (const file of readdirSync(this.node.file("run/fake-systemd")).filter((name) => name.endsWith(".pid"))) {
      try {
        process.kill(Number(readFileSync(this.state(file), "utf8")), "SIGKILL");
      } catch {}
    }
  }
}

function hosted(name: string, body: (host: Host) => void | Promise<void>): void {
  test(name, { skip: AS_ROOT }, async () => {
    const host = new Host();
    try {
      await body(host);
    } finally {
      host.stop();
    }
  });
}

hosted("setup-gpu.sh starts the helper and retires the timer only once the helper has written a fresh report; a second run changes nothing; the pools already there are kept and this install's added (Astra 2, Opus 1, Opus 10)", (host) => {
  host.node.write("etc/bb-box/gpu.conf", "pools other\nwrites on\n");
  chmodSync(host.node.file("etc/bb-box/gpu.conf"), 0o600);
  host.staleReport();
  const guests = host.guests();
  const started = Math.floor(Date.now() / 1000);
  const first = host.setup();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const calls = host.calls();
  const restart = calls.indexOf("start bb-box-gpu.service");
  const retire = calls.findIndex((call) => /^disable --now --quiet bb-box-gpu-memory\.timer$/.test(call));
  assert.ok(restart >= 0 && retire > restart, `the helper starts before the timer is retired: ${calls.join(" | ")}`);
  assert.ok(host.helperAt() >= started, "the report the handover waited for is this install's, not the stale one");
  assert.match(first.stdout, /setup-gpu\.sh: VM 9190's report: helper bb-box-gpu 0\.1\.0 protocol 1 writes off pve-container 6\.1\.14 tested\n/);
  assert.match(first.stdout, /setup-gpu\.sh: VM 9190's report: serves other bbbox\n/);
  assert.match(first.stdout, /wrote .*gpu\.conf: pools other bbbox, writes off \(it said writes on, which this release does not run\)/);
  assert.equal(host.conf(), "pools other bbbox\nwrites off\n");
  assert.equal(host.timerInstalled(), false);
  assert.ok(host.active("bb-box-gpu.service") && host.enabled("bb-box-gpu.service") && host.enabled("bb-box-gpu-boot.service"));
  assert.match(readFileSync(host.state("bb-box-gpu.service.log"), "utf8"), /with writes off whatever the settings say \(--dry-run\)/);

  const second = host.setup();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /setup-gpu\.sh: nothing changed\n$/);
  assert.equal(host.calls().filter((call) => call === "start bb-box-gpu.service").length, 1, "the second run does not restart the helper");
  host.touchedNoGuest(guests);
});

hosted("when the helper writes no fresh report, setup-gpu.sh stops it, keeps the timer and exits 1; an earlier install's helper line does not count (Astra 2, Opus 1)", (host) => {
  host.staleReport();
  const result = host.setup([], { FAKE_PVE_REFUSE_WRITE: `qemu ${REPORT_VMID}` });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /bb-box-gpu 0\.1\.0 wrote no fresh, healthy report with writes off in VM 9190 within 6 s, so bb-box-gpu is stopped and disabled, and bb-box-gpu-memory\.timer writes the report/);
  assert.ok(host.timerInstalled(), "the timer's files stay");
  assert.ok(host.enabled("bb-box-gpu-memory.timer") && host.active("bb-box-gpu-memory.timer"));
  assert.equal(host.active("bb-box-gpu.service"), false);
  assert.equal(host.enabled("bb-box-gpu.service"), false);
});

hosted("a timer that cannot be stopped during the handover stops the helper, and setup-gpu.sh exits 1 (Astra 2)", (host) => {
  const result = host.setup([], { FAKE_SYSTEMCTL_FAIL: "disable bb-box-gpu-memory.timer" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /bb-box-gpu-memory\.timer could not be stopped, so bb-box-gpu is stopped and disabled/);
  assert.ok(host.timerInstalled());
  assert.equal(host.active("bb-box-gpu.service"), false);
  assert.equal(host.helperLine(), null, "the timer wrote its own report once the helper stopped, so no stopped helper's lines are left (Opus 3)");
});

hosted("--remove puts the timer back before it stops the helper, whether the driver is loaded or not; a second --remove changes nothing; setup-gpu-report.sh does not put the timer back beside the helper (Astra 3, Opus 10)", (host) => {
  assert.equal(host.setup().status, 0);
  const ledger = readFileSync(host.node.ledgerPath(), "utf8");
  const guests = host.guests();
  const report = host.run("setup-gpu-report.sh");
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.match(report.stdout, /bb-box-gpu writes it on this host \(setup-gpu\.sh\), so bb-box-gpu-memory\.timer is not put back/);
  assert.equal(host.timerInstalled(), false);

  rmSync(host.node.file("proc/driver/nvidia"), { recursive: true, force: true });
  host.forgetCalls();
  const removed = host.setup(["--remove"]);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  const calls = host.calls();
  const enable = calls.indexOf("enable --quiet bb-box-gpu-memory.timer");
  const start = calls.indexOf("start bb-box-gpu-memory.timer");
  const wrote = calls.indexOf("start bb-box-gpu-memory.service");
  const stop = calls.indexOf("disable --now --quiet bb-box-gpu.service");
  assert.ok(enable >= 0 && start > enable && wrote > start && stop > wrote, `the timer runs and has written the report before the helper stops (Astra 2): ${calls.join(" | ")}`);
  assert.match(removed.stdout, /put back bb-box-gpu-memory\.timer, which writes the report every 15 s when a GPU's memory moves; it wrote the report before bb-box-gpu stopped/);
  assert.equal(host.helperLine(), null, "the report is the timer's");
  assert.ok(host.timerInstalled());
  assert.ok(host.enabled("bb-box-gpu-memory.timer") && host.active("bb-box-gpu-memory.timer"));
  assert.equal(existsSync(host.node.file("usr/local/sbin/bb-box-gpu")), false);
  assert.equal(host.active("bb-box-gpu.service"), false);
  assert.match(removed.stdout, /no guest's device lines or tags were changed/);
  assert.equal(readFileSync(host.node.ledgerPath(), "utf8"), ledger, "the ledger is kept");
  assert.equal(host.conf(), "pools bbbox\nwrites off\n", "gpu.conf is kept");
  const again = host.setup(["--remove"]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing changed/);
  host.touchedNoGuest(guests);
});

hosted("removed and put back, the helper starts from the kept gpu.conf and ledger and retires the timer again; the report goes on throughout", (host) => {
  assert.equal(host.setup(["--pool", "team"]).status, 0);
  const guests = host.guests();
  const claim = host.node.ledger().guests["214"]?.claim;
  assert.deepEqual(claim && [claim.part, claim.card, claim.answer], ["shared", CARD_A.uuid, "granted"], "a request needing no write is granted with writes off");
  assert.equal(host.setup(["--remove"]).status, 0);
  assert.equal(host.helperLine(), null, "the timer's own report took over");
  assert.match(readFileSync(host.reportFile(), "utf8"), /^#\s*gpu GPU-/m);

  const started = Math.floor(Date.now() / 1000);
  const back = host.setup();
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.match(back.stdout, /stopped, disabled and removed bb-box-gpu-memory\.timer/);
  assert.equal(host.conf(), "pools bbbox team\nwrites off\n");
  assert.ok(host.helperAt() >= started);
  assert.deepEqual(host.node.ledger().guests["214"]?.claim, claim, "the claim of record is the one from before the removal");
  assert.equal(host.timerInstalled(), false);
  assert.match(host.setup().stdout, /nothing changed\n$/);
  host.touchedNoGuest(guests);
});

hosted("--pool adds a pool and restarts the helper, which reports serving it; a name that cannot be a pool's, and a pool not in user.cfg yet, are said", (host) => {
  assert.equal(host.setup().status, 0);
  const guests = host.guests();
  const bad = host.setup(["--pool", "-x"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /'-x' cannot be a pool's name/);
  assert.equal(host.setup(["--pool"]).status, 2);
  assert.equal(host.conf(), "pools bbbox\nwrites off\n");

  const added = host.setup(["--pool", "team", "--pool", "bbbox", "--pool", "lab/gpu"]);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.match(added.stdout, /wrote .*gpu\.conf: pools bbbox team lab\/gpu, writes off\n/);
  assert.match(added.stdout, /pool team is not in \/etc\/pve\/user\.cfg yet; the helper serves it once it is/);
  assert.match(added.stdout, /setup-gpu\.sh: started bb-box-gpu\.service, with writes off/);
  assert.match(added.stdout, /VM 9190's report: serves bbbox team lab\/gpu\n/);
  assert.match(host.setup(["--pool", "team"]).stdout, /nothing changed\n$/);
  host.touchedNoGuest(guests);
});

hosted("--writes on is refused before anything changes; --writes off is taken; a bad value or a stray option is a usage error", (host) => {
  const refused = host.setup(["--writes", "on"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /this release runs bb-box-gpu with writes off only, a dry run\. Writes come on in a later release, once bb-box has marked its guests and a day of dry run with the markers shows no write the helper would make\. Nothing was changed\./);
  assert.deepEqual(host.calls(), [], "no systemctl call");
  assert.equal(existsSync(host.node.file("usr/local/sbin/bb-box-gpu")), false);
  assert.equal(existsSync(host.node.file("etc/bb-box/gpu.conf")), false);

  const off = host.setup(["--writes", "off"]);
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.equal(host.conf(), "pools bbbox\nwrites off\n");
  assert.match(host.setup(["--writes", "off"]).stdout, /nothing changed\n$/);
  const installed = readFileSync(host.node.file("usr/local/sbin/bb-box-gpu"));
  assert.equal(host.setup(["--writes", "on"]).status, 1);
  assert.deepEqual(readFileSync(host.node.file("usr/local/sbin/bb-box-gpu")), installed);
  assert.equal(host.conf(), "pools bbbox\nwrites off\n");
  for (const args of [["--writes", "maybe"], ["--writes"], ["--remove", "--pool", "x"], ["--remove", "--downgrade"], ["--remove", "--writes", "off"], ["--now"]]) {
    assert.equal(host.setup(args).status, 2, args.join(" "));
  }
});

hosted("an upgrade replaces the program and restarts the helper, keeps gpu.conf, the ledger and writes off, writes no guest, and leaves no moment without a writer of the report; then it changes nothing", (host) => {
  assert.equal(host.setup(["--pool", "team"]).status, 0);
  const guests = host.guests();
  const conf = host.conf();
  const claims = host.node.ledger().guests;
  const newer = releaseWith("0.1.1", versioned("0.1.1"));
  host.forgetCalls();
  const started = Math.floor(Date.now() / 1000);
  const upgrade = host.setup([], {}, newer);
  assert.equal(upgrade.status, 0, upgrade.stdout + upgrade.stderr);
  assert.match(upgrade.stdout, /installed .*\/usr\/local\/sbin\/bb-box-gpu\n/);
  assert.match(upgrade.stdout, /restarted bb-box-gpu\.service on 0\.1\.1, which was 0\.1\.0, with writes off; gpu\.conf and the ledger are kept/);
  assert.match(upgrade.stdout, /VM 9190's report: helper bb-box-gpu 0\.1\.1 protocol 1 writes off pve-container 6\.1\.14 tested/);
  assert.equal(host.installedVersion(), "0.1.1");
  assert.ok(host.helperAt() >= started);
  assert.equal(host.conf(), conf);
  assert.deepEqual(host.node.ledger().guests, claims, "the ledger's claims are as they were");
  assert.equal(host.node.ledger().protocol, 1);
  const calls = host.calls();
  const timer = calls.indexOf("start bb-box-gpu-memory.timer");
  const stop = calls.indexOf("stop bb-box-gpu.service");
  const start = calls.indexOf("start bb-box-gpu.service");
  const retire = calls.indexOf("disable --now --quiet bb-box-gpu-memory.timer");
  assert.ok(timer >= 0 && stop > timer && start > stop && retire > start, `the timer runs before the helper stops, and is retired once the new helper reports (Opus 1, Astra 1): ${calls.join(" | ")}`);
  assert.ok(!calls.some((call) => /^disable .*bb-box-gpu\.service/.test(call)), "the helper is never disabled");
  assert.match(upgrade.stdout, /started bb-box-gpu-memory\.timer while bb-box-gpu restarts, so the report has a writer throughout\n/);
  assert.match(upgrade.stdout, /stopped and removed bb-box-gpu-memory\.timer again, as bb-box-gpu writes the report\n/);
  assert.equal(host.timerInstalled(), false);
  assert.equal(host.backupKept(), false, "the backup goes once the run is done");
  assert.match(host.setup([], {}, newer).stdout, /nothing changed\n$/);
  host.touchedNoGuest(guests);
});

hosted("an older release refuses to replace a newer helper without --downgrade, changing nothing; with it, it installs and keeps the ledger", (host) => {
  const newer = releaseWith("0.2.0", versioned("0.2.0"));
  assert.equal(host.setup([], {}, newer).status, 0);
  const guests = host.guests();
  const program = readFileSync(host.node.file("usr/local/sbin/bb-box-gpu"));
  const ledger = host.node.ledger().guests;
  host.forgetCalls();
  const refused = host.setup();
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /bb-box-gpu 0\.2\.0 is installed, newer than this release's 0\.1\.0: run the newer release's setup-gpu\.sh, or give --downgrade to install 0\.1\.0\. Nothing was changed\./);
  assert.deepEqual(host.calls(), []);
  assert.deepEqual(readFileSync(host.node.file("usr/local/sbin/bb-box-gpu")), program);
  assert.ok(host.active("bb-box-gpu.service"));

  const down = host.setup(["--downgrade"]);
  assert.equal(down.status, 0, down.stdout + down.stderr);
  assert.match(down.stdout, /restarted bb-box-gpu\.service on 0\.1\.0, which was 0\.2\.0, with writes off/);
  assert.equal(host.installedVersion(), "0.1.0");
  assert.match(host.helperLine() ?? "", /^helper bb-box-gpu 0\.1\.0 protocol 1 writes off /);
  assert.deepEqual(host.node.ledger().guests, ledger);
  assert.match(host.setup().stdout, /nothing changed\n$/);
  host.touchedNoGuest(guests);
});

hosted("a ledger from a newer protocol is refused without --downgrade; with it, the ledger is set aside and the helper rebuilds it from the guests", (host) => {
  const newer = releaseWith("0.2.0-protocol-2", versioned("0.2.0", 2));
  assert.equal(host.setup([], {}, newer).status, 0);
  assert.equal(host.node.ledger().protocol, 2);
  const guests = host.guests();
  const written = host.node.ledger();
  const refused = host.setup();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /bb-box-gpu 0\.2\.0 is installed, newer than this release's 0\.1\.0/);

  rmSync(host.node.file("usr/local/sbin/bb-box-gpu"));
  const ledgerOnly = host.setup();
  assert.equal(ledgerOnly.status, 1, ledgerOnly.stdout + ledgerOnly.stderr);
  assert.match(ledgerOnly.stderr, /the ledger, .*\/var\/lib\/bb-box-gpu\/ledger, was written by protocol 2, newer than this release's protocol 1: run the newer release's setup-gpu\.sh, or give --downgrade to set the ledger aside, which bb-box-gpu 0\.1\.0 then rebuilds from the guests\. Nothing was changed\./);
  assert.equal(host.node.ledger().protocol, 2);

  const down = host.setup(["--downgrade"]);
  assert.equal(down.status, 0, down.stdout + down.stderr);
  const aside = readdirSync(host.node.file("var/lib/bb-box-gpu")).find((name) => name.startsWith("ledger.protocol-2-"));
  assert.ok(aside, "the newer ledger is kept beside");
  const kept = JSON.parse(readFileSync(host.node.file(`var/lib/bb-box-gpu/${aside}`), "utf8"));
  assert.deepEqual([kept.protocol, kept.guests], [2, written.guests]);
  assert.match(down.stdout, /set aside the ledger, written by protocol 2, as .*ledger\.protocol-2-\d+: bb-box-gpu 0\.1\.0 speaks protocol 1 and rebuilds it from the guests/);
  assert.equal(host.node.ledger().protocol, 1);
  assert.equal(host.node.ledger().guests["214"]?.claim?.answer, "granted", "the rebuilt ledger takes the marked guest whose lines match as granted");
  host.touchedNoGuest(guests);
});

hosted("an upgrade whose helper writes no fresh report puts the helper before it back as it was, with its gpu.conf, and exits 1; the timer that wrote the report meanwhile goes again", (host) => {
  const before = releaseWith("0.1.0-quick-heartbeat", [QUICK_HEARTBEAT]);
  assert.equal(host.setup([], {}, before).status, 0);
  const guests = host.guests();
  const program = readFileSync(host.node.file("usr/local/sbin/bb-box-gpu"));
  const ledger = host.node.ledger().guests;
  const broken = releaseWith("0.1.1-broken", [...versioned("0.1.1"), WRITES_NO_REPORT]);
  const started = Math.floor(Date.now() / 1000);
  const failed = host.setup(["--pool", "team"], {}, broken);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /bb-box-gpu 0\.1\.1 wrote no fresh, healthy report with writes off in VM 9190 within 6 s, so bb-box-gpu 0\.1\.0 is back as it was, with its settings and ledger/);
  assert.deepEqual(readFileSync(host.node.file("usr/local/sbin/bb-box-gpu")), program);
  assert.equal(host.conf(), "pools bbbox\nwrites off\n", "gpu.conf is as it was before the run");
  assert.ok(host.active("bb-box-gpu.service") && host.enabled("bb-box-gpu.service"));
  assert.ok(host.helperAt() >= started);
  assert.match(host.helperLine() ?? "", /^helper bb-box-gpu 0\.1\.0 /);
  assert.equal(host.timerInstalled(), false);
  assert.deepEqual(host.node.ledger().guests, ledger);
  host.touchedNoGuest(guests);
});

hosted("an upgrade whose helper and the one put back both write no report hands the report to the timer and exits 1", (host) => {
  assert.equal(host.setup().status, 0);
  const newer = releaseWith("0.1.1", versioned("0.1.1"));
  const failed = host.setup([], { FAKE_PVE_REFUSE_WRITE: `qemu ${REPORT_VMID}` }, newer);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /bb-box-gpu 0\.1\.1 wrote no fresh, healthy report with writes off in VM 9190 within 6 s, and bb-box-gpu 0\.1\.0, put back, wrote no fresh, healthy report either, so bb-box-gpu is stopped and disabled, and bb-box-gpu-memory\.timer writes the report/);
  assert.ok(host.timerInstalled() && host.enabled("bb-box-gpu-memory.timer") && host.active("bb-box-gpu-memory.timer"));
  assert.equal(host.active("bb-box-gpu.service"), false);
  assert.equal(host.installedVersion(), "0.1.0");
  assert.equal(host.helperLine(), null, "the timer's report replaced the helper's");
});

hosted("a downgrade that set a newer ledger aside, and whose helper writes no report, puts the newer helper and its ledger back", (host) => {
  const newer = releaseWith("0.2.0-protocol-2", [...versioned("0.2.0", 2), QUICK_HEARTBEAT]);
  assert.equal(host.setup([], {}, newer).status, 0);
  const written = host.node.ledger();
  const guests = host.guests();
  const broken = releaseWith("0.1.0-broken", [WRITES_NO_REPORT]);
  const failed = host.setup(["--downgrade"], {}, broken);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /so bb-box-gpu 0\.2\.0 is back as it was, with its settings and ledger/);
  assert.equal(host.installedVersion(), "0.2.0");
  assert.equal(host.node.ledger().protocol, 2);
  assert.deepEqual(host.node.ledger().guests, written.guests);
  const files = readdirSync(host.node.file("var/lib/bb-box-gpu"));
  assert.ok(files.some((name) => name.startsWith("ledger.from-0.1.0-")), `the older helper's ledger is kept beside: ${files.join(" ")}`);
  assert.ok(!files.some((name) => name.startsWith("ledger.protocol-")), "the set-aside ledger is back in place");
  assert.match(host.helperLine() ?? "", /^helper bb-box-gpu 0\.2\.0 protocol 2 /);
  host.touchedNoGuest(guests);
});

hosted("on a pve-container this release was not tested on, setup-gpu.sh says so; writes stay off", (host) => {
  writeFileSync(host.node.file("pve-container-version"), "6.1.15\n");
  const result = host.setup();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /VM 9190's report: helper bb-box-gpu 0\.1\.0 protocol 1 writes off pve-container 6\.1\.15 untested\n/);
  assert.match(result.stdout, /this release was not tested on the pve-container installed here, so its helper would change no guest on this host even with writes on/);
});

hosted("a helper stopped by hand is started again, and its report is waited for across its one-minute heartbeat, as a restart with nothing new to say writes only then", (host) => {
  assert.equal(host.setup().status, 0);
  const guests = host.guests();
  const written = host.helperAt();
  assert.equal(host.systemctl("stop", "bb-box-gpu.service"), 0);
  const again = host.setup([], { BBBOX_GPU_REPORT_WAIT: "" });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /started bb-box-gpu\.service, with writes off/);
  assert.ok(host.helperAt() > written, "a report of the restarted helper's own");
  assert.ok(host.active("bb-box-gpu.service"));
  host.touchedNoGuest(guests);
});

for (const [how, fault] of [
  ["refuses to stop it", { FAKE_SYSTEMCTL_FAIL: "stop bb-box-gpu.service" }],
  ["stops it but says it failed (Opus 1)", { FAKE_SYSTEMCTL_FAIL_AFTER: "stop bb-box-gpu.service" }],
] as const) {
  hosted(`a downgrade whose systemctl ${how} before the ledger is set aside puts every file back, with the newer helper running and the timer gone`, (host) => {
    const newer = releaseWith("0.2.0-protocol-2-quick", [...versioned("0.2.0", 2), QUICK_HEARTBEAT]);
    assert.equal(host.setup([], {}, newer).status, 0);
    const program = readFileSync(host.node.file("usr/local/sbin/bb-box-gpu"));
    const guests = host.guests();
    const result = host.setup(["--downgrade", "--pool", "team"], fault);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /bb-box-gpu\.service could not be stopped, so bb-box-gpu 0\.2\.0 is back as it was, with its settings and ledger/);
    assert.deepEqual(readFileSync(host.node.file("usr/local/sbin/bb-box-gpu")), program);
    assert.equal(host.conf(), "pools bbbox\nwrites off\n");
    assert.equal(host.node.ledger().protocol, 2);
    assert.ok(!readdirSync(host.node.file("var/lib/bb-box-gpu")).some((name) => name.startsWith("ledger.") || name.startsWith("setup-backup")), "no ledger set aside, and no backup left");
    assert.deepEqual(host.writers(), ["bb-box-gpu"]);
    assert.match(host.helperLine() ?? "", /^helper bb-box-gpu 0\.2\.0 protocol 2 /);
    assert.equal(host.timerInstalled(), false);
    host.touchedNoGuest(guests);
  });
}

const CAUGHT_EXIT: Readonly<Record<string, number>> = { TERM: 143, INT: 130, HUP: 129 };

function interrupted(result: { status: number | null; stderr: string }, signal: string, writers: readonly string[]): void {
  if (signal === "KILL") {
    assert.equal(result.status, null, "killed, so no trap runs");
    return;
  }
  assert.equal(result.status, CAUGHT_EXIT[signal], result.stderr);
  assert.match(result.stderr, new RegExp(`stopped part way, while .*\\(exit status ${CAUGHT_EXIT[signal]}\\); the report is written by ${writers.join(" and ").replace(/\./g, "\\.")}`));
}

for (const [after, signals, writers] of [
  ["start bb-box-gpu-memory.timer", ["TERM"], ["bb-box-gpu", "bb-box-gpu-memory.timer"]],
  ["stop bb-box-gpu.service", ["TERM", "INT", "HUP", "KILL"], ["bb-box-gpu-memory.timer"]],
  ["start bb-box-gpu.service", ["TERM", "KILL"], ["bb-box-gpu", "bb-box-gpu-memory.timer"]],
  ["disable bb-box-gpu-memory.timer", ["HUP", "KILL"], ["bb-box-gpu"]],
] as const) {
  hosted(`an upgrade interrupted by ${signals.join(", ")} right after "${after}" leaves a writer of the report, says which, keeps the backup, and a second run finishes it (Opus 1, Astra 1)`, (host) => {
    const newer = releaseWith("0.1.1", versioned("0.1.1"));
    for (const signal of signals) {
      assert.equal(host.setup().status, 0);
      assert.equal(host.installedVersion(), "0.1.0");
      const guests = host.guests();
      host.forgetCalls();
      const result = host.setup([], { FAKE_SYSTEMCTL_SIGNAL: `${after}=${signal}` }, newer);
      interrupted(result, signal, writers);
      assert.deepEqual(host.writers(), writers, `after ${signal}`);
      assert.ok(host.backupKept(), "the install from before is kept");
      const again = host.setup([], {}, newer);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /VM 9190's report: helper bb-box-gpu 0\.1\.1 protocol 1 writes off /);
      assert.deepEqual(host.writers(), ["bb-box-gpu"]);
      assert.equal(host.timerInstalled(), false);
      assert.equal(host.backupKept(), false);
      host.touchedNoGuest(guests);
      const back = host.setup(["--downgrade"]);
      assert.equal(back.status, 0, back.stdout + back.stderr);
    }
  });
}

hosted("--remove interrupted right after it stops the helper, by HUP or KILL, leaves the timer writing the report (Opus 1, Astra 2)", (host) => {
  for (const signal of ["HUP", "KILL"]) {
    assert.equal(host.setup().status, 0);
    host.forgetCalls();
    const result = host.setup(["--remove"], { FAKE_SYSTEMCTL_SIGNAL: `disable bb-box-gpu.service=${signal}` });
    interrupted(result, signal, ["bb-box-gpu-memory.timer"]);
    assert.deepEqual(host.writers(), ["bb-box-gpu-memory.timer"], `after ${signal}`);
    const again = host.setup(["--remove"]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(existsSync(host.node.file("usr/local/sbin/bb-box-gpu")), false);
    assert.equal(host.helperLine(), null);
  }
});

hosted("--remove stops the helper only once the timer runs and has written the report: a timer that cannot start or cannot write leaves the helper running and installed (Opus 1, Astra 2)", (host) => {
  assert.equal(host.setup().status, 0);
  const program = readFileSync(host.node.file("usr/local/sbin/bb-box-gpu"));
  const cannotStart = host.setup(["--remove"], { FAKE_SYSTEMCTL_FAIL: "start bb-box-gpu-memory.timer" });
  assert.equal(cannotStart.status, 1, cannotStart.stdout + cannotStart.stderr);
  assert.match(cannotStart.stderr, /bb-box-gpu-memory\.timer is in place, but it could not be started or wrote no report: see journalctl -u bb-box-gpu-memory; it needs nvidia-smi to work\. So bb-box-gpu was not stopped, and nothing of it was removed/);
  assert.ok(host.active("bb-box-gpu.service") && host.enabled("bb-box-gpu.service"));
  assert.deepEqual(readFileSync(host.node.file("usr/local/sbin/bb-box-gpu")), program);

  host.node.smiFails(true);
  const cannotWrite = host.setup(["--remove"]);
  assert.equal(cannotWrite.status, 1, cannotWrite.stdout + cannotWrite.stderr);
  assert.match(cannotWrite.stderr, /So bb-box-gpu was not stopped, and nothing of it was removed; run setup-gpu\.sh --remove again once the timer can write the report/);
  assert.deepEqual(host.writers(), ["bb-box-gpu", "bb-box-gpu-memory.timer"]);
  assert.ok(existsSync(host.node.file("usr/local/sbin/bb-box-gpu")));

  assert.equal(host.systemctl("stop", "bb-box-gpu.service"), 0);
  const helperStopped = host.setup(["--remove"]);
  assert.equal(helperStopped.status, 0, helperStopped.stdout + helperStopped.stderr);
  assert.match(helperStopped.stderr, /its first run once bb-box-gpu was gone wrote no report: see journalctl -u bb-box-gpu-memory; it needs nvidia-smi to work/);
  assert.equal(existsSync(host.node.file("usr/local/sbin/bb-box-gpu")), false, "a helper that was not running is removed: stopping it takes no writer away");
  assert.deepEqual(host.writers(), ["bb-box-gpu-memory.timer"]);
});

hosted("a handover after a failed rollback, killed right after it stops the helper, leaves the timer writing the report (Opus 1, Astra 2)", (host) => {
  assert.equal(host.setup().status, 0);
  const newer = releaseWith("0.1.1", versioned("0.1.1"));
  host.forgetCalls();
  const result = host.setup([], { FAKE_PVE_REFUSE_WRITE: `qemu ${REPORT_VMID}`, FAKE_SYSTEMCTL_SIGNAL: "disable bb-box-gpu.service bb-box-gpu-boot.service=KILL" }, newer);
  interrupted(result, "KILL", []);
  assert.deepEqual(host.writers(), ["bb-box-gpu-memory.timer"]);
  assert.equal(host.installedVersion(), "0.1.0", "the rollback had put 0.1.0 back");
});

hosted("a rollback interrupted right after it stops the failed helper leaves the timer writing the report, and a second run puts the helper before back from the kept install (Opus 1, Astra 1)", (host) => {
  const before = releaseWith("0.1.0-quick-heartbeat", [QUICK_HEARTBEAT]);
  assert.equal(host.setup([], {}, before).status, 0);
  const program = readFileSync(host.node.file("usr/local/sbin/bb-box-gpu"));
  const broken = releaseWith("0.1.1-broken", [...versioned("0.1.1"), WRITES_NO_REPORT]);
  host.forgetCalls();
  const result = host.setup([], { FAKE_SYSTEMCTL_SIGNAL: "stop bb-box-gpu.service#2=TERM" }, broken);
  interrupted(result, "TERM", ["bb-box-gpu-memory.timer"]);
  assert.ok(host.backupKept());
  const again = host.setup([], {}, broken);
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.match(again.stdout, /an earlier run did not finish, so the install from before it, kept in .*setup-backup, is the one a rollback puts back/);
  assert.match(again.stderr, /so bb-box-gpu 0\.1\.0 is back as it was, with its settings and ledger/);
  assert.deepEqual(readFileSync(host.node.file("usr/local/sbin/bb-box-gpu")), program);
  assert.deepEqual(host.writers(), ["bb-box-gpu"]);
  assert.equal(host.timerInstalled(), false, "the timer was not there before the first run, so it goes again");
  assert.equal(host.backupKept(), false);
});

hosted("an upgrade killed while its helper fails to report is put right by the next run, from the backup the killed run kept on disk (Astra 1)", (host) => {
  const before = releaseWith("0.1.0-quick-heartbeat", [QUICK_HEARTBEAT]);
  assert.equal(host.setup([], {}, before).status, 0);
  const program = readFileSync(host.node.file("usr/local/sbin/bb-box-gpu"));
  const broken = releaseWith("0.1.1-broken", [...versioned("0.1.1"), WRITES_NO_REPORT]);
  host.forgetCalls();
  interrupted(host.setup([], { FAKE_SYSTEMCTL_SIGNAL: "start bb-box-gpu.service=KILL" }, broken), "KILL", []);
  assert.deepEqual(host.writers(), ["bb-box-gpu", "bb-box-gpu-memory.timer"]);
  assert.ok(host.backupKept());
  const again = host.setup([], {}, broken);
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.match(again.stderr, /bb-box-gpu 0\.1\.1 wrote no fresh, healthy report with writes off in VM 9190 within 6 s, so bb-box-gpu 0\.1\.0 is back as it was/);
  assert.deepEqual(readFileSync(host.node.file("usr/local/sbin/bb-box-gpu")), program);
  assert.deepEqual(host.writers(), ["bb-box-gpu"]);
  assert.equal(host.timerInstalled(), false);
});

hosted("a rollback that fails part way under set -e leaves the timer writing the report and the backup in place; the release before then installs cleanly (Astra 1)", (host) => {
  const before = releaseWith("0.1.0-quick-heartbeat", [QUICK_HEARTBEAT]);
  assert.equal(host.setup([], {}, before).status, 0);
  const broken = releaseWith("0.1.1-broken", [...versioned("0.1.1"), WRITES_NO_REPORT]);
  host.forgetCalls();
  const result = host.setup([], { FAKE_SYSTEMCTL_FAIL_NTH: "daemon-reload#3" }, broken);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /stopped part way, while putting back bb-box-gpu 0\.1\.0 \(exit status 1\); the report is written by bb-box-gpu-memory\.timer/);
  assert.match(result.stderr, /the install from before this run is kept in .*setup-backup; run setup-gpu\.sh again/);
  assert.deepEqual(host.writers(), ["bb-box-gpu-memory.timer"]);
  const again = host.setup([], {}, before);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(host.writers(), ["bb-box-gpu"]);
  assert.equal(host.timerInstalled(), false);
});

hosted("a failed upgrade across a protocol change puts back the ledger the helper before kept, keeps the newer one beside, and the helper put back reports healthy (Opus 2, Astra 3)", async (host) => {
  const before = releaseWith("0.1.0-quick-heartbeat", [QUICK_HEARTBEAT]);
  assert.equal(host.setup([], {}, before).status, 0);
  const guests = host.guests();
  const broken = releaseWith("0.2.0-protocol-2-broken", [...versioned("0.2.0", 2), WRITES_NO_REPORT]);
  const running = host.setupLater([], {}, broken);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !host.calls().includes("start bb-box-gpu.service")) await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  host.node.mark(214, marker("shared", CARD_A, 2));
  const marked = host.guests();
  const deadlineForLedger = Date.now() + 5_000;
  while (Date.now() < deadlineForLedger && host.node.ledger().protocol !== 2) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(host.node.ledger().protocol, 2, "the newer helper wrote the ledger under its protocol while the installer waited");
  const result = await running;
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /so bb-box-gpu 0\.1\.0 is back as it was, with its settings and ledger; the ledger bb-box-gpu 0\.2\.0 wrote is kept as .*ledger\.from-0\.2\.0-\d+/);
  assert.equal(host.node.ledger().protocol, 1);
  const kept = readdirSync(host.node.file("var/lib/bb-box-gpu")).find((name) => name.startsWith("ledger.from-0.2.0-"));
  assert.equal(JSON.parse(readFileSync(host.node.file(`var/lib/bb-box-gpu/${kept}`), "utf8")).protocol, 2);
  assert.doesNotMatch(readFileSync(host.reportFile(), "utf8"), /error the ledger is protocol/);
  assert.match(host.helperLine() ?? "", /^helper bb-box-gpu 0\.1\.0 protocol 1 /);
  const rerun = host.setup([], {}, before);
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.deepEqual(host.guests(), marked);
  assert.notDeepEqual(marked, guests);
});

hosted("BBBOX_GPU_REPORT_WAIT is read from the process's environment alone, and must be a number of seconds (Opus 4)", (host) => {
  writeFileSync(host.node.file("bb-box.env"), "BBBOX_POOL=bbbox\nBBBOX_GPU_REPORT_WAIT=abc\n");
  const fromFile = host.setup([], { BBBOX_GPU_REPORT_WAIT: null });
  assert.equal(fromFile.status, 0, fromFile.stdout + fromFile.stderr);
  for (const wait of ["abc", "0", "-5", "10000"]) {
    const bad = host.setup([], { BBBOX_GPU_REPORT_WAIT: wait });
    assert.equal(bad.status, 2, wait);
    assert.match(bad.stderr, new RegExp(`BBBOX_GPU_REPORT_WAIT, from this process's environment, must be a whole number of seconds from 1 to 9999, not '${wait}'`));
  }
});

hosted("runs close together, as reruns after an interruption are, do not fall foul of systemd's start limit, which refuses a sixth start of a unit within its interval until reset-failed", (host) => {
  const limit = { FAKE_SYSTEMCTL_START_LIMIT: "5/120" };
  for (const pool of ["p1", "p2", "p3", "p4", "p5", "p6", "p7"]) {
    const result = host.setup(["--pool", pool], limit);
    assert.equal(result.status, 0, `${pool}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /started bb-box-gpu\.service, with writes off/);
  }
  assert.ok(host.calls().filter((call) => call === "reset-failed bb-box-gpu.service").length >= 7);
  for (let run = 0; run < 6; run++) {
    const removed = host.setup(["--remove"], limit);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.doesNotMatch(removed.stderr, /wrote no report/, "the timer's service is not refused either");
  }
});
