# 068: results

What was run for [068](068-boat-backend.md) on 29 October 2026, on a boat.dev
trial account, and what it measured. Times are wall-clock, from the machine
that called boat's API, polling the API every 0.5 s and SSH every 0.3 s.

## A sandbox's life

A stock `small` sandbox, created, stopped, resumed and forked from BB's
server, with no account secrets (`noEnv`):

| Step | Time |
| --- | --- |
| Create to `ready` | 1.1 s |
| Create to first SSH, with a key added through the API | 2.4 s |
| Stop to `archived` | 2.1 s |
| Resume to `ready` | 0.5 s |
| Resume to first SSH, its files there | 1.0 s |
| Fork of a stopped stock sandbox to `ready` | 2.4 s |
| Fork of a stopped stock sandbox to first SSH, its files there | 3.5 s |

What else it showed:

- **Saved snapshots are refused on the trial**
  (`403 trial_saved_snapshots_not_allowed`), so a template is a stopped
  sandbox, as 068 decides.
- **boat ran out of machines** for at least 6 minutes, from 14:55 to 15:01:
  every create and fork, with `failFast` or without, answered
  `503 out_of_capacity` with `retryAfterSeconds: 120`. bb-box tries again
  for up to 2 minutes, then refuses the box as `no_capacity`, so another
  backend can take it.
- **A sandbox's machine is boat's base image, already running, with the
  sandbox's changes laid over it.** A fork's machine had been up 17 minutes
  when it answered. Its changed system files arrived over the next 20 to
  30 s, then Docker and the enabled services started again; `hydrated` came
  35 s after the fork. A stop followed at once by a resume brought back the
  same running machine (uptime unbroken), so a restart is no test of a
  template: bb-box checks its templates in a fork, as boxes are.
- **Boat's image is not Ubuntu's cloud image.** It has Docker CE 29.7, Node
  in `/usr/local/bin`, Claude Code, Codex and other agents, Chrome, a
  desktop on `:0` (LightDM, Openbox, Sunshine, moonlight-web), and apt
  sources for a PHP PPA, CRAN, NodeSource, Microsoft, Chrome and Docker. Its
  user is `user`, uid 1000. bb-box's guest scripts needed three changes
  around them, in `setup/boat/template.sh`: boat's extra apt sources are set
  aside during the build (the PPA has no dated snapshot, which the scripts
  pin to), boat's Docker CE goes for Ubuntu's `docker.io` (they conflict),
  and boat's commands that bb-box's pinned tools replace move to
  `/usr/local/lib/boat-tools`.
- **A fork comes up with `docker.socket` stopped** and the removed base
  units failed, so the template has a service, `bb-box-boat-ready`, that
  boat starts once the system files are there: it clears the failed units,
  starts `docker.socket`, and writes `/run/bb-box/boat-ready`, which an
  acquire waits for.
- **A sandbox cannot reach a BB server on a private network**: a request to
  BB's URL from a sandbox timed out after 8 s. The doctor's `boat.bb` says
  so with its fix.

## Through bb-box's own code

`scripts/smoke.ts` on a Linux box beside BB's server, with the trial's key,
the backend as this branch has it:

| Run | Template | fork | ready | ssh | settle | Acquire | Command | Release |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| First box of `linux` | built, with its check in a fork | 0.43 s | 4.17 s | 5.22 s | 4.51 s | 361.4 s | 5.7 s | 0.84 s |
| Second | forked | 0.38 s | 4.26 s | 5.25 s | 1.60 s | 11.7 s | 0.14 s | 0.28 s |
| Third | forked | 0.39 s | 2.67 s | 4.71 s | 0.85 s | 8.8 s | 0.13 s | 0.23 s |

`ssh` includes giving the box user this install's key through boat's own
user; `settle` is waiting for `bb-box-boat-ready` and for Docker to answer.
The template's build took about 6 minutes: about 5 for the guest scripts,
then finalizing, stopping, and checking a fork of it as the box user, all
checks passing but "docker stopped after boot", which boat answers for (it
starts Docker with the machine). The command ran `uname -a`, Docker's
`hello-world`, and showed `/dev/kvm` to the box user, in the `kvm` group.

## On a separate BB

