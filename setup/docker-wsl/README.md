# Docker in WSL on a Windows PC

This makes a Windows PC a Docker host for bb-box's
[Docker backend](../docker/README.md). Docker Engine runs in one WSL 2
distribution, `bbdocker`, and listens on its unix socket only. When BB runs
on this PC, the backend's host is `wsl://bbdocker`. bb-box reaches the
daemon with `wsl.exe` and `docker system dial-stdio`, inside the
distribution, so the bytes never cross WSL's localhost forwarder. The
distribution also runs SSH on port 2222, for a BB server on another machine.

It works on every edition of Windows 11, Home too, needs no Docker Desktop,
and runs before anyone signs in. A box is ready 2 to 4 s after it is asked
for, and boxes run again within about 80 s after Windows restarts.

| Path | What it does |
| --- | --- |
| `setup.ps1` | Sets up the PC: run it once, in PowerShell as an administrator |
| `guest.sh` | Sets up the distribution: `setup.ps1` runs it inside |

How it works:

- WSL runs all of a Windows user's distributions in one lightweight VM.
  `setup.ps1` imports Ubuntu 24.04's WSL image as `bbdocker`, with systemd,
  Docker Engine from Docker's repository, and OpenSSH on port 2222. Windows'
  own OpenSSH Server, if it runs, keeps port 22.
- `.wslconfig` in the user's profile turns on mirrored networking, so the
  distribution listens on the PC's addresses, and turns off WSL's idle
  timeout, so it keeps running with nobody using it. It also turns off WSLg,
  WSL's Linux GUI support, whose compositor crashes with nobody signed in.
  Mirrored networking is how SSH from another machine reaches the
  distribution. It is not how bb-box on this PC reaches Docker.
- dockerd stays on its unix socket. Nothing listens on `127.0.0.1:2375`.
  WSL's localhost forwarder, which a program on Windows uses to reach a TCP
  port inside the distribution, drops an attached stream once the client
  closes its write side. `docker run` that prints output, and `docker exec`,
  then exit 0 and print nothing. `wsl://bbdocker` does not use that
  forwarder: `wsl.exe` runs `docker system dial-stdio` in the distribution,
  and the daemon's reply comes back on the process's stdout.
- A rule in the Hyper-V firewall, which filters WSL's traffic, lets port 2222
  in. The Windows firewall can stay on.
- A scheduled task, "bb-box WSL Docker host", starts the distribution when
  Windows starts, before anyone signs in, and keeps it running. It brings the
  distribution back within a minute after `wsl --shutdown`.

## What you need

- Windows 11 22H2 or later on x86_64, any edition, with virtualisation turned
  on in the PC's firmware.
- PowerShell 7.4 or later, run as an administrator, signed in as the Windows
  user who will own the distribution. The scheduled task runs as that user.
- Memory for WSL, which takes half the PC's memory by default. A small linux
  box takes 4 GiB and a desktop box 8 GiB. On a PC with 16 GB, run
  `setup.ps1` with `-Memory 12GB`: that runs one desktop box, or two small
  linux boxes, at a time.
- Disk on the PC's drive: about 3 GB for the distribution, then about 36 GB
  free to build all three images, as the Docker guide says. Boxes and
  `build.sh` see WSL's disk as about 1 TB free, since it is a sparse file, so
  watch the free space on the PC's drive instead.
- The PC must not sleep: in Settings, under Power, set sleep on mains power to
  Never, or run `powercfg /change standby-timeout-ac 0`.
- The machine that runs BB must reach the PC on TCP port 2222.

## Steps

### 1. Set up the PC

1. On the machine that runs BB, as the user BB runs as, find its public SSH
   key, such as `~/.ssh/id_ed25519.pub`. Make one with `ssh-keygen -t ed25519`
   if it has none.
2. Copy this directory to the PC.
3. Open PowerShell 7 as an administrator in it, and run:

   ```powershell
   .\setup.ps1 -Key "ssh-ed25519 AAAA... bb@server"
   ```

4. If it says to restart Windows, restart, then run it again. The first run
   turns on Windows' Virtual Machine Platform, which needs a restart.

It installs WSL from Microsoft's GitHub release if WSL is missing, downloads
Ubuntu's image, checks its SHA-256 and sets everything up. At the end it
prints the host to use and the PC's addresses. Its options:

| Option | Default | Meaning |
| --- | --- | --- |
| `-Key` | none | The public key the `docker` CLI logs in with |
| `-Name` | `bbdocker` | The distribution's name |
| `-User` | `box` | The Linux user the `docker` CLI logs in as |
| `-Port` | 2222 | The distribution's SSH port |
| `-Path` | `C:\WSL\bbdocker` | Where the distribution's disk goes |
| `-Memory` | WSL's own | Memory for the whole WSL VM, such as `12GB` |

### 2. Build the images

On this PC, run the build inside the distribution, on dockerd's unix socket.
`cd` to a checkout of bb-box. `/mnt/c/...` is a path on the PC's `C:` drive:

```powershell
wsl.exe -d bbdocker -u box -e bash -lc "cd /mnt/c/src/bb-box && setup/docker/build.sh"
```

From a BB server on another machine, log in once to accept the PC's host key,
then build:

```sh
ssh -p 2222 box@<pc> true
DOCKER_HOST=ssh://box@<pc>:2222 setup/docker/build.sh
```

### 3. Configure bb-box

Set up the Docker backend as its [guide](../docker/README.md) says.

When BB runs on this PC, set `host` to `wsl://bbdocker`. That is the
distribution's name. `wsl://box@bbdocker` is the same with the Linux user
named. bb-box runs `wsl.exe -d bbdocker -u box -e docker`, and dial-stdio
for the relay, against the unix socket. Do not set `tcp://127.0.0.1:2375`.

When BB runs on another machine, set `host` to `ssh://box@<pc>:2222`. Use
the PC's name or a fixed address: a DHCP address can change.

Set Memory kept free (`reserve-memory-mib`) to 1024. WSL's memory limit
already keeps Windows' share, and with WSL at 12 GB the default of 4096
refuses a desktop box.

## Check it worked

```sh
wsl.exe -d bbdocker -u box -e docker info
bb box doctor
```

From another machine, `DOCKER_HOST=ssh://box@<pc>:2222 docker info` is the
same check.

`linux` and `linux-desktop-cpu` boxes are tested on WSL. The Wayland desktop
image builds there too, but has not been tried on WSL yet, and GPU desktops
are not tested: use `linux-desktop-cpu`.

## Update

- Run `setup.ps1` again to update the distribution's packages or change the
  key. It keeps the distribution, its images and its running boxes.
- The images rebuild as on any Docker host: see the Docker guide's Update.
- Windows Update restarts the PC. The boxes start again with it, about 80 s
  after the restart, each with its processes started afresh.

## Remove

1. In BB, release the backend's boxes, and turn the Docker backend off or
   remove it.
2. On the PC, in PowerShell as an administrator, signed in as the user who
   set it up:

   ```powershell
   Unregister-ScheduledTask -TaskName "bb-box WSL Docker host" -Confirm:$false
   Get-NetFirewallHyperVRule | Where-Object DisplayName -like "bb-box: SSH to *" | Remove-NetFirewallHyperVRule
   wsl --unregister bbdocker
   ```

3. Delete `C:\WSL\bbdocker`, and the `[wsl2]` settings `setup.ps1` added to
   `.wslconfig` in your profile: `networkingMode`, `vmIdleTimeout` and
   `guiApplications`.

## When it goes wrong

- **`docker run` or `docker exec` from Windows prints nothing and exits 0**:
  that is WSL's localhost forwarder. The host is `wsl://bbdocker` when BB
  runs on this PC, not `tcp://127.0.0.1:2375`. dockerd stays on its unix
  socket. bb-box's doctor fails a `tcp://127.0.0.1` host on Windows when an
  attached command's output does not come back, and a box command whose
  stream ends without an exit status fails instead of reporting exit 0.
- **`Connection refused` on port 2222**: check that the distribution runs,
  with `wsl --list --verbose` as the user who set it up, and that the
  scheduled task runs: `Get-ScheduledTask "bb-box WSL Docker host"`.
- **Connection timed out**: check the Hyper-V firewall rule, with
  `Get-NetFirewallHyperVRule | Where-Object DisplayName -like "bb-box: SSH to *"`,
  and any firewall between BB's machine and the PC.
- **`wsl --install` fails over SSH, saying WSL is not installed**:
  `setup.ps1` installs WSL from its GitHub release instead.
- **A message at WSL's first start that nested virtualisation is not
  supported**: it is harmless.
- **Linux GUI apps in your other WSL distributions open no windows**: WSLg is
  off for all of that user's distributions.
- **Two separate WSL VMs**: `setup.ps1` was run as two Windows users. Run it
  as one user only.
