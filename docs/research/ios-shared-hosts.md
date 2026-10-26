# Several iOS Simulators in one macOS VM

How bb-box could run several iOS Simulator devices in one macOS VM, each
serving a different ios box, so a Mac holds more than the two devices that
Apple's limit of two macOS VMs allows today; and what each box gives up
against a VM of its own.

Research, 26 October 2026: a note of what was known and measured then, not
the current design, which is in [the architecture](../architecture.md).
It follows [063](../decisions/063-device-boxes.md), which gives each ios box
a VM of its own, and the notes on
[iOS Simulator boxes](ios-simulator-boxes.md) and
[slimming](ios-simulator-slimming.md).

Status: measured on one Tart VM from the ios kind's image, first at 6 cores
and 16 GiB, then resized to 8 cores and 32 GiB, on one Mac host. macOS
27.0, Xcode 27.0 (27A266a), iOS 27.0 (24A434), idb_companion 1.7.7. Every
device was a slim iPhone 18 Pro, with all 112 labels of the image's list
disabled. Another thread's macOS VM ran on the same Mac throughout, in the
Mac's other slot.

## Recommendation

1. **Option B: a macOS user per box, in a shared VM.** Several ios boxes
   share one long-lived VM, each box a standard macOS user with its own
   device, as the SSH host pool already lends a Mac's users. It ran as
   fast as one user with the same devices (4 devices: 58.6 fps and 67 ms
   from tap to frame, against 59 fps and 61 ms), and one user's
   CoreSimulatorService crash, release or reset touched no other box. Use
   option A, one user with several devices, only for one box that wants
   several devices at once: there, one crash stops every box's device,
   and any box can drive, read or erase another's.
2. **What limits a shared VM is the video encoder, not CPU or memory.**
   The VM's hardware H.264 encoder gives about 300 frames a second at an
   iPhone's 1206x2622, in total. So 4 watched iPhones stream at 59 fps
   with a tap shown in 61 to 67 ms, the same as one device in its own VM.
   At 6 watched they fall to 52 fps and 142 to 146 ms; at 8, to 31 to 52
   fps and 202 to 206 ms. 8 cores and 32 GiB did not move this.
3. **Stream at the size the viewer shows.** Only devices someone watches
   use the encoder: 8 busy devices with 4 watched kept the 4 at 59 fps and
   66 ms. At half scale, 603x1311, 8 watched iPhones ran at 59 fps and 66
   ms, and 11 at 58 fps and 78 ms. A panel rarely shows a phone taller
   than 1,311 pixels, so the device server should ask idb for the
   viewer's size, not the device's.
4. **Size: a large VM, 8 cores and 32 GiB, with up to 8 boxes.** A busy
   device (Safari drawing every frame) takes about 0.5 of a core with its
   stream, and 0.27 to 0.39 GiB of the VM's memory; an idle slim device
   about 0.01 of a core. 12 busy devices took 6.4 to 7.1 of 8 cores. Builds
   are what boxes feel from each other: a build that took 49 s alone took
   95 s beside 4 streaming devices, and two builds took 166 s each.
   Devices kept 59 fps and 64 ms through two builds at 97% CPU.
5. **Make each box's user and device ahead.** A new user takes 2 s and its
   removal 3.4 s. A slim device takes 155 s to make in a quiet VM, and 390
   to 410 s each when three are made at once, which loads the VM's other
   boxes. So a host keeps one or two slots ready, made one at a time, as
   the pool makes its next user ahead.
6. **A box in a shared VM gives up:** sudo and `brew install`; its own
   loopback and ports; privacy of its process list; cores and memory of
   its own; and a share of the encoder that can fall when others watch.
   Boxes are not a security boundary, as in the pool (047). Keep today's
   VM of its own as a size, for builds that need the cores and for root.

On one Mac, two large shared VMs would hold up to 16 ios boxes instead of
2, if the encoder is the VM's. If it is the Mac's media engine, shared by
both VMs, which one run suggests, the limit on watched devices is per Mac:
about 4 at full size, or 11 at half. That is the first open question.