A fresh `npx bb-app` (0.48.0) with no account, in a Proxmox LXC box, its own
data folder and ports, bb-box installed from this branch with
`bb plugin install path:`, the boat backend set by `bb box config apply`
with the key read from a file `box_copy` put there. With no agent login
there, the panel's RPCs were called over BB's HTTP API, as the panel calls
them, and commands ran through the panel's terminal WebSocket, for a thread
made with `bb thread spawn`.

| Step | First run | Second run | Third run, the bundle's tree |
| --- | --- | --- | --- |
| `bb box doctor` | boat.dev API ok on the trial plan; plan limits; `boat.bb` skipped, as this BB has no URL; templates; sandboxes | same | same, naming the template it forks |
| Acquire `linux`, the template the smoke runs' install built forked | ready in 12.3 s: fork 0.53, ready 3.26, ssh 4.08, settle 3.77 s | 24.6 s: fork 0.79, ready 4.32, ssh 18.17, settle 0.18 s | 17.4 s: fork 0.40, ready 3.64, ssh 8.74, settle 4.27 s |
| A command in the terminal | `uname`, `id` (box, in docker and kvm), Docker 29.7.0, `/dev/kvm`; first byte in 24 ms | same, first byte in 16 ms | same, first byte in 22 ms |
| A file copied in through the terminal | (sent as one 350 KB line, which the terminal's line limit cut) | 256 KiB, its SHA-256 matching in the box | the same |
| Stop | 18.9 s | 17.1 s | 6.7 s |
| Start | 1.2 s to ready | 2.0 s to ready, the copied file still there | 1.6 s, the file still there |
| Release | 0.5 s, and boat's list showed only the template | 0.5 s, the same | 1.8 s, the same |
| Phase 2's build, last | ready in 33.3 s (ssh 20.0 s); the command, the file, stop 8.2 s, start 1.4 s with the file there, release 0.6 s | | |
| Enrolment | failed in BB's words: "Sign in to your bb account to use bb connect", as this BB has no URL a sandbox reaches | same | the same |

The second acquire's 18 s of `ssh` was the sandbox's system files arriving
late; the first and the smoke runs' were 4 to 5 s.

## The conformance suite

`npm run conformance -- --backend boat --kind linux`, live on the trial
account, from the Linux box beside BB's server: 22 passed, none failed, 8
skipped, in 135 s.

- Passed: the doctor; kinds and capacity; refusing a kind it lacks; an
  acquire that records the guest before it changes anything (ready in
  20.9 s: fork 0.34, ready 4.56, ssh 10.28, settle 5.46 s); the transports;
  a spawned channel; commands with stdin, exit codes and a timeout; the OS
  and architecture; streamed output; 32 MiB copied each way; Docker; the
  test device's server (063); stop and start; a new instance on empty
  storage naming the box's owner; a new instance finding and releasing the
  box; releasing twice; a `medium` box read back at its size; acquires
  cancelled at claim and at starting leaving nothing; two installs leaving
  each other's boxes alone, the second forking the first's template.
- Skipped, with the run's reasons: enrolment and reconnecting to BB (no BB
  server that a sandbox reaches in this run); the presets' sizes and resize
  (the trial refuses `large` and `xlarge`, so `large` and `largest` cannot
  be made, and the backend resizes nothing); and, by the suite, a pool, image
  builds and reused references, which the backend does not have.

## The Linux desktop, first try

The first `linux-desktop-cpu` template build, through the smoke script,
stopped in `customize-desktop.sh` after 5 minutes: boat's image has Rust in
`/usr/local/rustup` and `/usr/local/cargo`, and the guest scripts' rustup
would not install over it ("cannot install while Rust is installed", then
"Permission denied" on `/usr/local/rustup/settings.toml`). The build
sandbox was deleted. So this bundle offers `linux` only; the desktop
follows in phase 2.

## In production

After phase 1 was deployed (main `97fed57a`), with the boat backend on
with the owner's key and the tailnet on, from an agent thread with BB's
own tools:

| Step | Result |
| --- | --- |
| `box_acquire` linux, `on: boat.dev` | ready in 41.4 s: fork 0.4, ready 5.6, ssh 21.4, settle 6.7, joining the tailnet 7.1 s, forking the template the smoke runs' install built |
| `box_run` | `uname`, `id` (box, in docker and kvm), Docker's `hello-world`, `/dev/kvm`, a tailnet address |
| `box_copy` | 4 MiB of random bytes into the box and back, SHA-256 matching both ways |
| Enrolment | a BB machine in 7.1 s, over the tailnet, shown connected in `bb machine list` |
| `box_release` | released; boat answered 404 for the sandbox |

