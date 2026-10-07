# Developing bb-box

How to build and test bb-box, and how to add a backend. How bb-box works is
in [the architecture](architecture.md), and why in the
[decisions](decisions/README.md).

## Build and test

```sh
npm install
npm run typecheck
npm test
npm run build
node scripts/smoke.ts <settings.json>
npm run conformance -- --backend <type> --settings <settings.json>
npm run reference
```

- The tests and scripts need Node 22.18 or later, which runs TypeScript
  directly.
- `npm test` runs against a fake Proxmox API, a fake `ssh`, a fake `tart`
  on a fake Mac and a fake `docker`, so it needs no host.
- `scripts/smoke.ts` runs one box on a real backend without BB, with a
  configuration file in the form `bb box config show --json` prints, with
  its secrets in it. See
  [section 6 of the Proxmox LXC guide](../setup/proxmox-lxc/README.md#6-smoke-test).
- `npm run conformance` runs the [conformance suite](#the-conformance-suite)
  against a real backend.
- `npm run reference` writes `docs/reference` from the code. Run it after
  changing a tool, command, setting, kind or check.
- `scripts/preview/` renders the built panels outside BB, with BB's theme
  and fixtures, for screenshots: serve the repository root and open
  `scripts/preview/index.html#panel-list`, or run
  `node scripts/preview/shoot.mjs` on a machine with Chrome.

## Writing a backend

A backend is where bb-box gets boxes from. The interface it implements is
in [src/backends/types.ts](../src/backends/types.ts) and
[src/transports/types.ts](../src/transports/types.ts), and
[the architecture](architecture.md#the-backend-interface) explains it.

### Where the code goes

| Part | Folder | Holds |
| --- | --- | --- |
| Core | `src/core/` | the registry, lifecycle, sweep, in-box scripts, computer use and images. It never names a provider or transport |
| Transports | `src/transports/` | SSH, PowerShell, routes and `openRoute`, and the ready check. They never know which provider made a box |
| Backends | `src/backends/<type>/` | one driver per provider, plus what several share: `ReadyPool` and `KvPoolStore` in `pool.ts`, the Proxmox client in `proxmox/`, and what bb-box runs in a Windows guest in `windows.ts` |

The core uses only the two `types.ts` files.

### Adding a backend

1. Create `src/backends/<type>/` with a `BackendDriver`:
   - `type`, which is also the ID of the first backend of the type;
   - `label`, `description` and the `kinds` its backends can make;
   - `fields`, and `hostFields` for a backend whose hosts are set up alike:
     BB's setting descriptors, each with a group (`connection`,
     `credentials`, `boxes` or `advanced`), in the order the settings page
     shows them. A secret field is kept apart from the configuration;
   - `parse`, which turns the backend's part of the configuration into a
     typed config, or problems each at its field;
   - `setup`, the path of its guide and of the scripts it runs, in order;
   - `several`, for a type with one backend per host, as Docker has: the
     host a backend's fields name
     ([042](decisions/042-a-docker-host-can-be-a-bb-machine.md));
   - `create`, which builds the `Backend`. Its context gives the backend's
     ID, its storage, its install ID, and its warm counts, kinds and hosts
     as the configuration has them now, so read them when needed. Where
     bb-box runs in BB, `context.machines` also reaches BB machines.
2. Reuse a transport from `src/transports/`, or add one there. A display
   served inside the box is built from the command transport's
   `route(port)`. A kind with computer use needs a transport with `spawn`.
3. Record ownership at the provider (tags, labels, names or a marker file),
   so `held()` finds every guest even when bb-box's storage is lost: the
   install ID, from the first write and on warm and part-made guests too,
   and the box's ID, thread, name, kind and creation time, from which the
   sweep restores a lost record
   ([018](decisions/018-guests-name-their-install-and-box.md),
   [019](decisions/019-lost-records-are-restored-from-guests.md)). List
   only this install's guests in `held()`.
4. Write `doctor()` so that it checks everything the backend needs and says
   how to fix each failure, with a stable ID per check. Add each ID to
   `CHECKS` in `src/core/checks.ts`: a check whose ID is not there does not
   compile, and the reference is made from that list. A backend with a warm
   pool gives `context.warmShortfalls()` the pools it left short at the end
   of each `maintain()` (#356). Give `sizesCheck()` in
   [src/backends/fit.ts](../src/backends/fit.ts) each host's cores and
   memory, so the doctor warns about a host too small for a kind's default
   size.
5. Add the driver to `DRIVERS` in
   [src/backends/index.ts](../src/backends/index.ts).
6. Add `setup/<type>/` with the guide and its scripts. Keep deployment
   values out: use example addresses and names. Images remove BB's daemon
   lock and PID file at boot
   ([017](decisions/017-boxes-clear-bb-daemon-state-at-boot.md)).
7. Test it against a fake of the provider, as `test/proxmox-lxc.test.ts`
   does with `test/fake-proxmox.ts`, and run the conformance suite against
   it.

Nothing else changes: the registry, tools, panel and sweep pick up its
kinds.

### Rules the registry relies on

- Call `hooks.claim(guest)` before making or changing anything.
- If acquiring fails, release what was claimed before throwing.
- Make every method safe to repeat. A missing guest counts as released.
- Where the provider can reuse a reference, keep the box ID as
  `Guest.data.box` from the claim on, and check before acting that the
  guest at the reference still names this install and that box. If it does
  not, `power` returns null, `release` does nothing, and `start` and `stop`
  throw `gone`. Add `stamp()` if your guests can predate install IDs.
- Guests of another install, or with none, still count against capacity.
- A real backend calls `hooks.resetting()` before it touches the machine,
  and puts the machine out of service if the reset fails. Keep the
  machine's generation in `Guest.data`, so a repeated release of an old box
  never resets a machine the next box holds.
- Give a resizable Linux or Windows desktop's display
  `minSize: MIN_DESKTOP`, 800x600.
- Put what a person should know about a box, such as a desktop's display
  mode, in `Guest.facts`. Like `data`, they are never a secret.
- Throw `BackendError` with `no_capacity`, `unsupported` or `gone` when the
  registry should act on it. Any other error is shown as it is, so its
  message must make sense to a person and never hold a credential.
- Offers of one kind must agree on what the agent relies on. The doctor
  warns when they do not (`offerChecks` in `src/backends/index.ts`).

## The conformance suite

[test/conformance/suite.ts](../test/conformance/suite.ts) runs the same
checks against any backend:

- the doctor first, which must pass;
- for each kind: capacity, an acquire that records the guest before it
  changes anything, the transports the kind declares, a spawned channel,
  commands with stdin, exit codes and a timeout, the declared OS and
  architecture, streamed output, 32 MiB copied each way, what enrolment
  needs and enrolment itself with a live BB server, Docker, the iOS
  Simulator, each display and its resize, the display's own input where its
  server ignores a viewer's, desktop commands, computer use (the driver
  lists the windows, and the OS's editor opens and shows text typed into
  it), stop and start (with the box's clock right, and connected to BB
  again within 3 s), recovery by a new instance, and repeated release;
- for each preset: a box of that size, measured as soon as it is ready;
- interrupted acquires that leave nothing behind, a small image build, two
  installs on one backend that leave each other alone, and a reused
  reference that reads as gone.

Steps a kind does not declare are skipped by its capabilities, never by
backend name, and any other skip gives its reason.

[test/fake-backend.ts](../test/fake-backend.ts) is an in-memory backend,
virtual or real, that passes the suite and backs the core's own tests.
[test/conformance.test.ts](../test/conformance.test.ts) runs the suite
against it, against Proxmox LXC with a fake API, against Tart on a fake Mac
and against Docker on a fake Docker host:

```sh
node --test test/conformance.test.ts
```

Against real hosts:

- **Docker**, with the images built:

  ```sh
  echo '{ "backends": [{ "id": "docker", "type": "docker", "enabled": true, "fields": {} }] }' > /tmp/docker.json
  npm run conformance -- --backend docker --settings /tmp/docker.json
  ```

- **The SSH host pool**, on a rig of Docker containers on one computer
  ([its guide](../setup/ssh-pool/README.md#testing-on-one-computer)):

  ```sh
  sh setup/ssh-pool/test/rig.sh up /tmp/bbbox-rig
  npm run conformance -- --backend ssh-pool --settings /tmp/bbbox-rig/settings.json
  SSH_POOL_RIG=/tmp/bbbox-rig node --test --test-concurrency=1 test/ssh-pool-live.ts
  ```
