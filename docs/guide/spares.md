# Spare boxes

A spare is a box made ahead and joined to BB as a machine, which belongs to no thread. When a thread asks for a box of its kind, at the kind's default size, it takes a spare and has it at once, rather than waiting while a box starts and joins BB.

## Keep spares for a kind

1. In BB Box's settings, go to Kinds and select the kind's row.
2. Set **Spare boxes** to how many to keep ready.

The row then says how many spares the kind keeps. BB Box makes them in the background, and makes another when a thread takes one.

A project's [image](images.md) keeps its own spare too: one on each backend and kind it covers, while the image is in use. A box of the standard image does not take it.

## Spares that wait stopped

On Proxmox's Windows VMs and Tart's macOS and Windows VMs, a spare waits stopped once it is a BB machine, so it holds no memory.

- Its machine's name in BB says so, for example 'calm-sparrow (spare, stopped)'.
- BB's machine list shows it offline meanwhile. This is expected.
- A thread that takes it waits a few seconds while it resumes and its machine connects again.
- Each such spare also takes the place of one of the kind's warm boxes, so the host holds no more than before.

## What a claimed spare says

In New box, a provider row says 'ready now' when a spare of the size you chose is waiting there, or 'ready in seconds' when that spare waits stopped and resumes first. See [making a box](making-a-box.md#provider).

Once a thread has taken it, the box's row says 'BB machine in N s', as a new box does. For a spare that waited stopped, N is how long its machine took to connect again after it resumed.

## Spares stay current

BB Box replaces a spare it no longer wants. It does this when:

- the kind's image was rebuilt since the spare was made, as when [standard images are rebuilt](images.md#standard-images-stay-up-to-date), so a thread never takes a box of the old build
- the kind's default size changed
- you lower the number of spares

A spare of a project's image is replaced in the same way when the image's build changes.
