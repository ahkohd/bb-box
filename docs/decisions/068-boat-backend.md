# 068: A boat.dev box is a sandbox forked from a template sandbox, held on a renewed auto-stop and deleted on release

Status: proposed, 29 October 2026. Results: [068-results](068-results.md).
Extends [055](055-cloud-boxes-run-on-cloud-hosts-first-and-a-cloud-vm-per-box-later.md):
boat.dev is a cloud VM per box (055's model A), on a provider that starts one in
about a second, so none of 055's reasons for hosts first apply to it.

## Context

boat.dev ("boat") rents persistent Ubuntu VMs, which it calls sandboxes,
through an HTTP API at `https://boat.dev/api/v1` with bearer keys that start
`boat_`. What its documentation and API said on 29 October 2026, and what a
trial account showed:

- **A sandbox** is a whole VM: Ubuntu 24.04, kernel 6.8, systemd, Docker 29,
  `/dev/kvm`, and a user `user` (uid 1000) with sudo without a password. It
  has a desktop of its own: Xorg on `:0` under LightDM with Openbox, streamed
  by Sunshine and moonlight-web, and Google Chrome and xdotool installed.
- **Sizes** are fixed: `small` 2 vCPU, 4 GB, 51 GB disk at $0.018 an hour;
  `default` 4, 8, 51 at $0.036; `large` 8, 16, 111 at $0.072; `xlarge` 16, 32,
  251 at $0.20 on the $100 plan and above. Billed by the second while running.
  The trial allows `small` and `default` only.
- **States**: `provisioning`, `provisioned` and `cloning` while it starts;
  `ready`, `idle` and `running` while it runs; `archiving` and `archived`
  while it stops and once stopped; `error`; and `cancelled` for a create that
  found no machine, which then answers 404.
- **Stop** removes the machine and keeps the disk as a snapshot for 14 days,
  free. Running processes end; enabled systemd services start again on
  resume. **Resume** and **fork** start from the newest snapshot, on a new
  machine whose address and SSH host key may change. **Delete** removes the
  sandbox and its snapshots for good.
- **A sandbox is boat's base image with its changes laid over it.** A fork
  or resume takes a machine that is already running boat's base image, and
  boat brings the sandbox's changed files in after `ready`: system files
  within seconds, then Docker and the enabled services start again, and the
  rest of the files in the background until `hydrated`.
- **Saved snapshots**, which never expire, are refused on the trial
  (`403 trial_saved_snapshots_not_allowed`).
- **Auto-stop**: a sandbox stops `ttlSeconds` after its create, resume or
  last `PATCH`, 1 hour by default. The trial refuses no auto-stop and caps it
  at 2 hours.
- **Labels**: up to 20, set at create or fork only, and listed with
  `GET /sandboxes?label=key=value`. A fork never takes its source's labels.
- **SSH**: `POST /sandboxes/{id}/sshkey` adds a public key for `user` and
  answers the address, an IPv4 `host:port` forward where the machine has only
  IPv6, and the host key to pin.
- **Limits**: the trial has 2 sandboxes at once and 5 starts a minute, 25 an
  hour and 75 a day, and 25 hours of compute, of which a `small` hour counts
  half. `503 out_of_capacity` came back for every create and fork for at
  least 10 minutes on 29 October 2026.
- **Regions**: the EU only, chosen by boat.

## Decision

1. **A box is one sandbox.** `Guest.ref` is `bbbox-` and the box's ID, known
   from the claim, before the sandbox exists; the sandbox's ID (`bx_` and 8
   letters, which boat never reuses) is `Guest.data.sandbox`. Its labels name
   the install, the box, the thread, the box's name and kind, and when it was
   made, from the fork on (018, 019), and the fork's idempotency key is the
   install's and box's IDs, so a retried acquire finds the same sandbox;
   `held()` lists the install's sandboxes by label. Labels cannot change, so
   a relabel (036) writes the thread and name into the sandbox's name. Boat's states map to
   bb-box's power so: starting and running states are `running`, `archiving`
   and `archived` are `stopped`, `error` is `unknown`, and `cancelled` or 404
   is gone.
2. **Boxes fork a template sandbox.** For each kind, bb-box builds a template
   once, in a sandbox, from the same guest scripts as Proxmox QEMU's Linux
   VMs and Tart's Linux images (`setup/proxmox-lxc/template/guest`, with
   `BOX_RUNTIME=vm` and `DESKTOP_GPU=none`), finalizes it and stops it, then
   checks a fork of it as a box starts and deletes the fork. A box is a fork
   of that stopped template. Saved snapshots would outlive a template's 14
   days, but the trial refuses them, and a template is rebuilt after 7 days
   anyway, as Namespace's Linux images are, so it never reaches 14. The
   first box of a kind waits for the build and says how long it takes.
   `setup/boat/` holds what boat's image needs around the guest scripts:
   its own apt sources set aside during the build, its Docker CE replaced by
   the guest scripts' `docker.io`, its copies of the pinned tools moved off
   the PATH, its own desktop stream turned off, and Docker enabled at boot,
   as boat restarts only enabled services after a restore.
