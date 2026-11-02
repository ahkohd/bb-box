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
  guest, and then starts it. With no card that has room, it is not started:
  "Container 7021 was not started: No card on pve can take another box now:
  ... It is stopped, with its disk as it was." Memory is not part of the
  start gate (see deviations). A start returns the claim it started with,
  and the box's record takes it, with its GPU fact naming the card it holds
  now, also when it starts on the last report's grant while the helper is
  not reporting. A release, and the readings of GPU memory in running
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
- **The helper, 0.3.0.** Protocol 1. The marker gains `gpu.release.g<N>`:
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
  lines for it. One with a row the helper cannot read, or that ends with an
  error status or is cut short, decides no request on any card and changes
  no guest's lines. Each is named in an `error` line, so the preview fails.
- **A lost ledger** is rebuilt from the guests as before, with two changes.
  A guest whose card a guest the helper cannot read may hold is left out,
  and its request waits. And the rebuild strips no stopped guest's lines, at
  boot or after: a stopped copy, a guest whose lines do not match its
  marker, and a whole box whose card another guest still has are refused,
  `copy` or `ledger-lost`, keep their lines, and are decided when bb-box
  asks again, as it does before it starts them.
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
  `proxmox.gpu-migration` reads a `gpu.release` marker as no marker.

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

### The node steps

Wait for the lead, after unit 4's day has passed and this unit is merged and
deployed: the helper upgraded to 0.3.0 with writes off and the test pool
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
  writes off: desktops are made and marked, and the doctor warns. The lead
  decided this (Opus 3).
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
  rule). Before, a lost ledger at boot stripped a stopped guest whose lines
  did not match its marker, so that its `onboot` start could not use a card
  no claim names. Now it is refused, `ledger-lost`, and keeps them. bb-box
  asks again before it starts the box, but a start outside bb-box, by
  `onboot` or by hand, uses those lines until then.
- With the desktop kind off, or its templates cleared, a stopped box with a
  marker still goes through the start gate. It may start on the card the
  helper holds for it, and is moved to no other.
- Choosing among the templates on a card still counts boxes by the template
  each was made from, as does the path with no helper. A box moved to another
  card counts against its first template there. It changes only which of a
  card's templates a new box is cloned from, never the card; without a
  helper, no box moves.

### Still open

- Whether a lost ledger at boot should strip a stopped guest whose lines do
  not match its marker, as before R3, for guests that start `onboot`. As
  built, it never strips; see deviations.
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