## The options

| | A: one user, several devices | B: a user per box | C: a VM per box (today) |
| --- | --- | --- | --- |
| What a box is | a device in the VM user's one device set | a standard macOS user in a shared VM, with its own device set | a Tart VM cloned from `bb-box-ios`, with one device |
| Boxes a Mac holds | as many as the VM holds | as many as the VM holds | 2, Apple's limit |
| Root, `brew install` | shared: one user, with sudo | no | yes |
| One box sees another's device, files, keychain | yes | no | no |
| One crash of CoreSimulatorService stops | every box's device | that box's device | that box's device |
| Reset after release | erase or delete the device; the files stay | remove the user: 3.4 s | delete the VM |
| Measured here | yes | yes | yes, as one device in the VM |

## How it was measured

Scripts and raw results are in [ios-shared-hosts](ios-shared-hosts/):

- [multi.ts](ios-shared-hosts/multi.ts) opens one idb `video_stream` per
  device over the companion's unix socket, with the device server's own
  gRPC client from `src/device`. It taps each device once a second, the
  devices' taps spread through the second, by idb's HID stream, for 30 s
  unless said. It counts frames, and writes each device's H.264 and each
  frame's arrival time. With `--sample` it reads the VM's CPU from `top`
  over the window, every process's CPU time from `ps` at both ends, memory
  from `memory_pressure` and `vm_stat`, and GPU memory in use from
  `ioreg` every 2 s. Tart's paravirtual GPU reports no utilisation, only
  memory in use, so the result's `gpuUtilisation` holds MiB.
- [page.html](ios-shared-hosts/page.html), open in each device's Safari,
  redraws a counter and a spinner every frame, and turns the page black or
  white at each touch.
- [analyse.py](ios-shared-hosts/analyse.py) decodes each saved stream
  with ffmpeg and reads one pixel's shade, at (60, 1700) in the device's
  pixels, in every frame. Tap to frame is from the HID event leaving the
  client to the arrival of the first frame whose shade there changed. It
  is measured in the VM, as 063's 53 to 64 ms were: BB's relay, the
  network and the browser are not in it.
- [devices.sh](ios-shared-hosts/devices.sh) makes slim clones of the
  image's iPhone 18 Pro, boots them, starts one idb_companion each and
  opens the page. [sweep.sh](ios-shared-hosts/sweep.sh) runs 1, 2, 4, 6
  and 8 devices, with each device's `phys_footprint` from the slimming
  note's [simtree.py](ios-simulator-slimming/simtree.py).
- [users.sh](ios-shared-hosts/users.sh) makes and removes macOS users and
  runs commands as them over SSH, as the pool reaches a box user.
  [user-device.sh](ios-shared-hosts/user-device.sh) gives a user a slim
  device, [user-up.sh](ios-shared-hosts/user-up.sh) boots and streams it,
  and [users-run.sh](ios-shared-hosts/users-run.sh) measures several users
  at once, each with its own harness, started at the same moment.
- [lifecycle.sh](ios-shared-hosts/lifecycle.sh) streams 4 devices while
  it boots, erases, shuts down and switches others, and
  [events.py](ios-shared-hosts/events.py) gives each streaming device's
  frame rate and worst gap from each event's start to 2 s after its end.
- [builds.sh](ios-shared-hosts/builds.sh) builds a generated Swift
  package of 2,000 files, from
  [build-load.sh](ios-shared-hosts/build-load.sh), for the simulator,
  arm64 only, with a clean DerivedData each time.
- [isolation.sh](ios-shared-hosts/isolation.sh) has one box user try to
  reach another's home, devices, idb socket, processes and loopback.

The box was an `ios` box, not a `macos-desktop` box with the iOS layer
built in it: it is the same Tart VM, from the image 063 built, with the
slim devices and idb_companion already in it. Its own device server was
stopped first. The 8-core runs are the same VM after `box_resize` to
large, which restarts it.

