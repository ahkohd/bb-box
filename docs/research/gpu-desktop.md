# The GPU in a desktop box

How apps in a Linux desktop box render on the host's NVIDIA GPU, when the box
is an unprivileged container and the desktop is streamed rather than shown on
a monitor.

Status: a working path is measured; a better one is proposed and needs one
experiment. Checked on 30 September 2026.

## Recommendation

1. **Ship what works now:** a real Xorg server with NVIDIA's driver on a
   virtual screen, streamed by `x0vncserver`. GL and Vulkan run on the GPU,
   and so do Chrome and GPUI apps.
2. **Move to Selkies' patched Xvfb on the GPU** if the experiment below
   passes. It keeps the screen on the GPU through glamor and DRI3 on the
   render node, so it resizes, needs no display device, and lets one GPU
   serve as many desktops as its memory allows. The same binary without
   `-glamor` is the CPU fallback, so a desktop has one display server in both
   cases.
3. **Keep the rules that apply to either path:** the userspace driver in the
   template must match the host's kernel driver exactly; one GPU is visible
   per desktop; the box reports whether it came up on the GPU or fell back to
   the CPU.

## What was measured

On a Proxmox VE 9.2 host with NVIDIA RTX PRO 6000 Blackwell GPUs, kernel
driver 580.142, in an unprivileged LXC container with the userspace driver
installed from NVIDIA's `.run` with `--no-kernel-modules`.

| Display server | OpenGL | Vulkan | Result |
| --- | --- | --- | --- |
| Xtigervnc 1.13.1 | CPU (llvmpipe) | NVIDIA cannot present ("Could not find both graphics and present queues"); lavapipe presents on the CPU | CPU only |
| Xtigervnc with VirtualGL 3.1.5 (EGL back end) | GPU, glxgears about 9,500 fps | none: VirtualGL has no Vulkan support | GL only, per app with `vglrun` |
| Xorg with NVIDIA's driver on a virtual 1920x1080 screen, served by `x0vncserver` | GPU (GLX, NV-GLX, Present) | GPU, vkcube about 7,700 fps | everything on the GPU |

With Xorg and NVIDIA's driver:

- It runs unprivileged and rootless, with no virtual terminal, using
  `AllowEmptyInitialConfiguration` and `UseDisplayDevice "none"`.
- Chrome 154 reports hardware acceleration for canvas, compositing, raster,
  WebGL, WebGPU and video decode (ANGLE on EGL and GL).
- Zed's GPUI `hello_world` (Zed main at 8da42dd) builds in 3.5 minutes and
  runs on NVIDIA Vulkan through wgpu, using 46 MiB of GPU memory.
- Two Xorg servers share one GPU, at 40 to 47 MiB each. Chrome's GPU process
  adds 100 to 300 MB.

Its limits:

- **No resize from the viewer.** With no display device there are no RandR
  outputs, so `x0vncserver` refuses a viewer's SetDesktopSize. `xrandr --fb`
  still resizes the screen, from 8x8 to 32767x32767, odd sizes included,
  and `x0vncserver` and XFCE's panel follow it, with Chrome still on GPU
  compositing.
  Measured later on 30 September; see
  [021](../decisions/021-desktop-resize-through-the-backend.md).
- **One GPU visible per desktop.** With two GPUs passed in, Vulkan device 0
  could not present. The desktop template passes in one GPU's nodes only.
- **CPU capture.** `x0vncserver` copies the screen from GPU memory for every
  update.
- **Old `x0vncserver`.** Ubuntu 24.04 ships TigerVNC 1.13.1. `x0vncserver`
  gained clipboard support only in 1.15, and 1.16.2 fixes CVE-2026-34352
  (other local users can read or drive the screen). A box has one user, so
  the CVE matters little, but the missing clipboard is a real gap.

## The proposed path: Selkies' patched Xvfb

Selkies 2.0 builds XLibre's Xvfb (25.2.2) with glamor, GBM and DRI3 and four
patches:

1. the screen pixmap lives on the GPU, so an app's present is a copy on the
   GPU;
2. spare RandR outputs, so the screen resizes and can gain a second display;
3. DRI3 1.4 explicit sync (timeline syncobjs), which NVIDIA's driver needs
   because it attaches no implicit fence to shared buffers;
4. the fake vblank runs at the stream's capture rate.

NVIDIA's own GLX and EGL client libraries and its Vulkan swapchain present
into this server through DRI3. Selkies' documentation compares it with an
Xorg that owns the GPU: the patched Xvfb lets "one GPU serve as many
containers as it has memory for", while Xorg is "one GPU per container". It
also lets Selkies capture and encode without the frame leaving the GPU
(DRI3 zero-copy to NVENC).

| | Xorg with NVIDIA's driver | Patched Xvfb with glamor |
| --- | --- | --- |
| GL and Vulkan on the GPU | measured | documented by Selkies; to be measured here |
| Resize | `xrandr --fb` only, not from the viewer | yes (RandR), checked on the CPU |
| Desktops per GPU | measured 2 | limited by memory |
| Needs | `nvidia_drv.so` from the `.run`, a GPU card node | `/dev/dri/renderD*`, `/dev/nvidia-modeset`, NVIDIA's GBM backend (in the `.run`) |
| CPU fallback | a different server (Xtigervnc) | the same binary without `-glamor` |
| Capture for streaming | CPU copy (`x0vncserver`), or NvFBC for Selkies | CPU copy (`x0vncserver`), or DRI3 zero-copy for Selkies |
| vsync | normal | NVIDIA apps should run with `__GL_SYNC_TO_VBLANK=0`; Selkies measured vsync adding about 30 ms of input latency |

