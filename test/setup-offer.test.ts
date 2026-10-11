// First-run setup: what each BB machine offers, and the line that fixes what stands in the way.

import assert from "node:assert/strict";
import { test } from "node:test";
import { restartFor, type SetupFacts } from "../src/host/relay.ts";
import type { DockerHostView } from "../src/plugin/docker-hosts.ts";
import { machineSetups } from "../src/plugin/setup-offer.ts";

function host(overrides: Partial<DockerHostView> = {}): DockerHostView {
  return { hostId: "host_a", name: "devpc", connected: true, docker: { version: "29.8.1", os: "Ubuntu 24.04", arch: "x86_64", cpus: 16, memoryMiB: 65536 }, problem: null, absent: false, backend: null, images: null, ...overrides };
}

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return { hostname: "devpc", user: "var", socketGroup: "docker", inSocketGroup: true, restart: "sudo systemctl restart user@1000.service", kvm: "ok", freeGb: 120, ...overrides };
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