3. **A template serves the account.** It is found by its labels: the kind
   and the fingerprint of the scripts it was built from, so a second install
   on the account, or one that lost its storage, forks it rather than
   building another, which the trial's 2 sandboxes at once would not allow.
   Each install tidies only the templates it built. As a template holds its
   builder's SSH key, an acquire replaces the box user's and root's
   `authorized_keys` with its own install's key, through boat's own `user`,
   before it uses the box.
4. **Release deletes.** A release deletes the sandbox and its snapshots. A
   stop is boat's stop: the disk stays and costs nothing, and a start
   resumes it. Neither keeps the session (`keepsSession` is false).
5. **A held box's auto-stop is a lease.** bb-box makes each box with an
   auto-stop of 30 minutes, the lease, and its upkeep, every 3 minutes, sets
   it back to 30 minutes for each running box it holds. If bb-box stops for
   good, its boxes stop within 30 minutes and cost nothing more; when it
   comes back, the sweep finds them stopped, says why, and starts or
   releases them as their threads need. bb-box never turns auto-stop off.
6. **bb-box reaches a box over SSH**, with its own key and the host key boat
   answers, pinned. It asks boat again after each resume, as the address and
   host key may change, and keeps the answer by sandbox, so a box's
   transports always use the current one. A box is ready once SSH as the box
   user answers and the template's `bb-box-boat-ready` service has run and
   Docker answers, so a box's first command never meets a half-restored
   system.
7. **Enrolment** is as on Namespace: a sandbox cannot reach a BB server on a
   private network, so with the tailnet on (050) a box joins it as it
   starts, and leaves it before it is deleted; otherwise BB's server needs a
   URL the sandbox can reach. Where BB's URL is on a private network and the
   tailnet is off, the doctor's `boat.bb` warns, and each box says it will
   not become a BB machine, with the fix.
8. **The desktop is bb-box's own**: the template runs the CPU desktop of
   Proxmox QEMU's Linux desktop VMs, with its VNC server and Selkies, reached
   through SSH, and boat's own stream is turned off in it. bb-box's viewer,
   shared control, computer use and recording then work as on every other
   Linux desktop. Boat's stream is a web page in an iframe, with no channel
   for bb-box's control, input or recording, and its URL carries a token.
   Measured in [the results](068-results.md).
9. **A box gets the smallest size that holds it**, and the doctor and the
   settings page say what each costs an hour. Sizes above what the plan
   allows are refused before boat is asked, so another backend can take the
   box.
10. **Failures say what to do**: a refused key, a plan limit, the start rate,
   boat's capacity and a region down each have their own words (see
   [Failures](#failures)).

## Times

Measured on 29 October 2026 from a Linux box beside BB's server, a `small`
sandbox; the details are in [the results](068-results.md):

| Step | Time |
| --- | --- |
| A stock sandbox: create to first SSH | 2.4 s |
| Stop to `archived` | 2.1 s |
| Resume to first SSH | 1.0 s |
| Building the `linux` template, its check in a fork included | 6 min |
| A `linux` box from the template, to ready with Docker answering | 8.8 to 24.6 s, in 5 acquires |

A box that starts in 9 to 25 s needs no warm pool, which would also take
one of the trial's 2 sandboxes. bb-box keeps none.

## Cost

A box costs its size's hourly price while it runs: $0.018 for `small`, $0.036
for `default`, $0.072 for `large`. A stopped box, and a template, cost
nothing for 14 days. The settings page says so, and that the plan's included
time is used first. The trial's 25 hours count a `small` hour as half.

## Failures

| What boat answers | What bb-box does and says |
| --- | --- |
| `401 unauthorized` | the doctor fails `boat.api`: the key is wrong, expired or revoked; make a new one in boat's dashboard |
| `402 billing_required` | refuses the box: the plan or wallet needs paying, in boat's dashboard |
| `403 trial_machine_class_not_allowed` | refuses the size before asking, from `GET /limits` |
| `429 limit_reached`, `trial_compute_limit_reached` | `no_capacity`: the plan's sandboxes at once, or its compute, is used up. Capacity counts every running sandbox on the account, and a template that must be built first as one more, so a box is refused with why before boat is asked |
| `429 rate_limited` | `no_capacity` with the window and when it opens again |
| `503 out_of_capacity`, `no_ready_machine` | tries again within the kind's ready time, then `no_capacity`, so another backend can take the box |
| no answer from `boat.dev` | the doctor fails `boat.api`: boat cannot be reached, which is boat's status page's to say |

## Consequences

- A new backend type, `boat`, in `src/backends/boat`, offering `linux`.
  `linux-desktop-cpu` is built in and offered once its template builds and
  its stream is measured live (phase 2): its first build stopped on boat's
  own Rust in `/usr/local/rustup`. `android` follows if a sandbox's KVM runs
  the emulator at speed.
- The template build uses a sandbox for about as long as the guest scripts
  take, from the plan's time.
- A box's address is not fixed, so `ssh <box>` from a thread is written
  again after a resume.
