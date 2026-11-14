# Mac and Linux boxes on Namespace

Namespace rents Macs and Linux machines by the minute. With a Namespace backend, each box is a machine of its own that BB Box makes in Namespace when a thread asks for one, and destroys when the box is released. You need no Mac or server of your own.

This page sets it up from a new Namespace workspace. It was first done on 22 October 2026.

## What it costs

Namespace bills a machine for every minute it exists, from when BB Box makes it until BB Box destroys it. Nothing is billed while you have no boxes there.

Namespace's prepaid prices on 22 October 2026, excluding tax:

| A box of | A minute | An hour |
| --- | --- | --- |
| Mac, 4 vCPU, 7 GB | $0.04 | $2.40 |
| Mac, 6 vCPU, 14 GB | $0.06 | $3.60 |
| Linux, 2 vCPU, 4 GB | $0.002 | $0.12 |
| Linux, 4 vCPU, 8 GB | $0.004 | $0.24 |

Larger machines cost more: see Namespace's pricing page. Minutes beyond what you prepaid cost half as much again.

BB Box gives each box the smallest machine Namespace offers that has at least the cores and memory the box's size asks for, and for a Mac its disk. Namespace's machines come in fixed shapes, so a box can have more than it asked for, and you pay for the machine it gets.

A Linux box's snapshots stay on its machine's disk and cost nothing extra. See [Snapshots on a Linux box](#snapshots-on-a-linux-box).

Linux boxes also need BB Box's Linux images. BB Box builds each in a Linux machine of 8 vCPU and 16 GB, about 4 minutes for the Linux image, 6 to 7 for the desktop's and 9 for the Wayland desktop's, and keeps it in the workspace's container registry. It builds an image when a box first needs it, and again, while boxes use it, when BB Box's image scripts or BB's app change, or after a week.

### What your plan allows

Your Namespace plan sets 2 limits that matter here:

- **How long a machine can live**: 3 hours on Developer, 5 on Team, up to 24 on Business, for Macs and Linux machines alike. A box ends then, whatever it is doing. Its thread hears an hour before, and the Box panel shows when it ends.
- **How many Mac cores you can have at once**: 12 on Developer. Namespace's trial allowed 6, which is one box of 6 vCPU. When you have as many as your plan allows, a thread that asks for another Mac box is told there is no room. Linux machines have a limit of their own, 32 cores on the trial.

BB Box also has its own limit, **Most machines**, which is 2 by default. With more than one workspace, add each as a backend of its own: see [several workspaces](#several-workspaces).

## Before you start

You need:

- a Namespace workspace for BB Box, made at namespace.so. Use one that runs nothing else, so what BB Box makes is easy to see
- a computer with a terminal, to make the token in step 2
- a way for the machines to reach BB's server: if BB is on a Tailscale tailnet, [set BB Box up to join them to it](tailnet.md); otherwise BB's server needs a URL they can reach, such as bb connect's

## Set it up

### 1. Install Namespace's command line, and sign in

```sh
curl -fsSL https://get.namespace.so/cloud/install.sh | sh
nsc login
```

`nsc login` opens Namespace in your browser. Sign in, and choose the workspace for BB Box.

### 2. Make a token for BB Box

BB Box uses a token that can only make, find, extend, reach and destroy machines, and read how many the workspace allows. Make it with:

```sh
nsc token create \
  --name bb-box \
  --description "BB Box's boxes" \
  --expires_in 8760h \
  --grant '{"resource_type":"instance","resource_id":"*","actions":["create","destroy","get","list","refresh","wait","ssh","exec","dial_host","suspend","resume"]}' \
  --grant '{"resource_type":"tenant/usage","resource_id":"*","actions":["get"]}'
```

The second grant lets BB Box read the workspace's limits: how many Mac cores and how much memory it allows at once, and how many are in use. With it, BB Box turns down a Mac box the workspace has no room for before asking Namespace, so another backend can take it. A token made without it still works: `bb box doctor` warns, and BB Box finds a full workspace only when Namespace refuses a Mac.

It prints the token once, after `Bearer Token:`, below its `Token ID` and dates. Copy the value after `Bearer Token:` for step 4, and do not save it anywhere else. Keep the token ID too: you need it to revoke the token. The token lasts a year, the longest Namespace allows. Make a new one before then.

To replace a token, such as one made before the second grant, make the new one with another name, such as `--name bb-box-2`: Namespace refuses a name a token already has. Set the new token in BB Box's settings, then revoke the old one with `nsc token revoke --token_id` and its ID.

### 3. Choose where the Macs run

Namespace puts a workspace's Macs where its regional preference says. You cannot choose a place for each Mac. On 22 October 2026, a new workspace's Macs ran in Namespace's sites in the eastern US.

If BB's server is in Europe and you want the Macs near it, ask Namespace's support to set the workspace's regional preference to Europe. Boxes work from either continent. A box's details say on which continent it runs.

### 4. Add the backend to BB Box

1. In BB Box's settings, select **Add backend**, then **Namespace**.
2. Paste the token from step 2 into **API token**.
3. Set **API region** to `eu` if BB's server is in Europe, or leave it as `us`. It only says which of Namespace's API addresses BB Box calls.
4. Set **Longest life (hours)** to your plan's limit: 3 on Developer, 5 on Team.
5. Set **Most machines** to how many boxes, Mac and Linux together, you are willing to pay for at once.
6. Leave **Largest machine** empty: with the token's second grant, BB Box reads the largest Mac the workspace allows from Namespace. Set it, as cores x memory in GB such as `6x14`, only to keep boxes smaller than that, or for a token without the grant. Without either, BB Box learns it the first time Namespace refuses a Mac for its size.
7. Select **Save**, and turn the backend on.

The token is kept as a secret. BB Box's settings show only that it is set.

### 5. Turn on the kinds

Under **Kinds**, turn on:

- **macOS**, for Mac boxes you use through a terminal
- **macOS desktop**, for Mac boxes whose desktop you can watch and use
- **Linux**, **Linux desktop** and **Linux desktop on Wayland**, for Linux boxes, if you want them from Namespace too

## Check it works

```sh
bb box doctor
```

The doctor checks that Namespace accepts the token, lists the machines BB Box has there, each with when it ends, and says when each Linux image was built. If you turned the tailnet on, it checks the tailnet too.

Then make a box from the Box panel, or ask an agent to.

## Several workspaces

Each Namespace workspace can be a backend of its own, with its own token. A plan's limits are per workspace, so 2 workspaces on the Developer plan allow 24 Mac cores at once rather than 12: 4 Mac boxes of 6 vCPU rather than 2.

To add another workspace, make a token in it as in step 2, signed in to that workspace, then add a second Namespace backend with a name of your own, of at most 15 lower-case letters, digits and hyphens:

```sh
grep '^NSC_TOKEN=' secrets.env | bb box backend add namespace --id team-b --secret token=NSC_TOKEN --secrets-stdin --field longest-life-hours=5
```

Its ID is `namespace:team-b`. **Add backend**, then **Namespace**, in BB Box's settings adds one too, with the ID `namespace:2`.

- **Each has its own settings**: API token, Most machines, Longest life, Largest machine and shared iOS hosts. Set Longest life to that workspace's plan.
- **Each is named by its ID.** `bb box kinds`, the Box panel and `box_list` call the second one Namespace (team-b), and `--on`, or an agent's `on`, takes that name or its ID. Without them, a new box goes to the first backend with room.
- **Each touches only its own machines.** BB Box labels each machine it makes with its backend, `bbbox-backend`, as well as its install, `bbbox-install`. A backend's sweep, upkeep, image builds, doctor and cleanup see only machines with its own label, even when 2 backends use one workspace.
- **Most machines counts the backend's own machines**, and those of other BB Box installs in its workspace, but not another backend's of this install. The workspace's Mac cores in use, which Namespace reports for the whole workspace, count for each backend on it.
- **Each builds its own Linux images**, in its workspace's registry. So the first Linux box of each kind on each backend waits for its build, about 4 to 9 minutes. The first backend's images are tagged `bbbox/linux:<version>`; another's carry its name first, as `bbbox/linux:team-b-<version>`. No backend deletes images from a registry. `bb box images list` lists each backend's images, with when each was built.
- **Each runs its own shared iOS host**, in its own workspace, with its own token. Its record says which backend it is on.
- **With the tailnet on**, a second backend's machines join it as `bb-box-nsb-`, then the install's ID, the length of the backend's name, the name and the box's name, such as `bb-box-nsb-k3v9q2m7xa-6-team-b-my-box`. So no backend takes another's tailnet devices for its own. A backend's name is at most 15 characters, so that there is room for the box's name. A tailnet name is at most 63 characters. Where one would be longer, BB Box keeps the start of the box's name and adds a code of 6 characters made from it, so each box still has a name of its own. On an install whose ID is longer than 23 characters, it may also shorten the install's ID to its first 16 characters and a code. With the ID BB Box makes, of 10 characters, a box's name is never shortened.

The first Namespace backend, with the ID `namespace`, keeps its ID when you add another, and with it its boxes, machines, iOS host and images. It also looks after machines that carry only the install's label, which versions of BB Box before several workspaces made. No other backend touches them.

## What a Mac box is like

A Mac box is a Mac virtual machine on Apple silicon, with macOS 26. You use it as `runner`, who is an administrator and can use `sudo`. Xcode and Homebrew are installed.

A Mac is ready about 20 seconds after BB Box asks for it. BB Box then gets it ready for its kind:

- a **macOS desktop** box builds BB Box's video helper with the Mac's Xcode, lets it and Screen Sharing see and control the screen, and keeps the display awake. You can watch its desktop over Screen Sharing or as video
- with the tailnet on, it joins the tailnet as `bb-box-ns-`, then the install's ID and the box's name

When the box is released, BB Box takes it off the tailnet and destroys the Mac. Nothing on it is kept.

A Mac cannot outlive your plan's limit. BB Box keeps each Mac's end an hour ahead while its box is held, up to that limit, so a Mac that BB Box loses track of ends within the hour.

### Mac sizes

Namespace names each Mac by its cores and memory, such as 6x14 for 6 cores and 14 GiB of memory. You cannot choose a Mac's disk: it follows the shape, at 48 GiB plus 8 GiB for each core or for each 2 GiB of memory, whichever gives more.

| Mac | Cores | Memory | Disk |
| --- | --- | --- | --- |
| 4x7 | 4 | 7 GiB | 80 GiB |
| 4x14 | 4 | 14 GiB | 104 GiB |
| 6x14 | 6 | 14 GiB | 104 GiB |
| 8x14 | 8 | 14 GiB | 112 GiB |
| 6x28 | 6 | 28 GiB | 160 GiB |
| 8x28 | 8 | 28 GiB | 160 GiB |
| 12x28 | 12 | 28 GiB | 160 GiB |
| 16x28 | 16 | 28 GiB | 176 GiB |
| 12x56 | 12 | 56 GiB | 272 GiB |
| 16x56 | 16 | 56 GiB | 272 GiB |

BB Box gives a Mac box the smallest of these with at least the cores, memory and disk its size asks for. A box that asks for more disk gets a larger Mac, so a 6-core box with 14 GiB of memory and 128 GiB of disk needs a 6x28.

If no Mac the workspace allows is large enough, BB Box refuses the box before it asks Namespace. The refusal names each part that is too large, the largest Mac the workspace allows with its disk, and a size that fits. To ask for a smaller disk, give `disk_gib` to the box, or `--disk-gib` on the command line.

### macOS permissions

Namespace's Macs run with System Integrity Protection off. So, as on Tart's macOS boxes, `box_grant` grants a program in a `macos` or `macos-desktop` box the permissions macOS would ask a person for, with no prompt: Accessibility, Screen Recording, Input Monitoring, the microphone, the camera, the system's audio and Automation of one app ([058](../decisions/058-a-mac-with-sip-off-grants-its-box-users-macos-permissions.md), [095](../decisions/095-namespaces-macs-grant-macos-permissions-through-the-mac-helper.md)). An app is granted by its bundle ID, and a command-line program by its path.

- **At each Mac box's start,** in about half a second, BB Box runs its Mac helper on the Mac. It gives `runner` a code-signing identity of its own, "bb-box local code signing", so a program signed with it keeps its grants when it is rebuilt. It also measures whether the Mac can grant: whether SIP is off, and whether macOS's permissions database is one BB Box knows. If the helper does not answer within 10 seconds, the box starts without them.
- **The doctor says what it measured.** `bb box doctor` has a check, **macOS permissions on Namespace's Macs**, that says whether `box_grant` worked on the Macs boxes started on most recently, and their macOS. If BB Box could not measure a Mac the last time it tried, the check warns and gives the reason, beside what earlier measurements found. `box_status` lists a box's grants, or says why it cannot grant.
- **It refuses rather than guess.** If a later Namespace image turns SIP on, or a newer macOS changes the permissions database, `box_grant` refuses, says why and writes nothing.
- **The grants end with the box,** as the Mac is destroyed at its release.

Commands that `box_run` runs on a Namespace Mac run under Namespace's own agent, outside `runner`'s desktop session. That changes 3 things:

- Sign with the box's identity in `runner`'s session: `sudo launchctl asuser "$(id -u)" sudo -u "$(id -un)" codesign -s "bb-box local code signing" --identifier <id> <program>`. Run straight from `box_run`, `codesign` does not find the identity. A program the linker signed only ad hoc can still be granted, by its path.
- A grant applies only when the program is its own responsible process. Open an app with `open`. Start a command-line program through launchd in `runner`'s session: `sudo launchctl asuser "$(id -u)" sudo -u "$(id -un)" launchctl submit -l <label> -o <log> -- <program>`, then remove it the same way with `launchctl remove <label>`.
- A program `box_run` runs directly is charged to Namespace's agent. On a macOS desktop box the agent has Screen Recording and Accessibility, for the desktop's video; it has no other permission, so such a program cannot use the microphone or the camera.

A Namespace Mac has no microphone. To feed an app sound, install BlackHole with `brew install --cask blackhole-2ch`, then restart macOS's audio with `sudo killall coreaudiod`: BlackHole 2ch becomes the default input.

Where `box_grant` refuses, a person can still turn a permission on in System Settings on a macOS desktop box, in the desktop's viewer, as on any Mac.

## iOS boxes on a shared Namespace host

Namespace can also lend `ios` boxes, as a pool Mac or a Tart host does ([064](../decisions/064-ios-shared-hosts.md), [065](../decisions/065-macs-say-what-they-offer-and-ios-streams-in-software-where-they-must.md)): each box a macOS user of its own, with its own iOS Simulator device, on a Namespace Mac it shares with other `ios` boxes. Namespace is the last choice for them, after a pool Mac and a Tart host, as its Macs cost by the minute and live at most your plan's limit. Using them is in [device boxes](devices.md).

- **It is on by what BB Box measures.** BB Box measures each Namespace Mac it starts, for any box: whether it runs the iOS Simulator, and whether it has a hardware H.264 encoder. Once it has seen one that runs the Simulator, with a slimming list in BB Box for its newest iOS runtime, Namespace offers `ios`. The offer follows the newest kind of Mac measured in full: a measurement that did not finish does not take it away, and a newer whole measurement that finds no iOS runtime does. **Shared iOS hosts**, on by default, turns it off. While no kind of Mac makes an offer, and a report came from an older BB Box or a measurement did not finish, BB Box measures again: a Mac it already holds and has not measured in full at once, otherwise on a Mac it starts for a few minutes, at most once a day, while shared iOS hosts are on. It logs the Mac's start, its result and its end, and a `macos` box refused meanwhile says why.
- **A host takes the workspace's Mac.** On a plan that allows one Mac at a time, no `macos` or `macos-desktop` box starts on Namespace while a host lives, and no host starts while such a box does. Each says why.
- **It lives until its last box goes,** at most an hour before your plan's limit. In that last hour it lends no new slot, and every box on it ends with it: box_status says when.
- **The first box waits for the host to be made:** the Mac, then idb_companion from its pin, BB Box's slimming list and a device made from it, and `bb-box-h264`, a few minutes in all. Boxes asked for meanwhile join it. A later box gets a ready slot in seconds.
- **Its device is the first of BB Box's models the Mac's Xcode has,** on its newest iOS runtime: on Xcode 26.1.1, the iPhone 17 on iOS 26.2.
- **Video** comes from the Mac's hardware H.264 encoder where it has one, and from `bb-box-h264`, in software, where it does not. Namespace's Macs of one kind can differ: of the M4 Pro VMs measured in October 2026, one had no hardware encoder. Each host measures its own Mac, and where Macs have differed, `box_list` and `bb box doctor` say Namespace's Macs vary by machine.
- **A slot's commands run as its user,** in its own launchd session, through Namespace's gateway and `sudo`, as Namespace's Macs run no SSH server of their own for other users. So such a box has no `ssh <box name>`, and no terminal in the panel.
- **A slot has no macOS permissions to grant.** Its user has no desktop session, and a grant in the Mac's own database would reach every box on the host, so `box_grant` refuses and says so. Acquire a `macos` box without `shared` for a Mac of its own.

`bb box doctor` has a check, **Shared iOS hosts on Namespace**, that says whether a host runs, its slots, when it ends and how its video is encoded.

## What a Linux box is like

A Linux box is BB Box's own Linux image, with Ubuntu, as on any Docker host, in a container on a Linux machine of its own. You use it as `box`, who can use `sudo`, and it has Docker of its own. Desktops have the same apps as on other backends.

Once its kind's image is built, a Linux box is ready in about 25 seconds, and a desktop in about 35: the machine starts in a few seconds, and pulling the image from the workspace's registry takes most of the rest. The first box of a kind also waits for its image to be built, and says so while it waits, with how long the build takes: in its row in the Boxes page, in `bb box status`, and in what an agent's `box_acquire` and `box_status` answer.

BB Box reaches the machine through Namespace's SSH gateway, and the box's commands run with `docker exec` through it. With the tailnet on, the machine joins the tailnet, as a Mac does, and the box reaches BB through it.

A Linux box can run VMs and emulators of its own: Namespace's machines have KVM, and the box's user may use `/dev/kvm`. So a thread that asks for `linux-kvm` can get a box from Namespace. As such boxes cost by the minute, a thread that asks for plain `linux` gets one from Namespace only when no other backend has room.

A Linux box ends at your plan's limit, as a Mac does, and is destroyed when it is released.

If a box's container stops, for example after a shutdown inside the box, BB Box keeps its machine running so the box's disk stays. A stopped box still costs its machine's minutes. Release it to end the cost.

### Snapshots on a Linux box

A Linux box on Namespace takes snapshots as a Docker box does: of its disk and its Docker data, pausing the box while BB Box copies them. They stay on the box's machine and cost nothing beyond the machine, but they take up its disk, which is fixed by the machine's shape, so each one leaves the box less free space. They end with the machine, at the box's release or at the machine's deadline, your plan's longest life.

- A restore makes a new container on the same machine, with an undo, and keeps the machine.
- Releasing the box destroys its machine, with any old container a restore could not remove. If Namespace does not destroy it, BB Box tries again at its next sweep, and does not bring the box back.

Once a box has taken a snapshot, BB Box looks at its machine's containers at each sweep:

- It keeps the machine running while a container of the box exists there, running or stopped. A stopped box still costs its machine's minutes until you release it.
- It destroys the machine when no container of the box is left.
- When the machine's Docker does not answer, it leaves the machine as it is and asks again at the next sweep. It keeps moving the machine's deadline on for an hour after the box's container last answered, then lets the machine end at its deadline. For a machine whose last answer BB Box has no record of, the hour starts at the first sweep Docker does not answer, and a restart of BB does not start it again.

BB Box does not look at the containers on a machine whose box has taken no snapshot. It keeps that machine running until the box is released or reaches your plan's limit.

Snapshots also have these limits:

- A take or a restore that would end after the machine is refused, and says when the machine ends.
- Forks are off: a fork needs a machine of its own, and BB Box cannot carry a snapshot from one machine to another yet.
- Keep is off, as the snapshots end with the machine.
- Macs and iOS boxes on Namespace take no snapshots.

See [Snapshots](snapshots.md#hetzner-cloud-and-namespace) for the rest.

## Check that nothing is left running

BB Box labels every machine it makes. To list every machine in the workspace:

```sh
nsc list --all
```

Without `--all`, `nsc list` leaves out machines made through the API, which is how BB Box makes them.

Each machine listed should be a box in BB Box's Boxes page, or, for at most an hour, a machine building a Linux image, with the label `bbbox-role=image-build`. Its `bbbox-backend` label says which Namespace backend made it. BB Box checks its backends every few minutes, and destroys a machine whose box has gone once BB says the box's thread has ended. `bb box doctor` lists any machine no box claims. If one stays, destroy it with `nsc destroy` followed by its ID.

The workspace's container registry keeps BB Box's Linux images, under `bbbox/`. They cost nothing but their storage. To list the machines one backend made, filter on its label, such as `bbbox-backend=namespace-team-b` for `namespace:team-b`.

With the tailnet on, the machines show in Tailscale's admin console, under **Machines**, with the tag `tag:bb-box`. BB Box removes any it no longer has within 15 minutes.

## Turn it off

1. Release the boxes on Namespace.
2. Turn the Namespace backend off in BB Box's settings. Boxes it already has keep working until they are released.
3. Check that `nsc list --all` lists nothing of BB Box's.
4. Revoke the token. `nsc token list` shows its ID:

   ```sh
   nsc token revoke --token_id <ID>
   ```

Once the token is revoked, BB Box cannot make machines, and Namespace bills for nothing more.
