# Docker snapshot take results

Measured on 10 November 2026 for item 2 of decision 082.

## Automated checks

The checks ran on a separate Linux box, from main at `321a8ac0` with this unit's changes.
The requested Docker, snapshot, provider-snapshot and conformance tests passed.
The site built and its link check found no broken links.

Focused tests cover take, list, delete, mount and layer refusals, identity blanking,
image-store estimates, interrupted takes, recovery bounds, late images, ownership,
provider-only listing and retrying an unpause after a completed commit.
Removing the corresponding behaviour made the estimate, layer, mount, identity,
unpause and recovery-bound tests fail. The changes were restored afterwards.

## Verified live

The successful checks used a separate BB with no account, running in a Linux VM
with 4 vCPU, 8 GiB memory and a 48 GiB disk. Its backend reached the VM's Docker
engine, Docker 29.1.3 with the containerd image store. The test box was Linux with 2 cores and 2 GiB memory. The image was built
from this repository. The test build used HTTPS Ubuntu sources because HTTP
package downloads stalled. Those build-only changes are not part of this unit.

The box held a file containing `A` and a running Alpine container with `A` in an
inner Docker volume. A take through `bb box snapshot take` completed in 4.05 seconds,
including CLI overhead. BB Box logged a pause of 2,413 ms. Its recorded operation
took 2,885 ms.

The list showed a ready disk snapshot of 14 MB. Its exact estimate was 13,959,168
bytes: 143,360 changed disk bytes counted twice on the containerd image store,
and 13,672,448 bytes of Docker data. A separate `du -sk` of the copied volume
reported 13,348 KiB, exactly 13,672,448 bytes. Read-only inspection found `A` in
both the committed image and the copied inner volume. The image's source box
label and identity variable were blank.

The image and volume used the agreed names and ownership labels. The volume had
no `bbbox.volume-of` label. Delete removed both objects. Restore, fork and Keep
refused. Fork used the core's existing identity-reset refusal for this test box.

For recovery, the box had 1 GiB of extra Docker data. The separate BB's recorded
processes were killed after Docker reported the box paused. A partial snapshot
volume existed, with no completed snapshot image. After restart, the snapshot
was not listed as ready. BB Box automatically unpaused the box about 193 seconds
after the take began, including the recovery bound and sweep interval. The partial
volume disappeared. Both the box file and the inner container data still read `A`.

Release removed the released box's snapshot image and volume. Another box's
snapshot image and volume remained. An image and volume labelled for a different
install also remained.

## Limits and follow-ups

- Records rebuilt from the engine alone have no displayed size, as on the other
  backends today. The byte counts remain in image labels for a later core change.
- The core does not announce a take's pause beforehand or include its measured
  pause in the result. The offer says it pauses; the log records milliseconds.
- Docker inside an LXC host refused `/proc/cpuinfo` before pausing. BB Box's LXCFS
  bind mounts currently have Docker's writable flag. They need a separate change
  before such boxes can take snapshots. This unit keeps the writable-mount refusal.
- Fork and Keep remain later units. Restore is below.

Cancelling a Docker commit client after the commit reaches the engine was not
measured here. The failed-task record rejects a late image after interruption.

Delete reports the stored snapshot estimate through the existing core interface.
When a manually made container still uses the image, Docker retains its layers.
Docker's size is marked as an estimate, so a delete says it freed up to about
that much, less what a fork or another image still uses.

## Restore, verified live

A fresh BB 0.49.0, with no account, ran in a separate Linux VM: Proxmox QEMU,
8 vCPU, 16 GiB of memory and a 100 GiB disk, Ubuntu 24.04.5, kernel
6.8.0-149, Docker 29.1.3 with the containerd image store. BB Box was installed
from the branch, and Docker set up with `bb box setup docker`. Each box was a
machine of 2 cores and 2 GiB. Each run wrote `A` to a file in the box user's
home and into an inner container's volume and writable layer, took snapshot
`A`, changed all three to `B`, and restored `A`. It then restored the undo,
deleted every snapshot and released the box.

