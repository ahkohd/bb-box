# microsandbox backend

This backend runs Linux boxes as microVMs on one Linux host with KVM, with
[microsandbox](https://github.com/superradcompany/microsandbox)'s `msb`. It
is an option beside the [Docker backend](../docker/README.md), not a
replacement and not the default: keep it after Docker in the backend order,
and ask for it with `--on` (or `box_acquire`'s `on`) for a box that needs a
kernel of its own. On bare metal it makes boxes as fast as Docker, and
removes them faster; under nested KVM, as in WSL 2, Docker is about twice as
fast. Either way a microVM holds far more memory while idle, as it keeps
its own page cache
([053](../../docs/decisions/053-microsandbox-runs-light-linux-boxes-as-microvms.md#what-the-built-backend-measured)).
It offers two kinds, from the same images as the Docker backend:

- **linux**: Ubuntu 24.04 with the same tools as a Docker or Proxmox LXC
  linux box, and Docker of its own;
- **linux-desktop-cpu**: XFCE and Chrome, drawn by the CPU, with computer use
  through Cua Driver.

Each box has a kernel of its own, so Docker in it needs no privilege on the
host, where a Docker box with Docker is a privileged container, and Chrome
runs with its own sandbox. That isolation is what this backend is for. Boxes join BB as machines, as
other Linux boxes do.

The host is the machine that runs BB, another machine over SSH, or a BB
machine, through BB. bb-box installs its own `msb` there, at the release it
pins, and reaches inside a box with `msb exec`, so it needs no network path to
the boxes. How bb-box drives a box is in the
[architecture](../../docs/architecture.md#microsandbox).

## What you need

- A Linux host on x86_64 with `/dev/kvm`: the machine itself, or a VM with
  nested virtualisation on. bb-box is tested on a Windows PC's WSL 2, where
  Hyper-V nests KVM, with glibc 2.28 or later.
- The user who runs the boxes allowed to use `/dev/kvm`: on most
  distributions, in the `kvm` group. On a BB machine that is the user BB's
  app runs as; over SSH, the user bb-box logs in as; on BB's server, the user
  BB runs as.
- `curl` and `tar` on the host, with which bb-box installs `msb`, and
  `mkfs.ext4` (e2fsprogs), with which it makes each box's Docker disk. Without
  it, boxes start more slowly.
- Docker on the host, to build the images, as for the Docker backend: about
  28 GB free to build both. bb-box imports them from Docker into `msb`.
- Disk for `msb`: about 6 GB for both images once imported, and what each box
  writes. A box's disks are sparse, so they take only what it writes.
- Memory for the boxes: bb-box keeps 4 GiB of the host's memory free by
  default, and counts each running box's full size, so a host for a few
  small boxes needs 16 GiB. A box that has joined BB holds about 2 GiB of
  the host's memory while idle, as its guest keeps its own page cache.
- For a host over SSH: the user BB runs as logs in to it with a key and no
  prompt.

Before you rely on it:

- **Beta.** `msb` is 0.7.7 and may change before 1.0. bb-box pins one
  release, checks its SHA-256, and moves to a new one only in a bb-box
  release that passes the conformance suite (see Update).
- **Not a security boundary.** A box has its own kernel, but its user may use
  `sudo`, and bb-box does not aim at isolation.
- **Not in LXC.** A Proxmox LXC container with `/dev/kvm` passed in runs
  boxes, but its seccomp filter stops `msb`'s snapshots and flat roots, which
  spares from forks will need. Use a VM or the machine itself.
- **No GPU.** `msb` has no GPU, so there are no GPU desktops.
- **Enrolment.** A box reaches BB's server through `msb`'s network, with the
  profiles `public,private`, so BB on a private or tailnet address works. BB
  on the host's localhost does not.

## Steps

### 1. Get the host ready

On the host, as the user who runs the boxes:

```sh
ls -l /dev/kvm                 # it is there
id                             # the user is in its group, usually kvm
sudo usermod -aG kvm "$USER"   # if not, then sign in again
```

On a BB machine, BB's app keeps the groups it started with. After adding its
user to `kvm`, restart that user's services:
`sudo systemctl restart user@$(id -u <user>).service`. In WSL, run
`wsl --shutdown` from Windows instead, and start the distribution again.

### 2. Build the images

bb-box never pulls an image. Build them with Docker on the host, from a
checkout of bb-box, as for the [Docker backend](../docker/README.md#2-build-the-images):

```sh
git clone <bb-box repository> && cd bb-box
setup/docker/build.sh linux desktop
```

bb-box imports `bbbox/linux:1` and `bbbox/linux-desktop:1` into `msb` with
`docker save` and `msb load`: the linux image in about 6 s and the desktop in
about 20 s, at the first box of each kind, or by its upkeep within a few
minutes. It imports an image again when Docker's has changed. A host that is
also a Docker backend's shares these images with it.

### 3. Configure bb-box

On BB Box's settings page in BB, set up the microsandbox backend: fill in its
fields, press Check, then Save and turn on.

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | empty | `bb:<machine ID>` for a BB machine, which bb-box reaches through BB, or `ssh://user@host`. Empty uses the machine that runs BB |
| `linux-image` | `bbbox/linux:1` | The image of linux boxes. Empty turns them off |
| `desktop-image` | `bbbox/linux-desktop:1` | The image of linux-desktop-cpu boxes. Empty turns them off |
| `docker` | on | Each box has a Docker daemon of its own, with its data on an ext4 disk of the box's own. Off, boxes have no Docker |
| `docker-disk-gib` | 64 | The most each box's Docker disk may grow to |
| `disk-gib` | 32 | The most a box's root disk may grow to, when no disk size is asked for |
| `network` | `public,private` | `msb`'s network profiles for each box: `public` reaches the internet, `private` the host's local networks and tailnet |
| `boxes` | 20 | The most bb-box microVMs on the host, running or stopped, of every bb-box install that uses it |
| `reserve-memory-mib` | 4096 | A new box is refused when the host would have less memory than this left, after the memory of the running boxes |

`bb machine list` gives a BB machine's ID. From a terminal,
`bb box config show --json` prints the configuration, and
`bb box config apply <file>` saves it. A backend on a BB machine is:

```json
{ "id": "microsandbox", "type": "microsandbox", "enabled": true, "fields": { "host": "bb:host_abc123" } }
```

Another microsandbox backend, on another host, has an ID of its own, such as
`microsandbox:devpc`.

bb-box installs `msb` on the host the first time it needs it, which takes
about 2 s. It keeps `msb`, its state and the images in a folder of its own:

| Host | Folder |
| --- | --- |
| A BB machine | `microsandbox` in bb-box's data folder on the machine, such as `~/.bb-machines/<BB server>/plugins/bb-box/host-data/microsandbox` |
| Over SSH, or BB's server | `~/.local/share/bb-box/microsandbox` |

Each box's Docker disk is in the folder's `disks`, and goes with the box.

`msb` needs a short path for its sockets, so when the folder's is long,
`msb` reaches it through a link, `/tmp/bb-box-msb-<uid>`. bb-box never uses
your own `~/.microsandbox`.

## Check it worked

Run `bb box doctor`. For the microsandbox backend it checks:

- the host answers, runs Linux on x86_64, and its cores, memory and free disk;
- `msb` is installed at the release bb-box pins;
- `/dev/kvm` is there and the user may use it;
- each image is in `msb`, or in Docker for bb-box to import, and how old it
  is;
- whether the host is an LXC container;
- the room on the host for a box at each kind's default size.

Its notes say how much disk `msb`'s state and images take.

To try the backend without BB, run the conformance suite from a checkout of
bb-box on the host. It acquires a box of each kind, checks it, and releases
it; without BB it skips enrolment, and says so:

```sh
npm install
echo '{ "backends": [{ "id": "microsandbox", "type": "microsandbox", "enabled": true, "fields": {} }] }' > msb.json
npm run conformance -- --backend microsandbox --settings msb.json
```

## Update

- **msb.** A bb-box release that pins a new `msb` installs it the first time
  it needs it, beside the old one in bb-box's folder, after checking its
  SHA-256. Do not run `msb self update` on bb-box's `msb`: bb-box would put
  its own release back. To free the space, remove the old release's folder,
  named by its version, such as `0.7.7`.
- **Images.** Rebuild them with `build.sh`, or let the nightly run rebuild
  Docker's ([setup](../README.md#rebuild-images-each-night)). bb-box imports
  each changed image into `msb` within a few minutes. Boxes made before keep
  running from the image they started with.

## Remove

1. In BB, release the backend's boxes, turn the backend off and remove it on
   BB Box's settings page.
2. On the host, remove bb-box's folder (see the table under step 3) and its
   link:

   ```sh
   bin=<folder>/bin/msb
   "$bin" ls                       # any boxes left
   "$bin" rm --force <name>
   rm -rf <folder> /tmp/bb-box-msb-$(id -u)
   ```

3. Remove the images from Docker if no Docker backend uses them:
   `docker image rm bbbox/linux:1 bbbox/linux-desktop:1`.

## When it goes wrong

- **"has no /dev/kvm"**: the host has no KVM. Use the machine itself, or turn
  on nested virtualisation for its VM.
- **"BB's user may not use it"**: add the user to the `kvm` group (step 1),
  then restart its services so it has the group.
- **"has no image"**: build the images with Docker on the host (step 2).
- **Installing msb fails**: the host needs `curl` and `tar`, and to reach
  GitHub. "SHA-256 is ..., not ..." means the download was not the release
  bb-box was tested with, so bb-box did not install it. Try again later.
- **A box does not join BB**: check that BB's server URL resolves and
  connects from the host. Its address must be one the `network` profiles
  reach: keep `private` for a private or tailnet address.
- **"belongs to another user"**: someone else owns `/tmp/bb-box-msb-<uid>`.
  Remove it.
- **A box does not come up**: `<folder>/bin/msb logs bbbox-<box ID>` shows
  its output. bb-box's error says what it saw.
