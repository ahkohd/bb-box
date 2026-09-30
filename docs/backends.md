# Backends

A backend is where bb-box gets boxes from. bb-box does not care who the provider is: Proxmox, LXC, a VM, a physical machine, Crabbox or a cloud is a backend behind one interface, [src/backends/types.ts](../src/backends/types.ts).

Several backends can be active at once. Each has its own settings under its own prefix in bb-box's settings, with a switch to turn it on.

## Core, transports and backends

The code has three parts.

| Part | Folder | Does | Never |
|---|---|---|---|
| Core | `src/core/` | registry, lifecycle, agent tools, panel, BB enrolment, thread access, computer use, desktop viewer | names a provider, hypervisor, container technology or transport |
| Transports | `src/transports/` | reach inside a box: run commands and copy files (SSH now), stream a desktop (VNC now) | know which provider made the box |
| Backends | `src/backends/<type>/` | adapt one provider: acquire and release, address, capacity, and which transports reach each box | run anything inside a box for the core |

The core uses only [src/backends/types.ts](../src/backends/types.ts) and [src/transports/types.ts](../src/transports/types.ts). A backend composes transports: `transports(guest, kind)` returns the command transport and display endpoint for a box.

Everything that runs inside a box goes through the command transport and is written once in the core, for each guest OS: POSIX sh for Linux and macOS, PowerShell for Windows. That covers BB enrolment, giving the box the thread's access, `run` and file copies, and computer use.

### Transports

- **Command**: a `CommandTransport` probes, runs a script, streams a script's output, and writes and reads files. `SshTransport` in [src/transports/ssh.ts](../src/transports/ssh.ts) is the first. WinRM or an in-box agent can follow for Windows. `waitUntilAnswers` in [src/transports/ready.ts](../src/transports/ready.ts) polls any command transport every second until the box answers.
- **Display**: a `DisplayEndpoint` says where a desktop stream connects: protocol, host and port. VNC now; RDP or WebRTC later. The desktop viewer in the core turns it into a view in BB.

## Virtual and real machines

Every backend says whether its boxes are virtual or real.

| | Virtual | Real |
|---|---|---|
| Examples | Proxmox LXC, Proxmox QEMU, macOS VMs on a Mac mini | a Mac mini, a Linux PC, a Windows PC |
| Acquire | clone and start a guest, or take a ready one from the warm pool | claim a free machine from the configured pool |
| Release | delete the guest | reset the machine to a clean state and return it to the pool |
| Capacity | free memory and disk on the host | free machines in the pool |
| Held by | one box | one box, so one thread, at a time |

A real backend never creates or destroys a machine. Its release is a reset: for example, it ends the box user's processes and wipes their home directory, or reimages the machine. The panel and tools say a real box is "being reset and returned", not deleted.

### Pools of ready machines

A virtual backend's warm pool and a real backend's machine pool are the same idea: machines that are ready and that no box holds. `ReadyPool` in [src/backends/pool.ts](../src/backends/pool.ts) holds the shared part. It picks a free member that can serve a kind, and it makes sure only one box holds a member at a time. Each backend brings its own `PoolStore`, which says where membership lives:

- **Proxmox LXC** keeps it in Proxmox tags. A warm guest is tagged `warm`. Claiming it retags it for its box, so no state is lost if bb-box's storage is.
- **Real backends** use `KvPoolStore`, which keeps holders in plugin storage and machine details in settings.

## The lifecycle

1. The registry asks the backends that offer a kind for `capacity`. It uses the first backend with room. If none has room, the user sees the backend's message, for example "pve has 3.1 GiB of memory free; a linux-desktop box needs 8 GiB and 4 GiB is kept spare".
2. The registry records the box and returns at once.
3. In the background it calls `acquire(box, previous, hooks, signal)`. The backend:
   - calls `hooks.claim(guest)` before it makes or changes anything, so a restart can resume it and the sweep can find the guest;
   - calls `hooks.starting()` when the guest is booting;
   - reports each step with `hooks.timing`;
   - returns when its command transport answers.
   If acquiring fails, the backend releases what it claimed before it throws.
4. The box is ready. If its kind can enrol, bb-box enrols it as a BB machine.
5. `release(guest)` deletes or resets it. A missing guest counts as released.

The registry and sweep may repeat any call, so every method must be safe to repeat.

A box is released only when:

- the agent or the user releases it;
- its thread is archived or deleted.

Nothing is released for age or idleness. The sweep runs at start and every few minutes as a safety net:

- it releases boxes of threads that are archived, deleted or gone;
- it finishes releases that were interrupted;
- it asks each backend for the guests it `held()` and releases any whose thread ended;
- it adopts guests whose thread is live but whose record was lost;
- it calls `maintain()`, which tops up warm pools.

## Kinds and capabilities

A backend declares its kinds. Kind IDs are unique across backends. The tools and panel follow each kind's capabilities.

