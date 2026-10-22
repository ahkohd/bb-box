# Cloud hosts: a plan for steps 1 and 2 of 055

A plan for the first two steps of
[055](../decisions/055-cloud-boxes-run-on-cloud-hosts-first-and-a-cloud-vm-per-box-later.md):
a cloud server made by hand as a Docker host through BB (#541), and a
backend that makes its own hosts on Hetzner Cloud (#542).

Research, 22 October 2026, read against BB 0.46.0 and bb-box's main branch
that day. It ends with [Namespace, compared](#namespace-compared), a second
provider the owner's team already uses, and a recommendation of which to
build first. No cloud account was used and nothing was spent. Hetzner's prices
and API were read from its price pages and its OpenAPI description that
day. Nothing here is built.

## What the owner must decide or provide

Nothing below starts until the owner gives these.

| | What | Why | Suggested |
| --- | --- | --- | --- |
| 1 | A Hetzner Cloud project for bb-box's tests alone, and an API token for it with Read & Write | A token reaches one project and every resource in it, and Hetzner has no narrower scope that can create a server, so the project is the boundary | A project named for the tests, with nothing else in it |
| 2 | Where the token goes | bb-box keeps it as a secret field in its settings: write-only, stored apart from the configuration, never in a log, an error or the doctor's output | Pasted into BB Box's settings by the owner; no agent reads it |
| 3 | A location | Latency to BB's server, which the desktop stream crosses twice | Nuremberg (`nbg1`) or Falkenstein (`fsn1`) for a server in western Europe; Helsinki (`hel1`) otherwise |
| 4 | A host type | A host builds or holds about 36 GB of images, keeps 4 GiB of memory free by default, and a small desktop box takes 8 GiB | A CX43 (8 vCPU, 16 GB, 160 GB) where Hetzner has one; on 22 October none was available in Germany or Finland, and a CPX42 (8 vCPU, 16 GB, 320 GB) is the cheapest that holds a desktop box. For real use, a CX53 or a CPX52 |
| 5 | Whether hosts join the tailnet | BB's server is reachable only on the tailnet, so a host, and its boxes, can reach BB only if the host joins it, or BB's own "bb Connect" access is paired | Join: a Tailscale auth key, or better an OAuth client that can make one-off keys (below) |
| 6 | A test budget, and a Hetzner cost alert at it | Hetzner has no spending cap | EUR 20, with the alert at EUR 10 |
| 7 | Limits for real use | bb-box's own guard against runaway hosts | At most 2 hosts at once, and a host deleted after 30 minutes with no box |

## What changed since 7 October

055 was written on 7 October. Read against today's code and BB 0.46.0:

- **BB's server is on the tailnet only.** BB 0.46.0 lets machines reach its
  server by a direct URL or through bb Connect. This install uses a direct
  URL whose name resolves, in public DNS too, to a tailnet address. A cloud
  server can enrol, and its boxes can, only once it is on the tailnet. 055
  treated this as one case among others; for this install it is the case.
- **Tailscale for boxes (050) is designed, not built.** No code joins a box
  or a host to the tailnet. Step 1 joins the host by hand; step 2 must join
  its hosts itself.
- **microsandbox (053) is built**, with a relay of its own for BB machines.
  AWS hosts with nested virtualization can run it in a later PR.
- **Images (049)** are built on each Docker host through the relay: about
  15 minutes and 36 GB of free disk for the three images. A CX33's 80 GB
  disk is too tight for all three; 160 GB, as a CX43 or a CPX32 has, is
  enough.
- **Spawns are cheap now.** bb-box starts its commands, the `docker` CLI's
  included, from a helper process, so BB's server no longer forks for each
  (#938). A Docker host over `ssh://` still starts one `ssh` per `docker`
  command, which matters for step 2 (below).
- **Resize (061)** works on Docker boxes live, with `docker update`, so it
  works on cloud hosts too.
- **Prices.** Hetzner now shows its prices with a public IPv4 included. They
  match 055's once its EUR 0.50 a month for IPv4 is added, so they have not
  risen since.
- **Stock.** Hetzner's create page now has three lines: Cost-Optimized (CX,
  marked "limited availability"), Regular Performance (CPX) and General
  Purpose (CCX). When step 1 was done by hand on 22 October, no CX server
  was available in Nuremberg, Falkenstein or Helsinki, so bb-box cannot
  count on CX types. Regular Performance, with IPv4, excluding VAT:

  | Type | vCPU | Memory | Disk | An hour | A month |
  | --- | --- | --- | --- | --- | --- |
  | CPX32 | 4 | 8 GB | 160 GB | EUR 0.0577 | EUR 35.99 |
  | CPX42 | 8 | 16 GB | 320 GB | EUR 0.1122 | EUR 69.99 |
  | CPX52 | 12 | 24 GB | 480 GB | EUR 0.1618 | EUR 100.99 |
  | CPX62 | 16 | 32 GB | 640 GB | EUR 0.2091 | EUR 130.49 |

  A CPX costs about twice a CX of the same size, and a host of 16 vCPU and
  32 GB about four times (CPX62 against CX53).

## Step 1: a cloud server made by hand (#541)

A server that runs Docker and is a BB machine is a Docker host through
bb-box's relay today (042). Nothing in bb-box assumes the machine is on the
same network as BB's server: the relay is a WebSocket the machine's worker
opens out to BB. The settings list offers any connected, persistent BB
machine that bb-box did not make, so a machine enrolled by hand qualifies.

**No code is needed**, only a guide page and one check on a real server.

### What the owner does

As the owner did it on 22 October 2026, and as the guide page
([a cloud server as a Docker host](../guide/cloud-docker-host.md)) gives it:

1. Makes a server in the Hetzner Console: Ubuntu 26.04, the chosen
   location, their own SSH key, and a Cloud Firewall with no inbound rules
   once setup is done, so nothing is open to the internet. With no CX
   server available, a CPX32 was the cheapest with room for the images.
2. Installs Docker from `get.docker.com` (29.9.2 that day), Tailscale from
   its install script, and Node.js 22 or later, which BB's installer needs:
   Ubuntu 26.04's own package was 22.22.1.
3. Joins the tailnet: `tailscale up`, approved with the login link it
   prints, or with an auth key tagged for bb-box hosts.
4. Makes the user BB's daemon runs as, not root: `useradd -m bb`,
   `loginctl enable-linger bb`, and `usermod -aG docker bb`.
5. In BB, Settings, then Machines, then Add a machine, with Manual setup:
   copies the command, which BB shows once and which expires in 15 minutes,
   and runs it as that user. `bb machine create --provider manual` does
   not show the command, and a manual machine opened afterwards in BB says
   "Machine is no longer paired".
6. In BB Box's settings, turns the machine on under Docker on BB machines,
   which adds a Docker backend with the host `bb:<machine ID>`, privileged.
   bb-box builds the images there, about 15 minutes, then offers Docker
   boxes on it.

About 45 minutes, most of it the image build. On the day, bb-box's Docker
check answered in 0.1 s through the relay.

**Without Node.js**, BB's installer failed with "sh: node: not found" and
printed only its usage, which does not say what is missing
([request 35](../bb-requests.md#35-say-what-a-machine-needs-before-installing)).

**Memory.** bb-box keeps 4 GiB of a Docker host's memory free by default. A
CPX32's 8 GB shows as about 7.6 GiB, so it holds no box until the backend's
`reserve-memory-mib` is lowered: at 1024, one small `linux` box of 4 GiB. A
small desktop box takes 8 GiB and needs a host of 16 GB, such as a CPX42.

### What bb-box does

What it does for any Docker host on a BB machine: lists it, opens the relay
when a `docker` command needs it, builds the images, places boxes, reaches
their desktops and terminals with `docker exec`, and checks it in the
doctor. Nothing new.

### How the host and its boxes reach BB's server

- **The host**: over the tailnet, as every other machine here does. Its
  daemon keeps an outbound connection to BB's server, and the relay's
  WebSocket goes the same way. No inbound port.
- **Its boxes**: a box enrols by reaching BB's server. A container's traffic
  leaves through the host, and Docker masquerades it as the host's, so a
  box reaches tailnet addresses through the host's Tailscale interface. The
  name of BB's server resolves to its tailnet address in public DNS too, so
  a box needs no tailnet DNS. To be confirmed in the check.
- **Without the tailnet**: the owner would pair bb Connect, or give BB's
  server a public URL. Either is the owner's choice and outside bb-box.

### The check, on a real server

On the CPX32 for `linux` boxes, and a CPX42 for desktop boxes, about 3
hours each:

1. The steps above, timed.
2. The doctor passes for the new Docker host.
3. A `linux` box and a `linux-desktop` box start, enrol in BB, run
   `box_run`, copy files both ways, and show their desktops over video and
   VNC. Their start time, and the desktop's frame rate and input delay from
   a browser near BB's server, are measured.
4. A box that is privileged runs `docker run hello-world`.
5. A live resize, and a release.
6. The host is deleted at the end, and the doctor is run again.

### The guide page

`docs/guide/cloud-docker-host.md`: what a cloud Docker host is for, what it
costs (from EUR 0.0577 an hour for a CPX32, with its IPv4), the steps above, the
firewall, how it reaches BB, what to do when the tailnet is not used, and
how to remove it. The setup README's Docker section links to it.

## Step 2: a backend that makes its hosts, Hetzner Cloud first (#542)

### Shape

A new backend, `hetzner`, that owns hosts as well as boxes:

- **Kinds**: those the Docker backend offers, from the images on its hosts.
- **Hosts**: servers bb-box makes from its host image, each carrying Docker
  boxes. A box is a container on one host, and `Guest.host` names it, as
  Proxmox nodes and the SSH pool's Macs are named today.
- **The Docker part is shared, not copied.** The Docker backend's work on
  one host (containers, labels, `docker exec`, copies, the desktop, resize,
  the doctor) moves into a part both backends use. The Hetzner backend has
  one such part for each host.

**Making a host.** On an acquire, bb-box places the box on the host with the
most room that fits it. When none fits:

- with fewer hosts than the limit, it makes one and the acquire waits for it,
  about a minute and a half: the server's start, the tailnet join, and Docker
  starting with the images already in the host image;
- at the limit, the offer says the backend is full, and the acquire takes the
  next backend, as any full backend does today.

A host that is more than three quarters full makes the next host ahead, so a
steady stream of acquires rarely waits.

**Deleting a host.** A host with no box for the idle time is deleted, so a
burst of short boxes reuses the same host. A host being deleted takes no new
box.

**Sizing.** One host type for the backend, set in its settings. A box counts
at its size against the host's cores and memory, keeping 4 GiB free, as the
Docker backend counts today.

### How bb-box reaches a host it made

Two ways were weighed:

| | SSH over the tailnet | The host as a BB machine (042) |
| --- | --- | --- |
| How | bb-box holds one SSH connection to the host's tailnet address, and forwards Docker's socket over it to a socket on BB's server; the `docker` CLI uses that socket | BB's daemon on the host, and bb-box's relay, as for a host made by hand |
| Start of a new host | the tailnet join, a few seconds | BB's installer, about a minute on today's boxes, then the relay |
| Seen by people | not a BB machine: nothing to pick | a BB machine in BB's lists and picker, where a thread could be started on it as root; BB cannot hide it (a possible later request) |
| Depends on | the tailnet, and an SSH key bb-box makes | BB's experimental host entry and WebSocket APIs |
| Without the tailnet | does not work | works with bb Connect or a public URL |

**SSH over the tailnet, then.** One forwarded socket a host, so `docker`
commands start no `ssh` each, as a `ssh://` host would. If the owner chooses
not to use the tailnet, the BB machine way is the fallback, and it needs BB
to keep such machines out of thread placement first.

### The host image

A Hetzner snapshot that bb-box builds and refreshes:

- Ubuntu 26.04, Docker Engine, Tailscale (installed, not joined), Node.js
  22 or later, for BB's installer where a host is a BB machine (the
  fallback above), and bb-box's three OCI images loaded, so a new host has
  nothing to build.
- A rule that stops containers reaching Hetzner's metadata service
  (169.254.169.254), installed before Docker starts. A privileged box is
  root on the host and could read the server's user data otherwise, and
  the user data is where a host gets its tailnet key.
- The build: bb-box makes a server of the backend's host type from Ubuntu's image, runs
  `setup/docker/build.sh` and the host script over SSH, takes a snapshot
  with labels for the install and the build, and deletes the server. About
  30 minutes and about EUR 0.06 on a CPX42. The nightly rebuilds (049) refresh it when its
  images are stale, keeping the last two snapshots.
- A snapshot of about 20 to 30 GB, compressed, costs about EUR 0.30 to 0.45
  a month.

### Joining the tailnet

A host joins at its first boot, from its user data:

- **Best**: a one-off, pre-approved, ephemeral auth key tagged for bb-box
  hosts, which bb-box makes for each host through Tailscale's API with an
  OAuth client the owner gives it. A key read later is already used.
- **Simpler**: one reusable, ephemeral, pre-approved, tagged key in BB Box's
  settings. Then the metadata rule above is what keeps boxes from reading
  it.

Ephemeral nodes leave the tailnet soon after their server is deleted.

### Records, and a sweep that leaks nothing

As every backend (018, 019), and as 055 sets out:

- **The claim first.** bb-box records the host in its storage before it asks
  for the server: `creating`, with the host's ID and the time.
- **An idempotent create.** The server's name is
  `bb-box-<install>-<host ID>`, unique in the project, so a retried create
  meets `uniqueness_error` (HTTP 409) and finds the server the first made.
- **The owner on the server.** Labels from the create:
  `bbbox-install=<install ID>`, `bbbox-host=<host ID>`,
  `bbbox-role=host` and `bbbox-image=<build>`. The SSH key, firewall and
  snapshots carry the install's label too.
- **The sweep** lists servers with the label selector
  `bbbox-install=<install ID>`, and:
  - deletes a server that no record claims, once it is older than 10
    minutes, so a create in flight is never swept;
  - drops a record whose server is gone;
  - deletes a host past its idle time;
  - finishes a delete that a restart cut short.
- **The doctor** lists the hosts, each with its age, boxes and cost so far,
  and warns of any server labelled for the install that no record claims.
- **The test project** ends each run empty: bb-box's sweep, then a script
  that deletes every server, snapshot, key and firewall labelled for the
  test install.

### Limits

- **Most hosts at once**, 2 by default. A create past it is refused.
- **Idle time**, 30 minutes by default. Hetzner bills by the hour, capped at
  a monthly price, so a shorter idle time saves little and makes acquires
  wait more often.
- **A monthly spending limit**, from Hetzner's `/pricing`: bb-box adds up
  what its hosts have cost this month and what one more would cost to the
  month's end, and refuses a new host past the limit, saying why. The doctor
  shows the month's spend against it.
- **Hetzner's own**: the project's resource limit, which Hetzner sets and
  raises on request, refuses servers past it (`resource_limit_exceeded`),
  and a cost alert in the Console warns by email.
- **API rate**: 3,600 requests an hour for each project, refilling one a
  second. bb-box reads the `RateLimit-Remaining` header, waits on `429`,
  and polls actions no more than once a second.

### Tests against a fake Hetzner API

Every call goes through one `fetch`, so the tests pass a fake, as the Proxmox
client's do. The fake keeps servers, actions, SSH keys, firewalls and
snapshots in memory, and can:

- answer a create with a server that starts after a set time;
- refuse a second create of a name with `uniqueness_error`;
- refuse past a resource limit with `resource_limit_exceeded`;
- answer `429` with `RateLimit-*` headers;
- fail or hang a call at a chosen step, or lose a response after acting.

Each host's Docker is the fake Docker CLI the Docker backend's tests use.

What the tests prove:

- the token appears in no error, log line or doctor output;
- a crash at each step of a create or delete leaves no server once the sweep
  has run, and never deletes a server a record claims;
- placement fills hosts before making one, and makes the next ahead;
- idle hosts are deleted, and the newest is kept;
- every limit refuses with its reason;
- the conformance suite passes on the fake.

### Pull requests

Small, each with what it proves:

1. **The guide page for a cloud Docker host (step 1)**, after the check on
   a real CPX32 and CPX42. Proves: a hand-made host works through the relay, boxes
   enrol over the tailnet, and the times and desktop figures.
2. **A Hetzner Cloud client and its fake.** Servers, actions, SSH keys,
   firewalls, images and pricing; errors; rate limits. Proves: the
   requests' shapes, `429` handling, and that the token is never shown.
3. **The Docker backend's work on one host, made a part.** No change in
   behaviour. Proves: every Docker test passes unchanged.
4. **Host records and the sweep**, on the fake. Proves: no leak from a
   crash at any step, and no claimed server deleted.
5. **The Hetzner backend**: placement, making hosts on demand and ahead,
   idle deletion and limits, on the fake, with the conformance suite.
   Proves: the backend's behaviour, with no account.
6. **Reaching hosts**: the tailnet join from user data, the forwarded
   Docker socket over SSH, and the metadata rule, with the doctor's checks.
   First live run in the test project. Proves: a host bb-box made serves a
   box that enrols, end to end.
7. **The host image**: its build, its refresh with the nightly rebuilds,
   and keeping two. Live. Proves: a new host starts with nothing to build,
   and the start time.
8. **Settings and the guide page** for the Hetzner backend.

AWS follows as its own plan, with microsandbox on instances with nested
virtualization (053).

## Namespace, compared

Namespace (namespace.so) rents ephemeral machines by the minute: Linux on
AMD64, Linux on Apple silicon, macOS, and Windows. Read from its pricing
page and documentation on 22 October 2026; no account was used.

### What it offers

- **Instances.** A machine of a chosen shape, made by `nsc create` or the
  Compute API, which destroys it at its deadline. Linux instances are
  microVMs that run containers, with `containerd` and optionally `dockerd`;
  `--bare` leaves out Kubernetes. They can be suspended, with memory and
  disks kept, and woken.
- **Platforms.** Linux on AMD64 (the default); Linux on Apple silicon, in
  early access and at 7 times the AMD64 price; macOS on M4 Pro or M5 Max,
  Sonoma to version 27, chosen by selectors such as `macos.version`; and
  Windows, generally available on the Team plan and above.
- **Deadlines.** Set at creation, and moved with `extendInstance`
  (`extendBy`, `ensureMinimum` or a new deadline). The workspace's plan caps
  an instance's life: 3 hours on Developer, 5 on Team, up to 24 on Business
  and Enterprise. An instance cannot outlive its plan's cap.
- **Devboxes**, the persistent product, with idle stop and per-user
  limits, are billed in their own minutes: a small one costs $0.004 a
  minute, $0.24 an hour, twice a Linux instance of 2 vCPU.
- **Access.** SSH through Namespace's gateway, `ssh <instance>@ssh.<region>.namespace.so`,
  with a key given at creation, or through `nsc proxy`; the API's
  `GetSSHConfig` hands out a short-lived key for one instance. VNC for
  macOS (`nsc vnc`, `nsc proxy --service vnc`, which returns an address and
  a password), RDP for Windows (`nsc rdp`). No remote display for Linux.
  Commands can run through the API too (`runCommand`, streaming), in the
  guest or a named container.
- **Records.** Labels at creation, and a label filter when listing. A
  `unique_tag` gives an instance a stable handle.
- **Tailnet.** A built-in Tailscale integration: Namespace registers each
  instance with a short-lived OpenID Connect token that a Tailscale trust
  credential accepts, with the tags the owner allows. No Tailscale key is
  stored anywhere.
- **API and auth.** Protocol Buffers on buf.build, served over gRPC and the
  Connect protocol at `{region}.compute.namespaceapis.com`, with a
  TypeScript SDK. Every call carries a bearer token: from `nsc login` (a
  person's, in their keychain), from workload federation, or a revokable
  token from `nsc token create`, scoped by grants and with an expiry.
- **Limits.** Concurrency by plan: on Developer, 32 vCPU of Linux and 12 of
  macOS at once.

### Prices against Hetzner's

Namespace's prepaid prices, excluding tax; overage costs half as much again.
Hetzner's with IPv4, excluding VAT.

| A box of | Namespace | Hetzner |
| --- | --- | --- |
| Linux, 2 vCPU, 4 GB | $0.002 a minute: $0.12 an hour | CX23 EUR 0.0096 an hour, or about EUR 0.007 as a share of a CX53, when CX servers are in stock; about EUR 0.03 as a share of a CPX62, or a CPX22 of its own at EUR 0.032 |
| Linux, 4 vCPU, 8 GB | $0.004 a minute: $0.24 an hour | CX33 EUR 0.0144 an hour; CPX32 EUR 0.0577 |
| Windows, 2 vCPU, 4 GB | $0.004 a minute: $0.24 an hour | no Windows images on Hetzner Cloud; bb-box's own Windows needs a host with KVM |
| macOS, 4 vCPU, 7 GB | $0.04 a minute: $2.40 an hour | none |
| macOS, 6 vCPU, 14 GB | $0.06 a minute: $3.60 an hour | none |

For Linux, Namespace costs 12 to 17 times as much for each hour a box
runs at CX prices, and about 4 times at CPX prices, and nothing while none does; a Hetzner host costs its hourly price
while it waits for its idle time. Namespace is cheaper only for boxes that
are few and short. For macOS it has no rival in this comparison: Macs by
the minute, with no 24-hour minimum such as AWS's Mac hosts have.

### How a Namespace backend would fit

**Model A, a machine per box**, which 055 put last for Hetzner, fits
Namespace better: its machines are billed by the minute, and the deadline is
a backstop against leaks that Hetzner lacks. How fast an instance starts is
for the trial to measure.

- **Acquire**: record the claim; create an instance of the kind's shape with
  labels for the install and the box, the install's SSH key, and a deadline
  of an hour; wait for it; prepare it as the kind needs (below). The CLI's
  `--unique_tag` could make a retried create find the first instance, as a
  unique name does on Hetzner; whether the API refuses a second instance
  with the same tag is for the trial.
- **Keep it alive**: while the box is held, bb-box moves the deadline on
  with `ensureMinimum`, an hour ahead, every quarter of an hour. At the
  plan's cap it cannot: the box's thread is told an hour ahead that the box
  will end, and the box ends at the cap. Boxes on the Developer plan last
  3 hours at most, which suits an agent's task but not a box kept for days.
- **Release**: destroy the instance.
- **Sweep**: list by the install's label; destroy what no record claims,
  past a short grace; drop records whose instance is gone. Whatever a crash
  leaves, the deadline ends within the hour.
- **Stop and start**: suspend and wake, where a kind allows it.
- **Transport**: SSH through Namespace's gateway, with bb-box's own key, as
  bb-box's SSH transport works today. The API's `runCommand` is an
  alternative that needs no SSH, at the cost of a second command path.

**Model B, hosts**, as for Hetzner, fits less well: a host dies at the
plan's cap, taking its boxes with it.

### How its machines reach BB

As for Hetzner: BB's server is reachable only on the tailnet, so instances
join it, or the owner pairs bb Connect. Namespace's Tailscale integration
does the join with no stored key, which is simpler and safer than Hetzner's
user data. The owner makes a Tailscale trust credential for Namespace's
issuer and the workspace, with the `auth_keys` scope and a tag for bb-box
machines.

### Desktops there

- **Linux**: no remote display of Namespace's, so bb-box's own. Its Docker
  desktop image would run as a privileged container in a Linux instance,
  reached by `docker exec` as on any Docker host, with the CPU desktop
  kinds only, as instances have no GPU. Whether Namespace's `dockerd` runs
  a privileged container with its own Docker inside is for the trial. The
  images would be built once into Namespace's container registry and pulled,
  not built on each instance, which takes about 15 minutes and 18 GB of
  disk for a desktop image.
- **macOS**: two ways. Namespace's VNC, through `nsc proxy --service vnc`
  or the API's VNC endpoint, which bb-box's RFB relay can carry as it
  carries a Mac's Screen Sharing today. Or bb-box's own video helper,
  `bb-box-stream`, built with the instance's Xcode, which needs the Screen
  Recording permission granted; whether Namespace's images allow that is
  for the trial. A Namespace Mac has one user, so the SSH pool's new user
  at the console for each box (047) is not needed.
- **Windows**: RDP only, and bb-box carries no RDP. bb-box's Windows video
  helper would have to be installed in each instance. Later, if at all.

### Auth

- **`nsc login`** is a person's login, in their keychain, through a
  browser: it suits a person at their machine, not a plugin on BB's server.
- **A revokable token** from `nsc token create`, granted only what bb-box
  needs on compute instances, kept as a secret field in BB Box's settings,
  and never printed. Its expiry needs a renewal before it lapses; the
  doctor warns a week ahead.
- **Federation** suits workloads that hold an OpenID Connect identity,
  which BB's server does not.

bb-box would call the Compute API with the Connect protocol's JSON over
HTTPS, through one `fetch`, so the tests can pass a fake, as for Hetzner,
rather than adding Namespace's SDK.

### A trial

On the Developer plan, which charges only what is used, or its 30-day free
trial; the owner logs in, and a revokable token is made for the trial:

1. A Linux instance of 4 vCPU and 8 GB, `--bare`, for 2 hours: join the
   tailnet through the integration; pull bb-box's Linux and desktop images
   from Namespace's registry; run a privileged desktop box; enrol it in BB;
   show its desktop over video; time each step. About $0.50.
2. A macOS instance of 6 vCPU and 14 GB, for 90 minutes: SSH through the
   gateway; join the tailnet; install BB's daemon and enrol; reach its VNC
   through bb-box's relay; build `bb-box-stream` and see whether Screen
   Recording can be granted; time each step. About $5.40.
3. Deadlines: extend an instance, and let one reach its deadline, to see
   both.
4. Building the images into the registry, about 15 minutes on 8 vCPU and
   32 GB: about $0.25.

**About $6 in all**, nothing if the free trial covers it. Windows needs the
Team plan, at $100 a month, so it is left out.

### The trial, 22 October 2026

Run in the owner's Personal workspace, on Namespace's trial plan, so it cost
nothing; at list prices the two instances, kept for the owner to check, come
to about $16. Driven from a Linux box of bb-box's own with `nsc` 0.0.587.

**Auth.** `nsc login --browser=false` printed a login link, which the owner
approved in their browser. Then `nsc token create` made a token named for
the trial, for 7 days, granted only `instance` (create, destroy, get, list,
refresh, wait, ssh, exec, dial_host, suspend, resume) and `tenant/usage`
(get). That token did everything below but one: `nsc proxy --service vnc`
returned an address and the Mac user's VNC password, but the connection
through it closed at once. The dashboard has no button to make a token, only
a list, so a person makes bb-box's with `nsc`.

**Region.** `--region eu` was accepted, but both instances' SSH gateways
were in Namespace's US East sites. Where an instance runs, and whether
Europe can be chosen for it, is for the backend's first PR to find out.

**Linux**, 8 vCPU and 16 GB, `--bare`:

| Step | Time | What it needed |
| --- | --- | --- |
| Create, to ready | 3.1 s | |
| SSH through `ssh.eu.namespace.so` | 1.7 s | the key given at creation |
| What is there | | root, on Wolfi Linux, with no systemd and no `sudo`; Docker 29.3; `/dev/kvm` and `/dev/net/tun`; 94 GB of disk |
| Tailnet | about 3 minutes, mostly the owner's approval | Tailscale's static binaries, `tailscaled`, and `tailscale up` with a login link; then BB's server answered in 0.68 s |
| Enrolment in BB | 7 s | Node.js 22 from Wolfi's packages, a `bb` user, and a `docker` group made by hand, as the socket was root's alone. With no systemd, BB's installer skipped its service, and the daemon ran as a plain process |
| bb-box's desktop image, built in the instance's Docker | 15.5 minutes | 6.8 GB |
| A box: our desktop image, privileged, with bb-box's own options | 2.0 s | Docker inside it answered in 1 s and ran `hello-world`; X and Selkies ran |

**macOS**, 6 vCPU and 14 GB, macOS 26:

| Step | Time | What it needed |
| --- | --- | --- |
| Create, to ready | 20.6 s | |
| What is there | | macOS 26.3.1 on a virtual M5 Max; the user `runner`, an admin with `sudo`, signed in at the console; System Integrity Protection off; Xcode 26.1.1; Node.js 25 from Homebrew |
| SSH | under 3 s | through Namespace's gateway, which runs commands under its own agent, `/opt/namespace/vmguest`, not `sshd` |
| Tailnet | 9 s to install from Homebrew, then the owner's approval | `tailscaled` as root, and `tailscale up` started apart from the SSH session, as the first ended with it |
| Enrolment in BB | 19 s | the command run as `runner`; BB installed its launch agent |
| Its desktop over VNC | | Screen Sharing on port 5900, through an SSH tunnel, as on the owner's Macs; it signs in with `runner`'s password, which `nsc proxy` gives |
| `bb-box-stream`, bb-box's video helper | built in 12 s | see below |

Video from the Mac took four changes, all for bb-box to make:

1. **Screen Recording for Namespace's agent.** With SIP off, bb-box grants
   it as it does on the owner's Macs (058), but to `/opt/namespace/vmguest`,
   which is signed ad hoc, by its path, rather than to `sshd-keygen-wrapper`.
2. **The console session.** ScreenCaptureKit answered only for a process
   started in `runner`'s session with `launchctl asuser`, as bb-box starts
   Mac desktop commands (030).
3. **A display that sleeps.** The Mac's one display, 1280 by 800 points,
   slept when idle and capture then hung: `caffeinate -u` woke it and
   `pmset displaysleep 0` kept it awake.
4. **No hardware encoder.** The VM has none, and `bb-box-stream` asks for
   low-latency rate control, which only the hardware encoder offers: every
   frame failed with -12915. Without it, the software encoder sent 153
   frames, 2.2 MB, in 10 seconds at 2560 by 1600, the first after 0.49 s.

**Deadlines.** `nsc extend` took 0.6 s. A request for 48 hours was cut to 4
hours from the instance's creation, this workspace's cap. An instance made
with a deadline of 2 minutes was gone 2 minutes later.

**A desktop box through BB.** With the Linux instance turned on under Docker
on BB machines, a `linux-desktop-cpu` box (4 cores, 8 GiB) on it was ready in
2.0 s: placing it 0.3 s, its network 0.4 s, making it 0.3 s, starting it
0.3 s. It enrolled in BB 16.8 s after, and its desktop drew in BB's panel.
From the box, BB's server answered HTTPS in 0.38 s and the internet in
0.03 s, and a ping to BB's server took 92 ms on average, as the instance ran
in the United States.

Beside Hetzner's step 1, a CPX32 in Nuremberg, the same day:

| | Namespace, Linux, 8 vCPU, 16 GB | Hetzner, CPX32, 4 vCPU, 8 GB |
| --- | --- | --- |
| A server, from asking to SSH | about 5 s | minutes, by hand in the Console |
| bb-box's images, built on the host | 15.5 minutes, the desktop image alone | 50 minutes (3,003 s) for bb-box's build |
| A box, ready | 2.0 s, a desktop box of 4 cores and 8 GiB | 1.3 s, a Linux box; 1.9 s, a desktop box of 2 cores and 4 GiB |
| Enrolled in BB | 16.8 s | 5.6 s, the Linux box |
| BB's server over HTTPS, from a box | 0.38 s | 0.16 s |
| The host's life | 4 hours at most on this plan | until deleted |

Hetzner's host is nearer BB's server, so its boxes enrol faster; Namespace's
was in the United States. A Namespace instance in Europe, if one can be
had, would close most of that gap.

### Which first

**Hetzner for Linux first, then Namespace for macOS.**

- Linux boxes are most of bb-box's use, and run for hours. On Hetzner they
  cost a twelfth to a seventeenth of Namespace's price at CX prices, and
  about a quarter at CPX prices while CX servers are out of stock; step 1
  needs no code, and step 2's plan is above.
- Namespace's strength is macOS by the minute. The owner's own Macs serve
  macOS boxes today, but only as many as there are Macs; Namespace would
  add Macs on demand, for short tasks, within its deadlines.
- The trial showed a Namespace Mac is a good box: ready in 20 seconds, an
  admin at the console with SIP off, so bb-box can grant it what it needs,
  and Xcode there. It needs four changes for video, above, one of them in
  `bb-box-stream` that helps any Mac without a hardware encoder.
- Linux on Namespace works too, and fast: ready in 3 seconds, with KVM and
  TUN, and our images run there as they do on our hosts. It is worth
  building for short, bursty boxes, or as a microsandbox host, as it has
  KVM; for Linux boxes that run for hours, Hetzner costs less.

**So: a Namespace backend for macOS next, beside Hetzner's step 2**, a
machine per box (model A), within the plan's cap on an instance's life:

1. `bb-box-stream` falls back to the software encoder without low-latency
   rate control where there is no hardware encoder.
2. A Namespace client through the Connect API and one `fetch`, with a fake,
   as for Hetzner; a revokable token in BB Box's settings.
3. The backend: acquire with labels and a deadline, extend while held,
   release by destroy, the sweep by label; enrolment as BB machines, as
   the trial did by hand.
4. Each Mac prepared at acquire: Screen Recording granted to Namespace's
   agent, the display kept awake, the video helper built, the desktop
   reached over an SSH tunnel with `runner`'s password.
5. The tailnet through Namespace's Tailscale integration, which needs the
   owner to make a Tailscale trust credential for the workspace.

Linux on Namespace can follow as the same backend's second kind, if bursty
boxes or microsandbox hosts are wanted.

## What the live tests cost

At Hetzner's prices on 22 October 2026, with IPv4, excluding VAT:

| Test | Servers | Time | Cost |
| --- | --- | --- | --- |
| Step 1's check | a CPX32, then a CPX42 | about 3 hours each | about EUR 0.50 |
| PR 6, a first live run | one CPX42 host, made and deleted a few times | about 3 hours | about EUR 0.35 |
| PR 7, the host image | a CPX42 for each build, three builds; two snapshots kept a month | 2 hours; a month | about EUR 0.25, and about EUR 0.70 for the snapshots |
| Later runs, 20 of them | one or two CPX42 hosts, about an hour each | 20 to 40 hours | about EUR 2.25 to 4.50 |

**Under EUR 7 in all**, if nothing leaks, at CPX prices; under EUR 3 if CX
servers are in stock. A CPX42 left running for a month would cost
EUR 69.99, about EUR 2.30 a day, which is what the EUR 20 budget and its
alert at EUR 10 are for: the alert comes within about four days.

## Open questions

- Whether containers on a cloud host reach BB's server over the host's
  tailnet interface as expected: step 1's check answers it.
- How long a host takes from create to ready, with the host image: PR 7
  measures it.
- When CX servers are in stock again in Germany and Finland. Until then a
  host costs about twice as much.
- How BB shows a host's boxes' latency to people: a desktop crosses the
  network from the host to BB's server, and from there to the browser.