The first `box_acquire` was refused, in plain words, as if the template
still had to be built: capacity looked only for this install's own record
of it. With one other sandbox running, that asked for 3 of the trial's 2.
The fix counts a template the install can adopt as built.

## Boat's own desktop stream

A stock `small` sandbox, a page with a block moving across it full screen
in Chrome on boat's desktop (`:0`), and boat's stream URL from
`POST /sandboxes/{id}/desktop`, opened in headless Chrome 156 on a Linux box
beside BB's server for 20 s. The URL was passed by file and never printed:
it carries the token that opens the desktop.

| | Boat's stream |
| --- | --- |
| What it is | moonlight-web's page on `<sandbox>-desktop.on.boat.dev`, Sunshine in the sandbox, H.264 over a WebSocket, decoded in the browser |
| Size and rate | 1920x1080 at 60 fps decoded; 89 frames dropped in 20 s by a headless Chrome decoding in software |
| Latency in the sandbox, as its stats say | host processing 6 to 13 ms, 8.7 ms on average; streamer round trip 1 ms |
| Control | its own: keyboard, mouse modes, touch modes, its own resolution choice |

So boat's stream is good video. bb-box does not use it: it is a page of
boat's, opened by a URL that is a secret, with its own input, so bb-box's
viewer could only frame it, and its one controller at a time (008, 015),
the agent's computer use beside a person, recordings (059) and the
clipboard would not reach through it. The template turns it off, and its
desktop runs bb-box's own stack, measured below.

## The Linux desktop

Four more things in boat's image stood in the way of bb-box's desktop, each
found in a build or a fork and handled in `setup/boat/template.sh`:

- **Rust**: boat has it in `/usr/local/rustup` and `/usr/local/cargo`, with
  `RUSTUP_HOME` and `CARGO_HOME` in `/etc/environment`, and the guest
  scripts' rustup would not install over it for the box user. It is set
  aside for desktops.
- **Cua Driver**: boat has its own, 0.23.2, behind a wrapper at
  `/usr/local/bin/cua-driver`, and puts that wrapper back in every fork, so
  bb-box's daemon and `cua-driver mcp` ran boat's driver and timed out.
  The template calls bb-box's 0.28.3 by its pinned path, puts it first on
  the PATH, and `bb-box-boat-ready` links it back after each restore.
- **A Cua daemon started during the restore does not answer**: the box
  user's systemd manager restarts while boat brings the files in, and the
  daemon it starts then times out on MCP's `initialize`, until it is
  restarted. An acquire, and the build's trial, restart it once the desktop
  is up and wait until it answers over MCP, 1 to 15 s.
- **GNOME keyring**: boat's image has it, and Chrome started in the box
  user's session asked for a new keyring's password in a dialog that took
  the keyboard. The template purges it, as bb-box's other desktops do not
  have it.

`bb-box-check-desktop` passed in a fork of the template, but for "docker
stopped after boot", which boat answers for. The smoke script then gave:

| Run | fork | ready | ssh | settle | display | computer use | Acquire | The desktop, as the relay opens it | Release |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.38 s | 7.92 s | 8.45 s | 11.96 s | 0.07 s | 0.78 s | 36.6 s | 1920x1080 in 1.3 s; Cua listed the windows | 0.28 s |
| 2 | 0.48 s | 9.21 s | 4.43 s | 2.53 s | 0.06 s | 1.96 s | 24.8 s | 1920x1080 in 2.3 s; Cua listed 4 windows | 0.36 s |

A desktop box is the `default` size, 4 cores and 8 GB, at $0.036 an hour.

### bb-box's desktop stream on boat, measured live

