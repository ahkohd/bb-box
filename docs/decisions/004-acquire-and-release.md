# 004: Acquire and release, for virtual and real machines

Status: accepted, 30 September 2026.

## Context

Some providers make machines on demand: containers, VMs and cloud instances.
Others lend machines that already exist: a Mac on a desk, a pool of PCs, any
host reachable over SSH. An interface built on create and destroy fits only
the first group.

## Decision

- The backend interface is acquire and release.
- Every backend declares whether its boxes are virtual or real.

| | Virtual | Real |
| --- | --- | --- |
| Acquire | make and start a guest, or take a ready one from the warm pool | claim a free machine from the pool |
| Release | delete the guest | reset the machine and return it to the pool |
| Capacity | host resources and slots | free machines |
| Held by | one box | one box at a time |

- A warm pool of ready virtual boxes and a pool of real machines share one
  implementation: members that are ready and that no box holds.
- A real backend never creates or destroys a machine. If its reset fails, the
  machine is held back from the pool and flagged for the operator.

## Consequences

- The panel and tools say "reset and returned" for a real box, not "deleted".
- A real box starts from a clean home directory, not necessarily a clean
  operating system, unless the machine can be reimaged or snapshotted. Each
  real backend documents what its reset restores.
- The conformance suite tests acquire and release for both natures.
