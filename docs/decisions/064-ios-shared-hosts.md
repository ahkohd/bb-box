# 064: iOS shared hosts: ios boxes as macOS users with their own device, many to a Mac

Status: accepted, 26 October 2026, with the owner's answers to its open
questions under [The owner's answers](#the-owners-answers). Revised the
same day after an independent review, answered finding by finding under
[Review answers](#review-answers). Built on the research note on
[several iOS Simulators in one macOS VM](../research/ios-shared-hosts.md),
which this note calls the research. Changes
[063](063-device-boxes.md), where each ios box is a Tart VM of its own.
[Measurements](#measurements) has every number this note gives that the
research and 063 do not.

## Context

An ios box today is a Tart VM with one booted device (063). Apple allows two
macOS VMs on a Mac, so a Mac holds two ios boxes, or one beside a macOS
box. The owner's direction: one simulator per VM is wasteful.

The research measured three ways to put several devices in one VM. It
recommended a macOS user per box in a shared VM, as the SSH pool lends a
physical Mac's users (047), and found the video encoder, not CPU or memory,
limits how many devices can be watched at once.

The lead made five decisions before this note:

1. A macOS user per box in a shared host is the default for ios boxes: its
   own device set, files, keychain, DerivedData and idb socket. A VM of its
   own stays as an opt-in, `dedicated: true`, for sudo, `brew install`, its
   own ports and its own process list.
2. Streams follow the viewer's size, not the device's, because the encoder
   is the limit.
3. A shared Tart VM has 8 cores, 32 GiB and 8 slots, with 1 to 2 made
   ahead. Apple's two-VM limit counts shared VMs too.
4. The device server in a slot runs as a LaunchDaemon with `UserName`.
5. While a shared VM is drained for an image update, ios boxes go to VMs of
   their own if Apple's limit allows, or wait with words.

The owner then set four more, while this note was written:

6. **No VM is held for iOS while nobody uses it.** A shared Tart host is
   made when an ios box needs a slot and no host has one, and is stopped
   and deleted when its last box is released. Slots are made ahead only
   while a host is up for other boxes.
7. **The pool's physical Mac is a second kind of shared host,** with no
   two-VM limit, no start, and the Mac's own encoder.
8. **Namespace Macs are a third,** made and deleted as Tart hosts are.
9. **Placement prefers** a free slot on an always-on pool Mac, then a
   running Tart or Namespace host, then a new Tart host, then a new
   Namespace host, then a VM of its own. And the note says whether a host
   should lend `macos` boxes too.

This note argues with decision 3, and finds decision 5 overtaken by
decisions 6 and 9; see
[Where this differs from the brief](#where-this-differs-from-the-brief).

## Decisions at a glance

| | Decision | Settled by |
| --- | --- | --- |
| 1 | A **device host** lends **slots**. A slot is one macOS user with one device; a box in a slot is an ios box. A host is a pool Mac, a Tart VM or a Namespace Mac | the research's option B; the owner's decisions 6 to 8 |
| 2 | A pool Mac is always on, and lends slots only while it is not lent whole. A Tart or Namespace host is made for a box, joinable while it starts, and deleted when its last box is released, decided under the host's own lock | the owner; review findings 1 and 2 |
| 3 | Each backend that lends slots answers with a graded tier; the registry chooses across backends under one lock for device placement, in the owner's order, and asks again when a claim loses its race | review finding 1; [Placing a box](#placing-a-box) |
| 4 | A slot's device is made by `simctl create` in its user, and made slim by seeding launchd_sim's store of disabled services before its first boot: 14.5 to 28.5 s in a VM, 10.4 to 12.4 s on the pool Mac, against 155 to 410 s for the list applied twice | M1 to M4, M13, POOL |
| 5 | The ios image carries two slots in a UID range of their own, so a new host's first box waits for a cold boot, not a device's making | M13, M16 |
| 6 | A slot is never lent twice. Release removes its user at once; queued sweeps remove every file its UID owns; UIDs come from ranges the image never uses | M6, M7, M17 |
| 7 | The device server and BB's daemon in a slot are LaunchDaemons with `UserName`. A slot box enrols as a BB machine with `BB_INSTALL_SKIP_SERVICE=1` and the helper's daemon | M14, M15, M16 |
| 8 | Each slot has a port range, and the host holds the common dev ports, so a box cannot reach another's server by mistake | the research: every device reaches every box's 127.0.0.1 |
| 9 | Streams are sent at a step of the device's size, the smallest that covers what the viewer draws; input is in the device's pixels; idb's stream runs only while wanted. Android keeps full size | M8, M9 |
| 10 | The encoder is the Mac's, shared by every VM on it: about 320 full-size iPhone frames a second on the Tart Mac, 375 on the pool's. A ledger per Mac caps streams, counting measured rates, giving room first to the person in control; at most two at full size | E1, M8, M11, POOL |
| 11 | `dedicated: true` asks for a VM of its own; a size, a project's ios image, a stop, a restart, a resize and the host's desktop need it. `shared: true` asks for a slot for a `macos` box | M12; review findings 11 and 12 |
| 12 | Shared becomes the ios default only once the ledger exists and bb-box's own enrolment of a slot has passed | review findings 4 and 16 |
| 13 | A host that drains for a new image still lends while no host on the new image can start | review finding 7 |
| 14 | Namespace hosts stay off: a Namespace Mac's VM has no H.264 encoder, so idb's stream sends nothing | M18 |

## The data shape

The types go in `src/core/device-host.ts`, beside 063's `src/core/device.ts`.

### Hosts

```ts
interface HostSettings {                     // a snapshot of the backend's ios-hosts setting, taken when the host is made
  readonly most: number;                     // slots making, ready or held, at most
  readonly ahead: number;                    // ready slots kept while the host holds a box
  readonly resettingMost: number;            // slots resetting at once, at most, apart from most
}

interface HostCommon {
  readonly id: string;                       // the pool machine's, the Tart VM's or the Namespace instance's name
  readonly runtime: Runtime;                 // 063's iOS runtime: Xcode, iOS build, idb_companion
  readonly cores: number;
  readonly memoryGiB: number;
  readonly settings: HostSettings;
}

type DeviceHost =
  | (HostCommon & { readonly on: "pool-mac"; readonly machine: string; readonly state: PoolMacState })
  | (HostCommon & { readonly on: "tart"; readonly mac: string; readonly vm: string; readonly state: HostState })
  | (HostCommon & { readonly on: "namespace"; readonly instance: string; readonly endsAt: number; readonly state: HostState });

type HostState =
  | { readonly is: "starting"; readonly promised: readonly string[]; readonly since: number }   // boxes that wait for it
  | { readonly is: "serving" }
  | { readonly is: "draining"; readonly why: "image" | "ending" | "operator"; readonly lends: boolean; readonly since: number }
  | { readonly is: "stopped"; readonly since: number }                                    // its VM is not running, as after the Mac restarted
  | { readonly is: "deleting"; readonly since: number }                                   // the helper's marker: every claim is refused
  | { readonly is: "failed"; readonly error: { readonly code: HostFailure; readonly words: string }; readonly since: number };

type PoolMacState =
  | { readonly is: "free" }                                                      // no box, no slot in any state
  | { readonly is: "whole"; readonly box: string }                              // lent whole, as 047
  | { readonly is: "resetting-whole"; readonly since: number }                  // 047's reset of a whole box
  | { readonly is: "slots" }                                                     // has a slot in any state; not lent whole until none is left
  | { readonly is: "out-of-service"; readonly why: string };

type HostFailure = "start-failed" | "helper-failed" | "no-slot-made";
```

What the shapes rule out:

- **A pool Mac is never deleted or started,** and lent whole or holding
  slots is one field, so it cannot do both. A Mac with any slot, even one
  resetting, is `slots`; it is `free` only when none is left.
- **A host that is starting can be joined.** `promised` lists every box
  waiting for it, up to `most`, so a burst of acquires fills one host
  instead of starting several ([Placing a box](#placing-a-box)).
- **A host being deleted lends nothing.** `deleting` is written by the
  host's helper, under its lock, in the same step that finds the last slot
  released ([Release and reset](#release-and-reset)), so no claim can land
  on it.
- **A host whose VM is not running says so.** `stopped` is what the Tart
  backend finds after a Mac restarts; it starts the VM again as it does a
  box's ([The host's life](#the-hosts-life)).
- **Only a Namespace host has an end,** `endsAt`, which box_status reads
  for every box in it, in place of the box's own.
- **Settings are a snapshot.** A host keeps the `most`, `ahead` and
  `resettingMost` it was made with. A change to the setting applies to
  hosts made after it; the pool Mac, which is never made, reads it at each
  sweep.

### Slots

```ts
interface Slot {
  readonly host: string;                     // DeviceHost.id
  readonly generation: number;               // up by one for each slot the host makes; never reused while the host lives
  readonly carried: boolean;                 // one of the image's two slots
  readonly state: SlotState;
}

const slotUser = (slot: Slot) => slot.carried ? `bbd-i${slot.generation}` : `bbd-${slot.generation}`;
const slotUid = (slot: Slot) => slot.carried ? 79990 + slot.generation : 80000 + (slot.generation % 10000);

type SlotState =
  | { readonly is: "making"; readonly step: "user" | "device" | "first-boot" | "daemons"; readonly for: string | null; readonly since: number }
  | { readonly is: "ready"; readonly device: SlotDevice; readonly booted: boolean }
  | { readonly is: "held"; readonly box: string; readonly for: "ios"; readonly device: SlotDevice; readonly since: number }
  | { readonly is: "held"; readonly box: string; readonly for: "macos"; readonly since: number }
  | { readonly is: "releasing"; readonly box: string; readonly since: number }
  | { readonly is: "resetting"; readonly step: "processes" | "user" | "sweep"; readonly since: number };

interface SlotDevice { readonly model: string; readonly udid: string }

type Placement =
  | { readonly on: "vm" }                                                        // dedicated: a VM or Mac of its own, as today
  | { readonly on: "slot"; readonly host: string; readonly generation: number; readonly carried: boolean };
```

- **A slot's user and UID come from its generation,** by one function each,
  so a record cannot hold `bbd-7` with UID 80009. The image's carried slots
  have a range of their own, 79991 and 79992, so the image's check can
  forbid every file in the 80000 range and exempt exactly those two users
  by name and UID ([Slots in the image](#slots-in-the-image)).
- **A slot being made can be promised.** `for` names the box it is made
  for, so two acquires never both decide to make "the" next slot.
- **A slot has one box at most,** and is never lent again: after
  `resetting` it is removed, and a new slot, with a new generation, takes
  its place.
- **`most` counts making, ready and held slots.** A slot leaves `most` once
  its user is removed, about 1.5 s after the release; its sweep counts only
  against `resettingMost`, since its UID is never given again and nothing
  of it can meet a later user (review finding 10).
- **A `macos` box in a slot has no device.** Its slot's device is deleted at
  the claim.
- **A box does not move,** and its placement is held once: in the record's
  `guest.data`, written by the backend at the claim. The record's
  `placement` is a getter over it, not a second field.
- **What a box can do is on the box.** The record gains `capabilities`,
  written at placement from the slot or VM it got: displays, computer use,
  root, enrolment and sizes. box_list, box_status, the panel's Device and
  Desktop views and 030's desktop commands read the box's, not the
  offer's.

The lifecycle of a slot:

```
making -> ready -> held -> releasing -> resetting -> (removed)
   \                                       ^
    `--- making failed --------------------'
```

### Where each part lives

| Data | Lives in | Written by | Read by |
| --- | --- | --- | --- |
| A host's state, its slots and their claims | on the host, `/var/db/bb-box/host/`: a state file, a folder a slot, each claim a marker made with `ln`, all changed under the helper's `flock` | the host's helper, as root | its backend, through the helper's `status` |
| A Tart host's VM, image build and settings snapshot | the Mac's owner file for the VM, `~/.bb-box/tart/owners/<vm>`, with `role=device-host`, as every Tart VM has one; its state there is a cache of the helper's | the Tart backend | the Tart backend at start and in each sweep; the doctor |
| A Namespace host | the instance's labels, as Namespace boxes have today, with `bbbox-role` `device-host` | the Namespace backend | the Namespace backend; the doctor |
| A pool Mac's mode | the pool helper's state, `/var/db/bb-box`: its owner marker when lent whole, a `slots` marker while it has slots, each made with `ln`, so one wins | the pool's helper, as root | the pool backend, through the helper's `status` |
| Where a box is, and what it can do | the box record: `guest.data` (`host`, `generation`, `carried`) and `capabilities` | the registry, from the backend's acquire, once | every tool and the panel |
| Hosts' settings | bb-box's configuration: each backend's `ios-hosts` ([below](#the-ios-hosts-setting)) | the operator | each backend |
| Device placement's lock | the plugin's memory: one lock for every ios placement, across backends | the registry | the registry |
| The encoder's ledger | the plugin's memory, per Mac, rebuilt from viewers and recordings at start | the instance that holds the boxes' leases (063) | [the budget](#the-encoder-budget) |
| A stream's step | the device server's memory: the viewers' wishes and the plugin's cap | each viewer; the plugin | the server, which alone opens idb's stream |

Backend storage holds no host or slot state: each host holds its own, so a
bb-box that lost its storage, or a second instance during a reload (045),
finds the same hosts and slots. Two instances that race on one host meet
at its helper's lock.

### The `ios-hosts` setting

Per backend that lends slots:

| Key | Default | What |
| --- | --- | --- |
| `on` | true on Tart and the pool; false on Namespace, whose VMs cannot stream a device (M18) | whether this backend lends slots |
| `most` | Tart 8, pool Mac 12, Namespace 3 | slots making, ready or held |
| `ahead` | 1 | ready slots kept while the host holds a box (the pool Mac: always) |
| `resetting-most` | 4 | slots sweeping at once |
| `cores`, `memory-gib` | 8 and 32 | a Tart host's size |
| `per-mac` | 1 | Tart hosts a Mac may run |
| `disk-reserve-gib` | 40 | below this much free disk a host lends no new slot |

Turning `on` off lends no new slot; boxes already in slots keep them, and
the host goes when the last is released.

## Placing a box

The registry today asks each offer in turn and takes the first with room
(`#place` in `src/core/boxes.ts`). An ios box needs a choice across
backends, so each backend that lends slots answers one question with a
graded answer, and the registry chooses:

```ts
type SlotTier =
  | { readonly tier: "ready"; readonly host: string; readonly waitMs: number }              // a ready slot
  | { readonly tier: "join"; readonly host: string; readonly waitMs: number }               // a slot being made, or a starting host with room
  | { readonly tier: "make"; readonly host: string; readonly waitMs: number }               // a slot to make on a host with room
  | { readonly tier: "new-host"; readonly where: string; readonly waitMs: number; readonly cost: "vm-slot" | "namespace-mac" }
  | { readonly tier: "own-vm"; readonly where: string; readonly waitMs: number }
  | { readonly tier: "wait"; readonly words: string };

interface SlotLender {
  offer(kind: "ios" | "macos", model: string, signal: AbortSignal): Promise<SlotTier>;
  take(choice: SlotTier, box: BoxIdentity, signal: AbortSignal): Promise<Guest | { readonly lost: string }>;
}
```

1. **One lock for device placement.** The registry takes one lock for
   every ios placement, across threads and backends, asks each lender for
   its best tier, picks the best by the order below, and asks that backend
   to `take` it. The lock is held from the asks to the backend's answer to
   `take`: a claim's `ln`, a promise written into a starting host's
   `promised`, or the backend's own start of a host, which it records as
   `starting` with this box promised before it releases the lock. So the
   next acquire sees the starting host and joins it.
2. **A lost race is asked again.** The helper's `ln` is the last word. A
   `take` that loses it, as when another bb-box instance claimed the slot
   during a reload, or the host went to `deleting`, answers `lost` with
   its words, and the registry asks the lenders again, three times at
   most, then waits with words. A lost race never fails an acquire.
3. **The order,** owner's decision 9, with what the box waits for. Times
   are to the device's first frame and the box being a BB machine, on one
   basis (M13, H3):

| Order | Tier | Where | What the box waits for |
| --- | --- | --- | --- |
| 1 | ready | a pool Mac that is `free` or has `slots` | a claim: marker, SSH key, the server's hello. Seconds (H1) |
| 2 | ready | a `serving` Tart or Namespace host | the same |
| 3 | join | a starting host, or a slot being made, with room | what is left of its start or making |
| 4 | make | a pool Mac or running host with room in `most` | a slot made: 24 to 43 s on Tart, under 30 s on the pool Mac (M3, M13, POOL) |
| 5 | new-host | Tart, on the Mac with a free VM slot and the fewest watched streams | about 50 to 60 s: the VM ready, 35 to 41 s; a carried slot's cold boot, 5 to 8 s; the first frame, 2 to 3 s; BB's daemon, 5 to 6 s (M13, H3). H1 measures a first box on a new host |
| 6 | new-host | Namespace, only once `on`, which it is not: its VMs cannot stream a device (M18) | the Mac ready in 29.7 s, idb_companion 0.6 s, a template's first boot 27.1 s (M18) |
| 7 | own-vm | where a backend has room for one | the same basis: 35 to 41 s, a cold boot of 5 to 6 s, enrolment 8 to 10 s: about 50 to 57 s (M13) |
| 8 | wait | | words per cause, below |

A new Tart host's first box and a VM of its own take about as long. The
host is chosen first because one VM slot then serves 8 boxes, not 1.

- **Words when it must wait,** one per cause: "Every shared iOS host is
  full, and every Mac runs two VMs." "Both of this Mac's VMs are macOS
  boxes, and no shared iOS host exists." "The shared iOS host is updating
  and no new one can start." Each ends with what frees first, from the
  hosts' and boxes' ages: "The next slot is likely free when a box on the
  pool's Mac is released."
- **Another model than the slots'.** A ready slot holds the kind's default
  model. A box that asks for another claims a ready slot, then the server
  switches as 063's switch does, making the model in the slot by `simctl
  create` and seeding: a first boot, 14.5 to 28.5 s.
- **Apple's two-VM limit** counts a Tart host as one macOS VM whether it
  lends 1 slot or 8. A Mac with a host has one VM slot left, for a macOS
  box, a dedicated ios box or, where `per-mac` allows, a second host.
- **`dedicated: true`,** a size, or a project with its own ios image asks
  only for tier `own-vm`, as today.
- **A `macos` box** asks for slots only with `shared: true`
  ([`macos` boxes in slots](#macos-boxes-in-slots)).
- **Ready slots are the spares.** 063's suspended ios spare stays for
  dedicated boxes only. Slots are made ahead only on a host that holds a
  box, and on the pool Mac, which is always on.
- **Starting a host warns the Mac's viewers.** A VM starting on the Mac
  took 8 half-size streams to 36 to 43 fps (E1). For about 30 s from a new
  host's start, viewers of devices on that Mac see "A VM is starting on
  this Mac; video may slow for about 30 s."

## Making a slot

Each host runs a helper as root: the pool's `machine-mac.sh` gains slot
commands; Tart and Namespace hosts run `device-host`, the same commands,
installed in the ios image or at the host's start. Each step and its time,
in a Tart VM at 8 cores and 32 GiB (M3):

| Step | What | Time |
| --- | --- | --- |
| 1. The user | `sysadminctl -addUser bbd-<generation> -UID <uid>`, a standard user, hidden, in `_developer`, its home from the pool's home template (the login PATH, which M12 found missing) and made `700` | 1.8 to 3.4 s |
| 2. CoreSimulator's defaults | the user's first `simctl` makes 19 default devices: deleted | 2.2 to 15.5 s |
| 3. The device | `simctl create` of the kind's default model, in the user's own set | 0.3 to 1.5 s |
| 4. Slim | the runtime's `disabled.plist` copied to `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>/`, the user's, before the first boot | under 0.1 s |
| 5. First boot | `simctl boot`, `bootstatus` | 14.5 to 28.5 s |
| 6. The device server | its daemon loaded; it attaches to the booted device and starts its companion | listening in 0.3 s (M15); idb_companion's socket in 0.1 to 0.2 s, a first frame 1.8 to 2.6 s later (M13) |
| 7. At the claim | the thread's SSH key; BB's command run with `BB_INSTALL_SKIP_SERVICE=1`, then the helper's `daemon` | the installer 5 s, then connected 0.5 to 0.7 s after the daemon loaded (M14) |

A slot took 24.1 to 26.1 s from a new user to its device's first frame in
a VM just booted (M13), 38.7 s to a booted device in a VM that had run for
a while, and 43.4 s while four watched devices streamed beside it, which
kept them at 55 fps (M3). A ready slot keeps its device booted and its
server running, about 0.01 of a core and 0.3 GiB (the research), so a
claim boots nothing.

### Slots in the image

A Tart host is a clone of the ios image, and lives only while it holds
boxes, so its first box always meets a new host. The image therefore
carries two slots, `bbd-i1` and `bbd-i2`, UIDs 79991 and 79992, each with
its device made, seeded, first-booted and shut down, as the image's own
devices are (063 unit 3.2), and their daemons written but not loaded. A
clone of the image gets them clean every time, as nothing ever ran in them.
Every clone has the same two UDIDs; each is in its own VM's device set, so
they never meet.

- **At the host's start** nothing boots. The first box's claim takes
  `bbd-i1` and loads its daemons: a cold boot of a device booted before,
  5.0 to 5.8 s for the image's own device (M13), 7.7 s for a slot's after a
  restart (M16), instead of a device's making. Then the host boots
  `bbd-i2`'s device in the background, as its ready slot.
- **The UID check.** The image's check fails on any file owned by a UID
  from 80000 to 89999, and on any owned by 79990 to 79999 but the two
  carried users' own, by name and UID. The sweep accepts both ranges.
- **The first slot made in a running host is `bbd-1`,** UID 80001.
- **Cost:** the two devices' first-boot data, about 1.6 GiB each (063
  E24), once on the Mac's disk, as clones share it.

### Why `simctl create`, and seeded

- **The store is found.** launchd_sim keeps a device's disabled services in
  `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>/disabled.plist`,
  outside the device's folder, keyed by its UDID, in a folder only its user
  can open (M1), in a Tart VM and on the pool's physical Mac alike. This
  explains every earlier finding: the list outlived `simctl erase` and was
  lost by `simctl clone` (the
  [slimming note](../research/ios-simulator-slimming.md)); a folder copied with its UDID
  met that folder owned by another user, and hung booting (the research);
  a Tart clone of the image kept it (063 results).
- **Seeding it makes a device slim at its first boot:** 112 of 112 labels
  off, from a clone in the same user (M2) and from `simctl create` in a new
  user (M3).
- **A device cloned from another user's set does not work.** It booted
  slim, but no app came to the front (M4), as the research found with a
  copied folder. So each slot makes its own device.
- **The store is undocumented.** The device server's boot check (063 unit
  4.2: it counts the list's labels in `print-disabled` at each boot, 0.3 s)
  stays the guard. If a later Xcode moves the store, the check finds the
  device stock and applies the list, as now, and making a slot takes about
  2 minutes longer. The image build keeps each runtime's `disabled.plist`
  beside its list in `/usr/local/share/bb-box/ios/`.

### The device server, and BB's daemon, in a slot

Both are LaunchDaemons with `UserName` set to the slot's user, written and
removed by the host's helper. A user with no console session has no `gui`
domain, so a LaunchAgent cannot load (the research; M14 for BB's own).

- **The device server,** `/Library/LaunchDaemons/app.bb-box.device.<user>.plist`,
  runs `bb-box-device.sh serve` from `~/.bb-box/device/current` in the
  slot's home, where 063's delivery puts each version, with `KeepAlive`
  and `ThrottleInterval` 1. Measured (M15): listening 0.3 s after the
  daemon loaded; it booted the slot's own seeded device (first boot 18.5
  s, all 112 services off) and started its companion in 169 ms. Killed
  three times, it was listening again in 0.32, 1.34 and 1.28 s. A new
  version folder with `current` pointed at it, then the server's exit: the
  new one listening in 1.67 s. So delivery works as 063's does, with the
  restart made by the server exiting, since the slot's user cannot
  kickstart a system daemon.
- **`bb-box-device connect`** waits for the socket rather than starting
  the service. If none comes within 10 s it says so, and the panel shows
  it: "The device server for this box has not started. bb-box has asked
  the host to start it again."
- **BB's daemon.** BB's installer puts its daemon in the `gui` domain, and
  in a slot it fails: "launchctl: Bootstrap failed: 125: Domain does not
  support specified action" (M14). With `BB_INSTALL_SKIP_SERVICE=1`, which
  the installer already honours, it enrols the machine and runs the daemon
  under its own `--supervise`. bb-box's enrolment of a slot box runs BB's
  command so, then asks the helper `daemon <generation>`, which stops the
  installer's process and loads a LaunchDaemon with the same command, port
  and data folder. Measured on a fresh BB in the host (M14): two slots
  enrolled, each on a port of its own the installer chose (38889, 38890),
  each connected 0.5 to 0.7 s after its daemon loaded, and BB ran a
  terminal on each as its own user. After a cold restart of the VM, both
  daemons started with it and reconnected 10.9 s after BB's server came
  back (M16).
- **Sockets** for both servers and idb's are in the user's home, which is
  `700`.

## Release and reset

The release is the helper's `release <generation>`, run under the helper's
lock. Measured with three users in a Tart VM, each with a booted device
(M6, M17):

| Step | What | Time |
| --- | --- | --- |
| 1. Stop | the BB machine removed, as every release does; the slot's daemons booted out; `launchctl bootout user/<uid>`; every process of the UID ended | 0.6 s |
| 2. The user | `sysadminctl -deleteUser` and the home: device set, keychain, DerivedData, caches. The slot leaves `most` here | 0.2 to 0.8 s for homes of 193 to 513 MiB |
| 3. Sweep, queued | every file and folder the UIDs in the queue own on the Data volume, in one `find -xdev` with one `-uid` each, at background priority, removed with the pool's `sweep`; the UIDs' System V IPC objects removed, as the pool does | one pass: 31.7 to 36.8 s for one UID, 31.8 s for three (M17) |

The release answers after step 2, about 1.5 s. The sweep queue runs one
pass at a time for every UID waiting, at most `resetting-most` of them. The
check, a second `find` that must find nothing (31.6 s, M17), is the
doctor's, run each night and after each restart, not on the release path:
the UID is never given again, so nothing left can meet a later user. What
the sweep found of each user: its folder in `/private/var/folders`; its
device's `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>`, with
the disabled list, launchd_sim's log and its syslog socket;
`/private/var/tmp/com.apple.launchd.*`; and folders named for its UUID
under `/private/var/protected`.

### The last release deletes the host

Decided on the host, where the claims are (review finding 2):

1. The helper's `release`, holding the lock, removes the claim and looks
   for any other claim, promise or slot being made for a box. If there is
   none, it writes the `deleting` marker before it lets go of the lock, and
   answers `last`.
2. From then every `claim` and `promise` is refused: "This host is being
   deleted; ask again." The registry treats that as a lost race and asks
   the lenders again (see [Placing a box](#placing-a-box)).
3. The backend then deletes the host under its own chain: on Tart `tart
   stop` and `tart delete`, as a box's VM today; on Namespace the instance.
   Its sweep is skipped: deleting the VM removes everything.
4. If the instance that began a deletion dies, the Tart backend's upkeep
   finishes any `deleting` host by its `since`, and the owner file, a cache
   of the helper's state, is removed with the VM.

A Namespace host does the same; the pool Mac is never deleted, and goes
back to `free` when its last slot's user is removed.

### When a step is cut short

`make`, `release` and `reset` are written to be run again, as the pool's
helper is, and each records its step before it takes it. The helper has a
LaunchDaemon of its own that runs `resume` at every boot.

| Found | Who acts | What happens | What a person sees |
| --- | --- | --- | --- |
| a slot `making`, by the helper at boot or on a new call | the helper | carried on from its step; a step that fails twice sends the slot to `resetting` | the box it was made for keeps waiting, or is placed again |
| a slot `releasing` or `resetting` | the helper | carried on from its step | nothing |
| a host `starting` whose instance died | the backend's upkeep | after 5 minutes with no boxes promised, deleted | its promised boxes are placed again |
| a host `deleting` | the backend's upkeep | deleted | nothing |
| a host `failed` | the backend's upkeep | deleted once it holds no box | its boxes see "The device's host failed" in box_status |
| a slot held by a box the registry no longer has | the backend's sweep, as for a box's VM today | released | nothing |

### A UID is never given again

macOS gave a new user the UID a removed one had just had (M7). In the ios
image, `/Applications/Google Chrome.app` is owned by UID 502, so a sweep of
a box user that macOS had given 502 removed Chrome (M7). So, as the pool's
helper does (047):

- Slot users take UIDs from 80000 to 89999, and the image's two carried
  slots 79991 and 79992, so a file left by any slot can never belong to a
  later one, even before its sweep ends.
- The sweep refuses a UID outside those ranges. The ios image's check, and
  the pool's setup, fail if any file is owned by a UID in them, but the
  carried users' own (see [Slots in the image](#slots-in-the-image)).
- Slot users are standard users, never `admin` (047: that is what makes
  removing one a reset), in `_developer` so the debugger and Instruments
  need no password (`DevToolsSecurity`), and in `com.apple.access_ssh`
  where Remote Login is limited to that group.

### What can pass between boxes, and how it is checked

Boxes are not a security boundary, as in the pool (047). Between two boxes
in one host, from the research's isolation run, with this note's changes:

| | Between two boxes in one host |
| --- | --- |
| Device, `simctl`, idb's socket, the device server's socket | apart: another user's set and sockets are refused |
| Home, keychain, DerivedData, Library | apart: the home is `700` (the research found `drwxr-x---` let others list its top level) |
| Processes | seen by all, with command lines and device UDIDs; not signalled |
| Loopback and ports | shared: a server on 127.0.0.1 is reached by every box and every device; a port held by one is refused to another. Each box has a range of its own ([below](#ports-a-range-for-each-box)) |
| `/tmp`, `/Users/Shared` | shared: what a box leaves readable there, others can read, until its reset |
| The host's own user | its home `700`, so no box reads bb-box's key or the host's state |
| After a reset | nothing: no process, no file of the UID on the Data volume, no IPC object |

H7, in unit 3, plants as one box: files in `/tmp`, `/Users/Shared`,
`/private/var/tmp` and its home; a LaunchAgent, a crontab and a keychain
item; a second simulator device; a process that ignores SIGTERM; a server
on 127.0.0.1. Another box, at the same time, must not reach the home,
keychain, device or sockets. After the release the next slot's user must
find none of them, and `find -uid` nothing, as `test/ssh-pool-live.ts` does
for the pool's Macs.

### Ports: a range for each box

Every box and every device in a host shares one loopback, and the research
found every device's Safari reached a server another user ran on
127.0.0.1. So two React Native boxes both starting Metro on 8081 would not
fail loudly: the second cannot bind, and its app loads the first box's
bundle. A test that passes against another box's server is a false pass.

- **Each slot has a range,** 100 ports from `BB_PORT_BASE` (20000 plus 100
  times its place among the host's slots), in `BB_PORT_BASE` and
  `BB_PORT_COUNT` in its environment, in box_status, and in the skill:
  "Servers on localhost in a shared iOS box are reachable from every box
  on its host. Start yours on your box's ports, from BB_PORT_BASE: for
  Metro, `--port $BB_PORT_BASE`."
- **The common ports are held,** so a mistake is an error, not a wrong
  connection. The host's helper listens on 127.0.0.1 at 3000, 4200, 5000,
  5173, 8000, 8080, 8081 and 19000, and answers each request with HTTP 421
  and "This port is shared by every box on this iOS host. Use your box's
  ports, from BB_PORT_BASE." A box that tries to bind one is refused with
  "Address already in use". A dedicated box has none of this.

### What one box can take from the others

macOS has no cgroups: nothing holds a box to a share of the cores or
memory. On a VM of its own a runaway build hurts its own thread; on a host
it hurts the others, so bb-box bounds what it can and shows the rest.

| | Bound | Shown |
| --- | --- | --- |
| Devices | one booted device a slot. The device server checks every 5 s; a second booted device is left for 10 minutes for a test that needs two, then shut down, with words in box_status | |
| Disk | the host lends no new slot below `disk-reserve-gib` free (40) | the helper's status gives free disk, and each slot's home size, read at background priority every 10 minutes |
| Memory | the host lends no new slot while `memory_pressure` gives under 15% free | each slot's resident memory |
| CPU | the helper's own work (making, sweeps) runs at background priority with `taskpolicy -b`; a box's own work does not | each slot's cores, from `ps` every 10 s |
| The encoder | the ledger caps bb-box's own streams ([below](#the-encoder-budget)); a box's own `ffmpeg` or Xcode previews it cannot see | |

**What a person sees:** box_status for a box in a slot names whoever is
using most, when it is not this box: "This host is busy: slot 5 is using 6
of 8 cores and 9 GiB." The doctor lists each host's slots by load. A person
who needs the cores asks for `dedicated`.


## What a box gives up in a slot

| | A box in a slot (default) | `dedicated: true` |
| --- | --- | --- |
| Ready | seconds from a ready slot; about 50 to 60 s on a new Tart host, as a BB machine (M13, M14) | about 50 to 57 s, as a BB machine (M13), or a spare (063) |
| Its device, files, keychain, input | its own | its own |
| sudo, `brew install`, system settings | no | yes |
| Cores and memory | shared with the host's other boxes; a 49 s build took 95 s beside 4 streaming devices (the research) | its own, at a size it chooses |
| Ports and loopback | shared; a range of its own, and the common ports refused | its own |
| Process list | others see its processes | its own |
| The host's desktop, for Xcode's window | none: a slot's user has no console session | yes |
| Watching its device | the same while the Mac's encoder has room; at a lower step when many are watched | the same rule: the encoder is the Mac's (E1) |
| A restart of its host | stops every box in the host | its own only |
| A project's ios image (049) | no: its script runs as root | yes |
| `box_resize`, `box_grant` | no | yes |
| Enrolment as a BB machine, `box_thread` | yes (M14) | yes |
| On Namespace | ends with the host, at most the plan's longest life after the host was made, not after the box was | at most the plan's longest life after the box was made |

What each box operation does for a box in a slot (review finding 12):

| Operation | A box in a slot | `dedicated: true` |
| --- | --- | --- |
| `box_run`, `box_copy`, `box_job`, `box_device`, `box_record`, the computer tools | as on any ios box | the same |
| `box_stop`, `box_start` | refused: "A shared ios box cannot be stopped on its own: it shares its host with other boxes. Release it, or ask for dedicated." | a Tart suspend and resume, as today |
| A restart of the box (`box_resize` with `restart`) | refused, in the same words; `box_device reboot` reboots its device | the VM restarts |
| `box_resize` | refused: no size of its own | as today (061) |
| `box_grant` | refused: no console session to grant to | as today (058) |
| `box_image_try`, `box_image_draft` | refused: a project's image runs as root | as today (049) |
| The upkeep's stop of an idle box | never: the host's other boxes keep it up; an idle slot box is released only by its thread's end, as today | as today |
| A spare's claim | ready slots are the spares | 063's suspended spare |
| 063's "When things stop and start", the box's own row | its device and server restart as there; a host restart is [below](#tart-hosts) | as 063 |

**box_list**, the ios kind's line: "Shared by default: a macOS user on a
Mac or VM shared with other ios boxes, with its own device, files and
keychain, but no sudo, and cores and processes shared. Servers on
localhost are reachable from every box on the host: use your box's ports,
from BB_PORT_BASE. Ask for dedicated for a VM of its own."

**box_acquire** gains `dedicated`: "For an ios box: a macOS VM of its own,
with sudo, brew install, its own cores, ports and desktop, instead of a
macOS user on a shared host. It takes one of the Mac's two VMs, so it may
wait for one." A `size`, `cores` or `memory_gib` for an ios box without it
is refused: "A shared ios box has no size of its own. Ask for dedicated:
true with a size."

**box_status** says where it is and what is near it: "On a shared iOS host
(a Tart VM), slot 3 of 8. Root: no. Ports 20300 to 20399." with the
host's load when another slot is busy, or "A VM of its own."

**The New box form,** for the ios kind, a choice before the device step:

- **Shared** (default): "Ready in seconds. No sudo or Homebrew installs.
  Other iOS boxes on the host share its cores and ports, and see its
  processes."
- **A VM of its own:** "sudo, Homebrew, its own cores, ports and desktop.
  Takes one of the Mac's two VMs, so it can wait for one." The size step
  shows only with this choice.

**The skill** says when to ask for `dedicated`: a build that needs the
cores, `brew install` or sudo, an app that needs fixed ports, Xcode's
window, or a project with its own ios image; and that a shared box's
servers go on its own ports, from `BB_PORT_BASE`.

## `macos` boxes in slots

Measured as a slot's user with no console session, over SSH as
`box_run` reaches a box, in a Tart VM (M12):

| Works | Fails |
| --- | --- |
| a Swift package built (4.5 s) and signed ad hoc | `brew install`: Homebrew belongs to the image's user |
| a keychain of its own, made with `security`; no login keychain is unlocked | sudo |
| `simctl`, a booted device, an iOS app built for testing (6.2 s) and an XCUITest run, which passed (18.5 s) | `open -a TextEdit`: "Launch failed" |
| npm into the home, a Python venv and pip | AppleScript to System Events: error -10810 |
| a server on 127.0.0.1, which the host's other users reached too | `screencapture`: "could not create image from display" |

So a `macos` box in a slot is a pool Mac's box (047) without the console:
commands, builds and the simulator, but no window of any app, no macOS UI
tests, no screenshots and no computer use. Against a VM of its own it gives
up all of that, and sudo, Homebrew, its own cores, its own ports and a size.
A `macos` box today has a console session even though its desktop is not
shown, so its desktop commands (030) run apps; in a slot they cannot.

**Recommendation: a host lends `macos` boxes only when asked,** with
`shared: true` on a `macos` acquire, and in the New box form as a choice
for the `macos` kind with the same words as the ios kind's. Without it a
`macos` box is a VM of its own, as today, and waits with words when none
can be had. A first draft made the slot a silent fallback; the review
showed why not (finding 11): an agent that asked for `macos` to build gets
a user with no sudo, Homebrew or app window, and may run `brew` before it
reads the words. A `macos` box's work is builds, which want the cores a
shared host splits (the research: a 49 s build took 95 s beside 4
streaming devices), and often sudo, Homebrew or a window. `shared: true`
on a `macos` box is for commands and builds that need none of them, and it
is ready in seconds.

A `macos` slot is an ios slot with its device deleted at the claim, so a
host's ready slots serve either kind, and a host with a `macos` box in it
stays up for it as for an ios box.

## The host's life

### Pool Macs

A pool Mac (047) is always on: no start, no deletion, no two-VM limit, and
the Mac's own encoder, shared with no VM (POOL).

- **Whole or slots, never both.** A pool Mac is `free`, lent `whole` to one
  box as today, or lending `slots`. A whole box takes the console, all the
  cores and, at its reset on macOS 27, a restart of userspace, which would
  stop every slot's device. So a whole claim needs a `free` Mac, and a slot
  claim turns a `free` Mac to `slots`. The Mac goes back to `free` when its
  last slot's user is removed; its sweeps finish in the background, and a
  whole claim waits for them. The pool's next box user (047) stays signed in
  at the console meanwhile, idle.
- **What whole-Mac boxes give up.** While any slot is held there, the pool
  Mac is not free for a `macos` or `macos-desktop` box. Those go to their
  other offers, or wait with words: "The pool's Mac is lending iOS slots
  (3 held). It is lent whole again when they are released." An operator who
  wants the Mac kept whole sets its `slots` to 0.
- **Its helper,** `machine-mac.sh`, gains `slot make`, `claim`, `release`,
  `daemon` and `status`, and the pool's setup installs idb_companion from
  its pin and bb-box's lists and seeds in `/usr/local/share/bb-box/ios/`. Slot users take UIDs from 80000, apart from the whole
  boxes' 70000 range; they are never at the console. The sweep is the
  pool's own, which removes protected folders where the Mac has Full Disk
  Access or SIP off (058).
- **Slots ahead.** One ready slot even while the Mac is `free`, since the
  Mac is up anyway and holds no VM for iOS. A whole claim removes ready
  slots first, about 1.5 s each, their sweeps in the background.
- **Size.** 12 slots on this pool's Mac, 18 cores and 36 GiB. Twelve busy
  devices took about 6.4 of its 18 cores and left 54 to 59% of its memory
  free; a seeded device first-booted in 10.4 to 12.4 s beside them (POOL).
- **The encoder:** about 375 full-size iPhone frames a second, in two
  halves of about 188. Four watched at full size ran at 59.3 to 59.5 fps
  with a tap shown in 50 ms at the median; twelve at half size at 58.7 to
  59.2 fps and 49 ms (POOL).

### Tart hosts

| What happens | The host | Its boxes |
| --- | --- | --- |
| An ios box finds no slot, and a Mac has a free VM slot | cloned from the ios image as `bb-box-host-<id>` and booted, `starting` with the box promised; the carried `bbd-i1` claimed for it, `bbd-i2` booted after as the ready slot; more made one at a time while it holds a box | the first waits about 50 to 60 s (M13, M14); boxes that came meanwhile join it |
| Its last box is released | the helper writes `deleting`; the backend stops and deletes it; the Mac's VM slot is free again | |
| A slot's device or CoreSimulatorService crashes | launchd starts that user's CoreSimulatorService again within 5 s (the research) | that box only: its server boots the device again, about 5 s (063); the others went on at 55.5 and 56.9 fps through it (the research) |
| A slot's idb_companion dies | | that box only: a new companion in about 0.1 s, a stall under 1 s (063 results) |
| A restart of its VM, by the operator or a crash | the helper's `resume`, every slot's device server and BB's daemon start with the VM, with no one signed in | every box stops, then comes back by itself: in M16 a slot's device server was up as the VM booted, its device booted cold in 7.7 s and streamed 25 s after, and BB's daemons reconnected 10.9 s after BB's server answered. With 8 slots, 8 cold boots took 62 s (the research). box_status says "The device's host restarted; back in about 2 minutes" |
| The Mac restarts | `stopped`: its VM does not start by itself. The Tart backend starts it at its own start and at each sweep, as it starts a held box's VM | as a restart of the VM, from when the backend starts it. box_status says "The host is starting again" |
| Full: `most` slots making, ready or held | lends no more | new boxes placed as [above](#placing-a-box) |
| The ios image changes | drains, softly: it still lends its ready slots while no host on the new image can start on that Mac, and stops lending as soon as one can; it is deleted when its last box goes, as always | new boxes go to a host on the new image where one can start, and otherwise to the old host's slots, with box_status naming its build. The doctor says why a host on an old build still lends |
| It fails to start, or to make a slot three times running | `failed`, with words; deleted by the upkeep once it holds no box | new boxes go on down the order |

**Draining is soft** (review finding 7). The lead's decision 5 had new
boxes wait while a host drained. With one host a Mac and the Mac's other VM
slot taken by a macOS box, a long-lived box in the old host would make
every new ios box wait, or take a Namespace Mac, while ready slots sat on
an image a day older. An image a day older is still an image every box of
the last month ran on, so the old host lends until a new one can start.

### Namespace hosts

A Namespace host is a Namespace Mac made by the Namespace backend for an
ios box when no tier above it in [placing a box](#placing-a-box) answered,
and deleted at once when its last box is released, as a Tart host is. What
is different:

- **One Mac at a time, at most 6 cores and 14 GB,** in this workspace
  (`machines: 1`, `largest-machine: 6x14`). A Namespace host takes that one
  Mac, so while it lives no `macos` or `macos-desktop` box can be made on
  Namespace, and the reverse.
- **A life of at most 4 hours,** the plan's longest (`longest-life-hours:
  4`), from the host's creation, not each box's. Every box in it ends with
  it. So a Namespace host lends no new slot in its last hour (`draining`,
  `ending`), every box placed there has at least an hour, and box_acquire
  says when it ends: "This box ends at 19:40, when its Namespace host does."
  A thread that needs a box for longer asks for `dedicated`, or gets a
  Tart host or the pool Mac by waiting; a Namespace host is the last
  shared choice in the order for this reason.
- **Its image is Namespace's:** macOS 26.3.1 on an M4 Pro, Xcode 26.1.1,
  with iOS runtimes 17.5, 18.6 and 26.0 to 26.2 (M18), not bb-box's ios
  image. At the host's start the helper installs idb_companion from 063's
  pin, checked by SHA-256 (0.6 s, M18), and bb-box's lists and seeds in
  `/usr/local/share/bb-box/ios/`, and 063's record names the runtime it
  uses, so box_status says which iOS a Namespace box tests on.
- **Slimming works there.** The iOS 27.0 list applied to an iPhone 17 Pro
  on iOS 26.2 turned off all 112 of its labels, and the store was where it
  is on Tart and the pool Mac (M18). Each runtime still gets its list
  checked, as 063's image check does.
- **It cannot stream a device's video.** Its VM has no H.264 encoder:
  VideoToolbox could not make a compression session (-12903), and idb's
  video stream answered "VideoToolbox encode error: OSStatus -12915" for
  every frame and sent none, while taps reached the devices (M18).
  VideoToolbox's software encoder gave 42 frames a second of one full-size
  iPhone, on the CPU. idb's screenshots worked, at 509 ms at the median and
  2.2 s at worst, too slow for 063's stills.
- **And four busy devices took all of it:** 6 cores at 0.6% idle, 11% of
  its memory free and 2 GiB swapped (M18).

**So Namespace hosts stay off** (`on: false`), and Namespace leaves the
order until a device on it can stream: by 063's Android path, raw frames
into `bb-box-h264`, if its CPU can afford it beside the devices, which M18
suggests it cannot for more than one or two; or by Namespace offering Macs
whose VMs have the encoder. Unit 7 waits for one of them. The rest of this
section stands for when it does.

## Streams at the viewer's size

### How a viewer's size reaches the server

- **The viewer says what it draws.** After `START_VIDEO`, and whenever what
  it draws changes and stays changed for 500 ms (a resize of the panel,
  zoom, Fit, Pixel for pixel, Show frame, a move to a screen of another
  pixel ratio), the viewer sends `BB_DEVICE_VIEW {"width": w, "height": h}`
  on its viewer connection: the device screen's drawn size in the browser's
  device pixels, CSS size times `devicePixelRatio`, upright. A hidden tab
  sends `STOP_VIDEO`, as now.
- **The relay passes it.** Its list of viewer verbs (`VIDEO_VERBS` in
  `src/core/selkies.ts`) gains `BB_DEVICE_VIEW`; a server of an older
  version ignores the verb, so it is never dropped as unknown.
- **The server picks a step.** Its wish is the largest drawn size among the
  viewers watching, as a share of the device's own pixels. The step is the
  smallest of a third, a half, two thirds and full that is at least that
  share less 5%. It changes step only after the wish has held for 1 s, by
  restarting idb's stream with `scale_factor` set to the step: a key frame
  in 50 to 106 ms (063 E5).
- **Input stays in the device's pixels.** The viewer turns its pointer into
  the device's own pixels by the video size in each frame's header, so a
  touch made while the step changes lands where it was drawn. A step change
  is not a geometry change: it does not move the generation, which 063
  moves at every change of video size. So an agent's screenshot and
  references stay good when a person resizes the panel.
- **The picture is drawn at the frame's size,** scaled up by the browser.
  At a lower step it is softer, not smaller.

This is a new version of the device server, with a new protocol
version for the verb and the input's space. A viewer of
an older protocol gets full-size video and sends video pixels, as now.

**Android keeps full size** in this change. Its frames are encoded by
`bb-box-h264` in its own VM, with no Mac encoder to share, so the steps
would save that box's CPU only, a later decision. Its input moves to device
pixels too, as the server is one program; with full-size video, device
pixels and video pixels are the same, so nothing an Android viewer sends
changes. Unit 1's live check runs 063's E8 cases on Android as well as iOS.

A window dragged between screens of two pixel ratios sends two wishes; with
the 1 s hold the stream restarts at most twice, each a stall of a key
frame's time, 50 to 106 ms (063 E5). H4 measures it.

What the panel would draw, the iPhone 18 Pro fitted to the panel's height.
These are estimates from the frame's fit rule (063 unit 6.1), not
measurements; H4 measures the steps through BB:

| Screen | Device drawn, in device pixels | Step |
| --- | --- | --- |
| A laptop at 2x, panel about 800 px tall | about 1,300 tall | a half |
| A desktop monitor at 1x, panel about 1,000 px tall | about 850 tall | a third |
| A 5K monitor at 2x, panel about 1,300 px tall | about 2,100 tall | full |
| Pixel for pixel | 2,622 tall | full |

### What runs the stream

Today the iOS driver opens idb's stream when the device attaches, and keeps
it open, viewers or not. Frames come only when the screen changes, so an
unwatched busy device, such as one running a UI test, takes the encoder for
nothing. Drawing with no stream takes none: with 8 devices busy and none
watched, the encoder gave the same 318 frames a second (M9).

So the server opens idb's stream only while one of these wants it, at the
largest step any asks, and closes it 10 s after the last:

| Who | Step | Why |
| --- | --- | --- |
| A viewer watching | its drawn size | |
| A recording (059, 063) | two thirds | the clip is at most 1,600 px on its long edge; two thirds of the iPhone 18 Pro is 1,748 px tall, of the iPad Pro 13-inch 1,835 |
| The agent's tools waiting for the screen to settle (063 unit 7.1, the server's `settle` read) | a third | they count frames, not read them |

Geometry no longer comes from frames when none flow: the server reads the
orientation from idb every few seconds while still, as it does now.

**A full-size screenshot** does not use the stream. `computer_screenshot`
and the toolbar's Screenshot take idb's screenshot, a PNG of the
framebuffer. With the encoder flat out it took 47 ms at the median against
38 ms with it idle (M10). Screenshots stay at the device's full size.

## The encoder budget

### Per Mac, not per VM

The research's first open question, settled by E1: two VMs on one Mac
share one encoder.

| The Mac's other VM | This VM: two encoders flat out, in all | This VM: 4 watched at full size | This VM: 8 watched at half size | The other VM's own encoders |
| --- | --- | --- | --- | --- |
| running, idle | 319.6 to 319.8 | 57.8 to 58.2 fps, 66 ms | 55.8 to 56.7 fps, 65 ms | |
| two encoders flat out | 159.3 to 159.4 | 52.6 fps, 149 ms | 57.0 to 57.3 fps, 68 ms | 112 each |
| four paced at 60 fps, as four watched iPhones | 105.9 to 106.1 | 52.4 fps, 146 ms | 56.7 to 57.5 fps, 69 ms | 52.4 to 52.5 each, not 60 |

Frames a second are each device's; times are from a tap to the frame that
shows it, at the median. So a second VM's watched devices take from the
first's, and the other way round: a second host on a Mac adds slots, not
watched streams. One host a Mac is the default for this reason
(`ios-hosts.per-mac`, 1).

Twice, another VM starting on the Mac while devices streamed (once ours,
once another thread's) took 8 half-size streams down to 36 to 43 fps, with
taps at 206 and 74 ms at the median and 370 and 404 ms at the 95th
percentile (E1). Whether that was the Mac's CPU during the boot or the new
VM's device streaming its first frames is not separated; H8 does.

### Two halves

The encoder works as two halves (M11). One stream alone used both, 288
frames a second (M8). With two or more, each was placed on one half when it
started and stayed there, and the streams on a half shared it equally. Four
full-size streams flat out split two and two, about 80 frames a second
each, in 8 of 12 tries, and one and three in 4: the one at 105 to 160, the
three at 46 to 53. This explains the research's slow state, "three at 52.9
fps and 145 ms, one at 66 ms", and its six devices all at 52.4 to 52.7 fps:
three on each half, and 160 / 3 is 53. The pool Mac's encoder splits the
same way, into halves of about 188 (POOL).

So a half carries two full-size streams at 60 frames a second, and a third
brings all three on it to 53. bb-box cannot choose the half. So **at most
two streams on a Mac are at full size at once**; others are capped at two
thirds, which a half carries four of at 60 (M8).

### What a frame costs

| A frame of | Pixels | Frames a second, the whole encoder, Tart Mac | Cost against a full iPhone frame |
| --- | --- | --- | --- |
| iPad Pro 13-inch, full | 2064x2752 | 183 | 1.75 |
| iPhone 18 Pro, full | 1206x2622 | 294 to 320 | 1 |
| two thirds | 804x1748 | 518 | 0.57 |
| a half | 604x1312 | 885 to 931 | 0.33 |
| a third | 402x874 | 1,604 | 0.18 |

On the pool Mac, a full-size iPhone frame: 374 to 377 a second; a half:
1,310 to 1,329, so 0.28 of a full one (POOL).

### The ledger

- **A budget per Mac,** in full-size iPhone frames a second, from the
  chip: 320 for an M4 Max running VMs and 375 for an M5 Max (E1, POOL), in
  a table in the code, read with the Mac's other facts. A chip not in the
  table is measured by a 15 s probe, run only while the Mac's ledger is
  empty, so it neither takes the encoder from a stream nor reads low
  because of one; two encoders, not four, so the halves cannot split it
  one and three (M11). A Namespace Mac has no hardware encoder (M18).
- **What it counts:** every stream bb-box makes on that Mac, each at its
  frames a second over the last 10 s, with a floor of 20, times its
  frame's cost from the table: watched devices, recordings, and the
  desktops bb-box streams there, a macOS desktop from a Tart VM (060) and a
  Windows desktop encoded on the Mac (046). So a panel open on a still
  device counts a third of a busy one's, and a device that becomes busy is
  counted as busy within 10 s.
- **The cap.** The plugin keeps the sum within three quarters of the
  budget: 240 on the Tart Mac, 280 on the pool's. That is four watched
  iPhones at full size, which ran at 57.8 to 58.2 fps and 66 ms with the
  other VM idle (E1), where six did not (the research). At most two
  streams a Mac are at full size (M11).
- **Who gets room,** in order: the stream of the person holding control of
  a device, then recordings, then other viewers, then the tools' waits.
  Over the cap, the plugin lowers the step of the lowest in that order
  first, largest first within it; never below a third, and a recording
  never below a half. Pixel for pixel for the person holding control always
  gets a full-size place, by stepping passive viewers down. When room comes
  back, steps rise in the same order after 10 s, so they do not flap.
- **What that gives,** at a busy device's 60 frames a second: on the Tart
  Mac 2 at full size and 3 at two thirds, or 12 at a half, or 21 at a
  third; on the pool Mac 2 at full size and about 4 at two thirds, or 16 at
  a half, or about 25 at a third. Still devices cost a third of that.
- **What a person sees,** in words that name boxes, not frames: under the
  toolbar while their stream is lowered, "Shown at a lower resolution: this
  Mac's video encoder is busy with 3 other devices (box ios-2, box ios-5,
  box ios-7)." box_status and the doctor: "On this Mac: 4 of about 5
  full-size streams' room in use."
- **Beyond the cap,** when every stream is at its floor and the sum still
  exceeds it: frames slow for every stream alike, as the encoder shares,
  and the toolbar says "This Mac's video encoder is full, so frames come
  more slowly." Nothing is refused.
- **New hosts go where streams are fewest.** Tier `new-host` picks the Mac
  with a free VM slot and the smallest ledger, and warns that Mac's viewers
  while the VM starts (see [Placing a box](#placing-a-box)).

## Measurements

Measured on 26 October 2026, on two Macs:

- **The Tart Mac,** an M4 Max: ios boxes from the ios image
  build.20261026-091450-8505, macOS 27.0, Xcode 27.0 (27A266a), iOS 27.0
  (24A434), idb_companion 1.7.7, each at 8 cores and 32 GiB, a host's
  size, but for E1's second VM at 6 and 16. Each box's own device server
  was stopped.
- **The pool's Mac,** an M5 Max with 18 cores and 36 GiB, macOS 27.0.1, the
  same iOS 27.0 runtime, as a pool box's user, with no root, idb_companion
  1.7.7 from its pin in the home.

Every device was an iPhone 18 Pro. Streams were read in the box from idb's
socket, with the research's harness,
[multi.ts](../research/ios-shared-hosts/multi.ts), and its decoded-pixel
tap analysis, [analyse.py](../research/ios-shared-hosts/analyse.py): BB's
relay, the network and the browser are not in them. The encoder was loaded with `ffmpeg`'s `h264_videotoolbox`, hardware
only, 8 Mbit/s, from a raw clip in memory, so nothing but the encoder
limited it. The scripts and summaries are in
[064-ios-shared-hosts](064-ios-shared-hosts/).

During M1 to M11, another thread's ios box ran in the Tart Mac's other VM
slot, with whatever its work gave the encoder. E1 had both slots.

### M1: where launchd_sim keeps disabled services

A label that does not exist was disabled in a booted device with `simctl
spawn <udid> launchctl disable system/<label>`, and every file changed
after it was listed with `find -newer`, as root, across `/private/var`,
`/Library`, `/private/etc` and the user's home. One file held it:
`/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>/disabled.plist`,
a binary property list of 124 labels, each `true`: the image's 112 and
others iOS disables itself. Its folder is the user's, `700`, and holds
launchd_sim's log and syslog socket too. Nothing in the device's own folder
held the label but LaunchServices' database, which names every label it
has seen.

### M2: a clone, seeded

| | Time | Disabled of the 112 | Processes under launchd_sim, 15 s after boot |
| --- | --- | --- | --- |
| `simctl clone` of the image's slim iPhone, same user | 2.1 s | | |
| `disabled.plist` copied into the clone's folder, then boot | 1.7 s | 112 | 60, against the template's 62 |
| 8 more clones, each seeded | 17.6 s for all 8 | | |
| The 8 booted one after another, each opening a page in Safari | 1.5 to 10.5 s each | | |

### M3: a slot, made in a new user

| Run | User | First `simctl` | `simctl create` | First boot, seeded | Disabled of the 112 | Whole slot |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.9 s | | 1.5 s | 28.5 s | 112 | |
| 2 | 2.7 s | 2.2 s | 0.3 s | 24.8 s | 112 | 38.7 s |
| 3, while 4 devices streamed | | | | | 112 | 43.4 s |
| 4 to 6, in a VM just booted (M13) | 1.9 to 2.0 s | 5.4 to 6.5 s | 0.2 s | 14.5 to 15.6 s | 112 | 24.1 to 26.1 s, to the first frame |

In run 1, Safari opened a page and came to the front, seen in a
screenshot. The 4 devices beside run 3, each busy and watched at full size,
tapped once a second:

| | Frames a second | Worst gap | Tap to frame: median, p95, worst |
| --- | --- | --- | --- |
| Before, 30 s | 55.2 to 55.6 | 89 to 121 ms | 72, 144, 317 ms |
| While the slot was made, 40 s | 55.4 to 56.3 | 114 to 135 ms | 71, 148, 244 ms |

A new user's first `simctl` made 19 default devices, every model of every
runtime, in 15.5 s and 192 MiB the first time and 2.2 s the second. A
`device_set.plist` written before it, with an empty `DefaultDevices` for
each runtime, did not stop it.

### M4: a device cloned across users

A template was cloned into a set in `/Users/Shared` readable by all, and a
new user cloned it into its own set with `simctl --set <shared set> clone
<udid> slot <its own set>`. The clone took 2.3 s and booted in 1.7 s, with
112 of 112 labels off once seeded. But no app came to the front: `simctl
openurl` answered success and `simctl launch` gave Safari a process, yet
launchd listed no `UIKitApplication` for Safari, and a screenshot showed the
Home Screen. A device made by `simctl create` in a user (M3), and a clone
within the same user (M2), each listed Safari and showed its page.

### M5: what a new user's first `simctl` costs

See M3: 19 default devices, 2.2 to 15.5 s, 192 MiB. Making a slot deletes
them.

### M6: removing a user, and what is left

Three users, each with a booted device, removed in turn:

| User's home | Processes ended | User and home removed | `find -xdev -uid` over the Data volume | Paths found | After the sweep | Sweep and check |
| --- | --- | --- | --- | --- | --- | --- |
| 193 MiB | 0.6 s | 0.2 s | 31.7 s | 6 | 0 | 71.1 s |
| 513 MiB | 0.6 s | 0.8 s | 36.8 s | 9 | 0 | 75.1 s |
| 328 MiB | 0.6 s | 0.7 s | 34.8 s | 9 | 0 | 71.0 s |

The paths: the user's folder in `/private/var/folders`; four folders named
for its UUID in `/private/var/protected/trustd/private` and
`/private/var/protected/sfanalytics`; three `/private/var/tmp/com.apple.launchd.*`
folders; and its device's `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>`.
An earlier removal without the sweep left 19 to 49 files of each user.

### M7: UIDs given again

After users 502 to 504 were removed, macOS gave the next new user 502. In
the image, `/Applications/Google Chrome.app` is owned by UID 502, and the
sweep of that user's UID removed it.

### M8: the encoder, by frame size

Four encoders flat out for 15 s, frames a second each over the last 10 s:

| Size | Each | All four |
| --- | --- | --- |
| 2064x2752 | 45.5 to 45.9 | 182.6 |
| 1206x2622 | 73.3 to 73.7 | 294.0 |
| 804x1748 | 129.4 to 129.7 | 518.0 |
| 604x1312 | 221.1 to 221.4 | 884.9 |
| 402x874 | 400.1 to 402.0 | 1,604.2 |

One encoder alone at 1206x2622 gave 288 frames a second; two, 160 each.

### M9: does drawing take the encoder?

Four encoders at 1206x2622 flat out gave 318.0 frames a second in all while
8 devices drew Safari's page every frame, unwatched, and 242.3 and 289.9
with every device shut down. Drawing does not take the encoder; what moved
the total is in M11 and E1.

### M10: a screenshot under a full encoder

15 PNG screenshots by idb, 200 ms apart, of a busy device: 38 ms at the
median and 164 ms at worst with the encoder idle; 47 ms and 68 ms with four
encoders flat out.

### M11: the encoder's two halves

Four encoders at 1206x2622 flat out, 12 runs: six started at once, six
1.5 s apart.

| Started | Two and two: about 80 each | One and three |
| --- | --- | --- |
| At once | 5 of 6 | 1: 160.2 and 52.6 to 53.1 |
| 1.5 s apart | 3 of 6 | 3: 105.2 to 160.3, and 46.2 to 53.2 |

The total was 317.3 to 319.0 in 10 runs, and 245.0 and 222.6 in two, with
nothing else in the VM using the encoder. The same split explains the
devices: 6 watched at full size ran at 51.5 to 51.7 fps, with taps at 139
to 149 ms at the median, all six alike, as three on each half; 8 at half
size ran at 55.9 to 56.6 fps and 66 ms.

### M12: what a slot's user can do

A slot's user, made as in M3, with no console session, reached over SSH
from the VM's own user, as `box_run` reaches a box. Each command, its exit
and its time:

| Command | Result |
| --- | --- |
| `sudo -n true` | refused: a password is required |
| `brew install tree` | refused: Homebrew's folders are the image user's, and it asks for `sudo chown` |
| `npm install -g --prefix ~/.npm-global`, a venv and `pip install` | worked: 0.6 s and 2.5 s |
| `swift package init`, `swift build -c release` | worked: 17.4 s with the init; the build 4.5 s |
| `codesign -s -` of the build | worked |
| `security list-keychains` | only the System keychain: no login keychain |
| `security create-keychain` in the home | worked |
| `open -a TextEdit` | failed: "Launch failed" |
| `osascript` to System Events | failed: error -10810 |
| `screencapture -x` | failed: "could not create image from display" |
| `simctl list devices booted` | worked: its own device |
| `xcodebuild build-for-testing` of 063's probe app | worked: 6.2 s |
| `xcodebuild test-without-building`, the probe's XCUITest, on its own device | passed: 18.5 s |
| a server on 127.0.0.1:8799 | answered; the VM's own user reached it too |

The new user's PATH had neither Homebrew nor Node: a slot's home needs the
home template the pool's users get (047).

### M13: a new host

Two Tart boxes of the ios image, from `box_acquire`'s timings, to SSH: place
4.3 and 4.6 s, clone 4.5 s, start 5.5 and 5.6 s, network 7.3 and 9.4 s,
SSH 4.2 and 6.5 s: 25.8 and 30.6 s; to ready, with a box's identify, name
and grants steps, 34.8 and 40.7 s. The image's own device, booted
once in the image, then booted cold in 5.0 and 5.8 s.

In the first, just booted, three slots were made one after another by a
script run as root, with UIDs 80001 to 80003 given to `sysadminctl`, and
idb_companion started for each by a LaunchDaemon with `UserName`:

| Slot | User | Defaults deleted | `simctl create` | First boot | Companion's socket | First frame after connecting | Whole |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2.0 s | 6.5 s | 0.2 s | 14.5 s | 0.2 s | 2.6 s | 26.1 s |
| 2 | 1.9 s | 5.4 s | 0.2 s | 14.5 s | 0.1 s | 1.8 s | 24.1 s |
| 3 | 1.9 s | 5.4 s | 0.2 s | 15.6 s | 0.1 s | 2.5 s | 26.0 s |

Each had 112 labels off.

### M14: a slot enrolled as a BB machine (H3)

A fresh BB, `npx bb-app` with no account, ran in the ios box's own user at
127.0.0.1:4999, with its machines' server address set to that URL and its
default access to `direct`. `bb machine create --provider manual` gave a
one-time enrolment command for each slot, which the slot's user ran over
SSH, as bb-box's enrolment runs BB's command in a box. Both slot users were
made as in M13, UIDs 80001 and 80002, with no console session.

| | Slot 1, as BB's command is | Slot 2, with `BB_INSTALL_SKIP_SERVICE=1` |
| --- | --- | --- |
| The installer | downloaded and installed the server's bb-app, 5 s; enrolled the machine; then failed: "Could not register the bb host-daemon launch agent … launchctl: Bootstrap failed: 125: Domain does not support specified action" | the same, then ran the daemon under its own `--supervise`; connected |
| The daemon's port, chosen by the installer | 38889 | 38890 (the VM's own user's daemon had 38888) |
| Then | its LaunchAgent's plist copied to `/Library/LaunchDaemons` with `UserName` added, and loaded: connected 0.7 s after | the installer's process stopped, and a LaunchDaemon written with the same command, port and data folder: connected 0.5 s after |
| A terminal made through BB on the machine | ran as `bbd-1`, UID 80001, and `simctl` saw its own devices | ran as `bbd-2`, UID 80002 |

### M15: the device server under a LaunchDaemon

The device server's version 13, as the plugin had delivered it to the VM's
own user, copied to `~/.bb-box/device/server/13` in slot 1's home, owned by
the slot's user, with `current` pointing at it, and run by a LaunchDaemon
with `UserName`, `KeepAlive` and `ThrottleInterval` 1:

| | Time |
| --- | --- |
| Listening on its socket, from the daemon's load | 0.3 s |
| The slot's own iPhone 18 Pro, seeded: first boot | 18.5 s; all 112 services off |
| Its companion listening | 169 ms after its start |
| Killed (SIGTERM), three times: listening again | 0.32, 1.34, 1.28 s |
| A new version folder, `current` pointed at it, the server's exit: listening again | 1.67 s |

### M16: a cold restart of the host's VM

The VM restarted by a resize with restart, which took 69.2 s, with slots 1
and 2 enrolled and slot 1's device server loaded. Nobody signed in. As the
VM came up, both slots' BB daemons and slot 1's device server were running.
The device server booted its device cold in 7.7 s and had its companion
listening and the device booted 25 s after launchd started it. The fresh
BB, which ran as the VM's own user by hand and so did not restart, was
started again; both slots' machines were connected 10.9 s after it
answered.

### M17: one sweep for several UIDs

Three slot users, each with a file in `/tmp`, a folder in `/Users/Shared`
and CoreSimulator's defaults, removed; then one `find -xdev` over the Data
volume for one UID took 31.8 s, and one for all three, with `-uid a -o
-uid b -o -uid c` and `-prune`, 31.8 s, finding 18 top paths. After the
sweep, a check of all three found nothing, in 31.6 s.

### M18: a Namespace Mac (H10)

The workspace's one Mac, at its largest shape, 6 cores and 14 GiB, taken
when it was free: ready in 29.7 s (create 0.1 s, ready 19.2 s, SSH 2.4 s,
tailnet 7.5 s). macOS 26.3.1 on an Apple M4 Pro (virtual), Xcode 26.1.1,
iOS runtimes 17.5, 18.6, 26.0, 26.1 and 26.2.

| | Result |
| --- | --- |
| idb_companion 1.7.7 from its pin, checked by SHA-256 | installed and ran in 0.6 s |
| An iPhone 17 Pro (1206x2622) on iOS 26.2: first boot | 27.1 s |
| The iOS 27.0 list applied (this Xcode's `simctl` has no `reboot`) | 112 of 112 labels off; the store at `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>/disabled.plist` |
| Six seeded clones, booted one after another, each opening the busy page | 16.0 to 25.5 s each |
| `ffmpeg`'s `h264_videotoolbox`, hardware only | "cannot create compression session: -12903" |
| The same with software allowed | 42 frames a second at 1206x2622, on the CPU |
| idb's video stream, 2 devices watched | no frames: "VideoToolbox encode error: OSStatus -12915" for each; taps sent, 29 a device |
| 4 devices booted and busy | 0.6% of 6 cores idle; 11% of memory free; 2,068 MiB of swap |
| 10 idb screenshots of a busy device | 509 ms at the median, 2,187 ms at worst |

The research's harness starts each companion with `nohup`, which could
not detach in this session; the second run started them without it.

### POOL: the pool's Mac

Four encoders flat out for 15 s, twice: 373.7 and 375.3 frames a second in
all at 1206x2622, 1,309.7 and 1,329.0 at 604x1312, the latter split one and
three (660 and about 218 each). Two encoders: 187.2 to 188.5 each.

12 slim devices, cloned and seeded in the box user's set, each busy in
Safari, each with its own idb_companion, watched at the step given and
tapped once a second for 30 s:

| Watched | Step | Frames a second | Worst gap | Tap to frame: median, p95, worst |
| --- | --- | --- | --- | --- |
| 4 | full | 59.3 to 59.5 | 34 to 46 ms | 50, 63, 77 ms |
| 8 | full | 47.1 | 31 to 32 ms | 148, 157, 167 ms |
| 12 | full | 30.5 to 30.9 | 270 to 765 ms | 207, 229, 1,030 ms |
| 8 | half | 59.2 to 59.4 | 36 to 49 ms | 49, 64, 76 ms |
| 12 | half | 58.7 to 59.2 | 36 to 48 ms | 49, 63, 74 ms |
| 12 | a third | 59.1 to 59.4 | 37 to 49 ms | 47, 61, 66 ms |

With all 12 booted and busy, `top` gave 62.8 to 68.5% of the Mac idle,
about 6.4 of its 18 cores used, and `memory_pressure` 54 to 59% free. The
template's list took 80 s to apply twice; 12 seeded clones took 26 s and
booted in 1.7 to 2.1 s each. A seeded `simctl create` then first-booted in
10.4 and 12.4 s beside the 12 busy devices, with 112 labels off. The store
was in the same place as in the VM (M1).

### E1: is the encoder the VM's or the Mac's?

Two Tart VMs on the Mac, the Mac's only two: VM A at 8 cores and 32 GiB
with 8 slim devices booted and busy, VM B at 6 cores and 16 GiB with its
device shut down. A ran the same phase under each of B's states: two
encoders flat out for 20 s, twice; 4 devices watched at full size for 30 s;
8 at half size for 30 s; two encoders again. B ran its load for 250 s from
a few seconds before A's phase began.

| B | A's two encoders, in all, three times | A: 4 at full size | A: 8 at half size | B's encoders |
| --- | --- | --- | --- | --- |
| idle | 319.6, 319.6, 319.8 | 57.8 to 58.2 fps; 66, 79, 140 ms | 55.8 to 56.7 fps; 65, 75, 109 ms | |
| two flat out | 159.4, 159.3, 159.4 | 52.6 fps; 149, 154, 157 ms | 57.0 to 57.3 fps; 68, 82, 92 ms | 112.0 each over its 250 s |
| four paced at 60 fps | 106.1, 105.9, 106.1 | 52.4 fps; 146, 160, 168 ms | 56.7 to 57.5 fps; 69, 84, 93 ms | 52.4 to 52.5 each |

Tap times are median, 95th percentile and worst. The phase was also run
with another thread's ios box in B's place, before B was taken: 319.7 to
320.2 in all, and 4 at full size at 58.1 to 58.5 fps and 65 ms; its 8 at
half size overlapped B's boot and fell to 35.7 to 37.0 fps, 206 ms. After
B was released, a run meant to be alone overlapped another thread's ios box
starting in the freed slot: 317.5 to 320.1 in all, but 4 at full size at
53.0 to 53.3 fps and 72 ms, with a 95th percentile of 190 ms, and 8 at half
size at 42.7 to 43.4 fps, 74 ms, 95th percentile 404 ms.

## Build units

Each unit is one builder's PR, built and checked on a Mac box: a dedicated
ios box where it needs root in the VM, the pool's Mac where it changes the
pool. Each ends in a live check through BB, on a separate BB in a box with
bb-box from the unit's branch, with what it measured. Each brings the
reference, the skill's text, settings keys, doctor checks, conformance
cases and guides for what it adds.

| Unit | Builds | Live check | After |
| --- | --- | --- | --- |
| 1. Streams at the viewer's size, and only while wanted | `BB_DEVICE_VIEW` from the viewer, added to the relay's `VIDEO_VERBS`; the server's steps, wishes and cap; input in device pixels, iOS and Android; a step change that keeps the generation; idb's stream opened only for a viewer, a recording or a tool's wait, closed 10 s after; a recording at two thirds; Android at full size; the server's new version and protocol | on a dedicated ios box and an android box: the panel at three sizes and Pixel for pixel, the step following within 2 s; a tap at each step landing where drawn; 063's E8 cases on both; an agent's element reference still good after a person resizes the panel; no frames encoded 10 s after the last viewer leaves; a recording's clip at 1,600 px; H4 | |
| 2. The data model, `dedicated` and `shared` | `src/core/device-host.ts` with its validators and the compile-time cases that must fail; `capabilities` and the placement in `guest.data` on the box record, read by every tool; `dedicated` for ios and `shared` for macos on box_acquire and `bb box acquire`; the refusals of [box operations](#what-a-box-gives-up-in-a-slot); box_list's and box_status's words; the New box form's choice, Shared off with "No shared iOS host is set up" until unit 4; the skill's text | `dedicated: true` gives today's box; a size without it refused in its words; box_list and box_status read back; the form at 360 px and by keyboard | |
| 3. The host's helper | `device-host`: make, claim, promise, release (with `last` and `deleting` under its lock), reset with its sweep queue, daemon, resume and status, each re-runnable from its recorded step; UIDs and users derived from the generation; devices by `simctl create`, seeded; the device server's and BB's daemons; homes `700`; the port range and the held common ports; the per-slot device bound and load in status. The ios image gains it, its two carried slots, each runtime's `disabled.plist`, and its UID check. Tested first on Linux with stub macOS tools, as `machine-mac.sh` is | in a dedicated ios box, as root: 8 slots made, each timed; a slot enrolled with bb-box's own enrolment and a terminal run on it (H3 through the plugin, after M14 on a fresh BB); a new device server version delivered to a slot and listening within 2 s (M15); a cold restart with slots held (M16); H7; a CoreSimulatorService killed in one slot while three others stream; a `release` cut short and run again | |
| 4. Tart hosts, shared still opt-in | the `ios-hosts` setting; `SlotLender` on the Tart backend; the registry's device placement lock and tiers; hosts made for a box, joinable while `starting`, deleted at the helper's `last`; carried slots; soft draining; `stopped` and the start of a held host's VM; the upkeep's rows for `starting`, `deleting` and `failed`; transports as the slot's user through the Mac; every slot stream capped at two thirds until unit 6; the doctor's page of hosts, slots, their load and the Mac's ledger; conformance cases | on a separate BB, with `shared: true` asked for: three ios boxes acquired at once make one host, not three; 8 boxes, each its own device, streamed and tapped; a ninth placed with its words; a release racing a claim, the claim placed again; the last release deleting the host and freeing the VM slot; H1 for a ready slot and for a first box on a new host; H5, H6, H9 | 2, 3 |
| 5. Pool Mac slots | `machine-mac.sh`'s slot commands; `free`, `whole`, `resetting-whole` and `slots`; a whole claim refused while slots are held, with words; `SlotLender` on the pool backend; setup installs idb_companion, the lists and seeds; the pool's guide; conformance cases | on the pool's Mac: 12 slots made and held; a `macos-desktop` box for the pool refused with its words, then lent whole once they end; a reset leaves nothing; H1, H11 | 2, 3 |
| 6. The encoder ledger, then shared by default | the per-Mac ledger in the plugin with measured rates and a floor; budgets by chip, the probe only on an empty ledger; the order of who gets room; caps sent to each server; at most two at full size; the words naming boxes; new hosts placed on the Mac with the fewest streams, and the warning while one starts. Then the ios kind's default becomes shared | 10 watched devices across a host and a dedicated ios box on one Mac: caps step down passive viewers first, the person in control keeps Pixel for pixel, every stream at 55 fps or more, the words seen; H8; then an ios box acquired with no options lands in a slot | 1, 4, 5 |
| 7. Namespace hosts, when a device can stream there | `SlotLender` on the Namespace backend; a Namespace Mac made as a host, idb_companion, lists and seeds installed from their pins, its runtime checked and named; `ending` an hour before the plan's longest life; a stream that does not need VideoToolbox, by 063's Android path, or Namespace Macs with an encoder; the Namespace guide's note that a host takes the workspace's only Mac | a Namespace host streaming 2 devices through BB, their frame rate and its CPU; then `on` | 4 |
| 8. `macos` boxes in slots | `shared: true` on a `macos` acquire takes a slot, its device deleted at the claim; the New box form's choice for `macos` | a `macos` box with `shared: true` placed in a slot in seconds, its words read back; one without it waits for a VM with its words | 4 |

Units 1, 2 and 3 run side by side; then 4 and 5; then 6, which makes
shared the default, and 7 and 8. Shared becomes the default only in unit 6:
after bb-box's own enrolment of a slot passes in unit 3 (review finding 4)
and the ledger exists (finding 16). Until then a box in a slot is opt-in,
with `shared: true`, and its streams are capped at two thirds.

**Conformance cases,** for any backend that lends slots: two boxes of the
kind share a host; a release of one leaves the other streaming; the last
release deletes an elastic host; a slot box refuses a size, a stop and a
grant with words; two acquires at once share one new host.

### Experiments

| | What | Settles | Unit |
| --- | --- | --- | --- |
| H1 | Ten claims of a ready slot through BB, and five first boxes on a new host: box_acquire to the device's first frame in the panel and to a connected BB machine | the ready times in [Placing a box](#placing-a-box) | 4, 5 |
| H3 | bb-box's own enrolment of a slot, through the plugin | a slot box as a BB machine, which M14 showed on a fresh BB | 3 |
| H4 | Tap to screen through BB at each step, 100 taps, and the stall when the step changes | the steps' cost to a person | 1 |
| H5 | A Tart host restarted with 8 held slots: time until every device streams and every BB machine is connected | the restart row of [Tart hosts](#tart-hosts) | 4 |
| H6 | An image change with 3 slots held: the old host lends while no new one can start, then stops lending and is deleted at its last release | soft draining | 4 |
| H7 | The plant-and-check of [what can pass between boxes](#what-can-pass-between-boxes-and-how-it-is-checked), with the held ports | isolation and reset | 3 |
| H8 | 10 watched devices on one Mac, in a host and a dedicated box, with the ledger on and off, and another VM starting meanwhile | the ledger, and what a VM's start costs streams (E1) | 6 |
| H9 | 8 held slots idle, each with its device, server and BB's daemon: the host's CPU and memory | the Tart host's size | 4 |
| H10 | Done (M18): a Namespace Mac's start, Xcode and runtimes, slimming, and its encoder: none in hardware, and idb's stream fails | Namespace stays off | 7 |
| H11 | A slot's reset on the pool's Mac, with its Full Disk Access: the sweep's time, and what is left | the pool Mac's reset | 5 |

M12 did what the first draft's H2 asked: a slot's user builds an iOS app
and passes an XCUITest on its own device. M14 to M16 did the review's
asks of H3 and finding 4 on a fresh BB: enrolment, the device server's
delivery and restart under a daemon, and a cold restart.

## Where this differs from the brief

- **Slots made ahead: one, and two in the image** (decision 3). Making a
  slot now takes 24 to 43 s, not the research's 155 to 410 s, and making
  one beside four watched devices left them at 55 fps (M3, M13). So a host
  keeps one ready while it holds a box, and `ahead` may be 2 where boxes
  come in bursts. The ios image carries two, so a new host's first box
  does not wait for one to be made.
- **Draining is soft** (decision 5). With hosts deleted at their last
  release (the owner's decision 6), an image change needs no replacement
  step. Decision 5 had new boxes wait while a host drained; this note lets
  the old host lend while no host on the new image can start, as the
  review asked (finding 7), since a box held for days would otherwise make
  every new ios box on that Mac wait. They still wait, with words, when
  nothing in the order can be had.
- **Shared becomes the default later** (decision 1): in unit 6, after
  bb-box's own enrolment of a slot passes and the ledger exists, not when
  hosts first work (review findings 4 and 16).
- **Streams follow the viewer's size by steps** (decision 2): a third, a
  half, two thirds or full, so a panel resized by a few pixels does not
  restart the stream. A recording asks for two thirds, not full size; at
  most two streams on a Mac are at full size (M11); screenshots stay full
  size and do not touch the encoder (M10).
- **A VM of its own comes last** in the owner's order. On a Tart Mac it can
  be reached only when no host could start, since both need a free VM slot;
  in practice a VM of its own is for `dedicated`, a size, or a project's
  ios image.
- **`macos` boxes in slots only when asked,** with `shared: true`, not as
  a fallback (review finding 11).
- **Namespace leaves the order for now** (the owner's decisions 8 and 9).
  Its Macs' VMs have no H.264 encoder, so idb sends a device no frames
  (M18). The design for Namespace hosts stands for when a device can
  stream there.
- **Against the research:** the encoder is the Mac's, not the VM's (E1),
  and its slow state is the encoder's two halves, not the other VM (M11);
  a device made by `simctl create` and seeded, not cloned or copied; a
  slot's UID from a range of its own.
- **Changes to 063:** a step change is not a geometry change; input is in
  device pixels on both platforms; idb's stream runs only while wanted; the
  device server in a slot is a daemon, restarted by exiting; a box in a
  slot has no host desktop; 063's suspended ios spare stays for dedicated
  boxes only.

## Open questions for the owner

1. **The pool's Mac: slots before whole boxes?** Default: an ios box takes
   a slot there whenever the Mac is not lent whole, and a `macos` or
   `macos-desktop` box for the pool then goes elsewhere or waits until its
   slots end. The other way would keep the pool's Mac whole whenever a
   whole box might come, and send ios boxes to Tart hosts first.
2. **A size without `dedicated`: refused, or a VM of its own?** Default:
   refused, in words that name `dedicated`, so an agent never takes a whole
   VM slot without asking for one.
3. **The held dev ports.** Default: the host's helper holds 3000, 4200,
   5000, 5173, 8000, 8080, 8081 and 19000 on 127.0.0.1 and answers with
   words, so a box that forgets its range fails loudly. The other way
   leaves them free, first come first served, with the risk of a test
   passing against another box's server.

## The owner's answers

Given on 26 October 2026, to the open questions above. Each is the
default:

1. **The pool's Mac lends slots before whole boxes.** A `macos` or
   `macos-desktop` box for the pool goes elsewhere or waits while slots
   are held.
2. **A size without `dedicated` is refused,** in words that name
   `dedicated`.
3. **The host holds the common dev ports** listed above, with words.

## Rejected

- **One user with several devices** (the research's option A). One
  CoreSimulatorService crash stops every box's device, and any box can
  drive, read or erase another's.
- **Copying or cloning a device into a slot's user.** A copied folder hung
  or booted with no app able to come to the front (the research); a clone
  from a shared set did the same (M4).
- **Applying the list at making:** 155 to 410 s against a seeded first boot
  of 10 to 28 s (M3, M13, POOL).
- **Reusing a slot's user for the next box,** with its device erased. Its
  keychain, caches, DerivedData and files left elsewhere would pass on. A
  new user per box is the reset, as the pool's (047).
- **UIDs that macOS chooses.** It gives them again, and the image owns
  files by one of them (M7).
- **A host kept up for spares.** It holds a VM slot for iOS while nobody
  uses one (the owner's decision 6). The ios image's two slots give a new
  host's first box most of what a spare would.
- **Two hosts on a Mac by default.** They share one encoder (E1), so the
  second adds slots but no watched streams, and takes the VM slot macOS
  boxes need.
- **A pool Mac lent whole and lending slots at once.** A whole box expects
  the Mac's cores, and its reset restarts userspace on macOS 27, which
  would stop every slot's device.
- **Full-size streams for every viewer.** Four watched iPhones at full size
  fill most of a Mac's encoder, two VMs' together (E1, M8).
- **An encoder arbiter in each host.** It could not see the other VM's
  streams, which share the encoder (E1). The plugin sees every stream on a
  Mac.
- **Holding a box to its share of the cores.** macOS has no cgroups;
  `taskpolicy` only lowers a process's priority (the research). Making and
  sweeping slots run at background priority; boxes do not.
- **A `macos` box in a slot as a silent fallback.** An agent that asked for
  `macos` to build would get no sudo, Homebrew or window (review finding
  11).
- **A check pass on every release.** A second walk of the volume for each
  slot doubles the sweep's cost on the host; the UID is never given again,
  so the check is the doctor's.

## Consequences

- A Tart Mac holds up to 8 ios boxes in one VM slot, and a macOS box or a
  dedicated ios box in the other; the pool's Mac up to 12 while it is not
  lent whole. Namespace holds none until its VMs can stream a device.
- Watched streams are limited per Mac, not per host: on the Tart Mac about
  12 busy at half size or 21 at a third, and on the pool's Mac about 16 at
  half size, before any is lowered; at most two at full size.
- No VM is held for iOS while no ios box runs. The first ios box on a Tart
  Mac waits about 50 to 60 s for a host and its enrolment, about as long as
  a dedicated box today; the next ones seconds.
- A box in a slot has no sudo, no Homebrew installs, no host desktop and no
  app windows, shares cores and its process list, and has ports of its
  own on a shared loopback. A restart of its host stops every box in it,
  and they come back by themselves.
- While the pool's Mac lends slots it is not lent whole.
- Namespace Macs cannot host ios boxes today: their VMs have no H.264
  encoder for idb's stream (M18).
- Slimming rests on an undocumented store; the device server's boot check
  stays the guard, at the cost of about 2 minutes to make a slot if a later
  Xcode moves it. Enrolment rests on BB's installer honouring
  `BB_INSTALL_SKIP_SERVICE` on macOS, which it does today.
- The ios image grows by two slots' first-boot data, about 3.2 GiB, once
  on the Mac's disk.
- The device server's protocol gains the viewer's size and input in device
  pixels.

## Review answers

An independent review by Claude Fable 5.1 read the first draft and said to
build after changes. Every finding changed the note.

| | Finding | Answer |
| --- | --- | --- |
| 1 | The order cannot be run by the registry; a starting host cannot be joined; bursts make several hosts | Changed. Each lender answers with a graded `SlotTier`; the registry chooses under one lock for device placement and holds it until the claim, promise or `starting` record is written; `starting` has `promised`, `making` has `for`; a lost `ln` race is asked again, three times: [Placing a box](#placing-a-box). Unit 4's live check acquires three at once and wants one host |
| 2 | The last release's delete races a claim; two writers of host state | Changed. The helper's `release` decides `last` under its lock and writes `deleting`, which refuses every later claim; the backend deletes after; the owner file is a cache; the upkeep finishes a `deleting` host: [The last release deletes the host](#the-last-release-deletes-the-host) |
| 3 | The image's carried slots break its own UID check; both boot at every start | Changed. Carried slots are `bbd-i1` and `bbd-i2`, UIDs 79991 and 79992, exempted by name and UID; nothing boots at the host's start; the first claim boots one, then the other boots as the ready slot: [Slots in the image](#slots-in-the-image) |
| 4 | Shared becomes the default before enrolment and the server-as-daemon are proven | Measured, and the flip moved. M14: two slots enrolled on a fresh BB and ran terminals through it; M15: the delivered server under a daemon, restarted in 0.3 to 1.3 s and from a new version in 1.7 s; M16: both back after a cold restart. The default flips in unit 6, after bb-box's own enrolment passes in unit 3; `connect`'s words when no server comes |
| 5 | Nothing bounds one box's load or shows whose it is | Changed. A booted-device bound, a disk reserve, a memory floor for lending, background priority for the helper's work, and each slot's cores, memory and disk in the helper's status; box_status names the busiest slot: [What one box can take from the others](#what-one-box-can-take-from-the-others). The encoder used by a box's own tools stays unseen, and the note says so |
| 6 | Shared loopback gives false passes against another box's server | Changed. A port range per slot in its environment, box_status and the skill; the common dev ports held by the helper with words: [Ports](#ports-a-range-for-each-box). Holding them is open question 3 |
| 7 | Draining is too strict; a Mac restart has no rule | Changed. Soft draining; `stopped`, with the backend starting a held host's VM as it does a box's; the restart measured (M16): [Tart hosts](#tart-hosts) |
| 8 | Half-made slots, cut sweeps and orphaned hosts | Changed. Every helper command re-runnable from its recorded step, `resume` at boot, and the upkeep's rows for `starting`, `deleting` and `failed`: [When a step is cut short](#when-a-step-is-cut-short) |
| 9 | The ledger: the probe, the count, who gets room, the words | Changed. Budgets by chip, a probe only on an empty ledger with two encoders; measured rates with a floor; the person in control first, Pixel for pixel for them always; words that name boxes; new hosts on the Mac with the fewest streams, with a warning while one starts: [The ledger](#the-ledger) |
| 10 | `most` counts resetting slots; a `find` per release | Changed. `most` counts making, ready and held; resetting has its own bound; one queued `find` sweeps every waiting UID, measured as fast for three as for one (M17); the check is the doctor's |
| 11 | `macos` in a slot as a silent fallback; capabilities per box | Changed. `shared: true` only; `capabilities` on the box record, read by every tool: [`macos` boxes in slots](#macos-boxes-in-slots), [The data shape](#slots) |
| 12 | Box operations undefined for a slot box | Changed. A table, each refusal in words naming `dedicated`: [What a box gives up in a slot](#what-a-box-gives-up-in-a-slot) |
| 13 | Illegal states in the shape | Changed. One placement, in `guest.data`; user and UID derived from the generation; `promised` and `for`; `stopped`; `resetting-whole` on the pool Mac and `slots` until the last slot is gone; settings as a snapshot; box_status reads a Namespace host's `endsAt` |
| 14 | Row 4 and row 6 on different bases | Changed. Both to the first frame and a connected BB machine: about 50 to 60 s and 50 to 57 s; "about as long", not "as long"; H1 measures first boxes on new hosts |
| 15 | Unit 1 changes Android's protocol unsaid | Changed. Android keeps full size; its input moves to device pixels with no change in effect; unit 1 runs E8 on Android |
| 16 | Phases: the relay's verbs, conformance, the setting's shape, the flip before the ledger, a page for a person, docs | Changed. `VIDEO_VERBS` gains the verb; conformance cases listed; [`ios-hosts`](#the-ios-hosts-setting) has keys and defaults; slot streams capped at two thirds until unit 6, which flips the default; the doctor's page of hosts in unit 4; the pool's and Namespace guides in units 5 and 7 |

The smaller points: the wait's words are one per cause; slot users are
never `admin`, and why `_developer`; the pool's setup and a Namespace
host's start install the lists and seeds; a Namespace host is the last
shared choice, for its short life, and box_acquire says when a box there
ends; a window dragged between screens restarts the stream at most twice,
which H4 measures.

After the review, H10 ran on Namespace (M18) and took Namespace out of the
order: its VMs cannot encode a device's video.