| Run | Take | Restore | Undo restored | What came back |
| --- | --- | --- | --- | --- |
| No LXCFS | 7.5 s, paused 5.5 s | 6.8 s | 5.9 s | `A` three times; the inner container restarted and ran; `B` after the undo |
| No LXCFS, BB killed after the undo's commit | 4.6 s | finished by the sweep after BB restarted, about 3 minutes later | 9.7 s | as above |
| No LXCFS, BB killed once the new container started, the old one still there | 4.3 s | finished by the sweep 181 s after BB restarted | 9.1 s | as above |
| LXCFS 5.0.4 | 5.5 s | 6.0 s | 3.7 s | as above; the new container had all 8 LXCFS mounts and saw 2048 MiB and 2 CPUs |
| LXCFS 5.0.4, BB killed after the undo's commit | 5.7 s | finished by the sweep 183 s after BB restarted | 9.0 s | as above |

In every run the box kept its ID, name, thread and kind labels, and
`BBBOX_IDENTITY` was its own ID. The new container was named
`bbbox-<box>-<8 hex>` and carried `bbbox.from-snapshot`. After each restore,
and after each recovery, Docker listed one container for the box. After the
deletes and the release, Docker listed no BB Box containers, volumes or
snapshot images.

A restore's steps, from Docker's events in one run: the undo's copy of the
Docker data and its commit took 3.9 s after `docker kill`; making the new
volume and copying the snapshot's Docker data into it, 0.3 s; the new
container's create, under 0.1 s; its start, 0.15 s. The old container was
removed 0.26 s after the start, once the new one was ready. The rest of the
restore's time, about a second, was BB Box's flush, plan and checks before
the kill.

After a kill, BB's first recovery could not reach Docker: this BB reaches its
own engine through its BB machine, which was offline until it reconnected. The
sweep 3 minutes later finished each restore. The old container stayed stopped
until then: Docker does not restart a container stopped by `docker kill`, even
with `unless-stopped`, and even after dockerd restarts (checked separately).

The box's page was open in the separate BB's panel, in Chromium with
Playwright, through every run. It recorded each Read at time the Activity card
showed. Across 39 readings in five runs, including both kinds of kill, the card
never showed a reading older than the one before it (issue 1428).

## Fork, verified live

Measured on 10 November 2026 on a Proxmox QEMU VM with 8 vCPU, 16 GiB of
memory and a 100 GiB disk: Ubuntu 24.04.5, kernel 6.8.0-149, Docker 29.1.3
with the containerd image store. A separate BB ran there, a fresh
`npx bb-app@0.49.0` with no account, its ports dropped from outside the VM,
with BB Box installed from the branch and markers on for its Docker backend
(`general.identityResetBackends`). Each source was one of the person's
machines, `linux` with 2 cores and 2 GiB, or `linux-desktop-cpu` with 2 cores
and 4 GiB, from images with identity reset version 9. The older versions were
made by changing the version the box's reset reports before the take, and the
failed resets by changing what its `boot` does.

| Run | What happened |
| --- | --- |
| Fork of `A` | Ready 2.3 s after the request: its start 0.6 s, BB Box's check 0.13 s, then it joined BB in 2.0 s more |
| A snapshot taken under reset version 6 | Refused before anything was made: "src-n had version 6 of the identity reset when "v6" was taken, and BB Box forks Docker on build-1's boxes only from version 7". Docker made no container and no volume |
| A reset that fails at its first start | The fork stopped as it started, saying "the identity reset failed, so the box starts nothing and never says it is ready". BB Box released it, and Docker deleted its container and Docker data |
| A reset that does not run at all | BB Box's check refused it: "its boot's identity check says "none", not that it reset". It was released. Its restart policy was `no` at its start and never became `unless-stopped` |
| Fork of a Linux desktop on the CPU, from a snapshot taken under reset version 9 | Ready 1.5 s after the request: its start 0.6 s, BB Box's check 66 ms. Its reset ran, it held the source's file, and its identity value was its own box ID |
| A Linux desktop snapshot taken under reset version 8 | Refused before anything was made: "BB Box forks Docker on build-1's boxes only from version 9". Docker made no container and no volume |
| BB's server killed with `kill -9` at the fork's `start` event | The half-made fork ran with restart policy `no`, its own reset done. When BB started again its BB machine had not reconnected, so the fork failed and said it was released; the sweep 3 minutes later deleted its container and Docker data. The source was untouched |

