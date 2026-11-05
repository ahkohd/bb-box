// bb box setup docker: what the Box panel's first run does, for an agent or a terminal (the setup plan's PR 5).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImageBuild } from "../src/plugin/docker-images.ts";
import { everyAddressPort, reachableUrl, setupDocker, type SetupDockerDeps } from "../src/plugin/setup-docker.ts";
import type { MachineSetup } from "../src/plugin/setup-offer.ts";

function machine(overrides: Partial<MachineSetup> = {}): MachineSetup {
  return { hostId: "host_bb", name: "devpc", here: true, state: "ready", docker: "29.8.1", problem: null, fix: null, restart: null, kvm: "ok", freeGb: 120, build: null, took: {}, ...overrides };
}

const BUILT: ImageBuild = { state: "built", targets: ["linux"], detail: null, startedAt: 0, endedAt: 540_000 };

function deps(machines: MachineSetup[], more: Partial<SetupDockerDeps> = {}) {
  const calls: string[] = [];
  const all: SetupDockerDeps = {
    setups: async () => machines,
    setDockerHost: async (hostId, enabled, linuxOnly) => {
      calls.push(`docker ${hostId} ${enabled} ${linuxOnly}`);
      return { ok: true, state: {} as never, problems: [] };
    },
    ensure: async (hostId) => {
      calls.push(`ensure ${hostId}`);
      return BUILT;
    },
    machineAccess: async () => null,
    glanceMs: 10,
    ...more,
  };
  return { all, calls };
}

test("it turns Docker on, Linux image alone, on the machine that runs BB, and waits for the build", async () => {
  const { all, calls } = deps([machine({ hostId: "host_far", name: "far", here: false }), machine()]);
  const result = await setupDocker(all, { wait: true });
  assert.deepEqual(calls, ["docker host_bb true true", "ensure host_bb"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "Docker on devpc is set up for BB Box. The Linux image built in 9 min.\nMake a box with box_acquire, or with the plus in a thread's Box panel.\n");
});

test("--machine picks a machine by name or ID, and names those that can when it is none of them", async () => {
  const { all, calls } = deps([machine(), machine({ hostId: "host_far", name: "Far", here: false })]);
  assert.equal((await setupDocker(all, { machine: "far", wait: true })).exitCode, 0);
  assert.deepEqual(calls.slice(0, 1), ["docker host_far true true"]);
  const missing = await setupDocker(all, { machine: "nowhere", wait: true });
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.stderr, "BB has no machine nowhere that can host boxes. These can: devpc, Far.\n");
});

test("where BB's user cannot use Docker, it gives the machine's own lines, says what the restart does, and turns nothing on", async () => {
  const { all, calls } = deps([machine({ state: "fix", problem: "Docker is on this machine, but BB's user, dev, cannot use it.", fix: "sudo usermod -aG docker dev", restart: "sudo systemctl restart user@1000.service" })]);
  const result = await setupDocker(all, { wait: true });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr!, /^Docker is on this machine, but BB's user, dev, cannot use it\.\n\nOn devpc, run:\n  sudo usermod -aG docker dev\n  sudo systemctl restart user@1000\.service\nThe second line restarts all of that user's services/);
  assert.match(result.stderr!, /\n\nThen run bb box setup docker again\.\n$/);
  assert.deepEqual(calls, []);
});

test("with no machine that has Docker, it says why for each and what to do", async () => {
  const { all } = deps([machine({ state: "none", docker: null }), machine({ hostId: "host_off", name: "attic", here: false, state: "offline", docker: null, problem: "The machine is offline in BB." })]);
  const result = await setupDocker(all, { wait: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "No BB machine has Docker that BB Box can use. devpc: no Docker; attic: The machine is offline in BB. Install Docker Engine on one, or set up another backend in BB Box's settings.\n");
});

test("--no-wait says how far the build is; a failed build says why; BB's machine access that will not let boxes join is said too", async () => {
  let resolve!: (build: ImageBuild) => void;
  const running = machine({ state: "on", build: { state: "building", targets: ["linux"], detail: null, step: { at: 3, of: 9 }, startedAt: 0, endedAt: null } });
  const { all } = deps([running], {
    ensure: () => new Promise((done) => (resolve = done)),
    now: () => 125_000,
    machineAccess: async () => ({ provider: "bb connect", message: "Sign in to your bb account to use bb connect" }),
  });
  const glance = await setupDocker(all, { wait: false });
  assert.equal(
    glance.stdout,
    "Docker on devpc is on for BB Box. Building the Linux image on devpc, step 3 of 9, started 2 min ago. Run bb box setup docker again to wait for it, or with --no-wait to see how far it is.\n" +
      "Boxes will not join BB yet. Sign in to your bb account in BB, or set Machine access to Manual in BB's settings, under Machines, with an address boxes can reach, and have BB listen there: started with npx bb-app, add --server-bind-host 0.0.0.0. From a terminal: bb settings general machineServerUrl http://<address>:<port>, then bb settings general defaultMachineAccess direct.\n",
  );
  const waiting = setupDocker(all, { wait: true });
  await new Promise((done) => setTimeout(done, 5));
  resolve({ state: "failed", targets: ["linux"], detail: "build.sh exited with 1: no space left on device", startedAt: 0, endedAt: 60_000 });
  const failed = await waiting;
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stderr, "Docker on devpc is on for BB Box, but the Linux image did not build, after 1 min: build.sh exited with 1: no space left on device\n");
});

test("it says it is waiting before the build ends", async () => {
  const said: string[] = [];
  let release!: (build: ImageBuild) => void;
  const { all } = deps([machine()], {
    ensure: () => new Promise((done) => (release = done)),
    say: (line) => said.push(line),
  });
  const waiting = setupDocker(all, { wait: true });
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(said, ["Docker on devpc: waiting for its images."]);
  release(BUILT);
  assert.equal((await waiting).exitCode, 0);
});

test("when BB listens on every address it asks before setting machine access, and --set-machine-access does it", async () => {
  const set: string[] = [];
  const offer = {
    listening: async () => ({ port: 4777, url: "http://10.0.0.8:4777" }),
    machineAccess: async () => ({ provider: "direct", message: "Machine access is not set" }),
    setDirectAccess: async (url: string) => void set.push(url),
  };
  const { all } = deps([machine()], offer);
  const asked = await setupDocker(all, { wait: true });
  assert.equal(set.length, 0);
  assert.match(asked.stdout ?? "", /Run again with --set-machine-access to set Machine access to direct at http:\/\/10\.0\.0\.8:4777/);
  const done = await setupDocker(all, { wait: true, setAccess: true });
  assert.deepEqual(set, ["http://10.0.0.8:4777"]);
  assert.match(done.stdout ?? "", /Set Machine access to direct at http:\/\/10\.0\.0\.8:4777/);
});

test("a listen on 0.0.0.0 is that port, and the URL is an address that is not the machine's own", () => {
  const tcp = "  sl  local_address rem_address   st tx_queue rx_queue\n   0: 0100007F:1A2B 00000000:0000 0A 00000000:00000000\n   1: 00000000:12A5 00000000:0000 0A 00000000:00000000\n";
  assert.equal(everyAddressPort(tcp), 0x12a5);
  assert.equal(everyAddressPort("  sl  local_address\n"), null);
  assert.equal(reachableUrl(4777, ["127.0.0.1", "10.0.0.8"]), "http://10.0.0.8:4777");
  assert.equal(reachableUrl(4777, ["127.0.0.1"]), null);
});