In the run JSONs, each device's `tap` field is a first guess from frame
sizes, which proved wrong (see [What went wrong](#what-went-wrong-and-what-it-teaches)).
Only `taps.json`, from decoded pixels, is used here.

## 1. Density

Each device: a slim iPhone 18 Pro, Safari busy on the page, its own
idb_companion, watched at the device's full 1206x2622, tapped once a
second. Frames a second and tap to frame are each device's; the range is
across devices. CPU is the VM's, from `top`.

6 cores, 16 GiB ([results/m6](ios-shared-hosts/results/m6/)):

| Devices | Frames a second | Tap to frame: median, p95, worst | VM CPU used | VM memory free | Footprint summed | GPU memory |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 57.1 | 62, 73, 98 ms | 0.87 cores | 82% | 656 MiB | 285 MiB |
| 2 | 57.1 to 57.4 | 65, 72, 74 ms | 1.33 | 81% | 1,320 MiB | 454 MiB |
| 4 | 58.9 to 59.1 | 61, 74, 80 ms | 2.29 | 77% | 2,747 MiB | 822 MiB |
| 6 | 52.4 to 52.7 | 142, 157, 214 ms | 3.83 | 72% | 4,390 MiB | 1,283 MiB |
| 8 | 31.2 to 52.1 | 206, 232, 251 ms | 3.86 | 65% | 6,311 MiB | 1,678 MiB |

8 cores, 32 GiB ([results/l8](ios-shared-hosts/results/l8/)):

| Devices | Frames a second | Tap to frame: median, p95, worst | VM CPU used | VM memory free | Footprint summed | GPU memory |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 56.5 | 63, 73, 75 ms | 0.90 cores | 93% | 671 MiB | 324 MiB |
| 2 | 56.9 to 57.1 | 64, 74, 76 ms | 1.30 | 93% | 1,353 MiB | 484 MiB |
| 4 | 58.5 to 58.8 | 64, 75, 80 ms | 2.28 | 91% | 2,709 MiB | 805 MiB |
| 6 | 52.4 to 52.6 | 146, 158, 161 ms | 3.45 | 89% | 4,091 MiB | 1,233 MiB |
| 8 | 31.6 to 52.6 | 202, 231, 243 ms | 4.43 | 87% | 5,504 MiB | 1,601 MiB |

No swap was used in any run. No tap was missed.

**Where it breaks down, and why.** From 4 to 6 watched devices, every
device fell from 59 to 52 fps and its taps took 80 ms longer; at 8, some
fell to 31 fps and took 150 ms longer. The frame rates are fixed steps,
52.5 and 31.5, not a gradual fall, and they were the same at 6 and 8
cores. CPU was 36% idle at 8 devices on 6 cores and 55% idle on 8 cores.
So the limit is not CPU, memory or the simulators' drawing. Three tests
point at the encoder:

| Test | Result |
| --- | --- |
| 8 devices busy, only 4 watched (6 cores) | the 4 at 59 fps, 66 ms median, 71 ms p95 |
| 8 devices watched at half scale, 603x1311 (6 cores) | all 8 at 58.6 to 58.9 fps, 66 ms median, 78 ms p95 |
| ffmpeg's `h264_videotoolbox` at 1206x2622, flat out, no simulators | 1 encoder: 156 fps; 2: 75 fps each; 4: 75 fps each; 6: 50 fps each. About 300 frames a second in total |
| The same at 604x1312 | 8 encoders: 116 fps each; 16: 59 fps each. About 940 frames a second in total |

At full size the simulators reached about 315 frames a second in total,
the same ceiling as ffmpeg's. Every device has its own SimRenderServer,
three SimMetalHost processes and its own VTEncoderXPCService, so nothing
per user or per device is shared but the encoder. When the encoder is
full, frames queue in it, so the latency grows before the frame rate falls
far.

**12 devices on 8 cores** ([results/l12](ios-shared-hosts/results/l12/)).
One device's Safari did not open its page, so 11 were busy and watched:

| Watched | Frames a second | Tap to frame: median, p95 | VM CPU used | VM memory free |
| --- | --- | --- | --- | --- |
| 4 of 12, full size | 53.4 to 57.5 | 66 ms on one; 138 to 147 ms on three | 7.1 of 8 cores | 84% |
| 11, half size | 57.6 to 58.1 | 67 to 84 ms; p95 85 to 116 ms | 6.7 | 84% |
| 11, full size | 26.3 to 31.6 | 216 to 253 ms | 6.4 | 83% |

With 12 busy devices CPU is near its end too: 6.4 to 7.1 of 8 cores, most
of it each device's Safari drawing at 60 fps, which is the app's work and
would be a real app's. A busy device costs about 0.5 of a core all told:
its own processes about 0.45, its companion 0.05 to 0.1, and its render
server, encoder service and Metal hosts about 0.05 each.

**The ceiling moves.** In a later run, 4 watched devices with nothing else
running were in the slow state: three at 52.9 fps and 145 ms, one at 66
ms ([results/build4](ios-shared-hosts/results/build4/)), where the first
sweep had all 4 at 59 fps and 61 ms. Minutes later, during two builds at
97% CPU, the same 4 were at 59 fps and 64 ms. The VM's own load does not
explain it. The likeliest cause is the Mac's media engine shared with the
other macOS VM on the host, which another thread was using. This was not
measured: it needs both of the Mac's slots at once.

**Memory is not the limit.** A busy slim device took 0.39 GiB of the
VM's free memory on 16 GiB and 0.27 GiB on 32 GiB (the fall in
`memory_pressure`'s free share from 1 to 8 devices), and about 0.3 GiB
more wired memory and 0.2 GiB of GPU memory each. Its summed
`phys_footprint`, Safari open, was 0.65 to 0.79 GiB, which counts pages
more than once. The slimming note's 0.21 GiB was an idle device.

**Idle devices.** An idle slim device costs about 0.01 of a core, and
sends no frames, so it costs no encoder either.

## 2. Builds

A Swift package of 2,000 generated files, built for the iOS Simulator,
arm64, in Debug, with an empty DerivedData each time, on 6 cores and
16 GiB ([results/build4](ios-shared-hosts/results/build4/)).

| | Build time | The 4 devices: frames a second | Tap to frame: median, p95, worst | VM CPU used |
| --- | --- | --- | --- | --- |
| One build, no devices | 49.7 s, 48.1 s | | | |
| Two at once, no devices | 89.0 s, 89.6 s | | | |
| 4 devices watched, no build | | 52.9 to 56.1 | 142, 155, 161 ms (the slow state above) | 2.3 cores |
| One build while 4 watched | 94.8 s | 52.2 to 57.5 | 147, 172, 211 ms; one device 68 ms | 4.2 cores |
| Two builds while 4 watched | 166.3 s, 165.7 s | 59.1 to 59.2 | 64, 73, 109 ms | 5.8 cores, 97% |

- **On the devices:** little. Through two builds at 97% CPU the devices
  kept 59 fps and 64 ms. The worst gap between frames rose from about 40
  ms to about 100 ms during one build. The slow tap times in the one-build
  run are the encoder's slow state, which the no-build run just before it
  had too.
- **On the builds:** a lot. Beside 4 streaming devices one build took 95 s
  instead of 49 s, and two builds 166 s instead of 89 s. The streaming
  devices took about 2.3 of the 6 cores, and the compiler got less than
  the rest.
- **On each other:** two builds at once take 1.8 times as long as one, as
  expected on shared cores. macOS has no cgroups: a box in a shared VM
  cannot be held to a share of the cores, only lowered in priority
  (`taskpolicy`).

## 3. Isolation

### B: what one box user can do to another

Run by [isolation.sh](ios-shared-hosts/isolation.sh) as one box user
against another, both standard users with their own device booted and
streaming ([results/isolation.txt](ios-shared-hosts/results/isolation.txt)):

| What one box tried | Result |
| --- | --- |
| List the other's home | yes: its top level only, as macOS makes homes `drwxr-x---` for `staff` |
| Read the other's `Library`, device set, keychain or DerivedData | no: permission denied |
| Write into the other's home | no |
| `simctl` on the other's device set, or its device by UDID | no: "Provided set path does not exist", "Invalid device" |
| Connect to the other's idb_companion socket | no: permission denied |
| See the other's processes, with their command lines and device UDID | yes: `ps` shows every user's |
| Signal the other's processes | no: "operation not permitted" |
| Reach a server the other runs on 127.0.0.1 | yes: one network stack. Simulators do too: every user's Safari loaded the page served on 127.0.0.1 by the VM's own user |
| Bind a port the other holds | no: "Address already in use", on 127.0.0.1 and on any address |
| Files in `/tmp` | none of the other's were there; `/tmp` is shared, so what a box leaves readable there, others can read |

So B keeps one box's device, files, keychain and input from another, and
does not keep apart their network or what `ps` shows. That is what the
pool's Mac gives too (047): boxes are not a security boundary. Two more
from 047 hold here: the VM's own user, which runs bb-box's machine and
has sudo, has a home other users can list unless it is made `700`; and a
box user must not be an administrator, or removing it is no reset.

### A: what one user gives up

Everything above. Every box's device is in one device set under one
CoreSimulatorService, so any box can screenshot, drive, install into,
erase or shut down another's device with `simctl` or its companion; read
its apps' data, DerivedData and keychain; and kill its processes. And one
crash stops them all ([Lifecycle](#4-lifecycle)).

## 4. Lifecycle

### A: four devices streaming while others change

[results/life4](ios-shared-hosts/results/life4/), 6 cores and 16 GiB. Before
the first event the 4 ran at 58.7 to 59.2 fps with a worst gap of 33 to 41
ms.

| Event | Its time | The 4 streaming devices: frames a second, worst gap |
| --- | --- | --- |
| Boot a fifth device | 3.9 s | 57.9 to 58.7 fps, 65 to 73 ms |
| Release the fifth: shut down and erase | 3.6 s | 58.3 to 58.6 fps, 58 to 74 ms |
| Boot the erased fifth: a first boot again | 25.7 s | 58.6 to 58.8 fps, 88 to 91 ms |
| Shut the fifth down | 3.3 s | 57.6 to 58.4 fps, 46 to 52 ms |
| Kill one device's idb_companion | 39 ms | the other 3: 59.8 fps, 24 to 35 ms |
| Switch one box to the iPad: shut its iPhone down | 3.2 s | the 2 still measured: 57.4 to 57.7 fps, 124 to 130 ms |
| Then boot the iPad | 2.3 s | the 2 still measured: 57.7 to 58.0 fps, 49 to 50 ms |

The harness did not reconnect to a killed companion or a switched device,
so their own streams end there; 063's server does reconnect (063 results,
unit 4.2).

### B: one user removed while three stream

[results/breset](ios-shared-hosts/results/breset/): removing a user whose
device was booted, by `launchctl bootout`, killing its processes,
`sysadminctl -deleteUser` and removing its home, took 3.4 s. Its home held
1,359 MiB. The three others ran at 57.6 to 58.7 fps with a worst gap of 32
to 37 ms during it, against 40 to 42 ms before. 63 files of the removed
user were left in `/private/var/folders`, Spotlight's among them, as 047
found on a physical Mac.

### A crash of CoreSimulatorService

| | A: the one user's, 4 devices streaming ([results/acss](ios-shared-hosts/results/acss/)) | B: one user's, 3 users streaming ([results/bcss](ios-shared-hosts/results/bcss/)) |
| --- | --- | --- |
| Devices shut down | all 4 | that user's only |
| The others | none left | 55.5 and 56.9 fps, worst gap 42 and 48 ms |
| The crashed user's idb_companion | its HID connection invalidated | the same |

In B, launchd had a new CoreSimulatorService for the user within 5 s. Each
stopped device has to be booted again and its companion started again: in
A that is every box's, in B one box's.

### A VM restart

The resize to 8 cores and 32 GiB restarted the VM in 55 s. Booting 8 slim
devices at once after it took 29 to 55 s each, cold, and all 8 had a
companion listening 62 s after the first boot was asked for. One cold
device alone booted in 8.8 s in 063 (unit 3.2). A restart of a shared VM
stops every box in it for about a minute plus macOS's boot.

### Making a box's device

| Way | Time | Slim after it |
| --- | --- | --- |
| `simctl clone` of the image's device, in the same user, then the list applied twice with reboots | 215 to 346 s each, four at once | yes, 112 of 112 |
| `simctl create`, first boot, the list applied twice with reboots, in a new user | 155 s alone; 387 to 410 s each, three at once | yes |
| Copy the device's folder into another user's set, keeping its UDID | the device hung booting: `bootstatus` never returned, `simctl` to it hung | |
| The same with a new UDID | copied in 2.3 to 3.8 s; booted 7 s later alone, 32 to 66 s with two others booting | no: 0 of 112; the list then took 118 to 133 s. Apps did not come to the front: `simctl openurl` and `launch` left the Home Screen showing |
| A new macOS user | 1.8 to 6.0 s | |

So the only working ways are Apple's, `simctl create` or `simctl clone`,
and either needs the list applied after it, about 2 minutes of a core or
more. `simctl clone` can write into another user's device set by path, which
was not tried. Where launchd_sim keeps the disabled labels is still not
known (the slimming note's open question 4); a quick search of the user's
`Library` and the device's folder did not find it.

## 5. Fit with bb-box

### A sketch: a device host

A **device host** is a long-lived Tart VM from the ios image, which no
thread holds. It lends **slots**: each slot is one macOS user with one
device, made ahead, and a box is a slot. This is the SSH pool's machine
lent with a new user (047), many times in one VM, inside the Tart backend.

```ts
interface DeviceHost {
  readonly id: string;                         // the host VM's name on its Mac
  readonly mac: string;                        // the Tart Mac it runs on
  readonly image: { readonly name: string; readonly build: string };
  readonly size: { readonly cores: number; readonly memoryGiB: number };
  readonly slots: number;                      // most boxes at once: 8 on a large VM
  readonly ready: number;                      // slots kept made ahead: 1 or 2
  readonly watchBudget: number;                // frames a second its encoder gives at full size: about 300
  readonly state: "starting" | "serving" | "draining" | "stopped";
}

type SlotState =
  | { readonly is: "making"; readonly since: number }        // user and device being made
  | { readonly is: "ready" }                                  // user made, device slim, shut down or booted idle
  | { readonly is: "lent"; readonly box: string; readonly thread: string }
  | { readonly is: "resetting"; readonly since: number };

interface Slot {
  readonly host: string;
  readonly user: string;                       // bbd-<generation>, a standard user, hidden, in _developer
  readonly generation: number;
  readonly device: { readonly model: string; readonly udid: string } | null;
  readonly state: SlotState;
}

type Placement =
  | { readonly on: "vm" }                                    // C: today's box, a VM of its own
  | { readonly on: "slot"; readonly host: string; readonly user: string };
```

The box record gains `placement`. Everything else of a device box is as 063
has it: the model, the state, the controls and the panel do not change.

### The device server: one per box

- **Per box, as now.** Each slot's user runs its own `bb-box-device`,
  with its socket in its own home, reached by `connect` over that user's
  SSH. That keeps 063's lease, versions and recovery per box, and the
  server's permission to its companion is the user's own.
- **Started by a LaunchDaemon with `UserName`.** A user with no console
  session has no `gui` domain, so 063's LaunchAgent cannot load: as the
  user, `launchctl bootstrap gui/<uid>` failed with "Domain does not support
  specified action", and `bootstrap user/<uid>` failed with an
  input/output error, also from root. A daemon in `/Library/LaunchDaemons`
  with `UserName` set to the box user ran as that user, and `simctl` in it
  saw the user's devices. The host's helper writes and removes it with the
  slot.
- **One thing per VM: the encoder budget.** Each server asks idb for the
  viewer's size, not the device's: idb's `scale_factor`, which 063's
  server sets to 1. With panels' sizes that keeps most streams at half or
  less. As a guard, the host's helper keeps a count of full-size streams
  in the VM, and a server that would pass the budget streams at half.
- **Simulators survive the SSH session.** A user's devices and
  CoreSimulatorService ran on after each SSH command ended, and over
  separate sessions.

### Placing a box

- An ios box asks for `placement: slot` by default where a device host
  has a ready slot, and a VM of its own otherwise, or when asked for a size
  (a size is a VM's).
- A claim takes a ready slot: it writes the marker, adds the thread's SSH
  key, boots the device if it is shut down (about 2 s once booted before
  in that slot, 9 to 12 s cold), and starts the device server. Seconds,
  as a pool claim.
- A release removes the user, its daemon and its files (3.4 s here), and
  the host makes a new slot when it has fewer ready than `ready`, one at
  a time, at low priority (`taskpolicy -b`), as making one costs about 2.5
  minutes of a core and loads the others.
- A model other than the slot's: the slot's user makes it with `simctl
  create` and the list, about 2.5 minutes, or the host keeps ready slots
  of more than one model.

### Spares and the two-VM limit

- A device host takes one of the Mac's two slots for as long as it serves,
  whether it lends 1 box or 8. On a Mac that also runs macOS and Windows
  boxes, a host leaves one slot for them.
- Its ready slots are the spares: a ready slot costs a user, a device's
  disk, and, if the device waits booted, about 0.01 of a core and 0.3 GiB.
  063's suspended-VM spare is not needed for slots.
- The host itself is started ahead and kept running. Updating its image
  means draining it: no new slots, the lent ones left until released, then
  a new host from the new image. With two hosts on a Mac, one drains
  while the other serves; with one, ios boxes go to VMs of their own
  meanwhile.
- A host restart stops every box in it for about 2 minutes: 55 s of VM,
  then about 60 s for 8 devices. Only the operator, an update, or a crash
  should cause one.

### Sizes to offer

| Size | What it is | For |
| --- | --- | --- |
| shared (default) | a slot in a device host: no cores of its own, no sudo | running and testing an app, the panel, the agent's computer tools |
| medium, large | today's: a VM of its own, 6 cores and 16 GiB, or 8 and 32 | heavy builds, root, `brew install`, an app that needs its own ports |

A host: large, 8 cores and 32 GiB, with 8 slots. Memory would hold many
more; CPU holds about 12 devices busy at once, with nothing left for builds;
the encoder holds 4 watched at full size, or about 11 at half.

## What a box gives up in a shared VM

Against a VM of its own (C), a box in option B:

| | B | C |
| --- | --- | --- |
| Watching its device | the same, 59 fps and 61 to 67 ms, while 4 or fewer stream at full size in the VM; 52 fps and about 145 ms at 6 | 57 fps and 62 ms |
| Builds | shared cores: a 49 s build took 95 s beside 4 streaming devices | its own 6 or 8 cores |
| Root, `brew install`, system settings | no | yes |
| Ports and loopback | shared with every box in the VM | its own |
| Process list | every box's, with device UDIDs | its own |
| Files, keychain, device, input | its own | its own |
| A crash of CoreSimulatorService | its own device only | its own device only |
| A restart of the VM | every box in it, about 2 minutes | its own |
| Ready time | a ready slot: seconds | a spare: Tart's resume; a new box: 37 s and the device |
| Mac's slots | an eighth of one | one whole |

## What went wrong, and what it teaches

1. **A frame's size is no sign of a tap on a busy screen.** The first
   page drew noise on a tap, for a large frame. VideoToolbox's rate control
   then starved the next frames, about 1 KB each, so the next tap's noise
   came out small, and every second tap was missed. A page that kept the
   noise showing dropped the stream to 13 fps. Repeating one noise image
   was predicted from an older reference frame. Decoding the frames and
   reading a pixel's shade has none of these faults. It is also cheap: one
   device's 20 s decoded in under a second.
2. **A device folder is not portable between users.** Copied with its
   UDID, the device hung booting; with a new UDID, it booted but no app
   came to the front. Make devices with `simctl`.
3. **A command's time limit stops what it started.** A `box_run` that ran
   past its limit stopped the idb_companions it had started with `nohup`,
   which cut the first 12-device run short. Long runs go in a job that
   returns at once.
4. **bb-box restarts a stopped device server.** Booting it out was not
   enough: on its next look the plugin started it again and it booted the
   default device. It had to be disabled and its LaunchAgent moved away.

## What limits this

- One Mac, with another thread's macOS VM in its other slot all the time.
  Whether the encoder is the VM's or the Mac's is not known, and the slow
  state with 4 devices suggests the Mac's.
- One model, the iPhone 18 Pro. An iPad Pro 13-inch has 1.8 times its
  pixels, so it costs the encoder about 1.8 iPhones.
- One app: Safari redrawing a page at 60 fps. A real app draws only when
  something changes, so its stream and CPU are lower most of the time;
  this is the worst case for both.
- Option B was measured with 4 users. Its streams, CPU and memory matched
  A's at 4, and nothing in B is shared but what A shares, so its knee is
  taken to be A's. 6 and 8 users were not run.
- Tap to frame is in the VM. Through BB, add about 25 ms (060).
- 30 s per run, one run per point, except where two are given. The
  encoder's slow state came and went between runs.

## Open questions for the owner

1. **The encoder: per VM or per Mac?** It decides whether two device hosts
   give 8 watched devices or 4. Measuring it needs both of the Mac's slots
   at once for about 20 minutes.
2. **Is B's trade right for ios boxes?** No sudo or `brew install`, shared
   ports, a shared process list and shared cores, for up to 8 boxes a VM
   instead of 1. Or offer it as a size, `shared`, beside today's?
3. **Stream at the viewer's size.** It changes 063's server, which asks
   idb for the device's own size. Should a person still be able to ask for
   full size?
4. **How many slots, and how many ready.** 8 slots on a large host, 1 or 2
   ready, made one at a time?
5. **The device server as a LaunchDaemon** with `UserName`, written by the
   host's helper: a change from 063's LaunchAgent for slots only.
6. **Where launchd_sim keeps disabled labels.** If found, a slot's device
   could be cloned slim in seconds instead of about 2 minutes.
7. **Draining for updates.** With one host a Mac, image updates move ios
   boxes to VMs of their own while the host drains. Is that acceptable, or
   should a Mac with a host keep both slots for hosts?

## Rerunning the measurements

In an ios box, with this folder and `src/` copied to `~/bb-box`, and its
device server stopped:

```sh
launchctl disable gui/$(id -u)/app.bb-box.device
launchctl bootout gui/$(id -u)/app.bb-box.device
mv ~/Library/LaunchAgents/app.bb-box.device.plist ~/app.bb-box.device.plist.off
cd ~/bb-box/docs/research/ios-shared-hosts
nohup python3 -m http.server 8765 --bind 127.0.0.1 >/tmp/http.log 2>&1 &
./devices.sh make 8 4
nohup ./sweep.sh m6 1 2 4 6 8 >~/shared/sweep.log 2>&1 &
```

For option B, copy the repository to `/Users/Shared/bb-box` readable by
all, then `./users.sh key`, `./users.sh make sbu1 sbu2 sbu3 sbu4`,
`./user-device.sh create sbu1` for each, and
`./users-run.sh b4 sbu1 sbu2 sbu3 sbu4`. ffmpeg is in the image.