The source wrote `A` to `~/work.txt` and, in a running inner container, to its
volume and its writable layer. The fork had `A` in all three. It was named
`bbbox-<fork>-<8 hex>`, with its own box ID, name and labels,
`bbbox.from-snapshot`, and `BBBOX_IDENTITY` its own box ID. Docker's events
for it, from the volume's create: its container's create at 883 ms, after the
copy of the Docker data, its start at 1,258 ms, BB Box's check at 1,568 ms, and
the change of its restart policy to `unless-stopped` at 1,825 ms.

What the fork's identity read, against its source:

| Item | Source | Fork |
| --- | --- | --- |
| Marker | its own box ID and value | before hand-over its own value and no box; after it, its own box ID and value |
| Boot | `unarmed` | `reset`: "the value bb-box set on this guest is not the marker's; BB machines removed: host_<id>", naming the source's BB machine |
| BB's machine credentials and the access file | the source's | the source's gone; new ones from its own enrolment, as a BB machine of its own |
| Machine ID | its own | a new one |
| SSH host keys | none: a Docker box runs no SSH server | new ones its reset made |
| Tailnet node | none: this BB has no tailnet | none |

A write of `B` in the fork, in all three places, left the source with `A`.
The source kept its container, marker, BB machine and credentials through
every run, and its inner Docker still ran containers. A Docker box's start
script never starts BB's daemon: BB Box starts it with BB's bootstrap once the
box is handed over, so no refused copy ran as its source's BB machine. After
the releases, Docker listed no BB Box containers, volumes or snapshot images.

## A fork held until its check

Measured on 10 November 2026 on a Proxmox QEMU VM with 8 vCPU, 16 GiB of
memory and a 100 GiB disk: Docker 29.1.3 with the containerd image store,
and the Linux image built from this change, labelled `bbbox.fork-hold="1"`
and holding `/usr/local/libexec/bb-box/fork-hold`. A separate BB ran there,
a fresh `npx bb-app@0.49.0` with no account, its ports dropped from outside
the VM, with BB Box installed from the branch and markers on for its Docker
backend. A `docker` wrapper first on BB's PATH logged each call and, while a
gate file was there, held BB Box's check of a fork before it ran, so the
fork could be read as BB Box's check would find it.

The source was one of the person's machines, `linux` with 2 cores and 2 GiB.
It wrote `A` to `~/work.txt`, and in its Docker to an inner container's
writable layer and named volume. A second inner container, with restart
policy `always`, ran the box's own `sshd` on port 2222 through `chroot`, as
the review that found the gap did, with the box's SSH host keys made by
`ssh-keygen -A`. The source also held a stand-in Tailscale state file. Two
snapshots were taken: one as it was, and one with `bb-box-identity boot`
changed to exit 0 without resetting.

