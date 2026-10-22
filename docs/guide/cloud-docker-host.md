# A cloud server as a Docker host

A server you rent from a cloud provider can host Docker boxes, as a PC with Docker can. You make the server, install Docker and BB's daemon on it, and turn it on in BB Box's settings. BB Box then makes boxes there, reaches them through BB, and builds its images there. Nothing on the server is open to the internet.

This page uses Hetzner Cloud, where it was first done on 22 October 2026. Any provider's Linux server works the same way.

## What it costs

You pay the provider for the server for every hour it exists, whether or not it has boxes. Hetzner bills by the hour, up to a monthly price, and only until you delete the server.

Hetzner's prices on 22 October 2026, with a public IPv4 address and excluding VAT:

| Type | vCPU | Memory | Disk | An hour | A month | Holds, with BB Box's defaults |
| --- | --- | --- | --- | --- | --- | --- |
| CPX32 | 4 | 8 GB | 160 GB | EUR 0.0577 | EUR 35.99 | one small Linux box |
| CPX42 | 8 | 16 GB | 320 GB | EUR 0.1122 | EUR 69.99 | a small desktop box, or 2 small Linux boxes |
| CPX62 | 16 | 32 GB | 640 GB | EUR 0.2091 | EUR 130.49 | about 6 small Linux boxes |
| CX43 | 8 | 16 GB | 160 GB | EUR 0.0264 | EUR 16.49 | as a CPX42 |
| CX53 | 16 | 32 GB | 320 GB | EUR 0.0481 | EUR 29.99 | as a CPX62 |

CX servers cost about half as much, but Hetzner marks them "limited availability", and on 22 October there were none in Germany or Finland. Choose a CX server when the Hetzner Console offers one.

Set a cost alert in the Hetzner Console. Hetzner does not stop spending by itself.

## Before you start

You need:

- a Hetzner Cloud project, and your SSH key in it
- a way for the server to reach BB's server: if BB is on a tailnet, the server joins the tailnet; otherwise BB's server needs a URL the server can reach, such as bb Connect
- 160 GB of disk on the server: BB Box's images need about 36 GB to build
- 16 GB of memory for desktop boxes: a small desktop box takes 8 GB, and BB Box keeps some memory free

## Set up the server

### 1. Make the server

In the Hetzner Console, make a server with:

- Ubuntu 26.04
- a location near BB's server, such as Nuremberg or Falkenstein for one in western Europe
- a type from the table above
- your SSH key

Log in with SSH as `root` for the steps below.

### 2. Install Docker, Tailscale and Node.js

```sh
curl -fsSL https://get.docker.com | sh
curl -fsSL https://tailscale.com/install.sh | sh
apt-get install -y nodejs
node --version
```

BB's daemon needs Node.js 22 or later. Ubuntu 26.04's own package is 22. Without Node.js, BB's command in step 5 stops with "sh: node: not found" and shows only its usage.

### 3. Join the tailnet

Skip this step if BB's server is reachable without a tailnet.

```sh
tailscale up
```

Open the link it prints and approve the server. Or use an auth key, with `tailscale up --auth-key=<key>`, tagged as your tailnet's policy needs for machines that reach BB's server.

### 4. Make a user for BB's daemon

BB's daemon runs as a user of its own, not as `root`. That user needs Docker, and keeps running when nobody is logged in:

```sh
useradd -m -s /bin/bash bb
loginctl enable-linger bb
usermod -aG docker bb
```

### 5. Add the server to BB

In BB, go to Settings, then Machines, then **Add a machine**, and choose **Manual** setup. Copy the command. BB shows it once, and it expires in 15 minutes.

On the server, run it as the user from step 4:

```sh
sudo -iu bb
```

Then paste the command. When it finishes, the server shows as connected in BB's Machines.

Use the dialog, not `bb machine create --provider manual`: the command line does not show the command, and the machine it makes cannot be paired afterwards.

### 6. Close the server to the internet

In the Hetzner Console, make a Cloud Firewall with no inbound rules, and apply it to the server. BB's daemon and Tailscale only make connections out, so they keep working. From now on, log in to the server over the tailnet, at its tailnet address.

## Turn it on in BB Box

1. In BB Box's settings, find the server under **Docker on BB machines**. Its row shows Docker's version, cores and memory.
2. Turn it on. BB Box adds a Docker backend for it and builds its images there. This takes about 15 minutes. The row shows the build until it ends.
3. On a server with 8 GB of memory, such as a CPX32, open the new backend's setup under **Backends** and set **Memory kept free (MiB)** to 1024. With the default of 4096 it has no room for a box.

Boxes on the server are privileged containers by default, so each has Docker of its own (**Docker in boxes**). A box with Docker can take over the server: use it only for work you would run on the server yourself.

## Check it works

```sh
bb box doctor
```

The doctor checks the new backend and its images. Then make a box on it from the Box panel, or ask an agent to. Once the images are there, a box should start in about a second and join BB a few seconds later, as on any Docker host.

## Remove it

1. Release the boxes on it.
2. Turn it off under **Docker on BB machines**.
3. Remove it in BB, under Settings, then Machines.
4. Remove it from the tailnet.
5. Delete the server in the Hetzner Console. Until you do, Hetzner keeps billing for it.
