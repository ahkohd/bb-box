# The Box panel and the Boxes page

The Box panel shows one thread's boxes. The Boxes page shows every box you have: your machines, and each thread's boxes. Both let you open a box's desktop or terminal, and stop, start or release it.

## The Box panel

Open a thread and select the **Box** tab in its right panel. Each box is a row. The plus at the top right makes a new box for the thread: see [making a box](making-a-box.md).

![The Box panel with 3 boxes: one starting, one ready desktop and one stopped](../design/mockups/built/panel-list-light.png)

When the thread has no boxes, the panel says 'No boxes yet'.

When no backend is set up, the panel looks for Docker on your BB machines, the one that runs BB first. Where it finds Docker, select **Use Docker on this machine**: BB Box turns it on and builds the Linux image, which usually takes 5 to 12 minutes, depending on the machine, and the panel shows how far it is, then says when the image is ready. Desktop images are left off until you first ask for a desktop: then New box's Desktop says 'Builds first, usually 4 to 10 min', Display offers X11 and Wayland, and **Build and create** builds that desktop's image, shows how far it is, and makes the box once it is built. If the image does not build, or the box cannot be made once it has, the panel says why, and choosing Desktop again tries again. Once a machine has built an image, the panel gives that machine's last time as its estimate. Where Docker is there but BB's user cannot use it, the panel gives the line to fix it, and the line that restarts BB there. A restart ends the turns of threads running there; where the line restarts all of the user's services, it also restarts a desktop's audio and notifications, so logging out and in again, or rebooting, is gentler. Then select **Check again**. Where no machine has Docker, the panel says 'BB Box is not set up yet' and links to BB Box's settings.

### What a row tells you

A row starts with the box's name and its system, such as Linux. A box with a device has its device's system, iOS or Android, then the device's model, such as iPhone 18 Pro. Badges then say what the box is:

- Simulator or Emulator: it has an iOS Simulator or an Android emulator device
- Desktop: it has a screen you can see and use
- Wayland: its desktop runs on Wayland rather than X11, so apps built only for X11 do not run there
- GPU: its desktop is drawn by a graphics card
- No Docker: it is a Linux box without Docker
- arm64: it runs on an ARM processor, which some programs do not support
- Container, LXC, VM or Physical: what kind of computer it is
- Shared: it shares a Mac or VM with other boxes, as a macOS user of its own
- BB machine: it is the machine this thread runs on

Where the line is short of room, the name stays whole. The device's model is cut, then dropped, then badges go: first GPU, Wayland, No Docker and arm64, then Desktop, then what kind of computer it is, then Shared, and Simulator or Emulator last. On a box with a device, the system, such as Android, goes before Simulator or Emulator, which say it already. On a narrow screen, such as a phone's, a row has one button beside its menu, which has the rest.

The line under the name says how the box is doing:

| What it says | What it means |
| --- | --- |
| Starting, with a time | the box is being made or started |
| Ready in 2.2 s | the box is ready, and took that long to start |
| Joining BB… | the box is becoming a BB machine, which takes a few seconds, or a minute or two for a Windows box |
| BB machine in 5.3 s | the box is a BB machine, so the thread's commands and terminals can use it |
| This thread's machine | the box was made for the thread to run on, from BB's new-thread screen |
| Could not join BB | the box works, but it is not a BB machine, and a line under it says why: see [when a box does not join BB](#when-a-box-does-not-join-bb) |
| Stopped | the box is off and keeps its disk |
| Stopping… or Releasing… | the box is stopping, or going for good |
| Failed | the box could not start, and a red line under it says why |
| Gone | someone deleted the box outside BB Box |

After the state, the line says what needs your attention. For a desktop, it says when someone has control: 'You have control' or 'Another viewer has control'. 'Display on the CPU' means a GPU desktop is drawn without its graphics card. The line then gives the box's cores, memory and disk.

The name and the line under it each keep to one line. In a narrow panel, the line leaves out what does not fit, from its end. Point at the line to see all of it. A long name is shortened in the same way.

Select a row to see its details. They give the box's address, size, backend and system, and whether it is a BB machine. They also say how long each step took to start it, and when it was made.

### What you can do with a box

The buttons on a row open the box's desktop or terminal, and stop or start the box where its backend can. The menu at the end of the row has these and more:

- Open in browser: shows the desktop on a page of its own
- Open on the Boxes page: opens [the box's page](#a-boxs-page), in the Box panel only
- Copy address: copies the box's network address
- New thread on this box…: starts a child thread that works on this box in its own copy of the project, and is archived with this thread
- Check now: asks the backend for the box's state again
- Resize…: changes its cores, memory or disk: see [resizing a box](resizing.md)
- Release…: deletes the box

![A box's menu in the Box panel](../design/mockups/built/panel-menu-light.png)

### Releasing a box

Releasing a box deletes it and everything on its disk, so copy out anything you want to keep first. On a physical machine, releasing resets the machine and returns it to its pool. Everything in the box user's home is deleted.

Release asks you first. If the box's own thread is working, or another thread is working on the box's BB machine, it asks again, for example 'Release calm-otter anyway?', and names the threads: 'Fix the sign-in flow is working on calm-otter.' Stop asks the same way, from a row, a menu, a box's page and a notice's **Stop again**, and so does a resize that needs a restart. If BB cannot say whether the box's thread is working, they ask too, and say so. A box whose threads are all idle stops at once. One of your machines asks only when a thread is working on it.

### The machine a thread runs on

A thread can run on a box rather than on your computer. That box is the first row, with a BB machine badge. Its row has no Release, Stop or Start. Instead, a line says where those are: on the Boxes page, under Machines, for one of your machines, or in the thread that holds the box.

### When a box does not join BB

A box joins BB through BB's machine access, in BB's settings under Machines. BB's desktop app starts with bb connect, which needs you signed in to your bb account. Until you are, no box joins BB: the row says 'Could not join BB' and why, and the first-run offer says so before you make a box. Sign in to your bb account in BB, or set Machine access to **Manual** with an address boxes can reach, such as the machine's address on your network. BB must listen on that address too. BB on its own listens only on 127.0.0.1, which a box cannot reach: start it with `npx bb-app --server-bind-host 0.0.0.0`, or with the address itself in place of 0.0.0.0. That makes BB reachable by anything else on that network too. A box made before then stays as it is, so release it and make a new one.

Boxes still work without joining BB, but the thread's commands and terminals cannot use them, and they do not get the thread's Git credentials and variables.

### When something goes wrong

If BB Box cannot do what you asked, it says why in a red line under the plus. For example, it cannot stop a box whose host does not answer. The line stays until you select **Dismiss** or do something else.

BB Box keeps a log of each box: who started, stopped, resized and released it, and when, whether you did it here, an agent did with its box tools, a `bb box` command did, BB Box did itself, as for a spare, or something outside BB Box did, as when a container is stopped on its host. When one of these fails, the log keeps the backend's words and what BB Box then saw of the box, such as that it is still running. A release that fails keeps the box until a release is confirmed. The log keeps a box's last 7 days, and a released box for 24 hours.

When a box stops answering, BB Box checks it again by itself after 1 minute, after 5, then every 15 minutes, until it answers. If you remove a backend from BB Box's settings while it still has boxes, `bb box forget <box>` removes BB Box's record of one of them. It deletes nothing: if the box still runs on that backend, it keeps running.

## The Boxes page

Select **Boxes** in BB's sidebar. The page has 2 tabs, each with a count:

- **Machines** lists your machines.
- **Threads** lists every thread's boxes, in a card for each thread. The card's title is the thread's title. Select it, or the arrow beside it, to open the thread.

The page opens on the tab you chose last. The first time, it opens on Machines if you have any.

![The Boxes page's Machines tab, with 2 machines](../design/mockups/built/boxes-page-light.png)

![The Boxes page's Threads tab, with 3 threads](../design/mockups/built/boxes-page-threads-light.png)

Under the tabs, a search field finds boxes by name, kind, provider, device, such as iPhone 18 Pro, or thread title. Beside it:

- **Filters** keeps the boxes whose system, tags, provider and state you tick. A box with a device has its device's system, iOS or Android, so it is not under macOS or Linux. Tags say what a box is, such as Desktop, GPU or Container. Each filter offers only what the tab lists.
- **Sort** orders the boxes by name or by when they were made. Select the same choice again to reverse the order.

On Threads, each thread's card comes where its first box falls in that order.

A thread's box has the same row and menu as in the Box panel. It asks the same questions before it releases or stops a box. 'New thread on this box…' is only in the Box panel.

A desktop or terminal you open from a row shows on the page, with a back arrow to the list. A row whose release did not finish says 'Release did not finish', and its menu has **Release again…**.

The gear at the top right opens BB Box's settings. **New box** beside it adds one of your machines, since a box made on this page has no thread. To start a thread on a box of its own, use BB's new-thread screen: see [starting a thread on a new box](making-a-box.md#starting-a-thread-on-a-new-box).

## A box's page

Every box, and every machine of yours, has a page of its own on the Boxes page, at `/plugins/bb-box/desktop/box/` and the box's ID. Its address works in a new browser tab, after a reload and as a link you send. To open it:

- in the Box panel, select **Open on the Boxes page** in a box's menu
- in the Monitor's machine status, select **Open** beside a box's name, then **Page**
- in a desktop, device or terminal on the Boxes page, select the box's name in its bar

The page shows, from the top:

- the box's name, system, device and badges, its state in words, such as 'Ready · up 2 h 14 min' or 'Stopped · 3 h 5 min ago, today at 3:53 PM, by you', its ID and **Copy link**, which copy with a click, and the thread it is for, with whether that thread is working now
- its views, Desktop, Simulator or Emulator and Terminal, then Start or Stop and the menu. A view that cannot open now is greyed out and says why, such as 'calm-otter is stopped'. Hold Command or Ctrl as you select a view to open it in a new tab
- notices, when there are any: a stop, start, resize or release that failed, with what BB Box saw of the box after it, a backend that is no longer in BB Box's settings, a box that does not answer, a box that did not start, a stop BB Box did not ask for, a device that did not boot, and a box that could not join BB
- while the box starts, its steps so far and what it waits on
- its kind, size, where it runs, address, system, whether it is a BB machine, when it was made, and who has control of its desktop or device
- the other threads on its BB machine, with **New thread on this box…**
- how it started: how long each step took, and when it last started, and who started it

Who stopped or started a box comes from its log, so the page leaves it out where the log does not say.

When a box's backend is no longer in BB Box's settings, or does not answer, its Stop, Start, Resize and New thread on this box are greyed out, and a line beside them says why. A box that does not answer itself can still be stopped, started, resized and released, as those go through its backend: only its views and New thread on this box are greyed out. It says when BB Box checks it again; select **Check now** to check at once. Once it is stopped, or answers, it no longer says it does not answer. For a box whose backend was removed, **Forget…** removes BB Box's record of it and deletes nothing: if it still runs on that backend, it keeps running.

A release that did not finish says so, with the backend's words, and **Release again…**. For 24 hours after a box is released or forgotten, its page says which, when and by whom. After that, or for a link that is wrong, the page says 'This box is not here'.

The back arrow on a desktop, device or terminal goes back to where you opened it from: the list, the box's page, or BB Box's settings, and says which. A link with no such place goes back to the box's page.

## Your machines

A machine is a box of your own, kept as a BB machine. It belongs to no thread. It shows in BB's machine list and in the new-thread picker, so you can start threads on it, and it stays until you remove it.

You can add a machine from **New box** on the Boxes page, or from **Add machine** in Settings, BB Box, Machines. The form is the same as for a new box, with a name at the end. The name is optional: leave it empty and BB Box picks one. A name uses lowercase letters, digits and hyphens, starts with a letter, does not end with a hyphen, and is at most 32 characters.

A machine's row shows the threads on it: up to three, those working first, with a spinner, then those most recently active. Select one to open it. **+2 more**, or however many there are, lists them all, with a search box when the list is long. You can stop, start, [resize](resizing.md) and remove it from the Boxes page or from settings. Removing a machine deletes it, as releasing a box does. If a thread is working on the machine, Remove and Stop ask again before they go on.

Remove a Windows machine here, not from BB's own machine list. Removing it there takes it out of BB, but leaves the Windows box running.
