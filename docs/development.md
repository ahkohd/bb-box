# Developing bb-box

How to build and test bb-box, and how to add a backend. How bb-box works is
in [the architecture](architecture.md), and why in the
[decisions](decisions/README.md).

Before you change bb-box, read [AGENTS.md](../AGENTS.md): the layout, the
commands, and the rules every change follows. Coding agents read it first,
and `CLAUDE.md` points to it.

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
  GitHub runs it, and the typecheck, on each pull request. It fails when
  the reference is out of date, a link between Markdown files is broken,
  or the skill does not name an agent tool.
- Run the tests in a BB Box box or on GitHub Actions, not on a machine
  that matters. Some fakes run a box's scripts on the test machine itself,
  and a script can reach that machine's own tools in ways no fake can
  stop, such as by a full path. Each test file's first import,
  `test/check-test-machine.mjs`, checks the machine, and finishes before
  the file's other imports load, however the file is run: by `npm test`,
  `npm run test:app`, `node --test`, `node` alone or vitest. The tests
  refuse to start where the current user can run `sudo` without a
  password, where the tests run as root, where Tailscale is installed, or
  where `sudo -n true` gives no clear answer: it fails other than by
  asking for a password, or has not answered within 10 seconds, when its
  process group gets SIGTERM and, 2 seconds later, SIGKILL. They start
  anyway in a BB Box box, whose `/usr/share/bb-box/image.json` is an image
  record of a contract and kind BB Box knows, that only root can change,
  or in a GitHub Actions run. To run them on such a machine anyway, at the
  risk of changing it, set `BBBOX_TESTS_MAY_BREAK_THIS_MACHINE=1`. A test
  file, in any folder under `test`, starts with `import
  "./check-test-machine.mjs";`, by its own relative path, and a test fails
  while one does not.
- The stubs keep the fakes' own scripts off the machine's tools, as far as
  a PATH can. A fake that runs a box's script on the test machine, such as
  the fake `ssh`, `docker` or microsandbox, puts a folder of stubs first
  on the script's PATH. There, `sudo` runs its command under the stubs,
  the tools that change a machine, such as `tailscale`, `systemctl`,
  `reboot`, `iptables`, `mount` and `pkill`, only record their call, and
  `ip`, `route`, `sysctl` and `scutil` run only in forms known to read.
  `rm`, `chown` and `chmod` accept only their own options, check every
  operand, after `--` too, follow it to its real target and act only
  inside the fake's own folders. A test reads the calls with
  `hostCommandsRecorded` from
  [test/host-stubs.mjs](../test/host-stubs.mjs).
- Each test process also puts a guard folder on the PATH of the children
  it starts, so a test file that runs the machine's own `sudo`,
  `tailscale`, `systemctl` or another of those tools by name fails and
  says which.
- `scripts/smoke.ts` runs one box on a real backend without BB: it
  acquires a box, runs a command, opens a desktop as the relay does, and
  releases the box, printing each step's time. Its settings file is the
  configuration as `bb box config show --json` prints it, with each secret
  as a string or `{"file": ...}`; `scripts/smoke.example.json` reads the
  Proxmox LXC guide's token file and key. `--kind`, `--size`, `--command`
  and `--doctor` choose what it does. Smoke runs are an install of their
  own, `smoke`, so they leave a real install's boxes alone.
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
   - `several`, for a type the configuration may have several backends
     of. For one backend per host, as Docker has, it gives the host a
     backend's fields name, which no two may share
     ([042](decisions/042-a-docker-host-can-be-a-bb-machine.md)). For
     backends that label what they make with their own ID, as Namespace's
     and boat.dev's do, it gives null, so any number may share an account
     ([087](decisions/087-each-namespace-workspace-is-a-backend-that-labels-what-it-makes.md),
     [093](decisions/093-each-boat-dev-account-is-a-backend-that-labels-what-it-makes.md)).
     `src/backends/labelled-owner.ts` holds what such backends share: their
     labels, which backend owns what, and their tailnet names;
   - `longestName`, the most characters a second backend's name may have,
     where the backend puts its name in something with a length limit,
     such as a tailnet name;
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
   size. Where the backend's images are rebuilt (049), give it
   `fromCurrentBuild()`, so the upkeep replaces a spare of a build that a
   refresh has replaced: false for such a guest, null when it cannot tell.
   It may be asked of a stopped guest, so answer without starting it.
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
- for each kind that takes snapshots, as its offer says: a take, the list,
  a restore as a new guest that can be undone, a delete, Keep dates that a
  new instance reads from the provider and that outlive the box's release,
  and a fork whose identity reset passes the same check BB Box makes
  before it hands a fork over;
