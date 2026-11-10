# 082: A Docker snapshot is a paused commit of the box and a copy of its Docker volume, kept on its engine

Status: accepted, 10 November 2026. Supersedes the anonymous volume in
[031](031-docker-boxes-are-reached-through-docker-exec.md) for a box made
after this record. A box made before keeps that volume. Refines the Docker
pause in [070](070-snapshots.md). The core stays free of provider names
([001](001-provider-agnostic-core.md)).

## Context

Docker is the quick-start backend, and its boxes take no snapshots. The
snapshots guide already fixes restores that make a new guest, forks that
check an identity reset, and Keep. The core runs all of these against
optional backend methods, so Docker can fill them in without a change to
the core.

Four facts make the shape less obvious.

- Docker gives no crash-consistent copy of a running container. A
  consistent copy means freezing the container, and the freeze lasts as
  long as the copy.
- A box's Docker data sits on a volume. `docker commit` leaves volumes out.
- `docker commit` copies the container's identity, labels and GPU variables
  into the image. Without blanking them, a copy would come up as its source.
- Hetzner and Namespace reuse the Docker backend on each host, and those
  hosts end on their own schedules.

The constraints that stay are the ones already decided. The identity source
is a value ([070](070-snapshots.md)). A Docker box has no disk of its own
([028](028-a-box-size-is-chosen-when-it-is-made.md)). Every Linux box has Docker
([041](041-every-linux-box-has-docker.md)).

Two designs were written from main at `7c629c26`. The lead took one as the
base and grafted one refusal from the other. Those rulings are below.

## Decision

A Docker snapshot is a committed image of the box's container, plus a copy
of the box's Docker volume. Both stay on the box's own Docker engine. They
are named and labelled so they can be found from that engine alone. The
commit runs last. An image whose labelled volume is present is a complete
snapshot. Nothing else marks completion.

A snapshot holds the disk and the box's Docker data. It does not hold
running programs or memory. `/run` and `/dev/shm` are empty at the next
start, as they are at any start.

### What lives on the engine

| Object | Name | Labels |
| --- | --- | --- |
| Snapshot image | `bbbox-snapshot/<install>/<box>:<snapshot>` | `bbbox.snapshot`, the install, the box, the kind, the reset version, when it was taken, the size, the volume name, and the sizes. The box's own `bbbox.*` labels and `BBBOX_IDENTITY` are blank |
| Snapshot volume | `bbbox-snapshot-<snapshot>-docker` | `bbbox.snapshot`, the install and the box |
| Keep date | tag `bbbox-kept/<install>/<snapshot>:<yyyy-mm-dd>` | one tag, moved when the date changes |
| The box's Docker data | `<container>-docker` | `bbbox.volume-of` is the container's name, and `bbbox.install` is the install |

A restored or forked container is named `bbbox-<box>-<8 hex>` and carries
`bbbox.from-snapshot`. Its volume is `bbbox-<box>-<8 hex>-docker`, the same
rule: the volume name is the container name with `-docker` on the end.

The questions a later sweep has to answer come from that structure.

- A snapshot is complete when its image exists and the volume that image
  names exists.
- It is incomplete when a volume exists with no image, or an image names a
  volume that is gone. An incomplete snapshot is deleted, and never treated
  as found.
- The keep date is the tag. A lost record of snapshots loses no keep date,
  because the tag is on the engine.
- Deleting a snapshot frees its volume at once. Its image layer is freed
  when no container carries `bbbox.from-snapshot` for it and no other
  snapshot image is built on its layers.
- A release removes only volumes labelled `bbbox.volume-of` that container,
  for this install. A snapshot volume is never labelled that way, so a
  release cannot delete one.

### The lead's rulings

1. The snapshot is the image plus the volume, on the box's own engine. A
   separate manifest volume was rejected. It would be a second record that
   has to stay in step with the first.
2. Before a take pauses a box, it refuses a writable mount BB Box cannot
   capture with the box. That is anything other than the box's own Docker
   volume and the mounts Docker makes itself. The refusal names the mount
   and says how to fix it, for example that shared storage at `/work` has
   to be moved into the box first.
3. A fork needs identity reset version 7 for a Linux server and version 9
   for a Linux desktop, the same versions microsandbox uses. Docker shares
   those images.
