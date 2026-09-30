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
   `held()` finds every guest even if bb-box's storage is lost.
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
instance, repeated release and interrupted acquires. Steps a kind does not
declare are skipped by its capabilities; any other skip gives its reason.

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
- Ownership lives in Proxmox tags (`bb-box`, `thread.<id>`, `box.<id>`,
  `kind.<kind>`).