| Capability | Meaning | Proxmox LXC |
|---|---|---|
| `os` | `linux`, `windows` or `macos` | `linux` |
| `desktop` | has a graphical desktop | `linux-desktop` only |
| `gpu` | has a GPU | `linux-desktop` only |
| `docker` | Docker runs in it | yes, through nesting=1 on the template |
| `command` | command transport for `run` and file copies, or none | `ssh` |
| `display` | desktop stream protocol, or none | `vnc` for `linux-desktop` |
| `enrol` | can enrol as a BB machine | yes |

The kind's capacity check is the backend's `capacity` method.

If a kind has no command transport, `run` and file copies fail with a clear message. The box can still be viewed and released. If a kind cannot enrol, bb-box does not try.

## Errors

A backend throws `BackendError` with a code when the registry should act on it:

- `no_capacity`: no room;
- `unsupported`: the kind cannot do this;
- `gone`: the guest no longer exists.

A transport throws `TransportError`:

- `unreachable`: the box did not answer. The registry checks power, starts a stopped box and tries once more;
- `unsupported`: the transport cannot do this on the box's OS.

Any other error is shown as it is, so its message must make sense to a user and must never include a credential.

## Adding a backend

1. Create `src/backends/<type>/` with a `BackendDriver`. Reuse a transport from `src/transports/`, or add one there if the provider's boxes need a new one:
   - `type`: also the backend's ID;
   - `settings`: setting descriptors whose keys start with the driver's prefix, including an enable switch;
   - `parse`: turns setting values into a typed config, or a list of problems;
   - `create`: builds the `Backend`.
2. Add the driver to `DRIVERS` in [src/backends/index.ts](../src/backends/index.ts).
3. Test it against a fake of its API, like `test/fake-proxmox.ts`.
4. Add it to this document.

Nothing else changes. The registry, tools, panel and machine provider pick up its kinds.

## Proxmox LXC (built)

- Nature: virtual.
- Code: [src/backends/proxmox-lxc/](../src/backends/proxmox-lxc/), with the Proxmox API client in [src/backends/proxmox/](../src/backends/proxmox/), which the QEMU backend will share.
- Kinds, each from its own CT template:
  - `linux-headless`: Docker through `nesting=1`;
  - `linux-desktop`: Xorg with the GPU over VNC, falling back to CPU rendering.
- Acquire:
  1. Take a warm guest if one is ready. Otherwise, make a linked clone of the kind's template into the pool, in bb-box's VMID range. If a VMID is taken, try the next.
  2. Set tags, cores, memory, and net0 with the static address fixed to the VMID.
  3. Grow the root disk.
  4. Start.
  5. Wait until SSH answers.
- Release: stop and delete with purge.
- Ownership lives in Proxmox tags (`bbbox`, `thread.<id>`, `box.<id>`, `kind.<kind>`), so the sweep finds guests even if bb-box's storage is lost.
- Capacity:
  - the node's available memory, less what boxes still starting will use, must keep the memory reserve after the new box;
  - the template's storage must have more free space than the disk reserve;
  - a free VMID is needed;
  - a warm guest always fits.
- Transports: SSH as the template's box user, and VNC on port 5900 of a desktop box's address. Commands load the thread's BB machine environment from `~/.config/bb-box/env`, which bb-box's host entry writes after the box enrols.

## Planned: Proxmox QEMU for Windows

- Nature: virtual. Kinds: `windows-desktop`, perhaps with a GPU.
- Acquire: linked clone of a QEMU template (`/nodes/{node}/qemu/{id}/clone`), then set cores, memory and net0, then start. It shares the Proxmox API client in `src/backends/proxmox/` and the address plan.
- Ready means the command transport answers. Windows has no SSH by default. The kind declares `command: "agent"` for a small agent baked into the template, or `"winrm"`, with scripts in PowerShell. If neither is set up, it declares `command: null`.
- Display: RDP on port 3389.
- Enrol: no, until BB runs on Windows.

## Planned: Mac mini, real

- Nature: real. Kinds: `macos-desktop`.
- Settings list the machines by name and address, with an SSH key.
- Acquire: claim a free machine through `ReadyPool` with a `KvPoolStore`, create or unlock the box user, and wait for SSH.
- Release:
  1. end the box user's processes;
  2. delete and recreate the box user's home from a template;
  3. return the machine to the pool.
  If the reset fails, the machine is held back from the pool and marked for the operator.
- Capacity: free machines.
- Transports: SSH with a POSIX shell, and VNC (Screen Sharing). Enrol: yes.
- `power` reports running. `start` and `stop` may use Wake-on-LAN or do nothing.

## Planned: macOS VMs on a Mac mini

- Nature: virtual. Kinds: `macos-desktop`.
- Acquire: clone and start a VM with the Mac's virtualisation tool (for example `tart clone` and `tart run` over SSH to the host), then wait for SSH in the guest.
- Capacity: the host's free memory and disk. Apple's licence allows two macOS VMs per Mac at once.

## Planned: a real Linux or Windows PC

- Nature: real. The same shape as the Mac mini backend.
- Linux resets the box user.
- Windows resets through its agent, or by reimaging, and uses RDP for its display.

## Possible: Crabbox, microsandbox, clouds

Any provider that can hand out a machine and say how to reach it fits. A cloud backend is virtual: acquire creates an instance, release deletes it, and capacity is a quota. It reuses the SSH transport.