- a take and a restore run in a second process, which the suite kills part
  way through, as when BB stops: a new instance on that process's storage
  settles the take, releases the restore's part-made guest and starts the
  box as it was. On Docker it kills the restore while its copy of the
  Docker data runs, trying again up to 3 times if the restore finishes
  first, and checks that no copy, volume or note of it is left. Only
  `npm run conformance` makes the second process, so `npm test` skips
  these two and says why;
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

  To check a Docker host over SSH, give its address as the host, and leave
  out the desktop images you have not built. With `--kind linux` the run
  checks Linux boxes alone:

  ```sh
  echo '{ "backends": [{ "id": "docker", "type": "docker", "enabled": true, "fields": { "host": "ssh://box@192.0.2.10", "desktop-image": "", "wayland-desktop-image": "" } }] }' > /tmp/docker-ssh.json
  npm run conformance -- --backend docker --settings /tmp/docker-ssh.json --kind linux
  ```

  A run of Linux boxes takes about 3.5 minutes on a VM with 8 cores, about
  6 minutes over SSH, and under a minute on overlay2. Most of it is the
  interrupted take on the containerd store: Docker settles a take whose
  process stopped only once the pause it planned has run three times
  over, plus a minute, and the suite writes 1 GiB into the box first so
  that the take is still running when it is killed. Run it on the containerd image
  store, Docker's default, and on overlay2
  (`"features": { "containerd-snapshotter": false }` in
  `/etc/docker/daemon.json`, then restart Docker and build the images
  again), as their commits differ.

- **The SSH host pool**, on a rig of Docker containers on one computer
  ([its guide](../setup/ssh-pool/README.md#testing-on-one-computer)):

  ```sh
  sh setup/ssh-pool/test/rig.sh up /tmp/bbbox-rig
  npm run conformance -- --backend ssh-pool --settings /tmp/bbbox-rig/settings.json
  SSH_POOL_RIG=/tmp/bbbox-rig node --test --test-concurrency=1 test/ssh-pool-live.ts
  ```

## The documentation site

[site/](../site) builds a documentation website with
[Starlight](https://starlight.astro.build) from the Markdown in this
repository: the README, the user guide, the setup guides, the reference,
the skill, the architecture, this page and the decision records. It reads
them where they are, so a page added to or changed in `docs/guide`,
`docs/reference` or `setup` reaches the site with no change to `site/`.
Each section of the sidebar follows the order of the links in its index:
`docs/guide/README.md`, `docs/reference/README.md`, and the backend tables
in `setup/README.md` and the README. A page no index links comes last in
its section. A link to another file in the repository, such as a source
file, leads to it on GitHub. The site has its own `package.json`, so the
plugin's install and build do not change.

To run it on your computer, with Node 22.18 or later:

```sh
cd site
npm install
npm run dev
```

Then open `http://localhost:4321`. A page changes as you save its
Markdown.

- `npm run build` writes the site, with its search index, to `site/dist`.
  It also writes, for agents, [llms.txt](https://llmstxt.org/) with a link
  to each page, `llms-full.txt` with every page in one file, and each
  page's Markdown at its address with `.md`, such as `/guide/boxes.md`,
  or `index.html.md`, such as `/guide/boxes/index.html.md`.
- `npm run check-links` checks every link and asset in `site/dist`, in
  its Markdown too, and fails on one that leads nowhere or on a page
  llms.txt does not list.
- `npm run preview` serves the build, which search needs.

GitHub builds the site and checks its links on each pull request.
`test/site.test.ts`, part of `npm test`, checks without a build that every
guide, setup and reference page is on the site, in its sidebar and in
llms.txt, that every link on it and in its Markdown leads to a page or a
file, and that the home page's setup prompt names only commands the CLI
has.

### Publishing the site

The site is not published. It is static files in `site/dist`, so any
static host can serve it. Three settings, read when it builds, say where:

| Variable | Says | Default |
| --- | --- | --- |
| `SITE_URL` | the site's full address, for its sitemap and canonical links | none |
| `SITE_BASE` | the path the site is served under | `/` |
| `SITE_REPOSITORY_REF` | the branch that links to files in the repository use | `main` |

Two hosts suit it:

- **GitHub Pages**, as https://bbbox.dev is published:
  `.github/workflows/docs.yml` runs `npm ci` and `npm run build` in
  `site/` on each push to `main`, with `SITE_URL` set to the site's address
  and `SITE_BASE` to `/`, checks its links, uploads `site/dist` with
  `actions/upload-pages-artifact`, and publishes it with
  `actions/deploy-pages`. In the repository's settings, under Pages, the
  source is GitHub Actions and the custom domain is the site's address. A
  fork that publishes its own copy changes the workflow's repository check
  and these two values.
- **Cloudflare Pages**: connect the repository, with `site` as the root
  directory, `npm run build` as the build command and `dist` as the output
  directory. Set `NODE_VERSION` to 22.18 or later, and `SITE_URL` to the
  site's address.

## Recording the demo

[Recording the demo](demo.md) says how to record the README's demo video and the guide's screenshots again, with the scripts in [scripts/demo](../scripts/demo).