With [060's harness](../../scripts/measure/README.md), through a separate
BB's relay: the separate BB above, its viewer headless Chrome 156 and the
harness's proxy in the same Linux box as BB's server, BB reaching the boat
box over SSH across the internet. The box, a `linux-desktop-cpu` of the
`default` size, showed `scene.html` full screen in Chrome, its own
screenshot the reference, and the viewer took control as the panel does.
Each run waited until the box was quiet (under half a core over 5 s), as
boat's restore takes 1 to 2.5 cores for its first minute. TCP connects from
BB's server to the box's SSH address took 16 to 62 ms, mostly about 20.

| Run | Stream | Drag fps | Drag lag p50 / p95 | Torn | Scroll fps | Scroll Mbit/s | Key p50 / p95 | Text SSIM | Box cores, drag / idle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9 | VNC | 112 | 63 / 84 ms | 0 | 136 | 8.0 | 36 / 50 ms | 1.0 | 1.3 / 1.4 |
| 9 | video (Selkies) | 62 | 59 / 75 ms | 0 | 62 | 2.0 | 50 / 58 ms | 0.9998 | 1.4 / 0.4 |
| 10 | VNC | 102 | 62 / 86 ms | 0 | 120 | 7.8 | 39 / 45 ms | 1.0 | 1.1 / 0.1 |
| 10 | video (Selkies) | 62 | 57 / 79 ms | 0 | 61 | 2.1 | 53 / 209 ms | 0.9997 | 1.5 / 0.4 |

Against 060's baselines for a Linux X11 desktop on the LAN (VNC 26 / 37 ms,
video 26 / 36 ms), a boat desktop trails the pointer by 30 to 40 ms more,
about the round trip to boat's machines and back through SSH, at the same
frame rates and sharpness. Video stays the viewer's default, at a quarter
of VNC's bandwidth while scrolling.

Six earlier runs are left out: in the first, the box was still busy with
boat's restore; in the next five, a GNOME keyring dialog from boat's image
held the keyboard over the scene, which is how the keyring was found, and
the drag and keys measured the dialog, not the stream.

### The desktop on the separate BB

The same separate BB and driver as for `linux`, for `linux-desktop-cpu`:

| Run | Result |
| --- | --- |
| 1 | ready in 27.0 s (fork 0.58, ready 10.1, ssh 6.2, settle 0.2, display 0.3, computer use 8.0 s); a command in the panel's terminal; 256 KiB copied in, SHA-256 matching; stop 16.9 s, start 9.0 s to ready, the file still there; release 0.5 s |
| 2 | failed at the display after 6 minutes: boat took 77 s to `ready`, 38 s to SSH and 127 s to settle, with the box's load average at 23 on 4 cores while it restored the template, and the desktop had not started 120 s later. The box's sandbox was deleted |
| 3 | an earlier build of the backend: Cua Driver did not answer within 2 minutes of its one restart |
| 4, the bundle's build | ready in 58.9 s (fork 0.49, ready 8.1, ssh 13.3, settle 0.2, display 0.05, computer use 36.2 s, its restarts); a command in the terminal; 256 KiB copied, SHA-256 matching; stop 3.3 s, start 8.8 s, the file still there; release 0.6 s, the sandbox gone |

So the backend now waits up to 5 minutes for the desktop and allows the
kind 10 minutes to ready; it restarts Cua Driver up to 6 times until it
answers over MCP; and `bb-box-boat-ready` no longer waits for the desktop
before it says the system files are in. How long a desktop takes to start
depends most on boat's restore of the template's files: 25 to 63 s in
eight acquires on quiet machines, and over 6 minutes once on a busy one.

### The desktop in production

After phase 2 was deployed (main `ae2ad0a6`), production adopted the
templates the smoke runs had built, so nothing was rebuilt. From an agent
thread with BB's own tools, and the owner's browser on the Box panel:

| Step | Result |
| --- | --- |
| `box_acquire` linux-desktop-cpu | ready in 59.1 s: fork 0.3, ready 20.7, ssh 13.1, settle 6.7, tailnet 8.9, display 0.1, computer use 8.0; a BB machine in 29.4 s |
| Computer use | `computer_launch` failed at first: Cua Driver had answered during the acquire, but stopped answering when boat finished restoring the template, 61 s after it started. Restarted, it answered (Cua 0.28.3, 62 tools, 1920x1080); Mousepad opened and took 65 characters |
| The panel | control taken and handed back; text typed in the panel reached Mousepad |
| `box_release` | released; boat answered 404 for the sandbox |

Measured in the panel's page, a Chromium browser on a Mac on the same
network as BB's server (TCP connect 5 ms); BB's server to the box's SSH
address, 17 to 22 ms. For frame rate, a page full screen on the box drew a
new colour 59 to 60 times a second, by its own count, and the panel's
canvas was sampled on every animation frame for 10 s. For keys, a page on
the box flipped from black to white on each key, and each of 30 keys was
timed from its keydown in the panel to the first frame that changed.

