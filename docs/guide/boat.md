# Linux boxes on boat.dev

boat.dev rents Linux virtual machines, which it calls sandboxes, by the second. With a boat.dev backend, each box is a sandbox of its own that BB Box makes when a thread asks for one, and deletes when the box is released. You need no server of your own. Why it works this way is in [decision 068](../decisions/068-boat-backend.md).

This page sets it up from a new boat.dev account. It was first done on 29 October 2026.

## What it costs

boat.dev bills a sandbox for every second it runs. A stopped sandbox costs nothing for 14 days. boat.dev's prices on 29 October 2026:

| A box of | An hour |
| --- | --- |
| 2 vCPU, 4 GB, 51 GB disk (`small`) | $0.018 |
| 4 vCPU, 8 GB, 51 GB disk (`default`) | $0.036 |
| 8 vCPU, 16 GB, 111 GB disk (`large`) | $0.072 |
| 16 vCPU, 32 GB, 251 GB disk (`xlarge`, on the $100 plan or higher) | $0.20 |

A plan's price comes back as sandbox time at these prices, and boat.dev uses it first. BB Box gives each box the smallest size that has at least the cores, memory and disk the box asks for, so a box can have more than it asked for.

BB Box also keeps a stopped template sandbox for each kind, which every box of the kind is a copy of. A stopped sandbox costs nothing. Building one takes a sandbox of the `default` size for about 6 minutes for Linux and 13 for a Linux desktop, one template at a time, when the first box of the kind needs it and again after a week or when the scripts its build runs change.

### What your plan allows

- **The free trial** lasts 7 days and has 25 hours of compute, in which an hour of a `small` sandbox counts as half. It allows 2 sandboxes at once, the `small` and `default` sizes only, 5 starts a minute and 25 an hour, and auto-stops of at most 2 hours.
- **A paid plan** allows 100 sandboxes at once or more, and more starts.

BB Box also has its own limit, **Most boxes**, which is 2 by default, a template being built included. When either is reached, a thread that asks for another box is told why.

## Before you start

You need:

- a boat.dev account, made at boat.dev
- a way for the sandboxes to reach your BB server: if BB is on a Tailscale tailnet, [set BB Box up to join them to it](tailnet.md); otherwise BB's server needs a URL they can reach. Without either, boxes work, but cannot become BB machines

## Set it up

### 1. Make an API key

In boat.dev's dashboard, make an API key, or with boat.dev's command line:

```sh
boat api-key create bb-box
```

The key starts with `boat_`. A key that expires stops working for BB Box when it does, so give it a long life, or none.

### 2. Add the backend to BB Box

1. In BB Box's settings, find **boat.dev** under **Backends** and select **Set up**.
2. Paste the key into **API key**.
3. Set **Most boxes** to how many boxes you are willing to pay for at once.
4. Select **Save**, and turn the backend on.

The key is kept as a secret. BB Box's settings show only that it is set.

### 3. Turn on the kinds