4. Memory is out. CRIU is not in Ubuntu 24.04. CRIU 4.3 could not dump a
   box with Docker inside, because `dockerd` holds MPTCP sockets. A plain
   container's checkpoint also failed to restore on the containerd image
   store, which is Docker's default for a new install. Snapshots say they
   hold the disk and the Docker data, and that they do not hold running
   programs or memory.
5. Keep follows the core's existing Keep rules. The provider's record of
   the keep date is the movable tag above.
6. Hetzner and Namespace come after Docker, in three stages. First,
   snapshots of live boxes, kept on their host or instance, with Keep off
   and the reason said. Then one way to carry a snapshot to another engine.
   Then kept snapshots off the host. A rented host is never kept alive
   silently to hold a snapshot.
7. The freeze was measured at 3.5 to 4.9 s on small boxes on overlay2, and
   up to about 45 s for a 1.8 GB change on the containerd store. A take
   says how long it will pause before it starts. A two-pass volume copy,
   which would shorten the freeze, is a follow-up. It is not in the first
   changes.

### This change

This record's first change is the volume a box keeps its Docker data on.
Taking, listing, restoring, forking and keeping a snapshot come later, in
the sequence below. They are not built with this record.

Every privileged Docker box BB Box makes from now on gets a volume named
`<container>-docker`. The labels are `bbbox.volume-of` set to the
container's name, and `bbbox.install` set to the install. The volume is
created before the container, so Docker does not invent an unlabelled
volume of that name. It is mounted at `/var/lib/docker`.

One function builds the `docker container create` arguments. Acquire uses
it. A later restore and a later fork use the same function. The function
takes the box, the install, the container name, the image, the volume name
or none, the placement, LXCFS, whether the container is privileged, the
network, the restart policy, and the snapshot id or none. It sets
`BBBOX_IDENTITY` to the box id of the box that will run. It does not take a
separate identity. When a snapshot id is set, it adds `bbbox.from-snapshot`.
Acquire passes none.

The environment variables that function sets are one list:
`BBBOX_IDENTITY`, `BBBOX_DOCKERD`, `NVIDIA_DRIVER_CAPABILITIES`,
`CUDA_VISIBLE_DEVICES`, `NVIDIA_VISIBLE_DEVICES`, `BBBOX_GPU_CARD`,
`BBBOX_GPU`, `BBBOX_GPU_ID` and `OMP_NUM_THREADS`. A later commit blanks
that same list, so a new variable a box is given is blanked in a snapshot
image without a second edit.

A release still runs `docker rm --force --volumes`, which removes an older
box's anonymous volume. It then removes every volume labelled as that
container for this install, and no other. A volume whose name does not
match a volume name is left alone, so a label cannot become a flag. If the
container is already gone and the box id is known, the labelled volumes of
that container name are still removed, so a release interrupted after the
container went can finish. At each maintenance pass, the backend also finds
this install's labelled volumes without a container and removes them. It
leaves volumes of boxes being made alone, using the engine's shared placement
reservations. Restored and forked containers use names of the form
`bbbox-<box>-<8 hex>` and make their volumes before their containers.
Those units must reserve creation under the new container name, so cleanup
cannot remove the volume in between. Cleanup runs after CPU and LXCFS
upkeep. Each removal failure is logged and retried on the next pass,
without stopping cleanup of other volumes.

A box made before this record keeps its anonymous volume. Making it again
finds the container, leaves it, and removes the named volume this attempt
created, because that volume is not mounted. A release of that box removes
the anonymous volume with the container.

If a volume of the box's name already exists and its labels are not this
container's for this install, the make stops and says to remove that
volume. It checks the labels again after creation, because Docker returns success
when the volume already exists. It does not mount or delete a foreign volume.
Each removal checks its own result; a missing volume cannot hide another
volume's failure.

On rootless Docker, and when `privileged` is off, there is no volume, as
today. A take of such a box will be the commit alone.

A local engine, Docker over SSH, and a BB machine's Docker all use this
path. Hetzner and Namespace Linux boxes are containers made by the same
Docker backend, so a new box there gets the same volume. Their snapshot
offer stays off until their own changes.

