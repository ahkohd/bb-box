# Linux boxes on Hetzner Cloud

Hetzner Cloud rents servers by the hour. With a Hetzner Cloud backend, BB Box makes its own Docker hosts in a Hetzner Cloud project when boxes need them, puts Linux boxes on them, and deletes each host once it has had no box for 30 minutes. You need no server of your own. Hosts can be x86, for Linux boxes, and Arm, for Linux boxes on arm64.

This page sets it up from a new Hetzner account. It was first done on 22 October 2026. To use a server you made yourself instead, see [a cloud server as a Docker host](cloud-docker-host.md).

## What it costs

Hetzner bills a server for every hour it exists, started hours in full, up to a monthly price. A host exists from when BB Box makes it until BB Box deletes it, 30 minutes after its last box is released. So a short session costs one hour of one host.

Hetzner's prices on 22 October 2026, with a public IPv4 address and excluding VAT:

| Host type | vCPU | Memory | Disk | An hour | A month | Holds, with BB Box's defaults |
| --- | --- | --- | --- | --- | --- | --- |
| CPX42 | 8 | 16 GB | 320 GB | EUR 0.1122 | EUR 69.99 | 2 small Linux boxes, or a small desktop box |
| CPX52 | 12 | 24 GB | 480 GB | EUR 0.1618 | EUR 100.99 | 4 small Linux boxes, or 2 small desktop boxes |
| CPX62 | 16 | 32 GB | 640 GB | EUR 0.2091 | EUR 130.49 | 6 small Linux boxes, or 3 small desktop boxes |

For Linux boxes on arm64, BB Box makes Arm hosts of Hetzner's Ampere types, which cost less. On 23 October 2026 a CAX31 (8 vCPU, 16 GB, 160 GB disk) cost about EUR 0.03 an hour, at most EUR 21.49 a month, with a public IPv4 address and excluding VAT. `bb box doctor` shows the price of the types you choose.

BB Box also keeps a host image: a snapshot of a host with Docker, Tailscale and the box images in it, so a new host has nothing to install or build. Hetzner bills snapshots by their size. On 22 October the host image was 17 GB, about EUR 0.20 a month, and the Arm one 9.9 GB, about EUR 0.12 a month. BB Box keeps the 2 newest of each.

Building the host image takes 10 to 30 minutes on a server of its own, or about 13 minutes for the Arm one, which costs one hour of that server. BB Box builds a new one each week, when BB updates its app, or when BB Box's image scripts change.

### Keeping the cost down

Hetzner has no spending limit of its own. BB Box has 3:

- **Most hosts**: how many hosts BB Box may have at once, 2 by default. When every host is full, BB Box tries the next backend that offers the kind, and refuses the box if none has room.
- **Monthly limit (EUR)**: BB Box makes no host when this calendar month's spend so far, and an hour more of every host with the new one, would pass this limit. It is EUR 20 by default. A host busy when the limit is reached keeps running until it is idle, so the month's spend can pass the limit by what busy hosts cost until then.
- **Idle minutes**: how long a host with no box lives, 30 by default. Hetzner bills started hours, so a shorter time saves little and makes boxes wait for a new host more often.

These count x86 and Arm hosts together.

### Hetzner's limit on vCPUs

Hetzner limits how many shared vCPUs a whole account may have at once, across all its projects: 20 for a new account. A CPX42 or a CAX31 takes 8, and so does each host image build while it runs. When a new host would pass the limit, Hetzner refuses it: BB Box then tries the next backend that offers the kind, and says that the account is at Hetzner's limit. A host image build waits, and tries again at BB Box's next check.

To raise the limit, open your account's **Limits** page in Hetzner's Console and ask for more.

## Before you start

You need:

- a Hetzner account, made at hetzner.com, with a payment method
- a way for the hosts to reach BB's server, and for BB's server to reach the hosts. If BB is on a Tailscale tailnet, [set BB Box up to join cloud machines to it](tailnet.md): its policy lets BB's server reach the hosts over SSH. Otherwise, BB's server needs a URL the hosts can reach, such as bb connect's, and BB Box reaches the hosts over the internet (see [without a tailnet](#without-a-tailnet))

## Set it up

### 1. Make a project for BB Box

In Hetzner's Console, select **New project**, and name it, for example `bb-box`. Use a project that holds nothing else. An API token reaches every server in its project, so the project is the boundary of what BB Box can touch.

### 2. Make an API token

In the project, go to **Security**, then **API tokens**, and select **Generate API token**. Give it **Read & Write** permission, name it `bb-box`, and copy it. Hetzner shows it only once.

### 3. Set a cost alert

In Hetzner's Console, open **Usage** and, in the project's row, set its **E-Mail Warning** to about half of what you are willing to spend in a month. Hetzner emails you when the project's spend that month reaches it. Hetzner does not stop spending by itself.

### 4. Add the backend to BB Box