| Stream | Frame rate, 3 runs | Keys p50 / p95 | Box cores busy, of 4 |
| --- | --- | --- | --- |
| video (Selkies) | 40.8, 39.9, 42.3 fps | 59 / 616 ms, the slow ones the first three after switching stream | 2.4 |
| VNC | 41.0, 34.1, 46.5 fps | 73 / 413 ms | 2.1 |

Chrome drawing the page took about a core, Selkies 0.3 and boat's lazy
file system 0.2. The page changed all of its top half every frame, which is
the hardest case for either stream; the 060 harness's drag and keys, from
BB's server, are above.

So a desktop box now waits for boat to say the sandbox is restored
(`hydrated`) before it checks Cua Driver, which restarts it, when it is
made, when it starts again and in the template's trial fork. The wait gives
up after 5 minutes and checks Cua Driver anyway.

Deployed (main `f2491d7f`), the next `linux-desktop-cpu` acquire was ready
in 125.6 s: fork 0.4, ready 9.8, ssh 11.0, settle 6.4, tailnet 8.6,
display 0.2, restore 81.8, computer use 7.2. Mousepad then opened and took
40 characters through Cua Driver, read back from its window, and Cua
Driver still answered minutes later.

## Android

Phase 3's code is tested against the fake API: android is withheld, with
its reason, until the Android SDK's licence is accepted in boat's settings
and a template lists its devices; the upkeep then builds the template, at
the largest size the plan allows (the trial's `default`); the build writes
the acceptance before the guest scripts and keeps the devices the build
made; another install's template is forked once its devices are read from
its snapshot; an Android box forks the template and shows its device, not
a desktop. The live build, the emulator's boot, the device's stream in the
panel and its input are proved once the field is on in production, as the
trial's starts allow.

### The first build in production

With the licence on in production (main `eee94661`), the upkeep built the
Android template at the `default` size. It failed 7 minutes in, at the
first device's first boot: the emulator's QEMU exited with code 1 within
2 s, saying only "QEMU main loop exits abnormally with code 1".

The same build in a fresh sandbox of our own failed the same way, on the
same CPU (AMD Ryzen 9 9950X, 4 cores) with KVM usable. bb-box's Android
scripts run by hand in a box forked from the Linux template made all three
devices: cold boots of 36 to 64 s and boots from their snapshots of 6 to
9 s. Started by hand in the failed sandbox, the emulator booted too, with
every flag `bb-box-emulator` gives it, until it was started from boat's
home directory, `/home/user`, mode 750, which the box user cannot enter:
then it failed as the build did, every time. boat runs the build's commands
over SSH as its own user, from that home, and `prepare-avds` kept it as its
working directory as it became the box user.

So the build's guest scripts and its finalize now start from `/`. In the
failed sandbox, the Android step run again from `/` made all three devices:

| Device | Cold boot | Snapshot saved in | Boot from the snapshot |
| --- | --- | --- | --- |
| Pixel 8 | 40.3 s | 8.1 s | 8.7 s |
| Pixel Fold | 54.1 s | 9.9 s | 7.0 s |
| Pixel Tablet | 67.3 s | 17.2 s | 8.5 s |

against 16.9 to 17.5 s cold and 2.1 to 3.3 s from the snapshot for the
Proxmox QEMU template's build on 8 cores (063). The Android step took
309 s, and the build's guest scripts before it 6.5 minutes.

### The second build in production

With that fix deployed (main `d5b1eb48`), production built again 6 hours
after the first failure, at 01:57 UTC. The guest scripts, the devices and
the finalize passed in 11 minutes. bb-box then stopped the template, and
boat was still saving its disk, with the SDK, the system image and three
devices' disks and snapshots on it, 10 minutes later, when the build gave
up and deleted it.

So a template's stop now waits up to an hour for boat to save its disk,
and, if boat is still saving then, says how boat's stop stands: still
saving, or failing with boat's own error, which boat retries by itself.
A box's stop keeps its 5 minutes, with the same words. The Android
template's trial fork now runs at the size its build ran at, 4 cores and
8 GB on the trial, the size an Android box will have, not the smallest.

boat counts its starts over the last 24 hours, not by the day: after the
first day's building and testing, 2 were left at 02:18 UTC.

### Each Android device's least size

The third build in production, at 08:20 UTC, made the template in 30
minutes: its guest scripts and devices in 25, boat's save of its disk in
about a minute, and its trial at 4 cores and 8 GB in 3. But an android box
was refused at the trial's largest size, 4 cores and 8 GB, as the kind's
least size was 4 cores and 10 GiB for every device.

So the least size is now each device's. Each device was measured in a fork
of production's Android template at 4 cores and 8 GB (7.75 GiB to Linux,
with a 2 GiB swap file): booted from its snapshot, then 10 minutes of 063's
load, the launcher's app list swiped up and down, with frames by shared
memory to `bb-box-h264` with OpenH264, as a box's device server does. Free
memory, swap and the emulator's resident memory were read every 10 s, and
the kernel's log for OOM kills. BB's daemon, about 260 MB in a box, was not
running, so a box has that much less.