| Run | What happened |
| --- | --- |
| Fork of the faulted snapshot, held at BB Box's check | The fork still held the source's marker, machine ID, SSH host keys, BB machine credentials, access file and Tailscale state, as its reset had not run. It ran `docker-init`, `bb-box-start`, `fork-hold` and `sleep` alone. No TCP port from 1 to 65535 answered on its address, `ssh-keyscan` on port 2222 had no answer, there was no Docker socket, and no inner container ran. When the gate opened, the check refused it: "its boot's identity check says "none", not that it reset". BB Box set its policy to `no`, killed it and deleted its container and Docker data. It never wrote the release |
| Fork of the snapshot as it was, held at BB Box's check | Its own identity value, a marker with its own value and no box, a new machine ID and new SSH host keys, no BB credentials, access file or Tailscale state of the source's. It ran the same four processes, no port answered and no inner container ran. When the gate opened, the check passed. BB Box changed the policy to `unless-stopped` 67 ms after the gate opened, and wrote the release 22 ms after that. Its inner containers started 560 ms after the release. Port 2222 then served the fork's own new ED25519 key, not the source's. Its start took 668 ms and the check 703 ms, the gate's wait included |
| BB's server killed with `kill -9` while a fork was held at its check | BB's own supervisor started the server again at once, before the VM's BB machine had reconnected, so the fork failed and BB Box could not yet delete it. The fork stayed held for 3 minutes, its four processes and no port, through a `docker restart` too. The next sweep set its policy to `no`, killed it and deleted it and its Docker data. It never wrote the release |
| An ordinary stop and start of the source | Not held: its inner containers started 520 ms after `docker start` |
| A restore of the source to the snapshot as it was | Not held: the new container had `BBBOX_FORK_HOLD` blank, from the snapshot's image, and restart policy `unless-stopped`. Its inner containers started 470 ms after `docker start`, with `A` back |

The fork joined BB as a BB machine of its own, with credentials of its own.
A write of `B` in the fork, in all three places, left the source with `A`,
and with its own marker, machine ID, SSH host keys and BB credentials.

The fork's first enrolment, and the source's reconnection after its
restore, could not reach BB at the VM's `docker0` address: each box's own
Docker had taken the same range, `172.16.0.0/24`, from the VM's Docker
address pools, so the address was the box's own. With BB's machine URL set
to the box network's gateway, the fork joined BB. This comes from the VM's
address pools, not from the hold. After the releases, Docker listed no
containers, volumes or snapshot images of the test install.

## Keep, verified live

Measured on 11 November 2026 on a Proxmox QEMU VM with 4 vCPU, 8 GiB of
memory and an 80 GiB disk: Ubuntu 24.04.5, Docker 29.1.3 with the containerd
image store. A separate BB ran there, a fresh `bb-app@0.49.0` with no
account, as a user of its own, its ports dropped on the VM's outside
interface, with BB Box installed from the branch, the Linux image built by
`bb box setup docker` (5 min), and markers on for its Docker backend. Each
source was one of the person's machines, `linux` with 2 cores and 2 GiB.

| Step | What happened |
| --- | --- |
| Take two snapshots, `before` and `plain` | Each paused the box for 3.1 to 3.5 s; 259 MB each |
| `bb box snapshot keep ... --check`, then keep | "If src-b is released, it stays where it is until Fri 11 Dec; nothing is copied then, and from then on it takes its whole size, up to 259 MB on (the host)'s Docker's disk". The engine then had the tag `bbbox-kept/<install>/<snapshot>:2026-12-11` on the snapshot's image |
| Keep `--until 2026-12-31`, unkeep, keep again | The tag moved to `:2026-12-31`, was removed, then came back as `:2026-12-11`; one keep tag at a time |
| Remove the machine | Its container went, and `plain`'s image and volume with it. `before`'s image, volume and keep tag stayed. `bb box snapshot list --all` listed it, kept until 2026-12-11, its box released. The doctor said "1 kept snapshot holds about 259 MB on Docker's disk" |
| Fork from the kept snapshot, alone on the engine | Refused by BB Box's check and released: Docker gave the fork the address its source had, as the lowest free one. See below |
| Fork again, with another machine running | Ready 0.9 s after the request. It held `A` in its file and in an inner Docker volume, written before the take, not the `B` written after. Its reset ran ("BB machines removed: host_<source>"), its identity value was its own box ID, and it joined BB as a machine of its own |
| Stop BB, move `snapshots.db` away, start BB, sweep | `bb box snapshot list --all` showed nothing before the sweep and, after it, the kept snapshot with its date, 2026-12-11, under its box's name, `src-b` |
| Keep the released box's snapshot until 2026-12-20 | The tag moved to `:2026-12-20`. Unkeep on a released box was refused: "only its keep holds it. Delete it instead, or keep it longer" |
| Remove the Docker backend | Refused, for the box record and the snapshot BB Box records, and for the snapshot on the engine: "has 1 snapshot on its host, kept or not, which would stay and take its disk after it is removed". After `bb box snapshot forget`, still refused from the engine's own list |
| Keep until 2026-11-12; BB's clock at now, then at +1 day (2026-11-12) with `faketime` | Kept, with its image, tag and volume, after a sweep at each |
| BB's clock at +2 days (2026-11-13) | The sweep deleted it: no snapshot listed, and no snapshot image, keep tag or volume on the engine |