An image box, which tries a build and is not a box a person keeps, stays
on an anonymous volume. Removing that container with `--volumes` already
deletes it. Image boxes use the same container argument builder as ordinary
boxes. Restore and fork will use that builder in later units.

### How a later take, restore, fork and keep will work

The core already flushes the box, records the operation, checks the count
and the room, and reads the reset version. The backend then reads the
sizes, refuses an image of 120 layers or more (Docker stops at 125, measured
as "max depth exceeded" at commit 124), pauses, copies the volume with a
helper container that has no network, commits with the pause left off and
the identity blanked, and unpauses in a finally. The helper is privileged,
because overlay's `trusted.*` attributes and whiteout devices need it. It
uses the box's own image, with `--pull never`.

On a box with no Docker volume, the take is the commit alone, while paused.

Only the take pauses a box. After a restart, a paused container is settled
from the engine. An image means the take finished. No image, and still
inside the time bound, means it is still running. Past the bound, the
container is unpaused, the leftover volume is deleted, and the take has
failed. The sweep uses the same bound.

A restore stops the box, takes an undo, makes a new container from the
snapshot at the snapshot's size, with the box's identity and the old
container's GPU placement, and deletes the old container once the new one
starts. A failed start puts the old container back. The snapshot's volume
is copied. The snapshot's own volume is never mounted by the new box.

A fork is a new container from the snapshot image, placed again, with its
own box id in `BBBOX_IDENTITY` and restart policy `no` until the core's
checks pass. Then the policy becomes `unless-stopped`.

Keep adds the date tag and removes any other keep tag for that snapshot.
The tag is written before BB Box's own record. Stopping keeping removes
the tag. Delete removes the keep tag, the snapshot tag, and the snapshot
volume. A release deletes snapshots nobody kept. A kept snapshot stays
where it is, on that engine.

Room is read with `df` on the filesystem that holds Docker's data. The
estimate is the changed layer times the image store's factor (1.0 on
overlay2, about 2.0 on containerd) plus the volume's size. The existing
room rule applies. There is no price on a person's own engine.

### What was measured

Measured on one Linux guest, released afterwards, while this design was
written. The guest was a Proxmox QEMU VM with 4 vCPU, 8 GiB of memory and
an 80 GB ext4 disk (2 GiB written directly in 8.8 s, about 240 MB/s). It
ran Ubuntu 24.04.5, kernel 6.8.0-149, Docker Engine 29.1.3, and Docker
29.9.3 inside the box. The stand-in was the `docker:29-dind` image, made
with the flags a box gets: privileged, `--init`, a tmpfs on `/run`, a
volume at `/var/lib/docker`, `BBBOX_IDENTITY` and `bbbox.*` labels. Its
Docker held `postgres:17`, `nginx:alpine`, an image with a deleted file,
and a running Postgres with 100,000 rows.

| What | How | Result |
| --- | --- | --- |
| Flush | `docker exec` of `sync` | 62 ms |
| Pause and unpause | `docker pause`, `docker unpause` | 46 ms and 64 ms |
| Volume copy, 759 MB | a privileged helper, `cp -a`, no network | 12.1 s (a tar pipe with xattrs took 18.5 s) |
| Commit, containerd, 1.07 GB layer, paused | `docker container commit --pause=false` | 33.5 s. The same commit with Docker's own pause took 16.2 s |
| The whole freeze | pause to unpause, that layer plus about 760 MB of Docker data | 45.6 s |
| Commit, containerd, 329 MB of 40,000 files | the same commit | 8.0 s |
| Space, containerd | `docker image ls` | a 1.07 GB layer used 2.6 GB of disk (base 455 MB), about 2.0 times. A 329 MB layer used about 1.75 times |
| Commit, overlay2, 1.4 GB | `--pause=false`, caches warm, then dropped | 6.3 s, 18.8 s and 39.2 s |
| Undo commit of a stopped box, overlay2 | `docker container commit` | 24.5 s, and 29.3 s cold |
| Space, overlay2 | `df` before and after | 1.37 GB more, 1.0 times the layer |
| Restore | volume copy, create, start until inner `docker info` | 6.5 s, 193 ms and 747 ms |
| What came back | the file, the 1 GiB file, inner images, a whiteout, Postgres | the files, three images, the deleted file still absent, 100,000 rows |
| Labels in a commit | `docker image inspect` | the container's labels and environment are inherited, and `--change` overrides them |
| Environment on create | `docker create --env` of a snapshot image | the new value wins over the image's |
| Removing an image a container uses | `docker image rm` of its last tag | refused unless forced. Other tags go |
| Layer limit, overlay2 | create then commit, 140 rounds | "max depth exceeded" at commit 124, which is 125 layers |
| Reading sizes and room | `inspect --size`, `du` in a helper, `df` in a helper | 71 ms, 344 ms and 334 ms |
| Stop | `docker stop -t 10` | 310 ms |

