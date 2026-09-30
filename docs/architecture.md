# Architecture

How bb-box fits together: its parts, the backend interface, a box's life, and
how you and the agent use a box. The backend interface itself is in
[backends.md](backends.md); the reasons behind each choice are in
[decisions](decisions/README.md).

## The rule

bb-box's core does not care who the provider is
([001](decisions/001-provider-agnostic-core.md)). A hypervisor, a container
host, a Mac, a pool of physical machines, a cloud or a sandbox runtime is a
backend behind one interface. The core is tested against every backend by one
conformance suite, so the rule is checked, not assumed.

## Parts

```
BB app (panel, desktop viewer)          BB server
          |                                 |
          v                                 v
+-------------------- bb-box plugin, on the BB server ---------------------+
| Core: registry, lifecycle, sweep, agent tools, panel, settings, doctor,  |
|       desktop relay, shared control, BB enrolment, in-box scripts per OS |
|------------------------------+-------------------------------------------|
| Transports                   | Backends                                  |
|  command: SSH (docker exec,  |  proxmox-lxc (built), proxmox-qemu,       |
|    WinRM, in-box agent later)|  docker, ssh-pool, mac (physical),        |
|  stream: RFB (Selkies, RDP   |  tart, clouds, ...                        |
|    later)                    |                                           |
+------------------------------+-------------------------------------------+
          |                                 |
          v                                 v
     inside each box                  each provider's API
```

| Part | Folder | Owns | Never |
| --- | --- | --- | --- |
| Core | `src/core/` | box records, lifecycle, sweep, tools, panel, relay, enrolment, computer use, in-box scripts | names a provider, hypervisor, container technology or transport |
| Transports | `src/transports/` | running commands, copying files, opening a byte channel to a port in a box | knows which provider made the box |
| Backends | `src/backends/<type>/` | acquire and release, address, capacity, ownership records, which transports reach each box, `doctor` | runs anything in a box for the core |

- bb-box is a BB plugin with no service of its own
  ([002](decisions/002-bb-is-the-coordinator.md)). The plugin calls each
  provider's API from the BB server.
- Everything that runs inside a box goes through the command transport and is
  written once per guest OS: POSIX sh for Linux and macOS, PowerShell for
  Windows. That covers enrolment, the thread's environment, `run`, file
  copies, computer use and the reset of a real machine's box user.
- Several backends can be active at once. Kind IDs are unique across them.

## The backend interface

A backend declares its nature (virtual or real) and its kinds, and implements
the methods below. The full types are in
[src/backends/types.ts](../src/backends/types.ts) and
[src/transports/types.ts](../src/transports/types.ts).

| Method | Does |
| --- | --- |
| `kinds()` | the kinds it offers, with capabilities |
| `capacity(kind, pending)` | whether one more box fits, and a message for the user when not |
| `acquire(box, previous, hooks, signal)` | makes or claims a guest, starts it, returns when its command transport answers |
| `release(guest)` | deletes a virtual guest, or resets a real machine and returns it to the pool |
| `power`, `start`, `stop` | power state, and stop and start where the provider supports them |
| `held()` | every guest it holds for boxes, with the owner recorded at the provider |
| `transports(guest, kind)` | the command transport and the desktop stream for a box |
| `doctor()` | checks the setup end to end and says what is missing |
| `maintain()` | upkeep, such as topping up a warm pool |

Every method must be safe to repeat: the registry retries after a restart and
the sweep repeats releases.

### Kind capabilities

| Capability | Values | The core uses it to |
| --- | --- | --- |
| `os` | `linux`, `windows`, `macos` | pick the in-box scripts |
| `desktop` | yes or no | offer the viewer and computer use |
| `gpu` | yes or no | show GPU status and count GPU capacity |
| `docker` | yes or no | tell the agent Docker is there |
| `command` | a transport name, or none | offer `run` and file copies |
| `stream` | `{ type, resizable }`, or none | load the viewer client and allow resizing |
| `enrol` | yes or no | enrol the box as a BB machine |

A kind with no command transport can still be viewed and released. A kind that
cannot enrol still runs commands through the transport.

### Changes proposed to the interface

Reviewing the interface against Docker, an SSH host pool, Tart and Windows
found these gaps. Each keeps provider details inside backends and transports.