Under **Kinds**, turn on **Linux** and **Linux desktop**, if you want them from boat.dev, and **Android emulator** for [Android boxes](#android-boxes).

## Check it works

```sh
bb box doctor
```

The doctor checks that boat.dev accepts the key and says what your plan allows now: sandboxes at once, starts left, the sizes and their prices, and on the trial the compute hours left. It says when each template was built, and lists the sandboxes BB Box has.

Then make a box from the Box panel, or ask an agent to. The first box of each kind waits for its template, and says so while it waits.

## What a box is like

A box is a virtual machine of its own: Ubuntu 24.04, with its own kernel, systemd, Docker and KVM, and BB Box's tools, as on its other backends. You use it as `box`, who can use `sudo`. A desktop box has the same desktop and apps as a Linux desktop on BB Box's other backends, drawn by the CPU, with computer use, and you watch and use it in the Box panel. 
Once its template is built, a Linux box is ready in 9 to 25 seconds, and a desktop in about 1 to 2 minutes: BB Box copies the template, the copy starts, and boat.dev brings in the template's system files and starts Docker, and for a desktop its desktop. A desktop then waits until boat.dev has brought in all of the template's files, about a minute after it starts, before BB Box checks Cua Driver, which stops answering if it is used before then. On a busy boat.dev machine a desktop has taken over 6 minutes.

BB Box reaches each box over SSH, with a key of its own and the host key boat.dev gives, which BB Box checks. A box gets no secret from your boat.dev account.

A box can run VMs and emulators of its own, as boat.dev's machines have KVM. As boxes cost by the second, a thread that asks for plain `linux` gets one from boat.dev only when no other backend has room, and one that asks for `linux-kvm` or `linux-vm` can get one at once.

### Stop, start and the auto-stop

Stopping a box stops its sandbox: its processes end, its disk is kept, and it costs nothing. Starting it again takes a second or two, on a new machine, whose address can differ.

boat.dev stops a sandbox by itself at its auto-stop. BB Box sets each box's auto-stop to **Auto-stop (minutes)**, 30 by default, and sets it again every few minutes while it holds the box. So a box runs while BB Box holds it, and if BB Box stops for good, its boxes stop within that time and cost nothing more. When BB Box comes back, it finds them stopped, and says why.

## Android boxes

boat.dev's machines have KVM, so they can run the Android emulator. An Android box on boat.dev is the same as on Proxmox QEMU: a phone, foldable or tablet, booted from its snapshot, with its screen in the Box panel. Using it is in [device boxes](devices.md).

1. Read the Android SDK's licence: Google's terms for the SDK, the emulator and the system image, as `setup/android/pins.json` pins them. `setup/android/accept-sdk-licence.sh` shows them, without accepting anything unless you say so.
2. In BB Box's settings, under **boat.dev**, turn on **Android SDK licence**. That is your acceptance. While it is off, boat.dev offers no Android boxes, and `box_list` and the doctor say why.
3. Turn on the **Android emulator** kind.

BB Box then builds boat.dev's Android template at its next upkeep, about 30 minutes, as no box can ask for a kind that is not offered yet. Android boxes come once it is ready.

The Android kind's own sizes start at 8 cores and 16 GB, boat.dev's `large`, which the free trial does not allow. Each device also has a least size, from what its emulator holds when busy:

| Device | Least size |
| --- | --- |
| Pixel 8 | 4 cores, 8 GiB |
| Pixel Fold | 4 cores, 10 GiB |
| Pixel Tablet | 4 cores, 10 GiB |

So on the trial, whose largest size is boat.dev's `default`, 4 cores and 8 GB, boat.dev offers the Pixel 8 only: ask for 4 cores and 8 GiB. An Android box is ready once boat.dev has brought in all of the template's files, about 4 minutes after it starts, and its device boots after that. On the trial's 4 cores the device draws about 9 to 14 frames a second in the Box panel, and a tap shows in about 150 ms, slower while boat.dev saves the box's disk, which it does each minute. The Pixel Fold and Pixel Tablet need a paid plan. The doctor's **Android** check says the largest size your plan allows, and which devices it leaves out.

## Check that nothing is left running

BB Box labels every sandbox it makes with `bbbox-install`, and its boxes with `bbbox-box`. To list them with boat.dev's command line:

```sh
boat list --all
```

Each one should be a box in BB Box's Boxes page, or a template, with the label `bbbox-role=template`, stopped. BB Box checks its backends every few minutes, and deletes a box's sandbox once BB says the box's thread has ended. It deletes an old template an hour after a new one replaces it. `bb box doctor` lists any sandbox no box claims. If one stays, delete it with `boat delete` followed by its ID.

## Turn it off

1. Release the boxes on boat.dev.
2. Turn the boat.dev backend off in BB Box's settings. Boxes it already has keep working until they are released.
3. Delete the templates with `boat delete`, and check that `boat list --all` lists nothing of BB Box's.
4. Revoke the key in boat.dev's dashboard.