A fork after the release, alone on the engine, is refused. Docker's address
manager gives a new container the lowest free address on the network, so
after its source's release the fork gets the source's old address. The
core's check refuses a fork that holds its source's last address unless a
DHCP lease shows it asked for it as itself, and Docker has no DHCP. A
network made with `com.docker.network.ipam.serial=true` gave the same
address again. The refusal is safe, and nothing of the fork acts as its
source, but the fork does not happen. A fix needs a choice: Docker holding
the source's last address while a fork starts, or a core rule for addresses
an engine assigns, which never gives one address to two running guests.
[Decision 088](088-a-fork-may-hold-its-gone-sources-address-when-its-provider-gave-it.md)
takes the second; see below.

## Keep's fix round, verified live

Measured on 11 November 2026 on a Proxmox QEMU VM with 8 vCPU, 16 GiB of
memory and an 80 GiB disk: Ubuntu 24.04, Docker 29.1.3 with the containerd
image store. A separate BB ran there, a fresh `bb-app@0.49.0` with no
account, as a user of its own, bound to 127.0.0.1, with BB Box installed from
the branch, the Linux image built by `setup/docker/build.sh linux`, and
markers on for its Docker backend. Each source was one of the person's
machines, `linux` with 2 cores and 2 GiB. No other container ran on the
engine.

| Step | What happened |
| --- | --- |
| Take `before`, keep `--check` | "It takes about 8 MB of (the host)'s Docker's disk that nothing else there shares, and up to 3.0 GB if what it shares is deleted." Its own layer was 139 kB unpacked, its Docker data 7.2 MB, and `docker system df --verbose` gave the image 2.99 GB in all. Before this round the dialog said "up to 8 MB", and Docker's own unique size for it was 795.6 MB, its packed base layers, which the box's image shares |
| Remove the machine, then fork from the kept snapshot | The engine had no container. Docker gave the fork 172.16.1.2, its source's address. BB Box handed it over 1.1 s after the request: it held `A` in its file and in an inner Docker volume, and its reset ran, its identity value its own box ID |
| Tag the kept image with two more keep dates, 2026-11-25 and 2026-12-20, then sweep | One keep tag stayed, `:2026-12-20`, and the snapshot was listed as kept until 2026-12-20 |
| The backend's host set to `ssh://` the same machine; a new machine, take, keep, remove, fork | Over SSH the fork got its source's address too and was handed over in 6.5 s, with the file from before the take and its reset run |
| Doctor; remove `bbbox/linux:1`, as a refresh does; delete the first kept snapshot; doctor | With two kept snapshots, about 8 MB that nothing else shares, as the two still shared the base layers. With one left, "It takes about 2.9 GB of Docker's disk that nothing else there shares, and up to 3.0 GB", against Docker's own unique size of 2.898 GB for the image, which shared only the Ubuntu layer, plus 7 MB of Docker data |
| Delete the kept snapshot | Its image, keep tag and volume went |

The fake Docker host now gives a starting container the lowest free address,
as Docker does, and a test runs where the BB server's hostname is the
engine's, so BB Box records the address. Its fork test failed before 088 and
passes with it. Keep tag changes cut short between the new tag and the old
one's removal, a renewal and a shortening, each with BB Box's recovery and
Docker's maintenance in both orders, leave one tag, the date asked for; with
`snapshots.db` and the backend's own storage both lost, the later date.

## The conformance suite, live on Docker

