import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUEST = join(ROOT, "setup/proxmox-lxc/template/guest");
const HELPER = join(GUEST, "docker-first-start.sh");
const DOCKERD_PID = "4242";
const NO_STALL = "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";

interface FakeStart {
  readonly seconds: number;
  readonly dockerdState: "D" | "S";
  readonly answers?: boolean;
  readonly cpuStallUsDuringStart?: number;
  readonly stealTicksDuringStart?: number;
  readonly dockerCpuUs?: number;
}

function cpuLine(total: number, steal: number): string {
  const idle = total - steal;
  return `cpu  0 0 0 ${idle} 0 0 0 ${steal} 0 0\n`;
}

function fakeBox(start: FakeStart): string {
  const dir = tempDir("docker-first-start");
  const bin = join(dir, "bin");
  const cgroup = join(dir, "cgroup/system.slice");
  const proc = join(dir, "proc");
  mkdirSync(bin);
  mkdirSync(join(dir, "systemd"));
  mkdirSync(join(proc, DOCKERD_PID, "task", DOCKERD_PID), { recursive: true });
  for (const unit of ["containerd.service", "docker.service"]) {
    mkdirSync(join(cgroup, unit), { recursive: true });
    writeFileSync(join(cgroup, unit, "cgroup.procs"), unit === "docker.service" ? `${DOCKERD_PID}\n` : "");
    writeFileSync(join(cgroup, unit, "cpu.pressure"), NO_STALL);
    writeFileSync(join(cgroup, unit, "cpu.stat"), `usage_usec ${unit === "docker.service" ? (start.dockerCpuUs ?? 0) : 0}\n`);
  }
  writeFileSync(join(proc, "stat"), cpuLine(10_000, 0));
  writeFileSync(join(proc, DOCKERD_PID, "task", DOCKERD_PID, "stat"), `${DOCKERD_PID} (dockerd) ${start.dockerdState} 1 1 1 0 -1\n`);
  const cpuStall = start.cpuStallUsDuringStart ?? 0;
  const steal = start.stealTicksDuringStart ?? 0;
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
[ "$1" = --version ] && exit 0
sleep ${start.seconds}
printf 'some avg10=0.00 avg60=0.00 avg300=0.00 total=${cpuStall}\\n' > "${join(cgroup, "docker.service/cpu.pressure")}"
printf '${cpuLine(10_000 + Math.max(steal * 2, 1), steal).trim()}\\n' > "${join(proc, "stat")}"
${start.answers === false ? 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1' : "echo 29.1.3"}
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "systemctl"), '#!/bin/bash\necho system.slice\n', { mode: 0o755 });
  return dir;
}

function judge(dir: string, limitMs: number) {
  const ran = spawnSync("bash", [HELPER], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      BBBOX_DOCKER_START_LIMIT_MS: String(limitMs),
      BBBOX_CGROUP_ROOT: join(dir, "cgroup"),
      BBBOX_PROC_ROOT: join(dir, "proc"),
      BBBOX_SYSTEMD_RUN_DIR: join(dir, "systemd"),
    },
  });
  return { status: ran.status, line: `${ran.stdout}${ran.stderr}`.trim() };
}

function ownMs(line: string): number {
  return Number(/^(\d+) ms of its own/.exec(line)?.[1] ?? Number.NaN);
}

test("a start slowed by its host's disk passes: the time Docker waited for the disk is not its own", () => {
  const box = fakeBox({ seconds: 0.9, dockerdState: "D" });

  const judged = judge(box, 400);

  assert.equal(judged.status, 0, judged.line);
  assert.match(judged.line, /^\d+ ms of its own \(limit 400\), of (\d+) ms, (\d+) ms of it waiting for the host's disk or CPU$/);
  assert.ok(ownMs(judged.line) < 400, judged.line);
});

test("a start that waits for something other than its host fails, as a broken socket activation does", () => {
  const box = fakeBox({ seconds: 0.9, dockerdState: "S" });

  const judged = judge(box, 400);

  assert.equal(judged.status, 1, judged.line);
  assert.ok(ownMs(judged.line) >= 800, judged.line);
});

test("the time Docker waited for a CPU, and the time its host took its CPUs, are not its own", () => {
  const waiting = fakeBox({ seconds: 0.9, dockerdState: "S", cpuStallUsDuringStart: 700_000 });
  const stolen = fakeBox({ seconds: 0.9, dockerdState: "S", stealTicksDuringStart: 500, dockerCpuUs: 700_000 });

  const forCpu = judge(waiting, 400);
  const forSteal = judge(stolen, 400);

  assert.equal(forCpu.status, 0, forCpu.line);
  assert.equal(forSteal.status, 0, forSteal.line);
});

test("Docker that does not answer through its socket fails, and says so", () => {
  const box = fakeBox({ seconds: 0, dockerdState: "S", answers: false });

  const judged = judge(box, 2000);

  assert.equal(judged.status, 1);
  assert.match(judged.line, /^Docker did not answer through its socket: Cannot connect to the Docker daemon/);
});

test("the limit stays 041's 2 s of Docker's own time", () => {
  const box = fakeBox({ seconds: 0, dockerdState: "S" });

  const judged = spawnSync("bash", [HELPER], { encoding: "utf8", env: { PATH: `${join(box, "bin")}:/usr/bin:/bin`, BBBOX_CGROUP_ROOT: join(box, "cgroup"), BBBOX_PROC_ROOT: join(box, "proc"), BBBOX_SYSTEMD_RUN_DIR: join(box, "systemd") } });

  assert.equal(judged.status, 0, judged.stdout);
  assert.match(judged.stdout, /\(limit 2000\)/);
});

test("every Linux image's checks time the first docker command with the helper customize-base installs", () => {
  const base = readFileSync(join(GUEST, "customize-base.sh"), "utf8");
  assert.match(base, /install -m 0755 "\$build\/guest\/docker-first-start\.sh" \/usr\/local\/libexec\/bb-box\/docker-first-start/);

  for (const check of ["check-headless.sh", "check-desktop.sh", "check-desktop-wayland.sh"]) {
    const line = readFileSync(join(GUEST, check), "utf8").split("\n").find((each) => each.startsWith('d "first docker command"'));
    assert.equal(line, 'd "first docker command" /usr/local/libexec/bb-box/docker-first-start', check);
  }
});
