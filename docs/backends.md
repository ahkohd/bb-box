# Writing a backend

A backend is where bb-box gets boxes from. The interface it implements, and
how each planned backend fits it, is in [the architecture](architecture.md)
under "Interface v1" and "Backends". This guide says where the code goes and
how to prove a backend works.

## Where the code goes

| Part | Folder | Holds |
| --- | --- | --- |
| Core | `src/core/` | the registry, lifecycle, sweep, in-box scripts, tools and panel. It never names a provider or transport |
| Transports | `src/transports/` | SSH, routes and `openRoute`, and the ready check. They never know which provider made a box |
| Backends | `src/backends/<type>/` | one driver per provider, plus what several share: `ReadyPool` and `KvPoolStore` in `pool.ts`, the Proxmox API client in `proxmox/` |

The core uses only [src/backends/types.ts](../src/backends/types.ts) and
[src/transports/types.ts](../src/transports/types.ts).

## Adding a backend

1. Create `src/backends/<type>/` with a `BackendDriver`:
   - `type`, which is also the backend's ID and its settings prefix;
   - `settings`, including an enable switch;
   - `parse`, which turns setting values into a typed config or a list of
     problems;
   - `setup`, the path of its guide and of the scripts it runs, in order.
     The settings page links the guide first, then the scripts;
   - `create`, which builds the `Backend`.
2. Reuse a transport from `src/transports/`, or add one there. A backend
   that serves a display inside the box builds it from the command
   transport's `route(port)`. A kind with computer use needs a command
   transport with `spawn`, which carries the driver's MCP session.
3. Record ownership at the provider (tags, names or a marker file), so
   `held()` finds every guest even if bb-box's storage is lost. Record the
   box's ID, thread, name, kind and creation time, which the sweep restores
   a lost record from
   ([019](decisions/019-lost-records-are-restored-from-guests.md)). Record
   `context.installId` with it from the first write, on warm and part-made
   guests too, and list only this install's guests in `held()`
   ([018](decisions/018-guests-name-their-install-and-box.md)).
4. Write `doctor()` so that it checks everything the backend needs and says
   how to fix each failure. Give each check a stable ID.
5. Add the driver to `DRIVERS` in
   [src/backends/index.ts](../src/backends/index.ts).
6. Add `setup/<type>/` with the guide and its scripts. Keep deployment
   values out: the guide uses example addresses and names. Templates and
   images remove BB's daemon lock and PID file at boot
   ([017](decisions/017-boxes-clear-bb-daemon-state-at-boot.md)).
7. Test it against a fake of the provider's API, as
   `test/proxmox-lxc.test.ts` does with `test/fake-proxmox.ts`, and run the
   conformance suite against it.

Nothing else changes. The registry, tools, panel and sweep pick up its
kinds.

## Rules the registry relies on

- Call `hooks.claim(guest)` before making or changing anything, so a
  restart can resume and the sweep can find the guest.
- If acquiring fails, release what was claimed before throwing.
- Make every method safe to repeat. A missing guest counts as released.
- Where the provider can reuse a reference, keep the box ID as
  `Guest.data.box` from the claim on, and check before acting that the
  guest at the reference still names this install and that box, or no box
  for an ownerless leftover. If it does not, `power` returns null, `release`
  does nothing, and `start` and `stop` throw `gone`. Add `stamp()` if your
  guests can predate install IDs.
- Guests of another install, or with none, still count against capacity.
- A real backend calls `hooks.resetting()` before it touches the machine,
  and puts the machine out of service if the reset fails. Keep the pool
  member's generation in `Guest.data`, so a repeated release of an old box
  never resets a machine that the next box holds.
- Put what a person should know about a box, such as a desktop's display
  mode, in `Guest.facts`. Status and the panel show them in order. Like
  `data`, they are stored with the box and are never a secret.
- Throw `BackendError` with `no_capacity`, `unsupported` or `gone` when the
  registry should act on it. Any other error is shown as it is, so its
  message must make sense to a person and never include a credential.
- Offers of one kind must agree on what the agent relies on. The doctor
  warns when they do not (`offerChecks` in
  [src/backends/index.ts](../src/backends/index.ts)).

## The conformance suite

[test/conformance/suite.ts](../test/conformance/suite.ts) runs the same
checks against any backend: doctor first, then for each kind acquire,
transports, a spawned channel, commands with 1 MiB of stdin, streaming,
32 MiB copied each way, enrolment, Docker, displays, stop and start (with
the box connected to BB again within 3 s of being ready), recovery by a new
instance, repeated release and interrupted acquires. It also checks that
two installs on one backend leave each other's guests alone, and, given a
`reuse` hook that makes the backend hand out a reference again, that the old
box reads as gone and its release leaves the new box alone. The size check
measures a box as soon as it is ready, after filling any warm pool the run's
settings ask for, so the box can come from it; the pool stays for the next
run, and a run with a target of 0 removes it. Steps a kind
does not declare are skipped by its capabilities; any other skip gives its
reason.

