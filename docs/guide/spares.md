# Spare boxes

A spare is a box made ahead and joined to BB as a machine, which belongs to no thread. When a thread asks for a box of its kind, at the kind's default size, it takes a spare and has it at once, rather than waiting while a box starts and joins BB.

## Keep spares for a kind

1. In BB Box's settings, go to Kinds and select the kind's row.
2. Set **Spare boxes** to how many to keep ready.

The row then says how many spares the kind keeps. BB Box makes them in the background, and makes another when a thread takes one.

A project's [image](images.md) keeps its own spare too: one on each backend and kind it covers, while the image is in use. A box of the standard image does not take it.

## Spares that wait stopped

On Proxmox's VMs, android boxes among them, and Tart's macOS and Windows VMs, a spare waits stopped once it is a BB machine, so it holds no memory.

- Its machine's name in BB says so, for example 'calm-sparrow (spare, stopped)'.
- BB's machine list shows it offline meanwhile. This is expected.
- A thread that takes it waits a few seconds while it resumes and its machine connects again.
- Each such spare also takes the place of one of the kind's warm boxes, so the host holds no more than before.

## Spares of device boxes

ios and android boxes keep no spares unless you set a number. Their spares are off by default because each one costs disk while it waits. Set **Spare boxes** on the kind's row to turn them on.

- An android spare waits as a hibernated Proxmox VM with its device booted. It holds no memory, and its saved memory takes up to the box's memory in disk: 16 GiB at the default size.
- An ios spare on Tart waits as a suspended macOS VM with its device booted. It takes none of the Mac's two VM slots. Its saved memory takes disk as well.
- A spare stops to wait only once its device has booted. A spare whose device does not boot within 10 minutes is released, and BB Box makes no other spare of that kind for 30 minutes.
- A spare holds the kind's default device. A thread that asks for another device takes the spare and the device switches. If the switch fails, the box keeps the spare's device, and box_acquire says why.
- A Tart spare is replaced once it has waited longer than **Tart: hours a macOS warm VM or spare is kept**, 6 by default, as a saved state that old may not restore. If a spare's saved state does not restore, its VM boots afresh from its disk and box_acquire says so.

The doctor's Spares section says, for each device kind, whether spares are off, how many are kept and ready, and what each costs. It warns when a kind has fewer spares than its number, and why.

## What a claimed spare says

In New box, a provider row says 'ready now' when a spare of the size you chose is waiting there, or 'ready in seconds' when that spare waits stopped and resumes first. See [making a box](making-a-box.md#provider).

Once a thread has taken it, the box's row says 'BB machine in N s', as a new box does. For a spare that waited stopped, N is how long its machine took to connect again after it resumed.

## Spares stay current

BB Box replaces a spare it no longer wants. It does this when:

- the kind's image or template was rebuilt since the spare was made, as when [standard images are rebuilt](images.md#standard-images-stay-up-to-date), so a thread never takes a box of the old build
- the kind's default size changed
- you lower the number of spares

A spare of a project's image is replaced in the same way when the image's build changes.
