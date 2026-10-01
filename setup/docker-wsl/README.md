# Docker in WSL on a Windows PC

This makes a Windows PC a Docker host for bb-box's [Docker backend](../docker/README.md).
Docker Engine runs in one WSL 2 distribution, `bbdocker`, with its own SSH
server on port 2222. WSL's mirrored networking puts that port on the PC's own
address, so the backend's host is `ssh://box@<pc>:2222`. Boxes then work as
on a Linux Docker host: linux boxes, with Docker when `privileged` is on,
linux-desktop-cpu boxes, their desktops, computer use and enrolment.

It works on every edition of Windows 11, Home too, needs no Docker Desktop
and runs before anyone signs in.

We tested it in a Windows 11 Pro VM with 8 cores and 16 GiB (#158). The
first run took 75 s. A box was ready 2 to 4 s after it was asked for, and
after Windows restarted the boxes ran again within 80 s. bb-box's conformance
suite passes against it.

| Path | What it does |
| --- | --- |
| `setup.ps1` | Sets up the PC: run it once, in PowerShell as an administrator |
| `guest.sh` | Sets up the distribution: `setup.ps1` runs it inside |

## How it works

- WSL runs all of a Windows user's distributions in one lightweight VM.
  `setup.ps1` imports Ubuntu 24.04's WSL image as `bbdocker`, with systemd,
  Docker Engine from Docker's repository, and OpenSSH on port 2222. Windows'
  own OpenSSH Server, if it runs, keeps port 22.
- `.wslconfig` in the user's profile sets mirrored networking, so the
  distribution listens on the PC's addresses, and turns off WSL's idle
  timeouts, so it keeps running with nobody using it. It also turns off
  WSLg, WSL's Linux GUI support: with nobody signed in its compositor
  crashes every few minutes and fills the disk with crash dumps.
- A rule in the Hyper-V firewall, which filters WSL's traffic, lets port 2222
  in. The Windows firewall can stay on.
- A scheduled task, "bb-box WSL Docker host", starts the distribution when
  Windows starts, before anyone signs in, and keeps a process in it. It
  waits until Windows has been up a minute: WSL started any sooner gets its
  network 3 minutes late. It tries again each minute, so the distribution
  comes back within a minute after `wsl --shutdown`. Boxes have Docker's
  `unless-stopped` restart policy, so a running box starts again too.
- The docker CLI on BB's server logs in as `box`, who may use Docker and
  accepts only the key you give.

## Requirements

- Windows 11 22H2 or later on x86_64, any edition. Mirrored networking needs
  22H2.
- Virtualisation turned on in the PC's firmware.
- PowerShell 7.4 or later, run as an administrator, signed in as the Windows
  user who will own the distribution. The scheduled task runs as that user.
- Memory for WSL: by default it takes half the PC's memory. A small linux
  box takes 4 GiB and a desktop box 8 GiB. On a PC with 16 GB, run
  `setup.ps1` with `-Memory 12GB`: that runs one desktop box or two small
  linux boxes at a time.
- Disk: about 3 GB for the distribution, then the images (about 10 GB) and
  the boxes. Boxes report about 1 TB free, since WSL's disk is a sparse file
  of up to 1 TB, so watch the free space on the PC's drive instead.
- The PC must not sleep. In Settings, under Power, set the screen and sleep
  times on mains power to Never, or run `powercfg /change standby-timeout-ac 0`.
- BB's server must reach the PC on TCP port 2222.

## 1. Set up the PC

1. On BB's server, as the user BB runs as, find its public SSH key, such as
   `~/.ssh/id_ed25519.pub`. Make one with `ssh-keygen -t ed25519` if it has
   none.
2. Copy this directory to the PC.
3. Open PowerShell 7 as an administrator in it, and run:

   ```powershell
   .\setup.ps1 -Key "ssh-ed25519 AAAA... bb@server"
   ```

4. If it says to restart Windows, restart, then run it again. It turns on
   Windows' Virtual Machine Platform the first time, which needs a restart.

It installs WSL from Microsoft's GitHub release if WSL is missing, downloads
Ubuntu's image, checks its SHA-256 and sets everything up. At the end it
prints the host to use and the PC's addresses.

Running it again is safe: it keeps the distribution, its images and its
running boxes, updates the packages and replaces the key. Its options:

| Option | Default | Meaning |
| --- | --- | --- |
| `-Key` | none | The public key the docker CLI on BB's server logs in with |
| `-Name` | `bbdocker` | The distribution's name |
| `-User` | `box` | The Linux user BB's server logs in as |
| `-Port` | 2222 | The distribution's SSH port |
| `-Path` | `C:\WSL\bbdocker` | Where the distribution's disk goes |
| `-Memory` | WSL's own | Memory for the whole WSL VM, such as `12GB` |

## 2. Check it from BB's server

As the user BB runs as, log in once to accept the PC's host key, then ask
Docker:

```sh
ssh -p 2222 box@<pc> true
DOCKER_HOST=ssh://box@<pc>:2222 docker info
```

## 3. Build the images and turn on the backend

Build bb-box's images on the PC's Docker, from a copy of bb-box anywhere the
docker CLI can reach it:

```sh
DOCKER_HOST=ssh://box@<pc>:2222 setup/docker/build.sh
```

Then set up the Docker backend as its [guide](../docker/README.md) says,
with `host` set to `ssh://box@<pc>:2222`. Use the PC's name or a fixed
address: a DHCP address can change.

Set Memory kept free (`reserve-memory-mib`) to 1024. The backend keeps
4096 MiB free by default, but WSL's memory limit already keeps Windows'
share, and with WSL at 12 GB the default refuses a desktop box.

## Limits

- One user's distributions share one VM. Other WSL distributions of the same
  Windows user share its memory and network, and `wsl --shutdown` stops every
  box.
- Running `setup.ps1` as another Windows user makes a second, separate WSL
  VM. Run it as one user only.
- GPU desktops (linux-desktop) are not tested on WSL. Use linux-desktop-cpu.
- Windows Update restarts the PC. The boxes start again with it, about
  80 s after the restart, but each box's processes start afresh, as after
  any box restart.
- WSLg is off for all of the user's distributions, so Linux GUI apps in
  their other distributions open no windows.

## Troubleshooting

- `ssh: connect to host ... port 2222: Connection refused`: check that the
  distribution runs, with `wsl --list --verbose` as the user who set it up,
  and that the scheduled task runs, with
  `Get-ScheduledTask "bb-box WSL Docker host"`.
- Connection timed out: check the Hyper-V firewall rule with
  `Get-NetFirewallHyperVRule -Name bb-box-docker-wsl-ssh`, and any firewall
  between BB's server and the PC.
- `wsl --install` fails over SSH, saying WSL is not installed: `setup.ps1`
  installs WSL from its GitHub release instead.
- A message at WSL's first start that nested virtualisation is not supported
  is harmless.