Measured on 11 November 2026. The shared conformance suite ran against real
Docker engines with `npm run conformance -- --backend docker --kind linux`,
from this repository, without BB. It needs no BB server: it calls the
backend directly, as an install of its own called `conformance`.

Two Proxmox QEMU VMs, each with 8 vCPU, 16 GiB of memory and a 100 GiB
disk, ran Ubuntu 24.04.5 and Docker 29.1.3. Each had `bbbox/linux:1` built
by `setup/docker/build.sh linux`. One VM ran the suite against its own
engine, through the local socket. It also ran the suite against the other
VM's engine, through `ssh://`. Each engine ran on the containerd image
store, Docker 29's default, and on overlay2, with
`"features": { "containerd-snapshotter": false }`.

The suite gained three checks for this run, each driven by the kind's
snapshot offer, not by Docker's name:

- a fork of a snapshot into a new box, which must pass the core's own fork
  check (`forkVerdict`): its identity reset ran, its identity value is its
  own box ID, its machine ID and host keys are new, and the source box
  still answers as itself;
- a take run in a second process, which the suite kills with SIGKILL 2 s
  after the take names its task, with 1 GiB just written in the box so the
  take is still running; a new instance on that process's storage then
  settles the take;
- a restore run in a second process, with 1 GiB just written into the
  box's Docker data, which the suite kills 1 s after the restore names its
  new guest; a new instance on that process's storage then releases the
  part-made guest and starts the box, which must hold what it held before.

### Results

Every snapshot check passed on each engine and image store. The killed
restore on the local containerd engine, open after the first round, passed
in five runs in a row once its copy was fenced (below). Each case and its
time, from the last run of each, on the final code:

| Check | Local, containerd | SSH, containerd | Local, overlay2 | SSH, overlay2 |
| --- | --- | --- | --- | --- |
| Take, list, restore as a new guest, put back, delete | 4.8 s | 23.9 s | 6.7 s | 25.5 s |
| Keep dates, read by a new instance on empty storage | 2.6 s | 15.0 s | 5.2 s | 14.9 s |
| Fork with the identity reset check | 4.2 s | 28.7 s | 7.5 s | 26.2 s |
| Take killed part way, settled by a new instance | 166.0 s, failed and cleaned | 173.4 s, failed and cleaned | 9.4 s, complete | 159.5 s, failed and cleaned |
| Restore killed part way, recovered by a new instance | 11.1 s | 21.7 s | 11.4 s | 25.3 s |
| A kept snapshot outlives the box's release | 0.3 s | 3.5 s | 0.4 s | 3.4 s |
| Whole run of Linux boxes | 205 s | 349 s | 65 s | 346 s |

The five local containerd runs took 227, 282, 228, 217 and 205 s in all,
and their killed restores 10.6, 18.1, 12.6, 18.4 and 11.1 s. The overlay2
runs ran beside the Docker tests on the same VM, so they were slower than
in the first round.

When a take was still copying as it was killed, it settled as failed: the
box was unpaused and its partial copy removed, once the take's time bound
had passed, about 2.7 minutes for a 1 GiB change. On the local overlay2
engine the commit of 1 GiB took under 2 s on the engine, which finished
it after its client was killed, so the take settled as a complete snapshot
and the suite deleted it. In three of the five final local containerd
runs, the restore was killed after Docker had made its copy's container,
and in one of them the copy was running; in the other two, before the
copy was asked for.

After each run, Docker listed no BB Box containers, volumes or snapshot
images on either engine. The rest of the suite passed too: acquire,
commands, copies, Docker in the box, stop and start, sizes and live
resize, interrupted acquires, image builds and two installs. Enrolment and
reconnection to BB were skipped, as the suite ran without a BB server.

The overlay2 engines ran the `bbbox/linux:1` image each had built on the
containerd store, saved with `docker save` and loaded with `docker load`
after the switch, as a rebuild's package downloads ran at about 75 KB/s.

### What the run found

