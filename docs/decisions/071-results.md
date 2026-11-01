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
