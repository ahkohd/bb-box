# Setting up bb-box

This page is for the person who runs BB and sets up bb-box. It covers choosing a backend, installing the plugin, rebuilding images each night, upgrading, and removing bb-box. For a first try, follow the [quick start](../README.md#quick-start).

## Choose a backend

A backend is where boxes come from. You can turn on several, and a new box goes to the first with room.

| Backend | Choose it for | Guide |
| --- | --- | --- |
| Docker | the quickest start: it needs only Docker, on the machine that runs BB, another host, or a BB machine | [Docker](docker/README.md), and [Docker in WSL on a Windows PC](docker-wsl/README.md) |
| Proxmox LXC | Linux boxes and desktops, including desktops on a GPU, on a Proxmox VE host | [Proxmox LXC](proxmox-lxc/README.md) |
| Proxmox QEMU | Windows desktops on a Proxmox VE host | [Proxmox QEMU](proxmox-qemu/README.md) |
| Tart | macOS, Linux on arm64 and Windows on arm64, on your Macs with Apple silicon | [Tart](tart/README.md) |
| SSH host pool | your own physical Linux machines or Macs, lent to one thread at a time | [SSH host pool](ssh-pool/README.md) |

## Install the plugin

On the machine that runs BB:

```sh
git clone https://github.com/moonstead/bb-box.git && cd bb-box
npm install
bb plugin build
bb plugin install .
```

Then follow your backend's guide. It says what to prepare, such as an image or a template, and what to enter on BB Box's settings page: in BB, open Settings, Plugins, BB Box. For each backend, select **Set up**, enter the values, select **Check**, then **Save and turn on**. The [user guide's settings page](../docs/guide/settings.md) explains the page.

From a terminal:

- `bb box doctor` runs the same checks, and says what to fix
- `bb box config show` prints the configuration, and `bb box config apply` saves it

Each thread then has a Box panel, and agents have the `box_` tools.

## Rebuild images each night

bb-box rebuilds its standard Linux and macOS images itself, so new boxes have current agent tools, gh and Chrome. Windows images are not rebuilt yet. To turn this on, have a BB automation run the job each night, in a project of yours:

```sh
bb automation create --project <project> --name "bb-box images" \
  --cron "0 2 * * *" --timezone <zone> \
  --script "bb box images refresh" --timeout 900000
```

A BB automation waits at most 15 minutes, but a run can take hours. When the automation stops waiting, the run goes on inside bb-box.

To see what the last run did, run `bb box images list`. `bb box doctor` warns when no run has finished for 8 days. What is rebuilt and when is in the [user guide's images page](../docs/guide/images.md), and every `bb box images` command is in the [command-line reference](../docs/reference/cli.md).

## Upgrade

Do not remove bb-box to upgrade it: `bb plugin remove` deletes its configuration, secrets and storage. `bb plugin source bb-box` shows what it was installed from.

- Installed from a path, as above: pull, run `npm install` and `bb plugin build`, then `bb plugin reload bb-box`.
- Installed from a branch, with `bb plugin install git:<bb-box repository>@<branch>`: `bb plugin update bb-box` moves it to the branch's newest commit and keeps its settings and storage. `bb plugin outdated` shows whether there is one.
- Installed from a commit or a tag: BB pins it, and `bb plugin update` refuses. Only a remove and an install move it, so install from a branch instead.

To keep a copy of the configuration, run `bb box config show --json`. It leaves out the secrets. `bb box config apply --replace` sets bb-box up again from that copy. Give the secrets again, either as strings in place of `{"set": true}`, or on the settings page after you apply the copy with those backends off.

## If bb-box loses its storage

Its boxes keep running. Run `bb box install-id --set <id>` with bb-box's old install ID, and the next sweep restores the boxes of live threads. When enrolment is on, each becomes a BB machine again once it answers. `bb box install-id` shows the ID, so note it while you still have it.

## Remove bb-box

Release the boxes first, as removing bb-box does not release them. Then run `bb plugin remove bb-box`. It deletes bb-box's configuration, secrets and storage. A box you did not release keeps running on its host, where you can delete it.