| Device | Boot from its snapshot, first in a fork | Least available | Swap used, most | Emulator resident, most | OOM kills | Busy fps (063, 4 cores) |
| --- | --- | --- | --- | --- | --- | --- |
| Pixel 8 | 14 s | 1.57 GiB | 115 MiB, none new | 3.70 GiB | 0 | 10 to 16 (23.5) |
| Pixel Fold, open | 70 s | 0.68 GiB | 88 MiB | 5.46 GiB | 0 | 5 to 9 (12.6) |
| Pixel Tablet | 32 s | 0.62 GiB | 144 MiB | 5.48 GiB | 0 | 6 to 10 (11.2) |

The phone kept more than 1 GiB free, so its least size is 4 cores and
8 GiB. The Fold and the Tablet did not, so theirs stay 4 cores and 10 GiB,
and their refusal says why. boat offers each device only where its plan's
largest size meets the device's least size: on the trial, the Pixel 8. A
box is refused a switch to a device it is too small for.

### Android live in production

After the per-device sizes were deployed (main `e1d1630b`), from an agent
thread with BB's own tools and the owner's browser on the Box panel, with
production's Android template of 08:20:

| Step | Result |
| --- | --- |
| `box_acquire` android, 4 cores, 8 GiB, on boat.dev | ready in 146.6 s: fork 0.4, ready 10.1, ssh 22.3, settle 42.1, tailnet 70.4; a BB machine in 14.7 s. The Pixel 8 booted 107.5 s after, 25 s of it giving the device its own Android ID. boat finished restoring the sandbox 4 min 16 s after it was made |
| `box_device` | Home, Back, Recents, rotate both ways, location: 0.1 to 0.2 s. Dark appearance, text size, battery, status bar, lock: 0.3 to 0.4 s. Wake 0.6 s. Network offline 1.3 s, online 2.3 s. The device's own battery back 6.1 s. A switch to the Pixel Fold refused: "This box has no Pixel Fold. Its devices are: Pixel 8." |
| The panel | the device's stream did not connect: "The device server did not start within 10 s". See below |
| After the fix below, by hand | the stream up 80 s after reconnecting, the device's boot included; control taken and handed back |
| Typing in the panel | into the probe page's field: 'Typed in the panel on boat, a7?b8!' arrived exactly |
| `box_release` | released; boat answered 404 for the sandbox |

**Why the panel could not connect.** While boat restores a sandbox, the
box's home is boat's FUSE file system, `ascii-lazyfs`. When the restore
ends, boat retires that mount and puts the disk's own `/home/box` in its
place. The device server had started when the acquire ended, 2 minutes
before the restore did, so it listened on a socket in the retired mount;
new clients found the disk's own file at the same path, with no listener,
and were refused. Cua Driver's socket, in `~/.cache`, broke the same way
on the desktop. So a device box now waits for boat's restore too, before
the acquire ends, as a desktop does. For this box, the device server and
the emulator were restarted by hand after the restore, and the emulator's
stale lock files from before it removed.

Measured in the panel, in a Chromium browser on a Mac, as for the desktop,
on the probe page of 063 (unit 5.1):

| Measure | Result | 063 on Proxmox QEMU, through BB |
| --- | --- | --- |
| Tap to screen, 3 runs of 30, 60 and 40 taps | all seen; median 221, 158 and 147 ms; p95 1034, 1198 and 865 ms; worst 2.1 s | 67 ms median, idle, 8 cores |
| Frames in the panel while the device animates every frame | 8.8 to 14.1 fps | 41 fps busy at 8 cores, 23.5 at 4 (E17, at the encoder) |
| Box's cores busy, of 4, while animating | 3.8 | |
| Memory, after 40 minutes | 1.84 GiB available, 93 MiB swap, emulator 3.77 GiB resident, no OOM kill | |

