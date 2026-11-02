# Resizing a box

You can give a box more or fewer cores, more or less memory, or a larger disk after it is made, where its backend can. Some changes happen live, with everything in the box still running. Others need a restart, which BB Box makes only when you say so.

## Where to find it

- In the Box panel, or on the Boxes page: select **Resize…** in a box's menu.
- For one of your machines: select **Resize…** in its menu, on the Boxes page or in Settings, BB Box, Machines.

Resize… shows for a box that is ready or stopped, where its backend can change at least one part. The row for the machine a thread runs on has none: resize that machine from Machines, or from the thread that holds it.

## Choosing a size

The dialog shows the box's size now. Choose **Small**, **Medium** or **Large**: a preset sets the cores and memory, and leaves the disk as it is. Or choose **Custom** and set the cores, the memory in GiB and the disk in GiB yourself, up to the kind's largest size. At that size or past it, a line under the fields says so, and **Change it in Settings** opens the kind's sizes in BB Box's settings, where you can raise it. An agent asking past it is told the same, and the command that raises it: `bb box kind set <kind> --largest-memory-gib <GiB>`, or `--largest-cores` or `--largest-disk-gib`. The dialog opens on the preset the box is now, if it is one.

Under **What changes**, each part says whether it changes live, with a restart, or cannot change, and the dialog says whether the box's host has room for it to grow. Select **Resize** to make the change, or **Cancel** to leave the box as it is.

## Live or with a restart

What can change, and how, depends on where the box runs:

| Backend | Cores | Memory | Disk |
| --- | --- | --- | --- |
| Proxmox LXC | live | live | live |
| Docker | live | live | cannot change |
| Proxmox QEMU, Linux and Windows | restart | restart | live |
| microsandbox | restart | restart | live |
| Tart, Linux | restart | restart | restart |
| Tart, macOS | restart | restart | cannot change |
| Tart, Windows | restart | restart | restart |
| SSH host pool | cannot change | cannot change | cannot change |
| Hetzner Cloud | live | live | cannot change |
| Namespace | cannot change | cannot change | cannot change |
| boat.dev | restart | restart | restart |

A live change takes effect at once. A restart shuts the box down, gives it its new size and starts it again: everything running in it stops, and a desktop's session ends. Some backends resize only a box that runs: if yours does, the dialog says to start the box first.

The disk only grows: you cannot make it smaller.

On boat.dev, a box's size is one of boat.dev's sizes, such as `small` or `default`, so cores, memory and disk change together, to the smallest size that has what you ask for, among those your plan allows. BB Box stops the box's sandbox and boat.dev starts it again on a machine of the new size, which costs nothing more than the restart. A smaller size is refused when the box's files would not fit its disk. A stopped box is started at its new size and stopped again.

Memory can shrink, but not below what the box uses. A live shrink is refused when the box would be left with less than 512 MiB, or a tenth of the new size, free above what it uses now. A Linux box has at least 2 GiB.

## When a restart is needed

If any part needs a restart, the dialog asks first, for example 'Restart calm-otter to resize it?', and says when the box will be back, such as in about 30 seconds. Select **Restart and resize** to go ahead.

If threads are working on the box, the dialog shows them and asks again, 'Restart calm-otter anyway?', as their work stops while it restarts.

When it is done, the dialog says what the box has now, for example 'It has 4 cores · 8 GiB · 64 GiB disk now, after a restart.' The box's row says how it went, for example 'Resized to 4 cores · 8 GiB · 64 GiB disk after a restart, in 15 s.'

## A BB machine's cores

BB counts a machine's cores when its daemon there starts, and sets the machine's automatic thread limit from them. After a live change of a BB machine's cores, BB Box restarts BB's daemon in the box once the box shows its new cores, within about 15 seconds, if no thread is working on the machine and no BB terminal is open there. Otherwise, the answer says how to set the thread limit by hand.

## Agents and the command line

Agents resize a box with the `box_resize` tool. From the command line, use `bb box resize` for a thread's box, and `bb box machines resize` for one of your machines:

- `--size small`, `medium` or `large` sets a preset's cores and memory
- `--cores`, `--memory-gib` and `--disk-gib` set the parts you name, and leave the rest as they are
- `--check` only says what would change, how, and whether there is room
- `--restart` allows a restart, where a part needs one: without it, BB Box changes nothing and says which parts need one
- `--force` restarts even while threads are working on the box, which ends their work

Neither restarts a box whose desktop a person controls: ask them to hand control back first. See [agent tools](../reference/tools.md#box_resize) and the [command-line reference](../reference/cli.md#bb-box-resize).