Commit time varies with the page cache. A plan should use cold rates:
about 30 s a GiB on containerd, about 25 s a GiB on overlay2 with many
small files, and about 15 s a GiB to copy the volume on ext4. Decision
070's "15 s for 1 GiB changed" is a warm commit, and it is low.

Small overlay2 boxes froze for 3.5 to 4.9 s. The long case, about 45 s,
was a 1.8 GB change on the containerd store (a 1.07 GB layer plus about
760 MB of Docker data).

### Alternatives

- Copying the Docker data into the writable layer, then committing again.
  Rejected. Overlay treats an inner whiteout as its own whiteout. The data
  also sits in a layer a restore cannot free.
- Storing the volume as a tar inside an image. Useful later as the way to
  carry a snapshot to another engine. Rejected as the snapshot itself,
  because every box made from it would keep a dead copy in a lower layer,
  and every restore would unpack it.
- `docker export` and `docker import` of the whole root filesystem.
  Rejected for a take. It copies everything and drops the image settings.
  It stays available for flattening an image that is near the layer limit.
- Committing and copying while the box runs. Rejected. A torn database
  would come back as if it were sound.
- Copying the volume under our pause, then committing with Docker's own
  pause. Rejected. The disk and the Docker data would be seconds apart.
  Docker would also unpause during the commit if BB Box had stopped.
- Keeping the snapshot's state only in BB Box's own storage. Rejected. The
  engine can hold the names, the labels and the keep date, and the guide
  asks for that.
- A separate manifest volume, from the other design. Rejected by the lead,
  as a second record that has to stay in step with the image and the volume.

### The sequence

Each step is merged before the next starts. This record is step 1. Steps
2 to 11 are not built with it.

1. One way to make a box's container, with a named Docker volume. A release
   removes the volumes labelled as that box. An existing box keeps its
   anonymous volume.
2. Take, list and delete. The offer has no restore, no fork and no Keep.
   The freeze, settling a pause after a restart, room, a release dropping
   snapshots nobody kept, the doctor checks, and the guide.
3. Restore as a new container, with an undo.
4. Forks. Reset version 7 for a Linux server and 9 for a Linux desktop.
5. Keep, as the tag, including a fork after the box is released.
6. The conformance suite's snapshot checks, run live on Docker.
7. Hetzner: snapshots of live boxes, on the host. Keep off, with the reason.
   Forks on the same host.
8. Namespace: snapshots of live boxes, on the instance. Fork and Keep off,
   with the reasons.
9. Carry a snapshot to another engine. Namespace forks, and Hetzner forks
   onto another host.
10. Hetzner: a kept snapshot on a Hetzner Volume, with its own decision
    record and a price.
11. Namespace: a kept snapshot in the workspace registry, once its price is
    known.

Left for later, and not part of these steps: flattening an image past 110
layers, a two-pass volume copy that does most of the copy before the
freeze, and whether cancelling a commit client stops the engine's commit.

## Consequences

- A Docker box made after this record keeps its Docker data on a named,
  labelled volume. A box made before keeps its anonymous volume, and a
  release still removes it.
- Hetzner and Namespace Linux boxes made after this record get the same
  volume, because they are made by the Docker backend. Their snapshot
  offer does not change.
- The core is unchanged. Docker does not offer snapshots until step 2.
- An image box stays on an anonymous volume.
- The container settings include the install id, because the volume's
  install label cannot be set without it. The snapshot id on those
  settings is plain text until the snapshot module exists.
- Decision 070's Docker row still says a pause of 15 s for 1 GiB changed.
  The cold rates above replace that figure for a plan. The row itself is
  left as it was written.