The device is slower on boat than on Proxmox QEMU for three reasons, each
seen in the box:

- **Half the cores.** The trial's largest size is 4 cores; the Proxmox
  box had 8. 063 measured the Pixel 8 at 23.5 fps on 4 cores, against 41
  on 8.
- **boat's save each minute.** boat saves a running sandbox's disk each
  minute. With the emulator writing to its disk, each save ran `tar` and
  `ascii-capture` for 15 to 40 s at 0.6 to 1.4 cores. The slow taps, over
  400 ms, fall in those saves; between them, taps took 112 to 180 ms.
- **The restore.** In its first 4 minutes the box restores the template's
  files on demand, at a load average of 16 on 4 cores, and the device's
  first boot took 107 s against 063's 2 to 4 s from a snapshot.

So an Android box on boat's trial works, with its stream, input and
controls, but at about a third of the frame rate and twice the tap
latency of Proxmox QEMU's 8-core box. A paid plan's `large`, 8 cores and
16 GB, would match Proxmox's cores, and hold the Pixel Fold and Pixel
Tablet; boat's saves would stay.

Two things this check found for later:

- **The panel after a deploy.** Production bb-box was deployed three times
  during the check. One deploy handed the device's control back to the
  agent while the panel still showed the person holding it; another left
  the panel's input going nowhere, with its video still live, until the
  tab was reloaded. Neither said so in the panel.
- **Rebuilds the build did not need.** boat's template fingerprint covered
  whole directories of the setup scripts, so a change to Proxmox's own
  `build.sh` (main `78e74984`), which boat never runs, rebuilt every boat
  template, for about 6 of the trial's starts and an hour of compute. The
  fingerprint and the archive the build copies are now the 38 files the
  build reads: boat's `template.sh` and what it runs, followed through each
  script's references, without the Wayland desktop's branch, which boat's
  build never takes. A test follows the references again and fails when a
  script reads a file the list lacks.

### The narrower fingerprint, deployed

Deployed (main `7bd9f833`) while production was building its Linux
template for `78e74984`: the interrupted build's sandbox was deleted by
the next upkeep, as no build followed it and it was over 10 minutes old,
and no half-made template was left. The Linux and desktop templates then
built under the new fingerprint, in 8 and 11 minutes. The Android
template's build failed: `bb-box-h264`'s C sources include `encoder.h`,
which the list lacked, as following the scripts' `$src`, `$build` and
`$here` paths does not see a C include. The list now has it, and the test
follows `#include "..."` and `#import "..."` too. In a fresh sandbox from
the narrowed archive with the header added, the Android step made all
three devices in 243 s, booting from their snapshots in 4.6 to 8.9 s, and
the finalize passed.

The two templates production had adopted on the first day, built by the
separate BB's install, were left on the account after production
replaced them, as an install tidies only the templates it built. They were
deleted by hand.

### Snapshots cut short

With the header in, production's next Android build failed at 23:47 UTC
just after saving the Pixel 8's snapshot. Two builds in fresh sandboxes
passed; a third failed the same way, and said why: the Pixel 8 "did not
boot from its snapshot", the emulator finding "Device 'cache' does not
have the requested snapshot". Its RAM had been saved, its disks' snapshots
not. The emulator's launcher waits 20 s for the emulator to shut down
before it kills it, unless `ANDROID_EMULATOR_WAIT_TIME_BEFORE_KILL` says
otherwise, and saving a snapshot on that machine took longer: the builds
that passed saved in 6.6 to 14 s, the failures took 17.8 s, 21 s and about
30 s, killed part way. In the sandbox that failed, each save failed again
the same way, until the launcher was given 120 s: the save took 45 s, and
the device booted from it.

So `bb-box-emulator` gives the emulator 180 s to save, and waits that long
and 30 s more before it kills it; it and `prepare-avds.sh` also say which
line failed when one does. Run again in the same sandbox, the Android step
made all three devices, whose saves took 63, 97 and 88 s, and each booted
from its snapshot.

The device server's own emulator unit (`src/device/emulator.ts`) does not
set the launcher's wait either, so a box's stop, which saves its device,
can be cut short the same way on a busy machine. That is left for the
device server.
