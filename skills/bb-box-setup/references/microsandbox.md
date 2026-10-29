# microsandbox

microsandbox runs Linux boxes as microVMs with `msb`, each with a kernel of
its own, on one Linux host with KVM or a Mac. It makes `linux` and
`linux-desktop-cpu`, and on a Mac `linux-arm64` and
`linux-arm64-desktop-cpu`. It is an option beside Docker, not the default:
keep it after Docker in the backend order, and ask for it with `--on`. Its
boxes run Docker without a privileged container, and Chrome with its own
sandbox. `msb` is beta. The guide is `setup/microsandbox/README.md`.

## Ask

- Which host: the machine that runs BB, a BB machine, or a host over SSH.
- Whether `/dev/kvm` is there and the user who runs the boxes may use it.
  Not in a Proxmox LXC container: KVM passed into one does not work.
- Disk: about 6 GB for both images, and each box's root disk, 32 GiB at
  most by default.

## Prepare the host

On the host, as the user who runs the boxes:

```sh
ls -l /dev/kvm && id      # the user must be in the device's group, usually kvm
```

Adding the user to `kvm` needs root: ask the person to run
`sudo usermod -aG kvm <user>`. On a BB machine, then restart that user's
services, `sudo systemctl restart user@$(id -u <user>).service`, so BB's app
gets the group.

The images come from Docker on the host, built as for the Docker backend:
`setup/docker/build.sh linux desktop` from a checkout of bb-box at the
installed commit. bb-box imports them into `msb` at the first box. A host
without Docker, such as a Mac, needs nothing: bb-box builds the images there
itself in a microVM, in about 3 minutes, with 80 GiB free while it builds.
bb-box installs its own `msb` on the host the first time, in about 2 s.

## Add it

```sh
bb machine list                                    # the BB machine's ID
bb box backend add microsandbox --field host=bb:<machine ID> --check
bb box backend add microsandbox --field host=bb:<machine ID>
```

`host` is `bb:<machine ID>` for a BB machine, `ssh://user@host` for a host
over SSH, or empty for the machine that runs BB. A second microsandbox
backend on another host needs `--id <name>`. `memory-overcommit=2` fits more
idle boxes on a host.

## Check and prove

`bb box doctor` checks KVM, `msb`, the images and the room. Prove it with
`bb box acquire linux --on microsandbox`. The first box of a kind waits for
its image to import, about 6 s for linux and 20 s for the desktop.