1. In BB Box's settings, find **Hetzner Cloud** under **Backends** and select **Set up**.
2. Paste the token from step 2 into **API token**.
3. Set **Location** to the one nearest BB's server: `nbg1` (Nuremberg), `fsn1` (Falkenstein) or `hel1` (Helsinki) for one in western Europe. A desktop's stream crosses between the host and BB's server.
4. Leave **Server type** as `cpx42`, or choose a larger CPX type from the table above. Hetzner's CX types cost about half as much, but on 22 October none were available in Germany or Finland.
5. For Linux boxes on arm64, set **Arm server type** to an Ampere type, such as `cax31`. Leave it empty for none.
6. Set **Most hosts**, **Monthly limit (EUR)** and **Idle minutes** to suit your team.
7. Select **Save**, and turn the backend on.

The token is kept as a secret. BB Box's settings show only that it is set.

### 5. Turn on the kinds

Under **Kinds**, make sure these are on: **Linux**, **Linux desktop** and **Linux desktop on Wayland**, and with an Arm server type, **Linux on arm64** and **Linux desktop on arm64**. Hetzner's hosts have no GPU, so the backend offers no GPU desktops. Hetzner Cloud has no nested virtualization either, so there are no microVMs or Windows boxes there.

## Check it works

```sh
bb box doctor
```

The doctor checks that Hetzner accepts the token, each server type and its price, how BB Box reaches hosts, each host image, the hosts BB Box has, and this month's spend against the limit.

Soon after you turn the backend on, BB Box starts building the first host image, up to 30 minutes, and the first Arm one, about 13 minutes. The doctor's **Host image** check says when it is ready. Until then, a new host installs Docker and Tailscale and builds the images it needs as it starts, so the first box takes about 6 minutes.

Then make a box from the Box panel, or from the command line:

```sh
bb box acquire linux --on hetzner
bb box acquire linux-arm64 --on hetzner
```

## What a box is like

A box is a Docker container on a host of the server type, with Ubuntu, as on any Docker host. A Linux box on arm64 goes only on an Arm host, and runs arm64 programs: amd64 container images and x86_64 binaries do not run there. There is no Wayland desktop on arm64 yet. It has Docker of its own by default (**Docker in boxes**), as a privileged container. A box with Docker can take over its host, but each host belongs to this BB Box alone.

How long a box takes, from the live runs on 22 and 23 October 2026 in Nuremberg, with a CPX42 and a CAX31:

| | x86 | Arm |
| --- | --- | --- |
| A box on a host that has room | about 2 seconds | about 2 seconds |
| A box that needs a new host, from the host image | about 1 minute | about 50 seconds |
| A box that needs a new host, before the first host image | about 6 minutes | |
| Joining BB, once the box is ready | about 20 seconds | about 20 seconds |
| Releasing a box | about 1 second | about 1 second |

A host more than three quarters full makes the next one ahead, so a steady stream of boxes rarely waits.

Each host:

- is named `bb-box-hz-`, then the install's ID and the host's ID
- joins the tailnet with a key BB Box makes for it, which works once and lasts 10 minutes
- lets in only Tailscale and ping from the internet: BB Box reaches its Docker over SSH on the tailnet, with a key of BB Box's own
- stops boxes reaching Hetzner's metadata service, which holds the host's first-boot data

## Check that nothing is left running

BB Box labels everything it makes in the project with `bbbox-install=` and this install's ID. `bb box install-id` shows the ID.

In Hetzner's Console, the project's **Servers** should list only the hosts that `bb box doctor` shows under **Hosts**, and, while a host image is built, a server with the label `bbbox-role=image-build`. With Hetzner's command line, `hcloud`:

```sh
hcloud server list -l bbbox-install=<install ID>
```

BB Box checks every few minutes. It deletes:

- a host with no box for the idle time
- a server of its own whose making or deleting was cut short, as when BB restarted
- a server with its label that no host claims, 10 minutes after it was made, unless it is a host, which it takes back as after lost storage

`bb box doctor` warns of any server with the install's label that is not a host BB Box knows. With the tailnet on, a deleted host's device leaves the tailnet with it, and BB Box removes any of its devices it no longer has.

Between uses, the project keeps BB Box's SSH key and firewall, both named `bb-box-` and the install's ID, and up to 2 snapshots for each architecture. These cost nothing but the snapshots.

## Without a tailnet

If BB's server is not on a tailnet, set **SSH from** in the backend's settings to BB's server's public address, as a range such as `203.0.113.7/32`. BB Box then reaches each host's SSH over the internet from that address alone, with a key of BB Box's own. With neither the tailnet nor **SSH from**, BB Box makes no host, and the doctor says so. The boxes reach BB's server at the URL BB gives them, such as bb connect's.

## Turn it off

1. Release the boxes on Hetzner.
2. Turn the Hetzner Cloud backend off in BB Box's settings. Its hosts are deleted as they become idle, within the idle time. Boxes it already has keep working until they are released.
3. Check that the project has no server with the install's label left.
4. In Hetzner's Console, delete what BB Box keeps between uses:
   - the snapshots with the label `bbbox-role=host-image`, under **Images**, then **Snapshots**
   - the firewall and the SSH key named `bb-box-` and the install's ID, under **Firewalls** and **Security**
5. Delete the API token, under **Security**, then **API tokens**.

Once the token is deleted, BB Box cannot make servers, and Hetzner bills for nothing more.
