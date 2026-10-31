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
