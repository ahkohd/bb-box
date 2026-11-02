# Setting up bb-box

This page is for the person who runs BB and sets up bb-box. It covers choosing a backend, installing the plugin, rebuilding images each night, upgrading, and removing bb-box. For a first try, follow the [quick start](../README.md#quick-start).

## Choose a backend

A backend is where boxes come from. You can turn on several, and a new box goes to the first with room.

| Backend | Choose it for | Snapshots | Guide |
| --- | --- | --- | --- |
| Docker | the quickest start: it needs only Docker, on the machine that runs BB, another host, or a BB machine | none yet | [Docker](docker/README.md), and [Docker in WSL on a Windows PC](docker-wsl/README.md) |
| microsandbox | an option beside Docker, not the default: Linux boxes and desktops that each need a kernel of their own, such as Docker without a privileged container, as microVMs on a Linux host with KVM or a Mac: the machine that runs BB, another host, or a BB machine | yes, with or without memory | [microsandbox](microsandbox/README.md) |
| Proxmox LXC | Linux boxes and desktops, including desktops on a GPU, on a Proxmox VE host | yes | [Proxmox LXC](proxmox-lxc/README.md) |
| Proxmox QEMU | Windows desktops, Linux boxes with a kernel of their own, and Android emulator devices, on a Proxmox VE host | Linux boxes, with or without memory | [Proxmox QEMU](proxmox-qemu/README.md) |
| Tart | macOS, Linux on arm64 and Windows on arm64, on your Macs with Apple silicon | macOS with its memory, and Linux | [Tart](tart/README.md) |
| SSH host pool | your own physical Linux machines or Macs, lent to one thread at a time | none | [SSH host pool](ssh-pool/README.md) |
| Hetzner Cloud | Linux boxes and CPU desktops, on x86 or arm64, with no machine of your own: bb-box rents Docker hosts by the hour as boxes need them, deletes them when idle, and keeps to a monthly limit | none yet | [Hetzner Cloud](../docs/guide/hetzner.md) |
| Namespace | macOS boxes and desktops beyond your own Macs, and Linux boxes and desktops, including Linux that can run VMs: a machine for each box, rented by the minute, within the workspace's plan | none yet | [Namespace](../docs/guide/namespace.md) |
| boat.dev | Linux boxes with KVM, CPU desktops and Android emulator devices with no machine of your own: a Linux VM for each box, forked from bb-box's template in seconds and billed by the second | on a paid plan, as saved snapshots priced on your account | [boat.dev](../docs/guide/boat.md) |

Where a backend takes snapshots, a box restores to one with an undo, and a Linux or macOS box can fork one into a new box. What each backend holds, restores, forks and keeps is in [snapshots](../docs/guide/snapshots.md#what-each-backend-offers).

The cloud backends join their machines to your tailnet when BB is on one: see [joining cloud machines to your tailnet](../docs/guide/tailnet.md).

## Install the plugin

In BB, open Settings, then Installed plugins. Select the arrow beside **New plugin**, then **Install from source**, enter `git:https://github.com/moonstead/bb-box.git@stable`, and select **Install plugin**. Or, with BB's command line:

```sh
bb plugin install git:https://github.com/moonstead/bb-box.git@stable
```

It asks you to confirm; an agent or a script adds `--yes`. BB fetches and builds it, so you need no clone. To change bb-box itself, clone it, run `npm install` and `bb plugin build`, then `bb plugin install .` in the clone.

Boxes join BB by reaching BB's server, through bb connect when BB is signed in to your bb account, or otherwise at an address you give under Machine access: see the [quick start](../README.md#quick-start).

For Docker on the machine that runs BB, the Box panel can do the rest: select **Use Docker on this machine**. From a terminal, or for an agent, `bb box setup docker` does the same and waits for the build. Otherwise, follow your backend's guide. It says what to prepare, such as an image or a template, and what to enter on BB Box's settings page: in BB, open Settings, Plugins, BB Box. For each backend, select **Add backend** and the backend, enter the values, select **Check**, then **Save and turn on**. The [user guide's settings page](../docs/guide/settings.md) explains the page.

From a terminal:

- `bb box doctor` runs the same checks, and says what to fix
- `bb box config show` prints the configuration, and `bb box config apply` saves it

Each thread then has a Box panel, and agents have the `box_` tools.

## Rebuild images each night

bb-box rebuilds its standard Linux, macOS and Windows images itself, so new boxes have current agent tools, gh and Chrome, and Windows boxes have Windows' updates. Turn on **Rebuild each night** on the Images page of BB Box's settings: bb-box then starts a run at 03:00 on BB's server, on a schedule of its own, while it is loaded. Setting up Docker from the Box panel, or with `bb box setup docker`, turns it on.

A run starts no image after 4 hours, and goes on in the background. To see what the last run did, run `bb box images list`. `bb box doctor` warns when no run has finished for 8 days. What is rebuilt and when is in the [user guide's images page](../docs/guide/images.md), and every `bb box images` command is in the [command-line reference](../docs/reference/cli.md).

If you want another time, or a run with other options, leave the switch off and have a BB automation run the job instead, in a project of yours:

```sh
bb automation create --project <project> --name "bb-box images" \
  --cron "0 2 * * *" --timezone <zone> \
  --script "bb box images refresh" --timeout 900000
```

A BB automation waits at most 15 minutes, but a run can take hours. When the automation stops waiting, the run goes on inside bb-box. Use one or the other: a run that starts while another goes on joins it.

## Upgrade

Do not remove bb-box to upgrade it: `bb plugin remove` deletes its configuration, secrets and storage. `bb plugin source bb-box` shows what it was installed from.

- Installed from a branch, as above: `bb plugin update bb-box` moves it to the branch's newest commit and keeps its settings and storage. `bb plugin outdated` shows whether there is one.
- Installed from a path: pull, run `npm install` and `bb plugin build`, then `bb plugin reload bb-box`.
- Installed from a commit or a tag: BB pins it, and `bb plugin update` refuses. Only a remove and an install move it, so install from a branch instead.

After an upgrade, run `bb box doctor`. Your backend's guide says, under **Update**, when its host needs a step too, such as running a setup script again.

To keep a copy of the configuration, run `bb box config show --json`. It leaves out the secrets. `bb box config apply --replace` sets bb-box up again from that copy. Give the secrets again, either as strings in place of `{"set": true}`, or on the settings page after you apply the copy with those backends off.

## If bb-box loses its storage

Its boxes keep running. Run `bb box install-id --set <id>` with bb-box's old install ID, and the next sweep restores the boxes of live threads. When enrolment is on, each becomes a BB machine again once it answers. `bb box install-id` shows the ID, so note it while you still have it.

## Remove bb-box

1. Release the boxes first, as removing bb-box does not release them. `bb box list --all` lists them, and `bb box release <box> --force` releases one. Remove your own machines with `bb box machines remove <name>`.
2. If you made a BB automation for the nightly rebuilds, delete it: `bb automation list --project <project>` finds it, and `bb automation delete` removes it.
3. Undo each backend's host side, as its guide says under **Remove**, or for Hetzner Cloud and Namespace under **Turn it off**.
4. Run `bb plugin remove bb-box`. It deletes bb-box's configuration, secrets and storage.

A box you did not release keeps running on its host, where you can delete it.