On overlay2, the first local run failed the killed restore. The killed
process's copy of the snapshot's Docker data, a `docker run --rm` on the
engine, kept running after its client was killed. The new instance's
release then failed with "volume is in use", as the copy still held the
new guest's Docker volume. The guest could not be released until the copy
ended. The SSH engine and the containerd runs passed, because their copies
had ended by then.

The copy now runs as a container named after the volume it fills, with
`-copy` on the end, and labelled with the install, that volume, the
container it is for and its own operation ID. Before it removes a box's
Docker volume, at a release or at maintenance, BB Box removes that
install's copies into it. `test/docker-restore.test.ts` releases a
restored container while the fake Docker host holds its copy. It failed
with the same "volume is in use" before the change, and passes with it.
The fake Docker host now shows a running copy as a container that holds
its volumes, as Docker does.

The doctor's snapshot leftovers check warned without saying what to do,
which the suite requires of every warning. It now says to wait for
maintenance and what maintenance does. `test/docker-snapshots.test.ts`
failed on the missing fix before the change.

### A copy Docker made after its restore was killed

The first round left one case open. On the local containerd engine the
killed restore failed twice with "volume is in use" for the new guest's
Docker volume. The suite kills the restore's process group, its `docker`
clients with it, but Docker finishes a request it has already received.
On the containerd store, making the copy's container from the snapshot's
image can take a moment, so the container appeared after the new
instance's release had begun: after it looked for a copy, and in one run
after it had removed the volume. A container made then makes its volumes
again, as Docker makes any named volume a container needs, without
labels, and that one stayed in Docker's Created state.

A copy is now fenced by its operation:

- BB Box writes a note of the copy, with its own operation ID and a time
  by which Docker must have made it, 2 minutes from the request, before it
  asks Docker for anything.
- It makes the copy's container with `docker container create`, then runs
  it with `docker container start --attach`. The container either exists
  or does not, and Docker starts it only when BB Box asks, once the
  create has returned.
- It removes the container and the note once the copy ends, whether it
  copied or failed. Docker does not remove a copy by itself, so once
  Docker has made one, it is there for a release to find. A request whose
  client was killed or timed out leaves the note.
- A release reads its own storage first. With no note, it removes the
  volume as before, and looks for a copy only if Docker says the volume is
  in use. With a note, it removes every copy into the box's Docker volume,
  by its labels, and waits for Docker to remove it. It then removes the volume,
  and tries again, up to 5 times a second apart, while the volume is in
  use. While the note says Docker may still make that copy, it looks again
  every 250 ms. When the copy appears, it removes it and the volume it
  made again. A volume with no labels is removed only when such a note or
  copy names it.
- Maintenance removes any copy whose restore this BB Box is not running,
  writing a note of it first if there is none. It drops a note only once
  the volume the copy made again has gone, so a failed removal is tried
  again each run, and the doctor names the volume after 3 failed tries.
  It does not wait for a copy. See
  [096](096-a-docker-volume-a-restores-copy-made-again-is-removed-by-its-note.md).

Two tests in `test/docker-restore.test.ts` run a restore in a second
process against the fake Docker host and kill its process group while the
fake engine is still making the copy's container. The engine makes it,
and the volume again, only once the new instance's release has removed
the volume, as in the failed runs. One releases the guest with the
restore's own storage, the other without it and then runs maintenance.
Both failed before the change, with the copy left, and pass with it.

In one local containerd run, Docker's events show the race that failed
before, and the release clearing it:

| Time (s) | Event |
| --- | --- |
| 0.000 | The killed restore's process made the new guest's Docker volume |
| 0.219 | The new instance's release removed the volume |
| 0.273 | Docker, finishing the killed process's request, made the volume again |
| 0.339 | Docker made the copy's container |
| 0.550 | The release removed the copy's container |
| 0.579 | The release removed the volume it made again |

The suite then killed a restore 1 s after it named its new guest, which in
some runs fell before the copy was asked for. To cover the whole window, a
script killed a restore of a box with 1 GiB of Docker data at set delays
after its new volume appeared, then released the guest with a new
instance on the restore's storage. On the local containerd engine, with
the final code:

