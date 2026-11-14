import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUEST = join(ROOT, "setup/proxmox-lxc/template/guest");
const HELPER = join(GUEST, "docker-first-start.sh");
const TEST_LIMIT_MS = 400;
const TEST_DEADLINE_MS = 3000;
const DEADLINE_OUT_OF_REACH_MS = 60_000;
const DEADLINE_IN_PLAY = { BBBOX_DOCKER_START_DEADLINE_MS: String(TEST_DEADLINE_MS) };
const SLOW_START_S = 0.9;
const HELD_BY_ANOTHER_UNIT_S = 3;
const KILL_GRACE_MS = 1000;
const SCHEDULING_SLACK_MS = 700;
const DOCKER_REFUSED = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

type Start = number | "refuse" | "hang" | "hang ignoring TERM" | "hang leaving a helper that ignores TERM";

interface FakeBox {
  readonly dir: string;
  readonly runtime: "systemd" | "no systemd";
}

const supervisors: ChildProcess[] = [];

after(() => {
  for (const supervisor of supervisors) process.kill(-supervisor.pid!, "SIGKILL");
});

function dockerScript(dir: string, starts: readonly Start[]): string {
  const cases = starts.map((start, index) => `  ${index + 1}) ${startBody(dir, start)} ;;`).join("\n");
  return `#!/bin/bash
[ "$1" = --version ] && { [ -e "${join(dir, "version-hangs")}" ] && exec sleep 1000; echo "Docker version 29.1.3"; exit 0; }
n=$(( $(cat "${join(dir, "starts")}") + 1 ))
echo "$n" > "${join(dir, "starts")}"
case $n in
${cases}
esac
echo 29.1.3
`;
}

function startBody(dir: string, start: Start): string {
  if (typeof start === "number") return `sleep ${start}`;
  if (start === "refuse") return `printf '\\n%s\\n' "${DOCKER_REFUSED}" >&2; exit 1`;
  if (start === "hang") return `echo $$ > "${join(dir, "hung")}"; exec sleep 1000`;
  if (start === "hang ignoring TERM") return `trap '' TERM; sleep 1000 & echo "$$ $!" > "${join(dir, "hung")}"; wait`;
  return `(trap '' TERM; exec sleep 1000) & echo "$!" > "${join(dir, "hung")}"; exec sleep 1000`;
}

