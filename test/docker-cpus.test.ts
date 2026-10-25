import assert from "node:assert/strict";
import { test } from "node:test";
import { allotCpus, cpusBothAllow, daemonCpusFromRefusal, formatCpuList, hostCpuRange, hostCpusFromProbe, movesOntoFreeCpus, parseCpuList, resizeCpus } from "../src/backends/docker/cpus.ts";

const HOST = hostCpuRange(8);

test("a CPU list reads and writes as Docker's --cpuset-cpus does, and anything else is no list", () => {
  assert.deepEqual(parseCpuList("0-2,5,7-8"), [0, 1, 2, 5, 7, 8]);
  assert.deepEqual(parseCpuList("3"), [3]);
  for (const text of ["", null, undefined, "2-1", "a", "1,,2"]) assert.equal(parseCpuList(text), null, String(text));
  assert.equal(formatCpuList([8, 0, 1, 2, 5, 7]), "0-2,5,7-8");
  assert.equal(formatCpuList([4]), "4");
});

test("a box takes the CPUs the fewest boxes are pinned to, the lowest first among equals (062)", () => {
  assert.deepEqual(allotCpus(HOST, [], 2), [0, 1]);
  assert.deepEqual(allotCpus(HOST, [[0, 1]], 2), [2, 3]);
  assert.deepEqual(allotCpus(HOST, [[0, 1], [2, 3], [4, 5]], 4), [0, 1, 6, 7], "the free ones first, then the least shared");
  assert.deepEqual(allotCpus(HOST, [[0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3]], 2), [4, 5], "when every CPU has a box, the least shared");
  assert.deepEqual(allotCpus(HOST, [], 12), HOST, "never more CPUs than the host has");
});

test("a resize keeps a box's CPUs, grows by the least-used and shrinks by dropping the most shared (062)", () => {
  assert.deepEqual(resizeCpus(HOST, [[2, 3]], [0, 1], 4), [0, 1, 4, 5]);
  assert.deepEqual(resizeCpus(HOST, [[0], [0], [3]], [0, 1, 2, 3], 2), [1, 2]);
  assert.deepEqual(resizeCpus(HOST, [[0, 1]], [], 2), [2, 3], "a box made before pinning is pinned at its first resize");
  assert.deepEqual(resizeCpus(HOST, [], [0, 1, 9], 2), [0, 1], "a CPU the host no longer has is dropped");
});

test("once CPUs come free, boxes sharing CPUs move onto them, keeping their count; a box that shares none stays (062)", () => {
  const boxes = [
    { id: "a", cpus: [0, 1] },
    { id: "b", cpus: [0, 1] },
    { id: "c", cpus: [2, 3] },
  ];
  assert.deepEqual(movesOntoFreeCpus(hostCpuRange(4), boxes), [], "no CPU is free");
  assert.deepEqual(movesOntoFreeCpus(HOST, boxes), [{ id: "a", cpus: [4, 5] }], "one of the two sharing moves; c shares nothing and stays");
  assert.deepEqual(movesOntoFreeCpus(hostCpuRange(5), boxes), [{ id: "a", cpus: [1, 4] }], "as far as the free CPUs go");
  assert.deepEqual(movesOntoFreeCpus(HOST, [{ id: "a", cpus: [0, 1] }], [[0, 1]]), [{ id: "a", cpus: [2, 3] }], "CPUs held by boxes it may not move count, as another install's");
  assert.deepEqual(movesOntoFreeCpus(HOST, [{ id: "a", cpus: [0, 1] }]), []);
});

test("a host's CPUs are those its containers may have, as a Docker host in an LXC container has, or 0 to its count less one without the file (062)", () => {
  assert.deepEqual(hostCpusFromProbe("27,61\n", 2), [27, 61]);
  assert.deepEqual(hostCpusFromProbe(null, 4), [0, 1, 2, 3]);
  assert.deepEqual(allotCpus([27, 61], [], 2), [27, 61]);
  assert.deepEqual(allotCpus([27, 61], [[0, 1]], 1), [27], "CPUs off the host count as none of its own");
});

test("a box on CPUs the host no longer has moves back onto it, free CPUs first, then the least used (062)", () => {
  assert.deepEqual(movesOntoFreeCpus([4, 5, 6], [{ id: "a", cpus: [0, 1] }]), [{ id: "a", cpus: [4, 5] }]);
  assert.deepEqual(movesOntoFreeCpus([4, 5], [{ id: "a", cpus: [4, 5] }, { id: "b", cpus: [0, 1] }]), [{ id: "b", cpus: [4, 5] }], "with no CPU free, onto the least used");
});

test("dockerd keeps the CPUs it had when it started, so a box is pinned to CPUs both it and the container's cgroup allow, as its refusal names them (062)", () => {
  assert.deepEqual(daemonCpusFromRefusal("Error response from daemon: Requested CPUs are not available - requested 1,23, available: 10,23,32,44-46,53,62"), [10, 23, 32, 44, 45, 46, 53, 62]);
  assert.equal(daemonCpusFromRefusal("No such image"), null);
  assert.deepEqual(cpusBothAllow([1, 23, 32], [10, 23, 32]), [23, 32]);
  assert.deepEqual(cpusBothAllow([1, 23], null), [1, 23]);
  assert.deepEqual(cpusBothAllow([1], [10]), [10], "with none in both, what dockerd takes");
});