| Kill after the volume appeared | The copy when killed | Release | Left after the release |
| --- | --- | --- | --- |
| 5 ms | not made yet | 0.9 s | nothing |
| 105 ms | created, not started | 0.7 s | nothing |
| 104 ms | created, not started | 0.8 s | nothing |
| 105 ms | created, not started | 0.8 s | nothing |
| 204 ms | created, not started | 0.9 s | nothing |
| 405 ms | running | 0.9 s | nothing |
| 807 ms | running | 1.4 s | nothing |
| 1,051 ms | the restore had finished | 0.6 s | nothing |

"Nothing" means no copy container, no volume of the guest and no note
left. On overlay2 the same delays left nothing either, each release taking
1.5 to 2.5 s.

The first version of the fix made the copy with `--rm`. The sweep on
overlay2 then found one more case: a restore killed 106 ms after its
volume appeared, whose copy Docker started, finished and removed by
itself before the release looked. The release could not tell that copy
from one not made yet, so it waited out the note's 2 minutes, 120.8 s,
before it went on, though it left nothing. The copy is now made without
`--rm`, so a copy Docker has made stays until BB Box removes it. A third
test in `test/docker-restore.test.ts` kills a restore while its copy
runs, lets the fake engine finish the copy, and releases with a clock
that never passes the note's time. It timed out with `--rm` and passes
without it.

### A release with no note, and a volume that will not go

An independent review found three more faults:

- every release, not only one after a killed restore, asked Docker for
  copies into the box's volume and read the volume's labels twice: 9
  Docker calls for an acquire and release on the fake engine, against 7
  before
- maintenance removed a copy, then dropped its note, before it removed
  the volume the copy made again. If that removal failed, nothing named
  the volume again
- the suite's killed restore could pass without its copy running when it
  was killed, and did not check what the copy left

[096](096-a-docker-volume-a-restores-copy-made-again-is-removed-by-its-note.md)
records the fixes. Three tests in `test/docker-restore.test.ts` failed
before them and pass after:

- a release of a box with no note makes one volume list, one inspect and
  one removal for the box's volume, and no call about copies. Before, it
  made 2 inspects
- a late copy's volume whose first removal fails is removed by the next
  sweep. Before, it was still there after the second
- after 3 failed sweeps the doctor's Snapshot leftovers check warns and
  names the volume. Before, it said ok

The test that releases a restored container while its copy runs, with a
new storage, needed the copy removed once Docker said the volume was in
use, as there is no note. It failed until that step was added.

The suite now kills the restore once Docker lists its copy as running,
and tries again, up to 3 times, if the restore finishes first. After the
release it checks that no copy container, volume or note of the restore is
left. With a release changed to drop its note without removing the
volume, the check failed and named the volume; the unchanged code passed
it.

The suite's Linux runs on one VM with 8 cores, 16 GiB of memory and
Ubuntu 24.04, Docker 29.1.3, over SSH to the same VM for the SSH runs:

| Run | Passed, failed, skipped | Killed restore | Killed while copying, at try | Whole run | Left on the engine |
| --- | --- | --- | --- | --- | --- |
| containerd, local, 1 | 32, 0, 5 | 10.5 s | 1 | 214.6 s | nothing |
| containerd, local, 2 | 32, 0, 5 | 14.7 s | 1 | 213.2 s | nothing |
| containerd, SSH | 32, 0, 5 | 26.6 s | 1 | 348.0 s | nothing |
| overlay2, local | 32, 0, 5 | 9.4 s | 1 | 43.3 s | nothing |
| overlay2, SSH | 32, 0, 5 | 29.8 s | 1 | 181.9 s | nothing |

"Nothing" means no container, volume or snapshot image after the run.
snapshot.ubuntu.com answered 503 while the image was built, so it was
built from Ubuntu's current archive instead of the pinned snapshot.

### Running it again

The settings and commands are in
[the development guide](../development.md#the-conformance-suite). The kill
checks run only with `npm run conformance`, which makes the second
process; `npm test` skips them and says why. The fork check is skipped on
the fakes, which run commands on the test machine.
