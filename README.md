# bb-box

bb-box gives each BB thread its own computers: fast Linux boxes on the
operator's Proxmox host, controlled from BB by the operator and by the thread's
agent.

## Goal

bb-box is for the operator's personal use with BB. A box is a resource of the
BB thread that asked for it, not a security boundary: anyone who can start the
operator's BB threads already has everything. A box exists so an agent has its
own environment for real computer, browser and app development work.

Requirements, from the operator on 30 September 2026:

- A BB thread can have up to 10 boxes at a time.
- Crazy fast startup.
- A box has access to everything its thread has.
- A **desktop** box where the agent does real computer-use and browser-use
  work, for example profiling a web app or working on a GPUI project, with a
  real GPU.
- A **headless** box for the agent's own work, so it runs Docker and backend
  services there instead of on the operator's machine.
- The operator controls all of this in BB, and so does the agent.

What matters, in order: UX, startup speed, BB integration. Do not add security
hardening that serves none of these. Keep what makes bb-box reliable: clean-up
when a thread ends, limits against runaway use, and recovery after a crash.

## Decisions

bb-box replaces Stead (`moonstead/stead`), which leased VMs through a Crabbox
coordinator and adapter and wrapped them in a security design the operator did
not want. These were decided on 30 September 2026, from measurements on
Moonstead:

- **No Crabbox, no coordinator.** A box belongs to one thread, and BB already
  knows who the operator and the agent are, so BB is the coordinator. The
  bb-box BB plugin calls the Proxmox API itself and reaches boxes over SSH and
  VNC. BB's plugin SDK serves HTTP and WebSocket routes
  (`bb.http.route`, `bb.http.experimental_websocket`), agent tools, a panel,
  thread lifecycle events and machine providers.
- **LXC containers, not VMs.** On Moonstead (Proxmox VE 9.2, kernel 6.17), a
  linked clone of an Ubuntu 24.04 CT template took 1 s, starting it 1 s, and
  systemd finished booting in 0.8 s. Crabbox took 55 s to hand over the same
  container. Containers share the host's NVIDIA driver, so many desktops share
  one GPU; a VM would need a whole GPU passed through. Docker runs in an
  unprivileged container with `nesting=1`. bb-box has no VMs: the operator
  decided a VM is overkill for this use.
- **Microsandbox is not needed.** It boots faster (about 100 ms) but has no
  display or GPU on Linux, runs one process under its own init rather than
  systemd, and is beta. Containers boot in under a second, and a warm pool
  hides even that.

## Architecture

```
BB server (LXC 115)
 └─ bb-box plugin
     ├─ registry: each thread's boxes (kind, VMID, address, state), in plugin storage
     ├─ Proxmox API: linked clone from a CT template, set cores, memory, disk,
     │   features and devices, start, stop, delete; tags name the owning thread
     ├─ warm pool: a few started boxes per kind, handed out at once and refilled
     ├─ SSH to each box: run commands, copy files, set up the thread's access
     ├─ WebSocket route: noVNC in BB's panel to each desktop box's VNC server
     ├─ agent tools: create, list, status, release, exec, copy, screenshot and
     │   Cua input for desktops
     ├─ panel: every box in the thread; start, stop, view, take control
     └─ thread archive and delete: delete that thread's boxes; a sweep deletes
         boxes whose thread is gone
Moonstead (Proxmox)
 ├─ CT templates: bbbox-headless (dev tools, Docker) and bbbox-desktop
 │   (XFCE, TigerVNC or NVIDIA Xorg, Chrome, Cua Driver, NVIDIA user space)
 ├─ pool bbbox, VMIDs in a dedicated range
 └─ guest bridge with NAT: boxes reach the internet, LAN and tailnet like the
     thread's own machine, and the tailnet and LAN reach boxes by address
```

A box gets what its thread has: the thread's Git credentials and machine
variables, BB (a box can also be enrolled as a BB machine, so a child thread
can run on it), and network reach. The thread's agent can SSH to its boxes, for
example with `DOCKER_HOST=ssh://<box>`.

Taking control of a desktop is shared: the operator drives the agent's own
desktop, and the agent's Cua input pauses until they hand back.

## Plan

1. Headless boxes end to end: CT template with Docker, plugin registry and
   Proxmox driver, SSH exec, agent tools, panel list, clean-up. Target: a
   thread gets a working headless box in a few seconds.
2. Desktop boxes: CT template with the desktop stack and the NVIDIA GPU, noVNC
   through the plugin, shared control, Cua tools. Target: an agent profiles a
   web app in Chrome and runs a GPUI example on the GPU.
3. Thread access: Git credentials, machine variables, BB machine enrolment for
   child threads, network reach both ways.
4. Speed: warm pool, and anything else between request and ready.
5. Retire Stead: switch the operator's threads to bb-box, then remove Stead,
   its Crabbox services in LXC 116 and the guest gateway, with the operator's
   approval.

Stead stays in production until bb-box replaces it.
