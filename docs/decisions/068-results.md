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
