# 071 results

What was measured and built for each unit of [071](071-gpu-boxes.md). Each
unit keeps to its own section.

## Unit 0: measurements on the node

Measured on 31 October 2026, on main `7a8dbeab`, in the order of section
16's list.

### How it was measured

- The builder never reached the Proxmox node. For each step the builder
  wrote one small bash script; the lead read it and ran it as root on the
  node, and sent back its output.
- Each script made its own test guests, on four VMIDs the lead lent outside
  bb-box's ranges, and destroyed them before it ended. Each script refused
  any other VMID and any VMID already in use, and printed at its end that
  all four were absent.
- No script read inside, or changed, a guest it did not make. Only step 9
  read other guests' configs, for their tags and a checksum. The owner's
  GPU boxes were left running throughout.
- GPU figures were read card-wide (`nvidia-smi --query-gpu`), never from the
  training boxes' processes.
- Steps 1 to 9 loaded no card: step 7 ran `nvidia-smi`, which makes no
  CUDA context. Step 10 loaded each card once, under the
  rules in section 16.
- Step 9's part with no card ran on a `linux` box of bb-box's own Linux
  image, on Proxmox LXC, not on the node.

The node: Proxmox VE 9.2 on kernel 6.17.13, two NVIDIA RTX PRO 6000
Blackwell Max-Q cards with 97,887 MiB each, NVIDIA driver 580.142, and a
BMC with its own VGA device.

### 1. Versions

`pveversion -v` on the node:

| Package | Version |
| --- | --- |
| proxmox-ve | 9.2.0 |
| pve-manager | 9.2.21 |
| pve-container | 6.1.14 |
| lxc-pve | 7.0.0-2 |
| qemu-server | 9.2.10 |
| libpve-guest-common-perl | 6.0.5 |
| libpve-common-perl | 9.2.3 |
| libpve-access-control | 9.1.2 |
| pve-cluster | 9.1.6 |
| kernel | 6.17.13-2-pve |
| NVIDIA driver (`/sys/module/nvidia/version`) | 580.142 |

The note names pve-container 6.0.4, from July 2025. The node runs 6.1.14.
Section 5's helper refuses to write on a version its release was not tested
on, so unit 2's first tested version is 6.1.14.

### 2. A device change through bb-box's token

Method: the installed `check_ct_modify_config_perm` (`PVE/LXC.pm`, line
1678) was read, then a stopped test guest was made with `dev0:
/dev/null,mode=0666`, put in bb-box's pool for under a second, and called
with bb-box's own API token, three times:

| Call with the token | Answer |
| --- | --- |
| GET the config (control) | 200; the token reads `dev0` |
| PUT the same description (control) | 200 |
| PUT `dev0` to its current value | 403 "Permission check failed (configuring device passthrough is only allowed for root@pam)" |

The config's SHA-256 was the same before and after. The source returns at
once for `root@pam` (line 1681) and refuses any `devN` key for every other
user (lines 1709 and 1710), whatever its value. An API token's user is
`user@realm!name`, so no token passes.

So the note stands on 6.1.14: only `root@pam` sets device lines, and the
helper is the only way bb-box can change them.

Limits: one call, with one token, on one version. The token had the pool
rights bb-box uses (the two controls passed), so the refusal is about the
device line and not about the pool.

### 3. `lock_config` in the installed source

Method: `grep` for `lock_config` in the installed pve-container and
libpve-guest-common-perl modules, with the API method or sub each one is
in.

- `pct start` is the API's `vm_start` (`PVE/API2/LXC/Status.pm`). Its worker
  takes `PVE::LXC::Config->lock_config` (line 184), checks the guest's
  `lock` inside it (line 195), and calls `PVE::LXC::vm_start` inside it
  (line 209). So the lock is held from the config's last read until the
  container is started.
- Every config change through the API, `pct set` included, is
  `update_vm` (`PVE/API2/LXC/Config.pm`). It checks permissions with
  `check_ct_modify_config_perm` (lines 179 to 211), then applies the change
  with `update_pct_config` and `write_config` (lines 250 and 261), all
  inside `lock_config` (line 268).
- Stop, shutdown, suspend, reboot, clone, template, resize, destroy, move
  volume and every snapshot change take the same lock.
- `lock_config` is `lock_config_full` with a 10 s timeout, an exclusive
  `flock` on `/var/lock/lxc/pve-config-<vmid>.lock`
  (`PVE/AbstractConfig.pm` line 330, `PVE/LXC/Config.pm`'s
  `config_file_lock`). It is local to the node, which is where a guest's
  config is written.

So the note stands: the helper's write inside `lock_config` is ordered
with `pct start` and every API change on that guest. Section 5's check that
the guest is stopped, made inside the lock, cannot race a start.

Limits: read from the source, not tried with two writers at once (unit 2's
race tests do that). A guest managed by Proxmox HA starts through the HA
manager (`hastart`, line 177), which reaches the same `vm_start` later;
bb-box's guests are not HA-managed.

### 4. Hot-plug on the installed version

Method: a running test guest with no network was given `/dev/net/tun`, a
device that is not a GPU's, with `pct set --dev0`, then had it taken away
with `pct set --delete dev0`. After each, the script looked for the node
inside the guest and opened it.

| | In the guest | Config |
| --- | --- | --- |
| Before | absent | no `dev0` |
| After `pct set --dev0 /dev/net/tun` (409 ms) | present (`crw-rw---- root root 10, 200`), opens | `dev0` current |
| After `pct set --delete dev0` (390 ms) | still present, still opens | `dev0` current, its delete pending |
| After stop | | no `dev0` |

So on 6.1.14 adding a device to a running container is live: the node
appears and the device cgroup allows it at once. Taking one away is not:
the delete waits in the pending section until the guest stops, and the
running guest can go on opening the device until then.

This is what the note says in "What bb-box offers today", and why the
helper refuses any device change on a running guest, checks it inside the
lock, and refuses a guest with pending device changes. It also means a
card cannot be taken away from a running box: Resize to none and a move
need the box stopped, as section 8 says.

Limits: one device, on one running guest. The node had no mode given, so
it came as 0660 for root in the guest; bb-box's GPU lines set
`mode=0666`.

### 5. The longest description Proxmox keeps

Method: halving between 0 and 131,000 characters, setting a description
made of report-like lines through `pvesh set`, and reading it back whole,
on a QEMU VM that is never started (as the report VM is) and on a
container.

| Guest | Longest kept | One more |
| --- | --- | --- |
| QEMU VM | 8,192 characters (config file 8,917 bytes) | 400 "description: value may only be 8192 characters long" |
| LXC container | 8,192 characters (config file 8,893 bytes) | the same |

The cap is checked on the request, in characters, before anything is
written. The report must stay under 8,192 characters, the "Do not edit"
line included. At 75 to 110 characters a line, that is about 75 to 105
lines: two cards' `gpu` and `card` lines, the `helper` and `driver` lines,
one `holder` line per box with a card, and the answers. Section 5 keeps the
answers of the last 10 minutes and every refusal in force; unit 2 must
bound that, for example by dropping the oldest granted answers first and
naming that it did.

Limits: ASCII only; a description with other characters is encoded in the
config file and may count differently.

### 6. Each card's UUID, PCI address, minor and DRM nodes

Method: `nvidia-smi --query-gpu`, `Device Minor` in
`/proc/driver/nvidia/gpus/<pci>/information`, and `/dev/dri/by-path`, as
`gpu_lines` reads them. Read on the boot of 23 September 2026.

| nvidia-smi index | UUID | PCI address | Minor | DRM card | DRM render |
| --- | --- | --- | --- | --- | --- |
| 0 | `GPU-<uuid A>` | 0000:21:00.0 | 1 (`/dev/nvidia1`) | card2 | renderD129 |
| 1 | `GPU-<uuid B>` | 0000:d1:00.0 | 0 (`/dev/nvidia0`) | card1 | renderD128 |
| BMC VGA | | 0000:d5:00.0 | | card0 | none |

The other nodes: `nvidiactl` (195, 255), `nvidia-modeset` (195, 254),
`nvidia-uvm` (508, 0), `nvidia-uvm-tools` (508, 1), and `/dev/nvidia-caps`.

So on this node nvidia-smi's index does not follow the minor (index 0 is
`/dev/nvidia1`), and the BMC's VGA device takes `card0`, as section 5 warns.
Claims must name a card by UUID, and the helper must work out the nodes
from the UUID at each write.

Waits: the same reading after the owner's next reboot, made for other
reasons, to see whether the minors and DRM numbers move. The node has not
been rebooted for this; the reading is still open.

### 7. nvidia-smi in a guest given one card's nodes, and a guest without them

Method: two linked clones of step 8's test template with NVIDIA's userspace
580.142. One got the server device lines of the card at 0000:21:00.0
(index 0, minor 1): `/dev/nvidia1`, `nvidiactl`, `nvidia-uvm` and
`nvidia-uvm-tools`, all `mode=0666`. The other got no device lines. Both
were started, and the commands below ran inside them.

With one card's nodes:

- `nvidia-smi -L` lists one GPU, as `GPU 0`, with that card's UUID. The
  other card is not listed, and its index inside the guest is 0, not the
  host's.
- `nvidia-smi` shows that card alone: driver 580.142, CUDA 13.0, its PCI
  address, and the card-wide figures (77 MiB of 97,887 MiB used,
  temperature, power, use). The process rows were counted, not printed:
  one row, which the script could not tell apart from "No running
  processes found".
- `/proc/driver/nvidia/gpus` in the guest lists both cards' PCI
  addresses. The guest can see that the other card exists, not open it.
- `mknod` for the other card's minor is refused ("Operation not
  permitted"), as it is in every unprivileged container.

Without the nodes:

- No `/dev/nvidia*` and no `/dev/dri`.
- `nvidia-smi -L` fails: "NVIDIA-SMI has failed because it couldn't
  communicate with the NVIDIA driver".
- `mknod` for the card's minor and for `nvidiactl` is refused, so neither
  can be opened.

So on Proxmox LXC a box sees and opens only the card whose nodes its
config lists, which is what makes Whole a fence (section 5). A box with a
shared card sees the whole card's memory and use, which is what the
Monitor shows (section "What bb-box offers today").

Limits: one card, the server set of nodes, no DRM nodes. The desktop set
(`nvidia-modeset` and the DRM nodes) was not tried here; today's GPU
desktops already run on it. The fence is the kernel's device cgroup and
the user namespace, read from the result, not from the cgroup's rules.

### 8. NVIDIA's userspace in a Linux template, and a clone's time

Method: a test container from the stock Ubuntu 24.04 template, with
libglvnd and the Vulkan loader from apt, was made a template, and 5 linked
clones of it were timed with `pct clone` (2 of them started). The same was
then done with NVIDIA's userspace 580.142 installed, from the host's
artifact cache, with `customize-desktop.sh`'s flags. Disk used was read
with `df` inside the container, and the thin volume's data with `lvs`.

| | Without the userspace | With it |
| --- | --- | --- |
| Disk used in the container | 893 MB | 2,274 MB |
| Thin volume's data | 1,140 MB | 4,430 MB |
| `pct template` | 1,230 ms | 1,311 ms |
| Linked clone, 5 tries | 1,199 to 1,329 ms, median 1,217 | 1,189 to 1,769 ms, median 1,332 |
| Start, to `pct exec` answering | 389 and 408 ms | 398 and 407 ms |

- The userspace adds 1,381 MB to the template's disk. The largest files
  are `libnvidia-rtcore` (101 MB), `libcuda` (92 MB), `libnvidia-opencl`
  (86 MB), `libnvidia-nvvm` (75 MB) and `libnvidia-gpucomp` (69 MB). The
  installer ran in 6 s.
- The same install on a `linux` box of bb-box's own image (step 9) added
  1,001 MB between a reading taken with the 380 MB installer on its disk
  and one taken after it was deleted: the same 1,381 MB.
- A linked clone shares the template's blocks, so its time does not depend
  on what the template holds. The medians differ by 115 ms, within the
  spread of 5 tries. A start is the same.
- The thin volume holds 3,290 MB more, not 1,381 MB: the pushed installer
  and its unpacked files were deleted, but their blocks stay allocated on
  the thin pool until trimmed. `build.sh` does not trim before `pct
  template`, so a Linux template with the userspace carries about 2 GB of
  deleted blocks. It is once per template, as clones share them. Unit 7
  can run `pct fstrim` before `pct template`.
- The installer warns that it guessed the X library path, `/usr/lib64`,
  because there is no X server. On a `linux` template the X driver goes to
  `/usr/lib64/xorg/modules`, not `/usr/lib/xorg/modules`, where
  `customize-desktop.sh` checks for it. That check is for desktops only;
  unit 7's `build.sh linux` must not make it, and unit 10's install in a
  server must not expect it.

Limits: 5 clones each, on a node with the owner's boxes running; a stock
template, not bb-box's Linux template, whose disk is larger. Starts were
timed to `pct exec` answering; `systemctl is-system-running --wait` timed
out at 60 s in the stock template both ways, so it says nothing.

### 9. The helper's time from a marker to an answer

Method: a throwaway helper, a Perl loop using Proxmox's own modules as
section 5 says, ran on the node against three test guests: a stopped
container that is never started, a running container with no network, and
a QEMU VM with no disk that is never started, standing in for the report
VM. Each scan read every container config on the node (29) for its tags,
and acted only on the two test containers. On a new marker it took
`PVE::LXC::Config->lock_config`, checked that the guest was not running,
locked or holding pending device changes, worked out the card's nodes
from its UUID through `/proc/driver/nvidia/gpus`, replaced only the
`/dev/nvidia*` and `/dev/dri/*` lines with the server set (or removed them
for none), wrote the config, and wrote a `claim` line into the report VM's
description inside its own lock.

A driver wrote each marker inside `lock_config`, as bb-box's API call
would, then read the report VM's config file every 20 ms until its answer
appeared. The time is from the marker's write returning to the answer
being readable. Markers alternated shared (the card at index 0) and none,
with a random 0.1 to 0.9 s pause between tries, so they landed at every
point of the scan.

First, Proxmox's API (`pvesh set --tags`) takes markers as tags and reads
them back unchanged: `gpu.shared.<uuid>.g1`, `gpu.whole.<uuid>.g12` and
`gpu.none.g1`. One `pvesh set --tags` took 483 ms, most of it the process
starting.

| | Scan every 1 s | Scan every 0.2 s |
| --- | --- | --- |
| Marker to answer, 20 tries | min 40, median 344, p90 829, max 949, mean 410 ms | min 20, median 40, p90 142, max 203, mean 77 ms |
| Helper: scan start to answer written | 4.5 to 6.1 ms | 4.2 to 9.0 ms |
| Helper: the config write alone | 0.4 to 0.6 ms | 0.4 to 0.8 ms |
| One scan of 29 configs | mean 1.8 ms, worst 3.3 ms | mean 1.5 ms, worst 3.2 ms |
| Helper's CPU | 380 ms over 25 s, 1.5% of one core | 430 ms over 18 s, 2.3% of one core |
| Helper's memory (RSS) | 124 MB | 124 MB |

Every try was granted, and the guest kept its other line (`dev0:
/dev/null`) throughout.

- A refusal: shared asked for the running container was answered
  `refused running` in 101 ms, and no device line was written.
- A malformed marker (`gpu.shared.GPU-<uuid>.g42`, with the prefix and
  capitals) was answered `refused malformed`, and nothing changed.
- A timeout: with the helper stopped, the driver waited its 10 s and gave
  up at 10,016 ms, with no answer.
- The 38 other guests' configs on the node had the same SHA-256 before and
  after.

So the time is the scan's wait, not the work: the lock, the write and the
answer take about 5 ms. With a scan every second the worst was 949 ms, well
under section 5's 2 s target and its 10 s limit. A scan every 0.2 s costs
little more CPU and brings the worst to about 200 ms.

Limits: a throwaway, not the helper unit 2 builds. It watched two guests;
it read all 29 container configs each scan but parsed only their tags. It
did not run `nvidia-smi` each second, which the real helper will, and
which is likely its largest cost. The time excludes bb-box's own side: its
API call to write the marker and its interval for reading the report
through the API. The script as run
differs from the one written in one pipe (`awk 'NR == 1'` for `head -1`,
which `pipefail` had stopped).

### 9, continued. On a box with no card: browsers, Vulkan and EGL, with and without the userspace

Method: a `linux` box of bb-box's own image (Ubuntu 24.04.5, x86_64) on
Proxmox LXC, with no device lines, so no `/dev/nvidia*` and no `/dev/dri`.
Installed from apt: Mesa's EGL, GL and Vulkan drivers (llvmpipe and
lavapipe), `mesa-utils` (`eglinfo`), `vulkan-tools` (`vulkaninfo`);
Playwright 1.64.1 with its headless shell (Chromium build 1248) and Google
Chrome 156. Each probe ran first without NVIDIA's userspace, then again
after installing 580.142 with `customize-desktop.sh`'s flags. The probes:

- an EGL program (in C) that renders one pixel through a pbuffer, on the
  default display and on each device of `EGL_EXT_platform_device`, 3 runs;
- `eglinfo -B`, which tries the GBM, Wayland, X11, surfaceless and device
  platforms;
- `vulkaninfo --summary`, 3 runs, then 5 runs interleaved with only
  lavapipe's ICD;
- headless Chrome through Playwright, both the headless shell and Chrome's
  new headless, 5 launches each: a WebGL context, its renderer, one pixel
  drawn and read back, WebGL 2;
- one direct `google-chrome --headless=new` run, its log read for GL,
  EGL, Vulkan and GPU lines.

| Probe | Without the userspace | With it, no card |
| --- | --- | --- |
| EGL program, device platform | 1 device, Mesa llvmpipe, pixel right, 35 to 37 ms | the same: 1 device, Mesa llvmpipe, pixel right, 31 to 36 ms |
| EGL program, default display | fails (no display), both | fails (no display), both |
| `eglinfo -B` | exit 3: GBM, Wayland and X11 fail cleanly; surfaceless and device give llvmpipe | exit 139: a segmentation fault in the GBM platform, in `libnvidia-egl-gbm.so.1`, called from `libEGL_nvidia.so.0` |
| `eglinfo -B -p surfaceless` | llvmpipe | llvmpipe, exit 0 |
| `vulkaninfo --summary` | exit 0, llvmpipe, 41 ms | exit 0, llvmpipe, 140 to 156 ms, and "ERROR: [Loader Message] ... Could not get 'vkCreateInstance' via 'vk_icdGetInstanceProcAddr' for ICD libGLX_nvidia.so.0" |
| `vulkaninfo`, lavapipe's ICD only | | 24 to 26 ms |
| Headless shell (Playwright) | ANGLE on SwiftShader, pixel right, WebGL 2; 80 to 120 ms a launch | the same; 56 to 68 ms |
| Chrome, new headless | the same; 211 to 239 ms | the same; 134 to 145 ms |
| Chrome's own log | "drmGetDevices2() has not found any devices" | the same, nothing more |
| `nvidia-smi` | not installed | "couldn't communicate with the NVIDIA driver" |

So:

- **Headless Chrome and Playwright behave the same.** They use their own
  ANGLE and SwiftShader and never load NVIDIA's libraries. Their launches
  were no slower; the runs were not interleaved, so read that as "not
  slower", not as faster.
- **EGL through glvnd falls back to Mesa** on the device and surfaceless
  platforms, as a program that renders headless uses them.
- **EGL's GBM platform crashes** with the userspace and no card, where
  Mesa alone fails cleanly. NVIDIA's external platform
  (`/usr/share/egl/egl_external_platform.d/15_nvidia_gbm.json`) is tried
  first and crashes in `libnvidia-egl-gbm.so.1`. With only Mesa's
  vendor file (`__EGL_VENDOR_LIBRARY_FILENAMES`) `eglinfo` exits 3 again.
  A program that asks for GBM with no `/dev/dri`, as `eglinfo` does by
  default, fails either way, but with the userspace it dies instead of
  falling back.
- **Vulkan's loader logs an error** for NVIDIA's ICD and goes on to
  lavapipe. Each Vulkan instance takes about 100 ms more (41 ms to about
  150 ms).

Section 6 expects "the same on a `linux` box with the userspace and no card
as on one without". That holds for headless Chrome, Playwright and EGL's
device and surfaceless platforms. It does not hold for EGL's GBM platform,
which crashes, or for Vulkan, which logs an error and is slower.

Limits: one box, one image, one driver version. A server with a shared
card has the NVIDIA nodes but no DRM nodes (step 7's set), and was not
tried: the GBM crash may or may not happen there. Desktops with a card
were not tried here; they draw on the GPU today.

### 10. The one load: the GPU memory a CUDA context takes

Method: a test container with NVIDIA's userspace 580.142 and PyTorch
2.11.0 (CUDA 12.8 wheels, cuDNN 9.19) was given one card's server nodes at
a time. Before each card, and before each process, the card's free memory
was read card-wide; each went ahead only with at least 3 GiB free (the
1 GiB bound on the load and 2 GiB more). Two processes ran one after the
other on each card: cold, the first CUDA process since the container
started, and warm, the next. Each made a CUDA context (`torch.zeros(1,
device="cuda")`), held it 4 s, did one 1024 x 1024 matrix multiply in
float32, held 4 s and exited. The host read the card's `memory.used`
every 0.1 to 0.2 s, from 5 s before to 6 s after, and would have stopped
the process above the baseline's highest plus 1 GiB. Each figure below is
the median of 25 to 35 readings; on both cards every reading in a phase
was the same.

| Card | Run | Before | With the context | After the matmul | After exit | Import, first CUDA tensor |
| --- | --- | --- | --- | --- | --- | --- |
| index 0, 0000:21:00.0 | cold | 77 MiB | 725 MiB (+648) | 755 MiB (+678) | 77 MiB | 1,172 ms, 225 ms |
| index 0 | warm | 77 MiB | 725 MiB (+648) | 755 MiB (+678) | 77 MiB | 648 ms, 165 ms |
| index 1, 0000:d1:00.0 | cold | 150 MiB | 798 MiB (+648) | 828 MiB (+678) | 150 MiB | 1,141 ms, 393 ms |
| index 1 | warm | 150 MiB | 798 MiB (+648) | 828 MiB (+678) | 150 MiB | 893 ms, 173 ms |

- Driver 580.142 (CUDA 13.0 by `nvidia-smi`); PyTorch 2.11.0+cu128,
  CUDA 12.8; compute capability 12.0; `CUDA_MODULE_LOADING` left at its
  default (lazy). Persistence mode was off on both cards.
- A PyTorch CUDA context takes 648 MiB on these cards, cold or warm, on
  either card. The first matrix multiply adds 30 MiB, cuBLAS's handle and
  workspace: 678 MiB in all. PyTorch's own allocator held only 16 MiB
  allocated and 22 MiB reserved, so 626 MiB of it is the context itself,
  which `torch.cuda.memory_reserved()` does not show.
- Cold and warm differ in time, not memory: the import took 1.1 to 1.2 s
  cold and 0.6 to 0.9 s warm; the first tensor 225 to 393 ms cold and
  165 to 173 ms warm.
- Every reading after exit was back to the one before, so the memory went
  with the process.
- Each load was 10 to 10.6 s, one card at a time, and at most 678 MiB.

So section 3's default of 1024 MiB for a new server is a PyTorch context
and cuBLAS (678 MiB) with about 350 MiB left for a small model. A desktop's
384 MiB is less than a CUDA context: a desktop that also runs PyTorch needs
both.

Limits: both cards were idle when it ran (the owner's training had
finished), so the readings are clean; on a busy card the same delta would
be read against a moving baseline. One PyTorch version and one way of
making the context. A bare CUDA program, or another framework, takes a
different amount; NVIDIA's lazy loading keeps it lower until kernels load.
A larger matmul, cuDNN or NCCL would add more.

### What each measurement means for units 1 to 15

| Unit | What unit 0 found, and what it means |
| --- | --- |
| 1 | Nothing changes in core. The card's identity must stay the full UUID (step 6). |
| 2 | Test on pve-container 6.1.14, the version installed, not 6.0.4 (step 1). The helper's write inside `lock_config` is ordered with `pct start` and every API change (step 3). Refuse pending device changes: a delete on a running guest stays pending (step 4). Keep the report under 8,192 characters, and bound the answers it lists so it stays under (step 5). Proxmox takes the marker as a tag unchanged (step 9). A 1 s scan answers in under 1 s, the work about 5 ms (step 9). |
| 3 | `setup-gpu.sh` should record the pve-container version it was tested on: 6.1.14 here. |
| 4 | Nothing new. |
| 5 | Claims by UUID, and nodes worked out at each write, are needed on this node: index 0 is `/dev/nvidia1` and `card2`, and the BMC takes `card0` (step 6). A 10 s wait for an answer is about 10 times the worst seen with a 1 s scan (step 9). |
| 6 | Nothing new; rollbacks were not tried here. |
| 7 | A shared server sees only its card in `nvidia-smi -L`, as `GPU 0`, and the card-wide figures (step 7). The Linux template grows by 1,381 MB, and a linked clone's time does not change (step 8). Trim before `pct template`, or the template keeps about 2 GB of the installer's deleted blocks (step 8). Do not check `/usr/lib/xorg/modules` on a Linux template: with no X the installer puts the X driver in `/usr/lib64` (step 8). Before shipping the userspace in every Linux box, decide what to do about EGL's GBM crash and Vulkan's error and 100 ms (step 9). The gate's PyTorch matrix multiply takes 678 MiB, under its 1 GiB (step 10). |
| 8 | A guest without a card's nodes cannot open them or make them (step 7), so Whole fences on Proxmox LXC. |
| 9 | Its gate's "process that counts, under 256 MiB on the card" cannot be a PyTorch process: a PyTorch context alone takes 648 MiB (step 10). Use a bare CUDA program, measured first, or raise the bound. Removing or moving a card needs a stop: a running guest keeps a deleted device until it stops (step 4). |
| 10 | The install takes 6 to 7 s and 1,381 MB (steps 8 and 9), well inside "about 60 s more" and the 2 GiB free asked for. The X driver lands in `/usr/lib64` on a box without X (step 8). |
| 11 | Not measured here: no Docker host with a card. |
| 12 | Nothing new. |
| 13 and 14 | Nothing new. |
| 15 | The guide can say a PyTorch context takes about 650 MiB on these cards (step 10), and that a box with a shared card sees the whole card's memory and use (step 7). |

### Where it contradicts the note

- The note names pve-container 6.0.4 (section "What bb-box offers today",
  and the report's example). The node runs 6.1.14. What the note says of
  6.0.4 holds on 6.1.14: a live add, a removal that waits for the next
  start, `root@pam` alone for device lines.
- Section 6 expects a `linux` box with the userspace and no card to behave
  as one without it, for headless Chrome, Playwright, `vulkaninfo` and an
  EGL program. Chrome, Playwright and EGL's device and surfaceless
  platforms do. EGL's GBM platform crashes instead of failing, and
  `vulkaninfo` logs an error for NVIDIA's ICD and takes about 100 ms more.
- Unit 9's gate asks for a process under 256 MiB on the card; a PyTorch
  process cannot be one.

Nothing else measured contradicts it.

### Still open

- Step 6 after the owner's next reboot: whether the minors and DRM numbers
  move. Read it again with step 6's commands after that reboot, made for
  other reasons.
- EGL's GBM platform on a server that has a card's nodes but no DRM nodes.
- The real helper's cost with its `nvidia-smi` running each second (unit
  2).

## Unit 1: the size's GPU part in core

Built on main `0a7af761`. Nothing new is offered: no form, tool, CLI
option, setting or backend behaviour changes.

### What it adds

- `GpuPart` (`none`, `shared`, `whole`), `CardClaim` and `CardPlacement`
  in `src/backends/types.ts`. `BoxSize` is now cores, memory, disk and
  `gpu`. The three parts a backend reads from a guest, and the kinds'
  presets, are `MachineSize`, which was `BoxSize` before.
- `src/core/gpu.ts`: which kinds have a GPU part (`linux` and
  `linux-desktop`), their GPU when not asked for (`shared` for
  `linux-desktop`, `none` for every other kind), `linux-desktop-cpu` as
  a name for a `linux-desktop` with no GPU, and the refusal of
  `linux-desktop-cpu` or a kind with no GPU part asked for a card. The
  default can be changed per kind by a map the settings will give in
  unit 15; the configuration does not take it yet. `cardsOf` says how
  many cards a part holds, 0 or 1, so a count can grow from it.
- Records. A box's `size` keeps its `gpu`. `nvidiaUserspace` is on the
  record. It reads `unknown` until a later unit reads it, for a kind that
  can have a card (`linux-desktop-cpu` included, as Resize can give it
  one), and `none` for every other kind. A claim is the backend's, on the
  box's guest (`guest.claim`), as its host is.
- Reading old records. A record with no `gpu` reads `shared` when its
  kind is `linux-desktop` and its offer had a GPU, and `none` otherwise,
  as section 1 says. Reading writes nothing back. A record without a size
  reads the same way.
- Writing. A new box records the GPU its kind gets when not asked for,
  and `none` where its offer has no GPU, which is what it gets today. A
  fork records what its source's offer gives, as today (unit 6 makes
  forks `none`). A resize, a restore through bb-box or outside it, and
  the sweep finishing a resize cut short replace only the cores, memory
  and disk (`withRecordedGpu`): a record keeps its own `gpu`, and a record
  from before keeps having none. Nothing writes a guessed part into it.
- `sameSize` compares `gpu` too, so a box asked for none never takes a
  shared spare, and a change of GPU alone is a change, for units 7 and 9.
  `sameMachineSize` compares the three parts, for presets.
- Backends get `gpu` in the size of the box they make (`BoxIdentity`),
  and ignore it. Capacity, resize plans and resizes get the three parts,
  as before.
- Views. `bb box status --json`, `bb box list --json` and the panel's
  box view gain `gpuPart`, `claim` and `nvidiaUserspace`. Their text,
  `box_status` and `box_list`, does not change.
- The fake backend takes `cards` and `boxesPerCard`. It places a shared
  box on the card with the fewest boxes holding it, then the lowest index;
  a whole box on a card nobody holds; and refuses when no card can take
  it. A stopped shared box gives up its place and a stopped whole box
  keeps its card, as the owner answered. A stopped shared box starts on
  its last card while it has room, else on another card with a new
  generation, and is refused when no card has room. Claims name cards by
  UUID.

### What was run

- On a box, in a `node:26-bookworm` container as CI runs: `tsc` clean;
  the node suite, 3,025 passed and 0 failed of 3,320; vitest, 443
  passed. After the reviews' fixes: `tsc` clean; the node suite, 3,033
  passed and 0 failed of 3,328; vitest, 443 passed. On main before the change: `tsc` clean and the same node suite
  but for one test that needs a git checkout, which the first run lacked.
- Seven existing tests compared a record's size with three parts; they
  now expect `gpu: "none"` as well. Two tests compare what backends are
  given, and pass unchanged.
- New tests: `test/gpu.test.ts`, and three in `test/boxes.test.ts`: new
  boxes of each kind record their GPU part; old records, with and
  without a size, read as section 1 says through two restarts and are
  not written; a `linux-desktop` from an offer with no GPU reads `none`;
  a resize keeps the GPU part and gives the backend three parts; a claim
  from the fake backend's cards is in the record and the view.

### The live check