function fakeBox(starts: readonly Start[], runtime: FakeBox["runtime"] = "systemd"): FakeBox {
  const dir = tempDir("docker-first-start");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "systemd"));
  writeFileSync(join(dir, "starts"), "0");
  writeFileSync(join(dir, "stops"), "");

  writeFileSync(join(bin, "docker"), dockerScript(dir, starts), { mode: 0o755 });
  writeFileSync(join(bin, "sudo"), '#!/bin/bash\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/bash
if [ "$1" = stop ]; then echo "$*" >> "${join(dir, "stops")}"; exit 0; fi
if [ -e "${join(dir, "stop-hangs")}" ]; then echo deactivating; else echo inactive; fi
`,
    { mode: 0o755 },
  );
  return { dir, runtime };
}

async function superviseDockerSocket(box: FakeBox): Promise<void> {
  const script = join(box.dir, "bb-box-start");
  writeFileSync(
    script,
    `#!/bin/bash
while :; do
  rm -f "$1"
  "$4" -e 'require("node:net").createServer().listen(process.argv[1])' "$1" &
  echo $! > "$2"
  until [ -S "$1" ]; do sleep 0.01; done
  echo listening >> "$3"
  wait
  sleep 0.2
done
`,
    { mode: 0o755 },
  );

  const supervisor = spawn("bash", [script, join(box.dir, "docker.sock"), join(box.dir, "docker.pid"), join(box.dir, "listens"), process.execPath], { detached: true, stdio: "ignore" });
  supervisors.push(supervisor);
  while (!existsSync(join(box.dir, "listens"))) await delay(20);
}

interface Judged {
  readonly status: number | null;
  readonly line: string;
  readonly ms: number;
}

function judge(box: FakeBox, env: Record<string, string> = {}): Promise<Judged> {
  const began = performance.now();
  const helper = spawn("bash", [HELPER], {
    env: {
      PATH: `${join(box.dir, "bin")}:/usr/bin:/bin`,
      BBBOX_DOCKER_START_LIMIT_MS: String(TEST_LIMIT_MS),
      BBBOX_DOCKER_START_DEADLINE_MS: String(DEADLINE_OUT_OF_REACH_MS),
      BBBOX_SYSTEMD_RUN_DIR: join(box.dir, box.runtime === "systemd" ? "systemd" : "no-systemd"),
      BBBOX_DOCKER_SOCKET: join(box.dir, "docker.sock"),
      BBBOX_DOCKER_PID_FILE: join(box.dir, "docker.pid"),
      ...env,
    },
  });

  let output = "";
  helper.stdout.on("data", (chunk) => (output += chunk));
  helper.stderr.on("data", (chunk) => (output += chunk));
  return new Promise((resolve) => helper.on("close", (status) => resolve({ status, line: output.trim(), ms: performance.now() - began })));
}

function lines(box: FakeBox, name: string): string[] {
  return readFileSync(join(box.dir, name), "utf8").split("\n").filter(Boolean);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertEnded(box: FakeBox): Promise<void> {
  const pids = readFileSync(join(box.dir, "hung"), "utf8").trim().split(" ").map(Number);
  for (let tries = 0; tries < 50 && pids.some(running); tries++) await delay(20);
  assert.deepEqual(pids.filter(running), [], "the check leaves nothing of the command running");
}

test("a quick first start passes at once, and Docker is not stopped again", async () => {
  const box = fakeBox([0]);

  const judged = await judge(box);

  assert.equal(judged.status, 0, judged.line);
  assert.match(judged.line, /^answered in \d+ ms \(limit 400 ms\)$/);
  assert.deepEqual(lines(box, "stops"), []);
});

test("a slow first start passes when a second first start is quick, and the line gives both times", async () => {
  const box = fakeBox([SLOW_START_S, 0]);

  const judged = await judge(box);

  assert.equal(judged.status, 0, judged.line);
  const times = /^answered in (\d+) ms at a second first start; the first took (\d+) ms, slowed by a cold or busy host \(limit 400 ms\)$/.exec(judged.line);
  assert.ok(times, judged.line);
  assert.ok(Number(times[1]) <= TEST_LIMIT_MS && Number(times[2]) >= SLOW_START_S * 1000, judged.line);
  assert.deepEqual(lines(box, "stops"), ["stop --no-block docker.service containerd.service"]);
});

test("an activation held 3 s by another unit fails, as it holds both first starts, under 041's 2 s limit", async () => {
  const box = fakeBox([HELD_BY_ANOTHER_UNIT_S, HELD_BY_ANOTHER_UNIT_S]);

  const judged = await judge(box, { BBBOX_DOCKER_START_LIMIT_MS: "", BBBOX_DOCKER_START_DEADLINE_MS: "" });

  assert.equal(judged.status, 1, judged.line);
  assert.match(judged.line, /^slow both times: 3\d{3} ms, then 3\d{3} ms at a second first start \(limit 2000 ms\)$/);
});

test("a missing socket fails at once with Docker's own message", async () => {
  const box = fakeBox(["refuse"]);

  const judged = await judge(box);

  assert.equal(judged.status, 1, judged.line);
  assert.equal(judged.line, `refused the connection or has no socket: ${DOCKER_REFUSED}`);
  assert.deepEqual(lines(box, "stops"), []);
});

test("a hung daemon, a command that ignores TERM and a helper that ignores it are each ended by the deadline", async () => {
  const hangs = [
    { start: "hang", endsAtMs: TEST_DEADLINE_MS - KILL_GRACE_MS },
    { start: "hang ignoring TERM", endsAtMs: TEST_DEADLINE_MS },
    { start: "hang leaving a helper that ignores TERM", endsAtMs: TEST_DEADLINE_MS - KILL_GRACE_MS },
  ] as const;
  const boxes = hangs.map((hang) => fakeBox([hang.start]));

  const judged = await Promise.all(boxes.map((box) => judge(box, DEADLINE_IN_PLAY)));

  for (const [index, each] of judged.entries()) {
    assert.equal(each.status, 1, each.line);
    assert.match(each.line, /^no answer within 3 s, so the check stopped the command$/);
    assert.ok(Math.abs(each.ms - hangs[index]!.endsAtMs) <= SCHEDULING_SLACK_MS, `${hangs[index]!.start}: ${each.ms} ms`);
    await assertEnded(boxes[index]!);
  }
});

test("the check runs no docker command before the one it times, so a hung docker --version cannot hold it", async () => {
  const box = fakeBox([0]);
  writeFileSync(join(box.dir, "version-hangs"), "");

  const judged = await judge(box, DEADLINE_IN_PLAY);

  assert.equal(judged.status, 0, judged.line);
  assert.ok(judged.ms < TEST_DEADLINE_MS - KILL_GRACE_MS, `${judged.ms} ms`);
});

test("a slow first start whose Docker does not stop again fails by the deadline", async () => {
  const box = fakeBox([SLOW_START_S, 0]);
  writeFileSync(join(box.dir, "stop-hangs"), "");

  const judged = await judge(box, DEADLINE_IN_PLAY);

  assert.equal(judged.status, 1, judged.line);
  assert.match(judged.line, /^answered in \d+ ms \(limit 400 ms\), then did not stop within 3 s for a second first start$/);
  assert.ok(judged.ms <= TEST_DEADLINE_MS + SCHEDULING_SLACK_MS, `${judged.ms} ms`);
});

test("a slow second first start fails, and so does one that is refused", async () => {
  const slow = fakeBox([SLOW_START_S, SLOW_START_S]);
  const refused = fakeBox([SLOW_START_S, "refuse"]);

  const [slowJudged, refusedJudged] = await Promise.all([judge(slow), judge(refused)]);

  assert.equal(slowJudged.status, 1, slowJudged.line);
  assert.match(slowJudged.line, /^slow both times: \d+ ms, then \d+ ms at a second first start \(limit 400 ms\)$/);
  assert.equal(refusedJudged.status, 1, refusedJudged.line);
  assert.match(refusedJudged.line, /^refused the connection or has no socket at a second first start, after \d+ ms at the first: Cannot connect/);
});

test("without systemd, as in a Docker box, a quick first start passes and leaves Docker running", async () => {
  const box = fakeBox([0], "no systemd");
  await superviseDockerSocket(box);
  const dockerd = Number(readFileSync(join(box.dir, "docker.pid"), "utf8"));

  const judged = await judge(box);

  assert.equal(judged.status, 0, judged.line);
  assert.ok(running(dockerd));
  assert.deepEqual(lines(box, "listens"), ["listening"]);
});

test("without systemd, a slow first start stops Docker's daemon, waits for bb-box-start to listen again, then times a second", async () => {
  const box = fakeBox([SLOW_START_S, 0], "no systemd");
  await superviseDockerSocket(box);
  const dockerd = Number(readFileSync(join(box.dir, "docker.pid"), "utf8"));

  const judged = await judge(box);

  assert.equal(judged.status, 0, judged.line);
  assert.match(judged.line, /^answered in \d+ ms at a second first start; the first took \d+ ms, slowed by a cold or busy host \(limit 400 ms\)$/);
  assert.equal(running(dockerd), false);
  assert.deepEqual(lines(box, "listens"), ["listening", "listening"]);
  assert.deepEqual(lines(box, "stops"), []);
});

test("every Linux image's checks time the first docker command with the helper customize-base installs", () => {
  const base = readFileSync(join(GUEST, "customize-base.sh"), "utf8");
  assert.match(base, /install -m 0755 "\$build\/guest\/docker-first-start\.sh" \/usr\/local\/libexec\/bb-box\/docker-first-start/);

  for (const check of ["check-headless.sh", "check-desktop.sh", "check-desktop-wayland.sh"]) {
    const line = readFileSync(join(GUEST, check), "utf8").split("\n").find((each) => each.startsWith('d "first docker command"'));
    assert.equal(line, 'd "first docker command" /usr/local/libexec/bb-box/docker-first-start', check);
  }
});