Checked locally, without a GPU: `build-xvfb.sh` builds on Ubuntu 24.04 in
about two minutes and produces one 2.9 MB binary with `-glamor` and `-dri`;
it starts, and `xrandr --fb 2560x1440` resizes it, with two spare outputs.

## Experiment

Run inside a clone of the desktop template, with the template's device lines
plus `/dev/nvidia-modeset` and the GPU's `/dev/dri/renderD*`. First check on
the host that `cat /sys/module/nvidia_drm/parameters/modeset` prints `Y`;
NVIDIA's GBM backend needs it.

Build the server (as root in the box):

```sh
apt-get install -y --no-install-recommends ca-certificates curl gcc git meson ninja-build patch \
  pkg-config libaudit-dev libbsd-dev libpixman-1-dev libselinux1-dev libssl-dev libx11-dev \
  libxau-dev libxcvt-dev libxdmcp-dev libxext-dev libxfont-dev libxkbfile-dev libxshmfence-dev \
  mesa-common-dev x11proto-dev xtrans-dev libdrm-dev libepoxy-dev libgbm-dev libgl-dev \
  libglvnd-dev libtirpc-dev
git clone --depth 1 --branch 2.0.0 https://github.com/selkies-project/selkies /tmp/selkies
XLIBRE_TAG=xlibre-xserver-25.2.2 \
XLIBRE_SHA256=3c1f07f4b5f8a483473097be4b964ee97a2b92adde9de6c0d8d9d7217a382810 \
DESTDIR=/opt/xvfb /tmp/selkies/addons/base/build-xvfb.sh
```

Run it (as the box user, with the Xorg desktop stopped or on another display):

```sh
/opt/xvfb/usr/bin/Xvfb :98 -verbose 1 -glamor -dri /dev/dri/renderD128 \
  +extension COMPOSITE +extension DAMAGE +extension GLX +extension RANDR +extension RENDER \
  +extension MIT-SHM +extension XFIXES +extension XTEST +iglx +render \
  -nolisten tcp -noreset -shmem -s 0 -dpms > /tmp/xvfb98.log 2>&1 &
export DISPLAY=:98 __GL_SYNC_TO_VBLANK=0
xrandr --fb 1920x1080
grep -iE 'glamor|egl|pixmap' /tmp/xvfb98.log
glxinfo -B | grep -E 'direct rendering|OpenGL vendor|OpenGL renderer'
vulkaninfo --summary | grep -E 'deviceName|driverName'
timeout 10 vkcube
xfce4-session &          # then open chrome://gpu and run GPUI hello_world
nvidia-smi               # memory per process
```

Record:

1. the vendor and renderer for GL, and whether vkcube presents on NVIDIA;
2. `chrome://gpu` feature status, and GPUI `hello_world` on Vulkan;
3. `xrandr --fb 2560x1440` and back, with Chrome and GPUI running;
4. a second instance on `:97` on the same GPU, with the memory of each;
5. with Selkies 2.0.0 (the Ubuntu 24.04 `.deb`) on `:98`, whether the log
   reports DRI3 zero-copy capture and NVENC.

If step 1 fails, check `/dev/nvidia-modeset` in the box and NVIDIA's GBM
files (`/usr/lib/x86_64-linux-gnu/gbm/nvidia-drm_gbm.so`) from the `.run`.

## What the core needs

- **Kind capabilities:** `gpu: true`, and the stream's type and whether it
  resizes (see [desktop streaming](desktop-streaming.md)).
- **Box status:** after start, whether the desktop is on the GPU or fell back
  to the CPU, and why (no device, driver mismatch). The panel shows it; the
  agent can read it.
- **Capacity:** the backend reports GPU desktops in use and free per GPU, so
  the core can refuse or fall back before the GPU runs out of memory. This is
  a backend concern; the core only reads the numbers.
- **Driver drift:** the template records the driver version it was built
  with, and the box compares it with the host's at boot. A mismatch means the
  CPU fallback and a notice to rebuild the template.
- **Other tenants:** if other workloads on the host allocate most of a GPU's
  memory at start, desktops holding memory can make those workloads fail to
  start. Setup should let the operator cap GPU desktops per GPU.

## Sources

- Selkies 2.0.0: `addons/base/build-xvfb.sh`, `addons/base/patches/xvfb-*.patch`,
  `addons/base/services/xvfb/run`, `docs/components/desktop-image.md`,
  `docs/components/kde-images.md`: https://github.com/selkies-project/selkies
- XLibre X server: https://github.com/X11Libre/xserver
- TigerVNC release notes (x0vncserver clipboard in 1.15, CVE fix in 1.16.2):
  https://github.com/TigerVNC/tigervnc/releases
- CVE-2026-34352: https://explore.alas.aws.amazon.com/CVE-2026-34352.html
- KasmVNC GPU acceleration (DRI3 on open-source drivers only):
  https://www.kasmweb.com/kasmvnc/docs/1.3.4/_sources/gpu_acceleration.md.txt
