// First-run setup: what each BB machine offers, and the line that fixes what stands in the way.

import assert from "node:assert/strict";
import { test } from "node:test";
import { restartFor, type SetupFacts } from "../src/host/relay.ts";
import type { DockerHostView } from "../src/plugin/docker-hosts.ts";
import { dockerFix, machineAccessProblem, machineSetups, needsSignIn } from "../src/plugin/setup-offer.ts";

function host(overrides: Partial<DockerHostView> = {}): DockerHostView {
  return { hostId: "host_a", name: "devpc", connected: true, docker: { version: "29.8.1", os: "Ubuntu 24.04", arch: "x86_64", cpus: 16, memoryMiB: 65536 }, problem: null, absent: false, backend: null, images: null, ...overrides };
}

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return { hostname: "devpc", user: "dev", socketGroup: "docker", inSocketGroup: true, restart: "sudo systemctl restart user@1000.service", kvm: "ok", freeGb: 120, ...overrides };
}

test("BB's daemon restarts with new groups through its user's manager for a user service, itself for a system one, and in words when bb-box cannot tell", () => {
  assert.equal(restartFor("0::/user.slice/user-1000.slice/user@1000.service/app.slice/bb-host-daemon-bb-host_x.service\n", 1000), "sudo systemctl restart user@1000.service");
  assert.equal(restartFor("0::/system.slice/bb.service\n", 999), "sudo systemctl restart bb.service");
  assert.equal(restartFor("0::/user.slice/user-1000.slice/session-3.scope\n", 1000), null);
  assert.equal(restartFor("", 1000), null);
});

test("each BB machine's setup: the server's first, ready where Docker answers, a fix line where its user is not in the socket's group, and what is on or offline", () => {
  const hosts = [
    host({ hostId: "host_far", name: "far", docker: null, problem: "Docker did not answer: var may not use Docker's socket /var/run/docker.sock.", absent: false }),
    host({ hostId: "host_bb", name: "bb" }),
    host({ hostId: "host_on", name: "on", backend: { id: "docker:host_on", enabled: true, boxes: 2 } }),
    host({ hostId: "host_none", name: "laptop", docker: null, absent: true }),
    host({ hostId: "host_off", name: "attic", connected: false, docker: null, problem: "The machine is offline in BB." }),
  ];
  const known = new Map([
    ["host_bb", facts({ hostname: "bb-server" })],
    ["host_far", facts({ hostname: "far", user: "bb", socketGroup: "docker", inSocketGroup: false, restart: null })],
  ]);
  const setups = machineSetups(hosts, known, "bb-server");
  assert.deepEqual(
    setups.map((setup) => [setup.name, setup.here, setup.state]),
    [
      ["bb", true, "ready"],
      ["on", false, "on"],
      ["far", false, "fix"],
      ["laptop", false, "none"],
      ["attic", false, "offline"],
    ],
  );
  const far = setups.find((setup) => setup.name === "far")!;
  assert.equal(far.fix, "sudo usermod -aG docker bb");
  assert.equal(far.restart, null, "bb-box cannot tell how BB runs there, so the panel says it in words");
  assert.match(far.problem!, /^Docker is on far, but BB's user, bb, cannot use it\./);
  assert.equal(setups[0]!.docker, "29.8.1");
});

test("a machine with too little disk for the Linux image is a fix, with no line to copy", () => {
  const [setup] = machineSetups([host()], new Map([["host_a", facts({ freeGb: 6 })]]), "elsewhere");
  assert.equal(setup!.state, "fix");
  assert.equal(setup!.fix, null);
  assert.match(setup!.problem!, /needs about 10 GB free to build, and devpc has 6 GB/);
});

test("the fix for a machine's Docker holds for one in use too: BB's user outside the socket's group wherever Docker refuses it, and disk only before it is used", () => {
  const refused = host({ name: "lab", docker: null, problem: "Docker did not answer: Docker's socket refused BB's daemon.", backend: { id: "docker:lab", enabled: true, boxes: 1 } });
  assert.deepEqual(dockerFix(refused, facts({ user: "bb", inSocketGroup: false }), false), {
    problem: "Docker is on lab, but BB's user, bb, cannot use it. Add bb to the docker group, then restart BB's daemon there.",
    command: "sudo usermod -aG docker bb",
    restart: "sudo systemctl restart user@1000.service",
  });
  assert.equal(dockerFix(refused, facts({ inSocketGroup: true }), false), null, "refused for another reason: no fix bb-box knows");
  assert.equal(dockerFix({ ...refused, connected: false }, facts({ inSocketGroup: false }), false), null);
  assert.equal(dockerFix(host({ backend: { id: "docker:devpc", enabled: true, boxes: 0 } }), facts({ freeGb: 6 }), false), null, "in use, its images are built already");
  assert.match(dockerFix(host(), facts({ freeGb: 6 }), true)!.problem, /and this machine has 6 GB/);
  assert.equal(machineSetups([refused], new Map([["host_a", facts({ inSocketGroup: false })]]), "elsewhere")[0]!.state, "on", "first-run setup still counts it on");
});

test("BB's machine access stands in the way of boxes joining when the way BB uses is not available, in BB's words", () => {
  const providers = [
    { id: "bb-connect", displayName: "bb connect", availability: { status: "setup-required", message: "Sign in to your bb account to use bb connect" } },
    { id: "manual", displayName: "Manual", availability: { status: "available", serverUrl: "http://10.0.0.2:41820" } },
  ];
  assert.deepEqual(machineAccessProblem({ generalSettings: { defaultMachineAccess: null }, serverAccess: { defaultProviderId: "bb-connect", providers } }), {
    provider: "bb connect",
    message: "Sign in to your bb account to use bb connect",
  });
  assert.equal(machineAccessProblem({ generalSettings: { defaultMachineAccess: "manual" }, serverAccess: { defaultProviderId: "bb-connect", providers } }), null);
  assert.equal(machineAccessProblem(null), null, "bb-box cannot tell");
  assert.equal(needsSignIn("Enrolling box calm-otter failed: Sign in to your bb account to use bb connect"), true);
  assert.equal(needsSignIn("BB removed the machine before it connected"), false);
});