A fresh `npx bb-app@0.48.1` with no account, in a Linux box with Docker,
with bb-box installed from main. On main: Docker set up for boxes with
the Linux and desktop images; the `linux` kind's default preset and
largest disk changed, a `linux-desktop-cpu` preset changed; the most
boxes a thread may hold, enrolment off; Docker's `gpu-desktops` on,
`desktops-per-gpu` 2 and its memory kept free changed; a project with a
thread, and a project's image for `linux` and `linux-desktop-cpu`. Boxes
of `linux` (with the project's image, and with `standard`),
`linux-docker`, `linux-desktop-cpu`, one stopped. The host has no card,
so main refuses a `linux-desktop` box before it records one; a
`linux-desktop` record with a GPU offer was written into the store by
hand, as main writes one, with BB stopped. It reads as gone.

Then `bb plugin install` from the branch over main, without removing
it, and BB restarted twice. Before the upgrade and after the second
restart:

| Output | Same? |
| --- | --- |
| `bb box kinds`, text and JSON; the `kinds` RPC | yes |
| `bb box config show --json`; the settings page's `config.get` and `backends` RPCs | yes |
| `bb box option list`, `bb box image list` | yes |
| `bb box list` and `bb box status` text, every box | yes |
| `bb box status --json` and `bb box list --json` | only `gpuPart`, `claim` and `nvidiaUserspace` added, and `reach.lastAnswered`, a time that moves between captures on main too |
| Every stored box record and the configuration, in BB's store | byte for byte |

Every box read as section 1 says: the `linux-desktop` record `shared`;
`linux`, `linux-docker` and `linux-desktop-cpu` boxes `none`; all with
no claim and userspace `unknown`. After the restarts, new `linux`,
`linux-docker` and `linux-desktop-cpu` boxes recorded `gpu: "none"`, a
`linux-desktop` was refused with main's words, the stopped old box
started, and a live resize of an old `linux-desktop-cpu` box kept `none`.
That first build recorded the guessed `none` on the resize; after the
reviews a resize writes no part into a record from before (see "After
the reviews"). The upgrade path did not change, so the live check was not
repeated.

Limits: no card, so the `shared` case was a record written by hand, and
no claim was seen live; the fake backend's cards are tested only in the
suites. `box_list`'s and `box_status`'s tool text was compared through
the CLI's text, which the tools share, not through an agent.

### Deviations from the note

- `BoxSize` gains `gpu`, as section 1 says; what backends read from a
  guest and the kinds' presets are named `MachineSize`, as they have no
  GPU part.
- A claim is on the box's guest, not beside it on the record, as the
  claim is the backend's (section 1).
- `linux-desktop-cpu` boxes keep their kind ID, and `box_list` does not
  yet say "also `linux-desktop-cpu`", so that nothing offered changes.
  Core knows the name and refuses it with a GPU; the tools take `gpu` in
  unit 7.

### After the reviews

Two reviews said to merge after fixes. Each fix has a test that failed on
the first build and passes now, run on a box:

| Finding | Fix | Test |
| --- | --- | --- |
| A restore, through bb-box or outside it, dropped the record's `gpu` | Both replace only the cores, memory and disk, through `withRecordedGpu` | `test/gpu-records.test.ts`: a `whole` record and one from before, restored each way |
| Resize, and the sweep finishing a resize cut short by an upgrade, wrote a guessed `gpu` into a record from before | The same helper, for the size and the resize's `from` and `to` | `test/gpu-records.test.ts`, an interrupted upgrade among them; `test/boxes.test.ts` |
| The fake backend started a stopped shared box on a card now held whole | It starts it on its last card while that has room, else on another with a new generation, else refuses | `test/gpu.test.ts`, on one card and on two |
| `sameSize` ignored `gpu` | It compares `gpu`; `sameMachineSize` compares the rest | `test/gpu.test.ts` |
| NVIDIA's userspace read `unknown` for kinds that will never have a card | It reads `none` there | `test/gpu.test.ts` |

Three vitest tests of 070's dialogs failed in the first 2 hours after
midnight, on main as on this branch, as their words say "today" or
"yesterday" of times set relative to the wall clock; a fourth, the fork's
fact, failed in the first minute. A second commit sets each one's clock to
noon local time on a fixed day. Full vitest runs, 443 passed each: under
`TZ=UTC` with the clock faked to 00:30 UTC by libfaketime (on the first
commit, the three failed), and under the default time zone at 00:09 UTC.
At 00:00:30 UTC, faked, the four failed before and pass now, as they do
under `TZ=Pacific/Kiritimati`.

## Unit 2: the host's GPU helper, dry run

Built on main `a0420ab3`. The helper is `setup/proxmox-lxc/host/bb-box-gpu`,
a Perl program on Proxmox's own modules, with `bb-box-gpu.service`,
`bb-box-gpu-boot.service` and `setup-gpu.sh`. This unit installs it with
writes off only: both units run it with `--dry-run`, so it writes the report
and logs each change it would make to a guest's device lines, and changes no
guest, whatever `gpu.conf` says. Nothing in bb-box reads its new lines yet.

### What it does

- **What it reads.** Once a second: every container config on the node,
  through `PVE::LXC::Config->load_config`; which containers run, from one
  `PVE::LXC::list_active_containers` call; the pools in
  `/etc/pve/user.cfg`; and its own settings, `/etc/bb-box/gpu.conf`
  (`pools ...` and `writes on|off`). The cards come from one
  `nvidia-smi --query-gpu=... -l 1` that runs on beside it. Each card's
  minor comes from `/proc/driver/nvidia/gpus/<pci>/information` and its DRM
  nodes from `/dev/dri/by-path`, read again from the card's UUID inside the
  lock before any write.
- **What it acts on.** A guest is written only if it is unprivileged, not a
  template, in a pool `gpu.conf` lists, has a description naming a bb-box
  install, and carries exactly one well-formed marker, or the helper has
  granted it a claim before. Every other guest with a `gpu.` tag gets one
  refusal: `not-served`, `privileged`, `template`, `not-bb-box` or
  `malformed`. An unmarked guest is never written, and still counts as
  holding the cards its lines name: `devN` lines, raw
  `lxc.mount.entry` lines and `lxc.cgroup2.devices.allow` rules, current
  and pending.
- **The marker.** `gpu.none.gN`, `gpu.shared.<uuid>.gN` or
  `gpu.whole.<uuid>.gN`, the UUID in lower case without `GPU-`, N from 1
  with no leading zero and at most 9 digits. Any other tag that starts
  `gpu.`, in any case, or two of them, is `malformed`. A UUID the helper did
  not list is `unknown-card`.
- **How it writes.** With writes on, inside
  `PVE::LXC::Config->lock_config_full`, with a 2 s wait: load the config, check the marker is still the one asked,
  refuse `locked` or `pending` (a device line or a device delete in the
  pending section), work out the card's nodes now, refuse `running` if the
  lines would change, replace only the current section's `devN` lines that
  name `/dev/nvidia*` or `/dev/dri/*`, write, then the ledger, then the
  answer. A server gets the card's `/dev/nvidiaN`, `nvidiactl`,
  `nvidia-uvm` and `nvidia-uvm-tools`; a desktop (`kind.linux-desktop*`,
  or a warm desktop) also `nvidia-modeset` and the card's render and card
  nodes, in `build.sh`'s order, each `mode=0666`. Raw `lxc.*` lines, other
  device lines (`/dev/net/tun`), the pending section and snapshot sections
  stay as they are. With writes off it takes no guest's config lock at
  all: it decides from a fresh read of the config, and the write is the step
  not taken. That is logged once to the journal ("would write CT 214 for
  request g3: remove ...; add ...") and listed in the report as a `would`
  line, and the request stays unanswered. Nothing is logged while any lock
  is held, Proxmox's or the helper's own: lines wait until the last lock is
  let go, so a stalled journal never holds a lock.
- **The helper decides.** Requests are taken one at a time, under a lock
  file the service, the boot pass and `--once` share. It refuses whole on a
  card another guest has the devices of (`card-held`), other than stopped
  shared boxes it manages, which yield; shared or whole on a card another
  guest holds whole (`whole-taken`); a device change on a running guest; and
  a claim for a box another guest holds (`copy`). Running guests are asked
  first, then guests whose hostname is their box's name, so a copy in its
  re-arm window never wins its source's claim in the same pass.
- **Yielding.** The yielding guest's ledger entry says `yielded` before its
  lines come out, so a crash between the two never leaves the ledger
  claiming a card the guest lost. A yielded box is not given its lines back.
- **The ledger.** `/var/lib/bb-box-gpu/ledger`, JSON, root's, written whole
  through a temporary file, `fsync` and `rename`. Per guest, by VMID: the box
  its description names, the highest generation answered, the claim
  (generation, part, card, `granted` or `yielded`) and, for a copy, that its
  lines come out. The answers of the last 10 minutes and every refusal in
  force, 300 at most. With writes off, nothing it would carry out with
  writes on is stored: a copy's or a conflict's lines coming out are kept
  apart, as a proposal, no yield is recorded, and a whole grant that waits
  on other boxes' lines coming out is left to its request. When writes are
  first on, claims granted with writes off stand, and every request refused
  or left waiting with writes off is decided again.
- **Each generation is answered once.** A generation at or below the one
  answered is never decided again, refused or granted. A stopped guest whose
  lines differ from its granted claim, after a rollback or a hand edit, gets
  the claim's lines back; a running one is reported as a `mismatch`.
- **A lost or unreadable ledger** is rebuilt from the guests on the next
  pass; an unreadable one is moved aside first. A marked guest whose lines
  match its marker is granted. Two guests naming one box: the running one,
  then the one named as its box, keeps it, and the others are refused
  `copy` and lose their lines. Any other guest of the box whose answered
  generation is the same or higher counts as the source, granted or not. A whole claim with another guest on its card:
  stopped shared boxes yield; otherwise the running guest keeps its lines,
  the stopped whole box loses them, and the whole claim is not granted. A
  marked guest whose lines do not match is refused `ledger-lost` and waits
  for bb-box's next request. A ledger from a newer protocol stops all
  decisions and says so in the report.
- **The boot pass**, `bb-box-gpu --boot --dry-run`, from
  `bb-box-gpu-boot.service` (`Before=pve-guests.service`, wanted by it, at
  most 45 s), puts each claimed guest's
  lines right from its card's UUID now, and takes out the lines of a card
  nvidia-smi does not list. It answers no request and writes no report.
  With no ledger at boot, a marked guest whose lines do not match its marker
  loses its lines, so it starts with no card rather than perhaps the wrong
  one.
- **The report** keeps today's header style, `at` and `gpu` lines first, so
  today's bb-box reads it unchanged. New lines:

  ```text
  helper bb-box-gpu 0.1.0 protocol 1 writes off pve-container 6.1.14 tested
  serves bbbox
  driver 580.142 since 1793450000
  card <uuid> pci 0000:21:00.0 minor 1 drm card2 renderD129
  remapped <uuid> was minor 0 drm card1 renderD128
  error <why>
  holder <uuid> <vmid> <shared|whole> <running|stopped> <install <id>|other> <managed|unmanaged>
  mismatch <vmid> <uuid|none>
  would <vmid> lines <uuid> <server|desktop>|lines none for <request gN|claim gN|copy of <vmid>|yield to <vmid> gN>
  claim <vmid> g<N> granted <part> [<uuid>]
  claim <vmid> g<N> refused <reason> <uuid|none|-> [<vmid or lock>]
  claim <vmid> g<N> yielded <uuid> <vmid>
  omitted <n> refusals in force, <n> answers
  ```

  It is written directly with `PVE::QemuConfig`'s lock, load and write, as
  unit 0's throwaway did: within about a second of any change but memory,
  at most every 15 s for a card's free memory moving a 64 MiB step, at least
  once a minute, and at once when its `at` is ahead of the clock. It stays
  under 8,000 characters whatever the settings say: the `serves` line and
  each required line at most 300 characters, at most 6 `error` lines and a
  count of the rest, then holders, mismatches, `would` lines, refusals in
  force and the newest answers, an `omitted` line when some do not fit, and
  a last cut to 8,000. `remapped` shows when a card's minor or DRM nodes
  differ from the last boot's, by boot ID. If a pass cannot finish, for
  example as the ledger cannot be saved, the report is still written, with
  an `error` line saying why, and `--once` exits 1.
- **When the node's container configs cannot be read**, as with
  pve-cluster stopped, a pass decides nothing, drops no claim and writes no
  report, so the report goes stale rather than show cards with no holders.
  If the list of running containers cannot be read, each is asked on its
  own.
- **When nvidia-smi fails**, the report has `at` and no `gpu` or `card`
  lines, and an `error` line; a shared or whole request is refused
  `no-cards`; lines already written stay. The service waits up to 10 s for
  nvidia-smi's first reading before its first pass. An `nvidia-smi` that
  gives no line for 30 s is sent TERM, then KILL 2 s later, and started
  again. The helper never waits on it: it reads a pipe of its own and reaps
  the process without blocking, so a stuck `nvidia-smi` delays neither a
  pass nor a stop. A one-off reading, as the boot pass takes, gives up
  after 15 s.
- **Time.** Passes, the watchdog and the hourly line run on the monotonic
  clock, so a clock stepped back or forward stops nothing. The report's
  `at` and the ledger's times are the wall clock's.
- **Writes are on** only when the helper runs without `--dry-run`, and
  `gpu.conf` says so, is owned by the helper's user and writable by no one
  else, and `dpkg-query` gives a pve-container version this release was
  tested on (6.1.14, from unit 0). Otherwise the report says why. The units
  this release installs run it with `--dry-run`.
- **Cost.** Once an hour, and when it stops, the service logs its passes'
  mean and worst time, how often it wrote the report and why (a change,
  memory alone, a heartbeat, a clock step), its own and nvidia-smi's CPU,
  and how often it started nvidia-smi. It exits when pve-container's version changes, so
  systemd starts it on the new modules.
- **`setup-gpu.sh`** installs the program and both units, writes
  `gpu.conf` with the pools already there and this install's, and
  `writes off`, makes the ledger's folder, and starts the helper. Only once
  the helper has written a fresh report (its `helper` line with writes off,
  and an `at` no older than the start) does it stop, disable and remove
  `bb-box-gpu-memory.timer` and its service, then wait for the helper's
  report again. If the report does not come within 30 s, or the timer
  cannot be stopped, it stops and disables the helper, keeps or puts back
  the timer, and exits 1. It prints each change, and "nothing changed" on a
  second run. `--remove` stops and removes the helper and its units, and
  always puts back the timer from the same folder, driver loaded or not. It
  keeps `gpu.conf` and the ledger and changes no guest.
  `setup-gpu-report.sh` no longer puts the timer back where the helper is
  installed, and the setup guide says the helper replaces the timer, and to
  stop it before a driver update or a card reset, as its `nvidia-smi` keeps
  NVIDIA's module in use.

### What was run

On a `linux` box, in a `node:26-bookworm` container as CI runs (Perl 5.36;
the node has 5.40):

- `test/gpu-helper.test.ts`: 31 tests, on fake Proxmox modules
  (`test/gpu-helper/PVE`) that take a real `flock` per guest, refuse a write
  made without the guest's lock, log every lock and write, can trace each
  lock to the output, refuse a write when asked, and can end the process
  just after a write. The node is unit 0's: index 0 is `/dev/nvidia1` and
  `card2`, and the BMC takes `card0`.
  - Section 14: guests outside the pools, privileged, a template, running,
    locked, with pending device lines or a pending device delete, malformed
    markers (`GPU-` prefix and capitals, `g0`, `g01`, `GPU.`), two markers,
    not bb-box's, an unknown card, and unmarked guests with NVIDIA lines:
    each config byte for byte as it was, each answered once over two passes.
  - Writes off: a request, a yield, a copy's lines, a rollback, a lost
    ledger's conflicts and the boot pass each logged and reported as a
    write it would make; no guest written; requests that need no write
    granted.
  - The gate's cases: two requests racing for one card, whole and whole,
    whole and shared, from two helpers started at once: one granted, one
    refused, one write. A start holding the guest's config lock while the
    helper waits for it: refused `running`, nothing written. A lost ledger,
    and an unreadable one. A write cut short after the config and before the
    ledger: granted on the next pass with no second write. A rollback to an
    older marker and another card's lines, locked and then not, and to a
    config with no marker: the claim's lines put back. A copy naming another
    box, stopped and running; a held copy's `gpu.none`; a swap.
  - Also: only NVIDIA and DRM lines replaced, part-only changes live,
    yields, the boot pass after the cards' numbers move and with a card
    missing, the report against today's `parseGpuReport` and under
    8,000 characters with 60 holders and 120 refusals, nvidia-smi failing,
    the node's configs unreadable, a newer ledger, `--help`, and the
    service: an answer in under 2.5 s,
    a `would` logged once over several passes, the report following a
    64 MiB step, and a clean stop that ends nvidia-smi.
- `test/proxmox-lxc.test.ts`: today's backend given the helper's report:
  `proxmox.gpu-report` passes ("The host reports 2 GPUs in VM 9190, written
  just now.") and both GPUs' room comes from the host.
- `test/gpu-setup.test.ts`: 4 tests of `setup-gpu.sh` and
  `setup-gpu-report.sh` under a temporary root (`BBBOX_ROOT`), as root as CI
  runs, with a fake `systemctl` that runs each unit's own `ExecStart`, so the
  helper runs as installed, with `--dry-run`. See "After the reviews".

### The live day

Waits for the lead: install with `setup-gpu.sh` on the node, a day with
writes off, every guest's config SHA-256 before and after, and today's
bb-box reading the report throughout.

### Deviations from the note

- Version 0.1.0, not the note's 1.0.0, as this release has never written a
  guest on the node.
- The ledger is kept per guest, by VMID, with the box it names, not per box.
  "One guest per box" is the copy rule. A guest whose description comes to
  name another box starts again with no claim, so a fork re-armed as its own
  box, or a reused VMID, is never taken for its old box.
- With writes off, a request that needs no write is granted and recorded,
  and one that needs a write is left unanswered with a `would` line. The note
  does not say which. Unit 4's marking relies on the first: today's desktops'
  lines already match their markers.
- A lost ledger refuses, as `ledger-lost`, a marked guest whose lines do not
  match, rather than deciding its request again; at boot that guest also
  loses its lines.
- Outside the boot pass too, a stopped claimed guest whose card nvidia-smi
  no longer lists loses its NVIDIA lines.
- The report has more line types than the note's example, listed above, and
  `holder` lines say running or stopped and managed or not. Holders leave
  out templates, held copies and earlier guests, as section 3's table says.
- With writes on, a guest's config lock is waited for 2 s, not Proxmox's 10,
  so a held lock delays a pass by at most 2 s; the request is tried on the
  next pass. With writes off no guest lock is taken at all.
- Memory alone writes the report at most every 15 s, not within a second,
  so it is written about as often as the timer wrote it.
- `setup-gpu.sh` does only an install with writes off and `--remove`. Unit 3
  adds `--pool`, `--writes`, upgrade, `--downgrade` and the version checks.

### After the reviews

Two reviews, Opus and Astra, said to install for the day only after fixes.
Each fix has a test, and each of these tests failed when run against the
first build's host scripts (`0203459b`), on a box:

| Finding | Fix | Test, and how it failed before |
| --- | --- | --- |
| Astra 1: with writes off it took a guest's config lock, and logged while holding it | No guest lock with writes off: a fresh read decides. No line is logged while any lock is held | A dry pass took 2,050 ms while another process held the guest's lock, and did not report its `would` line. With the lock traced to the output, nothing may be logged between locked and unlocked |
| Astra 2, Opus 1: the installer retired the timer first, and took an old `helper` line as success | Start the helper, wait for a report of its own (`at` no older than the start), then retire the timer; else stop the helper, keep the timer, exit 1. A timer that cannot be stopped stops the helper too | Three tests in `test/gpu-setup.test.ts`: the order of `systemctl` calls, a helper that cannot write the report, a timer that cannot be stopped. The first build's script cannot run under a test root, so they failed on that; both reviews reproduced the defects with fake systemd |
| Astra 3: `--remove` left no timer when the driver was unloaded | The timer is always put back; a failed first run is said apart | `--remove` with `/proc/driver/nvidia` gone |
| Astra 4, Opus 3: a stalled `nvidia-smi` was never restarted, and a blocking close could hang a pass, a stop or the boot pass | A pipe of its own, TERM then KILL after 2 s, reaped without blocking; restarted after 30 s with no line; the one-off reading gives up after 15 s; the boot unit's timeout is 45 s | A one-off pass with a silent `nvidia-smi` that ignores TERM hung until the test's 60 s limit; it now exits 17.1 s after the reading begins. The service probe below |
| Opus 2: memory moving about a step wrote the report every second | Memory alone at most every 15 s; anything else at once; the hourly line counts writes by cause | Memory changed twice within 15 s wrote the report twice; now once |
| Astra 5, Opus 6: with writes off, recovery stored strips, yields and whole grants that writes on would carry out | Kept apart as proposals, never carried out; the first pass with writes on decides afresh | The ledger held a strip, a yield and a whole grant. Now a copy whose source went away before writes were on keeps its card |
| Astra 6: 400 pools made a 17,812-character report | Each required line at most 300 characters, at most 6 errors, a last cut to 8,000 | The same settings now give a report under 8,000 |
| Opus 4: a ledger that could not be saved left no report | The decisions run in their own `eval`; the report is written with an `error` line, and `--once` exits 1 | No report was written; now it is, naming `ledger.new` |
| Opus 5: writes off rested on a settings file alone | `--dry-run`, in both units, keeps writes off whatever `gpu.conf` says | `--dry-run` was refused as unknown |
| Opus 7: a copy of a box whose request was refused could be granted a card | Any other guest of the box with the same or a higher answered generation is the source | The copy was granted a whole card |
| Opus 8: passes ran on the wall clock | The monotonic clock; a report whose `at` is ahead of the clock is written again | With the clock stepped back an hour by libfaketime, no pass ran and nothing was answered; now an answer comes within 5 s. CI now installs `faketime` |
| Opus 10: `setup-gpu-report.sh` put the timer back beside the helper; existing pools lost this install's | It leaves the timer off where the helper is installed; the pool is added; the guide says so | `setup-gpu-report.sh` after the install |

The four service probes from Opus's review, run at once on four fake nodes
for 67 s, on a box, with what each measured:

| Probe | First build, as Opus measured it | Now |
| --- | --- | --- |
| A. `nvidia-smi` prints once, then stalls, ignoring TERM | started once in 16 s; no `gpu` lines while it blocks | started again 30.8 s after the service started; the service stops 2.1 s after SIGTERM |
| B. a card's free memory moves 4 MiB either side of a 64 MiB step every 1.1 s | 19 report writes in 20 s | 1 report write in 19.8 s |
| C. the ledger cannot be saved | no report in 5 s | a report naming `ledger.new` after 1.8 s |
| D. nothing changes | 1 report write in 65 s | 2 in 65 s: the first and the heartbeat |

A one-off pass with a silent `nvidia-smi` that ignores TERM exits 17.1 s
after the reading begins: the 15 s wait, TERM, and KILL 2 s later. Limits: a
fake node on a box, not Proxmox.

**CI failed that test once**, at 20,051 ms against a bound of 20 s on the
whole run. Measured on a box with all 8 cores busy (load average 45 to 71),
10 runs each, with the fake `nvidia-smi` stamping its start:

| | Start to `nvidia-smi` | `nvidia-smi` to exit | Exit to output closed | In all |
| --- | --- | --- | --- | --- |
| The fake as it was | 34 to 81 ms | 17,075 to 17,117 ms | 0 to 1,601 ms; over 900 ms in 7 runs | 17,117 to 18,780 ms |
| The fake fixed | 52 to 83 ms | 17,073 to 17,106 ms | 0 ms | 17,137 to 17,178 ms |

The helper keeps to its design: 15 s, then 2 s to KILL. Nothing in it waits
on the child, and it takes one reading. The rest was the test's: its fake
stalled in a loop of `sleep 1`, so KILL ended the shell but left a `sleep`
holding the helper's output open for up to a second, and the test waited
for that output to close. Its bound also counted the time before the
reading began, which on CI, with the whole suite running, is longer than
on an idle box. The fake now stalls with `exec sleep`, so KILL ends it, and
the test reads the reading's wait and the wait to KILL from the helper's own
constants: it bounds the time from the reading's start to the helper's exit
at 15 s plus 2 s plus 1.5 s, the time for its output to close after it exits
at 0.5 s, and the whole run at 30 s. With all cores busy it passed 10 times
in 10, at 17,087 to 17,100 ms from the reading to the exit and 0 ms from the
exit to the output closing.

### Still open

- The doctor's fix for an old report still names `bb-box-gpu-memory.timer`
  (unit 3 changes the doctor).
- `nvidia-smi -l 1` keeps a client open on the driver all the time, as
  agreed. With persistence mode off, as on this node, that keeps the cards'
  driver state set up between the timer's old 15 s runs, and NVIDIA's module
  cannot be unloaded, nor a card reset, while the helper runs. The setup
  guide says to stop it first. Its CPU on the node is read from the hourly
  line on the day.

## Unit 3: setup-gpu.sh in full, and the doctor's helper check

Built on main `8ba2d1b1`, and after the reviews rebased onto `e7d934f9`.
The helper program and its two units are not
changed: `bb-box-gpu` stays 0.1.0, byte for byte, so unit 2's day of dry run
holds for the program that stays installed. Nothing new is offered.

### What it does

- **Options.** `setup-gpu.sh [--pool <name>]... [--writes off]
  [--downgrade]` installs or upgrades; `setup-gpu.sh --remove` removes.
  `--pool` adds a pool to those `gpu.conf` lists and `BBBOX_POOL`, and may
  be given more than once. A name that cannot be a pool's is refused before
  anything changes; a pool not yet in `/etc/pve/user.cfg` is said.
  `--writes off` is taken. `--writes on` is refused, with words, before
  anything changes: this release runs the helper with writes off only, as
  the lead agreed. `gpu.conf` is always written `writes off`; one that said
  `writes on` is rewritten, and the run says so.
- **Install** is as unit 2's: the program, both units, `gpu.conf` root's
  alone, the ledger's folder, then the helper started, and the timer
  retired only once the helper has written a fresh report.
- **Upgrade** is running a newer release's `setup-gpu.sh`. It replaces the
  program and units it finds different, restarts the helper and waits for
  a fresh report naming the new version with writes off. It keeps
  `gpu.conf`, the ledger and writes off, and touches no guest. It says
  "restarted bb-box-gpu.service on 0.1.1, which was 0.1.0".
- **A failed upgrade** puts the helper before it back as it was: its
  program, units and `gpu.conf`, and its ledger where the new helper wrote
  one under a newer protocol, keeping that one beside as
  `ledger.from-<version>-<time>`. It waits for that helper's fresh, healthy
  report and exits 1. Only if that helper writes no such report either is
  the report handed to the timer, as a failed first install is.
- **The timer first.** Before any run stops the helper, the timer is
  running: a writer of the report is there whatever happens next, even a
  SIGKILL. An upgrade retires the timer again once the new helper reports.
- **The install from before** is copied to
  `/var/lib/bb-box-gpu/setup-backup`, on disk and synced, before anything
  changes: the program, units, `gpu.conf`, the ledger (copied again once the
  old helper has stopped), its version and protocol, and whether the timer
  was there. It is removed when the run ends settled. A run that finds one
  left by a run that did not finish uses it for its rollback, and restarts
  the helper unless a fresh report already names this release's version.
- **An interruption or failure part way** (Ctrl-C, TERM, a dropped SSH
  session, a `set -e` exit): an EXIT trap, with INT, TERM and HUP made
  exits, keeps a writer running, starting the timer, or else the helper, if
  neither runs, and says which writes the report and where the install
  from before is kept. Files are put in place by rename.
- **The version checks.** The installer reads both programs' versions
  with `bb-box-gpu --version`, and the ledger's protocol with JSON::PP. It
  refuses, changing nothing, an older release over a newer helper, and a
  ledger written by a newer protocol than the release's, unless given
  `--downgrade`. With it, a newer ledger is moved aside, as
  `ledger.protocol-<n>-<time>`, once the newer helper has stopped, and the
  older helper rebuilds the ledger from the guests, as for a lost ledger.
  If the newer helper's stop fails, or says it failed, the run rolls back:
  every file is put back and that helper runs again.
- **pve-container.** The report's `helper` line says `tested` or
  `untested`. The installer prints that line and the `serves` line, and on
  an untested version says that the helper would change no guest there
  even with writes on.
- **A fresh, healthy report** is one read in one snapshot, naming the
  expected version and protocol with writes off, with an `at` no older than
  the helper's start, different from the report as it stood once the old
  helper had stopped, and with no `error` line saying the ledger is from a
  newer protocol, a pass could not finish, or the helper's state cannot be
  written. A report from the same second as the start is not taken as
  fresh.
- **systemd's start limit.** Before each start of the helper and of the
  timer's service, the installer runs `systemctl reset-failed`, so runs
  close together, as reruns after an interruption are, are not refused as
  starting too often.
- **The wait** is 75 s, not 30. The helper writes its report when it has
  something new and at least once a minute, so a helper started again with
  nothing new writes on its next minute. Unit 2's installer, given a helper
  stopped by hand, waited 30 s, took it as failed and handed the report to
  the timer: seen under real systemd, below. The wait is read from
  `BBBOX_GPU_REPORT_WAIT` in the process's environment only, never from
  `bb-box.env`, and must be 1 to 9999 s.
- **Removal** starts the timer and waits for its service to write the
  report before it stops the helper. If the timer cannot start or write, as
  when `nvidia-smi` fails, the helper is left running and nothing is
  removed. After the helper stops, the timer writes once more, so no
  stopped helper's lines are left in the report; a handover does the same.
  It keeps `gpu.conf` and the ledger, and changes no guest.
- **The doctor's `proxmox.gpu-helper`**, where the report VM's notes have
  a `helper` line, in this order:

  | Finds | Status | Fix |
  | --- | --- | --- |
  | a report dated a minute or more ahead of BB's clock | fail | `systemctl status bb-box-gpu`, and the host's clock |
  | no report, or one 3 minutes old or more | fail | the same |
  | a newer protocol | fail | "Update BB Box." |
  | an older protocol | fail | "Run host/setup-gpu.sh again, from this BB Box's setup guide" |
  | a `helper` line it cannot read, its protocol included | fail | the same |
  | this install's pool not served | fail | `host/setup-gpu.sh --pool <pool>` |
  | the pool not among those listed, with more not listed | warn | the same |
  | an untested pve-container | fail | `setup-gpu.sh` from a release tested on it |
  | writes off | warn | "Nothing to do now: a later BB Box release turns writes on" |
  | all of these met | ok | none |

  bb-box speaks protocol 1. The line is read by its protocol's grammar:
  for another protocol only the version and the protocol are read.
- **No helper, no check.** Decided with the lead: until unit 7 offers
  servers with a GPU, a node with no helper has no `proxmox.gpu-helper`
  check at all, so a node with today's GPU desktops reads exactly as
  before. The check is read with the GPU report, so only an install with
  GPU desktop templates has it.
- **`proxmox.gpu-report`'s fix** names `bb-box-gpu` when the report it
  finds old is the helper's, and `bb-box-gpu-memory.timer` when it is the
  timer's, which closes unit 2's open item. With no helper line, every
  word of the check is as before.
- The setup guide has a section on the helper: install, upgrade,
  `--downgrade`, `--remove`, the 75 s wait, and the doctor's check.

### What was run

On a `linux` box, in a `node:26-bookworm` container as CI runs (Perl 5.36),
after the reviews' fixes:

- `test/gpu-setup.test.ts`: 30 tests of `setup-gpu.sh` under a test root
  with fake `systemctl`, as root, the helper running as installed. Every
  test that installs checks every guest's config byte for byte, and that no
  guest was written or locked. Install, a second run, `--pool`,
  `--writes on` refused with no `systemctl` call, upgrade, an older release
  refused then `--downgrade`, a newer ledger refused then set aside, a
  failed upgrade rolled back, a failed rollback handed to the timer, an
  untested pve-container, a helper stopped by hand waited for across its
  heartbeat (60.5 s), removal and putting back. Then each review finding:
  see "After the reviews". The fake `systemctl` can signal its caller
  right after a given call, fail after doing a call, fail the n-th of a
  call, and refuse starts past a start limit. Release copies differ from
  the release in constants only: `VERSION`, `PROTOCOL`,
  `REPORT_BEAT_SECONDS` (2 s where a restart must not wait a minute), and a
  report VM name that does not exist, to make a helper that writes no
  report.
- `test/proxmox-lxc.test.ts`: 6 tests of the doctor. On reports from real
  helper runs: a dry run, `--dry-run` with `writes on` in `gpu.conf`, writes
  on, an untested pve-container, other pools, no pool. On edited lines: 2
  min 59 s and 3 min old, dated 30 s, 60 s and a day ahead, a 10 minute old
  report's fix, protocols 2 and 0, a protocol it cannot read, a line it
  cannot read, a cut pool list. No check beside the timer's report, with no
  report VM, or without GPU desktops, and the timer's words as before. The
  parser alone.
- `shellcheck -x` on `setup-gpu.sh` and the fake `systemctl`: clean.
- `tsc` clean; the node suite, 3,493 tests, 3,198 passed, 0 failed, 295
  skipped; vitest, 445 passed.

Under real systemd, in a `debian:trixie` container with systemd 257 as its
first process and Perl 5.40.1, as Proxmox VE 9 has, privileged, on the
same box. The Proxmox modules were unit 2's fakes, installed in Perl's
path; `nvidia-smi`, `qm` and `dpkg-query` were fakes; `/proc/driver` was a
tmpfs holding unit 0's two cards. The starting state was the node's: the
timer from `setup-gpu-report.sh`, then unit 2's own `setup-gpu.sh`.

- The node steps, as the lead will run them, with the check script: all
  printed what the steps say. The guests' configs did not change, the
  ledger's fingerprint stayed the same throughout, and the node ended on
  unit 2's program, byte for byte. Each install, upgrade or downgrade took
  1.0 to 1.5 s.
- 21 interruptions, through a wrapper of the real `systemctl` that signals
  the installer right after a given call: an upgrade after the timer's
  start (TERM), the helper's stop (TERM, INT, HUP, KILL), its start (TERM,
  KILL) and the timer's retirement (HUP, KILL); a downgrade after the stop
  (TERM) and the start (HUP); `--remove` after the timer's run (TERM) and
  each unit's disable (HUP, KILL, TERM), each followed by putting the helper
  back, interrupted after its start (TERM); and a broken upgrade's rollback
  after its stop (TERM) and during its wait (KILL). After each, a writer of
  the report ran, and the same command run again finished, or, for the
  broken upgrade, put 0.1.0 back in its 75 s. No guest's config changed.
  This found systemd's start limit, below.
- Before the fixes: an upgrade to a copy whose helper writes no report
  rolled back to 0.1.0 in 77.5 s. A helper stopped by hand, then
  `setup-gpu.sh`: it reported again after 59.9 s, and the run succeeded;
  the same with unit 2's `setup-gpu.sh` handed the report to the timer
  after 31.2 s and exited 1.

Limits: fake Proxmox modules and a fake `nvidia-smi`, not a node; no
`pve-guests.service`, so the boot unit was enabled but never run. A power
cut was not tried: the backup is synced to disk, and files are put in place
by rename.

### The live gate

Waits for the lead, after unit 2's day passes. The steps and a read-only
check script, which prints the report, the units, the program, `gpu.conf`,
the ledger, and fingerprints of every guest's device lines and tags, are
in the report to the lead. The live upgrade is to a copy of the release
that says 0.1.1, then `--downgrade` back. The doctor cannot pass live in
this release, as writes stay off: live it warns for the dry run, shows no
check after removal, and, if the lead chooses, fails a helper stopped for
3 minutes.

### After the reviews

Two reviews, Opus and Astra, said to merge after fixes. Each fix has a
test, and each test failed when run against the reviewed commit's
`setup-gpu.sh`, `gpu-helper.ts` and `backend.ts` (`66188103`, rebased), on
a box: 20 of its first 29 installer tests failed, every new one among them,
and so did the doctor's new tests.

| Finding | Fix | Test, and how it failed before |
| --- | --- | --- |
| Opus 1, Astra 1: an exit part way, by `set -e`, Ctrl-C, a kill or a dropped session, could leave neither the helper nor the timer writing the report, and the backup was deleted on exit | The timer runs before any stop of the helper. An EXIT trap, with INT, TERM and HUP made exits, keeps a writer running and says which. The install from before is kept on disk until the run settles, and the next run rolls back to it. Files are put in place by rename | An upgrade interrupted right after the timer's start, the helper's stop (TERM, INT, HUP, KILL), its start and the timer's retirement; `--remove`, a handover and a rollback interrupted; a rollback failing under `set -e`; a killed upgrade put right by the next run. Before: no writer ran, or the next run had nothing to put back |
| Astra 2: removal and the handover stopped the helper before the timer ran | The timer is started, and its service must write a report, before the helper stops. If it cannot, the helper is left running and nothing is removed | The order of calls; a timer that cannot start, and one that cannot write. Before: the helper was removed and nothing ran |
| Opus 2, Astra 3: a failed upgrade across a protocol change left a newer ledger, and the helper put back acted on nothing while the run said "with its ledger" | The backup keeps the ledger, copied again once the old helper stops. A rollback puts it back when the ledger's protocol is now newer than the old helper's, keeping the newer one beside. A fresh report must also be healthy | An upgrade to a protocol-2 copy that wrote its ledger while the installer waited. Before: the ledger stayed protocol 2, and the release before was refused |
| Opus 1: a downgrade whose stop failed, or stopped but said it failed, said "Nothing was changed" | Any failed stop rolls back, and the helper runs again | Both kinds of failed stop. Before: the helper stayed stopped |
| Opus 3: a handover with the timer already running left the stopped helper's lines in the report | The timer's service runs once after the helper stops, every time | The handover when the timer cannot be stopped. Before: the `helper` line stayed |
| Opus 4: `BBBOX_GPU_REPORT_WAIT` could come from `bb-box.env`, unchecked | Read from the process's environment before `bb-box.env` is read, and checked as 1 to 9999 | `abc` in `bb-box.env`, and `abc`, 0, -5 and 10000 given. Before: the env file's value made the wait 0, and the install failed |
| Opus 5, Astra 6: with a report VM but no report and no helper, the fix named both units | The timer's fix, word for word as before, wherever there is no `helper` line | The whole check. Before: the fix differed |
| Astra 4: a report dated ahead of BB's clock passed as fresh | A report dated a minute or more ahead fails, with the host's clock to check | A day and 60 s ahead fail, 30 s passes. Before: ok, "just now" |
| Astra 5: a `helper` line whose protocol it cannot read hid the check | Any `helper bb-box-gpu` line makes the check, and one it cannot read fails | `protocol broken`. Before: no check |
| Found by the interruption rehearsal: systemd refused a sixth start within 10 s, "attempted too often", so reruns close together handed the report to the timer | `systemctl reset-failed` before each start of the helper and of the timer's service | The fake `systemctl` with a start limit of 5 in 120 s: 7 installs and 6 removals. Before: the sixth start was refused |

Working the tests through also found that a rerun after an interruption
could find the old program running beside the new one's files, and so
restarts the helper unless a fresh report already names this release's
version.

### Deviations from the note

- `--writes on` is refused in this release; writes come on in unit 5.
- No `proxmox.gpu-helper` check with no helper, until unit 7.
- A failed upgrade puts the helper before it back, rather than handing the
  report to the timer; the timer only if that fails too.
- `--downgrade` also lets an older release replace a newer helper, not
  only use a newer ledger, which it sets aside for a rebuild.
- The installer waits up to 75 s for a fresh report, not 30 s.
- Removal waits for the timer's report before it stops the helper, and
  leaves the helper running if the timer cannot write.
- An interrupted run leaves a writer and its backup, and the next run
  completes or rolls back from that backup.
- The doctor fails a report dated a minute or more ahead of BB's clock.
- The doctor warns, rather than fails, when the report cuts its pool list
  short and does not list this install's pool.

### Still open

- The helper writes its report on a start only when it has something new.
  Decided with the lead: a helper release in unit 4 writes it on its first
  pass after a start, so unit 4's day of dry run with markers runs on that
  program, and the program unit 5 turns writes on for has had its day.
  0.1.0 stays installed, byte for byte, until then. The installer's 75 s
  wait stays, as a rollback can start 0.1.0 again.
- The doctor's pass, live, waits for writes on (unit 5). The lead agreed
  that it warns while writes are off, and skips the gate's optional step 11.

## Unit 4: marking today's guests, and a helper that reports on its first pass

Built on main `b15fe055`, and after the reviews rebased onto `93c25d53`.
Nothing new is offered: no box gets a card it did not have, and no form, tool
or setting changes. Writes stay off in both of the helper's units.

### What it does

- **`bb box gpu mark`** marks each guest of this install whose device lines
  name a card with the claim those lines give: one tag,
  `gpu.shared.<the card's UUID>.g<N>`, or `gpu.whole` where the box's record
  says a whole card, which no record on Proxmox LXC does yet. The card is the
  one the helper's report lists for the lines' `/dev/nvidiaN` and DRM nodes,
  matched as the helper matches them. N is 1 for a guest the helper has never
  answered, and otherwise one above the generation its ledger answered last,
  so a mark after `--undo` is never behind the ledger. Guests with no GPU
  device lines are not marked. Every Proxmox LXC backend that is on, or
  `--on <id>`.
- **What it reads and writes.** For each guest it reads the current config
  and the pending changes, decides from those, and writes only the tags,
  every other tag kept, the marker last, with the config's digest, so a
  change in between is refused. It then reads the guest again, decides again
  from that read, and tries once more. A config with no digest is not
  written. It never starts, stops or resizes a guest and never sends a device
  line. A running box is marked as it runs.
- **What it leaves, and names.** Checked on every read, from the config just
  read: a template, a held copy, an earlier guest, an image box, a warm guest
  being filled or retired, a guest whose tags or description no longer name
  this install. Then: a lock; GPU lines, or any device change, waiting in the
  pending changes; a privileged container; raw `lxc.*` lines for GPU
  devices; lines naming a node no card in the report has, or two cards; lines
  that are not exactly the card's set for the guest's kind, compared as the
  helper does, as complete sorted lists with repeats counted; a record that
  says no GPU; a card another guest holds whole, from the ledger or the
  holder lines; for a whole record, any other holder of the card; another
  guest of this install naming the same box, or a ledger entry holding the
  box for another guest; a gpu tag it did not write.
- **The helper's answers.** A marker just written counts as granted only
  from the helper's own `claim <vmid> g<N> granted <part> <card>` line for
  it. A marker already there counts as granted only when the ledger line
  holds that generation, part and card. A managed holder line is never taken
  for a grant. It waits up to 10 s, reading the report each second. Run
  again, a guest whose marker the helper refused, or whose ledger holds
  another claim, is asked again with the next generation once every check
  above passes; a refusal for a reason it does not know is left, named. It
  exits 1 when it leaves a guest or the helper does not grant one.
- **`--check`** says what it would mark and what it would leave, and changes
  nothing. **`--undo`** takes the shared and whole markers off this install's
  guests, checking each again from the config it reads, and nothing else. It
  does not clear the claims the helper granted, which stay in its ledger
  until a later release clears claims (unit 5). With writes off the helper
  changes nothing; with writes on it would go on giving each stopped guest
  the lines of the card it claimed. The command, the setup guide and this
  file say so.
- **bb-box keeps a marker.** A warm guest a box takes, and a box relabelled
  for another owner (036), read the tags again just before they write them,
  keep any gpu tag, write on the digest, and on a change in between read
  again and retry, up to 5 times.
- **`proxmox.gpu-migration`**, beside `proxmox.gpu-helper` and only where
  the report has a helper line. It reads the report and each of this
  install's guests' config and pending changes:

  | Finds | Status | Fix |
  | --- | --- | --- |
  | the helper's own check fails | skipped | |
  | no ledger lines in the report, as from 0.1.0 | fail | `setup-gpu.sh` from this release |
  | a report that leaves lines out | fail | the helper's journal |
  | GPU lines naming a node no card in the report has | fail, naming each guest and node | put the lines right on the host |
  | a guest with GPU lines, current, pending or raw, and no marker | fail, naming each | "Run bb box gpu mark" |
  | a write the helper would make to a guest of this install | fail, naming each and the write | the helper's journal; each must be explained before writes come on |
  | a refusal in force for a guest of this install | fail, naming each and why | put it right, then mark again |
  | a marker the ledger does not hold as asked | fail, naming the marker and the claim | mark again |
  | a marker the helper has not answered yet | warn | run the doctor again in a minute |
  | a write it would make to a guest outside this install's pool | warn, by VMID | the helper's journal |
  | none of these | ok | |

- **The helper, 0.2.0.** The service writes the report on its first pass
  after a start, whatever has changed, and counts those writes "on start"
  in its hourly line. The report gains `ledger entries <n>`, always, and a
  line per ledger entry, `ledger <vmid> box <install/box|-> answered g<N>
  claim g<M> <part> <card|-> <granted|yielded>` or `... claim none`, after
  the `would` lines in the budget, or `ledger unknown` when it cannot read
  its ledger. Each report also names the process that wrote it,
  `process <pid> started <seconds since the epoch, to the millisecond>`, so
  a helper started again within the second of the report it left still
  writes a report that differs from it (see "After CI"). Lines are only
  added: protocol 1 is unchanged, as the marker is, and today's bb-box skips
  them. Both units still run it with `--dry-run`, and
  `setup-gpu.sh --writes on` is still refused.
- **`setup-gpu.sh`** waits 30 s for this release's helper, which reports on
  its first pass, and still 75 s for a helper a rollback puts back, which
  may write only on its one-minute heartbeat. `BBBOX_GPU_REPORT_WAIT` sets
  both, as before.

### What was run

On a `linux` box, in a `node:26-bookworm` container as CI runs:

- `test/gpu-mark.test.ts`, 13 tests, and `test/gpu-mark-reviews.test.ts`,
  13 tests, with bb-box against the fake Proxmox API and the real helper, in
  a dry run, on unit 2's fake node, the two sharing the guests
  (`test/gpu-helper/bridge.ts`): each guest's tags written through the API
  are copied to the node's config, and the helper's report back to the API.
  - Marking today's guests (a running and a stopped desktop, a server's
    lines, a warm desktop): only tags change, every other tag stays, one
    `PUT` per guest with `tags` and `digest` and nothing else, the guest's
    config on the node byte for byte but its tags line, the helper grants
    each, would write nothing and writes no guest; untouched: a server and a
    CPU desktop with no lines, a template, another install's guest, a guest
    outside the pool, a held copy, an image box, a filling and a retired warm
    guest. A second run writes nothing.
  - `--check`; each refusal, with its words; a whole record; `--undo` and its
    `--check`; a refusal asked again; no answer within 10 s; a config changed
    between the read and the write; the whole run refused; the doctor's
    outcomes; the rules alone, the CLI's words, `--json` and exit status.
  - Each review finding, below.
- `test/proxmox-lxc.test.ts`: a warm guest a box takes, and a relabelled
  box, keep their marker, also one written between their read and write.
- `test/gpu-helper.test.ts`: the first-pass report; the ledger lines, and
  `ledger unknown` with a ledger it cannot read; the report under 8,192
  characters with 60 holders and 120 refusals, its ledger count kept.
- `test/gpu-setup.test.ts`, 33 tests: the version strings moved to 0.2.0 and
  newer copies to 0.2.1 and 0.3.0, and:
  - a helper stopped by hand and started again by `setup-gpu.sh` reports
    on its first pass: the run took 1.4 s, inside its 30 s wait (unit 3's
    test of this waited 60.5 s);
  - a rollback to a copy that writes only on its heartbeat, as 0.1.0 does,
    is still waited for: 60.3 s, past the 30 s a release's own helper gets;
  - the node's upgrade, from such a copy to this release: 1.5 s, gpu.conf,
    the ledger and writes off kept, no guest written or locked;
  - a helper started again within the second of the report it left, with
    the wall clock held by libfaketime: the run took 1.5 s, and the two
    reports, of one second, name two processes.
- `tsc` clean; the reference as `scripts/reference.ts` writes it; the node
  suite, 3,527 tests, 3,232 passed, 0 failed, 295 skipped; vitest, 448
  passed. Before the reviews, on `b15fe055`: the node suite 3,510 tests,
  3,215 passed, 0 failed; vitest 445 passed, one run of it timing out in
  `test/monitor-app.test.tsx`'s setup hook at 10 s and passing when run
  again.
- `shellcheck -x` on `setup-gpu.sh`, from its folder: clean.

### After the reviews

Two reviews, Opus and Astra, said to merge after fixes. Each fix has a test
in `test/gpu-mark-reviews.test.ts`, or where named. Run against the reviewed
commit's `src` and helper (`bde17304`, rebased), on a box, all 15 new tests
failed: the 13 in that file, the ledger test in `test/gpu-helper.test.ts` and
the race test in `test/proxmox-lxc.test.ts`. The older tests beside them
passed.

| Finding | Fix | Test, and how it failed before |
| --- | --- | --- |
| Opus 1, Astra 2: after `--undo`, mark wrote g1 again, behind the ledger, and took a managed holder line for a grant, so lines moved to card B read as "granted" while the ledger held card A | The helper's report lists its ledger. Mark asks one above the ledger's answered generation, and counts a grant only from the helper's `claim` answer to the marker it wrote, or, for a standing marker, the ledger's claim as asked | Mark A, undo, lines to B, mark: wrote g2 for B, granted at g2, nothing the helper would write. Before: it wrote g1 and said "granted" |
| Opus 1: refused at g1, granted at g2, undone, then marked again at g1, never answered | The same | g3, granted. Before: g1, and the old refusal shown |
| Opus 1, Astra 2: a standing marker for card B while the ledger held card A read as granted, and the doctor passed | The ledger's claim must match the marker; else mark asks again, and the doctor fails, naming both | Before: "already", granted, and the doctor ok |
| Opus 1: `--undo` said "it writes nothing" | The command, the guide and this file say the claims stay until unit 5, and what writes on would do | The undo words. Before: the old words |
| Opus 2, Astra 1: template, held copy, earlier guest, warm guest in flux and ownership came from the pool listing only, even after a reread | Checked from each config read, the first and the reread after a change | Each turned at the read and at the reread: left, with words, no marker. Before: marked |
| Astra 1: `--undo` did not check ownership again | The same check, from the config it reads | A guest whose tags came to name another install: left. Before: its marker taken off |
| Astra 1: a write without a digest was allowed | No digest, no write | A config with no digest: left. Before: written |
| Astra 3: two guests naming one box, and a whole holder blocking a shared request, were marked; a copy's refusal was asked again by generation alone | Both are checked before writing, from the configs read and the ledger; a refusal is asked again only once every check passes | Twins left, the refused copy not asked again, a shared request on a whole-held card left. Before: written |
| Astra 4: a guest whose lines name a node no card has fell out of the holder lines, and the check passed; an omitted line also passed | The doctor reads each guest's config and pending changes; any omission, or no ledger lines, fails | `/dev/nvidia7` named; "omitted 3 would lines" fails; no ledger lines fails, and mark refuses to run. Before: ok |
| Astra 5: devices compared as sets | Complete sorted lists, repeats counted, as the helper compares them | A line given twice: left. Before: marked, and the helper would have rewritten it |
| Opus 3, Astra 6: a warm claim and a relabel kept a stale tag list | Tags read again just before the write, on the digest, retried on a change | `test/proxmox-lxc.test.ts`: a marker written between their read and write stays. Before: lost |
| Opus 4: GPU lines only in the pending changes were "no card's lines" to mark, while the doctor named them | Pending changes are always read; mark leaves and names such a guest | Before: not named |

### After CI

CI failed the test of a helper stopped by hand once, at 32.1 s: the
installer waited its 30 s and rolled back. It was seen once on a box before,
at 33 s, and put down to load; that was wrong. Reproduced on a box by
running the GPU test files together, with the helper's output now in the
test's failure message: the restarted helper wrote its report on its first
pass, as its hourly line said ("1 on start"). The helper before it had run a
single pass before the test stopped it, so the two reports fell in one
second. The report's `at` is in whole seconds, so the two were byte for byte
the same, and the installer, which takes a report as fresh only if it
differs from the one there before the start, rightly could not tell them
apart. 0.2.0 then had nothing new to write until its 60 s heartbeat, past
the 30 s wait. Load alone did not cause it: 18 runs of the test alone,
6 at a time with all 8 cores busy, took 1.9 to 2.2 s each.

The fix is the report's `process` line: each helper process names itself,
so the report the service writes on its first pass always differs from the
one it replaces, in the same second or not. The line is left out when the
helper asks whether anything has changed, so a new process alone writes no
report: `--once`, and a release that writes only on its heartbeat, behave as
before. The `helper` line, which today's bb-box reads, is unchanged.
The installer's wait stays 30 s for this release's helper, against a first
report due within about 10 s even when `nvidia-smi` gives no reading; 75 s
for a helper a rollback puts back.

- The new test, with the wall clock held at one second by libfaketime,
  failed without the line, rolling back after the 30 s wait, and passes with
  it in 1.5 s.
- Under load, all 8 cores busy with `stress-ng --cpu 8`, load average 15 to
  21: the test of a helper stopped by hand and the new test, 10 runs each,
  all passed, 1.8 to 2.0 s each.
- The GPU test files together, as they reproduced it, 3 rounds after the
  fix: 190 passed, 0 failed each time, that test 1.4 to 1.5 s. Before the
  fix, 1 round of 2 had failed it.

### The live check

Run before and again after the reviews' fixes, the same way: a fresh
`npx bb-app@0.48.1`, with no account, in a container on a box, with bb-box
installed from this branch by `bb plugin install`. Its Proxmox LXC backend
was set up with `bb box backend add proxmox-lxc` against a throwaway HTTPS
server on the box that answers with the tests' fake Proxmox, pinned by its
certificate's fingerprint, and keeps its guests in a fake node's config files,
where the real helper 0.2.0 ran as a service with `--dry-run`. The guests: a
running and a stopped GPU desktop, one locked, one with a server's lines on a
desktop, a server, a warm desktop (which this BB's sweep retired, as it keeps
no warm pool), another install's desktop, a held copy and a template.

After the fixes:

- The doctor, on adding the backend: `proxmox.gpu-migration` failed, naming
  the four desktops with GPU lines and no marker; `proxmox.gpu-helper`
  warned for the dry run.
- `bb box gpu mark --check`: would mark the two desktops at g1, left the
  locked one and the one with short lines, with the words above, exit 1,
  nothing written.
- `bb box gpu mark`: marked both, each granted from the helper's `claim ...
  g1 granted` line, 1.3 s in all; the report's ledger lines held each claim.
- With the lock gone and the lines made whole on the fake node, a second run
  marked those two and said the first two were marked already; the doctor's
  check passed.
- `bb box gpu mark --undo`: the four markers off, with the words on what it
  leaves; the doctor failed again, naming them.
- The stopped desktop's lines moved from card 1 to card 0 by hand on the fake
  node, the case both reviews found: the report said the helper would put
  card 1's lines back (`would ... for claim g1`). A third mark asked each guest
  at g2, "The helper answered up to g1 for it before", each granted at g2,
  the stopped desktop's for card 0; the `would` line went, and the doctor
  passed.
- Throughout, the helper wrote the report VM alone, no guest; each guest's
  config changed in its tags only. The watcher, run for a few seconds
  against the fake node, logged the ledger lines and a summary with nothing
  the helper would write.

Limits: a fake Proxmox API and a fake node, not a node; no real `pct` lock
or pending section from the API; BB's sweep did not adopt the test guests,
so no box records gave a part.

### The live gate

Waits for the lead, after merge: upgrade the helper with this release's
`setup-gpu.sh`, mark from BB, 24 h of dry run with a watcher under
`systemd-run`, and the doctor's check. The steps, a read-only check script
and the watcher are in the report to the lead.

### Deviations from the note

- Guests with no GPU lines are not marked `gpu.none.g1` (section 5, "Dry
  run", step 2). A guest with no marker and no lines is never written and
  holds no card, so its marker changes nothing now; unit 5 writes markers as
  boxes are made. The lead's brief asks for this.
- The part comes from the box's record: shared, or whole where the record
  says so. A record that says no GPU on a guest with a card's lines is left
  for a person to decide.
- `bb box gpu mark` leaves a guest the helper would refuse or rewrite,
  rather than marking it and letting the dry run show the write; the doctor
  names it either way.
- A refused marker, or one the ledger does not hold as asked, is asked again
  with the next generation.
- `--undo` is new: the note has no way back from marking. It takes off tags
  only.
- `proxmox.gpu-migration` reads each guest's config, and also fails on a
  write the helper would make, a refusal, a marker the ledger does not hold,
  nodes no card has and an incomplete report; it warns while a marker waits
  for its answer. The note checks only for lines without a marker.
- The report gains `ledger` lines within protocol 1, and mark needs a helper
  that writes them, 0.2.0 or later.
- bb-box's relabel and warm claim keep a guest's marker.
- The installer waits 30 s for this release's helper, as unit 2 did, and 75 s
  only for a helper a rollback puts back.

### Still open

- A GPU desktop made after marking has no marker until `bb box gpu mark`
  runs again; the doctor names it. Unit 5 writes the marker as a box is
  made.
- A fork's re-arm, a swap and an earlier guest replace a guest's tags, so
  they drop its marker, as section 9 wants for the fork; unit 6 writes their
  markers.
- `--undo` leaves the helper's claims; unit 5 must clear them, or refuse
  `--undo`, and must not let `--undo` take off markers it writes itself.
- Not rehearsed under real systemd this time: the installer's code is unit
  3's but for its two waits, and the tests run it with the fake `systemctl`.

## Unit 5: claims, and the helper's writes on

Built on main `eb751824`. Used first by today's GPU desktops: no form, tool,
CLI option or setting is added, and no box is offered a GPU it was not
before. Writes stay off on the node until the lead runs
`setup-gpu.sh --writes on`, a step of its own.

### What it does

- **The card lock.** One lock per node, in bb-box's process, shared by every
  backend that reaches the node through the same API. It is held from
  reading the helper's report and the pool to reserving a card, and never
  across a clone, a stop or a start. An acquire, a warm desktop's fill and
  the start of a stopped box take it.
- **Reservations.** Under the lock, the card is reserved in memory for the
  box being placed, with the 384 MiB a desktop needs. Placement counts a
  reservation as a holder of its card, once per guest. A reservation ends
  when the operation fails, or, once the box runs, when the helper's report
  shows the guest running on the card, or after 2 minutes.
- **Placement** (section 3, "Shared"), where the helper is usable: a card
  that one of the desktop templates carries (each template's GPU ID is
  matched to the report's cards by UUID, PCI address or index, as today),
  not avoided after a display that came up on the CPU nor read full while
  another is left (as today), held whole by no guest, with fewer of this
  install's boxes than the desktops per GPU, and with no request of this
  install the helper has left unanswered; then the card with the fewest
  boxes holding it, of every install and none, the most memory free less
  what is reserved, and the lowest index. A box holds its card when it runs,
  when it holds it whole, and when the helper does not manage it; a stopped
  shared box the helper manages holds no place.
- **Generations.** A marker asks one above the highest of the ledger's
  answered generation for the guest, its claim's, the marker on the guest,
  and the last this process wrote.
- **Acquire.** Lock, place, reserve, unlock. Clone from the least used
  template on that card, whose lines are the card's. The marker
  `gpu.shared.<UUID>.g<N>` goes in the same config write as the box's
  labels. bb-box waits up to 10 s for the helper's answer, reading the
  report every 0.5 s, and starts the box only once it is granted. Refused,
  the guest is released and the box placed once more, on another card; a
  second refusal, or no answer, releases the guest and is said in words.
  The box's record gets the claim (`guest.claim`).
- **Warm desktops** are placed and marked the same way, before they start,
  and keep the marker through their last labels. A box that takes one keeps
  its marker, as since unit 4.
- **The start gate**, for a stopped guest with a shared or whole marker,
  whatever the desktop templates and kinds say now. A box starts only on a
  grant of its current marker, as the helper reports it. An unanswered request is waited for, up to 10 s, and so is a helper
  that is not reporting; then the box is not started. A marker the helper
  refused is not started on: where the helper still holds a claim for the
  guest, that claim is asked again as a new generation, which needs no
  write, and the box starts once it is granted. With writes off, or a whole
  claim, that is all: the box starts on the card it holds, as before. With
  writes on, a shared box starts on its last card if that card has room,
  else on another card with room that a desktop template of a kind that is
  on names: bb-box
  writes the new marker on the digest, every other tag kept, waits for the
  grant, for which the helper writes the card's lines into the stopped
  guest, and then starts it. Before each marker write, a retry after the
  config changed meanwhile included, and again just before the start, bb-box
  reads the guest's config and checks it still names this install and this
  box, writing on that config's digest; otherwise it writes nothing, does
  not start the guest, and does not release it. With no card that has room, it is not started:
  "Container 7021 was not started: No card on pve can take another box now:
  ... It is stopped, with its disk as it was." Memory is not part of the
  start gate (see deviations). A start returns the claim it started with,
  and the box's record takes it, with its GPU fact naming the card it holds
  now, also when it starts on the last report's grant while the helper is
  not reporting, and when it is started again while it runs. A release, and the readings of GPU memory in running
  desktops, go by that card too. A stop gives up the box's shared
  reservation at once.
- **Recovery at bb-box's start.** Before the first placement, bb-box reads
  the report and every marker on this install's guests, and waits up to a
  minute for each request the helper has not answered. Those still
  unanswered are logged by name, and the start gate does not start them.
  Placement leaves a card on which this install has an unanswered request
  that no operation in this process is waiting for.
- **When the helper cannot be used.** With no helper line in the report, or
  no report, and no guest of this install marked, GPU desktops are made as
  before, with no marker. With a guest of this install marked, a report with
  no helper line, as the timer writes while `setup-gpu.sh` restarts the
  helper, means the helper is not reporting: no new GPU desktop is made and
  no marked box starts. Where the helper's own doctor check fails (its
  report 3 minutes old, another protocol, this install's pool not served),
  or its report leaves lines out, lists no card or no ledger, a new GPU
  desktop and a warm desktop's fill are refused with the reason and the
  fix, and a stopped box whose current marker the last report granted still
  starts. A helper on a pve-container its release was not tested on runs as
  with writes off: desktops are made and marked, and no box is moved.
- **Capacity** uses the same placement, without the lock: its GPU limit is
  this install's boxes holding cards against the desktops per GPU times the
  cards, and its refusal is the placement's.
- **`bb box gpu mark --undo` clears claims.** It writes `gpu.release.g<N>`
  in place of each shared or whole marker, and on a guest with a claim and
  no marker, as unit 4's undo left them; waits up to 10 s for the helper's
  `claim <vmid> g<N> released`; then takes that tag off, on the digest. The
  guest keeps its lines, holds its card unmanaged, and the helper never
  writes it again. It needs bb-box-gpu 0.3.0 or later, and is refused,
  changing nothing, with an older helper or none.
- **The helper, 0.3.3** (0.3.0 as PR 1349 merged it, 0.3.1 as PR 1350 did, 0.3.2 as `c26657bf` did). Protocol 1. The marker gains `gpu.release.g<N>`:
  answered by clearing the guest's claim, with writes on or off, as it
  writes no guest; a rebuilt ledger takes it for no claim. `--preview` makes
  one pass as writes on would, writing no guest, ledger, report or state and
  locking no guest, and prints each write it would make, each answer it
  would give, and a summary. It exits 1, saying why, when it read no card,
  has an error line, or could not read a guest it would decide on. Under a
  guest's config lock, the helper writes or grants only while the guest is
  the same box it scanned: the same box, install, kind, pool and gpu tags;
  otherwise it leaves the request for the next pass. A guest whose config it
  cannot read is named in an `error` line, holds every card in the report's
  holder lines, and stops every decision that would give or claim a card it
  may hold until it can be read.
- **Incomplete readings.** A reading by `nvidia-smi` that leaves out a card
  the driver lists decides no request on that card and changes no guest's
  lines for it. One with a row the helper cannot read, or from a query that
  did not exit normally with status 0 (an error status, a signal, output
  closed with no exit, or cut short), decides no request on any card and
  changes no guest's lines. Each is named in an `error` line, so the preview
  fails.
- **A lost ledger** is rebuilt from the guests only from a full reading of
  every card: until `nvidia-smi` gives one, the report says `ledger
  unknown`, nothing is decided, and bb-box places and starts no GPU desktop.
  The rebuild is as before, with two changes.
  A guest whose card a guest the helper cannot read may hold is left out,
  and its request waits. And the rebuild strips no stopped guest's lines, at
  boot or after: a stopped copy, a guest whose lines do not match its
  marker, and a whole box whose card another guest still has are refused,
  `copy` or `ledger-lost`, keep their lines, and are decided when bb-box
  asks again, as it does before it starts them. Each guest the rebuild
  leaves unresolved, refused or left out, that may hold a card is kept in
  the ledger and named in the report, `unsettled <vmid> <uuid> g<N>`, one
  line per card it may hold. Until the helper answers it in a normal
  decision, once it has asked again, or it has gone or holds no card, every
  card it may hold takes no new guest and no whole claim: the helper
  refuses such a request `unsettled`, naming the guest, and bb-box places no
  box there. Only a full reading of every card can show it holds no card,
  and only an answer decided on one settles it: a reading that fails, or
  leaves a card out, keeps it, and a refusal for want of a reading does not
  count. A guest that already holds a claim on the card, or is itself
  unresolved and holds the card's lines, may still ask for it shared.
  Writes on or off alike.
- **`setup-gpu.sh --writes on`** works only on this release's helper,
  already installed and reporting, with no unfinished run. It runs the
  preview first, prints it, and refuses, changing nothing, when the preview
  would write any guest, is incomplete or has an error line, or finds an
  untested pve-container. An upgrade with writes on runs the new release's
  preview the same way first, and changes nothing if it fails. A `--writes
  on` cut short once both units are written is finished by the next run,
  which keeps writes on; cut short before that, writes stay off.
  Then it writes `writes on` in `gpu.conf` and installs both units without
  `--dry-run`, restarts the helper with the timer running meanwhile, and
  waits for a report that says `writes on`; else the install before is put
  back. `--check` prints the preview and changes nothing. `--writes off`
  sets both back. An upgrade keeps writes as they were; a failed one puts
  them back as they were. `--writes` takes no other option. Writes are on
  only when `gpu.conf` says so and the service unit runs the helper without
  `--dry-run`; after `--remove`, a later install comes back with writes off.
- **The doctor.** `proxmox.gpu-helper` still warns while writes are off,
  now saying what writes off means for bb-box and giving the steps:
  `--writes on --check`, then `--writes on`. It warns, rather than fails,
  for a pve-container the helper's release was not tested on.
  `proxmox.gpu-migration` reads a `gpu.release` marker as no marker, and
  names the guests a lost ledger left unresolved and the cards they close:
  it fails for this install's, whose fix is `bb box gpu mark`, which asks
  again, and warns for another install's.

### What was run

On a `linux` box, directly, with Node 26.13.0 and Perl 5.38, the tests as
root as CI runs them, after the reviews' fixes:

- `test/gpu-claims.test.ts`, 20 tests, with bb-box against the fake Proxmox
  API and the real helper 0.3.0 with writes on, on unit 2's fake node. A new
  bridge (`test/gpu-helper/claims-bridge.ts`) keeps the two in step both
  ways: before each helper pass every container's config, pool and power
  state goes to the node, and after it the device lines the helper wrote and
  its report come back; each sleep of bb-box's is one pass. The gate's cases:
  two acquires at once with desktops per GPU 1 on two cards, and a third
  refused before any clone; a second install whose placement a whole claim
  overtakes before its clone, refused `whole-taken` by the helper and placed
  once more on the other card, then refused with words where it has no
  other; bb-box made again with a marker left unanswered, which places
  nothing until the helper answers, and a box whose marker stays unanswered
  not started; a stopped desktop on a full card moved by the start gate,
  the helper writing the other card's lines into it while stopped and
  nothing else, and a running guest's move refused `running` with its lines
  kept. Also: a refusal on both cards; a stopped shared box holding no
  place; writes off as before; no helper, and a helper bb-box cannot use; a
  warm desktop marked as it is made; capacity; an acquire resumed after a
  restart; desktop templates whose GPU IDs name no card the helper lists;
  each review finding below; and the rules alone (holders, reservations,
  the lock, generations, answers, recovery, the report's states).
- `test/gpu-helper.test.ts`: release markers with writes on and off,
  running and stopped, an ineligible one refused, a lost ledger, and the
  boot pass after a release; `--preview` writing no guest, ledger, report or
  state and locking no guest, naming the write it would make, and the
  untested pve-container; and the review findings: a guest changed while the
  helper waited for its lock, an unreadable guest, an incomplete preview.
  The fake Proxmox modules can now change a guest's config once its lock is
  taken (`FAKE_PVE_SWAP_ON_LOCK`).
- `test/gpu-setup.test.ts`: `--writes on` refused before an install, with
  an older helper, on an untested pve-container, when the preview would
  write a guest, and when it is incomplete, each changing nothing;
  `--check`; on, with both units and `gpu.conf` together and no guest
  written; an upgrade keeping writes on, after the new release's preview,
  and refused while that preview fails; a failed upgrade putting them back
  on; `--writes off`; a removal and a later install coming back with writes
  off; the usage errors.
- `test/gpu-mark.test.ts` and `test/gpu-mark-reviews.test.ts`: `--undo`
  clears each claim and takes the markers off, as before marking; a second
  undo changes nothing; a mark after an undo asks above the release.
- Rebased onto main `ffafe0bb`: `tsc` clean; the reference as `npm run
  reference` writes it; the node suite, 3,579 tests, 3,285 passed, 0
  failed, 294 skipped; `shellcheck -x` on `setup-gpu.sh`: clean. vitest,
  448 passed, twice in a row, on a Hetzner box.
- After the re-review's fixes and the CI fix, still on main `ffafe0bb`, as
  root on a `linux` box: `tsc` clean; the node suite, 3,584 tests, 3,289
  passed, 0 failed, 295 skipped; vitest, 448 passed. A run of the node
  suite before that one failed a test of `test/identity-reset.test.ts`,
  which passed alone, 42 of 42 with 2 skipped, on this commit and on
  `b3212714`. The GPU and Proxmox LXC test files together: 267 tests, 266
  passed, 1 skipped.
- Run directly on a box rather than in a container that reaps them, the
  helper tests had left 136 of the fake `nvidia-smi`'s loops running. The
  fake now exits once nothing reads its output; the five GPU test files,
  124 tests, then passed and left none.

### The live check

Run again after the reviews' fixes, directly on a box: two fresh
`npx bb-app@0.48.1`, with no account and enrolment off, each with bb-box
installed from this branch by `bb plugin install`, each a separate install
with its own pool. Their Proxmox LXC backends were set up with `bb box
backend add proxmox-lxc` against a throwaway HTTPS server on the box that
answers with the tests' fake Proxmox, pinned by its certificate's
fingerprint, and keeps its guests in step with a fake node where the real
helper 0.3.0 made a pass with writes on every second. The boxes' addresses
answered SSH on the box itself, as the box user, with bb-box's key, and
their desktops said they had drawn on the GPU. Two GPU desktop templates,
one per card; desktops per GPU 1, then 2. Times are the fake server's log.

- Two `bb box acquire linux-desktop` at once: one on each card, each
  marker in the write that labelled the guest, each start after its grant.
  A third was refused before any clone, with the words above.
- One box stopped: a new box took its card. Starting the stopped box was
  refused, both cards full, and it stayed stopped. With the box on the other
  card released, the start moved it: marker g2 for card 1, the helper wrote
  card 1's lines into it while stopped 0.6 s after the marker, it started
  0.4 s later, and its record's claim and GPU fact name card 1.
- A box released, and another asked for at once: it took the released
  box's card, though the report still listed the released guest.
- The report made the timer's, with no helper line, and the helper paused:
  starting a stopped marked box was refused after 11 s, "bb-box cannot see
  a grant of its GPU marker ... The GPU helper on pve is not reporting ...",
  and an acquire was refused with the same reason. With the helper
  reporting again, the start went ahead.
- bb-box killed between a marker and its answer: with the helper's answers
  paused, an acquire wrote its marker and BB was killed 1.1 s later.
  Restarted, BB resumed that acquire, and was asked for a new desktop. For
  20 s nothing was cloned and the resumed guest was not started. Within
  1.3 s of the helper's answer both went on: the new acquire took card 0,
  so the resumed acquire's start gate moved its guest to card 1, the helper
  writing its lines while it was stopped, before starting it. Each card
  ended with two boxes, the limit.
- Writes turned off on the fake node, and a move of a stopped box to card 1
  asked as if just before: the helper left it as a write it would make. The
  start asked the box's standing claim on card 0 again (g3), the helper
  granted it with no write, and the box started on card 0.
- The second BB's desktop went to card 0. Stopped, its guest asked for card
  0 whole: the helper refused it `card-held 7003`, the first install's box,
  and its config was as before. Its next start did not use the refused
  marker: it asked its standing shared claim again (g3) and started on it.
- `bb box gpu mark --undo` on the first BB cleared four claims through
  release markers; every guest kept its lines; the doctor's Markers on GPU
  guests then failed, naming the four; `bb box gpu mark` asked each above
  the release and the helper granted them; the doctor then passed both GPU
  checks.
- In all, the helper wrote guests twice, CT 7000 and CT 7004, each while
  stopped, for a move bb-box asked; no running guest was written.

Limits: a fake Proxmox and a fake node, not a node: no real `pct` lock,
pending section or hot-plug; the helper made one-off passes, not the
service; the boxes were one SSH server; the cards loaded nothing. The first
move above ran on the build before the last fix (a released guest's place),
as the first BB had not restarted; every later step ran on the final build.

### After the reviews

Two reviews, Opus and Astra, said to merge after fixes, with writes kept off
until every one is in. The lead decided Opus 3. Each fix has a test, and each
of these tests failed when run against the reviewed commit's `src`, helper
and `setup-gpu.sh` (`1c5765fa`), on a box: 16 tests, all failing, each for
the reason in the table.

| Finding | Fix | Test, and how it failed before |
| --- | --- | --- |
| Astra 1: after waiting for a guest's config lock, the helper wrote a guest that had changed meanwhile: a guest asking for no card got the card it had asked before, and another install's guest that took the VMID got the old box's card | Under the lock, the helper writes, grants or takes a yield only while the guest is the one it scanned: box, install, kind, pool and gpu tags the same. Otherwise the request waits for the next pass | `test/gpu-helper.test.ts`, with the fake Proxmox changing the config once the lock is taken: the guest asking for none was given card 0's lines and granted shared; the replacement got the lines; a replaced yielder lost its lines |
| Astra 2: the start gate failed open: a report with no helper line skipped it, and with writes off a refused marker started | A box starts only on a grant of its current marker. A report with no helper line, while this install has marked guests, means the helper is not reporting: wait 10 s, then refuse. A refused marker is never started on; a claim the helper still holds is asked again, and the box starts on that grant | `test/gpu-claims.test.ts`: the marked box started on a timer-only report; with writes off, a box refused `whole-taken` started on another box's whole card; a refused move started on its old claim without asking again |
| Astra 3: a guest whose config could not be read was left out, so another guest got the card it held whole, and the preview passed | The guest is named in an `error` line, holds every card in the holder lines, and stops every decision that would give or claim a card it may hold; the preview fails | `test/gpu-helper.test.ts`: another guest was granted card 0 whole while the unreadable one ran on it, and the preview exited 0 |
| Astra 4, Opus 2: the preview, and so `--writes on` and `--check`, passed with no card read and an `nvidia-smi` error | The preview exits 1, naming why, when it read no card, has an error line, or could not read a guest; `setup-gpu.sh` refuses on any of these, and on any `error:` line | `test/gpu-helper.test.ts` and `test/gpu-setup.test.ts`: the preview exited 0, and `--writes on --check` succeeded, with `nvidia-smi` failing |
| Astra 5: stopping a box just made kept its reservation for up to 2 minutes | A stop, or a power-off, gives up the box's shared reservations at once, under the card lock | `test/gpu-claims.test.ts`: the next desktop was refused, its only card counted full |
| Opus 1: the start gate could move a box to a card no desktop template names | The gate places only on cards a desktop template names, as an acquire does | `test/gpu-claims.test.ts`: the box was moved to card 1, which no template names |
| Opus 3, decided by the lead: an untested pve-container refused every new GPU desktop | It runs as with writes off: desktops are made and marked, none is moved, and the doctor warns; `--writes on` stays refused | `test/gpu-claims.test.ts` and `test/proxmox-lxc.test.ts`: the acquire was refused, and the doctor failed |
| Opus 4: a timer-only report during a restart read as no helper, so desktops were made unmarked | With this install's guests marked, such a report blocks new GPU desktops, with words | `test/gpu-claims.test.ts`: an unmarked desktop was made |
| Opus 5: a move left unanswered when writes went off held the box, and closed the card it was moving to | With writes off, the standing claim is asked again, with no write, and the box starts; a request the helper would make only with writes on closes no card | `test/gpu-claims.test.ts`: the start was refused after 10 s. The rules test checks that such a request closes no card; it failed earlier, on Opus 8 |
| Opus 6: after a move, the box's GPU fact named its template's card | The fact names the card the box holds | `test/gpu-claims.test.ts`: the fact named card 0 after the move to card 1 |
| Opus 7: an upgrade with writes on ran no preview | It runs the new release's preview first, and changes nothing if that fails or would write | `test/gpu-setup.test.ts`: the upgrade went ahead with `nvidia-smi` failing |
| Opus 8: a reused VMID could read an old guest's answer | A marker asks above every answer the report lists for the VMID | the rules test: g1 was asked over a listed g5 |
| Found in the live check: a start or acquire just after a release was refused, as the report, written each second, still listed the released guest | A guest this process has deleted holds no place, until the report no longer lists it or 2 minutes pass | `test/gpu-claims.test.ts`: the next desktop was refused, its card counted full |
| Opus 9: the `--undo` words said a start marks a box again | "A box bb-box makes from now on is marked as it is made; these guests stay unmarked until bb box gpu mark marks them again." | `test/gpu-mark.test.ts`: the old words |

Also documented, as Opus asked: a `--writes on` cut short once both units are
written is finished by the next run of `setup-gpu.sh`, which keeps writes on.
And, from Astra 2's fix: `setup-gpu.sh --remove` now says that a box with a
GPU marker starts only once a helper reports its grant, so `bb box gpu mark
--undo` comes first when the helper is removed for good.

### After the re-review

Astra's re-review of `b3212714` found the earlier fixes held, except in
three cases, and one smaller one. Each fix has a test that fails on
`b3212714` for the reason the re-review gave, built from its description of
the probes. 8 tests: 4 new, and 4 earlier ones whose expectations change
with R3. They fail on `b3212714` and pass now, on a box, as root.

| Finding | Fix | Test, and how it failed before |
| --- | --- | --- |
| R1: a partial reading passed the preview: card 0 read, card 1 `[N/A]`, an error and exit 9 | The helper keeps the failure of any row it cannot read, and of an error status or a reading cut short, and compares the cards read with those the driver lists. A card not read blocks every decision on it; a bad row or status blocks every decision. Each is an `error` line, and the preview names the gap | `test/gpu-helper.test.ts`: the preview exited 0 with card 1 `[N/A]` and exit 9, with card 1 left out, and with every row then exit 9. `test/gpu-setup.test.ts`: `--writes on --check` and `--writes on` succeeded in the same three cases |
| R2: with the desktop templates cleared, a marked box skipped the start gate, and started on another box's whole card | Every stopped guest with a marker goes through the gate, whatever the templates. The gate and an acquire count only the templates of a kind that is on; with none, a box starts only on the card the helper holds for it | `test/gpu-claims.test.ts`, with the templates cleared and with the desktop kind off: the box started under a timer-only report and after a `whole-taken` refusal; with the kind off, it was moved to card 1 |
| R3: a lost ledger was rebuilt past a guest whose config could not be read, and stripped a stopped whole box on card 0 because of it | The rebuild leaves out a guest whose card an unreadable guest may hold, and strips no stopped guest's lines, at boot or after: it refuses, and the box asks again | `test/gpu-helper.test.ts`: the whole box lost card 0's lines, and a shared box was granted, while CT 2552 could not be read; at boot, a mismatched box lost its lines. The earlier tests of a lost ledger expected the strips |
| R4: a box moved from card 0 to card 1 and started again while the report was stale got card 0's GPU fact | A start on the last report's grant names the card the marker holds; a release and the readings of GPU memory go by the card the box holds, not its template's | `test/gpu-claims.test.ts`: the fact named card 0 |

### After CI

PR 1349 failed CI twice the same way: vitest's `test/monitor-app.test.tsx`
timed out in its 10 s `beforeAll` hook, and its 40 tests were skipped. This
unit did not cause it. Main `eb751824` failed CI the same way. On a quiet
box the file took the same time on main and on this branch, 21.2 to 21.7 s.

The hook loaded the app, `loadPluginApp(() => import("../app.tsx"))`. The
first import in a vitest worker compiles the app's whole module graph while
the other workers compile theirs, and on a busy runner that took longer
than the hook's 10 s. In CI's failing runs, compiling took 30 and 43
percent of vitest's time, against 3 percent in the passing run, and the
first test file finished 9 to 14 s after vitest started, against 1.3 s.
`test/activity.test.tsx` loaded the app the same way.

The fix: both files load the app at the top of the module, as
`test/app.test.tsx` does. The import is then part of collecting the file,
which has no time limit, and no hook waits for it.

- Under load on a 4-core box, with 8 busy loops beside a full `vitest run`,
  its cache cleared each time, load average about 9: before the fix, 2 of 3
  runs timed out the Monitor file's hook at 10.0 s, as CI did. After it,
  10 of 10 runs passed the Monitor file, its 40 tests in 26 to 32 s each,
  with no hook timeout, and the Activity file's 35 tests each time.
- In those runs, and in the run before the fix that passed the Monitor
  file, 3 or 4 tests of `test/app.test.tsx` failed: they check times and
  counts that this load, about 2.5 times the cores, delays. They passed in
  CI and on a quiet box, where vitest passed 448 of 448.

### A lost ledger closes the cards it leaves unresolved

The lead decided, after merging PR 1349: a lost ledger still strips no
stopped guest's lines, at boot or after; instead it fails closed. A card
that a guest the rebuild left unresolved may hold takes no new placement and
no whole claim until that guest has asked again and been answered, and the
doctor names those guests. Before this, after a lost ledger, a running whole
box whose card a stopped box still had was refused, and until it asked
again, at its next start, another guest could be placed on its card, as
could any card a refused guest still had the lines of.

- The helper, now 0.3.1, keeps each such guest in its ledger: refused,
  `copy` or `ledger-lost`, or left out of the rebuild for an unreadable
  guest, while it may hold a card. It refuses a whole request on any card
  the guest may hold, and a shared one from a guest that holds no claim on
  that card, `unsettled`, naming the guest. The guest is settled by the
  helper's next answer to it in a normal decision, or when it has gone or
  holds no card. The report lists `unsettled <vmid> <uuid> g<N>`.
- With writes off, the rebuild now refuses such a whole box too, rather than
  leaving its request to be decided each pass: decided each pass, its first
  refusal, by a new guest's lines, settled it and opened its card.
- bb-box places no box on a card a report's `unsettled` line names for
  another guest, and the doctor's Markers on GPU guests names the guests and
  the cards they close: it fails for this install's, whose fix is `bb box
  gpu mark`, and warns for another install's.
- The version is 0.3.1 so that `setup-gpu.sh --writes on`, which needs the
  installed helper to be this release's, refuses 0.3.0.

Three new tests, and the writes-off recovery test (Astra 5, Opus 6), whose
expectation changes, fail on `be5ec8ca` and pass now: the helper granted a
new guest on the running whole box's card, and on a card a refused guest
had the lines of; with writes off, it left the whole box's request open;
bb-box placed a new desktop on such a card, which had the most memory free.
Then, as root on a `linux` box: `tsc` clean; the node suite, 3,586 tests,
3,291 passed, 0 failed, 295 skipped; vitest, 448 passed; the GPU and
Proxmox LXC test files on the commit itself, 269 tests, 268 passed, 1
skipped.

### After the final review

The final review of `be5ec8ca` and `a16b4536` (PR 1350) said no-go, with
three blockers and the node steps. Each fix has a test built from the
review's probe, which fails on `ecb9129e` and passes now.

| Finding | Fix | Test, and how it failed before |
| --- | --- | --- |
| F1: a start whose marker write met a changed config retried on whatever guest then had the VMID: another install's replacement was marked, the helper moved its devices, and bb-box started it | Each marker write, each retry included, reads the config, checks it names this install and this box, and writes on that config's digest; the same check comes just before the start. Otherwise nothing is written or started, and a failed acquire does not release the guest | `test/gpu-claims.test.ts`, with the fake Proxmox replacing the guest at the first marker write: the replacement was marked, written by the helper and started |
| F2: a ledger lost while `nvidia-smi` failed was rebuilt with no card known, so a running whole box got no hold; a later failed reading let an unresolved guest go | A lost ledger is rebuilt only from a full reading of every card; until then nothing is decided and the report says `ledger unknown`. An unresolved guest is let go only on a full reading that shows it holds no card, or an answer decided on one | `test/gpu-helper.test.ts`: the ledger was rebuilt with no reading, the whole box lost its claim, and a failed reading let the guest go. `test/gpu-claims.test.ts`: bb-box placed a desktop on the running whole box's card |
| F3: a query killed by a signal after every row read as exit 0, so the preview, `--check` and `--writes on` passed | A query counts only when it exited normally with status 0; any other end is an `error` line that blocks every decision and fails the preview | `test/gpu-helper.test.ts`: the preview exited 0. `test/gpu-setup.test.ts`, run on the old helper with its version: `--check` and `--writes on` succeeded |
| O6, P3: a moved box started again while it ran got its template's GPU fact | A running box's GPU fact names the card the helper's ledger has granted it | `test/gpu-claims.test.ts`: the second start named card 0 |

The helper is 0.3.2, so `setup-gpu.sh --writes on` refuses 0.3.1 and
earlier. bb-box reads a report that says `ledger unknown` as the helper
waiting to rebuild, in the start gate, placement and the doctor. The node
steps now run each step as a script under `bash -euo pipefail`, so a failed
command, pipeline or comparison stops it; leave E3's pause of the production
helper optional, with a resume armed by `systemd-run` before it; make E4
stand alone; and have `u5-guest.sh mark` write only on a guest whose tags
name the test install, on its config's digest.

Then, as root on a `linux` box, directly, on the commit rebased onto main
`46525aaa`: `tsc` clean; the node suite, 3,600 tests, 3,305 passed, 0
failed, 295 skipped; vitest, 448 passed. On `ecb9129e` before that, the
suite passed the same way, 3,592 tests, 3,297 passed; a run before that one,
on the same code, failed the writes-off
lock test (Astra 1): its pass took 2.3 s against 1.5 s under the suite's
load. Alone it passed 5 times of 5 on this commit and on `ecb9129e`, and a
helper pass took 35 to 100 ms on both.

### After the go review

The go/no-go review of `c26657bf` said no-go, with three findings. Each
review had found write paths the fix before it had not reached, so the lead
asked to close the class: every write bb-box or the helper makes to a guest
goes through one ownership check, a table lists them, and a test enumerates
them.

- **N1: one check for every write.** The Proxmox LXC backend, `bb box gpu
  mark` and the fork module the backend uses no longer call Proxmox's guest
  writes themselves. They go through `OwnedGuests` (`owned.ts`): it reads the
  guest's config, checks the owner each caller names (this install and this
  box, or for a held copy, a warm guest, an image box or a template what
  makes it this install's), and writes a config change on the digest of the
  config it just checked, so a guest changed meanwhile is not written; a
  change refused for that is read and checked again. Proxmox takes no digest
  for a start, stop, shutdown, disk resize, template or delete, so for those
  the check comes immediately before. A write the check refuses changes
  nothing, and a failed acquire then deletes nothing. The guests taken by
  the review's probes, at an acquire's labels and marker, as that write
  failed, and at a warm desktop's fill, are now left as they were.
- **N2: device mappings.** A card whose `/dev/nvidia` minor, or DRM card or
  render node, the helper cannot find is an `error` line. Like a card it
  cannot read, it blocks every decision on every card, a request for no
  card and every repair included; it keeps a lost ledger from being rebuilt
  and an unresolved guest from being let go; and it fails the preview, so
  `--check` and `--writes on` refuse. bb-box places no box while the report
  lists a card without its mapping.
- **N3: the node steps.** `u5-check.sh` fails, saying what is missing, when
  it cannot read the helper, its units, settings, report, ledger or any
  container config, and only a complete snapshot ends with `== check
  complete`. `u5-compare.sh` compares two snapshots, printing what it
  compared, and fails on a missing, empty or cut-short one. `u5-watch-check.sh`
  fails on a missing or empty watcher log, one with no start or sample line,
  or a `FAILED` line. Each step checks the lines it expects and prints them,
  and reaches `step <X> done` only when every check had its evidence.
  `u5-steps-test.sh`, with the node steps, replays the review's runbook
  probe off the node: its 14 cases pass, where the scripts before exited 0
  with no Proxmox files and printed `step F done` with no baseline or log.
- The helper is 0.3.3, so `setup-gpu.sh --writes on` refuses 0.3.2 and
  earlier.

Each fix has a test from the review's probes that fails on `7821f2f8` and
passes now: the acquire and the warm fill marked, retagged or deleted the
other install's guest; the helper previewed and decided with a card it
could not map, and rebuilt a lost ledger meanwhile; bb-box placed on it; and
the write enumeration listed every direct write the backend made. Then, as
root on a `linux` box, directly: `tsc` clean; the node suite, 3,608 tests,
3,313 passed, 0 failed, 295 skipped; vitest, 448 passed.

### After go review 2

Go review 2 of `33a6d637` said no-go, with three gaps. Each fix has a test
from the review's probes that fails on `c4eb8400` and passes now.

- **G1: start, stop and delete.** Proxmox takes no digest for these, so a
  guest replaced between bb-box's check and its request could still be
  acted on, and `destroy`, a compound call, stopped, cleared protection and
  deleted with no check between. Now:
  - The gateway calls only Proxmox's single-step writes. A delete is its own
    steps: check, stop if running (checked before and after), check, delete;
    a protected guest has its protection cleared only on the digest of the
    config just checked. A disk grows on the digest too. The enumeration
    test fails if any code, the gateway included, calls the compound
    `destroy` or `growRootDisk`.
  - Right after each start, stop, shutdown, template or delete, the gateway
    reads the config again. If the VMID now holds a guest that is not the
    one it acted on, bb-box acts on it no more, logs it, and the doctor's
    VMID range check fails, naming it.
  - Every owner refuses a guest whose tags name another install, but for the
    clone bb-box has just made, which carries its template's tags until
    bb-box labels it, and which it knows by the description it gave the
    clone. A warm guest is bound to the description it was made with, which
    names it uniquely, so another warm guest of this install is not taken
    for it.
  - bb-box takes no VMID, for an acquire, a warm desktop, an image box, a
    copy or a fork, while a guest that is not this install's is in its
    VMID range: one whose tags name another install, or one that is not
    bb-box's at all. The doctor's VMID range check fails, naming such
    guests.
- **G2: device nodes.** A card whose device nodes a guest needs are missing,
  `/dev/nvidia<minor>`, `/dev/nvidiactl`, `/dev/nvidia-uvm`,
  `/dev/nvidia-uvm-tools`, `/dev/nvidia-modeset` or its DRM card or render
  node, a dangling link included, is an `error` line, like an unmapped card:
  it blocks every decision and every repair, and fails the preview, so
  `--check` and `--writes on` refuse.
- **G3: the node scripts.** The watcher fails, logging `FAILED`, on any config,
  power, report or journal read that fails, and on a report with no helper
  line; `u5-watch-check.sh` fails a start or sample line with no containers
  or no helper line. `u5-check.sh` takes a guest with no GPU lines as valid,
  and a failed read of its config as a failure. The review's runbook probe
  passes on the new scripts; on the scripts before, the snapshot with a CPU
  guest failed and the watcher whose reads all failed passed its check.
  `u5-steps-test.sh` passes its 15 cases.
- The helper is 0.3.4.
- Four tests had two installs share a VMID range, which bb-box now refuses;
  each now gives the second install a range of its own and checks it still
  leaves the first's guests alone: the conformance suite's two-install check,
  which takes an install's refusal of a guest outside its range as leaving it
  alone, and whose Proxmox LXC run's fake node now reports its memory less
  what running guests use, as a node does; the LXC test of another install's
  guests, where desktops per GPU counts each install's own boxes; the
  doctor's full-range test; and the smoke run's.
- Then, as root on a `linux` box, directly: `tsc` clean; the node suite,
  3,614 tests, 3,319 passed, 0 failed, 295 skipped; vitest, 448 passed.

**The residual window.** Between bb-box's last check and Proxmox acting on a
start, stop or delete, another actor could put a guest at that VMID; Proxmox
offers no digest or lock for those calls. The window is bounded by keeping
each install's VMID range its own, which the doctor enforces and bb-box
refuses to work without: in a range that holds only this install's guests,
the only guest at a VMID is one this install made. bb-box's token can act
only on guests it can see, and a guest it cannot see it cannot start, stop or
delete. If another actor puts a guest in the range anyway, bb-box sees it on
its next read, at the latest right after the call, acts on it no more, and
the doctor names it.

### After go review 3

Go review 3 of `552781b3` said no-go, with two gaps. The lead decided to close
H1 on the node for GPU guests, where the harm is, rather than bound it by
ranges. Each fix has a test from the review's probes that fails on
`b76f248f` and passes now.

- **H1: start, stop and delete of a GPU guest go through the helper.** A
  guest with a card's device lines, or with a marker that claims a card, is
  started, stopped, shut down and deleted only by the helper, under the
  guest's config lock:
  - bb-box checks the guest is the box's, then adds one tag to it on the
    digest of that read: `bb-power.<action>.<install>.<box>.g<N>.n<nonce>`,
    the action `start`, `stop`, `shutdown` or `delete`, `<box>` the box ID
    the description names, or `-` for a held copy or earlier guest, `g<N>`
    its marker's generation, or `g0` with none. It waits for
    `power <vmid> n<nonce> <action> done` or `refused <reason>` in the
    report, then takes the tag off. It stops waiting at once if the guest
    at that VMID is no longer the box's or the tag is gone; a refusal
    `not-the-box` is recorded as a sighting, so the doctor's VMID range
    check fails, naming it.
  - A delete is: a stop through the helper if it runs, protection cleared on
    the digest of the config just checked, then the delete through the
    helper.
  - The helper, each pass after claims and repairs, with writes on or off,
    but not in the boot pass or a preview, takes each request it has not
    answered. Under `PVE::LXC::Config->lock_config_full` it reads the guest
    again and refuses the request if it is gone or changed (`withdrawn`),
    if the guest is a template or not in a pool it serves, if its install
    or box is not the request's (`not-the-box`), or its marker's generation
    is not (`generation`). It refuses a locked guest and an HA resource. A
    start needs a granted claim of the marker's generation, part and card,
    and exactly that card's device lines; a `gpu.none` guest may have no
    card's lines; an unmarked guest with a card's lines, as an image box
    has, starts only while no other guest holds one of its cards whole and
    none whose config cannot be read may; a pending device change, which a
    start would apply, is refused. A delete needs a stopped guest.
  - Then it calls what the API's workers call inside the same lock, read
    from pve-container 6.1.14's `PVE/API2/LXC/Status.pm`, `PVE/API2/LXC.pm`
    and `PVE/LXC.pm` as Proxmox's package repository publishes them:
    `vm_start($vmid, $conf, 0)`; `vm_stop($vmid, 1)` for a stop;
    `vm_stop($vmid, 0, 60, 1)` for a shutdown, killed after 60 s as bb-box's
    `forceStop` asked; and the delete with purge, as bb-box's API call
    asked: `check_protection`, `check_lock`, the HA check,
    `destroy_lxc_container` with the `destroyed` lock and unreferenced
    disks, `remove_vm_access`, `remove_vmfw_conf`, `remove_vmid_jobs`,
    `remove_vmid_from_backup_jobs` and `destroy_config`. None of these takes
    the lock again. They were not run on a node; the tests run them as
    fakes that fail when the lock is not held.
  - Each request is acted on once: its answer is kept in the ledger's
    `power` part until its tag is gone and the answer is 10 minutes old.
  - bb-box sends requests to a helper of 0.4.0 or later. With an older one,
    and none newer seen since this BB started, it uses Proxmox's API as
    before, until the node is upgraded; `--writes on` needs 0.4.0. Once a
    newer helper has reported, a report with no helper line, or one 3
    minutes old or more, refuses the action at once, saying why. The
    protocol stays 1: older helpers ignore `bb-power.` tags.
  - The review's probes inject the replacement at Proxmox's start, stop or
    delete call, which bb-box no longer makes for a GPU guest. The tests
    inject it there and also where the helper acts: as bb-box's request is
    written, by another box of the same install, or of another install,
    carrying the request, before the helper's pass; and in the helper,
    while another process holds the guest's config lock. The replacement is
    not started on a card held whole, stopped or deleted.
- **Non-GPU guests** keep Proxmox's API for start, stop and delete, with the
  window this review found. It predates 071 and is not this unit's: see
  Follow-ups.
- **The doctor's VMID range check** keeps failing on a guest it can see that
  is not this install's, a description naming another install behind a
  bare `bb-box` tag included. It now says what it cannot see: the token sees
  only the guests of its pool, so a guest elsewhere in the range, or another
  install's range overlapping this one, is not seen, and the check is no
  proof that the range is this install's alone.
- **H2: the node scripts.** `u5-check.sh`, `u5-compare.sh` and `u5-guest.sh`
  check each read's status: a config, ledger or report that cannot be read,
  hashed or parsed fails the script. `u5-compare.sh` fails on `diff`'s error
  status, 2, and reports the difference on its status 1. The review's runbook
  probe passes on the new scripts and fails on those before;
  `u5-steps-test.sh` passes its 21 cases.
- The helper is 0.4.0. The setup tests' fake newer releases move above it.
- Two tests that started a box on a stale report now expect the start
  refused, then made through the helper once it reports again; the go
  review 2 tests of a replacement at the start and the delete inject it
  where the helper acts.
- Then, as root on a `linux` box, directly: `tsc` clean; the node suite,
  3,621 tests, 3,326 passed, 0 failed, 295 skipped; vitest, 448 passed. The
  9 tests named for go review 3 fail on `b76f248f`, its source and helper
  with these tests, and pass now.

### After go review 4

Go review 4 of `b53a4f93` said no-go, but close: it confirmed the GPU power
path against pve-container 6.1.14's source, and found three gaps and three
smaller ones. Each fix has a test from the review's probes that fails on
`b53a4f93` and passes now. The helper is 0.4.1.

- **N1: every box's power goes through the helper.** bb-box chose between
  the helper and the API from the config it read before the action, so a GPU
  desktop of the same install that took a box with no GPU's VMID after that
  read was started on a card held whole, stopped or deleted through the
  API. Now, on a node whose helper is 0.4.0 or later and serves the
  install's pool, every start, stop, shutdown and delete of a guest in the
  install's VMID range goes through the helper, GPU or not, whatever the
  read showed; outside the range, so does a guest with a GPU's lines or
  marker that is not a template. For a box with no GPU the helper checks, in
  the lock, that it is still that install's box, with no card's lines and no
  pending device change, so nothing it would need a claim for. A captured
  build, a template in the range, is deleted through it too, named by its
  install tag; a template is never started.
- **N2: what the node does is kept across restarts.** bb-box keeps, in its
  storage, the helper version it last read for each node, by API URL and
  node. While that is 0.4.0 or later, a report that is missing, has no
  helper line or cannot be read refuses the action at once, saying why,
  after a restart too; bb-box never falls back to the API. A report that
  names an older helper, as after a downgrade, is read as it says. Without
  such a record, as on an install's first contact with a node, bb-box still
  refuses a guest with a GPU marker, and a GPU guest whose report it cannot
  read; a box with no GPU, there, uses the API until bb-box first reads the
  helper.
- **N3: step D** greps for the release's own version, and
  `u5-steps-test.sh`, given the helper, checks that every helper version the
  steps look for is the helper's.
- **N4: an untested pve-container.** The helper stops a guest on a
  pve-container its release was not tested on, and refuses to start, shut
  down or delete one, `untested`, as writes stay off there. By the lead's
  decision, bb-box then sends a box with no GPU, one with no card's lines, no
  marker and no pending device change, through Proxmox's API with its
  ownership checks, as before 071, so it still starts, stops and is
  released, a failed acquire's cleanup included. A GPU desktop or a marked
  guest may only be stopped, and the refusal names the version. The doctor
  fails, naming the version and the helper release to install. So the API
  window between bb-box's check and Proxmox's action reopens for boxes with
  no GPU, and only while the node's pve-container is one the helper was not
  tested on.
- **N5: a card held whole.** A start is refused, `card-busy`, while another
  guest running on its card holds or claims the card whole, or the guest
  starting holds or claims it whole; and `unsettled` on a card a guest the
  lost ledger left unresolved may hold. Both happened through the API before
  this unit too.
- **N6: a warm guest** is named in its request by its `warm` token, which
  its description carries uniquely, from helper 0.4.1; another warm guest of
  the install carrying the request is refused `not-the-box`.
- The review's crossover, restart and whole-card probes inject where bb-box
  calls the API, which it no longer does on such a node; the tests inject
  there and also as bb-box's request is written, and in the helper while
  another process holds the guest's config lock. The review's probe of an
  untested pve-container expects even a stop refused; the lead's rule keeps
  the stop.
- Tests that started a GPU desktop on a helper's untested pve-container, or
  matched the stale report's words, now expect the start refused; the doctor
  fails for an untested pve-container from 0.4.1.
- Then, as root on a `linux` box, directly: `tsc` clean; the node suite,
  3,630 tests, 3,335 passed, 0 failed, 295 skipped; vitest, 448 passed. The
  11 tests named for go review 4 fail on `b53a4f93`, its source and helper
  with these tests, and pass now. `u5-steps-test.sh` passes its 22 cases.

### After go review 5

Go review 5 of `19678ee8` said go for the node steps, on two conditions: no
undo with `--remove`, and no pve-container upgrade on the node until F1 is
fixed. These are the follow-ups, each with a test that fails on `000cd517`.

- **F1: no GPU desktop left behind on an untested pve-container.** There the
  helper only stops guests, so a GPU desktop's clone could be neither started
  nor deleted. Now:
  - An acquire of a GPU kind, with no warm guest to take, and a warm fill of
    one, are refused before the clone, with words naming the version and the
    helper release to install; the warm pool's shortfall says the same.
  - bb-box keeps in its storage, by node, each clone it makes until its first
    start, with the description it gave it. On an untested pve-container, a
    delete of such a clone, still stopped and with that description, goes
    through Proxmox's API with the ownership checks, marked or not, so a
    clone caught by the version changing between that check and its start
    is deleted. So is a warm guest of the install left stopped in `filling`,
    a fill that never finished, as an untested pve-container left them
    before. bb-box's sweep releases both, after a restart too.
  - A GPU desktop that bb-box has no record of leaving unstarted is still
    only stopped there.
- **F2: the way back.** From bb-box-gpu 0.4.0 the helper starts, stops and
  deletes the install's guests, and each BB that has read it keeps that, so
  removing it would leave those BBs refusing every box's power on the node.
  `setup-gpu.sh --remove` is now refused while 0.4.0 or later is installed,
  unless given `--force`, and says the ways back: `--writes off`, which keeps
  the helper's power, or `setup-gpu.sh --downgrade` from the release with
  bb-box-gpu 0.2.0. A BB reads that version at its next box action on the
  node or doctor run, which now also refreshes what it keeps, and uses the
  API again. The setup README, `--help` and the node steps say so, and offer
  `--remove` only after that.
- **F3: the node steps' comparisons** compare only GPU guests, those with a
  card's device lines or a gpu tag in either snapshot, and the watcher logs
  changes of those only, so production's plain boxes coming, going,
  starting and stopping do not fail them. `u5-steps-test.sh` checks it.
- The test of an untested pve-container now expects no GPU desktop made.
- Then, as root on a `linux` box, directly: `tsc` clean; the node suite,
  3,634 tests, 3,339 passed, 0 failed, 295 skipped; vitest, 448 passed. The
  4 tests named for go review 5 fail on `000cd517`,
  its source and setup with these tests, and pass now. `u5-steps-test.sh`
  passes its 26 cases.

### Every write to a guest

`test/guest-writes.test.ts` enumerates these with TypeScript's checker: it
fails if any code in `src/backends/proxmox-lxc` or the fork module calls one
of Proxmox's guest writes other than `owned.ts`, if anything calls a
compound one (`destroy`, `growRootDisk`), if the gateway calls other than
the single-step ones, hands Proxmox's client to a
function that takes the checked writes, or writes through the check from a
function this table does not name. For the helper, it checks that the only
container write is `change_guest`, and that each call of it is in a
`with_guest` callback that holds the guest's config lock and finds it the
same guest.

| Writer | Guest | What it writes | Whose it must be |
| --- | --- | --- | --- |
| `acquire` | the guest it cloned, or the one it resumes | cores and memory, labels and marker, start, delete when refused or failed | box (the clone's description names this install and box until its labels do) |
| `#grow` | the same | its disk | box |
| `#settle`, `#settleWeight`, `settle` | a box's guest | the start weight and its tag | box |
| `#gateStart`, `#gateOnPin`, `#writeMarker`, `start`, `#startOnAnotherCard`, `#stopAndLetGo`, `#resumedWithoutItsGpu` | a box's stopped guest | its marker, its start; `#gateOnPin` reads only, for a restore's start on the card it holds; `#startOnAnotherCard` stops a server bb-box has just started that did not see its card, and starts it once more on another, and `#stopAndLetGo` stops it when it lists other cards or none (unit 7); `#resumedWithoutItsGpu` reads only, a resumed acquire's guest | box |
| `powerOff`, `stop` | a box's guest | stop | box |
| `release` | a box's guest | delete | box |
| `resize` | a box's guest | cores, memory, disk | box |
| `hold`, `#retag`, `relabel` | a warm guest a box takes, a box's guest | name, memory, description, labels | warm guest of this install, then box |
| `stamp` | a box's guest from before install IDs | its install label | the guest names the box and no install |
| `copyGuest`, `labelCopy`, `labelKept`, `disarmCopy`, `templateCopy`, `deleteCopy`, `retireGuest` | held copies and earlier guests | network, labels, keep date, template, delete | held copy or earlier guest of the box, of this install |
| `adoptCopy`, `forkSnapshot`, `armAdopted`, `#armWithClaim` | the guest a restore or fork has just made | network, size, labels, marker; `armAdopted` its marker and its start at boot, once its claim is granted and its lines checked | its description names this install and the box it is made for |
| `releaseGpuClaim`, `armReturned`, `#armWithClaim` | a swap's old guest | its `gpu.none` marker with its start at boot off, in one write; its claim and start at boot back, once granted and checked, when the swap fails | box |
| `#writesFor`, `disarm`, `armFork`, `dropHalfMadeFork`, `forkByFullClone` | a fork's guest, in the fork module | network, delete | as above, or box |
| `#fill`, `#topUp`, `#retireForWhole` | warm guests | cores and memory, labels and marker, start, retirement, delete; `#retireForWhole` retires and deletes this install's warm desktops on a card it keeps whole for a box (unit 8) | the warm guest of this install that bb-box made, by its description |
| `#imageBox`, `#capture`, `#removeImage` | image boxes and builds | settings, labels, start, shutdown, template, protection, delete | image box or build of this install |
| `#askPower` | a guest bb-box starts, stops, shuts down or deletes through the helper | the helper's request tag, added and taken off | the owner of the action asked for |
| `#replaceTemplate` | a configured template, and the guest made in its place | protection, delete, template, labels | the template as read, then the guest with the description bb-box gave it |
| `planAndWrite` (`bb box gpu mark`) | a guest of this install | its gpu tags | the guest bb-box looked at, on that look's digest |
| `change_guest`, in the helper | a container it serves | GPU device lines; for a copy proven not re-armed (its description names another box than its tags, or a held copy its tags do not label yet), also its start at boot, off, with a card or none | under the guest's config lock, the same box, install, kind, pool and gpu tags it scanned, and still such a copy |
| `decide_power`, in the helper | a container it serves that carries a request | start, stop, shutdown, delete | under the guest's config lock, the install, box or warm token, and marker generation the request names |

Not through the check, and why:

- A clone or full copy makes a new guest at a free VMID; Proxmox refuses one
  that is taken.
- The shared snapshot module's snapshot, rollback, snapshot delete and
  snapshot description act on a snapshot, after its `still` check that the
  guest names this install and box, as before; Proxmox takes no digest for
  them.
- The helper's other write is its own report VM's notes.
- The Proxmox QEMU backend's writes, to VMs no GPU desktop uses, are not
  part of unit 5 and are not changed.

### The node steps

Wait for the lead, after unit 4's day has passed and this unit is merged and
deployed: the helper upgraded to 0.4.0 with writes off and the test pool
served; `setup-gpu.sh --writes on --check`; `--writes on`; a watcher under
`systemd-run`; the gate on test guests on lent VMIDs, through a test BB with
its own pool and desktops per GPU 1. The steps, a read-only check script,
the watcher and a harness for the lent VMIDs are in the report to the lead.

### Deviations from the note

- Boxes per card is the existing desktops per GPU (no limit unless set),
  and it counts this install's boxes holding a card, as desktops per GPU
  did. Every guest holding the card counts in choosing among cards. On a
  node shared with the owner's boxes, the gate's "boxes per card 1" can
  only be met that way. The key `boxes-per-card` and its default of 4 come
  with units 7 and 15.
- Memory is not part of the start gate: a stopped desktop starts on its card
  as before, its display falling back to the CPU when the card is short. For
  new boxes the memory rule is as before, soft: a card read full is left out
  while another is left, now less what is reserved on it.
- Until writes are on, the start gate moves no box: it starts it on the card
  it holds, once its current marker is granted, asking the claim the helper
  holds again where that marker was refused or cannot be carried out with
  writes off. With writes on, section 3's rule applies, on cards a desktop
  template names.
- A helper on a pve-container its release was not tested on is taken as
  writes off: desktops are made and marked. The lead decided this (Opus 3).
  From helper 0.4.1 it also starts, shuts down and deletes no GPU desktop or
  marked guest there, only stops them (go review 4, N4), so a desktop is
  made but not started, and the doctor fails rather than warns. Boxes with no
  GPU go through the API.
- A box with a GPU marker starts only on a grant the helper reports. With the
  helper removed, marked boxes do not start until it is back, so `bb box gpu
  mark --undo` comes before a removal for good.
- A refused acquire is placed once more by releasing its guest and cloning
  from the other card's template, as templates still carry their card's
  lines until unit 7.
- The marker gains `gpu.release.g<N>`, answered `released`, within protocol
  1: older helpers refuse it as malformed and change nothing, and bb-box
  sends it only to 0.3.0 or later.
- `--undo` clears claims, as the lead's brief asked, rather than being
  refused; it does so for every shared or whole marker of this install,
  bb-box's own included, as each is the same claim.
- Writes on needs two keys, `gpu.conf` and units without `--dry-run`, set
  together by `setup-gpu.sh`, and a clean preview first.
- The card lock and reservations are per BB process, by API URL and node;
  two BBs on one node rely on the helper, as the note has two installs do.
- Recovery names unanswered markers in the server's log and the doctor's
  Markers on GPU guests check; `proxmox.gpu-claims` is not added yet.
- A release takes no card lock: the guest's place goes when the report no
  longer lists it.
- A box from an image build (049) is made as before, unmarked, and a warm
  desktop made before this release has no marker: `bb box gpu mark` marks
  them, and the doctor names them meanwhile.
- A lost ledger strips no stopped guest's lines, at boot too (R3, the lead's
  rule, kept by the lead's decision after the re-review). Before, a lost
  ledger at boot stripped a stopped guest whose lines did not match its
  marker, so that its `onboot` start could not use a card no claim names.
  Now it is refused, `ledger-lost`, and keeps them. bb-box asks again before
  it starts the box, but a start outside bb-box, by `onboot` or by hand,
  uses those lines until then. Every card it may hold is closed meanwhile,
  as above.
- With writes off, a lost ledger's whole box whose card a stopped shared box
  still has is refused `ledger-lost`, as with writes on, rather than left to
  its request. Left to its request, the helper decided it again each pass,
  and the first refusal, by another guest's lines, opened the card.
- Two installs on one Proxmox LXC backend need VMID ranges of their own (go
  review 2). Before, an install left another's guests in its range alone and
  went on; now it takes no VMID while one is there, and the doctor fails,
  naming it. A pool may still be shared.
- With the desktop kind off, or its templates cleared, a stopped box with a
  marker still goes through the start gate. It may start on the card the
  helper holds for it, and is moved to no other.
- From helper 0.4.0, every guest of the install in its range on a node
  whose helper serves its pool starts, stops and is deleted only through the
  helper (go reviews 3 and 4). With the helper stopped, or its report 3
  minutes old, missing or unreadable, no box there starts, stops or is
  released until it is back; before, a box whose claim stood still started
  on a stale report. The helper's pass waits for each start, and for a
  shutdown up to 65 s, so other markers and requests wait meanwhile.
- The helper starts, stops and deletes with writes off too. On a
  pve-container its release was not tested on it only stops, so after a
  `pve-container` upgrade the install's GPU desktops and marked guests on
  that node are not started or released until a helper release tested on it
  is installed; boxes with no GPU go through the API meanwhile, with its
  window. It refuses a guest with any lock, `mounted` included, which the
  API allows, and an HA resource.
- Choosing among the templates on a card still counts boxes by the template
  each was made from, as does the path with no helper. A box moved to another
  card counts against its first template there. It changes only which of a
  card's templates a new box is cloned from, never the card; without a
  helper, no box moves.

### Still open

- Whether boxes per card should count every install's boxes, as section 12's
  words suggest, once the node has no other install's boxes on the cards.
- The node's E3 step pauses the production helper for up to 45 s
  (`SIGSTOP`), so that a marker stays unanswered; production markers wait
  meanwhile. Skip it if that is not wanted: the suite and the live check
  cover it.
- Fork, restore, held copy, earlier guest and swap are unit 6's. With writes
  on, today's copies give the helper no write to make: each copy's
  description names its own box from the clone, and a held copy's or an
  earlier guest's labels drop the marker.

### Follow-ups

- On a node with no helper of 0.4.0 or later serving the install's pool, a
  guest's start, stop and delete still go through Proxmox's API, which takes
  no digest or lock for them: another actor that puts a guest at the VMID
  between bb-box's last check and Proxmox's action has that guest acted on,
  and bb-box sees it only on its next read (go review 3, H1). This predates
  071. On a node whose helper does, every guest of the install in its range
  goes through the helper (go review 4, N1), which closes it there for the
  Proxmox LXC backend, but for boxes with no GPU while the node's
  pve-container is one the helper was not tested on (N4). The Proxmox QEMU
  backend is not changed.
- A box with no GPU on an install that has never read the node's helper, as
  on its first contact with the node, uses the API until it first does, if
  the report is missing then.
- A GPU desktop's clone that an untested pve-container left behind before
  go review 5, made by an acquire rather than a warm fill, is not recognised
  as never started: it stays stopped until a tested helper deletes it, or
  it is deleted by hand. None can exist on a node whose pve-container was
  held at a tested version.
- Guests with no box ID other than warm guests, that is image boxes, held
  copies and earlier guests, are named in a request by install and marker
  generation only: a replacement would have to carry bb-box's request tag
  with its random nonce.

## Unit 6: snapshot safety

Built on main `e64cc838` in four commits, after three rounds of two
reviews each (Astra, Fable), and merged as `21d79fcb` (PR 1363). It ships
bb-box-gpu 0.4.2. Production's bb-box was deployed with it before the
helper was upgraded, as section 5 now requires.

### What it does

- **A fork starts with no card, unless asked for one.** `box_fork`, `bb
  box snapshot fork` and the fork form take `gpu`, none by default, or
  shared for a `linux-desktop` on a backend that places a fork's GPU. A
  shared fork is placed and its card reserved before anything is copied.
  The fork's marker goes in the same write as 070's re-arm. Whole, and
  shared for any other kind or backend, is refused before any record.
- **A restore keeps the box's card.** The restore records the box's claim
  and reserves its card, under the card lock, before the stop. After the
  rollback it writes the box's current marker with a new generation, a
  recorded step (`claim-kept`), unless the rolled-back marker is already
  that granted claim. A box with no GPU needs no helper. The start uses
  that exact claim and refuses rather than move cards. A card with no room
  refuses the restore before anything changes; after a restart, recovery
  holds the card again, or leaves the box stopped and says why.
- **A swap moves the claim.** The old guest's marker is set to `gpu.none`
  with its start at boot off, in one write (`claim-cleared`). The new guest
  is made with its start at boot off, then gets the box's claim with a
  generation above every ledger entry of its box, named `install/box` as
  the helper names it. Its lines are checked, and only then does it get the
  old guest's start at boot (`claim-given`). If the new guest cannot be
  made after the clear, the old guest gets the claim back, granted and
  checked, and its start at boot back, before it starts; if the helper does
  not grant it, the box stays stopped at `claim-back` and the next sweep
  tries again.
- **Held copies and earlier guests carry no claim.** Each gets `gpu.none`
  in its disarm or retire write, and the helper takes its lines out.
- **The helper refuses copies a claim.** From 0.4.2 a copy whose
  description names another box than its `box.` tag is refused as not
  re-armed. Any copy bb-box was making when it stopped, proven by its own
  labels, marker or not, loses its NVIDIA lines and its start at boot, in
  one write under its config lock while it is stopped, on each pass and on
  the boot pass. That is the helper's only write outside device lines.
- **The doctor's `gpu.<card>.whole`** passes when a card held whole has no
  other holder, and fails naming the guests.
- **Live-check holds** at `claim-kept`, `claim-cleared` and `claim-given`
  join the others, for the node steps and the tests.

### What was run

On `linux` boxes, as the box user and as root, as CI runs them, on the
final commit `93e84764`, merged as `21d79fcb`:

- `tsc` clean. The node suite as root: 3,662 tests, 3,366 passed, 0
  failed, 296 skipped. As the box user: 3,328 passed, 0 failed, 334
  skipped, the root-only `gpu-setup` tests among the skipped. vitest: 451
  passed. One vitest UI test (a thread card's spinner, not touched here)
  failed once in a full run and passed three runs alone and the next full
  run.
- `test/gpu-restore.test.ts` drives restores and swaps through `Snapshots`
  against a fake card ledger, with restarts at `rolled-back`,
  `claim-kept`, `claim-cleared`, `adopted`, `claim-given` and
  `claim-back`, and a crash after the clear but before its step was
  recorded.
- `test/gpu-restore-helper.test.ts` runs the backend against the real
  helper on the fake node: a held copy from before this unit with another
  card's lines and no marker; generations after a restart; the card held
  through a restore; a restore with no GPU never reading the helper; the
  old guest's start at boot; the driver read from an indented report.
- `test/gpu-helper.test.ts`: unmarked copies, held copies' clones before
  their labels, a fork of a legacy held copy and card-free copies lose
  their lines and their start at boot, on a pass and on the boot pass,
  while an ordinary unmarked guest keeps both.
- Each fix was reverted once on a box, and its test failed: 11 reverts
  after the first reviews, 8 after the second, and after the third the
  helper's card-free rule and the setup fixtures, whose old versions
  failed 3 runs of 3 as root.

### The live check

Run by the lead on the node and by the builder on a test BB, on 5 November
2026 (UTC). The test BB was a fresh `npx bb-app@0.48.1` on a Proxmox LXC box,
with no account, bb-box installed from `git archive 21d79fcb`, and
`BB_BOX_LIVE_CHECKS=1`. Its server ran as a systemd unit, so "stop the test
BB" was a `KILL` of the unit's whole cgroup, and iptables let only the lent
addresses reach its ports. The lead added its Proxmox LXC backend: a pool
of its own, five lent VMIDs and addresses, desktops per GPU 1, production's
desktop templates. S was a GPU desktop made as one of the person's machines.
Both cards had about 97 GiB free throughout; nothing loaded them beyond two
desktops' displays.

Proxmox LXC marks only the `linux` kind for the identity reset, so a
`linux-desktop` there is never fork-safe, and bb-box neither forks it nor
takes a held copy of it. With the lead's agreement, S's identity marker was
written by hand inside S (`bb-box-identity enable`, then `write --box
<S's box> --source eth`, then a stop and a start) so that every step could
run. Production desktops cannot reach the fork, held-copy and swap paths
below until desktops get an identity source.

| Step | Evidence |
| --- | --- |
| 0 | Production's `bb plugin source bb-box` resolved `21d79fcb9b7f`, on main at unit 6; its doctor passed the GPU helper (0.4.1, writes on) and the markers |
| A, B | 0.4.2 and 0.4.1 copied in. `setup-gpu.sh`: the preview would write no guest; 0.4.2 restarted with writes on; `u5-compare.sh`: no guest changed. Production's doctor: Host's GPU helper ok on 0.4.2. A production desktop made, stopped, started and released through it |
| C | The watcher started |
| D, fork none (11:13) | The fork F: `gpu.none.g2`, claim and ledger g2 granted none, no card lines, journal `granted CT <F> g2: none`. Its source marker had been refused `not-served` (g1) in the copy window. S kept card 1 |
| E, fork shared (11:15) | F on card 0 at g3, granted, holding it running; S on card 1. A third fork exited 1 naming both cards at their limit, and no lent CT came or went. The words checks failed: see the findings |
| F, restore after a move (11:17) | The harness moved S to card 0 at g2 (488 ms). The restore's check said "Its GPU stays as it is now: shared, card 0"; it exited 0. S ran on card 0 at g4, the ledger granted g4, and the journal has the grant |
| G, held copy (11:19) | The undo's held copy C: `gpu.none.g5` granted none, no card lines, onboot 0, not a template; then a template with the same tags and no lines. The restore exited 0 |
| H, swap (11:23) | OLD cleared to `gpu.none.g7`, no lines, onboot 0. NEW held with no claim and onboot 0 while the swap waited; then `gpu.shared` card 0 g8 granted, running, onboot 1. One lent holder of card 0. The restore exited 0, "It runs on a new guest made from that held copy" |
| I1a, fork's copy, shared marker (11:26) | The test BB stopped 1 s after the fork claimed its guest; the clone task was running, the copy locked `create` with onboot 1 and S's marker. Helper: `refused … g8: not-served`, then `wrote CT <copy> for not re-armed: remove dev0 /dev/nvidia1 …; add nothing; start at boot off`. No lines, no holder, onboot 0. Restarted, 070 deleted the copy and made the fork again |
| I1b, fork of a held copy (11:33) | The clone was seen running. The copy: `gpu.none.g6` and held-copy tags, `refused … g6: not-served`, no card lines, no holder, onboot 0. 070 deleted it and made the fork again |
| I1c, snapshot with no marker (11:35) | S's marker taken off by hand for the take, then put back at g9 (458 ms). The clone was seen running. Helper: `wrote CT <copy> for not re-armed: remove dev0 /dev/nvidia1 …; add nothing; start at boot off`. No gpu tag, no lines, no holder, onboot 0. 070 deleted it |
| I2, rollback and re-tag (11:42) | The harness moved S to card 1 at g10. Held after the rollback: S's tags carried the snapshot's card 0 g9, the ledger card 1 g10; the helper wrote card 1's lines in while S was stopped (`wrote CT <S> for claim g10`). Test BB stopped. S stopped on card 1's lines with onboot 1, as the box itself; the boot pass by hand: `0 running guests on the wrong lines`, the same after. Restarted: S ran on card 1 at g11 |
| I3, swap's gap (11:45) | Held at `adopted`: OLD `gpu.none.g12`, no lines, onboot 0; NEW no marker, no holder, onboot 0. Test BB stopped; the boot pass by hand left both onboot 0 with no lines. Restarted: NEW granted card 1 g13, running, onboot 1; OLD, an earlier guest, onboot 0 |
| I4, failed swap (11:48) | Every lent VMID in use. The restore cleared S at g14 (11:48:34), could not make the new guest, gave the claim back on card 1 at g15 (11:48:35) and started S: running, onboot 1. It exited 1: "… Nothing on its disk changed, and bb-box started box <S> again as it was." |
| I5, held copy's template step (11:49) | Held after the clone: C `gpu.none.g16` granted none, no lines, no holder, onboot 0, not a template. Test BB stopped. Restarted: 070 deleted C, made the copy again in another lent VMID, and finished the restore; no lent template had NVIDIA lines |
| J, boot pass (11:53) | `boot pass: 0 running guests on the wrong lines, writes on`; no mismatch; each card 4 holders, none whole. The test BB's doctor: `GPU 0 whole` and `GPU 1 whole` pass, "No box holds card N whole" |
| K (11:53) | Lent VMIDs empty. The helper wrote and refused no guest outside the lent VMIDs from 11:08. Production's doctor: the GPU helper, migration, report and both `gpu.<card>.whole` pass |

Where the lead changed a block on the node: `read </dev/tty` does not work
over ssh, so E, I2, I3 and I5 ran in two halves; I3 and I5 dropped a rule on
claim history at a reused VMID and judged the guest by its own config;
`u5-compare.sh` ran against a baseline taken after D (`d-rebase.txt`),
since a production warm desktop and its replacement, from the smoke test
after B, changed meanwhile; step J's mismatch check left out
`u5-check.sh`'s `mismatch lines: 0` summary. The test BB's side used two
helpers for restores (`--check`, then `--replace` in the background), and
for I1 a script that stopped the test BB one second after the fork had
claimed its guest, as a relayed message would land too late.

Limits: the cards loaded nothing; at most two test desktops; one node; a
test BB with one install; S's identity marker by hand.

### Findings from the live check

| Finding | Severity | What happens | Follow-up |
| --- | --- | --- | --- |
| Desktops have no identity source on Proxmox LXC | high, for the gate | bb-box never marks a `linux-desktop` there for the identity reset, so it forks no GPU desktop and takes no held copy of one. Section 16's gate item "a fork of a GPU desktop with none and with shared" cannot be met on production desktops; it passed here only with the marker written by hand | 070: an identity source for `linux-desktop` on Proxmox LXC (`eth`, as `linux` has), and its live check |
| A shared fork with no card free gets the acquire's words | medium | The provider's capacity check at the fork's admission refuses it before `placeForkGpu`, with "Release a desktop box, or raise the desktops per GPU", not "Not forked: … bb-box copied nothing". An agent's `box_fork` may be told to release a box or change a setting, against section 3 | The fork's own refusal for each audience, and a test of both |
| The snapshot store drops the snapshot's GPU record | medium | `SnapshotRecord.gpu` has no column in `snapshot-store.ts`, so every restore's check says "GPU not recorded", and section 9's userspace-mismatch warning can never show | A column and its migration, and a test through the real store |
| A fork with gpu none names a card in its facts | low | The fork's box facts named a card's GPU ID while it had no lines and no claim | The facts from the claim, not the template |
| A fresh clone's first answer is `not-served` | note | Proxmox adds a clone to the pool after its config exists, so the helper's first answer to the copy's inherited marker is `refused not-served`, not `copy unrearmed`. The copy still lost its lines and its start at boot, as a proven copy | Steps accept either answer, keyed to the copy's own generation |
| Rules on claim history at a reused VMID | note | A lent VMID used before keeps its earlier guests' `claim` lines in the report for 10 minutes, so a rule that a line exists, or does not, can match an earlier guest | Steps key such rules to the generation on the guest's own tags, or drop them |
| Step J's mismatch check | note | `^mismatch ` also matches `u5-check.sh`'s `mismatch lines: 0` | `^mismatch [0-9]+ ` |
| `read </dev/tty` pauses | note | They do not work when the lead runs a block over ssh | Each such block split in two |
| `watch_clone` | note | The lead's copy failed at once on an extra `cat` under `pipefail`. The library's own config checks pipe `conf_of` into `grep -q` under `pipefail`, which can fail the same way when grep exits first | Config checks read a here-string (`conf_has`), and `watch_clone` uses it |
| The kill wrapper | note | The builder's first wrapper returned while the unit was still deactivating | It waits until the unit has stopped |

### Deviations from the note

- A fork with gpu shared is offered only for `linux-desktop` and only on a
  backend that places a fork's GPU; whole waits for unit 8.
- The helper writes one key besides device lines: `onboot`, set to 0 on a
  copy proven not re-armed, so a crash-left copy never starts at boot.
- The restore refuses before the stop when the box's card has no room for
  it, rather than moving it to another card.
- `claim-back` is a restore step of its own: a failed swap whose claim the
  helper does not give back leaves the box stopped and the restore
  unconfirmed, retried at each sweep.
- `giveGpuClaim` became `armAdopted`, which also sets the new guest's start
  at boot; `armReturned`, `bootsWithNode`, `holdGpuCard` and `dropGpuCard`
  join the backend's optional methods.

### Still open

- The identity source for desktops, above: until it comes, units 7 to 9 that
  rely on forks or held copies of desktops cannot be checked on production
  desktops.
- I4's other path, where the helper does not give the claim back, was not
  run on the node, as it needs the production helper paused. The tests cover
  it.

## Unit 7: servers with a shared GPU on Proxmox LXC

Built on main `98753c5e`, on branch `u71-7`, then rebased over #1370, #1371
and #1373 and merged as `3f6d8395`. No helper change: bb-box-gpu
0.4.2 already gives a guest whose kind is not a desktop the server set of
device nodes. No GPU server is offered on a node until one of its Linux
templates has NVIDIA's userspace for the host's driver, so production is
unchanged until the lead rebuilds its Linux template, after the gate.

### What it does

- **The Linux template carries NVIDIA's userspace.** `build.sh linux` on a
  host with a driver installs exactly that driver's userspace, with no kernel
  modules, as `build.sh desktop` does; `--cpu` leaves it out, and a host with
  no driver builds without it. Both templates share one installer script,
  `guest/nvidia-userspace.sh`. It gives the installer Ubuntu's paths,
  `--x-library-path=/usr/lib/x86_64-linux-gnu
  --x-module-path=/usr/lib/xorg/modules`, so the X driver lands in
  `/usr/lib/xorg/modules` on a server too, not the `/usr/lib64` the installer
  guesses where there is no X server (unit 0, step 8). The template's
  description and image record carry the version.
- **NVIDIA's EGL and Vulkan drivers only in a box with a card**, as the lead
  decided. `bb-box-nvidia-drivers.service`, a oneshot early in each boot,
  renames NVIDIA's EGL vendor file, its EGL external platforms, its Vulkan
  ICD and its implicit Vulkan layer to `<name>.bb-box-no-card` while the box
  has no `/dev/nvidiactl` and `/dev/nvidiaN`, and back once it has. NVIDIA's
  GBM platform is shown only with a DRM render node too, which a server's
  card does not have. A file the installer puts back while hidden is the one
  kept.
- **`pct fstrim` before the template.** Each build trims its CT's file
  system, after `finalize.sh` and before the shutdown, so the template does
  not keep the installer's deleted blocks (about 2 GB, unit 0, step 8). A
  storage that cannot discard says so and the build goes on.
- **The image record keeps `nvidia`.** `build.sh`'s second push wiped the
  build directory in the CT, `extra-release` with it, so every Proxmox LXC
  template's record had `nvidia` null, desktops' included. The file is now
  carried across the push. bb-box reads a Linux template's userspace from
  its record.
- **One GPU desktop template with no device lines.** `build.sh desktop`
  gives the template no device lines; `--gpu <pci>` still gives it one
  card's, and `copy-desktop` another's, for a host without the helper. The
  devices go on the next free `devN`, so a copy's TUN line is never
  overwritten. The GPU desktop templates setting takes a VMID alone for such
  a template, which serves every card the helper lists while its writes are
  on: the helper writes the placed card's desktop set into the stopped clone,
  as unit 5's start gate does.
- **Desktops with no GPU from it.** `linux-desktop` with `gpu` none is cloned
  from a GPU desktop template with no GPU ID, gets no marker and no lines,
  takes no warm guest, and its display takes the CPU path, as it does in a
  box with no NVIDIA nodes. Proxmox LXC offers `linux-desktop` with `gpu`
  none only where such a template is listed. A fork with `gpu` none copies
  its snapshot, not a template, so the room for it needs no such template
  and no card.
- **Placement for servers.** A `linux` box with `gpu` shared takes no warm
  guest. Under the card lock it goes to a card that no guest holds whole,
  with fewer of this install's boxes than the desktops per GPU (unit 5's
  boxes per card), with 1,024 MiB free when last read less what is
  reserved, that no box lately failed to see, and on which no running box
  is on the wrong card; then section 3's order. It is cloned from the least
  used Linux template whose userspace is the host's driver, its marker goes
  in the same write as its labels, and it starts only on the helper's grant.
  Every refusal names each card and has words for the person and for an
  agent (`Capacity.agentMessage`), and an agent's never tells it to release
  a box or change a setting.
- **The check after each start** bb-box makes of a box with a card:
  `nvidia-smi --query-gpu=uuid,name,memory.total` lists the claimed card,
  and `cuInit(0)` returns 0, through Python's `ctypes`, which takes no card
  memory; a box with no `python3` is checked by `nvidia-smi` alone, and a
  check that does not finish fails. A fresh acquire that fails it is
  released and made again on another card within the kind's time, and that
  card is left out for 10 minutes. A stopped server that fails it is
  stopped, placed once on another card and started again; if that fails
  too, it is left stopped with its disk, and the start says why. A
  restore's start is never moved: it is left stopped on its card. A box
  whose userspace is not the host's driver is not moved, and its GPU fact
  says so. The GPU fact reads as section 11's words: "card
  1, shared, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 96
  GiB".
- **The sweep's check.** Every 10 minutes the backend's upkeep runs
  `nvidia-smi` in each running box of this install that holds a granted
  card. A box whose `nvidia-smi` lists another card, or says there is none,
  is logged, placements leave out both cards until it is released, stopped
  or checked again on its card, and the doctor's new `proxmox.gpu-cards`
  check fails, naming it. The helper's `mismatch` lines close their cards
  the same way. A reading the sweep cannot read, and a box whose userspace
  is not the host's driver, are skipped. bb-box never stops a box for it.
- **The tools.** `box_acquire` and `bb box acquire` take `gpu`, none or
  shared. Left out, it is the kind's: none for `linux`, shared for
  `linux-desktop`. Each offer says the GPU parts it gives (`gpuParts`), and
  the registry passes over offers that do not give the part asked for: a
  shared GPU is never met by a provider without one. `box_list` says, per
  provider, whether servers can have a GPU now and the room on each card
  with the reading's age, or why not; `box_status` and `box_acquire`'s answer
  have a `GPU:` line with the card's words.
- **The doctor.** `proxmox.gpu-helper` warns on a node with cards and no
  helper: "GPU on servers, whole cards and changes of card need
  host/setup-gpu.sh." A Linux template whose userspace is not the host's
  driver warns, saying GPU placements from it are off and boxes with no GPU
  are made as usual; it never fails for it. The GPU checks run where the
  desktop templates name no GPU, from the report's cards.

### On a box with no card, the installer and the drivers' unit

Run on a `linux` box, in `ubuntu:24.04` containers with libglvnd, Mesa's
EGL, GL and Vulkan drivers, `mesa-utils` and `vulkan-tools`, once without X
and once with `xserver-xorg-core`: `nvidia-userspace.sh` with NVIDIA's
580.142 installer, checked against NVIDIA's SHA-256, then the unit's script
by hand. The container has no card's nodes.

| | Without the userspace | With it, files hidden | With it, files shown |
| --- | --- | --- | --- |
| `eglinfo -B` | exit 3 | exit 3 | exit 139, a segmentation fault |
| `vulkaninfo --summary` | exit 0, 33 to 34 ms | exit 0, 23 ms, llvmpipe | exit 0, 128 to 138 ms, and the loader's error for NVIDIA's ICD |
| X driver | | `/usr/lib/xorg/modules/drivers/nvidia_drv.so`, with or without X; no `/usr/lib64/xorg` | |
| Installer | | 4.2 to 4.7 s | |

Hidden, a box with the userspace and no card behaves as one without it,
for EGL and Vulkan alike. NVIDIA's OpenCL ICD (`/etc/OpenCL/vendors`) is
left as it is.

The X paths, in a bare `ubuntu:24.04` (no libglvnd, no Vulkan loader, no X,
as bb-box's Linux template) and in one with libglvnd, the Vulkan loader and
`xserver-xorg-core` (as the desktop template), each installer run exiting 0:

| X flags | Bare: X driver, and what the installer said | With X and libglvnd |
| --- | --- | --- |
| none | `/usr/lib64/xorg/modules`, "forced to guess the X library path '/usr/lib64'" | `/usr/lib/xorg/modules` |
| `--x-module-path` alone | `/usr/lib/xorg/modules`, the same guess for the library path | `/usr/lib/xorg/modules` |
| both, as the script gives them | `/usr/lib/xorg/modules`, no guess | `/usr/lib/xorg/modules` |

In the bare container every run also said "ERROR: Unable to get file
properties for '/usr/lib/libGL.so.1'" and warned that NVIDIA's Vulkan ICD
needs a loader: the Linux template has no libglvnd and no Vulkan loader,
and `--no-install-libglvnd` leaves them out. CUDA, NVML and `nvidia-smi` do
not need them (`libcuda.so.1`, `libnvidia-ml.so.1` and `nvidia-smi` were
there; `cuInit` gave 100, no device, as a box with no card does). A server
that installs Mesa or the Vulkan loader later gets the drivers' unit's
hiding. Limits: containers on one box, one driver version, no card;
timings of one run each.

### What was run

On a `linux` box, in `node:26-bookworm` as root, as CI runs them:

- `tsc` clean. The node suite as root: 3,710 tests, 3,415 passed, 0
  failed, 295 skipped. vitest: 462 passed.
- `test/gpu-servers.test.ts`, against the real helper 0.4.2 on unit 2's fake
  node through unit 5's bridge, whose boxes now have an `nvidia-smi` that
  lists the card their lines name: a shared server placed, marked in the
  same write as its labels, given the server set while stopped and started
  on its card; a server with no GPU as before; refusals before any copy,
  for each audience, with no Linux template userspace, an old one, writes
  off and no helper; the 1,024 MiB need and the limit per card; a fresh
  server that lists another card released and made again on the other, the
  first card then left out; a desktop with no GPU from a template with no
  device lines; a shared desktop from it on each card; a stopped server
  that does not see its card moved once, and left stopped where no card has
  room; the sweep's mismatch failing the doctor and closing both cards; and
  the words of `box_list`.
- `test/nvidia-drivers.test.ts`: the drivers' unit on a fake root: hidden
  with no card, shown with one, GBM only with a render node, a file the
  installer put back kept, `--check`.
- `test/boxes.test.ts`: `gpu` shared goes only to a provider that gives it,
  its record keeps it, `gpu` left out on `linux` is none; a GPU no provider
  gives is refused before any box, for each audience; a provider's own
  refusal reaches an agent in its agent's words.
- `test/lxc-config.test.ts`: a desktop template with no GPU ID.
- The installer probe above, and `shellcheck` on the scripts this unit
  changed: no new findings (`build.sh` keeps its three from before).

### The live check

On a fresh `npx bb-app@0.48.1` in a `linux` box, with no account, bb-box
installed from this branch's tree, and Docker set up by `bb box setup
docker`: a provider with no cards.

| Command | Answer |
| --- | --- |
| `bb box kinds --json` | `linux` from Docker, `gpuParts` `["none"]` |
| `bb box acquire linux` | ready in 2.4 s, `gpuPart` none, no claim, `System: linux x86_64`, no `GPU:` line |
| `bb box acquire linux --gpu none` | the same |
| `bb box acquire linux --gpu shared` | exit 1 before any box: "No provider gives linux boxes a shared GPU: Docker on <host> gives linux boxes no GPU. Ask for gpu none. (unsupported)" |
| `bb box acquire linux --gpu bogus` | exit 1: "--gpu takes none or shared, not bogus." |

A server with a card, a desktop with no GPU from the GPU template, its time
to ready and an agent's `box_acquire` need the node's cards: node steps A
to G, through the lead, in [the gate on the node](#the-gate-on-the-node).

### Deviations from the note

- `linux-desktop-cpu` is still cloned from the CPU desktop template, with
  its warm guests, as today. Section 1 has it come from the GPU desktop
  template on a host with a driver; that moves every production CPU desktop
  and is a call for the lead. `linux-desktop` with `gpu` none comes from the
  GPU template.
- A desktop whose check after a start fails is not stopped and moved: its
  GPU fact says what the check found, as #597 does for its display. Servers
  are moved, as section 3 says.
- The sweep's mismatch shows in the doctor and closes the cards to new
  boxes; the box's page gets it with unit 14.
- Boxes per card is still the desktops per GPU setting, counting servers and
  desktops of this install together; 1,024 MiB is a constant until unit 15's
  setting.
- Refusals name guests by VMID and cards by index, not boxes by name: the
  backend does not know the names. Unit 8's refusals can carry them.
- The kind's GPU when not asked for applies on offers that have a GPU part.
  An offer whose kind has none (no such `linux-desktop` exists today) takes a
  request that leaves `gpu` out as none. A part that is asked for is never
  turned into none.
- A GPU desktop's GPU fact now reads "card 1, shared, <model>, <memory>",
  not the template's GPU ID, and every GPU desktop's acquire runs the card
  check: about one SSH command more.
- A Linux template whose userspace is not the host's driver warns; a desktop
  template's still fails, as 049 has it.
- NVIDIA's OpenCL ICD is left visible.
- `bb box acquire` takes `--gpu` too.

### After the reviews

Two reviews (Astra, Fable) said no-go. Each finding is fixed in one more
commit, with the lead's decisions, and each fix has a test that failed with
the fix reverted, on a box, 16 reverts in all.

| Finding | Fix |
| --- | --- |
| A box from a project's image with a GPU part skipped placement and its marker (Astra 1, Fable 1) | A server from an image is placed as a template's clone is, once the image's record has the host's userspace, and refused before any copy otherwise. A shared desktop from an image is placed on any card while the helper writes, or on the card its lines name while it does not. A desktop with no GPU from an image gets a `gpu.none` marker, and the helper takes the image's lines out; with no helper or writes off, an image with lines is refused for gpu none |
| A failed check moved a restore's pinned start to another card (Astra 2, Fable 3) | A restore's start never moves: the box is stopped and left on its card, and the start says why |
| The sweep took an unreadable reading for "no card" (Astra 3, Fable 2) | The sweep runs the full check and calls a box on the wrong card only when nvidia-smi lists another card or says there is none. An unreadable reading, a check cut short and a box whose userspace is not the host's driver are skipped |
| Placement ignored the helper's `mismatch` lines (Astra 4) | A card named in a `mismatch` line, and the card that guest's lines name, take no new box |
| Exclusions outlived their box (Astra 5) | A box's exclusion ends when it is released, stopped, or passes a check |
| `build.sh linux --cpu` set an empty device line (Astra 6) | Empty lines are left out |
| Any Python failure passed the CUDA check (Astra 7) | CUDA is skipped only where the box has no Python; a library that does not load, a non-zero `cuInit`, or a check whose last line is missing fails. A check bb-box could not run at all fails too |
| Refusals inside acquire and start reached an agent in the person's words (Astra 8, Fable 4) | Errors carry an agent's words beside the person's: `BackendError.agentMessage`, and `AudienceError` for a start. A failed box keeps both, and `box_acquire`, `box_status`, `box_list` and every tool's failure show the agent's |
| The node steps' memory parser split NVIDIA's CSV on spaces, and the PyTorch run passed when Python failed (Astra 9, 10) | The watcher writes one `time index used` line per card; the readings fail on missing or malformed samples, no load, or 1 GiB or more; the run exits with Python's status and asserts a finite result. No block passes by default |
| Comments in the new scripts (Astra 11) | Removed; their usage is in the setup guide |
| `box_list` said "no GPU helper" on a node with no card (Fable 5) | It says nothing about GPUs there |

Run on a `linux` box in `node:26-bookworm` as root, on the commit after the
reviews: `tsc` clean; the node suite, 3,722 tests, 3,427 passed, 0 failed,
295 skipped; vitest, 462 passed in four runs of five, and 461 in the first,
whose one failing test's name was not kept. Each block of the node steps
passes `bash -n`, and the readings block, run as written on a made-up watcher
log, gives a delta of 800 MiB for the reviewers' case and fails for a load
of 1.3 GiB, a card with no samples, a watcher that stopped, no load, and a
malformed sample.

### After the second reviews

Fable said go with three lows; Astra no-go with one high, five mediums and
a low. Each is fixed in one more commit, with the lead's decisions, and each
fix has a test that failed with the fix reverted, on a box: 14 reverts.

| Finding | Fix |
| --- | --- |
| An acquire resumed after its clone and before its marker started with no card, or kept an image's lines (Astra 1) | Before it starts, a resumed guest of a box with a GPU and no shared marker is placed and marked as a fresh one is; one with no GPU that carries a card's lines gets `gpu.none` and the helper takes them out. A resumed guest found running is released and the acquire refused |
| A desktop template listed without a GPU ID was taken to carry no lines (Astra 2) | bb-box reads the template's config: lines it carries are taken out by the helper for a desktop with no GPU, or the acquire is refused before any copy |
| A server stopped after both its checks failed kept a reservation (Astra 3) | Every stop after a failed check drops the box's reservation under the card lock, once the stop is confirmed |
| Wrappers lost the agent's words (Astra 4) | A start's move to another card, the backend's fork placement and the registry's failed fork keep both audiences' words |
| A check that did not finish released or moved a box (Fable 1) | A check that does not finish is run once more. Still unfinished, or failing in any way but a listing of other cards or none, the box is kept and the GPU fact says what the check found. Only a listing of other cards or none releases a fresh box or moves a stopped server |
| A bare `cuinit` line (Fable 2) | Read as Python giving no answer |
| A mismatch whose target is `none` (Fable 3) | Read apart: "runs with a card's lines while its claim is none"; it closes only the cards those lines name |
| `free_on` returned the last row's status, and the watcher's checks passed with no samples or none during the run (Astra 5, 6) | `free_on` exits on its own found or not found. D1 needs five samples for each card. D5 needs three samples before the run and ten during it, the first within 1 s of the run's start and the last within 1 s of its end, and no gap over 2 s |
| Comments this unit added to `build.sh`, `fetch-artifacts.sh` and `customize-base.sh` (Astra 7) | Removed; `LINUX_GPU` and `linux-nvidia` are in the setup guide |

### The gate on the node

Run by the lead on the node and by the builder on a test BB, on 5 November
2026 (UTC), on main at `3f6d8395`, after the merge and its deploy. After the
deploy, production's smoke test made a `linux-desktop` in 1.4 s with "GPU:
card 0, shared, NVIDIA RTX PRO 6000 …, 96 GiB" (its card check 0.1 s), and
production's doctor passed the GPU helper (0.4.2, writes on), the cards,
the migration, the report and both whole checks.

The test BB was a fresh `npx bb-app@0.48.1` on a Proxmox LXC box, with no
account, bb-box installed from `git archive 3f6d8395`, and live checks off,
as no step needed them. Its server ran as a systemd unit, bound to every
address, and iptables let only the box itself and the lent addresses reach
its two ports, so its boxes could join it. The lead added its Proxmox LXC
backend: a pool of its own, the test Linux template and the test desktop
template that steps A and B built on two lent VMIDs, the three other lent
VMIDs and addresses for boxes, production's CPU desktop template, desktops
per GPU 1, and no warm boxes. Both cards had about 97 GiB free at step 0,
and nothing loaded them but D5's two runs. At most two test GPU guests ran
at once.

| Step | Evidence |
| --- | --- |
| 0 (21:36) | Proxmox VE 9.2.0, pve-container 6.1.14, driver 580.142. The helper: 0.4.2, writes on, serving production's pool and the test pool. The lent VMIDs free. Card 0 had 97,171 MiB free, card 1 96,983 |
| A, the test Linux template | Built on the second try: the first failed one check (see the findings). "linux template … ready (NVIDIA 580.142, no card)": `template: 1`, no NVIDIA or DRM lines and no empty line, the TUN line; its record has `nvidia` 580.142 and kind `linux`; "NVIDIA's userspace ok 580.142, its EGL and Vulkan drivers hidden"; 11.8 GiB trimmed. Its base volume is 16,384 MiB |
| B, the test desktop template (21:46) | First try: no NVIDIA or DRM lines and no empty line, the TUN line; its record has `nvidia` 580.142 and kind `linux-desktop`; "display mode ok cpu: no NVIDIA device nodes", "NVIDIA's userspace ok 580.142, its EGL and Vulkan drivers hidden", "Selkies video ok x264"; 17.1 GiB trimmed. Its base volume is 24,576 MiB, inactive (`Vri---tz-k`) |
| C, the test BB | The doctor: both templates' images ok, each with NVIDIA 580.142; the GPU helper ok, for the test pool; "Boxes on their cards" ok; markers ok; 3 of 3 VMIDs free. `bb box kinds --json`: `linux` offers gpu `none` and `shared`, and its `gpuRoom` lists both cards, a limit of 1 and 1,024 MiB needed; `linux-desktop` offers `none` and `shared`. Two warnings: the thin pool's metadata, known from unit 6, and production's CPU desktop template's image (see the findings) |
| D1 (21:47) | The watcher: one `time index used` line per card, about four a second |
| D2, S1 (21:49) | The first acquire timed out (see the findings). The second was ready in 6.5 s: place 0.3, clone 1.6, gpu 1.0, start 2.1, network 0.4, ssh 0.2 and card check 0.5 s. `gpuPart` shared, claim card 0 granted at g1; "GPU: card 0, shared, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 96 GiB. Run nvidia-smi to see it." In it, `nvidia-smi -L` listed card 0 alone; NVIDIA's EGL, Vulkan, Wayland, xcb and xlib files were shown and its GBM platform hidden; no `/dev/dri` |
| D3, S1 (21:57) | Its lines: TUN, card 0's `/dev/nvidiaN`, `nvidiactl`, `nvidia-uvm` and `nvidia-uvm-tools`, each `mode=0666`; no `nvidia-modeset` and no DRM node. Marker `gpu.shared.<card 0>.g1`. The report: `claim <S1> g1 granted shared <card 0>`, `holder <card 0> <S1> shared running install <test install> managed`, no mismatch |
| D4, GBM | With NVIDIA's GBM platform hidden, `eglinfo -B` exits 3: GBM, Wayland and X11 fail to initialise with no display, and the surfaceless and device platforms initialise on the card (EGL 1.5, NVIDIA, the card as renderer). With it shown, `eglinfo` crashes (exit 139). `vulkaninfo --summary` exits 0 in 363 ms and lists the card and llvmpipe. The drivers' unit then hid GBM again. So a server, which has no render node, needs NVIDIA's GBM platform hidden, as unit 7 does |
| D5, S1's load (21:57) | PyTorch 2.11.0+cu128 (see the findings for its install). A 1024 × 1024 matmul on the card, finite; 44 MiB reserved; CUDA's start and the matmul in 0.54 s, the run 5.7 s. Card 0: 20 samples before the run and 25 during it, the longest gap 0.264 s; 77 to 777 MiB used, a delta of 700 MiB (unit 0: about 678) |
| D6, S2 (22:00) | Ready in 6.0 s, claim card 1 granted at g1, as S1 held card 0 and the limit is 1; `nvidia-smi -L` listed card 1 alone |
| D3 and D5, S2 (22:01) | The same lines with card 1's node; `claim <S2> g1 granted shared <card 1>`, `holder <card 1> <S2> shared running`, no mismatch. The run 5.7 s, CUDA's start and the matmul 0.75 s. Card 1: 21 samples before and 24 during, the longest gap 0.257 s; 266 to 965 MiB used, a delta of 699 MiB |
| D7 | Both released |
| E1, D0 (22:03) | `linux-desktop` with gpu none, ready in 5.1 s: clone 1.7, start 2.7, ssh 0.2 s, no place or gpu step. Gpu part none, no claim; "Display mode: CPU", "The box has no GPU device.", no `GPU:` line. `bb-box-check-desktop`: 20 checks, all ok, among them "display mode ok cpu: no NVIDIA device nodes", "nvidia-smi ok no GPU in this box", "NVIDIA's userspace ok 580.142, its EGL and Vulkan drivers hidden", Selkies x264, vkcube's 1000 frames in 588 ms on llvmpipe, and Chrome on ANGLE and llvmpipe. On the node, by hand (see the findings): tags `template.<test desktop template>` and `kind.linux-desktop`, the TUN line alone, no `gpu.` tag |
| E1, C0 | `linux-desktop-cpu` from production's CPU desktop template, ready in 4.4 s; 19 checks, all ok. By check name, the same checks as D0, each ok, but NVIDIA's userspace, which a CPU template built before unit 7 does not check and one built since skips |
| E2 (22:04 to 22:07) | Three cold acquires of each, one test guest at a time. Medians: `linux-desktop` gpu none 4,104 ms; `linux-desktop-cpu` 3,932 ms; `linux-desktop` with gpu left out, shared from the test desktop template, the helper writing card 0's desktop set while the clone was stopped (about 0.5 s), 5,169 ms; today's desktop, from production's per-card templates, 5,383 ms. Each is within 5 s of today's |
| F, an agent's `box_acquire` (production) | From a fresh production thread, with production's Linux template not yet rebuilt. (1) `linux` with gpu shared: refused before any box, "Not made: <node> cannot give a server a shared GPU now: no Linux template there has NVIDIA's userspace for its driver 580.142: template <vmid> has none. Ask for gpu none, or ask the user. bb-box changed nothing.", followed by the tool's generic hint (see the findings). (2) `linux` with no gpu: a box as before, no `GPU:` line. (3) `linux-desktop` with no gpu: "GPU: card 1, shared, NVIDIA RTX PRO 6000 …", display mode GPU, card check 0.1 s. (4) `box_list`: `linux` says "No GPU on Proxmox LXC on <node> now: … template <vmid> has none.", and the room per card shows under `linux-desktop`: right until production's Linux template has the userspace |
| G (22:07) | The watcher stopped; no lent VMID in use or holding a card; no mismatch; both test templates destroyed. Production's guests against the lead's baseline: only the warm desktop the smoke test took and released, and its replacement. The helper wrote and refused nothing outside the lent VMIDs from 21:15 |

### Findings from the gate

| Finding | Severity | What happens | Follow-up |
| --- | --- | --- | --- |
| An image refresh builds the Linux template without NVIDIA's userspace | high | After the gate, the lead rebuilt production's Linux template with `bb box images build`, the path the nightly refresh takes. It passed its trial's 30 checks, but its record has `nvidia` null: that path does not install the userspace as `build.sh linux` does on the node. So production still gives no server a GPU, and a `build.sh linux --replace` by hand would be undone at the next refresh | Fixed on its own branch, `u71-7b`: a refresh on a node with an NVIDIA driver installs that driver's userspace and records it |
| The first clone of a fresh template can miss the ready deadline | medium | S1's first acquire took 13.5 s to clone and 10.9 s to start, against 1.6 and 2.1 s on the next try, minutes later, at the same node load, so 4.5 s of the 30 s deadline were left for its network and SSH. Nothing answered on port 22 in time; bb-box deleted the guest and the acquire failed. Production's first box after `build.sh linux --replace` may fail the same way | Watch the first acquire after production's rebuild; a later unit may give a template's first clone more time |
| The first docker command's 2,000 ms limit on a busy node | low | Step A's first build failed "first docker command FAIL 4232 ms (limit 2000)" with the node at load 12 to 15; Docker answered in 10 ms after, and the build passed when run again. The limit is 041's, in all three check scripts; D0 and C0 took 1,405 and 1,559 ms | A limit that allows for load, or one retry, in 041's checks |
| An agent's refusal ends with the tool's generic hint | low | `box_acquire`'s refusal of gpu shared gave the agent's words, then "Next: Try again later, release a box you no longer need, or pick another kind.", which tells the agent to release a box, against section 3 | Fixed separately, as CO-11 |
| E1's node rule on the root disk | note (steps) | On LVM-thin a linked clone's `rootfs` names its own volume, not its template's base, so `^rootfs: .*base-<template>-disk-0/` cannot match, and the block stopped at its first check. The lead checked the rest by hand | The rule reads the `template.<vmid>` tag |
| E1's comparison by position | note (steps) | The block paired the two checks line by line, so C0's missing userspace line shifted every line after it | Compared by check name |
| PyTorch's install filled a 16 GiB box | note (steps) | pip's cache and the CUDA wheels filled the default disk; the install alone takes 6.5 GiB | `pip install --no-cache-dir` |
| No thin data for a template's base volume | note | `lvs` shows no `data_percent` for an inactive base volume, so A and B give no figure against unit 0's 4,430 MB; the trims ran, 11.8 and 17.1 GiB | None |
| A CPU template's image warning | low, not unit 7 | The test BB warned that production's CPU desktop template, rebuilt that day with Chrome 157, is newer than the repository's pin, Chrome 156, and its fix still says to rebuild it with `build.sh desktop <vmid> --cpu --replace`, which would go backwards. The warning is #1364's image check | That warning's fix |

### Still open

- Production's Linux template with NVIDIA's userspace, through `bb box
  images build` once `u71-7b` is in (above). Until then, an agent's gpu
  shared on `linux` is refused, as F (1) shows; then F (1) and (4) once
  more, and the first acquire after it (above).
- Optionally, a desktop template with no device lines, listed by its VMID
  alone, in place of the per-card templates.
- Whether `linux-desktop-cpu` should move to the GPU desktop template now
  (above).

## Unit 8b: bb-box-gpu 0.4.3, whole claims yield only the asking install's own boxes

Built on main `02a54581`, on branch `u71-8b`, as the lead decided after unit
8's reviews: a whole claim never takes the lines out of another install's
guest. Before, the helper yielded every stopped shared box it managed on the
card, of any install. bb-box from unit 8 already places a whole box only on a
card where no other install's guest stands, but between its placement and the
helper's answer another install's guest can come to stand stopped on the card,
as when its clone of a per-card template is granted and not yet started.
0.4.3 closes that: the authority refuses rather than yields.

### What it does

- A whole request yields only stopped shared boxes with a granted claim, not
  locked and with no pending device change, as before, and now also of the
  requesting guest's own install and pool. Any other guest with the card's
  lines blocks it, and the request is refused `card-held`, naming it; that
  guest's config is not written.
- The same rule holds for the check under each yielding guest's config lock,
  and for which guest a lost ledger's rebuild names when it refuses a whole
  claim; the rebuild's outcome does not change, as a whole box there loses its
  claim to any other guest on its card.
- Version 0.4.3, protocol 1, so `setup-gpu.sh --writes on` and the upgrade's
  preview need this release's helper. `setup-gpu.sh` itself is unchanged: an
  upgrade is running this release's `setup-gpu.sh`, which installs 0.4.3,
  runs its preview with writes on, and keeps the config and the ledger.

### What was run

On a `linux` box, in `node:26-bookworm` as root:

- `test/gpu-helper.test.ts` gains a test: another install's stopped shared
  box, and this install's in another pool, keep their lines and the whole
  claims are refused; this install's own box in its pool still yields. With
  the rule reverted, that test fails. A unit 6 test that took a claim away
  with another install's whole claim now takes it with this install's own.
  The setup tests' release-relative versions move up one, as unit 6's did,
  and the doctor's tests that read the real helper say 0.4.3.
- The GPU and Proxmox LXC test files: 325 tests, 324 passed, 0 failed, 1
  skipped. `tsc` clean. The node suite: 3,755 tests, 3,459 passed, 1 failed,
  295 skipped; the failure was a `computer_act` timing test in
  `test/plugin.test.ts`, which this unit does not touch, and the file passed
  on a second run. vitest: 469 passed. `shellcheck -x setup-gpu.sh`: clean.
- Merged with unit 8's branch: `tsc` clean, the node suite 3,787 tests, 3,492
  passed, 0 failed, 295 skipped.

### After the review

Astra said no-go, with one high: the check under the yielding guest's config
lock compared it with the requester as the pass had scanned it, so a
requester changed in between, under its own lock, to another install or
moved to another pool, still had the yield carried out, and its own request
was then left as changed. Now:

- The helper takes the requester's config lock first, reads it again, and
  checks it is the guest it scanned (box, install, kind, pool and GPU tags,
  so its marker and generation), before any yield. It holds that lock through
  every yield and its own write, so its config cannot change meanwhile.
- Each yielding guest is checked against that fresh requester under its own
  lock, as before.
- Pool membership, which Proxmox keeps outside a guest's config, is read
  again before each write: before a yielding guest's, for it and the
  requester, and before the requester's own. A change leaves the request for
  the next pass and writes nothing more.

Four tests, with the fake Proxmox changing a guest when a lock is taken or a
config written: the requester changed to another install when its lock is
taken; another actor's change to the requester while the yielding guest's
lock is held, which now cannot take the requester's lock; the requester moved
to another pool while the yielding guest's lock is held; and moved after the
yielding guest's write, before its own. Each fails with its part of the fix
reverted, on a box. A yield already written when the requester moves away
stays written, and the yielded box is placed again at its next start, as any
yielded box is.

Fable said go, with lows: the same race from the other side, fixed above;
`test/gpu-setup.test.ts`'s upgrade across a protocol change waited for the
first install's start call, which its calls still held, so on a slow runner
it marked a guest while the old helper answered; it now forgets the calls
before the upgrade. That test had failed once under load in unit 8's runs.
Its node-step lows are in the steps: the way back is archived from `02a54581`
and checked to be 0.4.2 before it runs, and step B reads the journal from
just after its baseline, leaving the guests to `u5-compare.sh`.

Then, on a `linux` box in `node:26-bookworm` as root: `tsc` clean; the node
suite, 3,759 tests, 3,464 passed, 0 failed, 295 skipped; vitest, 469 passed;
`shellcheck -x setup-gpu.sh` clean.

### The node steps

Upgrade the node's helper to 0.4.3 with this release's `setup-gpu.sh`, after
its preview, with writes on as before, and check that no guest changed: in
the report to the lead. Whole cards stay off (`general.wholeCards`) until 0.4.3
is on the node and the owner turns them on.

## Unit 8: whole cards on Proxmox LXC

Built on main `4f5b5d18`, on branch `u71-8`. No helper change: bb-box-gpu
0.4.2 already answers whole requests one at a time, refuses a whole claim on a
card whose devices another guest has, and yields stopped shared boxes it
manages (units 2 and 5). Whole cards are offered to the person, to agents and
to forks of desktops only on an install whose `general.wholeCards` option is
on, off by default, and only where the node's helper writes. The gate runs on
a test BB from this branch with the option on, as section "Gated in unit N"
says: no whole card is offered on production until two whole acquires at once
leave one claim, and then not until the owner turns the option on.

### What it does

- **Placement for a whole card** (section 3, "Whole"). Under the card lock, a
  whole box goes to a card that no other guest holds, running or stopped,
  other than this install's own stopped shared boxes in its pool that hold a
  claim in the helper's ledger, which yield, and this install's warm
  desktops, which are retired; another install's guest and a guest that is
  not bb-box's never yield to it; that is not held whole; on
  which this install has no reservation, for a box being made, moved, forked
  or started; on which no request of this install is unanswered and no guest
  a lost ledger left unresolved may hold the card; and that has the memory a
  new box needs free when last read (1,024 MiB for a server, 384 MiB for a
  desktop), less what is reserved. A card whose free memory the report does
  not give takes no whole box. Of those, the card with the least memory in
  use, then the most free, then the lowest index; a box's last card first,
  where it is free. Cards a box lately failed to see, or that a mismatch
  closes, are left out as for shared boxes.
- **A card kept whole takes no shared box.** A whole reservation closes its
  card to every shared placement, servers, desktops, warm fills and the start
  gate's, until the helper reports the whole box on it, from when the report's
  `whole` holder line closes it.
- **Acquire.** `linux` and `linux-desktop` with gpu whole take no warm guest
  and no spare. They are cloned as a shared box is, the marker
  `gpu.whole.<UUID>.g<N>` goes in the write that labels the guest, and the box
  starts only on the helper's grant, with the check after start as unit 7
  has it. A refusal from the helper, as when another install took the card
  meanwhile, releases the guest and places the box once more, on another
  card, then refuses with words.
- **Warm desktops are retired, not counted.** A card held only by this
  install's warm desktops and stopped shared boxes is free for a whole box.
  Once the card is reserved, bb-box retires those warm desktops, under the
  warm pool's lock so no claim takes one meanwhile, and deletes them before
  anything is copied. A warm desktop a claim took meanwhile is a box, and the
  helper's refusal of the whole claim follows. Another install's warm guests
  block the card.
- **Yielding.** The helper takes a yielding box's lines out, while it is
  stopped, and answers it `yielded`. bb-box reads a yielded claim as no grant,
  so the box's next start places it again: on another card with room, as
  section 3 says, or not at all, with words.
- **A stopped whole box keeps its card** (question 1's default). Its
  `whole stopped` holder line closes the card to every other placement, and
  its start asks for nothing new. A stopped whole box whose claim the helper
  does not hold is placed again as a whole box, on its last card first, and is
  never turned into a shared one.
- **Refusals for each audience.** Each reason is kept per card and worded
  twice. To the person, boxes are named with their threads' titles, from BB
  ("card 0 has lone-pine (in thread "Train the model") running"), and the
  words may say to release a box or ask for another part. To an agent, boxes
  are named by box name only; the words offer another GPU part or asking the
  user, and, where the agent's own thread has boxes on those cards, "Release
  one of your own boxes on card 0 (lone-pine)". Guests of another install, and
  guests that are not bb-box's, are named by VMID. Shared refusals, the start
  gate's and a restore's now name boxes the same way, where they named VMIDs.
  For a whole card:

  > No card on pve is free for a whole card now: card 0 has lone-pine (in
  > thread "Train the model") running and card 1 is quiet-elm's whole card
  > (in thread "Long job"). Release a box on one of the cards, ask for gpu
  > shared, or ask for gpu none.

  > Not made: no card on pve is free for a whole card now: card 0 has
  > lone-pine running and card 1 is quiet-elm's whole card. Ask for gpu
  > shared, or ask the user. bb-box changed nothing.

  Where the helper is missing, has writes off or was not tested on the
  node's pve-container: "pve cannot give a box a whole card now: its GPU
  helper has writes off, so it gives no box a card." with the fix for the
  person, and "Ask for gpu shared, or ask the user." for an agent.
- **The provider hears who asks.** `Backend.capacity` takes the asking
  thread, which the registry passes for an acquire and a fork's admission, so
  the room's agent words can name the thread's own boxes. The fork's
  admission gives an agent the provider's agent words, where before it gave
  the person's.
- **Forks.** `box_fork`, `bb box snapshot fork` and the RPC take gpu whole
  for a `linux-desktop`: the fork is placed and its card kept whole before
  anything is copied, and refused before the copy otherwise: "Not forked: No
  card on pve is free for a whole card now: ... Fork it with gpu shared or
  none, or ask the user. bb-box copied nothing."
- **The tools.** `box_acquire` and `bb box acquire --gpu` take none, shared or
  whole. A provider that gives a kind a shared GPU and no whole card is passed
  over for whole, and where none gives one: "No provider gives linux boxes a
  whole card: Fake host gives linux boxes a shared GPU, not a whole card. Ask
  for gpu shared." `box_list` says "none, shared or whole; ask with gpu shared
  or gpu whole", with each card's whole holder by box name ("card 0 whole,
  quiet-elm's") and "free for a whole card" on each card a whole box would
  take now. `box_status` says "GPU: card 0, whole, <model>, 96 GiB".

### What was run

On a `linux` box, in `node:26-bookworm` as root, as CI runs them:

- `tsc` clean. The node suite, on the commit: 3,765 tests, 3,470 passed, 0
  failed, 295 skipped. vitest: 469 passed. In the run before it, on the tree
  without the thread titles' wiring, `test/gpu-setup.test.ts`'s "a failed
  upgrade across a protocol change ..." failed once, taking 17 s at a load of
  about 18 on 8 cores; it passed alone, 45 of 45 in its file. This unit
  changes neither the helper nor `setup-gpu.sh`.
- `test/gpu-whole.test.ts`, 15 tests, against the real helper 0.4.2 on unit
  2's fake node through unit 5's bridge: the rules alone; a card kept whole
  closed to shared boxes; a whole server placed, marked in the write that
  labels it, granted and started on its card; the gate's two whole acquires
  at once, one made and one refused with one clone in all and one whole claim
  on the node; refusals naming boxes for the person with threads and for an
  agent by name, with and without its own boxes; a stopped shared box that
  yields and then starts on the other card; a stopped whole box that keeps its
  card; a whole desktop that takes no warm guest, though one fits, and retires
  this install's warm desktop on its card; whole refused with writes off and
  with no helper; a fork's whole card kept before the copy, and its refusal;
  `box_list`'s room and words; a yielded claim read as no grant; a whole box
  with no claim placed again whole; each backend's context giving threads'
  titles from BB.
- `test/boxes.test.ts`, `test/forks.test.ts`, `test/plugin.test.ts` and
  `test/gpu-restore.test.ts`: gpu whole goes only to a provider that gives it,
  and the room hears the asking thread; the words where a provider gives only
  a shared GPU; a fork's admission gives an agent the provider's agent words;
  `box_acquire` and `box_fork` take gpu whole; a server's whole fork is
  refused for its kind. The earlier GPU tests now expect boxes' names in
  their refusals.
- Each rule was reverted on its own on the box, and its tests failed: 19
  reverts. One more, a stopped whole box holding its place in a shared count,
  is unit 5's rule and its revert failed nothing here, as a whole holder blocks
  a card by its part; it is left out of the 19.
- Each block of the node steps passes `bash -n`, and the report helpers they
  use were run on a report in the helper's format.

### The node steps

The gate runs on a test BB from this branch, before the merge, on the lent
VMIDs and the test pool, through the lead: steps 0 and A to H in the report to
the lead. It needs one card that no guest outside the lent VMIDs holds,
running or stopped: a whole claim there must not yield a production guest.

### Deviations from the note

- In place of section 12's "Whole cards" setting (unit 15), the general option
  `general.wholeCards`, off unless set, turns whole cards on for the install.
  Off, `gpu whole` is not in any offer or `box_list`, and `box_acquire`,
  `box_fork` and the CLI refuse it before any provider is asked: "Not made:
  whole cards are off on this install. Ask for gpu shared, or ask the user.
  bb-box changed nothing." The person is told `bb box option set
  general.wholeCards=true`. Unit 15's settings take it over.
- Only this install's own stopped shared boxes yield to a whole card; the
  note has every stopped shared box the helper manages yield. bb-box asks for
  a whole card only where the node's helper is bb-box-gpu 0.4.3 or later
  (unit 8b), which keeps that rule itself, under each yielding guest's config
  lock, so another install's box that comes onto the card between bb-box's
  placement and the helper's answer blocks the claim rather than yielding.
  With 0.4.2 on the node, whole is refused even with `general.wholeCards` on.
- Boxes per card is still the desktops per GPU setting, counting this
  install's boxes; a whole box counts as one box on its card.
- A fork with a GPU, shared or whole, is offered only for `linux-desktop`, as
  in unit 6; a server's fork takes gpu none. The fork form keeps None and
  Shared; whole is in `box_fork`, `bb box snapshot fork` and the RPC. The
  forms are unit 13's.
- The person's words name a box's thread by its title in brackets, as text,
  not as a link: links come with the pages (units 13 and 14). A thread's
  title is looked up for at most 2 s; a refusal of a restore, worded under the
  card lock, names boxes without their threads.
- "The least memory in use outside bb-box's boxes" is the card's memory in
  use, total less free, as the report does not say whose it is. A card free
  for a whole box runs no box of bb-box's but warm desktops, which are
  retired.
- A stopped whole box whose claim the helper does not hold is placed again as
  a whole box, on its last card first. Section 3 has a stopped whole box keep
  its card and does not say what happens once its claim is gone.
- Resize to and from whole is unit 9's.

### After the reviews

Astra said no-go, with two highs; Fable go, with findings on the node steps
and the deploy. The lead decided the fixes below. Each code fix has a test
that failed with the fix reverted, on a box: 14 reverts.

| Finding | Fix |
| --- | --- |
| Whole was offered at once on every install with a writing helper (Fable 2) | `general.wholeCards`, off by default, withholds whole from offers, `box_list`, `box_acquire` and `box_fork`, in the registry and in the backend, with words for each audience; `box_list` says "Whole cards are off on this install: ask the user if a box needs a card to itself." The test BB turns it on |
| A whole placement could yield another install's stopped guest (Astra 2) | Only this install's stopped shared guests in its own pool, with a ledger claim, yield; any other guest on a card blocks it |
| A whole desktop could take the per-card template, image or resumed path while the helper was not reporting, and run shared with no claim (Astra 1, Fable 3) | Whole is refused, with the whole words, before any of those paths, whenever the node's helper is missing, blocked, writing nothing or untested |
| A whole server whose start check found no card was not moved (Astra 4) | The start gate leaves the card it is told to leave, for a whole box too, and places it again as whole on another card |
| `box_list` gave desktops no cards, and "free for a whole card" ignored closed and avoided cards (Astra 6, 7, Fable 4) | Desktops get the same per-card room as servers; "free for a whole card" goes through the acquire's own placement, so a card a mismatch closes, or one a box lately failed to see, is not free |
| A start's reservation was worded "a box, which bb-box is making" (Fable 5) | The start gate's reservation names the box, and its words say bb-box is starting it |
| Node steps: one free card did not keep placement off the other; H passed on unreadable reads; G1's clone timing; G2 with an empty other card (Astra 2, 3, 5, Fable 1) | Step 0 needs exactly one free card and a held other one; step K checks both immediately before G1, G2 and G3 and stops otherwise; H reads Proxmox, the report and the journal, fails when any cannot be read, and fails on any write by the helper to a guest outside the lent VMIDs; G1 uses the node's evidence alone; G2 says why the other card has holders |

Then, on a `linux` box in `node:26-bookworm` as root: `tsc` clean; the node
suite, 3,774 tests, 3,479 passed, 0 failed, 295 skipped; vitest, 468 of 469
in the full run, the one failure the thread card's spinner test that unit 6
found flaky, and 469 of 469 run again. `test/gpu-whole.test.ts` has 22
tests. In an earlier run of the GPU, core and plugin files together, three
timing tests in files this round does not change failed under load and passed
alone. The node steps' 15 blocks pass `bash -n`, and step K was run on four
sample reports: it passes with lent guests on the free card and production's
on the other, and stops when the other card is empty, when a production guest
is on the free card, and when the report cannot be read.

### After the second reviews

Astra said no-go, with one high; Fable go, with lows. The lead decided a
server's fork has no GPU for now, as section 9 has it, and the fixes below.
Each has a test that failed with it reverted, on a box: 8 reverts.

| Finding | Fix |
| --- | --- |
| Whole accepted a node whose helper was 0.4.2, which yields another install's stopped box that comes onto the card after placement (Astra 1) | Whole needs the node's helper at bb-box-gpu 0.4.3 or later, unit 8b's, read from its report: below it, capacity, every acquire path, a fork and `box_list` refuse or leave out whole, with words for each audience, even with `general.wholeCards` on |
| The tools' schemas and the CLI's help offered whole while whole cards were off (Astra 2, Fable low 2) | `box_acquire` and `box_fork` are registered with whole, and a selection of the plugin's tools for each agent session (`bb.agents.configure`) narrows their `gpu` to none or shared while the option is off; it takes the plugin's skills from its manifest, and leaves BB's own selection in place, saying so in the log, if it cannot read them. `bb box acquire` and `bb box snapshot fork` read the option when they print their help and check `--gpu` |
| Step K could pass after a failed read (Astra 3) | Each block reads the report once, fails when it cannot, and takes every card and holder from that one text, each in an assignment of its own that fails when it finds nothing |
| G2 did not check S1's card (Fable low 1) | G2 checks S1 is on the free card from step 0, and stops otherwise |
| `box_list` named whole cards in every list at deploy (Fable low 3) | "Whole cards are off" is said only where the node's helper could give one |
| A desktop's `box_list` had two lines for the same cards, the second saying "ask with gpu shared" while none had room (Fable low 4) | A desktop with cards has the cards line alone, and while no card has room for a desktop, the "no GPU has room" line alone |

The tests run the real helper; until unit 8b's 0.4.3 is in this tree, the
bridge runs it under the version 0.4.3, so its whole cards can be tested,
and one test runs it as 0.4.2 to see whole refused. Then, on a `linux` box in
`node:26-bookworm` as root: `tsc` clean; the node suite, 3,778 tests, 3,483
passed, 0 failed, 295 skipped; vitest, 469 passed. Merged with unit 8b's
branch: the node suite, 3,787 tests, 0 failed. Step K was run on five sample
reports, a failed read and a card the report leaves out among them.

### After the third review

Astra said no-go, with one high, one medium and one low:

| Finding | Fix |
| --- | --- |
| The start gate's new whole claim, for a whole server moved after its check found no card, skipped the helper's version, so with 0.4.2 it took another install's stopped box's card that came onto the chosen card (high) | Before any new whole claim, a move to another card or a standing whole claim asked again, the start gate checks the node's helper is 0.4.3 or later; below it the box is left stopped, with words for each audience |
| A manifest bb-box could not read, or a missing skills folder, threw out of the tool selection and could stop the plugin's setup (medium) | Reading the manifest and the skills gives no skills on any error, so the logged fallback leaves BB's own selection in place; a selection BB refuses is logged too. A candidate root whose manifest cannot be read is passed over |
| A SKILL.md with CRLF line endings turned the narrowing off (low) | Line endings are made LF before the front matter is read |

Each has a test that failed with its fix reverted, on a box: 5 reverts.
Then, on a `linux` box in `node:26-bookworm` as root: `tsc` clean; the node
suite, 3,782 tests, 3,487 passed, 0 failed, 295 skipped; vitest, 469 passed.

Merge order: this unit can merge and deploy at any time, as whole cards stay
off and need 0.4.3. Unit 8b then upgrades the node's helper; then the gate on
the test BB; then the owner turns `general.wholeCards` on.

### After the fourth review

Astra said no-go, with one high: a restore's handoff, which gives a whole
box's claim back to its guest or to a new guest after the restore cleared it,
asked the helper for the card whole without the version check, so with 0.4.2
another install's stopped box that took the card meanwhile lost its lines. It
was the third whole path found without the check, so the check is no longer
on each path:

| Where | What it does now |
| --- | --- |
| Every config write bb-box makes to a guest | A write whose tags carry a whole marker the guest does not have yet, which asks the helper for a whole card, reads the node's helper version first and is refused, with nothing written, below 0.4.3. Every path that asks for a whole card writes through it: acquires, forks, starts, a rollback's kept claim, a claim given back and a swap's given claim |
| A restore, by rollback or by swap | A box whose card is whole is refused before it stops and before its claim is cleared, with words for each audience, while the helper is below 0.4.3. The restore's refusal now gives an agent its own words, as the backend's were dropped before |
| `bb box gpu mark` | A guest whose box's record says a whole card is refused, with the upgrade it needs, and its tags are not written, below 0.4.3 |

The checks on the acquire, fork placement and start paths stay, as they refuse
before anything is copied or reserved, with each path's own words.

Tests: Astra's reproduction, for both handoffs, now finds the restore refused
before its claim is cleared, and the handoff refused with nothing written, so
the other install's box keeps its lines. A second test asks for a whole card
through every caller with 0.4.2 (two acquires, a fork's placement and its copy,
a start that places its box again, a restore's held card, a rollback's kept
claim, a claim given back and a swap's given claim) and finds each refused and
no whole marker written. With the write check reverted, a fork placed before
the helper went back to 0.4.2 wrote its whole marker: a fourth path the check
now covers.

Each rule has a test that failed with it reverted, on a box: 4 reverts (the
write check, the restore's early refusal, `bb box gpu mark`, the agent's
words). Then, on a `linux` box in `node:26-bookworm` as root: `tsc` clean; the node suite,
3,787 tests, 3,492 passed, 0 failed, 295 skipped; vitest, 469 passed.

### After unit 8b went in first

Unit 8b merged and was deployed before this unit (main `3dbc76bd`), and the
lead upgraded the node's helper to 0.4.3 with its step B: the preview would
write no guest, no guest changed and the helper wrote none, and production's
doctor passes the helper on 0.4.3. This branch is rebased onto that main. The
only conflict was at the end of this file, where both sections are kept, unit
8b's first.

- The test bridges no longer run the helper under the version 0.4.3: it is
  0.4.3 in this tree. A test that needs an older one still asks for it.
- The node steps no longer upgrade the helper first; they check that it is
  0.4.3. Step 0 takes the `u5-check.sh` baseline. Step H prints the helper's
  writes to guests outside the lent VMIDs for the record, as production's own
  GPU boxes are made and released during the gate, and `u5-compare.sh` judges
  production's GPU guests, allowing the lent VMIDs and the guests production's
  bb-box changed. A yield of a guest outside the lent VMIDs still fails step H:
  production asks for no whole card, so none of its guests yields.

On a `linux` box in `node:26-bookworm` as root, on the rebased branch: `tsc`
clean; the node suite, 3,800 tests, 3,505 passed, 0 failed, 295 skipped;
vitest, 469 passed. Each block of the node steps passes `bash -n`, and step H's
two journal filters were run on sample lines.

### The gate on the node, in part

Run by the lead on the node and by the builder on a test BB, on 6 November
2026 (UTC), on main at `4948d8a2`, after the merge and its deploy, with
`general.wholeCards` off on production and the node's helper at 0.4.3 from
unit 8b's step B. No card can be free while a guest outside bb-box, the
node's own development container, holds both cards' device lines: it blocks
every whole claim on either card, whatever else stops. So only the items that
need no free card were run, on node steps adapted for it, whose step 0 and
step K required both cards to be held by a guest outside the lent VMIDs and
stopped if either was free.

The test BB was a fresh `npx bb-app@0.48.1` on a Proxmox LXC box, with no
account, bb-box installed from `git archive 4948d8a2`, live checks off, and
`general.wholeCards` on for its install alone. Its server ran as a systemd
unit bound to every address, and iptables let only the box itself and the
lent addresses reach its two ports. Its thread's agent was a script that calls
bb-box's tools as an agent does, so the gate read an agent's words as well as
a person's. The lead added its Proxmox LXC backend: the test pool,
production's Linux template, the lent VMIDs and addresses, desktops per GPU 1,
no desktop templates and no warm boxes. Its check found no problem.

| Step | Evidence |
| --- | --- |
| 0 (05:32) | The helper 0.4.3, writes on, serving the test pool; the lent VMIDs free. Card 0 held by 3 guests outside the lent VMIDs, card 1 by 4, all shared and running; one guest, on both cards, is not bb-box's. `u5-check.sh`'s baseline: 36 guests |
| A, the test BB | `general.wholeCards` true. The doctor: the GPU helper ok, 0.4.3 with writes on for the test pool; "Boxes on their cards", the markers and both whole checks ok; 5 of 5 VMIDs free. Two warnings: the thin pool's snapshots, known from unit 6, and no nightly image run yet. `bb box kinds --json`: `linux` offers gpu `none`, `shared` and `whole`, and its room lists both cards, neither free for a whole card (card 0: 3 boxes, 97,171 MiB free; card 1: 4 boxes, 96,983 MiB free) |
| K (05:33:06) | Both cards still held by guests outside the lent VMIDs; no lent VMID in use |
| G2 (05:33:12 to 05:33:22) | S1, a shared server, made on card 0, its claim g1 granted. Then a whole card asked for twice, through the CLI and through the agent, and refused at once both times, at admission, `no_capacity`, in the words below |
| G2 on the node (05:34) | S1 the one lent VMID in use: its claim g1 granted shared, and it holds card 0, running, managed. No lent guest deleted since step K, by the API or through the helper; no lent guest holds a card whole; no guest yielded. S1's lines are card 0's server set (`/dev/nvidia1`, `nvidiactl`, `nvidia-uvm`, `nvidia-uvm-tools`), with no desktop nodes |
| G4 (05:34) | Inside S1: `/dev/nvidia1` and the shared nodes only. Card 1's node is absent, and `mknod` of it is refused, "Operation not permitted". `nvidia-smi -L` lists card 0 alone. `/proc/driver/nvidia/gpus` lists both cards' PCI addresses: a guest can see that a card exists, not open it |
| H (05:35) | S1 released at 05:34:50. The lent VMIDs free, none holding a card; no mismatch. The helper wrote no guest outside the lent VMIDs, and none yielded. `u5-compare.sh`: 7 GPU guests of 36 compared, no guest changed, with no production guest to allow |

The person's words, from the CLI:

> No card on `<node>` is free for a whole card now: card 0 has CT `<vmid>`,
> which is not bb-box's, CT `<vmid>` of another install, CT `<vmid>` of
> another install and S1 (in thread "CALL box_list") running and card 1 has
> CT `<vmid>`, which is not bb-box's, CT `<vmid>` of another install, CT
> `<vmid>` of another install and CT `<vmid>` of another install running.
> Release a box on one of the cards, ask for gpu shared, or ask for gpu none.

The agent's, from `box_acquire`:

> Not made: no card on `<node>` is free for a whole card now: card 0 has CT
> `<vmid>`, which is not bb-box's, CT `<vmid>` of another install, CT
> `<vmid>` of another install and S1 running and card 1 has CT `<vmid>`,
> which is not bb-box's, CT `<vmid>` of another install, CT `<vmid>` of
> another install and CT `<vmid>` of another install running. Release one of
> your own boxes on card 0 (S1), ask for gpu shared, or ask the user. bb-box
> changed nothing.

The person sees S1 with its thread's title, which is its first prompt, as a
test BB with no account writes no titles; the agent sees box names only, and
its own box to release. After step H the builder stopped the test BB, took its
firewall rules out and released its box.

G1 (two whole acquires at once for one free card), G3 (a stopped shared test
guest yields, and starts on the other card) and G5 (a stopped whole box keeps
its card) wait for a free card. Each needs a whole box made, and a whole claim
is made only on a card that no guest outside the lent VMIDs holds, which no
card is while the node's development container holds both cards' lines. They
need a node without it, or a window without it, and then run with the full
gate's node steps.

### Still open

- When unit 15 lets a kind's "GPU when not asked for" be whole, a spare and a
  warm guest of that kind must still be shared (section 3): today spares and
  warm guests take the kind's default, which is never whole.
- G1, G3 and G5 of the gate are accepted as not testable on this node
  (owner, 6 November 2026): the node's development container holds both
  cards and stays up. Whole cards stay off on Proxmox LXC
  (`general.wholeCards` unset). Docker's whole card, as placement, passed
  live in unit 11's gate. G1, G3 and G5 run with the full gate's node steps
  on a node where a card is free, before whole cards are turned on there.

## Unit 11: GPU boxes on Docker

Built on main `4948d8a2`, on branch `u71-11`. Section 7's Docker part:
servers with a GPU, whole as placement, the share switch, CUDA pointed at
the box's card in every route, and the words about privileged boxes. No
helper or node change. The gate ran on a test BB from this branch, on the
owner's Windows PC's Docker in WSL with its one card, before the merge, and
passed on 6 November 2026 (see [the gate](#the-gate)); nothing here was
offered before it.

### What it does

- **Kinds.** With GPU boxes on (`gpu-desktops`), Docker's `linux` offers gpu
  none, shared and, where `general.wholeCards` is on, whole; `linux-desktop`
  shared and whole. With it off, neither offers a GPU, as before.
- **The cards.** bb-box reads each card's index, UUID, model, total and free
  memory with `nvidia-smi` in a short-lived container given the cards (no
  network, not privileged, `--pull never`), kept 15 s for a placement and
  60 s for `box_list`. A card is known by its UUID; the CDI device a box gets
  is the one the toolkit names for it, by UUID or index. A card keeps its
  key across readings: where the probe fails, the cards are as last read,
  their free memory not known, so no whole card is placed. With no reading
  since bb-box started, a device named by UUID is that card and one named by
  index is kept by its device: shared boxes go on it, with no CUDA variables
  and no check, as before this unit. A box's card is the one its labels
  name when that is among the cards, or else the one its device gives.
  Where a box holding a card whole matches no card, no GPU box is placed on
  the host until it does. A box with no GPU never runs the probe.
- **WSL.** The toolkit's spec in WSL has one device, `nvidia.com/gpu=all`, as
  every card is `/dev/dxg`. Where the daemon lists only that, every card is
  given through it, and the box's card is the UUID bb-box placed it on.
- **Placement**, under a lock kept by the Docker daemon's engine ID, which
  every backend instance on that daemon shares, with its reservations and
  the cards left out: a settings check's instance of a backend and the live
  one order their placements on one lock, and a rename of the host keeps it.
  Cloned hosts that kept one engine ID share it too, which only makes them
  place one at a time; their cards have different UUIDs. A box being made
  counts on the daemon the backend making it reads at that moment, and on
  every daemon of its engine ID when that backend cannot be asked. Each
  acquire drops its reservation from the share it made it in, and a new
  instance of a backend joins the share its engine ID has, so a reconfigure
  keeps the boxes being made. Every backend of
  the install that reaches the daemon, on or off, reads a box's switched
  part from one record. Two backends are on one daemon when its engine ID,
  name and Docker root from `docker info` are all the same. A backend counts
  on a daemon once it places or plans a box there, and only
  while it is on; listing, releasing and upkeep do not count. Of two
  backends of the install that count on one daemon, only the one whose ID
  sorts first places GPU boxes there; the other refuses them, for each
  audience, and makes boxes with no GPU as usual, and the doctor warns on
  both with `docker.one-backend`. A box being made holds its card, with the memory it
  needs reserved, from its placement until docker lists it. Every bb-box
  container on the host holds the card its labels name, running or
  stopped, of any install, as a container's devices are fixed. Shared: a card
  no box holds whole, with fewer boxes than boxes per card
  (`desktops-per-gpu`), and 1,024 MiB free for a server or 384 MiB for a
  desktop when last read, less what boxes being made need; then the fewest
  boxes, the most free, the lowest index. Whole: a card no other box holds,
  of any install, with that memory free (a card whose memory could not be
  read takes no whole box); then the least used, the most free, the lowest
  index. A card a box lately failed to see is left out for 10 minutes.
- **Refusals** name each card's boxes, for the person with their threads'
  titles (looked up for 2 s at most) and for an agent by box name, offering
  its own boxes on those cards, another GPU part or the user; another
  install's boxes are "<name> of another install". No card listed, or none
  read, says so with the toolkit's fix.
- **The container.** A GPU box gets `--device <its card's CDI name>`,
  `CUDA_VISIBLE_DEVICES` and `NVIDIA_VISIBLE_DEVICES` set to `GPU-<UUID>`,
  `NVIDIA_DRIVER_CAPABILITIES=all`, and the labels `bbbox.gpu`,
  `bbbox.gpu-card` and `bbbox.gpu-part` (the part it was made with). A
  desktop still gets `BBBOX_GPU=1`, and `BBBOX_GPU_ID` when it can see every
  card: when privileged, or when its CDI name is `all`, where it is the
  card's UUID. `BBBOX_GPU_CARD` names the card for the box's start script.
- **Every route.** The container's environment reaches `docker exec`:
  `box_run`, the box page's terminal and BB's daemon with what it starts.
  After the box is ready, bb-box writes the two variables into
  `/etc/environment` as root, keeping its other lines, which the command
  prelude, login shells and PAM (`sudo -i`, `su -l`) read. So a service
  started from a clean environment gets them too. A desktop's launcher,
  `setup/docker/start`, starts its session and services (XFCE, Cua Driver,
  Selkies) from a clean environment, so it now adds both variables from
  `BBBOX_GPU_CARD`, past the `NVIDIA_VISIBLE_DEVICES=void` a CDI spec may
  set; that needs desktop images built from this branch. Servers need no
  image change, so the gate uses production's images on the owner's host.
- **The check after start**, after an acquire and after each start of a box
  made by this unit: `nvidia-smi` lists the card, `cuInit` works, and CUDA's
  device 0 has the card's UUID (`cuDeviceGetUuid`, no context, no memory). A
  fresh box whose CUDA picks another card or finds none (its device answer,
  or `cuInit` 100, with the card listed), or whose `nvidia-smi` lists none,
  is removed, its card left out for 10 minutes, and placed once more on
  another card within the acquire, its record following it and the removed
  container's reservation dropped. When that fails too, or no other card
  can take it, the acquire is refused for each audience, naming each card
  and why, and nothing is left. Any other CUDA error, such as 802, and
  other failures keep the box on its card, which is not left out, and its
  GPU fact says what the check found. A started box
  cannot move on Docker, so its fact says what the check found.
- **The words.** A GPU box's facts: "GPU: card 0, shared, <model>, 32 GiB.
  Run nvidia-smi -i GPU-<UUID> to see it; every card on the host is listed."
  The words about reach come from the host's privilege, not from a kind's
  GPU: every box of every kind, CPU desktops included, on a host that lists
  cards and whose boxes are privileged, with GPU boxes on or off, and every
  GPU box where the cards are one device, has a `Cards` fact, which
  `box_status` and `box_acquire`'s answer show: "On <host>, every box with
  Docker in it can open every card, with a GPU or without. None and Whole
  card are what bb-box places, not what a box can reach." `box_list` says it
  once for each kind offered there, the New box form says it under
  Resources for the provider a box would go to, and the resize words and
  the doctor say it too.
- **The share switch.** `box_resize gpu` and `bb box resize --gpu` (and
  `bb box machines resize --gpu`) take none, shared or whole; the tool's and
  the CLI's whole is hidden while whole cards are off, as unit 8 does.
  Docker's `Resizing.gpu` is add `no`, share `live`, move `no`. Shared to whole
  is live where no other box holds the card, of any install, and refused
  naming them otherwise ("on Docker a box cannot move to another card");
  whole to shared is live. The plan is made again under the placement lock
  when carried out. The part is this install's, kept in bb-box's storage
  where every backend of the install reads it, by the container's ID, with
  the engine ID, name and Docker root of the daemon it was written on, and
  a generation that goes up at each switch. A release drops it. Otherwise
  the upkeep of a daemon with the engine ID it was written under drops it
  once no Docker daemon the install reaches lists its container, and never
  while bb-box cannot tell which daemons it reaches. The claim on the guest
  and the GPU fact follow it, and the record's `gpu` changes. A GPU added or
  removed is refused, with words for each audience. A backend whose
  `Resizing` has no `gpu`, Proxmox LXC until unit 9, refuses every GPU
  change.
- **The doctor.** `docker.gpus` lists the cards with their memory when read,
  the boxes per card, whether they are one device, and the reach words; it
  warns, naming them, when another install's GPU boxes are on the host, as it
  sees only the part they were made with; it warns when it could not read
  the cards just now, and fails, naming it, when a box holding a card whole
  matches no card it reads. `gpu.<card>.whole` fails a whole
  card with another box on it; `gpu.<card>.limit` (new) warns of a card over
  its limit, naming its boxes.
- `setup/docker/README.md` has a "GPU boxes" section in place of "GPU
  desktops".

### What was run

On a `linux` box, in `node:26-bookworm` as root with `--init`, as CI runs
them:

- `tsc` clean. The node suite: 3,820 tests, 3,398 passed, 112 failed, 310
  skipped; vitest, 469 passed. On main `4948d8a2` in the same container: 3,800
  tests, 3,378 passed, 112 failed, 310 skipped. The 112 are the same tests on
  both, by name: identity reset scripts that find none of the container's
  eth interfaces, and the snapshot, fork and keep tests built on them, the
  Android image check and `setup-mac.sh`; none is a GPU or Docker test.
  Without `--init`, `test/gpu-setup.test.ts` hangs on unreaped processes, on
  main too.
- `test/docker-gpus.test.ts`, 17 tests, against the fake docker, which now
  lists cards in a probe container and, in a box given them, answers
  `nvidia-smi` and CUDA's device by `CUDA_VISIBLE_DEVICES`: the kinds' parts;
  a shared server's device, labels, environment, `/etc/environment`, claim,
  facts and probe; a box with no GPU, privileged and not; WSL's one device;
  boxes per card with stopped boxes, boxes being made and another install's;
  the memory a server and a desktop need, and an unread card; whole
  placement, its refusals for each audience and whole cards off; two whole
  acquires at once, one container made; the share switch, its refusal and
  the fixed devices; a box whose CUDA picks another card; a start after a
  switch; `box_list`'s room; the doctor; the probe's parser; placement's
  order; the check's judge; the environment script on a file.
- `test/boxes.test.ts`, 3 tests: `box_resize gpu` live, recorded with its
  claim, and left out keeps the GPU; refusals for each audience of a GPU a
  backend cannot add or remove, a whole card it refuses, whole while whole
  cards are off, and a GPU change where the backend's `Resizing` or its plan
  has no GPU part; the resize line's words. `test/plugin.test.ts`:
  `box_resize`'s `gpu` and the CLI's `--gpu` offer no whole card while whole
  cards are off. `test/docker.test.ts`: today's GPU desktops' tests, now with
  the new words.
- 26 reverts, each rule on its own, each failing its tests, by a harness
  that patches the rule out, runs its tests and puts it back. Two of them,
  `box_resize`'s two GPU guards, first passed, as each covered the other;
  a test for each on its own was added, and both then failed.

### The rehearsal on a box with a fake card

On a `linux` box with Docker 29.1.3, the real path with a card that is not
there: `bbbox/linux:1` built from `setup/docker/build.sh linux`; a CDI spec in
`/etc/cdi` written as WSL's is, with only `nvidia.com/gpu=all`, giving two
fake cards, a fake `nvidia-smi` and a fake `libcuda.so.1` (C, honouring
`CUDA_VISIBLE_DEVICES`). Docker listed the device as soon as the file was
written, with no restart. A fresh `npx bb-app@0.48.1` in the box, with no
account, bb-box installed from this branch by the gate's script, against the
box's own Docker:

| Step | Result |
| --- | --- |
| The doctor | "GPUs: 2 NVIDIA cards as CDI devices (card 0, NVIDIA GeForce RTX 5090 (fake), 32 GiB, 31000 MiB free when read; card 1, ...), up to 4 boxes each. Docker gives them as one device, nvidia.com/gpu=all, as in WSL. On <box>, every box with Docker in it can open every card, ..." |
| `bb box acquire linux --gpu none` | Ready in 0.4 s, privileged, no device request, "Cards: On <box>, every box with Docker in it can open every card, with a GPU or without. ..." |
| `--gpu shared` | Ready in 0.7 s with "gpu 52 ms, card check 38 ms"; "GPU: card 0, shared, NVIDIA GeForce RTX 5090 (fake), 32 GiB. Run nvidia-smi -i GPU-…a to see it; every card on the host is listed." Docker keeps the device in `DeviceRequests` (`cdi`, `nvidia.com/gpu=all`); both variables in the container's environment and in `/etc/environment` |
| `bb box run` (as `box_run`) | `cuda-card.py load`: `result=0 devices=1 device0=GPU-…a`, a context and 64 MiB |
| The box page's terminal command, on a PTY | The login shell had `CUDA_VISIBLE_DEVICES=GPU-…a`, and CUDA picked card 0 |
| A service from `sudo -i` with the variables removed | Ran detached and picked card 0; a login from `env -i` had the variable, from `/etc/environment` through PAM |
| `CUDA_VISIBLE_DEVICES` set to another UUID | `result=100 devices=0` |
| `--gpu whole --check`, then the switch | Live in 55 ms; "GPU: card 0, whole, ..."; the doctor's "GPU 0 whole: Card 0 is <box>'s whole card, with no other box on it." |
| Another `--gpu shared` | On card 1, as card 0 was whole |
| `--gpu none --check` | Refused: "cannot lose card 0 on Docker" |
| Back to shared | Live in 54 ms |

The rehearsal found three faults in the gate's steps, fixed there: CDI
devices are in `HostConfig.DeviceRequests`, not `Devices`; `pgrep -f` matched
its own shell; and a terminal's input must wait for the shell. It also found
that the sweep releases the boxes of a thread the test BB does not know,
within two sweeps, so the gate's script makes a real project and thread.

### Deviations from the note

- Settings stay as units 7 and 8 left them: `gpu-desktops` (now worded "GPU
  boxes"), `desktops-per-gpu` (now "Boxes per card", counting every
  install's boxes on the card, as Docker counted desktops), `general.wholeCards`
  for whole, and 1,024 MiB a constant. The key renames are unit 15's.
- Resize's GPU part in core is built here for the share switch only, as unit
  9 has not been built: `ResizePlan.gpu` is a `GpuResize` with the words and,
  where refused, a refusal for each audience, not section 8's `GpuChange`
  with `installs`. Unit 9 extends it for Proxmox LXC.
- On WSL every GPU box gets every card, as the spec has one device; the words
  say so even where boxes are not privileged.
- Readings come from the probe container, not from a host report or a box,
  with their age in `box_list`. A placement reads the cards again when its
  reading is over 15 s old, which adds about a second to a GPU box's acquire.
- Today's GPU desktops made before this unit are counted on their cards as
  shared, and their starts run no check, as before.
- `linux-desktop` with gpu none is not offered on Docker: that is
  `linux-desktop-cpu`.

### After the reviews

Astra and Fable said no-go. The lead decided the fixes below, all in one
more commit; the pull request stays a draft until the gate passes and is
recorded here (Astra 1). Each fix has a test that failed with it reverted,
on a box: 16 reverts for these fixes (15 rules and the form's line), and the
25 reverts of the first round run again, one of them changed to the new
line, each failing its tests.

| Finding | Fix |
| --- | --- |
| The card lock and reservations were a backend instance's, so two backends on one daemon could both take a card whole (Astra 2) | The lock, the reservations and the cards left out are the Docker daemon's, by its ID, shared by every instance on it; switched parts are in the backend's storage, which its instances share. Of two backends of the install on one daemon, only the one whose ID sorts first makes boxes; the other refuses, for each audience, and the doctor's new `docker.one-backend` fails on it and warns on the first |
| A CUDA that found no device passed when `cuInit` returned 100 before its card was read (Astra 3) | CUDA's device answer is read whenever `nvidia-smi` lists the card, and a `cuInit` of 100 with the card listed is no device: both are a wrong card |
| A fresh box that failed its check was refused, not made again on another card, and the results said the registry would retry, which it does not (Astra 6, Fable 2) | Within the acquire, the box is removed, its card left out for 10 minutes and its record moved, and it is placed and made once more on another card; when that fails too, or no card can take it, it is refused naming each card and why. The results' words are corrected |
| The desktop's session and services lost both variables in the launcher's clean environment (Astra 4) | `setup/docker/start` adds them from `BBBOX_GPU_CARD`, which bb-box sets on every GPU box; `BBBOX_GPU_ID` is passed to a desktop that sees every card: privileged, or on `nvidia.com/gpu=all` (Fable) |
| The privileged-box words left out CPU desktops and were not in the New box form (Astra 5) | They come from the host's privilege and its cards, for every kind, with GPU boxes on or off: the `Cards` fact, `box_list` once per kind, and a line under Resources in the New box form for the provider a box would go to |
| Devices named by index whose cards could not be read refused every GPU desktop (Fable 1) | They are kept by device: shared boxes go on them, with no CUDA variables and no check, as before this unit; whole, and a switch to whole, are refused on them |
| A box with no GPU ran the probe (Fable) | The reach words come from `docker info`'s devices, so a box with no GPU never reads the cards |
| Comment lines added to `test/fake-docker.mjs` (Astra 7) | Removed |

Then, on a `linux` box in `node:26-bookworm` as root with `--init`: `tsc`
clean; the node suite, 3,827 tests, 3,405 passed, 112 failed, 310 skipped,
the 112 the same environment's failures as before, by name, as on main in
the same box; vitest, 470 passed. `test/docker-gpus.test.ts` has 24 tests.
One plugin test, a try to join BB with a set clock, failed once in a run of
its own on this box and passed again; it fails on main the same way.

### The gate

Run by the lead on 6 November 2026 (UTC) on the owner's Windows PC, <host>,
with one NVIDIA GeForce RTX 5090 (32 GiB), the driver 610.88 in Windows, and
Docker 29.8.1 in an Arch Linux distribution in WSL, the WSL2 kernel 6.6.87.2.
Nothing reached the host but the lead. Every step that used the card first
read it card-wide and went on only under 10 per cent busy and 2 GiB in use;
one test GPU box at a time; one CUDA load.

**Read-only checks and setup (A and B, 06:32 to 06:33).** The card had 0 per
cent busy and 1,126 MiB in use, Windows' own. WSL had `/dev/dxg`, NVIDIA's
`libcuda`, NVML, `libdxcore` and `nvidia-smi`, one driver store folder of
NVIDIA's that the toolkit chose, and one card. Docker read CDI specs from
`/etc/cdi` and `/var/run/cdi`, listed no devices, ran `runc` by default with
the owner's `nvidia` runtime registered, and was not rootless. NVIDIA's
Container Toolkit 1.20.0 was already installed, so nothing was installed.
`nvidia-ctk cdi generate --mode=wsl --output=/etc/cdi/nvidia.yaml` wrote one
device, `nvidia.com/gpu=all`, and `docker info` listed it at once, with no
restart. A probe container as bb-box makes it, given that device, had
`/usr/bin/nvidia-smi`, `/dev/dxg` and `python3`, and listed the card with
its memory. The spec stays: production's Docker GPU boxes there need it once
this unit merges.

**The test BB.** It ran in the same WSL distribution, as root: `npx
bb-app@0.48.1` with no account, as a transient systemd unit, listening on
127.0.0.1 only, with bb-box from a tarball of `dd6f4370` (without `docs/` and
`site/`), enrolment and nightly images off, whole cards on, and a Docker
backend on the distribution's own Docker socket, network `bbbox-gate`, GPU
boxes on and no desktop images, so nothing left the host. It used the
images production's bb-box had built there that day, and built none. Every
box was made, run, resized and released through the test BB's CLI, `bb box
...`, and its terminal through the box page's own WebSocket route; Docker
was only read. The scripts are in the report to the lead; each wrote all it
did to a file, and each ended "done".

| Step (UTC) | Evidence |
| --- | --- |
| Stand-up (15:57) | The doctor: "1 NVIDIA card as CDI devices (card 0, NVIDIA GeForce RTX 5090, 32 GiB, 31244 MiB free when read), up to 4 boxes each. Docker gives them as one device, nvidia.com/gpu=all, as in WSL. On <host>, every box with Docker in it can open every card, with a GPU or without. None and Whole card are what bb-box places, not what a box can reach." The test BB listened on 127.0.0.1 alone |
| C3 (15:59) | The doctor as above, and no other backend of the test install on the daemon. `bb box kinds --json`: `linux` offers gpu none, shared and whole; card 0 with no box, 31,244 MiB free, free for a whole card; 1,024 MiB needed; the reach words on every kind offered |
| D0 | The card 0 per cent busy, 944 MiB in use. No bb-box container on the daemon, of any install |
| D1, a privileged box with no GPU | `bb box acquire linux --gpu none`, ready in 1.8 s: its status has the Cards line and no GPU line; Docker shows it privileged with no device request and no card label. Through `bb box run`, as root in the box, `/dev/dxg` (`crw-rw-rw-`) opened; no `libcuda` and no `CUDA_VISIBLE_DEVICES`: it can open the card, as the words say, though bb-box gave it none |
| D2, a shared server | `bb box acquire linux --gpu shared`, ready in 3.0 s, with "gpu 0.3 s, card check 0.5 s": claim the card's UUID, shared, generation 1, granted. Status: "GPU: card 0, shared, NVIDIA GeForce RTX 5090, 32 GiB. Run nvidia-smi -i GPU-<UUID> to see it; every card on the host is listed." and the Cards line. Docker: privileged, a `cdi` request for `nvidia.com/gpu=all`, labels with the card and `shared`, and `CUDA_VISIBLE_DEVICES`, `NVIDIA_VISIBLE_DEVICES` and `BBBOX_GPU_CARD` set to the card. In it, `/etc/environment` had both variables, `nvidia-smi -L` listed the card, and `nvidia-smi -i "$NVIDIA_VISIBLE_DEVICES"` named it |
| D3, `box_run`'s route, the one load | `cuda-card.py load` through `bb box run`: CUDA's device 0 the card's UUID, one device, and "64 MiB allocated, set and freed on device 0, result 0", in 1.1 s. The card read four times a second, card-wide: 944 MiB in use before (median of 13), 946 at most during (12), 944 after. The 2 MiB is WSL's card-wide reading of a CUDA context and a 64 MiB load, which CUDA reported made, set and freed: under WSL that figure does not follow a box's allocation as it does on Linux. The load was under 1 GiB and 60 s either way |
| D4, a terminal | The box page's terminal route, a WebSocket to the test BB, the box user's login shell: both variables the card's, and CUDA's device 0 the card |
| D5, a service | Started detached through `sudo -i` from an environment without the variables, so only `/etc/environment`, through PAM, could give them: CUDA's device 0 the card, and the process ended. A login from an empty environment had `CUDA_VISIBLE_DEVICES` set to the card |
| D6 | With `CUDA_VISIBLE_DEVICES` naming another UUID, CUDA returned 100 with no device: the variable picks the card |
| D7, whole and the switch | The check: "GPU: shared → whole card 0 · Live", with the reach words. The switch, live in 0.8 s: "GPU: card 0, whole, ...". A shared acquire was refused before any container: "No card on <host> can take a shared GPU now: card 0 is <box>'s whole card (in thread ...)". `--gpu none --check` refused: "cannot lose card 0 on Docker: a container's devices are fixed when it is made". The doctor: "GPU 0 whole: Card 0 is <box>'s whole card, with no other box on it." Back to shared, live in 0.8 s |
| D8 (16:00) | The test box released; the daemon's bb-box containers the same as at D0, none; none of the test install's left; the card 0 per cent busy, 944 MiB in use |
| Clean-up (16:00) | No test container left; the unit stopped and nothing answering on its port; `bbbox-gate` and the test BB's folder removed; `/etc/cdi/nvidia.yaml` kept |

The doctor also warned, as for any Docker host without it, that the host has
no LXCFS, and that no nightly image rebuild had run on the test BB, whose
nightly images were off.

What the gate did not cover: more than one card (the tests cover placement
across cards and WSL's one device for several); a desktop with a GPU, as
Xorg cannot draw on `/dev/dxg`; and switches seen by another install.

### After the second reviews

Astra said no-go and Fable go, with one medium finding. The lead decided the
fixes below, in one more commit. Each has a test that failed with it
reverted, on a box: 10 reverts for these fixes, and the 41 reverts of the
earlier rounds run again, 5 of them changed to the new lines, each failing
its tests.

| Finding | Fix |
| --- | --- |
| A daemon was known by its engine ID alone, which a cloned host keeps, so two daemons, such as two Docker roots on one machine, were one, and the second backend refused every box, with a GPU or without (Astra 1) | A daemon is its engine ID, its name and its Docker root from its own `docker info` together; where they differ, the backends are on two daemons. Where two backends still look like one daemon, the second refuses GPU boxes alone, for each audience, and makes boxes with no GPU as usual; the doctor's `docker.one-backend` warns on both and no longer fails |
| A backend that was off, or had only listed, released or kept up its boxes, counted on the daemon, so an old backend kept off beside a new one stopped it (Fable) | A backend counts once it places or plans a box there, through a capacity check, an acquire or a resize plan, and only while it is on in the install's settings; listing, releasing and upkeep use the daemon's lock without joining it |
| A failed probe changed a card's key from its UUID to its device, so boxes, reservations and whole claims stopped counting on it, and a shared box went on a card held whole (Astra 2) | A card keeps its key across readings: where a probe fails, bb-box names the cards as last read, their free memory not known, so no whole card is placed, and the doctor warns. With no reading since bb-box started, a box's card is matched by its device. A box holding a card whole that matches no card bb-box reads stops every GPU placement there, for each audience, until it does, and the doctor fails, naming it |
| A retry counted the reservation of the container it had removed, so with room for one more box it refused (Astra 3) | The retry drops that reservation before it reads the host |
| Any CUDA error removed a fresh box and left its card out for 10 minutes (Astra 4) | Only CUDA's no-device answer (100) or another card's UUID does. Any other, such as 802 (system not ready), keeps the box on its card, with the error in its GPU fact, and the card is not left out |

Then, on a `linux` box in `node:26-bookworm` as root with `--init`: `tsc`
clean; the node suite, 3,833 tests, 3,411 passed, 112 failed, 310 skipped,
the 112 the same environment's failures, by name, as on main (`ed5d3dee`)
in the same box, where 114 failed; vitest, 470 passed.
`test/docker-gpus.test.ts` has 30 tests.

The gate's results stand: none of these changes alters what it proved. It
ran one backend on its daemon; every reading of the card succeeded; no fresh
box failed its check, so none was made again; and CUDA returned 0 in each
check. D6's 100 was CUDA run in the box, not bb-box's check, and a 100 in the
check still removes a fresh box. The doctor's words the gate quoted are the
same where the cards are read and no second backend counts.

### After the third review

Astra said no-go, with one finding. A share switch was kept in the storage of
the backend that made it, so a backend made later on the same daemon read
the container's label, shared, and put another shared box on a card held
whole, while the first box kept its whole claim. Astra reproduced this by
acquiring a shared box through one backend, switching it to whole, turning
that backend off and acquiring a shared box through a new one.

The lead decided the fix. A box's current part is kept in bb-box's storage
where every backend of the install reads it, on or off, under the daemon and
the container's ID. Placement, capacity, `held` and the doctor of any backend
on that daemon read it. A release drops it, and so does the next upkeep of a
backend on that daemon after its container has gone, without touching
another daemon's records. A settings check reads it through a layer, so it
changes nothing there. (The fourth review changed the key: see below.)

A test runs Astra's sequence: the new backend refuses the shared box, naming
the whole box, and the first keeps its whole claim. Each of 5 rules has a
revert that fails it, on a box: the shared record, the one storage every
backend's context gives, the drop at upkeep, the drop at release, and
records kept per daemon. Then, on a `linux` box in `node:26-bookworm` as root
with `--init`: `tsc` clean; the node suite, 3,834 tests, 3,412 passed, 112
failed, 310 skipped, the 112 the same environment's failures, by name, as on
main (`ed5d3dee`)
in the same box; vitest, 470 passed. The 41 reverts of the earlier rounds
and the 10 of the second ran again, one changed to the new write, each
failing its tests.
`test/docker-gpus.test.ts` has 31 tests.

The gate's results stand. Its switches, shared to whole and back at D7, were
made and read through its one backend. With this fix, that backend writes
and reads the part in the shared storage instead, and the words and claims
are the same.

### After the fourth review

Astra said no-go, with one finding. The record's key named the daemon by its
engine ID, name and Docker root, and Docker's name follows the host's, which
can change while the engine ID stays. Astra acquired a shared box, switched
it to whole, renamed the host, reconnected and acquired a shared box: both
boxes got the same card.

The lead decided the fix. Every read, by placement, capacity, `held`, the
doctor and a resize plan, finds a box's switched part by its container's ID,
which Docker makes random, 64 hex characters long, and never changes,
whatever the daemon is called now. The record carries the engine ID, name
and Docker root it was written under. Upkeep deletes a record only when its
container is gone from this daemon and it was written under this daemon's
engine ID, or, where a daemon has none, its name and root; a release deletes
its own box's record. So a host renamed keeps its boxes' switches and drops
its records of containers gone, and one daemon's upkeep never drops
another's. (This let cloned hosts, which share an engine ID, drop each
other's records; the next section changes it.)

A test runs Astra's sequence, through the backend that switched the box and
through one made after the rename, and checks capacity, `held`, a resize
plan and the doctor too; Astra's earlier sequence, a backend turned off and
one made later, runs as before. Each of 8 rules has a revert that fails it,
on a box: the shared record, the one storage every backend's context gives,
the lookup by container ID whatever the daemon is called, the drop at
upkeep, the drop by engine ID after a rename, another daemon's records kept,
the drop at release, and the daemon a record was written under. Then, on a
`linux` box in `node:26-bookworm` as root with `--init`: `tsc` clean; the
node suite, 3,835 tests, 3,413 passed, 112 failed, 310 skipped, the 112
the same environment's failures, by name, as on main (`ed5d3dee`) in the same
box; vitest, 470 passed. The 51 reverts of the earlier
rounds ran again, one changed to the new write, each failing its tests.
`test/docker-gpus.test.ts` has 32 tests.

The gate's results stand: it did not rename its host, and its one backend
writes and reads the part by the container's ID now, with the same words and
claims.

### The rule for dropping a record, changed by the lead

Under the fourth review's rule, two cloned hosts sharing an engine ID would
each drop the other's records, as the other's containers are not on them,
and so forget the other's whole switches. The lead changed the rule. Upkeep
drops a record only when its container is gone from this daemon and either
it was written under this daemon's engine ID, name and root, or it was
written under this daemon's engine ID with a name and root that no Docker
daemon the install reaches has now, which is a rename of this daemon. A
record whose name and root are another reached daemon's is never dropped
from here.

The daemons the install reaches now are asked for at that moment, and only
when such a record is found: each Docker backend bb-box has built, on or off,
reads its daemon's `docker info`. If any of them does not answer, bb-box
cannot tell, and keeps the record. Hetzner Cloud and Namespace hosts are not
asked: their Docker hosts have no GPU boxes, so they write no such record.

Tests: two cloned hosts with one engine ID, each with a box switched to
whole, keep both records through each other's upkeep and refuse a shared box
on their whole cards; each drops only its own record once its container is
gone. A renamed host keeps its record while bb-box cannot tell which daemons
it reaches, and drops it once it can. The registry reports every Docker
backend's daemon, on or off, and none while one does not answer. Each of 7
rules has a revert that fails it, on a box, and the 57 earlier reverts ran
again, 1 changed to the new call and 2 replaced by these, each failing its
tests. Then, on a `linux` box in `node:26-bookworm` as root with `--init`:
`tsc` clean; the node suite, 3,837 tests, 3,415 passed, 112 failed, 310
skipped, the 112 the same environment's failures, by name, as on main
(`ed5d3dee`) in the same box; vitest, 470 passed.
`test/docker-gpus.test.ts` has 34 tests.

The gate's results stand: it ran one daemon, renamed nothing and dropped no
record.

### After the fifth review

Astra said no-go, with two findings, both from a host's name changing:

- after two cloned hosts each switched a box to whole, one was renamed; the
  other's upkeep dropped the renamed clone's record, as its old name was no
  longer reached, and a shared box went on its whole card (high)
- a rename while an acquire was making its box gave the daemon a new share,
  without the pending box's reservation, so two boxes went on one card
  (medium)

The lead decided the fix, taking the name out of everything but one check:

- The lock, the reservations and the cards left out are kept by the engine
  ID alone, which a rename does not change. Cloned hosts with one engine ID
  share them, so they place one at a time; their cards have different UUIDs,
  so no card is counted for the other. Each reservation names the backend
  that made it and counts only on that backend's daemon, so a box one clone
  is making takes none of the other's memory, cores or box count, as
  Hetzner Cloud hosts made from one snapshot would otherwise. A backend
  always counts its own, through a rename too. This last part is the
  builder's, beyond the lead's decision.
- The engine ID, name and Docker root together only tell two backends on
  one daemon apart, so that the second stops only GPU boxes.
- Upkeep drops a record only when its container is gone from every Docker
  daemon the install reaches, and bb-box can tell which those are; the
  daemon whose upkeep drops it must have the engine ID the record was
  written under. The lead's rule counted only daemons sharing that engine
  ID; this counts every daemon reached, which keeps a record wherever its
  container is listed, as on a clone whose engine ID was made new. A release
  still drops its own box's record.

Astra's two reproductions are tests: the renamed clone keeps its record and
refuses a shared box on its whole card, and a rename while a whole box is
being made refuses a shared box on that card ("card 0 is kept whole for
pending-whole, which bb-box is making"). Every earlier sequence still runs:
the backend turned off and the one made later, the rename and reconnect,
the clones, and two backends on one daemon. Two more tests: a box one clone
is making takes none of the other's room, and after a rename a backend still
counts its own pending whole card when a settings check's instance of it
last read the old name. Each of 11 rules has a revert that fails it, on a
box, and the 57 earlier reverts ran again, 3 changed to
the new lines and 4 of the last round's replaced by these, each failing its
tests. Then, on a `linux` box in `node:26-bookworm` as root with `--init`:
`tsc` clean; the node suite, 3,841 tests, 3,419 passed, 112 failed, 310
skipped, the 112 the same environment's failures, by name, as on main
(`ed5d3dee`) in the same box; vitest, 470 passed.
`test/docker-gpus.test.ts` has 38 tests.

The gate's results stand: it ran one daemon, whose share and record are the
same under either key.

### After the sixth review

Astra said no-go, with two medium findings:

- after a rename while one backend was making a whole box, another backend
  on the daemon compared its new name with the first backend's name as last
  read, the old one, so it did not count the pending box and put a shared
  box on its card
- a reconfigure while a box was being made cleared the old instance's
  share, so its acquire dropped its reservation from an empty one, and the
  box was counted for ever, boxes with no GPU too

The lead decided the fixes:

- Whose daemon a reservation counts on is read from its owner at that
  moment: when bb-box reads the host, as for every placement under the lock,
  it asks each backend with a reservation for its daemon now. When the
  owner cannot be asked, as once it is gone, or does not answer, the
  reservation counts. A name never drops one.
- An acquire keeps the share it reserved in and drops its reservation from
  that share. A new instance of a backend already joins the share its engine
  ID has, so a reconfigure keeps the boxes being made, and a test now holds
  it to that.

The builder's rule of the last round that a backend always counts its own
reservations is now part of the first: its own read says its daemon.

Astra's two reproductions are tests: after a rename, the other backend
refuses a shared box with "card 0 is kept whole for pending-whole, which
bb-box is making", and still does once the first backend is disposed; a
reconfigure while a box with no GPU is being made leaves the new instance
counting it, and once the acquire ends and the box is released, the host
has room again. Every earlier sequence still runs. Each of 5 rules has a
revert that fails it, on a box, and the 66 earlier reverts ran again, 1
changed to the new call and 2 of the last round's replaced by these, each
failing its tests. Then, on a `linux` box in `node:26-bookworm` as root with
`--init`: `tsc` clean; the node suite, 3,843 tests, 3,421 passed, 112
failed, 310 skipped, the 112 the same environment's failures, by name, as on
main (`ed5d3dee`) in the same box; vitest, 470 passed.
`test/docker-gpus.test.ts` has 40 tests.

The gate's results stand: it ran one backend, whose reservations count on
its daemon as before.

### After the seventh review

Astra said no-go, with one medium finding. The daemon's lock first reads
`docker info` to find the share, and that read had no signal. So a resumed
acquire with no GPU, on a fresh backend whose BB machine was slow to be
ready, ignored its cancellation, and the plugin could not stop: main's
`Boxes.dispose()` settled at once, this branch's stayed pending.

The fix passes each operation's signal through the placement lock to that
read, for every placement, resize, release and upkeep, and to the read for a
switched part's record. The builder checked the other calls this unit added
on the placement path: each already had its signal. As the lock is now one
per engine ID, shared by every instance of a backend, waiting for it ends
when the signal aborts too; work already running under it ends by its own
signal, so no reservation is made after its acquire has given up.

Tests: Astra's reproduction, a plugin stopping while a resumed acquire with
no GPU waits for a fresh backend's BB machine, settles at once; and a
placement waiting for the lock that another instance holds ends when its
signal aborts. Each of 3 rules has a revert that fails it, on a box, and the
71 earlier reverts ran again, 3 changed to the new calls, each failing its
tests. Then, on a `linux` box in `node:26-bookworm` as root with `--init`:
`tsc` clean; the node suite, 3,845 tests, 3,423 passed, 112 failed, 310
skipped, the 112 the same environment's failures, by name, as on main
(`ed5d3dee`) in the same box; vitest, 470 passed.
`test/docker-gpus.test.ts` has 42 tests.

The gate's results stand: its operations were never cancelled, and an
operation that is not cancelled runs as before.

### Still open

- A switch made by one install is not seen by another on the same host; the
  doctor warns where two installs have GPU boxes there.

## Unit 12: the userspace update after a driver change

Built on main `07b96c95`, on branch `u71-12`, and rebased onto main
`6ef653f5`. Section 6's update of a box's NVIDIA userspace after the host's
driver changes, as a person's operation on its own, and the reading of each
box's userspace that it rests on. No helper or template change. Nothing
updates a box's userspace by itself: only `bb box gpu update`, which a person
runs. Its gate passed on the node on `476dd54d`, after two rounds of reviews
by Astra and Fable, whose last checks said go.

### What it does

- **Each box's userspace is read.** bb-box reads NVIDIA's userspace in a box
  with a GPU, on a backend whose boxes keep it on their own disks (Proxmox
  LXC), after its acquire, after each start bb-box makes, after each restore,
  during and after an update, and in the doctor for each running box. A
  reading is the version file, `/usr/share/bb-box/nvidia-version`, and the
  version of the `libnvidia-ml.so.1` it finds; the record keeps both
  (`userspaceRead`), with the host's driver as bb-box knew it then, and
  `nvidiaUserspace` becomes the library's version. Where the two disagree,
  the userspace is half-installed. A snapshot's take reads the box itself,
  whatever the record says, so a userspace changed in the box since is the
  one recorded.
- **The host's driver** comes from the backend (`Backend.nvidiaHost`). On
  Proxmox LXC it is the driver the node's GPU helper reports now; with no
  helper, it is read then from a running box of the install, never a value a
  desktop saw at an earlier start; where the helper is not reporting, or there
  is no helper and no running box shows the driver, bb-box says why and
  updates nothing. Docker does not offer it:
  NVIDIA's Container Toolkit gives each box the host's own userspace.
- **`bb box gpu update <box>`**, for one box or several, one at a time. Before
  anything changes it refuses a box that is stopped ("Start box X first"),
  has no GPU, or is on a backend that keeps no userspace in its boxes, and a
  host whose driver bb-box cannot tell. It reads the box's userspace and
  stops there when it is the host's driver and its last update finished. It
  then runs one check in the box, as root: x86_64, bb-box's own Linux image
  (Ubuntu 24.04 with its image record), 2 GiB free in `/var/tmp`, no
  `nvidia-*`, `libnvidia-*` or `cuda-drivers` package from apt in any state
  but not installed or configuration files only (held, unpacked and
  half-installed ones count), a list of packages it could read, the box seeing
  the host's driver as the helper reports it, and the processes that have a
  `/dev/nvidia*` node open. `--check` says what it would do: "bb-box installs
  NVIDIA's userspace 580.142 in lone-pine, over 570.86, then restarts it.
  Everything running in it stops: python3 (3310) has the GPU open.", names
  threads working on the box, and offers `--snapshot` where the backend
  snapshots. It is refused while a person holds the box's desktop and, unless
  `--force`, while threads work on it, as a resize's restart is (061), and
  asked again just before the restart, so a thread that began working during
  the download stops the update before it restarts the box. The check's
  script comes on stdin: `--check`, and a refusal, write nothing in the box;
  the update's files go in with the download.
- **The steps**, recorded on the box (`userspaceUpdate`) before the first:
  `fetch`, the installer for exactly the host's driver downloaded in the box
  from NVIDIA and checked against NVIDIA's SHA-256 (one already there and
  matching is kept); `install`, with `nvidia-userspace.sh`, the same script
  and flags as the templates, no kernel modules, which writes the version
  file and the drivers' unit; for a desktop, `DISPLAY_MODE=auto`; then
  `restart`, a stop and a start through the backend, so the start gate and
  the card check run as for any start; then `check`: the userspace read
  again is the host's driver, `nvidia-smi` lists the claimed card and
  `cuInit` returns 0, and for a desktop its display is on the GPU and its
  video comes from NVENC. The installer and its files are removed once
  installed. The restart's stop and start are in the box log, by the person's
  command.
- **One update at a time, in the box.** The update's script holds a lock,
  `/run/bb-box-nvidia-update.lock`, with `flock` while it downloads and
  installs, and NVIDIA's installer keeps it as the script's child, so it is
  held for as long as any of them runs, even after bb-box has gone. The
  kernel drops the lock when its last holder exits, so a dead installer
  leaves none behind. While it is held, a reading of the box says so: the
  reading is not recorded, an update cut short stays `unknown`, the doctor
  says "An earlier update of NVIDIA's userspace is still running in box X:
  bb-box reads its userspace once it ends, and starts no other update until
  then.", and a new update, `--check` and Update again included, is refused
  before any check. The script refuses too, should one get past. The box's
  record keeps when a reading last saw the lock held, until a reading sees it
  free, so `bb box status`, the box's view and an agent's `box_status` say the
  same and offer no Update again meanwhile.
- **When it does not finish.** A failed download changes nothing in the box.
  A failed install leaves the box running, not restarted, and reads it: a
  half-installed userspace is named, with "run bb box gpu update X again". A
  failed restart or check leaves the box with its disk, says what happened,
  and keeps the update named as not finished until Update again. When bb-box
  stops in the middle, the update is `unknown`: it was cut short. The next
  sweep, or the doctor, reads the box again where it runs, and the update
  becomes failed with what the box had; an install that had finished is left
  at its restart. A box left starting or stopping by the cut is settled from
  its power first. The box is never released for it. A failed update stops
  being named once a reading shows the host's driver as read then, after a
  start bb-box made since the update, a restore's included, or after a
  download that failed: the update is then done, and no update reinstalls a
  box that matches. The start is kept on the update's record, so a reading
  that comes later, after the start's own reading failed, still counts it.
- **The doctor**, a section of its own: `gpu-userspace` counts the boxes with
  a GPU whose userspace is the host's driver; `gpu-userspace.<box>` warns for
  each that is not, that is half-installed, or whose last update did not
  finish, with the command: "Box lone-pine has NVIDIA's userspace 570.86, and
  the host's driver is 580.142: nvidia-smi and CUDA fail in it until its
  userspace is updated." and "Fix: Update it: bb box gpu update lone-pine
  --thread <thread>". A stopped box is named as bb-box last read it, and one
  never read as "not checked". Spares are left out.
- **What a person and an agent see.** `bb box status` adds a line with the
  same words and the command. An agent's `box_status` and `box_acquire` say
  "nvidia-smi in lone-pine fails: its NVIDIA userspace is 570.86 and the
  host's driver 580.142. Ask the user to update it.", or that it is
  half-installed and to ask the user to update it again. No agent tool
  updates it. The box's view (`bb box status --json` and the panel's) carries
  the reading, the update and a notice with its action, `update` or
  `update-again`, for unit 14's page.
- `setup/proxmox-lxc/README.md` says what to do after a driver change.

### What was run

On a `linux` box, in `node:26-bookworm` with `--init`, as CI runs them, on
the branch's last commit, after the reviews' round:

- `tsc` clean, and `node scripts/reference.ts --check` clean after the
  reference was written again (the new command and the two new checks).
- The node suite as root, rebased on main `6ef653f5`, run alone: 3,889
  tests, 3,468 passed, 111 failed, 310 skipped. Each failure is one of main's
  in the same container (3,849 tests, 3,425 passed, 114 failed, 310 skipped,
  run beside two other runs at a load of about 60 on 8 cores): identity reset
  scripts that find none of the container's eth interfaces, the snapshot,
  fork and keep tests built on them, the Android image check and
  `setup-mac.sh`, as unit 11 found. Four of main's pass here: three
  timing-bound under that load, and one of the Android image check's. vitest:
  471 passed, as on that main.
- The new files as the box user: 42 passed, and the one that needs root
  skipped.
- `test/gpu-userspace.test.ts`, 21 tests, through `Boxes` with the fake
  backend, a card and a fake NVIDIA userspace in its box: the check and the
  update over an older userspace, with its steps in order, the restart's
  guard asked twice and the restart in the box log; the refusals before
  anything changes; an install that leaves a half-installed userspace, and
  Update again; bb-box stopping mid-install, then its sweep; an earlier
  update still running, which leaves the update unknown, refuses a new one
  and is settled once it ends; a crash that left the update running and the
  box starting, read first by the doctor; nothing updated by an acquire, a
  start, a stop, the sweep or the doctor, and the doctor's words for a
  running box, a stopped one and one never read, and why it did not read a
  running one; the doctor reading a change bb-box did not make; a check
  after the restart that fails, that cannot run, and an install that changed
  nothing; the guard refusing just before the restart; a restart that fails;
  a failed update settled by a matching reading, against the host's driver
  read then, and after a start whose own reading failed; a held lock in
  status with no Update again, and an update not read since it was cut short
  sending the person to the doctor; a desktop's check on the
  GPU; a person's machine and a spare; and the CLI: `--check`, the restart's
  guard and `--force`, `--snapshot`, and several boxes.
- `test/gpu-userspace-scripts.test.ts`, 14 tests: the update script on a fake
  root (its check, apt packages installed, held, unpacked, half-installed and
  not installed, a list it cannot read, an `os-release` that is missing; the
  download against NVIDIA's SHA-256 from a `file://` mirror, a mismatch,
  another driver and a version that is not one; the install, a desktop set to
  auto, its files removed, and a failed install; the lock, held by an
  installer's child left running, refusing a second fetch and install, seen
  by a reading and by the check, and gone once its holder is killed), the
  files bb-box puts in the box with the download, the root wrapper and the
  whole check from stdin as root, and the judges and words.
- `test/gpu-userspace-proxmox.test.ts`, 3 tests: Proxmox LXC's host driver
  from the real helper on unit 2's fake node, read again when it changes,
  none for a kind it does not offer, why it cannot tell, and with no helper
  read each time from a running box of the install.
- `test/snapshot-gpu.test.ts`: a take reads the box rather than its record;
  a restore to a snapshot with an older userspace reads the box again and
  the doctor names it, with nothing updated; a restore's start settles an
  update that failed after its install. Its earlier take test gives its fake
  box a userspace to read.
- Each rule was reverted on its own on the box, and its tests failed: 94
  reverts, by a harness that patches each rule out, runs its tests and puts
  it back. Two of them, the abort of an update when bb-box stops and the
  refusal of a new one meanwhile, fail by their test's timeout.
- `shellcheck` on the update script: clean. Each block of the node steps
  passes `bash -n` and `shellcheck`, with its shared definitions.

### The gate on the node, first run

Run by the lead on the node and by the builder on a test BB, on 6 November
2026 (UTC), on `af0d2f6b` before the lock below. The test BB was a fresh
`npx bb-app@0.48.1` on a Proxmox LXC box, with no account, bb-box installed
from `git archive af0d2f6b`, live checks off, its server the systemd unit
`tbb`, and iptables letting only the box itself and the lent addresses reach
its two ports. Its thread's agent was a script that calls bb-box's tools as
an agent does. The lead added its Proxmox LXC backend: the test pool,
production's Linux template (NVIDIA 580.142), the lent VMIDs and addresses,
desktops per GPU 2, no desktop templates and no warm boxes. One test GPU
guest, T1, a shared server; no load but `nvidia-smi` and `cuInit`.

| Step | Evidence |
| --- | --- |
| 0 (22:42) | The helper 0.4.3 with writes on, serving the test pool; driver 580.142; both cards about 97 GiB free; 38 guests in `u5-check.sh`'s baseline |
| A (22:43) | T1 made shared on card 1, its claim g1 granted, ready in 5.3 s; its record and the box both 580.142, file and library; no update files. On the node: T1 the one lent VMID, the server set of lines on card 1's `/dev/nvidia0` |
| B (22:43 to 22:44) | 570.195.03 installed in T1 from NVIDIA, SHA-256 checked; `nvidia-smi` exits 18, "Driver/library version mismatch". The doctor: "Box T1 has NVIDIA's userspace 570.195.03, and the host's driver is 580.142: nvidia-smi and CUDA fail in it until its userspace is updated.", Fix "Update it: bb box gpu update T1 --thread <thread>"; `bb box status` the same; an agent's `box_status` "nvidia-smi in T1 fails: its NVIDIA userspace is 570.195.03 and the host's driver 580.142. Ask the user to update it."; no agent tool updates it |
| C (22:44) | Snapshot "older": shared, card 1, userspace 570.195.03 |
| D (22:44 to 22:45) | `--check`: "bb-box installs NVIDIA's userspace 580.142 in T1, over 570.195.03, then restarts it. Everything running in it stops." The update: "Updated NVIDIA's userspace in box T1 from 570.195.03 to 580.142, and restarted it, in 34 s. nvidia-smi in it lists card 1, shared, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 96 GiB, and CUDA's driver initialises." (33,719 ms by its record, download included). On the node: the helper stopped and started T1; its marker, claim g1 and lines unchanged; no mismatch |
| E (22:45 to 22:47) | The restore's check: "This snapshot has NVIDIA's userspace 570.195.03, and the host's driver is now 580.142: nvidia-smi will fail in the box until its userspace is updated." After the restore the doctor names T1. After the doctor, a stop and start, and the test BB's restart: still 570.195.03, the last update still D's, no update files, the installer's log untouched |
| F (22:47 to 22:48) | The test BB killed at 22:48:04 with NVIDIA's installer running in T1. Its sweep at its start read T1 at 22:48:08, 570.195.03, and named the update cut short with Update again. See the finding below |
| G (22:49) | Update again: "Updated NVIDIA's userspace in box T1 from half-installed (libraries 580.142, version file 570.195.03) to 580.142, and restarted it, in 22 s." The doctor names nothing |
| H (22:49 to 22:50) | T1 released; no lent VMID in use or holding a card; no mismatch; the helper wrote no guest outside the lent VMIDs; `u5-compare.sh`: no GPU guest changed but production's three it started (power starts only) |

**The finding.** The kill did not stop the installer in T1: it ran on past
the sweep's reading and installed the 580.142 libraries, and the script
around it never wrote the version file. At 22:48:58 T1 had libraries 580.142
and a version file 570.195.03 and no NVIDIA process; the doctor, which reads
running boxes again, named it half-installed. For about 50 s the record was
out of date, and an Update again in that window would have run a second
installer beside the first. The lock above closes it, and the gate's step F
now waits for the lock to clear, says what bb-box said meanwhile, and checks
from the node that the installer has ended.

### After the first review

Astra said no-go, with three findings; the lead decided they go in this round
with the lock. Fable's review was still running.

| Finding | Fix |
| --- | --- |
| The apt guard passed held, unpacked and half-installed NVIDIA packages (high) | The script lists every package's state with `dpkg-query` and counts any `nvidia-*`, `libnvidia-*` or `cuda-drivers*` package not in `not-installed` or `config-files`, or with a `reinstreq` flag, naming its state; a list it cannot read refuses the update |
| An aborted command does not stop the installer, and a retry could overlap it (high) | The lock above, held by the installer itself, checked by every reading and every update |
| The gate's sweep step could pass with no sweep run (medium) | Step E runs `bb box sweep`, which answers only once a sweep has finished, and reads T1 after its report; step F the same once the lock has cleared |

Fable then said no-go, with seven findings; the lead decided they go in the
same round.

| Finding | Fix |
| --- | --- |
| No guard against an installer that runs on after bb-box is cut off, which the updated gate steps already assert (high) | The lock above, at the path and with the words the steps expect; the update's check reports it too |
| A failed update outranked a fresh reading that matches, for ever, and an update then reinstalled a box that matched (medium) | A reading after a start bb-box makes, a restore's included, or after a download that failed, that shows the host's driver settles the update as done |
| The restart's guard ran minutes before the restart (low) | It is asked before anything changes and again just before the stop; refused then, the update is left at its restart, with Update again |
| `--check` wrote the update's scripts into the box (low) | The check's script comes on stdin; the files go in with the download |
| A failed restart said "with its disk as it was" after its install (low) | "with the new userspace on its disk" |
| The doctor's "not checked" assumed a stopped box (low) | A running box it did not read says why: bb-box was working on it, or could not read the host's driver |
| With no helper, Proxmox gave the driver a desktop saw at an earlier start (low) | It reads the driver from a running box of the install each time, or says why it cannot |

Astra's re-review said no-go, with two medium findings and a low one; the
lead decided all three go in this round.

| Finding | Fix |
| --- | --- |
| A failed update was settled against its own target, not the host's driver, so after a failed download and a host back on the box's driver it reinstalled the same version (medium) | It is settled against the host's driver as the reading found it |
| Only the reading made at a start counted it, so a start whose reading failed was lost, and later matching readings never settled the update (medium) | A start is kept on the failed update's record (`restartedSince`) before its reading, and every later reading counts it |
| The held lock reached the doctor but not status, which still offered Update again (low) | The box's record keeps when a reading saw the lock held (`userspaceRunningSeenAt`); status, the view and `box_status` say an earlier update is still running, with no action, until a reading sees the lock free |

Fable's re-review said go, with one low finding, which the lead put in this
round: for an update cut short and not read since, `bb box status` told the
person to update again, which the lock may refuse. Status now says that `bb
box doctor` reads the box and says whether that update is still running and
when to update it again, with no action; an agent is told to ask the user.

### The gate on the node, second run

Run by the lead on the node and by the builder on the same test BB, on 7
November 2026 (UTC), on `476dd54d`, after every review's fixes: the lock,
the apt guard, the sweep's evidence and the re-reviews'. The test BB had
bb-box installed from `git archive 476dd54d`, and the same backend: the test
pool, production's Linux template (NVIDIA 580.142), the lent VMIDs and
addresses, desktops per GPU 2. One test GPU guest, T1, a shared server on CT
3241; no load but `nvidia-smi` and `cuInit`; both cards idle at the end.

| Step | Evidence |
| --- | --- |
| 0 (before 00:17) | The helper 0.4.3 with writes on, driver 580.142, 42 guests in `u5-check.sh`'s baseline, both cards over 96 GiB free; the lent VMIDs free. The first run's files kept apart |
| A (00:17) | T1 made shared on card 0, claim g1 granted, ready in 12.4 s (clone 3.2, start 4.2, network 2.6 s); its record and the box 580.142, file and library; no update files; `nvidia-smi -L` lists card 0. On the node: T1 the one lent VMID, holding card 0 running, with the server set of lines (`/dev/nvidia1`, `nvidiactl`, `nvidia-uvm`, `nvidia-uvm-tools`) and no desktop nodes |
| B (00:18:07 to 00:18:54) | 570.195.03 installed in T1 from NVIDIA, SHA-256 checked; `nvidia-smi` exits 18, "Driver/library version mismatch". The doctor: "Box T1 has NVIDIA's userspace 570.195.03, and the host's driver is 580.142: nvidia-smi and CUDA fail in it until its userspace is updated.", Fix "Update it: bb box gpu update T1 --thread <thread>"; `bb box status` the same; an agent's `box_status` "nvidia-smi in T1 fails: its NVIDIA userspace is 570.195.03 and the host's driver 580.142. Ask the user to update it."; no agent tool updates it; no update record |
| C (00:18:54) | Snapshot "older": shared, card 0, userspace 570.195.03, read from the box |
| D (00:18:57 to 00:21:42) | `--check`: "bb-box installs NVIDIA's userspace 580.142 in T1, over 570.195.03, then restarts it. Everything running in it stops.", with `--snapshot` offered and "Changes nothing (--check)". The update: "Updated NVIDIA's userspace in box T1 from 570.195.03 to 580.142, and restarted it, in 158 s. nvidia-smi in it lists card 0, shared, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 96 GiB, and CUDA's driver initialises." 158,287 ms by its record, most of it NVIDIA's download: T1's installer log ends at 00:21:24 (34 s in all in the first run). On the node: T1's marker (g1, shared, card 0), claim and lines as at A; no mismatch; the helper's journal has one stop and one start of T1 for the restart |
| E (00:22:26 to 00:23:39) | The restore's check: "Its GPU stays as it is now: shared, card 0." and "This snapshot has NVIDIA's userspace 570.195.03, and the host's driver is now 580.142: nvidia-smi will fail in the box until its userspace is updated." After the restore the doctor names T1 with 570.195.03 against 580.142. After the doctor, a stop and start, the test BB's restart and `bb box sweep`, whose report came back (all counts 0): still 570.195.03, the last update still D's, no update files, the installer's log untouched |
| F (00:23:45 to 00:24:13) | The test BB killed at 00:23:59 with NVIDIA's installer running in T1. At 00:24:02 the lock in T1 was held: the doctor said "An earlier update of NVIDIA's userspace is still running in box T1: bb-box reads its userspace once it ends, and starts no other update until then."; T1's update stayed `unknown`; a new update said "Not changed: an earlier update of NVIDIA's userspace is still running in box T1: … Run this again once it has ended: bb box doctor says when it has." (`try_again`). The lock was free by 00:24:07, with no installer running. `bb box sweep` then read T1: libraries 580.142, version file 570.195.03, half-installed; the update failed at its install step, "bb-box restarted before the update finished. When bb-box read the box again, it had a half-installed NVIDIA userspace: NVIDIA's libraries 580.142 and a version file that says 570.195.03."; status and the doctor: "Update it again: bb box gpu update T1 --thread <thread>". On the node: no NVIDIA installer process in T1 and no update lock held; T1's version file 570.195.03 and library 580.142; NVIDIA's installer log ends at "Running post-install sanity check:", so the installer ended before its sanity check finished |
| G (00:24:44 to 00:26:04) | Update again: "Updated NVIDIA's userspace in box T1 from half-installed (libraries 580.142, version file 570.195.03) to 580.142, and restarted it, in 57 s. nvidia-smi in it lists card 0, shared, …, and CUDA's driver initialises." The update done; T1 580.142, file and library; no update files; the doctor: "1 box with a GPU has NVIDIA's userspace for its host's driver." |
| H (00:26) | T1 released with its snapshots. On the node: no lent VMID in use or holding a card; no mismatch; the helper wrote no guest outside the lent VMIDs; `u5-compare.sh`: 8 GPU guests of 42 before and 8 of 43 after, no guest changed but production's own power actions (one stopped and deleted, two started); both cards idle |

So the lock did what the first run found was missing: the installer bb-box's
kill left running kept the lock for about 5 s after the test BB was back,
bb-box read nothing as settled meanwhile and refused a second update, and it
read and named the half-installed userspace only once the installer had
ended.

Limits: one node and one server; the cards loaded nothing; a desktop's
update is tested with the fake backend only. The kill's timing decides what
the installer leaves; both runs left a half-installed userspace.

### Deviations from the note

- Where it is offered: `bb box gpu update` and the doctor, and `bb box
  status`. The box's page ("Update NVIDIA's userspace…") and the settings'
  list of cards are units 14 and 15; the box's view already carries the
  notice and its action.
- The installer is always downloaded in the box from NVIDIA and checked
  against NVIDIA's SHA-256. The host's artifacts are not used: bb-box's token
  cannot read the node's files.
- The snapshot offered first is `--snapshot`, taken before the update, not a
  dialog's choice.
- The update has no box log events of its own, as new event kinds need a
  migration of the box log's table: it is recorded on the box and in the
  server's log, and its restart's stop and start are in the box log.
- The doctor's check is bb-box's own, per box, `gpu-userspace.<box>`, with a
  summary, not `proxmox.gpu-userspace`: the boxes are bb-box's records, and
  the templates' part stays in each template's image check, as unit 7 left
  it. It reads each running box with a GPU at each run: one short command a
  box.
- A box with no GPU is refused: nothing in it uses the userspace. Adding a GPU
  to a box without the host's userspace is unit 10's.
- The desktop's check after the restart reads its display mode and probes
  Selkies' video for NVENC, as `bb-box-check-desktop`'s two lines do, not
  the whole of that check.

### Still open

- A desktop's update is tested with the fake backend only: the gate is on a
  server, as a GPU desktop's display can take more of a card than the gate's
  256 MiB allows.
