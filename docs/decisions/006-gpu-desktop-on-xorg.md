# 006: The Linux GPU desktop runs Xorg with NVIDIA's driver, streamed by x0vncserver

Status: accepted, 30 September 2026. Research:
[the GPU in a desktop box](../research/gpu-desktop.md). Partly superseded by
[021](021-desktop-resize-through-the-backend.md): the screen resizes with
`xrandr --fb`, so the backend resizes it for the viewer.

## Context

The desktop box exists for GPU-rendered apps: Chrome with WebGL and WebGPU,
and native apps such as GPUI apps on Vulkan. In an unprivileged container with
no monitor, measured on an NVIDIA GPU:

| Display server | Result |
| --- | --- |
| Xtigervnc | CPU only; Vulkan cannot present on NVIDIA |
| Xtigervnc with VirtualGL | OpenGL on the GPU, no Vulkan |
| Xorg with NVIDIA's driver on a virtual screen | OpenGL, Vulkan, Chrome and GPUI all on the GPU |

Selkies' patched Xvfb would keep the screen on the GPU and allow resizing and
more desktops per GPU. It needs the host's `nvidia_drm` module loaded with
`modeset=Y`, and changing that means reloading the module or rebooting the
host.

## Decision

- The desktop template runs Xorg with NVIDIA's driver on a virtual screen,
  served by `x0vncserver` from upstream TigerVNC 1.16.2. Ubuntu 24.04's 1.13.1
  lacks clipboard support in `x0vncserver` and the fix for CVE-2026-34352.
- Each desktop sees one GPU. With two GPUs visible, Vulkan could not present.
- Without a usable GPU (no device, or a driver mismatch), the box falls back
  to Xtigervnc on the CPU and reports why.
- The patched Xvfb is parked until the operator sets `modeset=Y` on the host.
  Then the experiment in the research note decides whether to switch.

## Consequences

- The desktop cannot resize to the panel; it keeps the size it started with.
- `x0vncserver` copies each update from GPU memory on the CPU.
- Each desktop uses 40 to 47 MiB of GPU memory for Xorg, and Chrome's GPU
  process 100 to 300 MB more. The backend reports GPU desktops per GPU, and
  a setting caps them so other workloads on the host keep their memory.
- The box reports whether it came up on the GPU or the CPU. The panel shows
  it and the agent can read it.