| Gap | Who needs it | Change |
| --- | --- | --- |
| A desktop endpoint is a host and port, which assumes the BB server can reach the box directly | Docker on another host, SSH pool machines with VNC on localhost, Tart VMs behind the Mac host's NAT, a QEMU console from the Proxmox API | Replace `DisplayEndpoint {host, port}` with a stream endpoint that opens a byte channel (below). A backend composes it from a direct TCP connection, an SSH tunnel, `docker exec`, or a provider's console API |
| Boxes behind another host | Tart, SSH pool machines behind a bastion, remote Docker hosts | `SshTransport` takes an optional jump host |
| `DisplayProtocol` is `vnc`, `rdp` or `webrtc` | the viewer | Rename to the stream type: `rfb`, `selkies`, `rdp`. Drop `webrtc`, which a plugin route cannot carry ([007](decisions/007-desktop-stream-is-a-typed-transport.md)). Add `resizable` |
| Capacity has memory and disk only | Tart (two macOS VMs per Mac), Docker (a container limit), GPU desktops | Optional `slots: {used, total}` and `gpu: [{id, desktops, maxDesktops, freeMiB}]` on `VirtualCapacity` |
| `start` and `stop` are required | SSH pool and physical machines, which cannot be stopped and started remotely | Make them optional, and let the panel and tools offer them only when present |
| `PowerState` is running or stopped | real machines that do not answer | Add `unknown` |
| `stream()` output is a string | binary output, and splitting stdout from stderr | `onOutput(chunk: Uint8Array, from: "stdout" \| "stderr")` |
| What a real release restores is not stated | the panel, and people choosing a backend | A real backend states it: `home` (the box user's home is recreated) or `machine` (reimaged or restored from a snapshot) |

The stream endpoint, as a sketch:

```ts
/** A two-way byte stream to a port inside a box, with backpressure. */
interface ByteChannel {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

interface StreamEndpoint {
  readonly type: "rfb" | "selkies" | "rdp";
  readonly resizable: boolean;
  open(signal?: AbortSignal): Promise<ByteChannel>;
}

interface CommandTransport {
  // ... as now, plus:
  /** Opens a byte channel to a TCP port inside the box: SSH direct-tcpip, or socat through docker exec. */
  connect?(port: number, signal?: AbortSignal): Promise<ByteChannel>;
}
```

## A box's life

```
requested -> acquiring -> starting -> ready -> enrolled
                                        |  ^
                                   stop |  | start      (you or the agent)
                                        v  |
                                      stopped

any state -> releasing -> released     (release, or the thread is archived or deleted)
```

1. **Requested.** The registry asks each backend that offers the kind for
   `capacity`, and uses the first one with room. If none has room you see the
   backend's message, which says what is full and what to release. The
   registry records the box and returns at once.
2. **Acquiring.** In the background, the backend claims a guest with
   `hooks.claim` before it makes or changes anything, so a restart can resume
   and the sweep can find it.
3. **Starting.** The guest exists and is booting (`hooks.starting`). Each
   step's time goes to `hooks.timing` and shows in the box's status.
4. **Ready.** The command transport answers.
5. **Enrolled.** If the kind can enrol, bb-box enrols the box as a BB machine
   and the thread's environment reaches it (see Thread access).
6. **Released.** You or the agent release the box, or its thread is archived
   or deleted ([003](decisions/003-boxes-live-until-released.md)). bb-box
   removes the machine from BB, then the backend releases the guest. A missing
   guest counts as released.

| | Virtual | Real |
| --- | --- | --- |
| Acquire | clone and start a guest, or take one from the warm pool | claim a free machine, prepare the box user |
| Ready | the transport answers | the transport answers as the box user |
| Stop and start | yes, where the provider can | usually not |
| Release | delete the guest | end the box user's processes, recreate its home, return the machine |
| If release fails | the sweep retries | the machine is held back from the pool and flagged for the operator |

Stopping and starting a box is something you or the agent choose, to free
memory or GPU while keeping the disk. It never happens on a timer.

## Warm pool

A warm pool keeps ready guests of a kind so that acquire is only a claim. A
real backend's pool of free, reset machines is the same thing
([004](decisions/004-acquire-and-release.md)).

- `ReadyPool` in [src/backends/pool.ts](../src/backends/pool.ts) picks a free
  member that can serve the kind and makes sure only one box holds it.
- Each backend brings a `PoolStore` for membership. Proxmox LXC keeps it in
  guest tags; real backends keep it in the backend's plugin storage.
- The target size is a setting per kind, off by default. `maintain()` tops the
  pool up after each claim and on every sweep, and never below the backend's
  memory and disk reserves.
- A warm guest counts against capacity and always fits when claimed.
- Warm guests are not enrolled, because enrolment ties a machine to a thread's
  environment. Whether a warm guest can be enrolled ahead and handed over is
  the subject of the enrolment research (in progress).

## Thread access

A box is a resource of its thread and gets what the thread's own machine has.

- **Enrolment.** A box whose kind can enrol becomes an ordinary BB machine.
  The plan is to install BB's host app in the template, so enrolment skips
  the download (enrolment research, in progress). The thread's Git
  credentials and machine variables reach the box through BB, and bb-box's
  in-box scripts write them where the box's commands load them.
- **Child threads.** A child thread can run on an enrolled box.
- **Direct access.** The agent can also reach its boxes itself, for example
  with `ssh <box name>` or `DOCKER_HOST`, over the same network the BB server
  uses.
- **No enrolment.** A kind that cannot enrol (Windows until BB runs there)
  still runs commands, copies files and streams its desktop through the
  transports.

## You and the agent

| Surface | You | The agent |
| --- | --- | --- |
| Panel | list the thread's boxes, acquire one by kind, see status, GPU or CPU, and timings, stop, start and release | not used |
| Tools | not used | acquire, list, status, run, copy files in and out, stop, start, release, start a child thread on a box |
| Desktop | the viewer in the panel, over the relayed stream | computer use inside the box: the accessibility tree first, screenshots when appearance matters |
| Control | take and hand back | waits while you hold control |

- **Desktop viewer.** The panel opens one WebSocket per viewer on the plugin's
  `/desktop?box=<id>` route. The relay opens the box's stream endpoint and
  copies bytes both ways without decoding them. The panel loads the client
  for the stream type: noVNC for `rfb`
  ([007](decisions/007-desktop-stream-is-a-typed-transport.md)).
- **Shared control.** One owner of input at a time, the agent by default,
  held in the plugin's memory. The relay drops input from any viewer that is
  not the owner, so nothing in the box filters input. Taking control refuses
  new computer-use calls, lets running ones finish for up to 5 s, then stops
  the computer-use service; apps it started keep running. Resizing is allowed
  only while you hold control. On hand-back the relay releases any keys and
  buttons still held down. Control returns to the agent when you hand back,
  when your viewer has been gone for 60 s, or when the plugin restarts
  ([008](decisions/008-shared-control.md)).
- **Computer use** runs as a service inside the box, written once per OS. The
  computer use research (in progress) compares the options.

## Clean-up and crash recovery

Nothing expires, so a box must never be forgotten.

- **Ownership is recorded at the provider** where it can be: tags on a Proxmox
  guest, the container name for Docker, the VM name for Tart, a marker file on
  a real machine. `held()` reads it back, so the sweep works even if bb-box's
  storage is lost.
- **The claim comes first.** `hooks.claim` records the guest before anything
  is made, so an interrupted acquire is always found.
- **After a restart** the registry resumes boxes that were acquiring, repeats
  releases that were interrupted, and checks the power of the rest.
- **The sweep** runs at start and every few minutes:
  1. releases the boxes of threads that are archived, deleted or gone;
  2. finishes interrupted releases;
  3. releases guests from `held()` that have no owner (an acquire interrupted
     before the claim was labelled) or whose thread has ended;
  4. adopts guests whose thread is live but whose record was lost;
  5. calls `maintain()`.
- **A guest deleted outside bb-box** makes `power` return nothing; the box is
  marked gone and the panel says so.
- **If the BB server is down**, boxes keep running and nothing is released.
- **If a box reboots**, its services start again, the viewer reconnects and
  control returns to the agent.

## Data ownership

| Data | Lives in | Owned by | Survives |
| --- | --- | --- | --- |
| Box records: ID, thread, kind, backend, guest, state, timings | plugin storage | core | rebuilt by the sweep from provider records if lost |
| Which guest belongs to which box and thread | the provider (tags, names), or a marker on a real machine | backend | the plugin's storage being lost |
| Pool membership | the backend's `PoolStore` | backend | as above for tags; plugin storage otherwise |
| Settings and provider credentials | BB plugin settings | operator | never shown in output, logs or errors |
| bb-box's SSH key | plugin storage; its public key is installed by setup | core | |
| The thread's Git credentials and variables | BB | BB | delivered to the box on enrolment, never stored by bb-box |
| Work in the box: files, containers, running apps | the box's disk | the thread | deleted on release (virtual), or the home recreated (real); not backed up |
| Templates and images | the provider | operator | built by the setup scripts |
| Who holds each desktop's input | plugin memory | core | resets to the agent on restart |

Push work to Git or copy it out before releasing a box.

## Backends

How each backend fits the interface. Proxmox LXC is built; the rest are
planned, and the later-backends research fills in the details.

| | Proxmox LXC | Proxmox QEMU (Windows) | Docker | SSH host pool | macOS (physical Mac) | Apple Virtualization framework (Tart) |
| --- | --- | --- | --- | --- | --- | --- |
| Nature | virtual | virtual | virtual | real | real | virtual |
| Acquire | linked clone, start | linked clone, start | create and start a container from the kind's image | claim a machine | claim a Mac, prepare the box user | `tart clone` (copy on write), `tart run` headless |
| Release | delete | delete | remove the container | reset the box user | reset the box user | `tart delete` |
| Command | SSH | OpenSSH for Windows with PowerShell, or WinRM | `docker exec`, or SSH if the image runs it | SSH | SSH | SSH through the Mac host |
| Stream | RFB | RFB from the Proxmox console API, or RDP | RFB through `docker exec` | RFB through SSH | RFB (Screen Sharing) | RFB through the Mac host |
| Ownership record | tags | tags | container name (labels cannot change after creation) | marker file and plugin storage | marker file and plugin storage | VM name with box and thread IDs |
| Capacity | memory, disk, guest IDs, GPU | memory, disk, GPUs | memory, a container limit, GPU | free machines | free Macs | two VMs per Mac, memory, disk |
| Stop and start | yes | yes | yes | no | no | yes |
| Enrol | yes | not until BB runs on Windows | open question: containers usually run without an init system | yes | yes | yes |

Notes:

- **Docker** reaches its daemon through a local socket or a remote Docker
  host. GPU desktops use NVIDIA's container toolkit. Docker inside a Docker box
  needs Docker-in-Docker or another runtime; the first Docker kinds may leave
  it out.
- **SSH host pool** needs nothing but SSH access to each machine. It is the
  simplest real backend, and the physical Mac backend may turn out to be the
  same driver with macOS machines and a desktop kind.
- **Physical Macs** have one console session. The box user must be logged in
  at the console for the desktop and computer use, so resetting it means
  logging out and in again. Accessibility and Screen Recording permissions
  are granted once per machine at setup.
- **Tart** images are prepared ahead: permissions granted, Xcode and the iOS
  Simulator warmed, background indexing off. They are pulled from an OCI
  registry with `tart pull`. Apple's licence allows two macOS VMs per Mac.
  Several Macs can be listed in settings, or managed by Orchard later. Tart's
  licence terms for this use are being checked.
- **Clouds, microsandbox and Crabbox** fit as virtual backends with SSH and
  instance tags; a cloud's capacity is its quota.

## Conformance suite and setup

([009](decisions/009-conformance-suite-and-doctor.md))

- **Conformance suite** in `test/conformance/`, run against a live backend
  from an env file. For each kind: capacity, acquire to ready with the hooks,
  run a command, copy files, enrol, stream a frame, computer use, stop and
  start where supported, repeated release, and crash recovery (an interrupted
  acquire is resumed or released, and `held()` finds every guest). Steps a
  kind does not support are skipped by its declared capabilities, never by
  backend name.
- **Fake backend.** An in-memory backend passes the suite and backs the core's
  own tests.
- **Setup scripts**, one per backend, prepare the provider: templates or
  images, the network, a restricted credential, and bb-box's public key. Each
  has a short guide.
- **Settings page.** Each backend has its own section with an enable switch.
  After you save, the page runs `doctor()` and shows each check with what to
  do when it fails.
- **`doctor`** also runs from the panel and from the command line, and prints
  notes such as the public key to install. It never prints a credential.

## Open questions

| Question | Where it is answered |
| --- | --- |
| How fast enrolment can be, and whether warm guests can be enrolled ahead | enrolment and warm pools research |
| Accessibility tree and input on each OS, and which computer-use tool to build on | computer use research |
| Details and licences of the Windows, Mac, Tart, Docker and SSH pool backends | later-backends research |
| Enrolment in a container without an init system | enrolment research, then the Docker backend |
| Whether BB's plugin WebSocket gives `bufferedAmount` and echoes subprotocols | a BB feature request |
| Switching the Linux desktop to Selkies' patched Xvfb | the experiment in [the GPU in a desktop box](research/gpu-desktop.md), once the host allows it |
