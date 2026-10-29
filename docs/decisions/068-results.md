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
