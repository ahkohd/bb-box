# 018: Guests name their install and their box

Status: accepted, 30 September 2026. Extends
[011](011-interface-v1.md) and [016](016-changes-from-building-v1.md).

## Context

Reviewing the first build
([review of #14](https://github.com/moonstead/bb-box/pull/14#pullrequestreview-5370800411))
found three ways a box can act on a guest that is not its own:

| Case | What goes wrong |
| --- | --- |
| Two BB servers, or a smoke run and a BB server, use one Proxmox pool and VMID range | `held()` lists every guest in the pool. The sweep releases any guest whose box it has no record of when BB returns 404 for the owner thread. Each install deletes the other's boxes within one sweep, 3 min, and they take each other's warm guests. |
| A provider reuses references | Proxmox reuses a VMID once the range wraps. A box whose guest was deleted outside bb-box reads `running` again when its VMID holds a new box. The old thread's commands run there, and releasing the old box deletes the new one. |
| A crash between the claim and the clone | The claim records a VMID before the clone. If another install takes that VMID first, the record names the other install's guest, and releasing it deletes that guest. |

[016](016-changes-from-building-v1.md) protects real pools with a reset
generation. Virtual backends have no such check.

## Decision

- **Install ID.** Each bb-box install makes a random ID the first time it
  starts, for example `k3v9q2m7xa`, and keeps it in plugin storage.
  `BackendContext` gains `installId: string`.
- **Recorded on every guest.** A backend records the install ID with the
  owner from its first write, and on warm and part-made guests too. For
  Proxmox LXC, that is an `install.<id>` tag and an `install <id>` line in
  the description the clone writes.
- **`held()` returns only this install's guests.** The sweep, warm pool and
  adoption never touch a guest with another install's ID, or none. Such
  guests still count against capacity (memory, disk, VMIDs and GPU
  desktops), because they use the same host.
- **Box ID in `Guest.data`.** A backend whose references can be reused
  keeps the box ID as `Guest.data.box` from the claim on. A guest from
  `held()` carries the owner that `held()` found, or no box.
- **Check before acting.** Before acting, `power`, `start`, `stop` and
  `release` check that the guest at the reference still names this install
  and the same box, or no box for an ownerless leftover. When it does not:

  | Method | Does |
  | --- | --- |
  | `power` | returns null, so the box is marked gone |
  | `release` | nothing, as for a missing guest |
  | `start`, `stop` | throw `BackendError("gone")` |

  Real pools keep the generation check from 016.
- **Doctor.** The doctor shows this install's ID. A note lists the guests in
  the backend's scope that carry another install's ID, or none, with a count
  per ID.
- **Lost storage.** An install that lost its storage gets a new ID and
  leaves its old guests alone. The doctor note shows the old ID, and an
  operator command (for example `bb box install-id --set <id>`) takes it
  back. The next sweep then adopts or releases those guests as before.
- **Smoke runs.** `scripts/smoke.ts` uses the install ID `smoke`. It releases
  any guest of that install before it starts, so one smoke run at a time
  cleans up after the last.
- **Guests made before this record.** At its first start with this change,
  an install adds its ID to each guest that has none and is recorded as one
  of its boxes. It leaves every other guest without an ID to the doctor's
  note.

## Consequences

- A development and a production BB server can share one pool and range.
  They still compete for its capacity, and each shows the other's guests
  in the doctor.
- A deleted guest stays gone, even when its reference is reused. A stale
  release, or one after a crash, never deletes another box.
- Proxmox LXC reads the guest's config once more in `start`, `stop`,
  `release` and the panel's refresh. The sweep reads power and tags from
  the pool listing it already makes.
- The conformance suite adds two checks:
  - two instances with different install IDs on one backend leave each
    other's guests alone;
  - where the backend can reuse a reference, the old box's `power` returns
    null and its release leaves the new guest alone.
- The ID in each guest's tags or labels is not a secret, and it names no
  person or host ([010](010-publishable-by-default.md)).