[test/fake-backend.ts](../test/fake-backend.ts) is an in-memory backend,
virtual or real, that passes the suite and backs the core's own tests.
[test/conformance.test.ts](../test/conformance.test.ts) runs the suite
against it, and against Proxmox LXC with a fake API.

```sh
node --test test/conformance.test.ts
```

## Proxmox LXC

- Virtual. Code in [src/backends/proxmox-lxc/](../src/backends/proxmox-lxc/),
  with the API client in [src/backends/proxmox/](../src/backends/proxmox/).
- The host side, templates and API token are set up by
  `setup/proxmox-lxc/`, whose guide lists the settings.
- Ownership lives in Proxmox tags (`bb-box`, `install.<id>`, `thread.<id>`,
  `box.<id>`, `kind.<kind>`), and in the description the clone writes, which
  names the install and the box before the tags are set.

## SSH host pool

- Real. Code in [src/backends/ssh-pool/](../src/backends/ssh-pool/). The
  machine side is `setup/ssh-pool/`: `setup.sh`, and the helper
  `machine.sh`, the only thing bb-box runs on a machine as root. Its guide
  lists the settings.
- bb-box logs in as the admin user, whose key is limited with `restrict`
  and whose sudo rule allows only the helper. The helper reads `key=value`
  lines on stdin, prints `key=value` lines, and holds a lock on the machine
  while it acts.
- Ownership lives on the machine, in `/var/lib/bb-box`: the reset
  generation, and an `owner` marker naming the install, box, thread, kind,
  generation and box user, written before the box user is made. A release
  first renames it to `resetting`, so `held()` returns a machine being
  reset with no owner, and the next release finishes it. Plugin storage
  keeps only what the machine cannot say: that it is out of service and
  why, the generation last seen, and the box on a machine that does not
  answer.
- `Guest.data` keeps the machine's generation and the box user. Every
  method checks the marker names this install, box and generation before
  acting, so an old box's release leaves the next box alone.
- Capacity is one `machines` limit: the machines serving the kind, and how
  many are not free at the size. A machine has a size when it has at least
  its cores, 90% of its memory and, for a disk, that much free under
  `/home`. Acquire claims the smallest such machine. Capacity first gives
  each acquire that has not claimed the machine its claim would take, so a
  small box waiting to claim does not stop a large one. `Guest.size` is the
  machine's cores and memory, with `diskGiB` null. There is no warm pool.
- `restores` is `machine` only when every machine has a whole-machine
  reset (`reset=machine`); only those machines serve `linux-docker`.
- `members()` reads each machine now, and shows a machine whose marker
  names a box as held, even when its helper is too old to lend it again.
  `returnToService(ref)` resets an out-of-service machine again; an
  operator can also run the helper's `reset` on the machine, which bb-box
  sees as a clean machine at a later generation. Neither resets a machine
  a box holds.

`test/ssh-pool.test.ts` runs the suite and the pool's own checks against a
fake helper. To run them against real machines, start the Docker rig, then:

```sh
sh setup/ssh-pool/test/rig.sh up /tmp/bbbox-rig
npm run conformance -- --backend ssh-pool --settings /tmp/bbbox-rig/settings.json
SSH_POOL_RIG=/tmp/bbbox-rig node --test --test-concurrency=1 test/ssh-pool-live.ts
```

## Tart

- Virtual. Code in [src/backends/tart/](../src/backends/tart/): the
  settings in `config.ts`, the scripts it runs on a Mac in `host.ts`, and
  the backend in `backend.ts`.
- Each Mac and its image are set up by `setup/tart/`, whose guide lists the
  settings. bb-box reaches a Mac over SSH as a host user, with the Mac's host
  key pinned, and each VM through the Mac as the jump host.
- Ownership lives in an owner file per VM on the Mac,
  `~/.bb-box/tart/owners/<VM>`, which names the install, the box, its
  thread, name, kind and creation time. It is written with noclobber before
  the clone and removed after the VM is deleted. VM names hold the box ID, so
  references are never reused.
- Capacity is per Mac: `guests`, the running macOS VMs Tart lists there, at
  most two; `memory`, less a reserve and every running VM's; and `disk`. A
  box gets its size's cores and memory with `tart set`, and may not have
  more cores than the Mac. It keeps its image's disk, so a disk size is
  refused for now. `Guest.size` comes from the VM's
  config.json, with `diskGiB` null.
- The tests run the real host scripts against a fake `tart` on a fake Mac
  ([test/fake-tart.mjs](../test/fake-tart.mjs),
  [test/fake-mac.ts](../test/fake-mac.ts)).
