# BB Box user guide

BB Box gives each BB thread computers of its own, called boxes. A box can run Linux, macOS or Windows, as a server you reach through a terminal or as a desktop you can see and use. This guide is for people who use boxes day to day.

A box belongs to a thread. It stays until you release it, or until its thread is archived or deleted. A machine is a box of your own that belongs to no thread and stays until you remove it.

## Using boxes

- [The Box panel and the Boxes page](boxes.md): see a thread's boxes and every box you have, and act on them
- [Making a box](making-a-box.md): choose its system, type, image, size and where it runs
- [Resizing a box](resizing.md): give a box more or fewer cores, more or less memory, or a larger disk
- [GPU boxes](gpu-boxes.md): give a Linux box an NVIDIA card, shared or whole, for compute, training and desktops drawn on the GPU
- [Snapshots](snapshots.md): save a box's state, restore it with an undo, fork it into a new box, and keep it past the box's release
- [Desktops](desktops.md): watch a desktop, take control, copy and paste, hand back, and show it as video
- [Device boxes](devices.md): iPhones and iPads in the iOS Simulator, and Android phones and tablets in the emulator, to test apps on
- [Recordings](recording.md): clips of an agent's work on a desktop, with each step and its result captioned
- [The terminal](terminal.md): use a shell in a box
- [A box's files](box-files.md): read and change the box user's own files
- [Images](images.md): project images, and how standard images stay up to date
- [Long commands and jobs](jobs.md): what happens when an agent's command runs for minutes
- [Files](files.md): copy files to and from a box, and put files in every box
- [Spare boxes](spares.md): boxes made ahead, so a thread has one at once
- [Sound and the microphone on Mac boxes](mac-sound.md): feed speech to an app, and what agents' apps may use
- [The Monitor](monitor.md): see how BB's server, your machines and boxes are doing, open a box's views and threads, and get told when BB's server is under pressure
- [Settings](settings.md): set up backends, choose the kinds and sizes on offer, and the general settings
- [A cloud server as a Docker host](cloud-docker-host.md): rent a server, such as one on Hetzner Cloud, and make Docker boxes there
- [Linux boxes on Hetzner Cloud](hetzner.md): Docker hosts BB Box makes in Hetzner Cloud as boxes need them, and deletes once idle
- [Mac and Linux boxes on Namespace](namespace.md): rent a Mac or a Linux machine for each box by the minute
- [Linux boxes on boat.dev](boat.md): rent a Linux VM for each box by the second
- [Joining cloud machines to your tailnet](tailnet.md): let the machines BB Box rents reach a BB server on a Tailscale tailnet

## Reference

Agents use boxes through tools, and you can use them from the command line:

- [Agent tools](../reference/tools.md)
- [Command-line reference](../reference/cli.md)
- [Kinds and sizes](../reference/kinds.md)
