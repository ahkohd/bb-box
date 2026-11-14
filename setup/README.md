# Setting up BB Box

This page is for the person who runs BB and sets up BB Box. It covers choosing a backend, installing the plugin, rebuilding images each night, upgrading, and removing BB Box. For a first try, follow the [quick start](../README.md#quick-start).

## Choose a backend

A backend is where boxes come from. You can turn on several, and a new box goes to the first with room.

| Backend | Choose it for | Snapshots | Guide |
| --- | --- | --- | --- |
| Docker | the quickest start: it needs only Docker, on the machine that runs BB, another host, or a BB machine | none yet | [Docker](docker/README.md), and [Docker in WSL on a Windows PC](docker-wsl/README.md) |
| microsandbox | an option beside Docker, not the default: Linux boxes and desktops that each need a kernel of their own, such as Docker without a privileged container, as microVMs on a Linux host with KVM or a Mac: the machine that runs BB, another host, or a BB machine | yes, with or without memory | [microsandbox](microsandbox/README.md) |
| Proxmox LXC | Linux boxes and desktops, including desktops on a GPU, on a Proxmox VE host | yes | [Proxmox LXC](proxmox-lxc/README.md) |
| Proxmox QEMU | Windows desktops, Linux boxes with a kernel of their own, and Android emulator devices, on a Proxmox VE host | Linux boxes, with or without memory. Windows desktops, the disk only, restored in place on storage that rolls back past newer snapshots. None for Android | [Proxmox QEMU](proxmox-qemu/README.md) |
| Tart | macOS, Linux on arm64 and Windows on arm64, on your Macs with Apple silicon | macOS with its memory, and Linux | [Tart](tart/README.md) |
| SSH host pool | your own physical Linux machines or Macs, lent to one thread at a time | none | [SSH host pool](ssh-pool/README.md) |
| Hetzner Cloud | Linux boxes and CPU desktops, on x86 or arm64, with no machine of your own: BB Box rents Docker hosts by the hour as boxes need them, deletes them when idle, and keeps to a monthly limit | none yet | [Hetzner Cloud](../docs/guide/hetzner.md) |
| Namespace | macOS boxes and desktops beyond your own Macs, and Linux boxes and desktops, including Linux that can run VMs: a machine for each box, rented by the minute, within the workspace's plan | none yet | [Namespace](../docs/guide/namespace.md) |
| boat.dev | Linux boxes with KVM, CPU desktops and Android emulator devices with no machine of your own: a Linux VM for each box, forked from BB Box's template in seconds and billed by the second | on a paid plan, as saved snapshots priced on your account | [boat.dev](../docs/guide/boat.md) |

Where a backend takes snapshots, a box restores to one with an undo, and a Linux or macOS box can fork one into a new box. A Windows desktop on Proxmox QEMU restores its disk and does not fork. What each backend holds, restores, forks and keeps is in [snapshots](../docs/guide/snapshots.md#what-each-backend-offers).

The cloud backends join their machines to your tailnet when BB is on one: see [joining cloud machines to your tailnet](../docs/guide/tailnet.md).

## Install the plugin

Install BB Box from BB's plugin store. In BB, open Settings, then Installed plugins, search for **BB Box**, and install it. Or open the plugin store and install **BB Box**. BB updates a store install to each new release before 1.0.

To install from Git instead, open Settings, then Installed plugins. Select the arrow beside **New plugin**, then **Install from source**, and enter `git:https://github.com/ahkohd/bb-box.git@main` for new work as it lands, or a release tag such as `git:https://github.com/ahkohd/bb-box.git@v0.2.3`. Or, with BB's command line:

```sh
bb plugin install git:https://github.com/ahkohd/bb-box.git@main
```

It asks you to confirm; an agent or a script adds `--yes`. BB fetches and builds it, so you need no clone.

A release tag, such as `git:https://github.com/ahkohd/bb-box.git@v0.2.3`, stays on that tag. Releases are tags on `main`. `bb plugin update` refuses a plugin installed from a tag.

To change BB Box itself, clone it, run `npm install` and `bb plugin build`, then `bb plugin install .` in the clone.

Boxes join BB by reaching BB's server, through bb connect when BB is signed in to your bb account, or otherwise at an address you give under Machine access. If a box says Could not join BB, see the [quick start](../README.md#quick-start).

For Docker on the machine that runs BB, the Box panel can do the rest: select **Use Docker on this machine**. From a terminal, or for an agent, `bb box setup docker` does the same and waits for the build. Otherwise, follow your backend's guide. It says what to prepare, such as an image or a template, and what to enter on BB Box's settings page: in BB, open Settings, Plugins, BB Box. For each backend, select **Add backend** and the backend, enter the values, select **Check**, then **Save and turn on**. The [user guide's settings page](../docs/guide/settings.md) explains the page.

From a terminal:

- `bb box doctor` runs the same checks, and says what to fix
- `bb box config show` prints the configuration, and `bb box config apply` saves it

Each thread then has a Box panel, and agents have the `box_` tools.

## Rebuild images each night

BB Box rebuilds its standard Linux, macOS and Windows images itself, so new boxes have current agent tools, gh and Chrome, and Windows boxes have Windows' updates. Turn on **Rebuild each night** on the Images page of BB Box's settings: BB Box then starts a run at 03:00 on BB's server, on a schedule of its own, while it is loaded. Setting up Docker from the Box panel, or with `bb box setup docker`, turns it on.

A run starts no image after 4 hours, and goes on in the background. To see what the last run did, run `bb box images list`. `bb box doctor` warns when no run has finished for 8 days. What is rebuilt and when is in the [user guide's images page](../docs/guide/images.md), and every `bb box images` command is in the [command-line reference](../docs/reference/cli.md).

If you want another time, or a run with other options, leave the switch off and have a BB automation run the job instead, in a project of yours:

```sh
bb automation create --project <project> --name "BB Box images" \
  --cron "0 2 * * *" --timezone <zone> \
  --script "bb box images refresh" --timeout 900000
```

A BB automation waits at most 15 minutes, but a run can take hours. When the automation stops waiting, the run goes on inside BB Box. Use one or the other: a run that starts while another goes on joins it.

## Upgrade

Do not remove BB Box to upgrade it, or to switch where it was installed from. `bb plugin remove` deletes its configuration, secrets and storage. `bb plugin source bb-box` shows what it was installed from.

- Installed from the plugin store: BB updates it to each new release before 1.0. `bb plugin update bb-box` installs the newest release in that range and keeps its settings and storage. `bb plugin outdated` shows whether there is one.
- Installed from `@main`: `bb plugin update bb-box` moves it to the newest commit on `main` and keeps its settings and storage.
- Installed from a path: pull, run `npm install` and `bb plugin build`, then `bb plugin reload bb-box`.
- Installed from a pinned tag: BB pins that tag, and `bb plugin update` refuses. A store install and an install from `@main` keep updating. A pinned tag does not.

After an upgrade, run `bb box doctor`. Your backend's guide says, under **Update**, when its host needs a step too, such as running a setup script again.

To keep a copy of the configuration, run `bb box config show --json`. It leaves out the secrets. `bb box config apply --replace` sets BB Box up again from that copy. Give the secrets again, either as strings in place of `{"set": true}`, or on the settings page after you apply the copy with those backends off.

## If BB Box loses its storage

Its boxes keep running. Run `bb box install-id --set <id>` with BB Box's old install ID, and the next sweep restores the boxes of live threads. When enrolment is on, each becomes a BB machine again once it answers. `bb box install-id` shows the ID, so note it while you still have it.

## Remove BB Box

1. Release the boxes first, as removing BB Box does not release them. `bb box list --all` lists them, and `bb box release <box> --force` releases one. Remove your own machines with `bb box machines remove <name>`.
2. If you made a BB automation for the nightly rebuilds, delete it: `bb automation list --project <project>` finds it, and `bb automation delete` removes it.
3. Undo each backend's host side, as its guide says under **Remove**, or for Hetzner Cloud and Namespace under **Turn it off**.
4. Run `bb plugin remove bb-box`. It deletes BB Box's configuration, secrets and storage.

A box you did not release keeps running on its host, where you can delete it.
