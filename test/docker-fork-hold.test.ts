import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const FORK_HOLD = fileURLToPath(new URL("../setup/docker/fork-hold", import.meta.url));
const DOCKER_START = fileURLToPath(new URL("../setup/docker/start", import.meta.url));
const DOCKERFILE = fileURLToPath(new URL("../setup/docker/Dockerfile", import.meta.url));
const FORK = "bxfork0000001";
const STILL_HELD_AFTER_MS = 600;

interface Guest {
  readonly root: string;
  readonly script: string;
}

function guest(): Guest {
  const root = tempDir("fork-hold");
  const script = join(root, "fork-hold");
  const text = readFileSync(FORK_HOLD, "utf8").replaceAll("/run/bb-box/", `${root}/run/bb-box/`).replaceAll("/var/lib/bb-box/", `${root}/var/lib/bb-box/`);
  writeFileSync(script, text, { mode: 0o755 });
  return { root, script };
}

function hold(at: Guest, env: Readonly<Record<string, string>>): ChildProcess {
  return spawn("bash", [at.script], { env: { PATH: process.env.PATH, ...env }, stdio: "ignore" });
}

function ended(child: ChildProcess, withinMs: number): Promise<number | null | "still held"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("still held"), withinMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function release(at: Guest, value: string): void {
  mkdirSync(join(at.root, "var/lib/bb-box"), { recursive: true });
  writeFileSync(join(at.root, "var/lib/bb-box/fork-released"), value);
}

const held = (at: Guest) => existsSync(join(at.root, "run/bb-box/held"));

test("a box that is not a held fork goes past the hold at once and writes no hold", async () => {
  const at = guest();

  const code = await ended(hold(at, { BBBOX_IDENTITY: FORK }), 5_000);

  assert.equal(code, 0);
  assert.equal(held(at), false);
});

test("a held fork says it is held and waits until BB Box releases it as its own box, then goes on", async (t) => {
  const at = guest();
  const child = hold(at, { BBBOX_FORK_HOLD: "1", BBBOX_IDENTITY: FORK });
  t.after(() => child.kill("SIGKILL"));

  assert.equal(await ended(child, STILL_HELD_AFTER_MS), "still held");
  assert.equal(held(at), true, "it wrote /run/bb-box/held, which BB Box waits for before its check");

  release(at, FORK);

  assert.equal(await ended(child, 5_000), 0);
  assert.equal(held(at), false);
});

test("a held fork stays held when the release it finds names another box, such as the source it was copied from", async (t) => {
  const at = guest();
  release(at, "bxsource00001");
  const child = hold(at, { BBBOX_FORK_HOLD: "1", BBBOX_IDENTITY: FORK });
  t.after(() => child.kill("SIGKILL"));

  assert.equal(await ended(child, STILL_HELD_AFTER_MS), "still held");
  assert.equal(held(at), true);
});

test("a held fork with no identity value stays held, even with an empty release", async (t) => {
  const at = guest();
  release(at, "");
  const child = hold(at, { BBBOX_FORK_HOLD: "1", BBBOX_IDENTITY: "" });
  t.after(() => child.kill("SIGKILL"));

  assert.equal(await ended(child, STILL_HELD_AFTER_MS), "still held");
});

test("a fork BB Box released goes past the hold at once at each later start", async () => {
  const at = guest();
  release(at, FORK);

  const code = await ended(hold(at, { BBBOX_FORK_HOLD: "1", BBBOX_IDENTITY: FORK }), 5_000);

  assert.equal(code, 0);
  assert.equal(held(at), false);
});

test("a Docker box holds right after its identity reset, before it starts any service or says it is ready", () => {
  const start = readFileSync(DOCKER_START, "utf8");
  const reset = start.indexOf('bb-box-identity boot --value "${BBBOX_IDENTITY:-}"');
  const holdAt = start.indexOf("/usr/local/libexec/bb-box/fork-hold &");
  const services = ['rm -f "$home"/.bb-machines/*/daemon.lock.lock', "systemd-socket-activate", "dbus-daemon", "/usr/local/libexec/bb-box/display", 'touch "$run/ready"'];

  assert.ok(reset > 0 && holdAt > reset, "the hold comes after the identity reset");
  for (const service of services) assert.ok(start.indexOf(service) > holdAt, `${service} comes after the hold`);
  assert.match(start.slice(holdAt), /^\/usr\/local\/libexec\/bb-box\/fork-hold &\nif ! wait \$!; then\n[^\n]*\n  exit 1\nfi/, "a failed hold starts nothing");
});

test("every Docker image installs the hold and says so in its labels, as the snapshots of its boxes carry them", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const images = dockerfile.split(/^FROM /m).filter((stage) => stage.includes("CMD [\"/usr/local/sbin/bb-box-start\"]"));

  assert.equal(images.length, 3);
  for (const image of images) {
    assert.match(image, /^COPY --chmod=0755 docker\/fork-hold \/usr\/local\/libexec\/bb-box\/fork-hold$/m);
    assert.match(image, /^LABEL .*bbbox\.fork-hold="1"/m);
  }
});
